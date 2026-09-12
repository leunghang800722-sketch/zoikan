"""WP2b (normalize.py) 單元測試：R1 合併/拆開兩個實證、R2 優先次序、
別名解析、守恆邏輯嘅細部函數。呢啲測試用合成數據，唔靠真實 data/2026-07
（PDPO），亦唔需要跑成個 run_wp2b()（嗰個要真實 WP1/WP2a 輸出，留俾
test_end_to_end 風格嘅 skip-if-missing 測試，見底部）。
"""
import csv
import json
from collections import Counter
from pathlib import Path

import pytest

from importer.normalize import (
    BrokerIndex,
    SiteIndex,
    _find_conflicted_staff_no,
    build_payroll_index,
    is_aggregate_guard_name,
    is_longterm_payroll_row,
    levenshtein,
    normalize_name,
    normalize_site_label,
    normalize_tel,
    payroll_row_key,
    payroll_site_slices,
    resolve_identities,
    resolve_settlement_for_row,
)
from importer import paths


def _row(file="f.xlsx", row="1", staff_no="", tel="", name="", name_raw=None,
         external="False", **extra):
    d = {
        "file": file, "sheet": "2026", "row": row, "staff_no": staff_no,
        "tel": tel, "name": name, "name_raw": name_raw or name,
        "external": external, "site_raw": "測試盤", "sub_site": "",
        "broker_code": "", "time_slot": "1900-0700", "rank": "夜更保安員",
        "work_count": "1",
    }
    d.update(extra)
    return d


# ---------------------------------------------------------------------------
# R1：身份合併／拆開（用假名假電話，唔用真員工資料）
# ---------------------------------------------------------------------------

def test_split_on_shared_staff_no_with_two_different_phones():
    """實證（改用假名假電話，真實案例見 P0-執行計劃.md §3.8「工號錯誤實證」，
    唔喺呢度重複真實 staff_no／電話／姓名）：同一個 staff_no，但兩個唔同
    電話、唔同名——即「一號兩人」嗰種情況——要拆做兩個獨立安員，兩個都
    記 staff_no_conflict，正式 staff_no 留空。"""
    rows = [
        _row(file="a.xlsx", row="1", staff_no="U99999", tel="1111 1111", name="測試員甲"),
        _row(file="b.xlsx", row="2", staff_no="U99999", tel="2222 2222", name="測試員乙"),
    ]
    guard_id_by_rowkey, guards, decisions = resolve_identities(rows)
    g1 = guards[[g["guard_id"] for g in guards].index(guard_id_by_rowkey[("a.xlsx", "1")])]
    g2 = guards[[g["guard_id"] for g in guards].index(guard_id_by_rowkey[("b.xlsx", "2")])]
    assert g1["guard_id"] != g2["guard_id"]
    assert g1["staff_no"] == "" and g2["staff_no"] == ""
    assert g1["staff_no_conflict"] == "U99999"
    assert g2["staff_no_conflict"] == "U99999"
    split_decisions = [d for d in decisions if d["decision"] == "split"]
    assert len(split_decisions) == 2
    assert {d["guard_ids"] for d in split_decisions} == {g1["guard_id"], g2["guard_id"]}


def test_merge_on_same_name_and_phone_different_staff_no():
    """實證（改用假名假電話，真實案例見 P0-執行計劃.md §3.8「工號錯誤實證」，
    唔喺呢度重複真實 staff_no／電話／姓名）：同名（含同形字變體）＋同電話，
    但兩個唔同 staff_no——即「一人兩號」嗰種情況——要合併做一個安員，
    staff_no 揀出現次數多嗰個，另一個入 staff_no_aliases。"""
    rows = [
        _row(file="a.xlsx", row="1", staff_no="U10001", tel="8888 8888", name="黃小明"),
        _row(file="b.xlsx", row="2", staff_no="U10001", tel="8888 8888", name="黃小明"),
        _row(file="c.xlsx", row="3", staff_no="U20002", tel="8888 8888", name="黄小明"),  # 同形字變體（黃/黄）
    ]
    guard_id_by_rowkey, guards, decisions = resolve_identities(rows)
    gid_a = guard_id_by_rowkey[("a.xlsx", "1")]
    gid_b = guard_id_by_rowkey[("b.xlsx", "2")]
    gid_c = guard_id_by_rowkey[("c.xlsx", "3")]
    assert gid_a == gid_b == gid_c
    guard = next(g for g in guards if g["guard_id"] == gid_a)
    assert guard["staff_no"] == "U10001"  # 出現兩次，多過 U20002 一次
    assert "U20002" in guard["staff_no_aliases"].split(";")
    merges = [d for d in decisions if d["decision"] == "merge"]
    assert len(merges) == 1
    assert merges[0]["guard_ids"] == gid_a


