"""(time_slot, code) 逐日對數測試 —— WP1 修正 2/6。

覆蓋兩個真實排版：
- "aligned" 排版（大部分檔，例如 皓日/HKU座頭/HKU Y更/數碼港/城巴）：Total 行同
  自己嘅安員行一樣，time_slot 喺 field_col('time_slot')，代號喺
  field_col('staff_no')（借用嗰個位，因為統計行冇真係 staff no）。
- "shifted" 排版（淨係啟航1331）：Total 行嘅文字向右移咗兩欄，field_col('time_slot')
  反而係空白，時段變咗喺 field_col('staff_no')；代號要等落一行「所需人手」嘅
  field_col('tel') 先讀到，然後 patch 返上 Total 行。

亦覆蓋 HKU座頭 嗰種「同一 (time_slot, code) 喺同一個 sheet 出現兩次、屬於兩組
完全唔同嘅人」嘅情況——純粹靠 (time_slot, code) 做 key 會將兩組人加埋一齊，
一定要按 Total 行出現嘅位置（bisect 揀「下一個」）先分得返兩組。
"""
import datetime

from importer.extract import _extract_visible_sheet, _stat_row_context
from importer.mappings_io import load_cell_codes, load_stat_row_labels
from importer.validate import check_day_total_mismatch

from .helpers import new_sheet, write_row


def _run(ws):
    records, rows, unparsed, sheet_stats, review_rows = [], [], [], [], []
    cell_codes = load_cell_codes()
    stat_labels = load_stat_row_labels()
    _extract_visible_sheet(ws, "test.xlsx", "2026", records, rows, unparsed,
                            sheet_stats, review_rows, cell_codes, stat_labels)
    return records, rows, unparsed, sheet_stats, review_rows


def test_stat_row_context_aligned_shape():
    """皓日/HKU座頭 呢種：Total 行 time_slot 喺阻定位置，code 喺 staff_no 位。"""
    wb, ws = new_sheet()
    write_row(ws, 7, {2: "0700-1900", 3: "早更保安員", 4: "D", 5: "12 Hours", 6: "Total"})
    # Need a mapping: build one via header rows 3/4 like a real sheet.
    import datetime as dt
    write_row(ws, 3, {6: "Date", 7: dt.datetime(2026, 7, 1)})
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name", 7: "Wed"})
    from importer.layout import build_mapping
    mapping = build_mapping(ws, 3, 6)
    time_slot, code = _stat_row_context(ws, 7, mapping)
    assert time_slot == "0700-1900"
    assert code == "D"


def test_stat_row_context_shifted_shape_defers_code():
    """啟航1331 呢種：Total 行自己得返 time_slot，code 要等 所需人手 行先有。"""
    wb, ws = new_sheet()
    import datetime as dt
    write_row(ws, 3, {6: "Date", 7: dt.datetime(2026, 7, 1)})
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name", 7: "Wed"})
    from importer.layout import build_mapping
    mapping = build_mapping(ws, 3, 6)

    # Total row: text shifted 2 columns right of the usual guard-row offsets.
    write_row(ws, 10, {4: "0700-1500", 5: "Zone IC", 6: "Total"})
    ts_total, code_total = _stat_row_context(ws, 10, mapping)
    assert ts_total == "0700-1500"
    assert code_total is None  # 要等落一行先知

    # 所需人手 row: duration text at staff_no slot, clean code at tel slot.
    write_row(ws, 11, {4: "8 Hours", 5: "IC", 6: "所需人手"})
    ts_req, code_req = _stat_row_context(ws, 11, mapping)
    assert ts_req is None  # 呢行自己冇時段，靠上面果行嘅 current_time_slot 延續
    assert code_req == "IC"


