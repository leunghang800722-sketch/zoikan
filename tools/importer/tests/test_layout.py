"""表頭定位測試：三種欄位排法各一個 test，唔可以靠寫死欄號。"""
from importer.layout import build_mapping, find_date_headers

from .helpers import new_sheet, write_row


def test_standard_layout_detected_by_header():
    """標準 17 檔排法：A雞頭|B時段|C更別|D StaffNo|E電話|F姓名|G起=日期。"""
    wb, ws = new_sheet()
    ws["A2"] = "皓日"
    write_row(ws, 3, {6: "Date", 7: "2026-07-01"})
    ws.cell(row=3, column=7, value=__import__("datetime").datetime(2026, 7, 1))
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel", 6: "Name",
                       7: "Wed"})
    write_row(ws, 5, {1: "W", 2: "0700-1900", 3: "早更保安員", 4: "U99999",
                       5: "9999 9999", 6: "測試員甲", 7: "D"})

    headers = find_date_headers(ws)
    assert headers == [(3, 6)]
    mapping = build_mapping(ws, 3, 6)
    assert mapping.layout == "standard"
    assert mapping.date_start_col == 7
    assert mapping.field_col("broker_code") == 1
    assert mapping.field_col("time_slot") == 2
    assert mapping.field_col("rank") == 3
    assert mapping.field_col("staff_no") == 4
    assert mapping.field_col("tel") == 5
    assert mapping.label_col == 6  # Name column


def test_digital_port_layout_detected_by_blank_column_before_name():
    """數碼港三檔：多一欄英文名/公司名，F=name_en(冇header)，G=Name(中文)，H起=日期。"""
    wb, ws = new_sheet()
    ws["A2"] = "數碼港 CP1-4"
    import datetime
    write_row(ws, 3, {7: "Date", 8: datetime.datetime(2026, 7, 1)})
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Staff No.", 5: "Tel",
                       7: "Name", 8: "Wed"})  # col 6 (name_en) intentionally blank
    write_row(ws, 5, {6: "Wilson Guard", 7: "測試員乙", 8: "D"})

    headers = find_date_headers(ws)
    assert headers == [(3, 7)]
    mapping = build_mapping(ws, 3, 7)
    assert mapping.layout == "digital_port"
    assert mapping.label_col == 7
    assert mapping.field_col("name_en") == 6
    assert mapping.field_col("tel") == 5
    assert mapping.field_col("staff_no") == 4
    assert mapping.date_start_col == 8


def test_citybus_layout_detected_by_property_name_header():
    """城巴一檔：多一欄 Property Name（邊個車廠），呢欄要保留做 sub_site。"""
    wb, ws = new_sheet()
    ws["B2"] = "城巴車廠"
    import datetime
    write_row(ws, 3, {7: "Date", 8: datetime.datetime(2026, 7, 1)})
    write_row(ws, 4, {2: "Time", 3: "Rank", 4: "Property Name", 5: "Staff No.",
                       6: "Phone No.", 7: "Name", 8: "Wed"})
    write_row(ws, 5, {1: "T", 2: "1900-0700", 3: "夜更保安員", 4: "屯門城巴車廠",
                       5: "U99999", 6: "9999 9999", 7: "測試員丙", 8: "N"})

    headers = find_date_headers(ws)
    assert headers == [(3, 7)]
    mapping = build_mapping(ws, 3, 7)
    assert mapping.layout == "citybus"
    assert mapping.field_col("sub_site") == 4
    assert mapping.field_col("staff_no") == 5
    assert mapping.field_col("tel") == 6
    assert mapping.label_col == 7