def test_blank_tel_does_not_trigger_false_split():
    """回歸測試：同一 staff_no，一行有電話一行電話留空（更表漏填，唔係
    第二個人）——唔應該當拆開處理，應該合併做一個安員，維持個 staff_no。"""
    rows = [
        _row(file="a.xlsx", row="1", staff_no="U30003", tel="", name="測試員丁"),
        _row(file="a.xlsx", row="2", staff_no="U30003", tel="3333 3333", name="測試員丁"),
    ]
    guard_id_by_rowkey, guards, decisions = resolve_identities(rows)
    gid1 = guard_id_by_rowkey[("a.xlsx", "1")]
    gid2 = guard_id_by_rowkey[("a.xlsx", "2")]
    assert gid1 == gid2
    guard = next(g for g in guards if g["guard_id"] == gid1)
    assert guard["staff_no"] == "U30003"
    assert guard["staff_no_conflict"] == ""
    assert not any(d["decision"] == "split" for d in decisions)


def test_conflicted_staff_no_needs_two_distinct_nonblank_phones():
    rows = [
        _row(staff_no="U1", tel="", name="甲"),
        _row(staff_no="U1", tel="", name="甲"),
    ]
    assert _find_conflicted_staff_no(rows) == set()
    rows2 = [
        _row(staff_no="U1", tel="1111 1111", name="甲"),
        _row(staff_no="U1", tel="2222 2222", name="乙"),
    ]
    assert _find_conflicted_staff_no(rows2) == {"U1"}


def test_no_staff_no_no_tel_keyed_by_name_and_file():
    """Event Guard / Wilson 嘅人：冇 staff_no 又冇電話 -> 用 name+file 做身份，
    唔跨檔合併（唔同檔嘅同名人當唔同人，因為冇任何嘢證明係同一個）。"""
    rows = [
        _row(file="a.xlsx", row="1", name="散工", external="True"),
        _row(file="b.xlsx", row="2", name="散工", external="True"),
    ]
    guard_id_by_rowkey, guards, _ = resolve_identities(rows)
    assert guard_id_by_rowkey[("a.xlsx", "1")] != guard_id_by_rowkey[("b.xlsx", "2")]


# ---------------------------------------------------------------------------
# 別名解析（sites / brokers）
# ---------------------------------------------------------------------------

def test_site_index_resolves_exact_and_normalized_alias():
    sites = [{"site_id": "S1", "canonical_name": "測試盤", "client": "", "client_group": "",
              "billing_model": "per_shift", "aliases": ["測試盤別名", "測試盤(夜)"]}]
    idx = SiteIndex(sites)
    assert idx.resolve("測試盤") == "S1"
    assert idx.resolve("測試盤別名") == "S1"
    assert idx.resolve("測試盤(夜)") == "S1"
    assert idx.resolve("測試盤夜更") == "S1"  # 靠 normalize_site_label 去尾綴
    assert idx.resolve("完全唔存在嘅盤") is None
    assert idx.resolve(None) is None


def test_site_alias_change_propagates_without_code_change():
    """對照表改一個別名要即時改變輸出（data-driven 嘅核心保證）。"""
    sites = [{"site_id": "S1", "canonical_name": "正名", "client": "", "client_group": "",
              "billing_model": "per_shift", "aliases": []}]
    idx_before = SiteIndex(sites)
    assert idx_before.resolve("舊叫法") is None
    sites[0]["aliases"] = ["舊叫法"]
    idx_after = SiteIndex(sites)
    assert idx_after.resolve("舊叫法") == "S1"


def test_broker_index_resolves_settlement_unit_and_roster_code():
    brokers = [
        {"broker_id": "B1", "code": "K", "canonical_name": "K", "aliases": ["K-LINK", "K-1331"],
         "kind": "broker", "settlement_type": "cash"},
    ]
    idx = BrokerIndex(brokers)
    assert idx.resolve_settlement_unit("K-LINK") == "B1"
    assert idx.resolve_settlement_unit("K-1331") == "B1"
    assert idx.resolve_roster_code("K") == "B1"
    assert idx.code_of("B1") == "K"
    assert idx.name_of("B1") == "K"


