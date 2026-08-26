import argparse
import ctypes
import datetime as dt
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request


LOCAL_TZ = dt.timezone(dt.timedelta(hours=8))


def now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log(message: str) -> None:
    print(f"[{now_text()}] {message}", flush=True)


def is_transient_network_error(error: Exception) -> bool:
    text = str(error)
    return any(
        marker in text
        for marker in (
            "WinError 10061",
            "WinError 10060",
            "timed out",
            "TimeoutError",
            "ConnectionRefusedError",
            "ConnectionResetError",
        )
    )


def pid_exists(pid: int) -> bool:
    try:
        kernel32 = ctypes.windll.kernel32
        process = kernel32.OpenProcess(0x1000, False, pid)
        if not process:
            return False
        kernel32.CloseHandle(process)
        return True
    except Exception:
        return False


def parse_datetime(value: str, end_of_period: bool = False) -> int:
    text = (value or "").strip()
    if not text:
        raise ValueError("empty datetime")

    if text.isdigit():
        return int(text)

    patterns = [
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%Y.%m.%d %H:%M:%S",
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y-%m",
        "%Y/%m",
        "%Y.%m",
    ]

    for pattern in patterns:
        try:
            parsed = dt.datetime.strptime(text, pattern)
            if pattern in {"%Y-%m", "%Y/%m", "%Y.%m"}:
                if end_of_period:
                    year, month = parsed.year, parsed.month
                    if month == 12:
                        parsed = dt.datetime(year + 1, 1, 1, 0, 0, 0) - dt.timedelta(seconds=1)
                    else:
                        parsed = dt.datetime(year, month + 1, 1, 0, 0, 0) - dt.timedelta(seconds=1)
                else:
                    parsed = dt.datetime(parsed.year, parsed.month, 1, 0, 0, 0)
            elif pattern in {"%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"}:
                parsed = parsed.replace(
                    hour=23 if end_of_period else 0,
                    minute=59 if end_of_period else 0,
                    second=59 if end_of_period else 0,
                )
            return int(parsed.replace(tzinfo=LOCAL_TZ).timestamp())
        except ValueError:
            continue

    raise ValueError(f"unsupported datetime format: {text}")


def post_json(url: str, payload: dict, timeout: int) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {detail}") from exc


def get_json(url: str, timeout: int) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason}: {detail}") from exc


def post_json_with_retry(url: str, payload: dict, timeout: int, retries: int = 3) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return post_json(url, payload, timeout)
        except Exception as exc:
            last_error = exc
            if attempt < retries and is_transient_network_error(exc):
                wait_seconds = 2 * (attempt + 1)
                log(f"temporary API error while starting job, retrying in {wait_seconds}s: {exc}")
                time.sleep(wait_seconds)
                continue
            raise
    raise last_error or RuntimeError("post_json_with_retry failed")


def get_json_with_retry(url: str, timeout: int, retries: int = 5) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return get_json(url, timeout)
        except Exception as exc:
            last_error = exc
            if attempt < retries and is_transient_network_error(exc):
                wait_seconds = 3 * (attempt + 1)
                log(f"temporary API error while querying job, retrying in {wait_seconds}s: {exc}")
                time.sleep(wait_seconds)
                continue
            raise
    raise last_error or RuntimeError("get_json_with_retry failed")


