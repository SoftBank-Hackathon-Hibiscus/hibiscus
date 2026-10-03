"""Export the verified recorded report; no Docker, backend, or LLM calls.

From parity/: python scripts/export_diagnosis_demo.py [--check]
"""

import argparse
import sys
import tempfile
from pathlib import Path

PARITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PARITY))

from premortem.diagnosis import main as generate  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check the committed frontend report without changing it")
    args = parser.parse_args()
    fixture = PARITY / "examples" / "diagnosis"
    target = PARITY.parent / "frontend" / "public" / "diagnosis" / "guestbook.html"
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "report"
        status = generate([
            "--bundle", str(fixture / "guestbook"), "--source", "app.py",
            "--recorded", str(fixture / "guestbook-analysis.json"), "--out", str(output),
            "--translation", str(fixture / "guestbook-analysis.ja.json"),
        ])
        if status:
            return status
        html = (output / "index.html").read_text(encoding="utf-8")
        if args.check:
            if not target.is_file() or target.read_text(encoding="utf-8") != html:
                print("Frontend report is missing or stale; run scripts/export_diagnosis_demo.py", file=sys.stderr)
                return 1
            print("Frontend report matches the verified recording.")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(html, encoding="utf-8", newline="\n")
            print(f"Exported: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
