"""① extract: 20×xlsx -> out/wp1/{records.jsonl, rows.csv, hidden-sheets.csv,
unparsed.csv, sheet-stats.csv, summary.csv}.

Rules implemented here trace to P0-執行計劃.md §3 (數據事實同轉換規則) and the
WP1 briefing. Read that file's §3 and §6 before changing this module.
"""
import csv
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import openpyxl
from openpyxl.utils import get_column_letter

from . import paths
from .excel_dates import to_number
from .layout import LAYOUT_OFFSETS, ColumnMapping, build_mapping, find_date_headers
from .mappings_io import DEFAULT_BILLING_GROUP, load_cell_codes, load_rank_billing, load_stat_row_labels

VISIBLE_SHEET_NAME = "2026"
EXPECTED_YEAR_MONTH = (2026, 7)

# HKU Y更 name suffixes: "測試員甲(上)", "測試員甲(摩)", "測試員乙 (上)" (space before paren
# is inconsistent in the source, so we tolerate 0-1 spaces).
NAME_SUFFIX_RE = re.compile(r"^(?P<base>.+?)\s*\((?P<tag>上|摩)\)\s*$")
LOCATION_TAG_MAP = {"上": "上村", "摩": "摩星嶺"}

EXTERNAL_MARKERS = ("Wilson Guard", "Wilson Supervisor")

# Used to read a Total/所需人手/尚欠 row's own time_slot / work-code, without
# hardcoding any file name. See _stat_row_context() for how these are used —
# most files keep the same column alignment as their guard rows ("aligned"
# shape); 啟航1331 shifts the text two columns over on its Total row only
# ("shifted" shape). Both shapes are detected generically from the text
# itself (a HH*-HH** time range vs a "N Hours" duration vs a bare code).
TIME_RANGE_RE = re.compile(r"^\d{3,4}-\d{3,4}$")
HOURS_RE = re.compile(r"^\d+(\.\d+)?\s*Hours?$", re.IGNORECASE)


