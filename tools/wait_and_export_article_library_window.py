import argparse
import ctypes
import json
import time
import urllib.request


def pid_exists(pid: int) -> bool:
    process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not process:
        return False
    ctypes.windll.kernel32.CloseHandle(process)
    return True


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefetch-pid", required=True, type=int)
    parser.add_argument("--start", required=True, type=int)
    parser.add_argument("--end", required=True, type=int)
    parser.add_argument("--api-base", default="http://127.0.0.1:3001")
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args()

    print(
        json.dumps(
            {
                "waiting_for_prefetch_pid": args.prefetch_pid,
                "window_start": args.start,
                "window_end": args.end,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    while pid_exists(args.prefetch_pid):
        time.sleep(max(args.poll_seconds, 3))

    job = post_json(
        f"{args.api_base.rstrip('/')}/api/tools/article-library/export",
        {
            "mode": "full",
            "syncFromTimestamp": args.start,
            "syncToTimestamp": args.end,
        },
    )
    job_id = job["id"]
    print(json.dumps({"export_job_started": job_id}, ensure_ascii=False), flush=True)

    status_url = f"{args.api_base.rstrip('/')}/api/tools/article-library/export-status?id={job_id}"
    while True:
        payload = get_json(status_url)
        job = payload.get("job") or {}
        print(
            json.dumps(
                {
                    "job_id": job.get("id"),
                    "status": job.get("status"),
                    "message": job.get("message"),
                    "processed": job.get("processedCandidates"),
                    "total": job.get("totalCandidates"),
                    "exported": job.get("exportedCount"),
                    "skipped": job.get("skippedExistingCount"),
                    "failed": job.get("failedCount"),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        if job.get("status") in ("completed", "failed"):
            break
        time.sleep(max(args.poll_seconds, 3))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
