import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def maybe_fix_mojibake(text: str) -> str:
    if not text:
        return text

    candidates = [text]
    attempts = [
        ("latin1", "utf-8"),
        ("cp1252", "utf-8"),
        ("latin1", "gbk"),
        ("cp1252", "gbk"),
    ]

    for src, dst in attempts:
        try:
            repaired = text.encode(src, errors="strict").decode(dst, errors="strict")
            candidates.append(repaired)
        except Exception:
            continue

    def score(value: str) -> tuple[int, int, int]:
        cjk = sum(1 for ch in value if "\u4e00" <= ch <= "\u9fff")
        bad = sum(1 for ch in value if ch in "ï¿½�")
        alnum = sum(1 for ch in value if ch.isalnum())
        return (cjk, -bad, alnum)

    return max(candidates, key=score)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fix mojibake nicknames in a wechat account manifest")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    manifest = load_json(Path(args.input))
    for account in manifest.get("accounts", []):
        nickname = account.get("nickname")
        if isinstance(nickname, str):
            account["nickname"] = maybe_fix_mojibake(nickname)

    Path(args.output).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"accounts": len(manifest.get("accounts", [])), "output": args.output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
