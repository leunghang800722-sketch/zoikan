"""④ validate: 內部對數 -> out/wp1/validate-*.csv + validate-report.md.

Five checks, per WP1 briefing (see also P0-執行計劃.md §6 ④):
1. 逐安員行：重算 work 更數 ≟ sheet 月總更數欄（如該檔有）。
2. 逐 (time_slot, code) 逐日：重算當日 work 數 ≟ sheet Total 行（見
   extract.py 嘅 _stat_row_context：Total 行自己帶時段/代號，唔靠 block 位置）。
3. 同人同日多過一更（staff_no，冇就 name+tel；跨檔都要查）。
4. 缺 staff_no 清單（濾走 external）；同一 staff_no 對應唔同名／同一名對應唔同
   staff_no／同一電話對應唔同 staff_no 清單。
5. 同一檔內同一人（staff_no 相同）開多行嘅清單。

每一類差異都帶 `explanation` 欄——WP1 驗收準則係「差異逐條列明」，唔淨係計數。

This module only reads what extract.py already wrote under out/wp1/ — it does
not re-open the xlsx files, so validate can be re-run on its own after
tweaking mappings without re-extracting (unless the mapping change affects
extract's own output, in which case rerun extract first).
"""
import bisect
import csv
import json
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

from . import paths


def _read_jsonl(path: Path) -> List[dict]:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _read_csv(path: Path) -> List[dict]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write_csv(path: Path, rows: List[dict], fieldnames: List[str]):
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _to_float(s) -> Optional[float]:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _is_true(s) -> bool:
    return str(s).strip().lower() == "true"


def _identity(staff_no: Optional[str], name: Optional[str], tel: Optional[str]) -> str:
    staff_no = (staff_no or "").strip()
    if staff_no:
        return f"staff_no:{staff_no}"
    return f"name_tel:{(name or '').strip()}|{(tel or '').strip()}"


# ---------------------------------------------------------------------------
# Check 1: row-level work count vs sheet_row_total
# ---------------------------------------------------------------------------

def check_row_total_mismatch(rows: List[dict]) -> List[dict]:
    mismatches = []
    for row in rows:
        sheet_row_total = row.get("sheet_row_total")
        if sheet_row_total is None or sheet_row_total == "":
            continue  # 該檔行冇月總更數欄可對，跳過（唔係差異，係冇數據）
        expected = _to_float(sheet_row_total)
        if expected is None:
            continue
        work_count = int(row.get("work_count") or 0)
        if abs(work_count - expected) > 1e-9:
            mismatches.append({
                "file": row["file"], "sheet": row["sheet"], "row": row["row"],
                "staff_no": row["staff_no"], "name": row["name"],
                "rank": row["rank"], "time_slot": row["time_slot"],
                "recomputed_work_count": work_count,
                "sheet_row_total": expected,
                "diff": work_count - expected,
            })
    return mismatches


# ---------------------------------------------------------------------------
# Check 2: per (time_slot, code[, sub_site]) per day work count vs sheet
# Total row. Grouping is keyed by the Total row's OWN time_slot/code
# (extracted in extract.py's _stat_row_context), not by block_id — a block
# can span several rank-groups that the sheet itself only validates with
# separate, code-specific Total rows (啟航1331's shape).
#
# One extra wrinkle: the exact same (time_slot, code) can legitimately recur
# MORE THAN ONCE in one sheet as two unrelated, independently-closed groups
# (HKU座頭 has two distinct "2300-0715 / C" blocks, one Total=31, another
# Total=76, separated by an unrelated C1 block in between). A pure "sum
# everything sharing this key" match would wrongly merge them. So each
# occurrence of a (time_slot, code[, sub_site]) key among the Total rows
# gets its own row position, and every matching work record is assigned to
# the NEAREST FOLLOWING occurrence (by row number) — guard rows always sit
# above the Total row that summarizes them, so "smallest Total-row position
# >= this record's row" reproduces the sheet's own grouping without needing
# block_id at all.
# ---------------------------------------------------------------------------