# ---------------------------------------------------------------------------
# R2：結算單位反推優先次序
# ---------------------------------------------------------------------------

def _broker_index():
    return BrokerIndex([
        {"broker_id": "BW", "code": "W", "canonical_name": "W", "aliases": ["W"],
         "kind": "broker", "settlement_type": "cash"},
        {"broker_id": "BT", "code": "T", "canonical_name": "T", "aliases": ["T"],
         "kind": "broker", "settlement_type": "cash"},
    ])


def test_r2_prefers_payroll_match_over_roster_code():
    """R2 rule 1：糧明細優先，更表 A 欄只做交叉核對。"""
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client": "", "client_group": "",
                              "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_rows = [
        {"source_file": "p.pdf", "page": "1", "settlement_unit": "T", "row_no": "1",
         "site_label": "測試盤", "guard_name": "測試員己", "time_slot": "", "shift_kind": "normal",
         "shifts": "10", "wage": "700", "broker_fee": "", "bank_note": ""},
    ]
    payroll_by_name_site, unmapped = build_payroll_index(payroll_rows, site_index, {})
    assert unmapped == {}
    wp1_row = {"broker_code": "Y"}  # 更表標 Y，但糧明細話係 T
    guard = {"name_zh": "測試員己", "name_variants": ""}
    result = resolve_settlement_for_row(wp1_row, guard, "S1", payroll_by_name_site, broker_index, {})
    assert result["settlement_unit"] == "T"
    assert result["source"] == "payroll"
    assert result["roster_code_agrees"] == "False"  # Y != T，記入 broker-conflicts


def test_r2_falls_back_to_autopay_names_en_when_no_payroll_row():
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client": "", "client_group": "",
                              "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_by_name_site, _ = build_payroll_index([], site_index, {})
    names_en_by_zh = {normalize_name("測試員戊"): {"english_name": "SAMPLE GUARD FOUR", "confidence": "high"}}
    guard = {"name_zh": "測試員戊", "name_variants": ""}
    result = resolve_settlement_for_row({"broker_code": ""}, guard, "S1", payroll_by_name_site, broker_index, names_en_by_zh)
    assert result["settlement_unit"] == "autopay_longterm"
    assert result["source"] == "autopay"
    assert result["confidence"] == "high"


def test_r2_unknown_when_neither_payroll_nor_autopay_match():
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client": "", "client_group": "",
                              "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_by_name_site, _ = build_payroll_index([], site_index, {})
    guard = {"name_zh": "完全查唔到嘅人", "name_variants": ""}
    result = resolve_settlement_for_row({"broker_code": ""}, guard, "S1", payroll_by_name_site, broker_index, {})
    assert result["settlement_unit"] == "unknown"
    assert result["source"] == "none"


def test_r2_detects_longterm_via_autopay_bank_note():
    """糧明細該行 wage 空／broker_fee 有值（bank_note=Autopay）=> 安員係
    長工，settlement_unit=autopay_longterm，referral_broker=該雞頭。"""
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client": "", "client_group": "",
                              "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_rows = [
        {"source_file": "p.pdf", "page": "4", "settlement_unit": "T", "row_no": "5",
         "site_label": "測試盤", "guard_name": "長工甲", "time_slot": "", "shift_kind": "normal",
         "shifts": "24", "wage": "", "broker_fee": "720", "bank_note": "Autopay(長工)"},
    ]
    payroll_by_name_site, _ = build_payroll_index(payroll_rows, site_index, {})
    guard = {"name_zh": "長工甲", "name_variants": ""}
    result = resolve_settlement_for_row({"broker_code": ""}, guard, "S1", payroll_by_name_site, broker_index, {})
    assert result["settlement_unit"] == "autopay_longterm"
    assert result["referral_broker"] == "T"
    assert result["source"] == "payroll"


