import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)

DELETED_MARKERS = (
    "The content has been deleted by the author.",
    "该内容已被发布者删除",
)


def canonicalize_url(url: str) -> str:
    text = (url or "").strip()
    match = re.search(r"https://mp\.weixin\.qq\.com/s/[A-Za-z0-9_-]+", text)
    return match.group(0) if match else text


def html_cache_file_path(cache_root: pathlib.Path, url: str) -> pathlib.Path:
    key = hashlib.sha1(canonicalize_url(url).encode("utf-8")).hexdigest()
    return cache_root / f"{key}.json"


def load_json(path: pathlib.Path) -> Any:
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-16le", "latin1"):
        try:
            return json.loads(raw.decode(encoding).lstrip("\ufeff"))
        except Exception:
            continue
    raise RuntimeError(f"failed to parse json: {path}")


def article_is_success(html: str) -> bool:
    return 'id="js_article"' in html or "id='js_article'" in html


def article_is_deleted(html: str) -> bool:
    return any(marker in html for marker in DELETED_MARKERS)


def fetch_html(url: str, timeout: int, retries: int) -> tuple[str, str]:
    last_error = "unknown error"
    for attempt in range(retries):
        req = urllib.request.Request(
            url,
            headers={
                "Referer": "https://mp.weixin.qq.com/",
                "Origin": "https://mp.weixin.qq.com",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                html = resp.read().decode("utf-8", "ignore")
            if article_is_success(html):
                return "success", html
            if article_is_deleted(html):
                return "deleted", html
            last_error = "unexpected html structure"
        except urllib.error.HTTPError as exc:
            last_error = f"http {exc.code}"
        except Exception as exc:
            last_error = str(exc)

        if attempt + 1 < retries:
            time.sleep(min(2 ** attempt, 8))

    return "failed", last_error


def upload_batch(api_base: str, items: list[dict[str, Any]], timeout: int) -> dict[str, Any]:
    body = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{api_base.rstrip('/')}/api/tools/article-library/html-snapshot",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True, type=int, help="publish start timestamp, inclusive")
    parser.add_argument("--end", required=True, type=int, help="publish end timestamp, inclusive")
    parser.add_argument("--api-base", default="http://127.0.0.1:3001")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--fetch-timeout", type=int, default=60)
    parser.add_argument("--upload-timeout", type=int, default=120)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    export_root = repo_root / "data" / "exports" / "article-library"
    snapshot = load_json(export_root / "snapshot.json")
    html_index_path = export_root / "html-cache-index.json"
    html_cache_root = export_root / "html-cache"
    html_index = load_json(html_index_path) if html_index_path.exists() else {"items": {}}

    deduped: dict[str, dict[str, Any]] = {}
    for article in snapshot.get("articles", []):
        if article.get("is_deleted") or not article.get("link"):
            continue
        create_time = int(article.get("create_time") or 0)
        if create_time < args.start or create_time > args.end:
            continue
        url = canonicalize_url(article["link"])
        if not url:
            continue
        deduped[url] = article

    candidates = []
    for url, article in deduped.items():
        if url in html_index.get("items", {}) or html_cache_file_path(html_cache_root, url).exists():
            continue
        candidates.append(
            {
                "fakeid": article["fakeid"],
                "url": url,
                "title": article.get("title") or "",
            }
        )
    uncached_total = len(candidates)
    if args.limit > 0:
        candidates = candidates[: args.limit]

    print(
        json.dumps(
            {
                "window_start": args.start,
                "window_end": args.end,
                "total_candidates": len(deduped),
                "already_cached": len(deduped) - uncached_total,
                "to_fetch": len(candidates),
                "uncached_total": uncached_total,
            },
            ensure_ascii=False,
        )
    )

    lock = threading.Lock()
    upload_lock = threading.Lock()
    uploaded = 0
    deleted = 0
    failed = 0
    processed = 0
    success_items: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    def flush_batch(force: bool = False) -> None:
        nonlocal uploaded, success_items
        with lock:
            if not success_items:
                return
            if not force and len(success_items) < args.batch_size:
                return
            batch = success_items[: args.batch_size]
            del success_items[: args.batch_size]

        with upload_lock:
            result = upload_batch(args.api_base, batch, args.upload_timeout)
        with lock:
            uploaded += int(result.get("updated") or 0)

    def worker(candidate: dict[str, Any]) -> None:
        nonlocal deleted, failed, processed
        status, payload = fetch_html(candidate["url"], args.fetch_timeout, args.retries)
        with lock:
            processed += 1
            if status == "success":
                success_items.append(
                    {
                        "fakeid": candidate["fakeid"],
                        "url": candidate["url"],
                        "title": candidate["title"],
                        "commentID": None,
                        "html": payload,
                    }
                )
            elif status == "deleted":
                deleted += 1
            else:
                failed += 1
                failures.append({"url": candidate["url"], "reason": payload})
            if processed % 20 == 0 or processed == len(candidates):
                print(
                    json.dumps(
                        {
                            "processed": processed,
                            "queued_upload": len(success_items),
                            "uploaded": uploaded,
                            "deleted": deleted,
                            "failed": failed,
                        },
                        ensure_ascii=False,
                    )
                )
        flush_batch(False)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(args.concurrency, 1)) as pool:
        futures = [pool.submit(worker, candidate) for candidate in candidates]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    while success_items:
        flush_batch(True)

    report = {
        "window_start": args.start,
        "window_end": args.end,
        "total_candidates": len(deduped),
        "already_cached": len(deduped) - uncached_total,
        "uncached_total": uncached_total,
        "fetch_attempted": len(candidates),
        "uploaded": uploaded,
        "deleted": deleted,
        "failed": failed,
        "failure_samples": failures[:50],
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    report_path = export_root / f"prefetch-report-{args.start}-{args.end}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