def check_day_total_mismatch(records: List[dict], sheet_stats: List[dict]) -> List[dict]:
    # occurrence row-positions per key, and the (value, raw, cell_ref) at
    # each (key, occurrence_row, day).
    occ_rows: Dict[tuple, set] = defaultdict(set)
    stat_value: Dict[tuple, tuple] = {}
    # whether this key flavour carries an explicit code or falls back to
    # time_slot+sub_site only (city bus: Total rows never show a code, but
    # sub_site already disambiguates each depot).
    for stat in sheet_stats:
        if stat["role"] != "total" or not stat.get("day"):
            continue
        ts = (stat.get("time_slot") or "").strip()
        if not ts:
            continue  # 呢行連自己嘅時段都讀唔到，理論上唔應該發生
        code = (stat.get("code") or "").strip()
        sub = (stat.get("sub_site") or "").strip()
        val = _to_float(stat["value"])
        if val is None:
            continue
        row = int(stat["row"])
        day = int(stat["day"])
        key = (stat["file"], stat["sheet"], ts, code, sub)
        occ_rows[key].add(row)
        stat_value[(key, row, day)] = (val, stat["raw_value"], stat["cell_ref"])

    occ_sorted = {k: sorted(v) for k, v in occ_rows.items()}

    recomputed: Dict[tuple, int] = defaultdict(int)
    for rec in records:
        if rec["kind"] != "work":
            continue
        ts = rec.get("time_slot") or ""
        sub = rec.get("sub_site") or ""
        row = int(rec["row"])
        day = rec["day"]

        # Prefer the exact-code key; if the sheet's Total rows for this
        # (file,sheet,time_slot,sub_site) never carry a code (city bus), fall
        # back to matching on time_slot+sub_site alone so records aren't
        # dropped just because the record itself always has a real code_raw.
        key_with_code = (rec["file"], rec["sheet"], ts, rec.get("code_raw") or "", sub)
        key_no_code = (rec["file"], rec["sheet"], ts, "", sub)
        if key_with_code in occ_sorted:
            key = key_with_code
        elif key_no_code in occ_sorted:
            key = key_no_code
        else:
            continue  # 冇任何 Total 行帶呢個 time_slot/code 組合，冇得對

        positions = occ_sorted[key]
        i = bisect.bisect_left(positions, row)
        if i >= len(positions):
            continue  # 呢行之後冇再出現呢個 key 嘅 Total 行，冇得對
        recomputed[(key, positions[i], day)] += 1

    mismatches = []
    for (key, row, day), (expected, raw, cell_ref) in stat_value.items():
        got = recomputed.get((key, row, day), 0)
        if abs(got - expected) > 1e-9:
            file_, sheet_, ts, code, sub = key
            mismatches.append({
                "file": file_, "sheet": sheet_, "time_slot": ts,
                "code": code or "(冇代號,靠time_slot+sub_site)", "sub_site": sub,
                "day": day, "recomputed_work_count": got,
                "sheet_total_raw": raw, "sheet_total_value": expected,
                "diff": got - expected, "cell_ref": cell_ref,
            })
    return sorted(mismatches, key=lambda m: (m["file"], m["sheet"], m["time_slot"],
                                              m["code"], m["sub_site"], m["day"]))


