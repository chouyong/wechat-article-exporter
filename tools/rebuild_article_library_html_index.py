import json
import pathlib
import re


FIELD_PATTERNS = {
    "fakeid": re.compile(r'"fakeid"\s*:\s*"((?:\\.|[^"\\])*)"'),
    "url": re.compile(r'"url"\s*:\s*"((?:\\.|[^"\\])*)"'),
    "title": re.compile(r'"title"\s*:\s*"((?:\\.|[^"\\])*)"'),
    "commentID": re.compile(r'"commentID"\s*:\s*(null|"((?:\\.|[^"\\])*)")'),
    "updatedAt": re.compile(r'"updatedAt"\s*:\s*"((?:\\.|[^"\\])*)"'),
}


def decode_json_string(value: str) -> str:
    return json.loads(f'"{value}"')


def extract_metadata(path: pathlib.Path) -> dict[str, object] | None:
    text = path.read_text(encoding="utf-8", errors="ignore")[:32768]
    url_match = FIELD_PATTERNS["url"].search(text)
    if not url_match:
        return None

    fakeid_match = FIELD_PATTERNS["fakeid"].search(text)
    title_match = FIELD_PATTERNS["title"].search(text)
    comment_match = FIELD_PATTERNS["commentID"].search(text)
    updated_match = FIELD_PATTERNS["updatedAt"].search(text)

    return {
        "fakeid": decode_json_string(fakeid_match.group(1)) if fakeid_match else "",
        "url": decode_json_string(url_match.group(1)),
        "title": decode_json_string(title_match.group(1)) if title_match else "",
        "commentID": None if not comment_match or comment_match.group(1) == "null" else decode_json_string(comment_match.group(2)),
        "updatedAt": decode_json_string(updated_match.group(1)) if updated_match else "",
    }


def main() -> int:
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    export_root = repo_root / "data" / "exports" / "article-library"
    cache_root = export_root / "html-cache"
    index_path = export_root / "html-cache-index.json"

    items: dict[str, dict[str, object]] = {}
    scanned = 0
    skipped = 0

    for path in sorted(cache_root.glob("*.json")):
        scanned += 1
        metadata = extract_metadata(path)
        if not metadata or not metadata["url"]:
            skipped += 1
            continue

        url = str(metadata["url"]).strip()
        items[url] = {
            "fakeid": metadata["fakeid"],
            "title": metadata["title"],
            "commentID": metadata["commentID"],
            "file": f"html-cache/{path.name}",
            "updatedAt": metadata["updatedAt"],
        }

    index_path.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"scanned": scanned, "indexed": len(items), "skipped": skipped, "index": str(index_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
