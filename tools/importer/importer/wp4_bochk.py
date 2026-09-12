"""解析 D2 中銀「發薪檔案編輯器」.xls（長工 autopay 出糧清單）。

檔案本身用 Excel 「Velvet Sweatshop」預設密碼加密（唔係使用者自訂密碼），
`msoffcrypto` 解密之後用 `xlrd` 讀（呢個係舊式 .xls biff 格式，openpyxl
唔識讀）。

**PDPO**：呢個檔含銀行戶口號碼（`Employee A/C` 欄）。P0-執行計劃 §8 D2 同
本工作包指示明文：「只用金額，唔准輸出戶口號碼」。呢個 module 淨係
return 員工英文名（做配對 key）同金額，戶口號碼、銀行編號一律唔讀出嚟、
唔傳落去、唔寫入任何 out/ 檔案。
"""
import io
from decimal import Decimal
from pathlib import Path
from typing import List

from . import paths


def load_payroll_editor_rows(xls_path: Path = paths.BOCHK_XLS_2026_07,
                              password: str = paths.BOCHK_XLS_PASSWORD) -> List[dict]:
    """讀「Payroll Editor」sheet 逐行員工發薪記錄。

    Return: [{english_name, amount(Decimal)}]（刻意唔包含戶口/銀行編號欄）。
    """
    import msoffcrypto
    import xlrd

    with open(xls_path, "rb") as fh:
        office_file = msoffcrypto.OfficeFile(fh)
        office_file.load_key(password=password)
        buf = io.BytesIO()
        office_file.decrypt(buf)
        buf.seek(0)
        wb = xlrd.open_workbook(file_contents=buf.read())

    sh = wb.sheet_by_name("Payroll Editor")
    rows = []
    # row 15 (0-based) 係中文/英文雙語表頭（"編號"/"No."），資料由 row 16 開始，
    # 逐行直到 No. 欄空白或者唔係數字為止（後面全部係模板空白列）。
    r = 16
    while r < sh.nrows:
        no_cell = sh.cell_value(r, 0)
        if no_cell in ("", None):
            break
        name = str(sh.cell_value(r, 4)).strip()
        amount_raw = sh.cell_value(r, 5)
        if not name or amount_raw in ("", None):
            r += 1
            continue
        rows.append({
            "english_name": name,
            "amount": Decimal(str(amount_raw)),
        })
        r += 1
    return rows


def load_names_en_tiers() -> List[dict]:
    """讀 data/mappings-private/names_en.csv（真名對照＋WP2b/WP3 分嘅
    longterm/small 兩層），Return 逐行 dict（english_name, name_zh,
    confidence, tier, evidence）。"""
    import csv
    with open(paths.NAMES_EN_CSV, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))
