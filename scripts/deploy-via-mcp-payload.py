#!/usr/bin/env python3
"""Print deploy_edge_function MCP arguments JSON to stdout."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scripts/deploy-via-mcp-payload.py <function-name>", file=sys.stderr)
        sys.exit(1)
    path = ROOT / f".deploy-mcp-{sys.argv[1]}.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    json.dump(payload, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
