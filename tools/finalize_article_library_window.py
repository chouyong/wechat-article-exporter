import argparse
import json
import pathlib
import time
import urllib.request


def now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def append_log(path: pathlib.Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(f"{now_text()} {message}\n")


def get_json(url: str, timeout: int) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(url: str, payload: dict, timeout: int) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def process_exists(pid: int) -> bool:
    try:
        kernel32 = __import__("ctypes").windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--start", required=True, type=int)
    parser.add_argument("--end", required=True, type=int)
    parser.add_argument("--prefetch-pid", type=int, default=0)
    parser.add_argument("--api-base", default="http://127.0.0.1:3001")
    parser.add_argument("--poll-seconds", type=int, default=30)
    parser.add_argument("--max-failed-retries", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--log-path", required=True)
    args = parser.parse_args()

    log_path = pathlib.Path(args.log_path)
    job_id = args.job_id
    retries = 0

    append_log(log_path, f"supervisor started job={job_id} prefetch_pid={args.prefetch_pid}")

    while args.prefetch_pid > 0 and process_exists(args.prefetch_pid):
        append_log(log_path, "prefetch still running")
        time.sleep(max(args.poll_seconds, 5))

    if args.prefetch_pid > 0:
        append_log(log_path, "prefetch finished")

    while True:
        status = get_json(
            f"{args.api_base.rstrip('/')}/api/tools/article-library/export-status?id={job_id}",
            args.timeout,
        )
        job = status.get("job") or {}
        if not job:
            append_log(log_path, f"job missing id={job_id}")
            return 1

        append_log(
            log_path,
            "job id={id} status={status} processed={processed}/{total} exported={exported} skipped={skipped} "
            "failed={failed} zip={zip_path}".format(
                id=job.get("id"),
                status=job.get("status"),
                processed=job.get("processedCandidates"),
                total=job.get("totalCandidates"),
                exported=job.get("exportedCount"),
                skipped=job.get("skippedExistingCount"),
                failed=job.get("failedCount"),
                zip_path=job.get("zipPath"),
            ),
        )

        state = job.get("status")
        failed_count = int(job.get("failedCount") or 0)
        if state == "completed" and failed_count <= 0:
            append_log(log_path, "job completed cleanly")
            return 0

        if state in {"completed", "failed"}:
            if retries >= args.max_failed_retries:
                append_log(log_path, f"retry budget exhausted state={state} failed={failed_count}")
                return 1

            retries += 1
            append_log(log_path, f"starting failed-only retry #{retries} from job={job_id}")
            started = post_json(
                f"{args.api_base.rstrip('/')}/api/tools/article-library/export",
                {
                    "mode": "failed-only",
                    "syncFromTimestamp": args.start,
                    "syncToTimestamp": args.end,
                },
                args.timeout,
            )
            next_job = ((started or {}).get("job") or {}).get("id")
            if not next_job:
                append_log(log_path, "failed to start failed-only retry")
                return 1
            job_id = next_job
            append_log(log_path, f"failed-only retry started job={job_id}")
            time.sleep(10)
            continue

        time.sleep(max(args.poll_seconds, 5))


if __name__ == "__main__":
    raise SystemExit(main())