def _clean(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s if s != "" else None


def _is_row_blank(ws, row: int, mapping: ColumnMapping) -> bool:
    cols_to_check = set()
    for off in LAYOUT_OFFSETS[mapping.layout].values():
        cols_to_check.add(mapping.label_col + off)
    cols_to_check.add(mapping.label_col)
    for c in range(mapping.date_start_col, mapping.date_end_col + 1):
        cols_to_check.add(c)
    for c, _label in mapping.trailing_cols:
        cols_to_check.add(c)
    for c in cols_to_check:
        if _clean(ws.cell(row=row, column=c).value) is not None:
            return False
    return True


_IDENTITY_FIELDS = ("broker_code", "time_slot", "rank", "staff_no", "tel",
                     "name_en", "sub_site")


def _has_identity_signal(ws, row: int, mapping: ColumnMapping) -> bool:
    for name in _IDENTITY_FIELDS:
        col = mapping.field_col(name)
        if col is not None and col >= 1 and _clean(ws.cell(row=row, column=col).value) is not None:
            return True
    return False


def _field(ws, row: int, mapping: ColumnMapping, name: str) -> Optional[str]:
    col = mapping.field_col(name)
    if col is None or col < 1:
        return None
    return _clean(ws.cell(row=row, column=col).value)


def _stat_row_context(ws, row: int, mapping: ColumnMapping) -> Tuple[Optional[str], Optional[str]]:
    """Read a Total/所需人手/尚欠 row's own time_slot and work-code straight
    off its cells — no block-position guessing, no hardcoded file names.

    Two shapes exist in the wild (verified against every 2026-07 roster):
    - "aligned" (17 of the 20 files, incl. all standard/digital_port/citybus
      layouts other than 啟航1331): the row keeps the SAME column alignment
      as its own guard rows — time_slot sits at field_col('time_slot') and
      the code sits at field_col('staff_no') (reusing that guard-row column
      slot, since a stats row has no real staff number).
    - "shifted" (啟航1331 only): the Total row's text is shifted two columns
      right — its own field_col('time_slot') is blank, and what would be
      field_col('staff_no') holds the time range instead; the clean code
      only shows up one row later, on 所需人手/尚欠, at field_col('tel').

    Which shape a given row is uses is detected from the text itself (does
    it look like "0700-1500", or "12 Hours", or neither), never from the
    file name — so this keeps working if a 21st roster shows up with either
    shape.
    """
    t = _field(ws, row, mapping, "time_slot")
    s = _field(ws, row, mapping, "staff_no")
    te = _field(ws, row, mapping, "tel")

    if t and TIME_RANGE_RE.match(t):
        time_slot = t
        code = s if (s and not TIME_RANGE_RE.match(s) and not HOURS_RE.match(s)) else None
        return time_slot, code

    if s and TIME_RANGE_RE.match(s):
        # Shifted shape's Total row: time_slot lives here; `te` at this point
        # only holds a fuller descriptive label (e.g. "Zone IC"), not the
        # clean code, so we deliberately leave code unset — it gets patched
        # in from the very next 所需人手 row instead (see caller).
        return s, None

    # Neither aligned nor shifted-with-time on THIS row: typical of a
    # shifted-shape 所需人手/尚欠 row, where the clean code sits at `te`.
    code = None
    if te and not TIME_RANGE_RE.match(te) and not HOURS_RE.match(te):
        code = te
    elif s and not TIME_RANGE_RE.match(s) and not HOURS_RE.match(s):
        code = s
    return None, code


def _split_name(name_raw: str) -> Tuple[str, Optional[str]]:
    m = NAME_SUFFIX_RE.match(name_raw)
    if m:
        return m.group("base").strip(), LOCATION_TAG_MAP[m.group("tag")]
    return name_raw, None


def _get_site_raw(ws) -> Optional[str]:
    for coord in ("A2", "B2"):
        v = _clean(ws[coord].value)
        if v:
            return v
    return None


def extract_workbook(xlsx_path: Path, ctx_records, ctx_rows, ctx_unparsed,
                      ctx_sheet_stats, ctx_hidden_sheets, ctx_review_rows,
                      cell_codes, stat_labels):
    file_name = xlsx_path.name
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        if sheet_name != VISIBLE_SHEET_NAME:
            ctx_hidden_sheets.append({
                "file": file_name,
                "sheet": sheet_name,
                "sheet_state": ws.sheet_state,
                "max_row": ws.max_row,
                "max_col": ws.max_column,
                "A2": repr(ws["A2"].value),
                "B2": repr(ws["B2"].value),
            })
            continue

        _extract_visible_sheet(
            ws, file_name, sheet_name, ctx_records, ctx_rows, ctx_unparsed,
            ctx_sheet_stats, ctx_review_rows, cell_codes, stat_labels,
        )


def _extract_visible_sheet(ws, file_name, sheet_name, records, rows_out,
                            unparsed, sheet_stats, review_rows, cell_codes,
                            stat_labels):
    site_raw = _get_site_raw(ws)
    headers = find_date_headers(ws)
    if not headers:
        unparsed.append({
            "file": file_name, "sheet": sheet_name, "row": None, "col": None,
            "cell_ref": None, "block_id": None, "code_raw": None,
            "reason": "sheet 完全搵唔到 Date 表頭，冇任何資料被讀取",
            "context": json.dumps({}, ensure_ascii=False, sort_keys=True),
        })
        return

    block_counter = 0
    current_block_id = f"{file_name}::{sheet_name}::B{block_counter}"
    stat_roles_seen = set()

    # State for tagging each Total/所需人手/尚欠 row with the time_slot/code
    # it actually validates (§ WP1 修正 2). A fresh 'total' row resets both;
    # 'required' fills in `current_code` when the Total row's own shape
    # didn't already carry it (啟航1331's "shifted" rows), and that fix gets
    # patched back onto the Total row's already-emitted sheet_stats entries.
    current_time_slot = None
    current_code = None
    pending_total_entries: List[dict] = []
    # Fallback context (time_slot, rank, sub_site) carried over from the most
    # recent guard row emitted in the CURRENT block, for Total rows whose own
    # cells are blank (e.g. 城巴車廠 柴灣 0700-1900 日更 Total row has nothing
    # in its first 6 columns). Data-driven — not specific to any one file:
    # any block's Total row can fall back to it, and it resets at every block
    # boundary so it never leaks context from an unrelated earlier group.
    last_guard_context = None

    for i, (date_row, label_col) in enumerate(headers):
        mapping = build_mapping(ws, date_row, label_col)
        start_row = mapping.header_row + 1
        end_row = headers[i + 1][0] - 1 if i + 1 < len(headers) else ws.max_row

        r = start_row
        while r <= end_row:
            if _is_row_blank(ws, r, mapping):
                r += 1
                continue

            label_val = _clean(ws.cell(row=r, column=mapping.label_col).value)

            if label_val in stat_labels:
                role = stat_labels[label_val]
                if role != "combined_total" and role == "total" and "total" in stat_roles_seen:
                    # A second 'Total' row shows up without a closing 尚欠 in
                    # between (known 啟航1331 shape: several rank-groups'
                    # worth of guard rows get validated by back-to-back
                    # Total/所需人手/尚欠 triples with no guard rows of their
                    # own in between) -> the previous triple is already
                    # finished, start a fresh block for this one so it does
                    # not get glued onto the first.
                    block_counter += 1
                    current_block_id = f"{file_name}::{sheet_name}::B{block_counter}"
                    stat_roles_seen = set()
                    last_guard_context = None

                sub_site = _field(ws, r, mapping, "sub_site")
                if role in ("total", "required", "shortfall"):
                    row_time_slot, row_code = _stat_row_context(ws, r, mapping)
                else:
                    row_time_slot, row_code = None, None

                if role == "total":
                    if row_time_slot is None and last_guard_context is not None:
                        row_time_slot = last_guard_context[0]
                    if sub_site is None and last_guard_context is not None:
                        sub_site = last_guard_context[2]
                    current_time_slot = row_time_slot
                    current_code = row_code
                elif role in ("required", "shortfall") and row_code:
                    current_code = row_code

                emit_time_slot = current_time_slot if role in ("total", "required", "shortfall") else None
                emit_code = current_code if role in ("total", "required", "shortfall") else None

                before_len = len(sheet_stats)
                _emit_stat_row(
                    ws, r, mapping, file_name, sheet_name, current_block_id,
                    label_val, role, sheet_stats,
                    time_slot=emit_time_slot, code=emit_code, sub_site=sub_site,
                )
                new_entries = sheet_stats[before_len:]

                if role == "total":
                    pending_total_entries = new_entries
                elif role == "required":
                    if current_code and pending_total_entries:
                        for entry in pending_total_entries:
                            entry["code"] = current_code
                    pending_total_entries = []

                if role != "combined_total":
                    stat_roles_seen.add(role)
                    if role == "shortfall":
                        block_counter += 1
                        current_block_id = f"{file_name}::{sheet_name}::B{block_counter}"
                        stat_roles_seen = set()
                        last_guard_context = None
                r += 1
                continue

            if _has_identity_signal(ws, r, mapping):
                guard_ctx = _emit_guard_row(
                    ws, r, mapping, file_name, sheet_name, current_block_id,
                    site_raw, cell_codes, records, rows_out, unparsed,
                )
                if guard_ctx is not None:
                    last_guard_context = guard_ctx
            else:
                # No broker/time/rank/staff_no/tel/name_en/sub_site at all:
                # this is an unlabeled derived-stats row (e.g. the second,
                # label-less line under 數碼港 sheets' "早加夜" combined row),
                # not an 安員 row. Record it as a stats row instead of
                # inventing a fake guard named after whatever number sits in
                # the label column — and ALSO log it for human review rather
                # than silently reclassifying it (WP1 修正 guardrail).
                _emit_stat_row(
                    ws, r, mapping, file_name, sheet_name, current_block_id,
                    label_val or "(冇標籤)", "other", sheet_stats,
                )
                review_rows.append({
                    "file": file_name, "sheet": sheet_name, "row": r,
                    "block_id": current_block_id,
                    "label_col_value": label_val,
                    "reason": (
                        "呢行有值但 broker/time/rank/staff_no/tel/name_en/"
                        "sub_site 全部空白，當統計行（role=other）處理，"
                        "唔當安員行。人手覆核係咪啱。"
                    ),
                })
            r += 1


def _emit_stat_row(ws, row, mapping: ColumnMapping, file_name, sheet_name,
                    block_id, label, role, sheet_stats, time_slot=None,
                    code=None, sub_site=None):
    for col in range(mapping.date_start_col, mapping.date_end_col + 1):
        raw = ws.cell(row=row, column=col).value
        if raw is None:
            continue
        day = mapping.date_values[col].day
        sheet_stats.append({
            "file": file_name, "sheet": sheet_name, "block_id": block_id,
            "stat_label": label, "role": role, "row": row,
            "col": get_column_letter(col), "cell_ref": f"{get_column_letter(col)}{row}",
            "day": day, "trailing_label": None,
            "raw_value": repr(raw), "value": to_number(raw),
            "time_slot": time_slot, "code": code, "sub_site": sub_site,
        })
    for col, trailing_label in mapping.trailing_cols:
        raw = ws.cell(row=row, column=col).value
        if raw is None:
            continue
        sheet_stats.append({
            "file": file_name, "sheet": sheet_name, "block_id": block_id,
            "stat_label": label, "role": role, "row": row,
            "col": get_column_letter(col), "cell_ref": f"{get_column_letter(col)}{row}",
            "day": None, "trailing_label": trailing_label,
            "raw_value": repr(raw), "value": to_number(raw),
            "time_slot": time_slot, "code": code, "sub_site": sub_site,
        })


def _emit_guard_row(ws, row, mapping: ColumnMapping, file_name, sheet_name,
                     block_id, site_raw, cell_codes, records, rows_out, unparsed):
    broker_code = _field(ws, row, mapping, "broker_code")
    time_slot = _field(ws, row, mapping, "time_slot")
    rank = _field(ws, row, mapping, "rank")
    staff_no = _field(ws, row, mapping, "staff_no")
    tel = _field(ws, row, mapping, "tel")
    name_en = _field(ws, row, mapping, "name_en")
    sub_site = _field(ws, row, mapping, "sub_site")
    name_raw = _clean(ws.cell(row=row, column=mapping.label_col).value)

    if name_raw is None:
        # We already filtered fully-blank rows; reaching here with no name
        # but *some* signal elsewhere is unexpected -> flag every non-blank
        # date cell instead of silently dropping the row.
        any_flagged = False
        for col in range(mapping.date_start_col, mapping.date_end_col + 1):
            raw = ws.cell(row=row, column=col).value
            if raw is None or _clean(raw) is None:
                continue
            any_flagged = True
            unparsed.append({
                "file": file_name, "sheet": sheet_name, "row": row,
                "col": get_column_letter(col),
                "cell_ref": f"{get_column_letter(col)}{row}",
                "block_id": block_id, "code_raw": _clean(raw),
                "reason": "安員行冇姓名（Name 欄空白）但呢格有值，懷疑 block 邊界判斷錯咗",
                "context": json.dumps({
                    "broker_code": broker_code, "time_slot": time_slot,
                    "rank": rank, "staff_no": staff_no,
                }, ensure_ascii=False, sort_keys=True),
            })
        if not any_flagged:
            unparsed.append({
                "file": file_name, "sheet": sheet_name, "row": row, "col": None,
                "cell_ref": None, "block_id": block_id, "code_raw": None,
                "reason": "安員行冇姓名，亦冇任何日期格有值（唔應該發生，行入面得返 time/rank 等零碎欄）",
                "context": json.dumps({
                    "broker_code": broker_code, "time_slot": time_slot,
                    "rank": rank, "staff_no": staff_no, "tel": tel,
                }, ensure_ascii=False, sort_keys=True),
            })
        return None

    name, location_tag = _split_name(name_raw)
    external = bool(name_en and any(m in name_en for m in EXTERNAL_MARKERS))

    row_month_total = None
    row_extra: Dict[str, Optional[float]] = {}
    if mapping.trailing_cols:
        first_col, _first_label = mapping.trailing_cols[0]
        row_month_total = to_number(ws.cell(row=row, column=first_col).value)
        for col, label in mapping.trailing_cols[1:]:
            row_extra[label] = to_number(ws.cell(row=row, column=col).value)

    counts = defaultdict(int)
    for col in range(mapping.date_start_col, mapping.date_end_col + 1):
        raw = ws.cell(row=row, column=col).value
        code_raw = _clean(raw)
        if code_raw is None:
            continue

        date_obj = mapping.date_values[col]
        day = date_obj.day
        work_date = date_obj.isoformat()
        kind = cell_codes.get(code_raw, "unknown")

        if (date_obj.year, date_obj.month) != EXPECTED_YEAR_MONTH:
            unparsed.append({
                "file": file_name, "sheet": sheet_name, "row": row,
                "col": get_column_letter(col),
                "cell_ref": f"{get_column_letter(col)}{row}",
                "block_id": block_id, "code_raw": code_raw,
                "reason": (
                    f"格仔日期 {work_date} 唔係 2026-07，需要人手覆核（可能表頭"
                    "日期行本身有問題，或者呢個月有跨月更次）"
                ),
                "context": json.dumps({
                    "name": name, "staff_no": staff_no,
                    "rank": rank, "time_slot": time_slot, "broker_code": broker_code,
                }, ensure_ascii=False, sort_keys=True),
            })

        is_numeric_looking = code_raw.replace(".", "", 1).replace("-", "", 1).isdigit()
        if kind == "unknown":
            unparsed.append({
                "file": file_name, "sheet": sheet_name, "row": row,
                "col": get_column_letter(col),
                "cell_ref": f"{get_column_letter(col)}{row}",
                "block_id": block_id, "code_raw": code_raw,
                "reason": (
                    "安員行出現純數字，懷疑 block 邊界判斷錯咗（呢格可能其實係統計行）"
                    if is_numeric_looking else
                    "格仔代號未喺 mappings/cell_codes.csv 對照表出現"
                ),
                "context": json.dumps({
                    "name": name, "staff_no": staff_no, "day": day,
                    "rank": rank, "time_slot": time_slot, "broker_code": broker_code,
                }, ensure_ascii=False, sort_keys=True),
            })

        counts[kind] += 1
        records.append({
            "file": file_name, "sheet": sheet_name, "row": row,
            "col": get_column_letter(col), "cell_ref": f"{get_column_letter(col)}{row}",
            "block_id": block_id, "layout": mapping.layout,
            "site_raw": site_raw, "sub_site": sub_site,
            "broker_code": broker_code, "time_slot": time_slot, "rank": rank,
            "staff_no": staff_no, "tel": tel,
            "name": name, "name_raw": name_raw, "name_en": name_en,
            "location_tag": location_tag, "external": external,
            "day": day, "work_date": work_date,
            "code_raw": code_raw, "kind": kind,
        })

    rows_out.append({
        "file": file_name, "sheet": sheet_name, "row": row, "block_id": block_id,
        "layout": mapping.layout, "site_raw": site_raw, "sub_site": sub_site,
        "broker_code": broker_code, "time_slot": time_slot, "rank": rank,
        "staff_no": staff_no, "tel": tel, "name_raw": name_raw, "name": name,
        "name_en": name_en, "location_tag": location_tag, "external": external,
        "work_count": counts.get("work", 0), "ot_count": counts.get("ot", 0),
        "leave_count": counts.get("leave", 0), "pointer_count": counts.get("pointer", 0),
        "unknown_count": counts.get("unknown", 0),
        "sheet_row_total": row_month_total,
        "sheet_row_extra_json": json.dumps(row_extra, ensure_ascii=False, sort_keys=True),
    })

    return time_slot, rank, sub_site


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------

def _write_csv(path: Path, rows: List[dict], fieldnames: List[str]):
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _write_jsonl(path: Path, rows: List[dict]):
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def run_extract() -> dict:
    paths.ensure_out_dir()
    cell_codes = load_cell_codes()
    stat_labels = load_stat_row_labels()
    rank_billing = load_rank_billing()

    records: List[dict] = []
    rows: List[dict] = []
    unparsed: List[dict] = []
    sheet_stats: List[dict] = []
    hidden_sheets: List[dict] = []
    review_rows: List[dict] = []

    xlsx_files = sorted(paths.DATA_DIR.glob("*.xlsx"))
    for xlsx_path in xlsx_files:
        extract_workbook(
            xlsx_path, records, rows, unparsed, sheet_stats, hidden_sheets,
            review_rows, cell_codes, stat_labels,
        )

    _write_jsonl(paths.RECORDS_JSONL, records)

    rows_fields = [
        "file", "sheet", "row", "block_id", "layout", "site_raw", "sub_site",
        "broker_code", "time_slot", "rank", "staff_no", "tel", "name_raw",
        "name", "name_en", "location_tag", "external", "work_count",
        "ot_count", "leave_count", "pointer_count", "unknown_count",
        "sheet_row_total", "sheet_row_extra_json",
    ]
    _write_csv(paths.ROWS_CSV, rows, rows_fields)

    unparsed_fields = ["file", "sheet", "row", "col", "cell_ref", "block_id",
                        "code_raw", "reason", "context"]
    _write_csv(paths.UNPARSED_CSV, unparsed, unparsed_fields)

    stats_fields = ["file", "sheet", "block_id", "stat_label", "role", "row",
                     "col", "cell_ref", "day", "trailing_label", "raw_value",
                     "value", "time_slot", "code", "sub_site"]
    _write_csv(paths.SHEET_STATS_CSV, sheet_stats, stats_fields)

    hidden_fields = ["file", "sheet", "sheet_state", "max_row", "max_col", "A2", "B2"]
    _write_csv(paths.HIDDEN_SHEETS_CSV, hidden_sheets, hidden_fields)

    review_fields = ["file", "sheet", "row", "block_id", "label_col_value", "reason"]
    _write_csv(paths.REVIEW_ROWS_CSV, review_rows, review_fields)

    _write_summary(records, rank_billing)

    return {
        "files": len(xlsx_files),
        "records": len(records),
        "rows": len(rows),
        "unparsed": len(unparsed),
        "hidden_sheets": len(hidden_sheets),
        "review_rows": len(review_rows),
    }


def _write_summary(records: List[dict], rank_billing: Dict[str, str]):
    per_file: Dict[Tuple[str, str], dict] = {}

    def bucket(file, sheet):
        key = (file, sheet)
        if key not in per_file:
            per_file[key] = {
                "file": file, "sheet": sheet, "site_raw": None,
                "work_internal": 0, "external": 0, "pointer": 0, "ot": 0,
                "leave": 0, "unknown": 0,
                "broker_breakdown": defaultdict(int),
                "code_breakdown": defaultdict(int),
                "rank_breakdown": defaultdict(int),
                "sub_site_breakdown": defaultdict(int),
                "billing_breakdown": defaultdict(int),
            }
        return per_file[key]

    for rec in records:
        b = bucket(rec["file"], rec["sheet"])
        b["site_raw"] = rec["site_raw"]
        kind = rec["kind"]
        if kind == "work" and not rec["external"]:
            b["work_internal"] += 1
            b["broker_breakdown"][rec["broker_code"] or "(blank)"] += 1
            b["code_breakdown"][rec["code_raw"]] += 1
            b["rank_breakdown"][rec["rank"] or "(blank)"] += 1
            if rec["sub_site"]:
                b["sub_site_breakdown"][rec["sub_site"]] += 1
            billing_group = rank_billing.get(rec["rank"] or "", DEFAULT_BILLING_GROUP)
            b["billing_breakdown"][billing_group] += 1
        elif kind == "work" and rec["external"]:
            b["external"] += 1
        elif kind == "pointer":
            b["pointer"] += 1
        elif kind == "ot":
            b["ot"] += 1
        elif kind == "leave":
            b["leave"] += 1
        elif kind == "unknown":
            b["unknown"] += 1

    fieldnames = ["file", "sheet", "site_raw", "work_internal", "external",
                  "pointer", "ot", "leave", "unknown",
                  "work_per_shift", "work_monthly_ic",
                  "broker_breakdown", "code_breakdown", "rank_breakdown",
                  "sub_site_breakdown", "billing_breakdown"]
    out_rows = []
    for (_file, _sheet), b in sorted(per_file.items()):
        out_rows.append({
            "file": b["file"], "sheet": b["sheet"], "site_raw": b["site_raw"],
            "work_internal": b["work_internal"], "external": b["external"],
            "pointer": b["pointer"], "ot": b["ot"], "leave": b["leave"],
            "unknown": b["unknown"],
            "work_per_shift": b["billing_breakdown"].get("per_shift", 0),
            "work_monthly_ic": b["billing_breakdown"].get("monthly_ic", 0),
            "broker_breakdown": json.dumps(dict(b["broker_breakdown"]), ensure_ascii=False, sort_keys=True),
            "code_breakdown": json.dumps(dict(b["code_breakdown"]), ensure_ascii=False, sort_keys=True),
            "rank_breakdown": json.dumps(dict(b["rank_breakdown"]), ensure_ascii=False, sort_keys=True),
            "sub_site_breakdown": json.dumps(dict(b["sub_site_breakdown"]), ensure_ascii=False, sort_keys=True),
            "billing_breakdown": json.dumps(dict(b["billing_breakdown"]), ensure_ascii=False, sort_keys=True),
        })
    _write_csv(paths.SUMMARY_CSV, out_rows, fieldnames)