def test_b1_mixed_row_slices_keep_only_own_site_cells():
    """B1 回歸測試：混合行（決定 5，真實案例見 P0-執行計劃.md，一個人一行
    印住多過一個盤名，例如「31/皓日/創富(混合)」）逐格
    拆盤之後，每個 site slice 淨係應該帶住屬於自己嗰個盤嘅 cells，唔可以
    夾埋第二個 slice 嘅日子——呢個係 day-mismatch.csv 逐日對數唔可以將
    另一個盤嗰日都當「呢個盤有做」嘅根本保證（wp2b_run.py 嘅
    cells_by_key4 就係逐個 slice 攞呢度嘅 cells 嚟做逐日比較）。"""
    site_index = SiteIndex([
        {"site_id": "SA", "canonical_name": "盤A", "client": "", "client_group": "",
         "billing_model": "per_shift", "aliases": []},
        {"site_id": "SB", "canonical_name": "盤B", "client": "", "client_group": "",
         "billing_model": "per_shift", "aliases": []},
    ])
    row = {"source_file": "p.pdf", "page": "2", "settlement_unit": "公司兵", "row_no": "15",
           "site_label": "盤A/盤B(混合)", "guard_name": "混合工", "shift_kind": "normal", "shifts": "10"}
    # C2 修正後 key 加咗 guard_name（(source_file,page,row_no,guard_name)），
    # 同 cells 檔自己嘅 guard_name 對齊。
    cells_by_row_key = {
        ("p.pdf", "2", "15", "混合工"): [
            {"day": "1", "site_label": "盤A", "guard_name": "混合工", "cell_kind": "shift"},
            {"day": "2", "site_label": "盤A", "guard_name": "混合工", "cell_kind": "shift"},
            {"day": "10", "site_label": "盤B", "guard_name": "混合工", "cell_kind": "shift"},
        ]
    }
    slices = payroll_site_slices([row], site_index, cells_by_row_key)
    by_site = {sid: cells for _row, sid, _is_mixed, cells, _key4 in slices}
    assert set(by_site.keys()) == {"SA", "SB"}
    assert {c["day"] for c in by_site["SA"]} == {"1", "2"}
    assert {c["day"] for c in by_site["SB"]} == {"10"}
    # SA 嘅 slice 唔可以睇到 SB 嗰日（10 號），反之亦然——呢個先係修正
    # 之前嘅 bug（wp2b_run.py 曾經用成行嘅 cells_by_row_key 嚟做逐日對比，
    # 兩個 slice 見到同一份 10 格，令另一個 site 冇做嗰日都當佢有做）。
    assert "10" not in {c["day"] for c in by_site["SA"]}
    assert "1" not in {c["day"] for c in by_site["SB"]}


def test_b3_inferred_guard_only_fires_per_person_with_staff_no():
    """B3 回歸測試：推斷長工規則（決定 2）改做逐人判斷之後——
    (1) 有 staff_no、個人名完全冇喺任何現金糧明細出現過 => inferred_guard；
    (2) 有 staff_no，但個人名有喺現金糧明細出現過（哪怕唔係呢個盤）=> 唔
        觸發呢條規則，跌落 unknown（避免誤判，真正嘅盤配對留俾人手覆核）；
    (3) 冇 staff_no（Event Guard/散工）=> 唔觸發，永遠留喺 unknown，因為冇
        工號冇辦法追蹤佢係咪長工。
    呢個係修 B3 之前嘅 bug（舊規則要求『成個盤現金糧明細完全冇任何人』先
    觸發，數碼港/HKU 呢類有零星現金人嘅盤永遠唔觸發）嘅回歸保證。"""
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "數碼港CP1-4", "client": "",
                              "client_group": "", "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_guard_names = {normalize_name("張三")}  # 「張三」有喺現金糧明細出現過（可能係另一個盤）

    guard_with_sn_unseen = {"name_zh": "李四", "name_variants": "", "staff_no": "U88888"}
    result1 = resolve_settlement_for_row({"broker_code": ""}, guard_with_sn_unseen, "S1", {}, broker_index, {},
                                          payroll_guard_names=payroll_guard_names)
    assert result1["settlement_unit"] == "autopay_longterm"
    assert result1["source"] == "inferred_guard"
    assert result1["confidence"] == "low"

    guard_with_sn_seen = {"name_zh": "張三", "name_variants": "", "staff_no": "U77777"}
    result2 = resolve_settlement_for_row({"broker_code": ""}, guard_with_sn_seen, "S1", {}, broker_index, {},
                                          payroll_guard_names=payroll_guard_names)
    assert result2["settlement_unit"] == "unknown"
    assert result2["source"] == "none"

    guard_no_sn = {"name_zh": "王五", "name_variants": "", "staff_no": ""}
    result3 = resolve_settlement_for_row({"broker_code": ""}, guard_no_sn, "S1", {}, broker_index, {},
                                          payroll_guard_names=payroll_guard_names)
    assert result3["settlement_unit"] == "unknown"
    assert result3["source"] == "none"
    assert "冇 staff_no" in result3["note"]


