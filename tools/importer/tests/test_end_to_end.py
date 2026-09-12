"""End-to-end test: 21 個真實更表 -> 逐盤 work 更數 對 P0-執行計劃.md 第 4 節目標數字。

data/2026-07/ 冇入 git（PDPO），所以呢個 test 喺冇資料嘅環境會自動 skip，唔會 fail CI。
"""
import csv
import json
from collections import defaultdict

import pytest

from importer import paths
from importer.extract import run_extract
from importer.validate import run_validate

pytestmark = pytest.mark.skipif(
    not paths.DATA_DIR.exists() or not list(paths.DATA_DIR.glob("*.xlsx")),
    reason="data/2026-07/*.xlsx 唔存在（本機專用資料，冇入 git）",
)

# file substring -> expected internal work count (唔計 external/pointer)
# 見 P0-執行計劃.md §「驗收目標」
EXPECTED_WORK_INTERNAL = {
    "城巴車廠": 517,
    "啟航1331": 1126,
    "數碼港 - Jul": 230,
    "數碼港 CP5 - Jul": 205,  # 180 (在勤) + 25 (早更IC)
    "數碼港 CP5 數據中心": 23,
    "HKU座頭": 201,
    "HKU Y更": 166,
    "屯門凱和山": 73,
    "淺水灣道11號蔚峰園": 88,
    "九龍企業大廈": 62,
    "屯門小欖樂怡街5號": 62,
    "粉嶺安樂村貨倉": 62,
    "Weave Hospital Road": 32,
    "Weave Robinson": 32,
    "Weave OL": 31,
    "IFC 70樓": 40,
    "皓日": 17,
    "殷樺花園": 25,
    "怡安168": 4,
    "美心集團中心": 2,
    "HKU 醫學院": 5,
}

EXPECTED_CITYBUS_SUB_SITE = {
    "柴灣城巴車廠": 189,
    "創富車廠": 182,
    "屯門城巴車廠": 31,
    "黃竹坑城巴車廠": 31,
    "東涌城巴車廠": 31,
    "將軍澳城巴車廠": 31,
    "西九龍城巴車廠": 17,
    "上環城巴車廠": 5,
}

EXPECTED_EXTERNAL = {
    "數碼港 - Jul": 260,   # Wilson Guard
    "數碼港 CP5 - Jul": 26,  # Wilson Supervisor
}

EXPECTED_POINTER = {
    "數碼港 CP5 - Jul": 3,
}

EXPECTED_OT = {
    "HKU座頭": 6,
}


def test_all_21_files_read_and_hidden_sheets_excluded():
    summary = run_extract()
    assert summary["files"] == 21
    # 6 hidden 工作表1 excluded: HKU Y更, HKU座頭, 數碼港, 啟航1331, 城巴,
    # HKU 醫學院（第 21 檔，隱藏 sheet 係 2025-12 啟航1331 殘留，照排除）
    assert summary["hidden_sheets"] == 6
    assert summary["unparsed"] == 0


def test_work_counts_match_p0_plan_targets():
    run_extract()
    records = [json.loads(l) for l in open(paths.RECORDS_JSONL, encoding="utf-8")]

    work_internal = defaultdict(int)
    external = defaultdict(int)
    pointer = defaultdict(int)
    ot = defaultdict(int)
    sub_site_citybus = defaultdict(int)

    for rec in records:
        file_ = rec["file"]
        if rec["kind"] == "work" and not rec["external"]:
            work_internal[file_] += 1
            if rec["sub_site"]:
                sub_site_citybus[rec["sub_site"]] += 1
        elif rec["kind"] == "work" and rec["external"]:
            external[file_] += 1
        elif rec["kind"] == "pointer":
            pointer[file_] += 1
        elif rec["kind"] == "ot":
            ot[file_] += 1

    def find_file(substr):
        matches = [f for f in work_internal.keys() | external.keys() | pointer.keys() | ot.keys()
                   if substr in f]
        assert len(matches) == 1, f"expected exactly 1 match for {substr!r}, got {matches}"
        return matches[0]

    for substr, expected in EXPECTED_WORK_INTERNAL.items():
        f = find_file(substr)
        assert work_internal[f] == expected, f"{f}: work_internal={work_internal[f]} != {expected}"

    for substr, expected in EXPECTED_EXTERNAL.items():
        f = find_file(substr)
        assert external[f] == expected, f"{f}: external={external[f]} != {expected}"

    for substr, expected in EXPECTED_POINTER.items():
        f = find_file(substr)
        assert pointer[f] == expected, f"{f}: pointer={pointer[f]} != {expected}"

    for substr, expected in EXPECTED_OT.items():
        f = find_file(substr)
        assert ot[f] == expected, f"{f}: ot={ot[f]} != {expected}"

    assert dict(sub_site_citybus) == EXPECTED_CITYBUS_SUB_SITE


def test_cp5_work_splits_into_per_shift_and_monthly_ic():
    """WP1 修正 5: summary.csv 要拆得出 180 (per_shift) + 25 (monthly_ic)，
    唔靠喺 code 度寫死 CP5 —— 分類完全由 mappings/rank_billing.csv 驅動。
    """
    run_extract()
    with open(paths.SUMMARY_CSV, encoding="utf-8-sig", newline="") as fh:
        summary_rows = list(csv.DictReader(fh))
    cp5_rows = [r for r in summary_rows if "數碼港 CP5 - Jul" in r["file"]]
    assert len(cp5_rows) == 1
    row = cp5_rows[0]
    assert int(row["work_per_shift"]) == 180
    assert int(row["work_monthly_ic"]) == 25
    assert int(row["work_internal"]) == 205


def test_day_total_mismatch_confined_to_known_qihang_shape():
    """WP1 修正 2: 逐 (time_slot, code) 逐日對數之後，19/20 檔應該全部 0 差異，
    淨低啟航1331 一條已知、可解釋嘅差異（Event Guard 1000-1900 嘅更表面睇時段
    唔同，但 sheet 自己嘅 0730-1930 早更 D Total 行連佢埋一齊計）。
    """
    run_extract()
    result = run_validate()
    assert result["row_total_mismatch"] == 0

    with open(paths.VAL_DAY_TOTAL_MISMATCH_CSV, encoding="utf-8-sig", newline="") as fh:
        mismatches = list(csv.DictReader(fh))

    files_with_mismatch = {m["file"] for m in mismatches}
    for f in files_with_mismatch:
        assert "啟航1331" in f, f"預期淨係啟航1331先有逐日差異，但見到: {files_with_mismatch}"
    for m in mismatches:
        assert m["time_slot"] == "0730-1930"
        assert m["code"] == "D"