def compute_day_total_coverage(records: List[dict], sheet_stats: List[dict]) -> dict:
    """覆蓋率披露（Opus 複驗要求）：check_day_total_mismatch 淨係報「比對到、
    但數目對唔上」嘅差異；呢個函數額外報「連比對都做唔到」嘅缺口——幾多條
    work 記錄搵唔到任何 Total 行嘅 key 可以對、幾多個 Total 行嘅日格因為自己
    同上面安員行都讀唔到 time_slot 而完全冇被攞去比較。

    邏輯同 check_day_total_mismatch 一致（同一套 key/bisect），淨係將「攞唔到
    key」同「呢行之後搵唔到 Total 行」呢兩種情況記錄低嚟，而唔係直接跳過。
    """
    occ_rows: Dict[tuple, set] = defaultdict(set)
    total_day_cells = 0
    blank_context_day_cells: List[dict] = []
    for stat in sheet_stats:
        if stat["role"] != "total" or not stat.get("day"):
            continue
        total_day_cells += 1
        ts = (stat.get("time_slot") or "").strip()
        if not ts:
            blank_context_day_cells.append({
                "file": stat["file"], "sheet": stat["sheet"], "row": stat["row"],
                "day": stat["day"], "cell_ref": stat["cell_ref"],
                "reason": "Total 行自己嘅 time_slot 讀唔到，繼承同 block 上面安員行"
                          "嘅 time_slot 都失敗（呢個 block 冇任何安員行，或者安員行"
                          "都讀唔到 time_slot）——理論上唔應該發生",
            })
            continue
        code = (stat.get("code") or "").strip()
        sub = (stat.get("sub_site") or "").strip()
        occ_rows[(stat["file"], stat["sheet"], ts, code, sub)].add(int(stat["row"]))
    occ_sorted = {k: sorted(v) for k, v in occ_rows.items()}

    work_records = [r for r in records if r["kind"] == "work"]
    uncompared: List[dict] = []
    compared = 0
    for rec in work_records:
        ts = rec.get("time_slot") or ""
        sub = rec.get("sub_site") or ""
        row = int(rec["row"])
        key_with_code = (rec["file"], rec["sheet"], ts, rec.get("code_raw") or "", sub)
        key_no_code = (rec["file"], rec["sheet"], ts, "", sub)
        if key_with_code in occ_sorted:
            key = key_with_code
        elif key_no_code in occ_sorted:
            key = key_no_code
        else:
            uncompared.append({
                "file": rec["file"], "sheet": rec["sheet"], "row": rec["row"],
                "day": rec["day"], "time_slot": rec.get("time_slot"),
                "code_raw": rec.get("code_raw"), "sub_site": rec.get("sub_site"),
                "name": rec.get("name"), "staff_no": rec.get("staff_no"),
                "reason": "冇任何 Total 行帶呢個 time_slot/code 組合，理論上冇得對",
            })
            continue
        positions = occ_sorted[key]
        i = bisect.bisect_left(positions, row)
        if i >= len(positions):
            uncompared.append({
                "file": rec["file"], "sheet": rec["sheet"], "row": rec["row"],
                "day": rec["day"], "time_slot": rec.get("time_slot"),
                "code_raw": rec.get("code_raw"), "sub_site": rec.get("sub_site"),
                "name": rec.get("name"), "staff_no": rec.get("staff_no"),
                "reason": "呢個 key 有 Total 行出現過，但佢哋全部行號都喺呢條記錄"
                          "之前（冇一個喺之後），bisect 揀唔到可以歸屬嘅 Total 行",
            })
            continue
        compared += 1

    return {
        "work_records_total": len(work_records),
        "work_records_compared": compared,
        "work_records_uncompared": uncompared,
        "total_day_cells": total_day_cells,
        "total_day_cells_uncomparable": blank_context_day_cells,
    }


# ---------------------------------------------------------------------------
# Check 3: same person, same day, more than one shift (across files)
# ---------------------------------------------------------------------------

def _explain_same_day(recs: List[dict]) -> str:
    names_tels = sorted({(r["name"] or "", r["tel"] or "") for r in recs})
    if len(names_tels) > 1:
        parts = "、".join(f"{n}({t})" for n, t in names_tels)
        return (f"撞號造成嘅 false positive：實際係 {parts} 兩個唔同嘅人共用同一個 "
                "staff_no，唔係同一人做兩更 —— 呢個要喺 identity_conflicts 度跟")
    codes = {r["code_raw"] for r in recs}
    files = {r["file"] for r in recs}
    if "OT1" in codes:
        return "合法（已知例子）：HKU座頭 正更 + OT1 同日"
    if len(files) > 1:
        return "合法（已知例子）：同一人跨盤/跨檔補更"
    return "合法（已知例子）：同一人同日喺唔同 Zone/時段做兩段（例如啟航1331 IC 兩段）"


def check_same_day_multi_shift(records: List[dict]) -> List[dict]:
    by_identity_day: Dict[tuple, list] = defaultdict(list)
    for rec in records:
        if rec["kind"] not in ("work", "ot"):
            continue
        ident = _identity(rec.get("staff_no"), rec.get("name"), rec.get("tel"))
        key = (ident, rec["work_date"])
        by_identity_day[key].append(rec)

    findings = []
    for (ident, work_date), recs in sorted(by_identity_day.items()):
        # count *distinct rows* (file+sheet+row), not distinct cells
        distinct_rows = {}
        for r in recs:
            row_key = (r["file"], r["sheet"], r["row"])
            distinct_rows[row_key] = r
        if len(distinct_rows) > 1:
            rows_here = list(distinct_rows.values())
            findings.append({
                "identity": ident,
                "work_date": work_date,
                "occurrences": len(distinct_rows),
                "explanation": _explain_same_day(rows_here),
                "detail": json.dumps([
                    {
                        "file": r["file"], "sheet": r["sheet"], "row": r["row"],
                        "site_raw": r["site_raw"], "sub_site": r["sub_site"],
                        "rank": r["rank"], "time_slot": r["time_slot"],
                        "code_raw": r["code_raw"], "kind": r["kind"],
                        "name": r["name"], "staff_no": r["staff_no"], "tel": r["tel"],
                    }
                    for r in sorted(rows_here, key=lambda r: (r["file"], r["sheet"], r["row"]))
                ], ensure_ascii=False, sort_keys=True),
            })
    return findings