def test_is_longterm_payroll_row_and_aggregate_guard_name():
    assert is_longterm_payroll_row({"bank_note": "Autopay(長工)", "shift_kind": "normal"})
    assert is_longterm_payroll_row({"bank_note": "", "shift_kind": "flat_referral"})
    assert not is_longterm_payroll_row({"bank_note": "Cash", "shift_kind": "normal"})
    assert is_aggregate_guard_name("(156更長工整體)")
    assert is_aggregate_guard_name("")
    assert not is_aggregate_guard_name("測試員己")


# ---------------------------------------------------------------------------
# C2（放行條件，2026-09-04）：payroll_row_key 加 guard_name，防止「一個
# row_no 印住兩個人」（K-LINK p1 row4「TKO Gateway 厚B」厚B安員丙/厚B安員丁
# 案，改用假名測試）張冠李戴。
# ---------------------------------------------------------------------------

def test_payroll_row_key_includes_guard_name():
    row_a = {"source_file": "p.pdf", "page": "1", "row_no": "4", "guard_name": "測試員甲"}
    row_b = {"source_file": "p.pdf", "page": "1", "row_no": "4", "guard_name": "測試員乙"}
    assert payroll_row_key(row_a) != payroll_row_key(row_b)
    assert payroll_row_key(row_a) == ("p.pdf", "1", "4", "測試員甲")


def test_one_row_two_people_cells_do_not_cross_contaminate():
    """回歸測試（改用假名）：一個 row_no 印住兩個人，各自嘅 cells 唔可以
    夾埋——用 guard_name 做 key 嘅第四個元素分開返，每個人淨係攞到屬於
    自己個 guard_name 嘅 cells。"""
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client_name": "",
                              "client_group": "", "billing_model": "per_shift", "aliases": []}])
    row_a = {"source_file": "p.pdf", "page": "1", "row_no": "4", "site_label": "測試盤",
             "guard_name": "測試員甲", "shift_kind": "normal", "shifts": "15"}
    row_b = {"source_file": "p.pdf", "page": "1", "row_no": "4", "site_label": "測試盤",
             "guard_name": "測試員乙", "shift_kind": "normal", "shifts": "1"}
    cells_by_row_key = {
        ("p.pdf", "1", "4", "測試員甲"): [
            {"day": str(d), "site_label": "測試盤", "guard_name": "測試員甲", "cell_kind": "shift"}
            for d in range(1, 16)
        ],
        ("p.pdf", "1", "4", "測試員乙"): [
            {"day": "23", "site_label": "測試盤", "guard_name": "測試員乙", "cell_kind": "shift"},
        ],
    }
    slices = payroll_site_slices([row_a, row_b], site_index, cells_by_row_key)
    cells_by_guard = {r["guard_name"]: cells for r, _sid, _mixed, cells, _key4 in slices}
    assert len(cells_by_guard["測試員甲"]) == 15
    assert len(cells_by_guard["測試員乙"]) == 1
    assert cells_by_guard["測試員乙"][0]["day"] == "23"


# ---------------------------------------------------------------------------
# C3（放行條件，2026-09-04）：兄弟盤 site override（siblings_of）+ 近似名
# （levenshtein ≤1）。
# ---------------------------------------------------------------------------

def test_siblings_of_uses_nonempty_client_group_only():
    sites = [
        {"site_id": "S006", "canonical_name": "HKU Y更", "client_name": "HKU", "client_group": "HKU",
         "billing_model": "per_shift", "aliases": []},
        {"site_id": "S007", "canonical_name": "HKU座頭", "client_name": "HKU", "client_group": "HKU",
         "billing_model": "per_shift", "aliases": []},
        {"site_id": "S029", "canonical_name": "蔚峰園", "client_name": "", "client_group": "",
         "billing_model": "per_shift", "aliases": []},
    ]
    idx = SiteIndex(sites)
    assert set(idx.siblings_of("S006")) == {"S007"}
    assert set(idx.siblings_of("S007")) == {"S006"}
    # client_group 空白唔算兄弟盤（唔可以將全部冇填 client_group 嘅盤當一組）
    assert idx.siblings_of("S029") == []


