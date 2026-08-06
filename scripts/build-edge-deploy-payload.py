#!/usr/bin/env python3
"""Edge Function 배포 페이로드 생성. Usage: python scripts/build-edge-deploy-payload.py submit-reservation"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SPECS = {
    "submit-reservation": {
        "name": "submit-reservation",
        "entrypoint_path": "index.ts",
        "verify_jwt": False,
        "files": [
            ("index.ts", "supabase/functions/submit-reservation/index.ts"),
            ("../_shared/booking_deadline.ts", "supabase/functions/_shared/booking_deadline.ts"),
        ],
    },
    "my-reservations": {
        "name": "my-reservations",
        "entrypoint_path": "supabase/functions/my-reservations/index.ts",
        "verify_jwt": False,
        "files": [
            ("supabase/functions/my-reservations/index.ts", "supabase/functions/my-reservations/index.ts"),
            ("supabase/functions/_shared/booking_deadline.ts", "supabase/functions/_shared/booking_deadline.ts"),
        ],
    },
    "check-booking-submit-allowed": {
        "name": "check-booking-submit-allowed",
        "entrypoint_path": "index.ts",
        "verify_jwt": False,
        "files": [
            ("index.ts", "supabase/functions/check-booking-submit-allowed/index.ts"),
            ("../_shared/booking_submit_block_ip.ts", "supabase/functions/_shared/booking_submit_block_ip.ts"),
            ("../_shared/admin_source_ip.ts", "supabase/functions/_shared/admin_source_ip.ts"),
        ],
    },
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in SPECS:
        print("Usage: python scripts/build-edge-deploy-payload.py <function-name>", file=sys.stderr)
        sys.exit(1)
    spec = SPECS[sys.argv[1]]
    payload = {
        "name": spec["name"],
        "entrypoint_path": spec["entrypoint_path"],
        "verify_jwt": spec["verify_jwt"],
        "files": [
            {"name": name, "content": (ROOT / rel).read_text(encoding="utf-8")}
            for name, rel in spec["files"]
        ],
    }
    out = ROOT / f".deploy-mcp-{spec['name']}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
