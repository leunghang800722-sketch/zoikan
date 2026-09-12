#!/usr/bin/env python3
"""P1-WP4 wrapper：叫現有、唔准改嘅 tools/importer/importer/wp4_bochk.py
（P0 code）讀 BOCHK 長工 autopay 發薪檔，將結果（english_name + amount，
PDPO：冇戶口號碼——wp4_bochk.py 本身已經淨係 return 呢兩個欄）dump 做
JSON 落一個 gitignored 路徑（out/ 已經成個資料夾喺 .gitignore）。

呢個檔案本身喺 scripts/ 底下（PDPO：真名/工號唔准入 scripts/），但呢個
檔案完全冇任何工號/真名字面——淨係「點樣攞資料」嘅邏輯，實際員工英文名
只會出現喺 runtime 產生嘅 out/ JSON（gitignored）度，唔會喺呢個 git-tracked
檔案入面出現。

用法：tools/importer/venv/bin/python scripts/seed/lib/py/extract_bochk_payroll.py <out_json_path>
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "tools" / "importer"))

from importer import wp4_bochk  # noqa: E402  (P0 code，唔改)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: extract_bochk_payroll.py <out_json_path>", file=sys.stderr)
        sys.exit(1)
    out_path = Path(sys.argv[1])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        rows = wp4_bochk.load_payroll_editor_rows()
    except FileNotFoundError as exc:
        json.dump({"ok": False, "error": f"file_not_found: {exc}"}, out_path.open("w", encoding="utf-8"))
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001 — 診斷用，寫入 JSON 俾 TS 側判斷，唔炸
        json.dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, out_path.open("w", encoding="utf-8"))
        sys.exit(0)

    payload = {
        "ok": True,
        "rows": [{"english_name": r["english_name"], "amount": str(r["amount"])} for r in rows],
    }
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"wrote {len(rows)} rows -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
