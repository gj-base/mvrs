#!/usr/bin/env python3
"""Usage: python scripts/load-deploy-payload.py <function-name>"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scripts/load-deploy-payload.py <function-name>", file=sys.stderr)
        sys.exit(1)
    path = ROOT / f".deploy-mcp-{sys.argv[1]}.json"
    sys.stdout.buffer.write(path.read_bytes())


if __name__ == "__main__":
    main()
