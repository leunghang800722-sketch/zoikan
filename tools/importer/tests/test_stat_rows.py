"""統計行識別 + block/day 對數測試。"""
import datetime

from importer.extract import _extract_visible_sheet
from importer.mappings_io import load_cell_codes, load_stat_row_labels

from .helpers import new_sheet, write_row


def _run(ws):
    records, rows, unparsed, sheet_stats, review_rows = [], [], [], [], []
    cell_codes = load_cell_codes()
    stat_labels = load_stat_row_labels()
    _extract_visible_sheet(ws, "test.xlsx", "2026", records, rows, unparsed,
                            sheet_stats, review_rows, cell_codes, stat_labels)
    return records, rows, unparsed, sheet_stats, review_rows


def _build_simple_sheet():
    wb, ws = new_sheet()
    ws["A2"] = "測試盤"
    write_row(ws, 3, {6: "Date"})
    for i in range(3):
        ws.cell(row=3, column=7 + i, value=datetime.datetime(2026, 7, 1 + i))
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name",
                       7: "Wed", 8: "Thu", 9: "Fri"})
    # two guard rows, 3 days each, all 'D'
    write_row(ws, 5, {1: "W", 2: "0700-1900", 3: "早更保安員", 4: "U00001",
                       5: "9111 1111", 6: "安員甲", 7: "D", 8: "D", 9: "D", 10: 3})
    write_row(ws, 6, {1: "W", 2: "0700-1900", 3: "早更保安員", 4: "U00002",
                       5: "9222 2222", 6: "安員乙", 7: "D", 8: None, 9: "D", 10: 2})
    # Total / 所需人手 / 尚欠 triple: day1=2, day2=1, day3=2
    write_row(ws, 8, {6: "Total", 7: 2, 8: 1, 9: 2})
    write_row(ws, 9, {6: "所需人手", 7: 2, 8: 2, 9: 2})
    write_row(ws, 10, {6: "尚欠", 7: 0, 8: 1, 9: 0})
    return ws


def test_stat_rows_not_treated_as_guards():
    ws = _build_simple_sheet()
    records, rows, unparsed, sheet_stats, review_rows = _run(ws)

    # Only the 2 guard rows produced rows.csv entries, not the stat rows.
    assert len(rows) == 2
    assert {r["name"] for r in rows} == {"安員甲", "安員乙"}
    assert unparsed == []


def test_day_total_recomputes_and_matches():
    ws = _build_simple_sheet()
    records, rows, unparsed, sheet_stats, review_rows = _run(ws)

    work_records = [r for r in records if r["kind"] == "work"]
    by_day = {}
    for r in work_records:
        by_day[r["day"]] = by_day.get(r["day"], 0) + 1
    assert by_day == {1: 2, 2: 1, 3: 2}

    total_rows = [s for s in sheet_stats if s["role"] == "total"]
    total_by_day = {s["day"]: s["value"] for s in total_rows}
    assert total_by_day == {1: 2, 2: 1, 3: 2}
    # recomputed matches sheet Total exactly for this clean synthetic sheet
    assert by_day == total_by_day


def test_row_month_total_captured():
    ws = _build_simple_sheet()
    records, rows, unparsed, sheet_stats, review_rows = _run(ws)
    by_name = {r["name"]: r for r in rows}
    assert by_name["安員甲"]["sheet_row_total"] == 3
    assert by_name["安員甲"]["work_count"] == 3
    assert by_name["安員乙"]["sheet_row_total"] == 2
    assert by_name["安員乙"]["work_count"] == 2