def test_levenshtein_edit_distance_one_for_near_match_names():
    """實證（改用假名，真實案例見 P0-執行計劃.md §3.4：兩對名各只差一個
    字嘅安員，喺 C3 近似名規則觸發人手覆核，唔喺 code 度重複真實姓名）。"""
    assert levenshtein("測試員己", "測試員庚") == 1
    assert levenshtein("測試員辛", "測試員壬") == 1
    assert levenshtein("測試員己", "測試員己") == 0
    assert levenshtein("測試員己", "完全無關者") > 1


# ---------------------------------------------------------------------------
# C4（放行條件，2026-09-04）：客戶員工（is_external=True）一律 rule 0
# settlement_unit=external，優先於所有配對規則，唔會跌入 unknown。
# ---------------------------------------------------------------------------

def test_r0_external_guard_always_resolves_to_external():
    site_index = SiteIndex([{"site_id": "S010", "canonical_name": "數碼港 CP1-4", "client_name": "",
                              "client_group": "數碼港", "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    guard = {"name_zh": "Wilson Guard", "name_variants": "", "is_external": True, "staff_no": ""}
    result = resolve_settlement_for_row({"broker_code": ""}, guard, "S010", {}, broker_index, {},
                                         site_index=site_index)
    assert result["settlement_unit"] == "external"
    assert result["source"] == "external"
    assert result["confidence"] == "high"


def test_r0_external_takes_priority_even_with_payroll_match():
    """就算個名撞咗某行糧明細（極端情況），is_external=True 都要優先跌
    去 external，唔應該畀客戶自己嘅人被誤判做真安員。"""
    site_index = SiteIndex([{"site_id": "S1", "canonical_name": "測試盤", "client_name": "",
                              "client_group": "", "billing_model": "per_shift", "aliases": []}])
    broker_index = _broker_index()
    payroll_rows = [
        {"source_file": "p.pdf", "page": "1", "settlement_unit": "T", "row_no": "1",
         "site_label": "測試盤", "guard_name": "撞名工", "time_slot": "", "shift_kind": "normal",
         "shifts": "10", "wage": "700", "broker_fee": "", "bank_note": ""},
    ]
    payroll_by_name_site, _ = build_payroll_index(payroll_rows, site_index, {})
    guard = {"name_zh": "撞名工", "name_variants": "", "is_external": True, "staff_no": ""}
    result = resolve_settlement_for_row({"broker_code": ""}, guard, "S1", payroll_by_name_site,
                                         broker_index, {}, site_index=site_index)
    assert result["settlement_unit"] == "external"
    assert result["source"] == "external"


# ---------------------------------------------------------------------------
# End-to-end：如果真實 WP1/WP2a 輸出存在，跑成個 run_wp2b 做煙霧測試 +
# 守恆檢查斷言（PDPO 資料唔入 git，喺冇呢個目錄嘅環境自動 skip）。
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not paths.ROWS_CSV.exists() or not paths.PAYROLL_ROWS_CSV.exists(),
                     reason="需要真實 out/wp1/ 同 data/2026-07/transcribed/（PDPO，唔入 git）")
def test_end_to_end_run_wp2b_conservation_and_no_duplicate_identity():
    from importer.wp2b_run import run_wp2b
    summary = run_wp2b()
    assert summary["shift_records"] > 0
    assert summary["guards"] > 0

    # 安員無重複身份：同一電話唔可以出現喺兩個 guard，除非 identity-decisions
    # 有解釋（split 嘅兩邊本身電話就係唔同，唔違反呢條規則）。
    with open(paths.WP2B_GUARDS_CSV, encoding="utf-8") as fh:
        guard_rows = list(csv.DictReader(fh))
    tel_to_guards = {}
    for g in guard_rows:
        tel = g["tel"].strip()
        if tel:
            tel_to_guards.setdefault(tel, set()).add(g["guard_id"])
    dup_tels = {tel: gids for tel, gids in tel_to_guards.items() if len(gids) > 1}
    assert dup_tels == {}, f"同一電話出現喺多過一個 guard，未經 identity-decisions 解釋：{dup_tels}"

    # 每條 shift_record 都可以追溯到原始格
    with open(paths.WP2B_SHIFT_RECORDS_CSV, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            assert row["provenance_file"]
            assert row["provenance_cell"]

    # 三次重跑 byte-identical（用 shift_records.csv 做代表）
    with open(paths.WP2B_SHIFT_RECORDS_CSV, "rb") as fh:
        first = fh.read()
    run_wp2b()
    with open(paths.WP2B_SHIFT_RECORDS_CSV, "rb") as fh:
        second = fh.read()
    assert first == second


@pytest.mark.skipif(not paths.ROWS_CSV.exists() or not paths.PAYROLL_ROWS_CSV.exists(),
                     reason="需要真實 out/wp1/ 同 data/2026-07/transcribed/（PDPO，唔入 git）")
def test_c2_c3_c4_regression_against_real_data():
    """C2／C3／C4 放行條件嘅整合回歸：用真實數據跑一次 run_wp2b()，鎖定
    2026-09-04 修完之後嘅已知結果，防止之後改壞。"""
    from importer.wp2b_run import run_wp2b
    run_wp2b()

    with open(paths.WP2B_SHIFT_RECORDS_CSV, encoding="utf-8") as fh:
        shift_rows = [r for r in csv.DictReader(fh) if r["record_type"] == "shift"]

    # C4：客戶自己嘅人（Wilson Guard/Supervisor）settlement_unit=external，
    # 唔可以再跌落 unknown；真 unknown 應該係個位數（唔靠估，淨係斷言合理
    # 上限，具體數字由 out/wp2b/wp2b-report.md 逐次覆核）。
    su_counts = Counter(r["settlement_unit"] for r in shift_rows)
    assert su_counts.get("external", 0) > 0
    assert su_counts.get("unknown", 0) < 10

    # C3：site-overrides.csv／name-near-match.csv 要存在並且有内容（兄弟盤
    # override 同近似名清單唔可以淨係得個空表）。
    with open(paths.WP2B_SITE_OVERRIDES_CSV, encoding="utf-8") as fh:
        overrides = list(csv.DictReader(fh))
    with open(paths.WP2B_NAME_NEAR_MATCH_CSV, encoding="utf-8") as fh:
        near_matches = list(csv.DictReader(fh))
    # 2026-09-10 裁定（HKU 上村 override 反轉）：呢個數據集入面 C3(a) 兄弟盤
    # exact-identity override 嘅唯一觸發案例本來就係 HKU 上村（兩位安員，PDPO唔寫真名）
    # ——而家證實咗嗰個 label 其實係 S007 自己嘅崗位（sites.csv 已改佢做
    # S007 嘅 alias），唔再係跨site override，所以 site-overrides.csv 依家
    # 應該係空。near-match（C3b，edit distance=1）唔受呢個裁定影響，繼續
    # 要有內容。
    assert len(overrides) == 0
    assert len(near_matches) > 0
    assert all(o["client_group"] for o in overrides)

    # C2：TKO Gateway 厚B 一行兩人（厚B安員丙/厚B安員丁）唔可以再互相張冠李戴——
    # 逐個 guard 生成嘅 payroll_only shift_records 數應該貼近佢自己嘅
    # shifts 數（唔會兩個人各自攞晒成組 cells）。
    with open(paths.WP2B_PAYROLL_ONLY_ROWS_CSV, encoding="utf-8") as fh:
        po_rows = [r for r in csv.DictReader(fh) if r["site_label"] == "TKO Gateway 厚B"]
    by_guard = {r["guard_name"]: r for r in po_rows if r["guard_name"]}
    if "厚B安員丁" in by_guard and "厚B安員丙" in by_guard:
        assert int(by_guard["厚B安員丁"]["generated_records"]) <= 2
        assert int(by_guard["厚B安員丙"]["generated_records"]) >= 10

    # OT 落地：6 條 OT record 全部要有 shift_type_id／ot_hours／parent_shift_id。
    with open(paths.WP2B_SHIFT_RECORDS_CSV, encoding="utf-8") as fh:
        ot_rows = [r for r in csv.DictReader(fh) if r["record_type"] == "ot"]
    assert len(ot_rows) == 6
    for r in ot_rows:
        assert r["shift_type_id"]
        assert r["ot_hours"]
        assert r["parent_shift_id"]

    # day-mismatch 全部要有 category（一併做項目 3），冇留空。
    with open(paths.WP2B_DAY_MISMATCH_CSV, encoding="utf-8") as fh:
        dm_rows = list(csv.DictReader(fh))
    assert dm_rows
    assert all(r["category"] for r in dm_rows)