def extract_job(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {}
    nested = payload.get("job")
    if isinstance(nested, dict):
        return nested
    if payload.get("id") and payload.get("status"):
        return payload
    return {}


def download_zip(api_base: str, job_id: str, output_path: pathlib.Path, timeout: int) -> None:
    url = f"{api_base.rstrip('/')}/api/tools/article-library/export-download?id={urllib.parse.quote(job_id)}"
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(resp.read())


def write_text(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def copy_failure_log_from_job(job_id: str, output_path: pathlib.Path) -> bool:
    source = pathlib.Path("data") / "exports" / "article-library" / "jobs" / str(job_id) / "failures.jsonl"
    if not source.exists():
        return False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(source.read_bytes())
    return True


def wait_for_prefetch(prefetch_pid: int, poll_seconds: int) -> None:
    if prefetch_pid <= 0:
        return

    log(f"waiting for prefetch pid={prefetch_pid}")
    while pid_exists(prefetch_pid):
        time.sleep(max(poll_seconds, 3))
    log("prefetch finished")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True, help="range start, e.g. 2026-01-01")
    parser.add_argument("--end", required=True, help="range end, e.g. 2026-05-31")
    parser.add_argument("--mode", default="full", choices=["full", "recent-3d", "failed-only", "cached-only"])
    parser.add_argument("--api-base", default="http://127.0.0.1:3001")
    parser.add_argument("--poll-seconds", type=int, default=15)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--retry-failed-only", type=int, default=3)
    parser.add_argument("--prefetch-pid", type=int, default=0)
    parser.add_argument("--download-zip", action="store_true")
    parser.add_argument("--zip-output", default="")
    parser.add_argument("--failure-log", default="")
    parser.add_argument("--summary-log", default="")
    args = parser.parse_args()

    try:
        start_ts = parse_datetime(args.start, end_of_period=False)
        end_ts = parse_datetime(args.end, end_of_period=True)
    except ValueError as exc:
        log(str(exc))
        return 2

    if end_ts < start_ts:
        log("end must be >= start")
        return 2

    wait_for_prefetch(args.prefetch_pid, args.poll_seconds)

    log(f"starting export mode={args.mode} start={args.start} end={args.end}")
    try:
        started = post_json_with_retry(
            f"{args.api_base.rstrip('/')}/api/tools/article-library/export",
            {
                "mode": args.mode,
                "syncFromTimestamp": start_ts,
                "syncToTimestamp": end_ts,
            },
            args.timeout,
        )
    except Exception as exc:
        log(f"failed to start export job: {exc}")
        return 1

    job = extract_job(started)
    job_id = job.get("id")
    if not job_id:
        log(f"failed to start export job: {json.dumps(started, ensure_ascii=False)}")
        return 1

    log(f"export job started job_id={job_id}")
    status_url = f"{args.api_base.rstrip('/')}/api/tools/article-library/export-status?id={urllib.parse.quote(str(job_id))}"

    retries = 0
    completed_cleanly = False
    final_job: dict = {}
    while True:
        try:
            payload = get_json_with_retry(status_url, args.timeout)
        except Exception as exc:
            log(f"failed to query job status after retries: {exc}")
            return 1
        job = extract_job(payload)
        if not job:
            log(f"job missing: {json.dumps(payload, ensure_ascii=False)}")
            return 1

        log(
            "job_id={id} status={status} processed={processed}/{total} exported={exported} skipped={skipped} failed={failed}".format(
                id=job.get("id"),
                status=job.get("status"),
                processed=job.get("processedCandidates"),
                total=job.get("totalCandidates"),
                exported=job.get("exportedCount"),
                skipped=job.get("skippedExistingCount"),
                failed=job.get("failedCount"),
            )
        )

        state = job.get("status")
        failed_count = int(job.get("failedCount") or 0)
        final_job = job

        if state == "completed" and failed_count <= 0:
            completed_cleanly = True
            break

        if state in {"completed", "failed"}:
            if retries >= args.retry_failed_only:
                break
            retries += 1
            log(f"retry failed-only #{retries}")
            try:
                started = post_json_with_retry(
                    f"{args.api_base.rstrip('/')}/api/tools/article-library/export",
                    {
                        "mode": "failed-only",
                        "syncFromTimestamp": start_ts,
                        "syncToTimestamp": end_ts,
                    },
                    args.timeout,
                )
            except Exception as exc:
                log(f"failed to start failed-only retry: {exc}")
                return 1
            next_job = extract_job(started).get("id")
            if not next_job:
                log(f"failed to start failed-only retry: {json.dumps(started, ensure_ascii=False)}")
                return 1
            job_id = next_job
            status_url = f"{args.api_base.rstrip('/')}/api/tools/article-library/export-status?id={urllib.parse.quote(str(job_id))}"
            log(f"failed-only retry started job_id={job_id}")
            time.sleep(max(args.poll_seconds, 3))
            continue

        time.sleep(max(args.poll_seconds, 3))

    if not completed_cleanly:
        message = f"export finished with remaining failures: job_id={job_id} failed={final_job.get('failedCount')}"
        log(message)
        if args.failure_log:
            failure_log_path = pathlib.Path(args.failure_log)
            copied = copy_failure_log_from_job(str(job_id), failure_log_path)
            if not copied:
                failure_samples = final_job.get("failureSamples") or []
                lines = [
                    json.dumps(
                        {
                            "job_id": job_id,
                            "url": item.get("url"),
                            "reason": item.get("reason"),
                        },
                        ensure_ascii=False,
                    )
                    for item in failure_samples
                ]
                write_text(failure_log_path, "\n".join(lines) + ("\n" if lines else ""))
            log(f"failure log written to {args.failure_log}")
        return 1

    summary = {
        "job_id": job_id,
        "mode": final_job.get("mode"),
        "processed": final_job.get("processedCandidates"),
        "total": final_job.get("totalCandidates"),
        "exported": final_job.get("exportedCount"),
        "skipped": final_job.get("skippedExistingCount"),
        "failed": final_job.get("failedCount"),
    }

    if args.download_zip:
        output_path = pathlib.Path(args.zip_output) if args.zip_output else pathlib.Path("data") / "exports" / "article-library" / "downloads" / f"{job_id}.zip"
        log(f"downloading zip to {output_path}")
        download_zip(args.api_base, str(job_id), output_path, args.timeout)
        log(f"zip downloaded: {output_path}")
        summary["zip_path"] = str(output_path)

    if args.summary_log:
        write_text(pathlib.Path(args.summary_log), json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        log(f"summary log written to {args.summary_log}")

    log(f"done job_id={job_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