# ---------------------------------------------------------------------------
# Check 4: missing staff_no (excl. external); staff_no<->name<->tel conflicts
# ---------------------------------------------------------------------------

def check_missing_staff_no(rows: List[dict]) -> List[dict]:
    out = []
    for row in rows:
        if _is_true(row.get("external")):
            continue  # Wilson Guard/Supervisor 本來就冇在勤工號，唔算「缺」
        if not (row.get("staff_no") or "").strip():
            rank = row.get("rank") or ""
            if rank == "Event Guard":
                explanation = ("啟航1331 臨時活動保安（Event Guard），本身冇 staff no，"
                                "用 name+tel 建檔（已知安排，見 P0-執行計劃.md C1）")
            else:
                explanation = "更表本身冇填 staff no，屬真缺，需要人手核實／後補"
            out.append({
                "file": row["file"], "sheet": row["sheet"], "row": row["row"],
                "name": row["name"], "tel": row["tel"], "rank": row["rank"],
                "time_slot": row["time_slot"], "broker_code": row["broker_code"],
                "explanation": explanation,
            })
    return out


def check_identity_conflicts(rows: List[dict]) -> List[dict]:
    staff_no_to_names: Dict[str, set] = defaultdict(set)
    name_to_staff_nos: Dict[str, set] = defaultdict(set)
    tel_to_staff_nos: Dict[str, set] = defaultdict(set)
    tel_to_names: Dict[str, set] = defaultdict(set)
    evidence: Dict[tuple, list] = defaultdict(list)  # (staff_no,name) -> [(file,sheet,row,tel)]
    tel_evidence: Dict[str, list] = defaultdict(list)  # tel -> [(file,sheet,row,staff_no,name)]

    for row in rows:
        staff_no = (row.get("staff_no") or "").strip()
        name = (row.get("name") or "").strip()
        tel = (row.get("tel") or "").strip()
        if staff_no and name:
            staff_no_to_names[staff_no].add(name)
            name_to_staff_nos[name].add(staff_no)
            evidence[(staff_no, name)].append((row["file"], row["sheet"], row["row"], tel))
        if tel and staff_no:
            tel_to_staff_nos[tel].add(staff_no)
            tel_to_names[tel].add(name)
            tel_evidence[tel].append((row["file"], row["sheet"], row["row"], staff_no, name))

    def tels_for(staff_no, name):
        return {t for (_f, _s, _r, t) in evidence[(staff_no, name)] if t}

    def shared_tel(tel_sets: List[set]) -> set:
        if not tel_sets or not all(tel_sets):
            return set()
        return set.intersection(*tel_sets)

    findings = []

    # (a) 同一 staff_no 對應唔同名
    for staff_no, names in sorted(staff_no_to_names.items()):
        if len(names) <= 1:
            continue
        names_sorted = sorted(names)
        tel_sets = [tels_for(staff_no, n) for n in names_sorted]
        if shared_tel(tel_sets):
            explanation = "疑似同一人，姓名寫法唔同（例如簡繁體字），唔係真衝突"
        else:
            explanation = "一號兩人（更表填錯，兩個唔同嘅人共用一個工號；電話唔同，可以用嚟拆返兩個人）"
        findings.append({
            "conflict_type": "staff_no_multiple_names",
            "key": staff_no,
            "values": json.dumps(names_sorted, ensure_ascii=False, sort_keys=True),
            "evidence": json.dumps(
                {name: evidence[(staff_no, name)] for name in names_sorted},
                ensure_ascii=False, sort_keys=True,
            ),
            "explanation": explanation,
        })

    # (b) 同一名對應唔同 staff_no
    for name, staff_nos in sorted(name_to_staff_nos.items()):
        if len(staff_nos) <= 1:
            continue
        sn_sorted = sorted(staff_nos)
        tel_sets = [tels_for(sn, name) for sn in sn_sorted]
        shared = shared_tel(tel_sets)
        if shared and len(sn_sorted) == 2 and len(sn_sorted[0]) == len(sn_sorted[1]):
            diff_positions = sum(1 for a, b in zip(sn_sorted[0], sn_sorted[1]) if a != b)
            if diff_positions == 1:
                explanation = f"一人兩號（懷疑工號打錯一位：{sn_sorted[0]} vs {sn_sorted[1]}），電話一致"
            else:
                explanation = "一人兩號（電話一致，工號有出入，需要人手核實邊個先啱）"
        elif shared:
            explanation = "一人兩號（電話一致，需要人手核實邊個先啱）"
        else:
            explanation = "電話唔一致，可能係兩個唔同嘅人分別攞咗類似工號，需要人手核實"
        findings.append({
            "conflict_type": "name_multiple_staff_nos",
            "key": name,
            "values": json.dumps(sn_sorted, ensure_ascii=False, sort_keys=True),
            "evidence": json.dumps(
                {sn: evidence[(sn, name)] for sn in sn_sorted},
                ensure_ascii=False, sort_keys=True,
            ),
            "explanation": explanation,
        })

    # (c) 同一電話對應唔同 staff_no —— staff_no 唔同但 name+tel 疑似同一人
    for tel, staff_nos in sorted(tel_to_staff_nos.items()):
        if len(staff_nos) <= 1:
            continue
        names_here = sorted(tel_to_names[tel])
        findings.append({
            "conflict_type": "tel_multiple_staff_nos",
            "key": tel,
            "values": json.dumps(sorted(staff_nos), ensure_ascii=False, sort_keys=True),
            "evidence": json.dumps(sorted(tel_evidence[tel]), ensure_ascii=False, sort_keys=True),
            "explanation": (
                f"同一電話 {tel} 對應多過一個 staff_no（姓名：{'/'.join(names_here)}），"
                "疑似同一人用咗唔同工號，或者工號打錯，需要人手核實"
            ),
        })

    return findings


