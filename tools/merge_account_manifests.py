import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge wechat account manifests by fakeid")
    parser.add_argument("--base", required=True)
    parser.add_argument("--extra", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    base = load_json(Path(args.base))
    extra = load_json(Path(args.extra))

    merged: dict[str, dict[str, Any]] = {}
    for item in base.get("accounts", []):
        merged[item["fakeid"]] = item
    for item in extra.get("accounts", []):
        merged[item["fakeid"]] = item

    accounts = sorted(merged.values(), key=lambda item: item.get("nickname") or item["fakeid"])
    output = {
        "version": "1.0",
        "usefor": "wechat-article-exporter",
        "accounts": accounts,
    }
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"accounts": len(accounts), "output": args.output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
