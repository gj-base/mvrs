#!/usr/bin/env python3
"""Supabase MCP deploy_edge_function 호출용 — JSON 페이로드를 stdin/파일에서 읽어 deploy 인자 출력."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_payload(name: str) -> dict:
    path = ROOT / f".deploy-mcp-{name}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scripts/mcp-deploy-args.py <function-name>", file=sys.stderr)
        sys.exit(1)
    payload = load_payload(sys.argv[1])
    # stdout: compact JSON for MCP tool arguments
    json.dump(payload, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