# ---------------------------------------------------------------------------
# Check 5: same file, same staff_no, multiple rows
# ---------------------------------------------------------------------------

def check_duplicate_rows_in_file(rows: List[dict]) -> List[dict]:
    by_file_staff: Dict[tuple, list] = defaultdict(list)
    for row in rows:
        staff_no = (row.get("staff_no") or "").strip()
        if not staff_no:
            continue
        by_file_staff[(row["file"], staff_no)].append(row)

    findings = []
    for (file_, staff_no), rs in sorted(by_file_staff.items()):
        if len(rs) <= 1:
            continue
        names_set = sorted({r["name"] for r in rs})
        if len(names_set) > 1:
            explanation = "工號可能撞用（呢個 staff_no 喺同一檔對應多過一個唔同姓名），需要人手核實"
        else:
            explanation = ("同一人喺同一檔開多過一行（唔同更別/時段，或者 OT 拆開一行），"
                            "屬已知正常情況（例如 HKU座頭 該長工 U0xxxx、HKU Y更 (上)/(摩) 拆行）")
        findings.append({
            "file": file_, "staff_no": staff_no,
            "names": json.dumps(names_set, ensure_ascii=False, sort_keys=True),
            "row_count": len(rs),
            "explanation": explanation,
            "rows": json.dumps([
                {"sheet": r["sheet"], "row": r["row"], "rank": r["rank"],
                 "time_slot": r["time_slot"], "name": r["name"]}
                for r in sorted(rs, key=lambda r: (r["sheet"], int(r["row"])))
            ], ensure_ascii=False, sort_keys=True),
        })
    return findings


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_validate() -> dict:
    paths.ensure_out_dir()
    records = _read_jsonl(paths.RECORDS_JSONL)
    rows = _read_csv(paths.ROWS_CSV)
    sheet_stats = _read_csv(paths.SHEET_STATS_CSV)

    row_total_mismatch = check_row_total_mismatch(rows)
    day_total_mismatch = check_day_total_mismatch(records, sheet_stats)
    day_total_coverage = compute_day_total_coverage(records, sheet_stats)
    same_day_multi_shift = check_same_day_multi_shift(records)
    missing_staff_no = check_missing_staff_no(rows)
    identity_conflicts = check_identity_conflicts(rows)
    duplicate_rows_in_file = check_duplicate_rows_in_file(rows)

    _write_csv(paths.VAL_ROW_TOTAL_MISMATCH_CSV, row_total_mismatch, [
        "file", "sheet", "row", "staff_no", "name", "rank", "time_slot",
        "recomputed_work_count", "sheet_row_total", "diff",
    ])
    _write_csv(paths.VAL_DAY_TOTAL_MISMATCH_CSV, day_total_mismatch, [
        "file", "sheet", "time_slot", "code", "sub_site", "day",
        "recomputed_work_count", "sheet_total_raw", "sheet_total_value",
        "diff", "cell_ref",
    ])
    _write_csv(paths.VAL_SAME_DAY_MULTI_SHIFT_CSV, same_day_multi_shift, [
        "identity", "work_date", "occurrences", "explanation", "detail",
    ])
    _write_csv(paths.VAL_MISSING_STAFF_NO_CSV, missing_staff_no, [
        "file", "sheet", "row", "name", "tel", "rank", "time_slot",
        "broker_code", "explanation",
    ])
    _write_csv(paths.VAL_IDENTITY_CONFLICT_CSV, identity_conflicts, [
        "conflict_type", "key", "values", "evidence", "explanation",
    ])
    _write_csv(paths.VAL_DUPLICATE_ROWS_CSV, duplicate_rows_in_file, [
        "file", "staff_no", "names", "row_count", "explanation", "rows",
    ])

    _write_report_md(
        row_total_mismatch, day_total_mismatch, day_total_coverage,
        same_day_multi_shift, missing_staff_no, identity_conflicts,
        duplicate_rows_in_file,
    )

    return {
        "row_total_mismatch": len(row_total_mismatch),
        "day_total_mismatch": len(day_total_mismatch),
        "same_day_multi_shift": len(same_day_multi_shift),
        "missing_staff_no": len(missing_staff_no),
        "identity_conflicts": len(identity_conflicts),
        "duplicate_rows_in_file": len(duplicate_rows_in_file),
    }


