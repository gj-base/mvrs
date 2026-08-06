#!/usr/bin/env python3
"""Supabase MCP deploy_edge_function 호출용 JSON 출력 (Cursor agent가 MCP에 전달)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    names = sys.argv[1:] or ["submit-reservation", "my-reservations"]
    for name in names:
        path = ROOT / f".deploy-mcp-{name}.json"
        if not path.exists():
            print(f"MISSING {path}", file=sys.stderr)
            sys.exit(1)
        payload = json.loads(path.read_text(encoding="utf-8"))
        # markers for verification
        idx = payload["files"][0]["content"]
        markers = {
            "submit-reservation": {
                "status_approve": 'status: "승인"' in idx,
                "deadline": "isUserActionAllowed" in idx,
                "mail": "invokeConfirmationEmail" in idx,
            },
            "my-reservations": {
                "can_edit": "can_edit" in idx,
                "deadline": "booking_deadline" in idx or "isUserActionAllowed" in idx,
            },
        }.get(name, {})
        print(f"=== {name} ===")
        print(json.dumps({"markers": markers, "file_count": len(payload["files"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
