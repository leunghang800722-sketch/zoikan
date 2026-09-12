"""Decode statistic-row cell values that Excel stored as dates/times by mistake.

Evidence (見 P0-執行計劃.md §3.1 / §7 WP1 驗收準則):
啟航1331 sheet 的「高級IC」「Zone IC」等 Total 行，格仔本應係整數（每日已排更數），
但 Excel 將條 SUM 公式嘅結果用日期格式顯示 -> openpyxl(data_only=True) 讀出嚟
變成 python datetime.datetime(1900, 1, 1, 0, 0) 呢類值（= serial 1）。「尚欠」行
被顯示做 time 格式，讀出嚟係 datetime.time(0, 0) 呢類值（= serial 0）。

Excel serial-date epoch (Windows, with the historical 1900-leap-year bug that we
don't need to worry about for the small values seen here, all < 60):
    serial = (date - date(1899, 12, 31)).days
"""
import datetime
from typing import Optional, Union

_EPOCH = datetime.date(1899, 12, 31)

Number = Union[int, float]


def to_number(value) -> Optional[Number]:
    """Best-effort coercion of a stat-row cell value to a plain number.

    Returns None if the cell is empty / not coercible (caller should treat
    that as "no data", not as zero).
    """
    if value is None:
        return None
    if isinstance(value, bool):
        # bool is a subclass of int in Python; stat cells are never booleans
        # in practice, but guard against it explicitly rather than silently
        # treating True/False as 1/0.
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, datetime.datetime):
        days = (value.date() - _EPOCH).days
        frac = (value.hour * 3600 + value.minute * 60 + value.second) / 86400
        return days + frac
    if isinstance(value, datetime.date):
        return (value - _EPOCH).days
    if isinstance(value, datetime.time):
        return (value.hour * 3600 + value.minute * 60 + value.second) / 86400
    if isinstance(value, str):
        s = value.strip()
        if s == "":
            return None
        try:
            return float(s) if "." in s else int(s)
        except ValueError:
            return None
    return None