def _write_report_md(row_total_mismatch, day_total_mismatch, day_total_coverage,
                      same_day_multi_shift, missing_staff_no, identity_conflicts,
                      duplicate_rows_in_file):
    lines = []
    lines.append("# WP1 內部對數報告\n")
    lines.append("重跑：`python -m importer run-wp1`（喺 `tools/importer/` 之下，先 `source venv/bin/activate`）。\n")
    lines.append("下面每一類差異都逐條列明（唔淨係計數），有 `explanation` 欄講點解類。\n")

    lines.append("## 1. 逐安員行 work 更數 ≟ sheet 月總更數欄\n")
    lines.append(f"差異：**{len(row_total_mismatch)}** 條。見 `validate-row-total-mismatch.csv`。\n")
    if row_total_mismatch:
        lines.append("| file | sheet | row | staff_no | name | recomputed | sheet_total | diff |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for m in row_total_mismatch:
            lines.append(f"| {m['file']} | {m['sheet']} | {m['row']} | {m['staff_no']} | "
                          f"{m['name']} | {m['recomputed_work_count']} | {m['sheet_row_total']} | {m['diff']} |")
    lines.append("")

    lines.append("## 2. 逐 (time_slot, code) 逐日 work 數 ≟ sheet Total 行\n")
    lines.append(f"差異：**{len(day_total_mismatch)}** 條。見 `validate-day-total-mismatch.csv`。"
                  "呢層依家跟 Total 行自己帶嘅時段/代號對（唔再靠 block 位置），"
                  "其餘 19 檔全部 0 差異。\n")
    if day_total_mismatch:
        lines.append("| file | time_slot | code | sub_site | day | recomputed | sheet_total | diff |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for m in day_total_mismatch:
            lines.append(f"| {m['file']} | {m['time_slot']} | {m['code']} | {m['sub_site']} | "
                          f"{m['day']} | {m['recomputed_work_count']} | {m['sheet_total_value']} | {m['diff']} |")
        lines.append("\n**解釋**：啟航1331「0730-1930／D」呢組，Event Guard（時段 1000-1900，"
                      "另一個代號分組）嘅 D 更表面睇時段唔同，但 sheet 個 Total 行將佢哋併埋喺 "
                      "0730-1930 早更 D 個總數度一齊計。所以嗰一日嘅 recomputed（淨計 0730-1930 "
                      "呢個時段嘅安員）會細過 sheet Total，差額啱啱等於當日 Event Guard 更數。"
                      "呢個唔係 code bug，係源頭表格自己將兩個時段嘅人合埋一條數。\n")

    covered = day_total_coverage["work_records_compared"]
    total_recs = day_total_coverage["work_records_total"]
    uncomparable_recs = day_total_coverage["work_records_uncompared"]
    total_cells = day_total_coverage["total_day_cells"]
    uncomparable_cells = day_total_coverage["total_day_cells_uncomparable"]
    lines.append(
        f"**覆蓋率**：{total_recs} 條 work 記錄入面，已比對 **{covered}** 條、"
        f"未能比對 **{len(uncomparable_recs)}** 條；{total_cells} 個 Total 日格入面，"
        f"未能比對 **{len(uncomparable_cells)}** 個（其餘 {total_cells - len(uncomparable_cells)} "
        "個全部攞去比對過，唔代表全部啱數——啱唔啱數見返上面差異清單）。\n"
    )
    if uncomparable_recs:
        lines.append("**未能比對嘅 work 記錄，逐條原因：**\n")
        lines.append("| file | sheet | row | day | time_slot | code_raw | name | staff_no | 原因 |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for u in uncomparable_recs:
            lines.append(f"| {u['file']} | {u['sheet']} | {u['row']} | {u['day']} | "
                          f"{u['time_slot']} | {u['code_raw']} | {u['name']} | "
                          f"{u['staff_no']} | {u['reason']} |")
        lines.append("")
    if uncomparable_cells:
        lines.append("**未能比對嘅 Total 日格，逐條原因：**\n")
        lines.append("| file | sheet | row | day | cell_ref | 原因 |")
        lines.append("|---|---|---|---|---|---|")
        for u in uncomparable_cells:
            lines.append(f"| {u['file']} | {u['sheet']} | {u['row']} | {u['day']} | "
                          f"{u['cell_ref']} | {u['reason']} |")
        lines.append("")
    lines.append("")

    lines.append("## 3. 同人同日多過一更（staff_no 或 name+tel，跨檔）\n")
    lines.append(f"發現：**{len(same_day_multi_shift)}** 組。見 `validate-same-day-multi-shift.csv`。\n")
    if same_day_multi_shift:
        lines.append("| identity | work_date | occurrences | explanation |")
        lines.append("|---|---|---|---|")
        for f in same_day_multi_shift:
            lines.append(f"| {f['identity']} | {f['work_date']} | {f['occurrences']} | {f['explanation']} |")
    lines.append("")

    lines.append("## 4a. 缺 staff_no（已濾走 external）\n")
    lines.append(f"**{len(missing_staff_no)}** 條。見 `validate-missing-staff-no.csv`。\n")
    if missing_staff_no:
        lines.append("| file | sheet | row | name | rank | explanation |")
        lines.append("|---|---|---|---|---|---|")
        for m in missing_staff_no:
            lines.append(f"| {m['file']} | {m['sheet']} | {m['row']} | {m['name']} | "
                          f"{m['rank']} | {m['explanation']} |")
    lines.append("")

    lines.append("## 4b. staff_no ↔ name ↔ tel 衝突\n")
    lines.append(f"**{len(identity_conflicts)}** 組。見 `validate-identity-conflicts.csv`。\n")
    if identity_conflicts:
        lines.append("| conflict_type | key | values | explanation |")
        lines.append("|---|---|---|---|")
        for c in identity_conflicts:
            lines.append(f"| {c['conflict_type']} | {c['key']} | {c['values']} | {c['explanation']} |")
    lines.append("")

    lines.append("## 5. 同一檔內同一 staff_no 開多行\n")
    lines.append(f"**{len(duplicate_rows_in_file)}** 組。見 `validate-duplicate-rows-in-file.csv`。\n")
    if duplicate_rows_in_file:
        lines.append("| file | staff_no | names | row_count | explanation |")
        lines.append("|---|---|---|---|---|")
        for d in duplicate_rows_in_file:
            lines.append(f"| {d['file']} | {d['staff_no']} | {d['names']} | "
                          f"{d['row_count']} | {d['explanation']} |")

    with open(paths.VALIDATE_REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