def test_same_time_slot_code_recurring_twice_still_reconciles():
    """HKU座頭 嗰種：同一 (time_slot, code) 出現兩次，中間隔住第三組人。
    純粹用 (time_slot, code) 加埋一齊會錯；要用 Total 行位置分返兩組。
    """
    wb, ws = new_sheet()
    write_row(ws, 3, {6: "Date"})
    for i in range(3):
        ws.cell(row=3, column=7 + i, value=datetime.datetime(2026, 7, 1 + i))
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name",
                       7: "Wed", 8: "Thu", 9: "Fri"})

    # Group 1: time_slot=2300-0715, code=C, 1 guard, works all 3 days.
    write_row(ws, 5, {1: "W", 2: "2300-0715", 3: "夜更保安員", 4: "U00001",
                       5: "9111 1111", 6: "甲", 7: "C", 8: "C", 9: "C", 10: 3})
    write_row(ws, 7, {2: "2300-0715", 3: "夜更保安員", 4: "C", 5: "8.25 Hours",
                       6: "Total", 7: 1, 8: 1, 9: 1})
    write_row(ws, 8, {6: "所需人手", 7: 1, 8: 1, 9: 1})
    write_row(ws, 9, {6: "尚欠", 7: 0, 8: 0, 9: 0})

    # Group 2 (different code C1, unrelated group in between).
    write_row(ws, 11, {1: "Y", 2: "2200-0615", 3: "夜更保安員", 4: "U00002",
                        5: "9222 2222", 6: "乙", 7: "C1", 8: "C1", 9: "C1", 10: 3})
    write_row(ws, 13, {2: "2200-0615", 3: "夜更保安員", 4: "C1", 5: "8.25 Hours",
                        6: "Total", 7: 1, 8: 1, 9: 1})
    write_row(ws, 14, {6: "所需人手", 7: 1, 8: 1, 9: 1})
    write_row(ws, 15, {6: "尚欠", 7: 0, 8: 0, 9: 0})

    # Group 3: SAME time_slot + code as group 1 (2300-0715 / C), 2 guards.
    write_row(ws, 17, {1: "W", 2: "2300-0715", 3: "夜更保安員", 4: "U00003",
                        5: "9333 3333", 6: "丙", 7: "C", 8: "C", 9: "C", 10: 3})
    write_row(ws, 18, {1: "W", 2: "2300-0715", 3: "夜更保安員", 4: "U00004",
                        5: "9444 4444", 6: "丁", 7: "C", 8: "C", 9: "C", 10: 3})
    write_row(ws, 20, {2: "2300-0715", 3: "夜更保安員", 4: "C", 5: "8.25 Hours",
                        6: "Total", 7: 2, 8: 2, 9: 2})
    write_row(ws, 21, {6: "所需人手", 7: 2, 8: 2, 9: 2})
    write_row(ws, 22, {6: "尚欠", 7: 0, 8: 0, 9: 0})

    records, rows, unparsed, sheet_stats, review_rows = _run(ws)
    assert unparsed == []

    mismatches = check_day_total_mismatch(records, sheet_stats)
    assert mismatches == [], (
        "同一 (time_slot, code) 出現兩次應該靠 Total 行位置分返兩組，"
        f"唔應該有差異，但見到: {mismatches}"
    )


def test_event_guard_merged_into_different_time_slot_total_shows_up():
    """反過來：如果 sheet 自己都將兩個唔同 time_slot 嘅人埋單計落同一個
    Total（啟航1331 Event Guard 嗰種情況），呢個差異應該老實咁報出嚟，
    唔應該被算法自動「修正」到啱。
    """
    wb, ws = new_sheet()
    write_row(ws, 3, {6: "Date"})
    ws.cell(row=3, column=7, value=datetime.datetime(2026, 7, 3))
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name", 7: "Wed"})

    # D-group proper: time_slot 0730-1930.
    write_row(ws, 5, {1: "K", 2: "0730-1930", 3: "早更保安員", 4: "U00001",
                       5: "9111 1111", 6: "甲", 7: "D", 8: 1})
    # Event Guard: different time_slot 1000-1900, but the sheet's own Total
    # row for 0730-1930/D includes it anyway (matches 啟航1331's real shape).
    write_row(ws, 6, {1: "K", 2: "1000-1900", 3: "Event Guard", 5: "9222 2222",
                       6: "乙", 7: "D", 8: 1})
    write_row(ws, 8, {2: "0730-1930", 3: "早更保安員", 4: "D", 5: "12 Hours",
                       6: "Total", 7: 2})  # sheet says 2 (1 D-group + 1 event guard)
    write_row(ws, 9, {6: "所需人手", 7: 2})
    write_row(ws, 10, {6: "尚欠", 7: 0})

    records, rows, unparsed, sheet_stats, review_rows = _run(ws)
    mismatches = check_day_total_mismatch(records, sheet_stats)
    assert len(mismatches) == 1
    m = mismatches[0]
    assert m["time_slot"] == "0730-1930"
    assert m["code"] == "D"
    assert m["recomputed_work_count"] == 1  # 淨計返 0730-1930 嗰組
    assert m["sheet_total_value"] == 2
    assert m["diff"] == -1
