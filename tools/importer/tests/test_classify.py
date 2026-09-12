"""Pointer / external / OT 分類測試，以及 HKU Y更 姓名後綴拆分測試。"""
from importer.extract import EXTERNAL_MARKERS, _split_name
from importer.mappings_io import DEFAULT_BILLING_GROUP, load_cell_codes, load_rank_billing


def test_cell_codes_kinds():
    codes = load_cell_codes()
    assert codes["N"] == "work"
    assert codes["D"] == "work"
    assert codes["C1"] == "work"
    assert codes["IC"] == "work"
    assert codes["SIC"] == "work"
    assert codes["Y"] == "work"
    assert codes["OT1"] == "ot"
    for leave_code in ("RD", "SH", "AL", "SL", "NPL", "NL", "OFF"):
        assert codes[leave_code] == "leave"
    assert codes["數據中心"] == "pointer"
    assert "不存在嘅代號" not in codes


def test_external_markers_match_wilson_only():
    assert "Wilson Guard" in EXTERNAL_MARKERS
    assert "Wilson Supervisor" in EXTERNAL_MARKERS
    assert any(m in "Wilson Guard" for m in EXTERNAL_MARKERS)
    assert any(m in "Wilson Supervisor" for m in EXTERNAL_MARKERS)
    assert not any(m in "Sample Guard One" for m in EXTERNAL_MARKERS)
    assert not any(m in "Sample Guard Two" for m in EXTERNAL_MARKERS)


def test_name_suffix_split_hku_y_shift():
    assert _split_name("測試員甲(上)") == ("測試員甲", "上村")
    assert _split_name("測試員甲(摩)") == ("測試員甲", "摩星嶺")
    assert _split_name("測試員乙 (上)") == ("測試員乙", "上村")  # 原文有空格
    assert _split_name("測試員丙 (上)") == ("測試員丙", "上村")
    assert _split_name("測試員丁(上)") == ("測試員丁", "上村")


def test_name_without_suffix_untouched():
    assert _split_name("測試員戊") == ("測試員戊", None)


def test_rank_billing_exception_and_default_fallback():
    """rank_billing.csv 淨係列例外（早更IC -> monthly_ic）；其他 rank 一律
    用 DEFAULT_BILLING_GROUP（per_shift），唔使逐個 rank 列晒先得（WP1 修正 5:
    唔好寫死 CP5——分類係靠呢個 CSV 驅動，唔係靠 code 入面認 file name）。
    """
    billing = load_rank_billing()
    assert billing["早更IC"] == "monthly_ic"
    assert DEFAULT_BILLING_GROUP == "per_shift"
    # 任何冇喺 CSV 出現嘅 rank 都要靠 call site 嘅 .get(rank, DEFAULT) 拎到
    # per_shift —— 呢度模擬 summary 果句寫法。
    for rank in ("早更保安員", "夜更保安員", "Event Guard", "唔存在嘅 rank"):
        assert billing.get(rank, DEFAULT_BILLING_GROUP) == "per_shift"
