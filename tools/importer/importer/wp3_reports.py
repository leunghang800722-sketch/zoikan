"""⑥ report：三份報表 Excel（openpyxl）。

1. `build_roster_reports`：更表 round-trip——由 WP1 out/wp1/rows.csv +
   records.jsonl（逐格原始資料）配合 out/wp2b/shift_records.csv 嘅
   is_external/provenance 做「邊格留低邊格剔走」嘅業務判斷，逐盤重現做
   xlsx，同原始格仔逐格比對，出 `roundtrip-diff.csv`。
2. `build_payroll_report`：雞頭糧明細——由 shift_records_priced.csv 逐結算
   單位聚合做 xlsx，同 `payroll-rows.csv` 逐行對金額，出 `payroll-diff.csv`。
3. `build_monthly_report`：月結總表——由 shift_records_priced.csv 逐盤聚合，
   同 2026-07-月結總表-FinalR2.pdf 逐行對，出 `monthly-diff.csv`。
"""
import csv
import difflib
import json
import re
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Tuple

from datetime import datetime

from openpyxl import Workbook

from . import paths, wp3_io, wp3_r2
from .private_mappings import broker_canonical_name, client_name

# PDPO：雞頭真名（K/P）／客戶真名淨係喺呢度經 private_mappings 讀一次（冇
# private 檔就 fallback 用代號本身，見 private_mappings.py）。
_BROKER_K = broker_canonical_name("K")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
_BROKER_K_1331 = f"{_BROKER_K}-1331"
_CLIENT_EXCELLENT_PROPERTY = client_name("excellent_property")
_CLIENT_DUSSERVICE = client_name("dusservice")

# openpyxl 預設將「而家」時間寫入 docProps/core.xml（created/modified），
# 令成個 xlsx 檔案每次 save 都 byte 唔同，就算內容一模一樣。跟 WP1/WP2b
# 「連跑幾次要 byte-identical」嘅原則，save 之前一律將呢兩個欄位定死做
# 呢個常數（唔反映真實 wall-clock，純粹保證輸出穩定、可對 md5）。
_FIXED_TIMESTAMP = datetime(2026, 7, 31, 0, 0, 0)


def _save_stable(wb: Workbook, path: Path) -> None:
    wb.properties.created = _FIXED_TIMESTAMP
    wb.properties.modified = _FIXED_TIMESTAMP
    wb.properties.creator = "importer(wp3)"
    wb.properties.lastModifiedBy = "importer(wp3)"
    wb.save(path)
    # 2026-09-10 發現：openpyxl 嘅 save_workbook()（writer/excel.py）save
    # 之前會強制 `workbook.properties.modified = datetime.now()`，完全蓋過
    # 上面設低嘅 _FIXED_TIMESTAMP——每次 save 個 xlsx 都會因為呢一個內部
    # timestamp byte 唔同。呢個係openpyxl library本身嘅行為，唔關內容/
    # 數據事——save完之後直接重寫zip入面嗰份docProps/core.xml，逼佢用返
    # _FIXED_TIMESTAMP，先至真係byte-for-byte穩定（更表round-trip嘅
    # byte-identical驗收先做得到）。
    _force_stable_core_xml(path)


def _force_stable_core_xml(path: Path) -> None:
    import zipfile
    with zipfile.ZipFile(path, "r") as zin:
        infos = zin.infolist()
        contents = {info.filename: zin.read(info.filename) for info in infos}
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:creator>importer(wp3)</dc:creator>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{_FIXED_TIMESTAMP.isoformat()}Z</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{_FIXED_TIMESTAMP.isoformat()}Z</dcterms:modified>'
        '<cp:lastModifiedBy>importer(wp3)</cp:lastModifiedBy>'
        '</cp:coreProperties>'
    ).encode("utf-8")
    contents["docProps/core.xml"] = core_xml
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in sorted(infos, key=lambda i: i.filename):
            new_info = zipfile.ZipInfo(info.filename, date_time=(2026, 7, 31, 0, 0, 0))
            new_info.compress_type = zipfile.ZIP_DEFLATED
            new_info.external_attr = info.external_attr
            zout.writestr(new_info, contents[info.filename])

TWOPLACES = Decimal("0.01")


def _d(x):
    if x is None or x == "":
        return Decimal("0")
    return Decimal(str(x))


def _try_num(x):
    """修正 B10：將睇落係純數字嘅值轉做真正 numeric type（int/float），等
    Excel 開返嚟嗰陣可以直接 SUM/公式用，唔使人手成欄「轉文字為數字」先
    做到。淨係喺已知「呢個位應該係數值」嘅欄先 call（電話/員工編號/時段
    呢啲全部數字但語意上唔係「數量」嘅欄唔會call到呢個function）；輸入
    帶單位/括號備註（例如「27760.00（不完整：長工月薪未分攤）」）呢類轉
    唔到嘅，原句奉還，唔會拋錯、唔會靜靜地砍甩後半句。"""
    if x is None or isinstance(x, (int, float)):
        return x
    if isinstance(x, Decimal):
        return float(x)
    if not isinstance(x, str) or x == "":
        return x
    try:
        return float(x) if ("." in x or "e" in x.lower()) else int(x)
    except (ValueError, TypeError):
        return x


def _read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _read_jsonl(path):
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


# ---------------------------------------------------------------------------
# 1. 更表 round-trip
# ---------------------------------------------------------------------------

def build_roster_reports(out_dir: Path):
    """由 out/wp1/rows.csv（逐個安員行嘅 metadata）+ records.jsonl（逐格原始
    code_raw）重現 20 個更表 xlsx，並用 out/wp2b/shift_records.csv 判斷邊行
    要喺重現報表剔走（external）。

    設計：cell 層面嘅內容（code_raw）本身直接嚟自 WP1 原始抽取（呢個就係
    「原始格仔」），shift_records 負責提供業務判斷（呢格計唔計、邊個 site/
    broker、A欄啱唔啱）——round-trip 驗證嘅重點唔係「我哋有冇打錯字抄錯
    格」（呢個 WP1 already 驗證咗），而係「WP2b/WP3 呢兩層有冇静静整少咗
    /整多咗格仔」。已經證實 out/wp1/records.jsonl 3,638 格同
    out/wp2b/shift_records.csv 嘅 3,638 條 roster-sourced 記錄係完全一一
    對應（bijection，見 rates-report.md 附註），所以呢度嘅 diff 淨係應該
    剩低「刻意剔走」嘅類別。
    """
    roster_dir = out_dir / "roster"
    roster_dir.mkdir(parents=True, exist_ok=True)

    rows_meta = _read_csv(paths.ROWS_CSV)
    records = _read_jsonl(paths.RECORDS_JSONL)
    shift_records = wp3_io.load_wp2b_shift_records()
    broker_conflicts = _read_csv(paths.WP2B_BROKER_CONFLICTS_CSV) if paths.WP2B_BROKER_CONFLICTS_CSV.exists() else []
    identity_decisions = _read_csv(paths.WP2B_IDENTITY_DECISIONS_CSV) if paths.WP2B_IDENTITY_DECISIONS_CSV.exists() else []

    # (file, cell_ref) -> shift_record，做 external / resolved settlement 判斷
    sr_by_cell = {(r["provenance_file"], r["provenance_cell"]): r
                  for r in shift_records if r["provenance_file"].endswith(".xlsx")}

    # 逐檔分組：file -> row -> {meta, cells: {work_date: code_raw}}
    by_file_row = defaultdict(dict)
    for m in rows_meta:
        by_file_row[m["file"]][m["row"]] = {"meta": m, "cells": {}}
    for rec in records:
        row = str(rec["row"])
        entry = by_file_row.setdefault(rec["file"], {}).setdefault(row, {"meta": None, "cells": {}})
        entry["cells"][rec["work_date"]] = rec

    resolved_by_guard_row = defaultdict(list)
    for c in broker_conflicts:
        resolved_by_guard_row[(c["file"], c["evidence"])].append(c)

    diff_rows = []
    all_days = [f"2026-07-{d:02d}" for d in range(1, 32)]

    for file_name, row_map in sorted(by_file_row.items()):
        wb = Workbook()
        ws = wb.active
        ws.title = "2026"
        header = ["雞頭代號", "A欄broker_code_resolved(WP3新增,唔覆寫原值)",
                  "時段", "更別/rank", "Staff No.", "電話", "姓名"] + \
                 [str(d) for d in range(1, 32)] + ["月總更數(work)", "備註"]
        ws.append(header)

        for row_no in sorted(row_map, key=lambda x: int(x)):
            entry = row_map[row_no]
            meta = entry["meta"]
            if meta is None:
                continue
            is_ext = meta["external"] == "True"
            cells = entry["cells"]

            # A欄resolved：呢行個名有冇喺 broker-conflicts.csv 出現（by file+name_zh，
            # broker-conflicts.csv 冇存row number，用姓名對——同一檔案入面姓名
            # 應該唯一，如果撞名會攞到最後一條，屬於已知限制）
            resolved_note = ""
            for c in broker_conflicts:
                if c["file"] == file_name and c.get("name_zh") == meta.get("name"):
                    resolved_note = f"{c['resolved_settlement_unit']}({c['resolution']})"

            work_dates_sorted = sorted(cells.keys())
            row_out = [meta["broker_code"], resolved_note, meta["time_slot"],
                       f"{meta['rank']}", meta["staff_no"], meta["tel"], meta["name"]]

            if is_ext:
                # 設計：external（客戶自己嘅人）喺重現報表整行剔走，唔開單唔出糧。
                # 呢個係 P0-執行計劃 knows 嘅刻意設計，唔係漏格。
                diff_rows.append({
                    "file": file_name, "row": row_no, "staff_no": meta["staff_no"],
                    "name": meta["name"], "work_date": "", "category": "external_row_excluded",
                    "note": f"external（customer own staff），成行{len(cells)}格喺重現報表剔走，唔開單唔出糧",
                })
                continue

            for d in range(1, 32):
                wd = f"2026-07-{d:02d}"
                rec = cells.get(wd)
                if not rec:
                    row_out.append("")
                    continue
                sr = sr_by_cell.get((file_name, rec["cell_ref"]))
                displayed_code = rec["code_raw"]
                row_out.append(_try_num(displayed_code))
                if sr is None:
                    diff_rows.append({
                        "file": file_name, "row": row_no, "staff_no": meta["staff_no"],
                        "name": meta["name"], "work_date": wd, "category": "needs_review",
                        "note": f"cell_ref={rec['cell_ref']} 喺shift_records.csv搵唔到對應provenance，需要覆核",
                    })
            row_out.append(_try_num(meta["sheet_row_total"]))
            row_out.append("")
            ws.append(row_out)

        safe_name = file_name.replace("/", "_")
        _save_stable(wb, roster_dir / safe_name)

    # 身份合併：identity-decisions.csv 逐條都記一行入diff（唔係錯誤，係已知
    # 嘅身份合併決定，方便WP4/Opus覆核）
    for d in identity_decisions:
        diff_rows.append({
            "file": "(cross-file)", "row": "", "staff_no": "", "name": d.get("key_value", ""),
            "work_date": "", "category": f"identity_{d['decision']}",
            "note": f"{d['decision']}: {d['guard_ids']} ({d['key_type']}={d['key_value']})",
        })

    # 統計行重算（P0-執行計劃§3.1「統計行唔當安員，工具自己由格仔重算再同
    # 統計行交叉核對」）：Total由records.jsonl逐sub-group/day嘅kind=="work"
    # 格仔數重算（pointer/leave/ot唔算work，「數據中心」pointer本身唔喺
    # CP5file出現work kind，自然唔會計落CP5嘅Total，符合「只喺數據中心更
    # 表計一次」嘅規則）；尚欠=所需人手(sheet-stats原值，呢個係policy輸
    # 入，唔重算)－Total(重算)。
    #
    # 配對key預設用(file, block_id, day)——19個file嘅block_id喺
    # records.jsonl同sheet-stats.csv兩條抽取路徑之間一一對應，呢個key準確
    # 又安全（例如城巴車廠每個depot block先啱好對得住，改用time_slot/code
    # 會將唔同depot但撞同一個time_slot/code嘅block錯誤合併，試過會屈出
    # 84條假diff）。
    #
    # 淨係啟航1331（QIHANG_FILE）例外：呢個file嘅Total行受Excel日期污染，
    # 擾亂咗WP1 block切界嘅heuristic，令兩條抽取路徑對同一個physical更別
    # sub-group編咗唔同嘅block_id（實測：records.jsonl嘅B0涵蓋咗「早Zone
    # IC」＋「早更」兩組人合共17行，但sheet-stats.csv嘅B0淨係「早Zone IC」
    # 嗰4人嘅Total；B3/B4兩個block都係time_slot=2230-0730但code分別係
    # SIC/IC，records.jsonl入面全部歸咗B3）。淨係呢個file改用
    # (day, time_slot, code_raw)做key——喺呢個file入面time_slot+code啱啱好
    # 對應返每個更別sub-group嘅guard行範圍，唔受block_id編號漂移影響。
    QIHANG_FILE = "Roster - 啟航1331 - Jul 2026 (updated 27.07.2026).xlsx"

    # 啟航1331嘅「尚欠」stat row自己個code欄唔可靠——實測「尚欠」有時攞到
    # 職級文字（例如"早更保安員"）而唔係真係嘅shift code（"D"），令佢同
    # 同一個block嘅Total/所需人手（code="D"）拆咗做兩個key、屈出「Total有
    # 但尚欠冇」嘅假phantom entry。所以先用「Total」呢個可靠嘅label，逐
    # (day,time_slot)攞返個canonical code，「所需人手」／「尚欠」淨係喺
    # 果個(day,time_slot)得返一個Total-code先override（多過一個code嘅
    # ambiguous時段——例如2230-0730同時有SIC/IC兩組——就信返stat row自己
    # 個code，如果都啱好係嗰兩個候選之一）。
    qihang_codes_by_slot: Dict[Tuple[int, str], set] = defaultdict(set)
    for s in _read_csv(paths.SHEET_STATS_CSV):
        if s["file"] == QIHANG_FILE and s["stat_label"] == "Total" and (s.get("day") or "").strip():
            qihang_codes_by_slot[(int(s["day"]), s.get("time_slot") or "")].add(s.get("code") or "")

    def _qihang_code(s):
        slot_key = (int(s["day"]), s.get("time_slot") or "")
        candidates = qihang_codes_by_slot.get(slot_key, set())
        if len(candidates) == 1:
            return next(iter(candidates))
        raw = s.get("code") or ""
        if raw in candidates:
            return raw
        return raw

    def _rec_key(rec):
        if rec["file"] == QIHANG_FILE:
            return (rec["file"], int(rec["day"]), rec.get("time_slot") or "", rec.get("code_raw") or "")
        return (rec["file"], rec["block_id"], int(rec["day"]))

    def _stat_key(s):
        if s["file"] == QIHANG_FILE:
            return (s["file"], int(s["day"]), s.get("time_slot") or "", _qihang_code(s))
        return (s["file"], s["block_id"], int(s["day"]))

    work_count_by_key: Dict[tuple, int] = defaultdict(int)
    for rec in records:
        if rec.get("kind") == "work":
            work_count_by_key[_rec_key(rec)] += 1

    sheet_stats = _read_csv(paths.SHEET_STATS_CSV)
    stat_rows_by_key: Dict[tuple, Dict[str, str]] = defaultdict(dict)
    block_by_key: Dict[tuple, str] = {}
    for s in sheet_stats:
        if s["stat_label"] not in ("Total", "所需人手", "尚欠"):
            continue  # 「早加夜」／CP5/CP1-4嗰兩組"19"/"9"係另一種彙總行，
                      # 結構未完全確認，WP3c刻意唔喺呢度重算，避免屈假diff。
        if not (s.get("day") or "").strip():
            continue  # 冇day嘅stat row（例如跨月/整月彙總格），唔啱呢個逐日重算
        key = _stat_key(s)
        stat_rows_by_key[key][s["stat_label"]] = s.get("value") or s.get("raw_value") or ""
        block_by_key[key] = s["block_id"].split("::")[-1]

    for key, stats in sorted(stat_rows_by_key.items(), key=lambda kv: (kv[0][0], str(kv[0][1:]))):
        file_name = key[0]
        if file_name == QIHANG_FILE:
            _, day, time_slot, code = key
            row_label = block_by_key.get(key, "")
        else:
            _, block_id, day = key
            time_slot, code = "", ""
            row_label = block_id.split("::")[-1]
        computed_total = work_count_by_key.get(key, 0)
        orig_total = stats.get("Total", "")
        orig_required = stats.get("所需人手", "")
        orig_shortfall = stats.get("尚欠", "")
        try:
            required_val = int(float(orig_required)) if orig_required != "" else None
        except ValueError:
            required_val = None
        try:
            total_matches = orig_total != "" and int(float(orig_total)) == computed_total
        except ValueError:
            total_matches = False
        computed_shortfall = (required_val - computed_total) if required_val is not None else None
        try:
            shortfall_matches = (computed_shortfall is not None and orig_shortfall != ""
                                  and int(float(orig_shortfall)) == computed_shortfall)
        except ValueError:
            shortfall_matches = False

        if total_matches and (computed_shortfall is None or shortfall_matches):
            continue
        wd = f"2026-07-{day:02d}"
        category = "stat_recompute" if file_name == QIHANG_FILE else "needs_review"
        name_label = f"統計行(time_slot={time_slot},code={code})" if file_name == QIHANG_FILE else "統計行"
        diff_rows.append({
            "file": file_name, "row": row_label, "staff_no": "",
            "name": name_label, "work_date": wd, "category": category,
            "note": f"Total原值={orig_total} 重算={computed_total}；"
                    f"所需人手={orig_required}；尚欠原值={orig_shortfall} 重算={computed_shortfall}",
        })

    return diff_rows


# ---------------------------------------------------------------------------
# 2. 雞頭糧明細
# ---------------------------------------------------------------------------

_PAYROLL_REF_RE = re.compile(r"^(?P<src>.+)#p(?P<page>\d+)#row(?P<row>\d+)$")


def _parse_payroll_refs(ref: str):
    """`shift_records.csv` 嘅 `payroll_ref` 欄格式：
    `2026-07-雞頭糧明細-FinalR.pdf#p5#row9`，跨 1-15/16-31 兩頁用`;`分隔。
    拆做 (source_file, page, row_no) tuple list，page/row_no 去咗 p/row
    前綴淨低純數字字串，直接同 payroll-rows.csv／payroll-cells*.csv 嘅
    page/row_no 欄（都係純數字字串）做key比對。"""
    out = []
    for part in (ref or "").split(";"):
        part = part.strip()
        if not part:
            continue
        m = _PAYROLL_REF_RE.match(part)
        if m:
            out.append((m.group("src"), m.group("page"), m.group("row")))
    return out


def build_payroll_report(out_dir: Path, priced_rows: List[dict], sites_by_id: Dict[str, dict],
                          guards_by_id: Dict[str, dict], payroll_rows: List[dict],
                          payroll_pages: List[dict] = None,
                          raw_shift_records: List[dict] = None,
                          payroll_cells: List[dict] = None):
    payroll_dir = out_dir / "payroll"
    payroll_dir.mkdir(parents=True, exist_ok=True)

    # 用 settlement_page（K 先分頁）優先，冇就用 settlement_unit 做 sheet 分組。
    #
    # 修必修1（2026-09-10）：唔可以對 source=master_roster／master_roster_
    # site（rule 0.1／0.2）嘅記錄無腦 fallback 去 settlement_unit——呢兩條
    # 規則嘅 settlement_unit 值（T／G／公司兵…真名見 data/mappings-private/
    # brokers.csv）啱啱好同真實糧單
    # 頁面嘅字面 label 一樣，如果冇真糧單證據（settlement_page=""）都跌落
    # 呢個 fallback，就會將呢啲總表confirm但糧單搵唔到嘅記錄，錯誤計入
    # *真.糧單頁*嘅逐頁 Total（page_diff_rows 同 payroll-pages.csv 嘅
    # policy_total_shifts 對唔上，公司兵頁曾經因此由 243 regen 到 376）。
    # 呢類記錄冇真糧單頁可以重現，用 master_broker_code 開獨立 sheet（唔會
    # 撞落任何 payroll-pages.csv 已知嘅 settlement_unit，唔會計入逐頁對
    # 數），純粹畀人手審核用。
    def group_key(r):
        if r["settlement_page"]:
            return r["settlement_page"]
        if r.get("source") in ("master_roster", "master_roster_site"):
            code = r.get("master_broker_code") or ""
            return f"總表確認-{code}" if code else (r["settlement_unit"] or "(unknown)")
        # WP5c必修12：master_roster_only（國泰城/M+/CP5 IC/控制室/威信
        # Patrol/ICBC/哈羅——§3.7「月結有、更表冇」，冇任何糧單頁證據）
        # 同上面master_roster/master_roster_site係同一個問題嘅同類修正：
        # 呢啲記錄嘅settlement_unit（公司兵/K…真名見private mapping）啱啱好同真糧單頁字面
        # label一樣，如果落返呢啲settlement_unit分組，會將冇糧單證據嘅
        # 記錄計入*真.糧單*嘅逐頁Total，同payroll-pages.csv嘅
        # policy_total_shifts對唔上（實測：公司兵頁243 regen到338）。
        if r.get("source") == "master_roster_only":
            return f"總表補入庫-{r.get('site_id','')}"
        return r["settlement_unit"]

    groups = defaultdict(list)
    for r in priced_rows:
        if r["settlement_unit"] in ("external",):
            continue
        groups[group_key(r)].append(r)

    # 修正 A1：糧明細報表加返「時段」＋1-31逐日格（P0-執行計劃§3.1原始欄
    # 序：物業/時段/保安員/單價/1-31/更數/工資/雞頭費/金額）。
    #   - 逐日「1」／「OT」：由 raw_shift_records（out/wp2b/shift_records.csv，
    #     未經pricing篩走ot/leave，record_type齊全）逐日逐(site,guard)標記——
    #     唔用priced_rows係因為price_shift_records()一開始就skip咗
    #     record_type!=shift嘅記錄（見wp3_pricing.py），OT格喺priced_rows
    #     搵唔返。
    #   - 逐日狀態碼（RD/NL/SH/AL…）：呢啲請假日冇對應shift_record（唔係
    #     更次），要由 payroll-cells*.csv（WP2a原始轉錄，逐格保留cell_kind=
    #     status）補返——透過 shift_records.csv 嘅 `payroll_ref` 欄
    #     （source_file#page#row_no，WP2b normalize時已經寫低嘅出處）反查
    #     返呢個guard呢個site對應payroll-rows.csv邊一行，再用同一組
    #     (source_file,page,row_no) 去 payroll-cells 逐日搵status格。
    #   - 時段：同樣用 (source_file,page,row_no) 查 payroll-rows.csv 嘅
    #     time_slot欄（呢個先係原始頁面印嘅時段文字，唔靠shift_type反推）。
    raw_shift_records = raw_shift_records or []
    payroll_cells = payroll_cells or []

    rowmeta_by_ref: Dict[Tuple[str, str, str], dict] = {}
    for pr in payroll_rows:
        key = (pr.get("source_file", ""), pr.get("page", ""), pr.get("row_no", ""))
        rowmeta_by_ref.setdefault(key, pr)

    cells_by_ref_day: Dict[Tuple[str, str, str, int], dict] = {}
    for pc in payroll_cells:
        try:
            day = int(pc.get("day") or 0)
        except ValueError:
            continue
        if not day:
            continue
        key = (pc.get("source_file", ""), pc.get("page", ""), pc.get("row_no", ""), day)
        cells_by_ref_day[key] = pc

    day_mark_by_group: Dict[str, Dict[Tuple[str, str], Dict[int, str]]] = defaultdict(lambda: defaultdict(dict))
    refs_by_group_guard: Dict[str, Dict[Tuple[str, str], set]] = defaultdict(lambda: defaultdict(set))
    for r in raw_shift_records:
        if r.get("record_type") not in ("shift", "ot"):
            continue
        g = group_key(r)
        key = (r["site_id"], r["guard_id"])
        wd = r.get("work_date") or ""
        if len(wd) != 10:
            continue
        try:
            day = int(wd[8:10])
        except ValueError:
            continue
        mark = "1" if r["record_type"] == "shift" else "OT"
        day_mark_by_group[g][key][day] = mark
        for ref in _parse_payroll_refs(r.get("payroll_ref", "")):
            refs_by_group_guard[g][key].add(ref)

    # 月費制安員（月費制人甲 M+、月費制人乙 控制室…）：shift_kind!=normal，一條
    # shift_record都冇（見out/wp2b/payroll-only-rows.csv），淨係喺
    # payroll-rows.csv/payroll-cells*.csv有記錄——上面`refs_by_group_guard`
    # 完全搵佢哋唔到，會令佢哋成個guard喺regenerated xlsx度冧晒（連埋
    # 15粒status格入面14粒都屬於呢兩個guard），所以呢度直接由
    # payroll-rows.csv補返一組(source_file,page,row_no)俾佢哋，唔使
    # 經shift_records。呢啲補充row純粹畀「月結對照」sheet顯示/audit用
    # （逐日格status code），唔會計落tot/regen_totals/regen_shifts——嗰啲
    # 已經由下面`monthly_totals`/`ot_adj_totals`嗰段validated嘅
    # payroll-diff邏輯獨立處理（category=ot_or_adjustment），呢度加多行
    # 純粹視覺展示，唔可以影響Total行/policy_total_shifts核對。
    from .normalize import SiteIndex as _SiteIndex
    _site_index = _SiteIndex(list(sites_by_id.values()))
    payroll_only_rows_by_group: Dict[str, List[dict]] = defaultdict(list)
    for pr in payroll_rows:
        if (pr.get("shift_kind") or "normal") == "normal":
            continue
        g = pr.get("settlement_unit") or ""
        payroll_only_rows_by_group[g].append(pr)

    wb = Workbook()
    wb.remove(wb.active)
    regen_totals = defaultdict(lambda: defaultdict(Decimal))  # group -> (site,guard) -> amount
    regen_shifts = defaultdict(lambda: defaultdict(Decimal))  # group -> (site,guard) -> shifts
    sheet_totals = {}  # group -> {"shifts":..,"wage":..,"fee":..,"amount":..}
    day_cols = [str(d) for d in range(1, 32)]

    for group, rows in sorted(groups.items()):
        ws = wb.create_sheet(title=group[:31] if group else "unknown")
        ws.append(["物業", "時段", "保安員", "單價", *day_cols, "更數", "工資", "雞頭費", "金額"])
        by_guard_site = defaultdict(lambda: {"shifts": Decimal("0"), "wage": None, "fee": None})
        for r in rows:
            key = (r["site_id"], r["guard_id"])
            g = by_guard_site[key]
            g["shifts"] += Decimal("1")
            if r["guard_wage_snapshot"]:
                g["wage"] = _d(r["guard_wage_snapshot"])
            if r["broker_fee_snapshot"]:
                g["fee"] = _d(r["broker_fee_snapshot"])
        tot = {"shifts": Decimal("0"), "wage": Decimal("0"), "fee": Decimal("0"), "amount": Decimal("0")}
        for (site_id, guard_id), g in sorted(by_guard_site.items()):
            guard = guards_by_id.get(guard_id, {})
            site = sites_by_id.get(site_id, {})
            wage_sub = (g["wage"] or Decimal("0")) * g["shifts"]
            fee_sub = (g["fee"] or Decimal("0")) * g["shifts"]
            amount = wage_sub + fee_sub

            gk = (site_id, guard_id)
            day_marks = day_mark_by_group.get(group, {}).get(gk, {})
            refs = refs_by_group_guard.get(group, {}).get(gk, set())
            time_slot = ""
            for ref in sorted(refs):
                meta = rowmeta_by_ref.get(ref)
                if meta and meta.get("time_slot"):
                    time_slot = meta["time_slot"]
                    break
            day_values = []
            for d in range(1, 32):
                v = day_marks.get(d, "")
                if not v:
                    # 冇shift/OT記錄嘅日——試下呢個guard對應嘅payroll-rows
                    # row_no喺payroll-cells度嗰日係咪有status格（RD/NL/
                    # SH/AL…，請假日冇shift_record，要由轉錄原始資料補）。
                    for ref in sorted(refs):
                        cell = cells_by_ref_day.get((*ref, d))
                        if cell and cell.get("cell_kind") == "status":
                            v = cell.get("cell_value", "")
                            break
                day_values.append(v)

            ws.append([site.get("canonical_name", site_id), time_slot, guard.get("name_zh", ""),
                       _try_num(str(g["wage"] or "")), *[_try_num(v) for v in day_values],
                       _try_num(str(g["shifts"])),
                       _try_num(str(wage_sub)), _try_num(str(fee_sub)), _try_num(str(amount))])
            regen_totals[group][(site_id, guard.get("name_zh", ""))] = amount
            regen_shifts[group][(site_id, guard.get("name_zh", ""))] = g["shifts"]
            tot["shifts"] += g["shifts"]
            tot["wage"] += wage_sub
            tot["fee"] += fee_sub
            tot["amount"] += amount

        # 補返月費制/非normal安員（月費制人呢類）：唔計落tot，純視覺
        # 展示＋畀status code逐日格有嘢可以核（呢兩個guard正正係全部15粒
        # status格入面淨有嘅owner）。
        for pr in payroll_only_rows_by_group.get(group, []):
            site_id2 = _site_index.resolve(pr.get("site_label") or "") or ""
            site2 = sites_by_id.get(site_id2, {})
            ref2 = (pr.get("source_file", ""), pr.get("page", ""), pr.get("row_no", ""))
            day_values2 = []
            for d in range(1, 32):
                cell = cells_by_ref_day.get((*ref2, d))
                if cell and cell.get("cell_kind") in ("status", "shift", "ot"):
                    day_values2.append(cell.get("cell_value", "") if cell.get("cell_kind") == "status"
                                        else ("OT" if cell.get("cell_kind") == "ot" else "1"))
                else:
                    day_values2.append("")
            ws.append([site2.get("canonical_name", site_id2) or pr.get("site_label", ""),
                       pr.get("time_slot", ""), pr.get("guard_name", ""),
                       _try_num(str(pr.get("rate") or "")), *[_try_num(v) for v in day_values2],
                       f"{pr.get('shifts', '')}（{pr.get('shift_kind', '')}，唔計入Total，見payroll-diff.csv）",
                       "", "", _try_num(str(pr.get("amount") or ""))])

        # 逐頁總計行（更數／工資／雞頭費／金額，P0-執行計劃WP3c §B）——用嚟
        # 同payroll-pages.csv嘅policy_total_shifts核對（見下面page_diff_rows）。
        # 呢個Total淨計normal shift_kind（policy_total_shifts口徑，§3.7a），
        # 唔包above嘅月費制補充行。
        ws.append(["Total", "", "", "", *([""] * 31), _try_num(str(tot["shifts"])), _try_num(str(tot["wage"])),
                   _try_num(str(tot["fee"])), _try_num(str(tot["amount"]))])
        sheet_totals[group] = tot

    _save_stable(wb, payroll_dir / "雞頭糧明細-regenerated.xlsx")

    # 逐頁總計 vs payroll-pages.csv 嘅 policy_total_shifts（WP2a已驗收嘅口
    # 徑：OT唔算一更，見P0-執行計劃§3.7a）。一個settlement_unit可能有
    # 「全月」／「1-15」+「16-31」兩期，要加埋先啱好比得住全月regen總數。
    policy_by_unit: Dict[str, Decimal] = defaultdict(Decimal)
    for p in (payroll_pages or []):
        su = p.get("settlement_unit")
        pts = p.get("policy_total_shifts")
        if su and pts not in (None, ""):
            policy_by_unit[su] += _d(pts)

    page_diff_rows = []
    for group, tot in sheet_totals.items():
        expected = policy_by_unit.get(group)
        if expected is None:
            continue
        if tot["shifts"] != expected:
            page_diff_rows.append({
                "settlement_unit": group, "site_label": "__PAGE_TOTAL__", "guard_name": "",
                "payroll_amount": str(expected), "regenerated_amount": str(tot["shifts"]),
                "diff": str(tot["shifts"] - expected),
                "note": "逐頁總更數(regen) vs payroll-pages.csv policy_total_shifts唔等",
                "category": "shift_count_diff",
            })

    # diff：同 payroll-rows.csv 逐行對（by settlement_unit/page + site_label
    # 解出嘅site_id + guard_name），只對得上先比較金額；對唔上嘅列明原因，
    # 唔屈個 site_id。
    from .normalize import SiteIndex, normalize_name
    site_index = SiteIndex(list(sites_by_id.values()))
    from .wp3_rates import OUT_OF_SCOPE_SETTLEMENT_UNITS

    # D/W/公司兵-2/LINK公司兵 有「1-15」＋「16-31」兩頁（period 分開），
    # 要先加埋先至係全月金額，先可以同 regenerated（全月）比較——唔係就會
    # 每個人「淨計半個月」對成個月，穩定造成假diff（曾經發生：G0092
    # （PDPO：只記guard_id，具體人可查out/wp2b/guards.csv）7300
    # vs regen 14600，其實 7300 只係 16-31 嗰半月，1-15 嗰半月都係 7300，
    # 相加先啱）。
    monthly_totals = defaultdict(lambda: {"amount": Decimal("0"), "shifts": Decimal("0"),
                                           "site_labels": set(), "rows": []})
    ot_adj_totals = defaultdict(lambda: {"amount": Decimal("0"), "kinds": set()})
    for row in payroll_rows:
        su = row["settlement_unit"]
        if su in OUT_OF_SCOPE_SETTLEMENT_UNITS or su in (_BROKER_K_1331, _BROKER_P):
            continue  # LINK C7 out_of_scope；K-1331逐日總額／個別雞頭特殊收入項冇逐guard金額，唔啱呢個逐guard diff
        site_id = site_index.resolve(row["site_label"])
        k = (su, site_id, row["guard_name"])
        if row["shift_kind"] != "normal":
            a = ot_adj_totals[k]
            a["amount"] += _d(row["amount"])
            a["kinds"].add(row["shift_kind"])
            continue
        agg = monthly_totals[k]
        agg["amount"] += _d(row["amount"])
        if row.get("shifts"):
            agg["shifts"] += _d(row["shifts"])
        agg["site_labels"].add(row["site_label"])
        agg["rows"].append(row)

    # near_name候選：唔淨係搵同一個su入面嘅名——WP2b已知近似名（見
    # out/wp2b/name-near-match.csv）因為人手確認清單未合併，令個guard實際嘅
    # settlement_unit可能解析去咗第二個su（甚至unknown），淨喺同一su搵會
    # 見漏。所以呢度攞埋全部site_id曾經出現嘅guard_name做全域候選（唔限
    # su），match到就喺note出返實際regen嗰邊嘅su，方便人手核對。
    global_candidates_by_site: Dict[str, List[Tuple[str, str]]] = defaultdict(list)
    global_candidates_all: List[Tuple[str, str, str]] = []  # (name, site_id, su)
    for su_x, site_map in regen_totals.items():
        for (sid, gn) in site_map.keys():
            if gn:
                global_candidates_by_site[sid].append((gn, su_x))
                global_candidates_all.append((gn, sid, su_x))

    diff_rows = list(page_diff_rows)
    for (su, site_id, guard_name), agg in monthly_totals.items():
        expected = agg["amount"]
        actual = regen_totals.get(su, {}).get((site_id, guard_name))
        actual_shifts = regen_shifts.get(su, {}).get((site_id, guard_name))
        site_label = "/".join(sorted(agg["site_labels"]))

        if actual is None:
            # 搵唔到對應(site_id, guard_name)組合——先睇係咪mixed_row（呢個
            # guard呢個su入面有多個site_label，可能site_label解析拆咗做
            # 唔同site_id）、再睇係咪mixed_site_label（single row嘅
            # site_label文字本身已經係composite，例如「31/皓日/創富(混合)」
            # ——payroll-rows.csv轉錄嗰陣已經將幾個site合埋一行/一個
            # guard_name，而唔係拆開幾行）、再睇係咪near_name（同一
            # site_id、任何su有個相近姓名，可能係轉錄/正規化打字差，或者
            # WP2b近似名未合併令佢分咗落第二個su），淨係全部都唔係先當
            # tool_bug。
            #
            # 修正 B8：以前near_name揾到嘅「近似姓名」有時同guard_name
            # 一模一樣（difflib對住完全相同嘅字串一定係ratio=1.0嘅「最近
            # 似」）——呢種唔係真係近似名/打字差，係個guard identity搵到，
            # 但site_id分拆唔到（跨3個site嘅composite site_label就係噉，
            # PDPO：真實個案可查payroll-diff.csv category=mixed_site_label
            # 嗰幾條），將佢叫做「近似姓名」會誤導人以為要人手核對一個唔
            # 存在嘅OCR差異。所以exact match唔再算near_name。
            if len(agg["site_labels"]) > 1:
                category, note = "mixed_row", f"呢個guard喺payroll-rows.csv同一su入面有多個site_label：{site_label}"
            elif "混合" in site_label or site_label.count("/") >= 1:
                # site_label本身已經係複數site名join埋一齊（例如
                # 「31/皓日/創富(混合)」），呢個guard嘅shift_records真係分散
                # 咗落幾個唔同site_id——攞返呢個su入面同名（exact match）
                # 嘅guard橫跨嘅全部site_id，加返總更數，睇下同payroll claim
                # 差幾多，畀返一個可追蹤嘅缺口數，唔淨係話「近似名」。
                matching_site_ids = [sid for (sid, gn) in regen_totals.get(su, {}).keys() if gn == guard_name]
                total_regen_shifts = sum(
                    (regen_shifts.get(su, {}).get((sid, guard_name)) or Decimal("0"))
                    for sid in matching_site_ids
                )
                gap = agg["shifts"] - total_regen_shifts if agg["shifts"] else None
                if matching_site_ids:
                    category = "mixed_site_label"
                    note = (f"site_label係composite（「{site_label}」），呢個guard橫跨site_id="
                            f"{sorted(matching_site_ids)}，regen總更數={total_regen_shifts}"
                            + (f"，vs payroll claim{agg['shifts']}更，缺口{gap}" if gap is not None else "")
                            + "（人手拆返每個site_id應佔幾多更）")
                else:
                    category = "shift_missing"
                    note = f"site_label係composite（「{site_label}」），但regenerated報表全部site_id都搵唔到「{guard_name}」呢個guard名，shift_records可能完全缺漏"
            else:
                same_site_pairs = global_candidates_by_site.get(site_id, [])
                candidates = [gn for gn, _su in same_site_pairs if gn != guard_name]
                if not candidates:
                    candidates = [gn for (sid, gn) in regen_totals.get(su, {}).keys() if gn and gn != guard_name]
                    same_site_pairs = [(gn, su) for (sid, gn) in regen_totals.get(su, {}).keys() if gn]
                close = difflib.get_close_matches(guard_name, candidates, n=1, cutoff=0.5)
                if close:
                    matched_su = next((s for gn, s in same_site_pairs if gn == close[0]), su)
                    category, note = "near_name", f"regenerated報表site_id={site_id}（su={matched_su}）有個近似姓名「{close[0]}」，可能係轉錄/正規化打字差或WP2b近似名未合併"
                else:
                    # 最後一步：全部site/su都搵一次（同site都搵唔到，可能
                    # 個guard跨盤——例如WP2b已知近似名（見
                    # out/wp2b/name-near-match.csv）入面兩個唔同site各一次嘅
                    # 個案），純粹畀人手核對用嘅提示，
                    # 唔會自動合併身份。exact同名（同上面理由）唔算near_name，
                    # 落去shift_missing。
                    all_names = [n for (n, sid, s) in global_candidates_all if n != guard_name]
                    close_all = difflib.get_close_matches(guard_name, all_names, n=1, cutoff=0.5)
                    if close_all:
                        n2, sid2, su2 = next((x for x in global_candidates_all if x[0] == close_all[0]))
                        category, note = "near_name", f"regenerated報表site_id={sid2}（su={su2}，同payroll呢行嘅site_id={site_id}唔同）有個近似姓名「{close_all[0]}」，可能係跨盤重名或WP2b近似名未合併，人手核對"
                    else:
                        exact_elsewhere = [(sid, s) for (n, sid, s) in global_candidates_all if n == guard_name]
                        if exact_elsewhere:
                            category = "shift_missing"
                            note = (f"「{guard_name}」呢個guard名喺regenerated報表site_id="
                                     f"{sorted({sid for sid, s in exact_elsewhere})}存在（su={sorted({s for sid, s in exact_elsewhere})}），"
                                     f"但呢個(site_id={site_id})冇對到——可能shift_records冇齊/site_id判定唔同，人手核實")
                        else:
                            category, note = "tool_bug", "喺regenerated報表搵唔到對應(site_id/guard_name)組合，可能係site_label解唔到／guard名對唔上"
            diff_rows.append({
                "settlement_unit": su, "site_label": site_label, "guard_name": guard_name,
                "payroll_amount": str(expected), "regenerated_amount": "",
                "diff": "", "note": note, "category": category,
            })
        elif actual != expected:
            ot_adj = ot_adj_totals.get((su, site_id, guard_name))
            if actual_shifts is not None and agg["shifts"] and actual_shifts != agg["shifts"]:
                category = "shift_count_diff"
                note = f"更數payroll={agg['shifts']} vs regen={actual_shifts}"
            elif ot_adj and abs((actual - expected) - ot_adj["amount"]) <= Decimal("0.01"):
                category = "ot_or_adjustment"
                note = f"金額差同OT/調整行({'/'.join(sorted(ot_adj['kinds']))})金額{ot_adj['amount']}吻合"
            else:
                category = "tool_bug"
                note = ""
            diff_rows.append({
                "settlement_unit": su, "site_label": site_label, "guard_name": guard_name,
                "payroll_amount": str(expected), "regenerated_amount": str(actual),
                "diff": str(actual - expected), "note": note, "category": category,
            })
        else:
            # 修正 B7：金額啱唔代表更數一定啱——payroll-rows.csv嘅shifts欄
            # 有時係碎數（PDPO：真實個案可查payroll-diff.csv
            # category=shift_count_diff_amount_ok嗰條，某長工23.25 vs
            # regen 23個shift_record，因為Autopay長工嘅雞頭費係一個flat
            # 金額，唔逐更計，就算更數差0.25都唔會反映落金額度）。以前
            # 呢種case金額對得中就直接歸"ok"，令23.25呢類可疑碎數靜靜哋
            # 冧咗——而家金額一樣都要額外比一次更數，
            # 唔啱就照樣flag（但唔可以當tool_bug，金額本身冚啱，只係更數
            # 有蹊蹺，用專門category）。
            if actual_shifts is not None and agg["shifts"] and actual_shifts != agg["shifts"]:
                diff_rows.append({
                    "settlement_unit": su, "site_label": site_label, "guard_name": guard_name,
                    "payroll_amount": str(expected), "regenerated_amount": str(actual),
                    "diff": "0",
                    "note": f"金額啱（{expected}），但更數payroll={agg['shifts']} vs regen={actual_shifts}唔啱（可能係碎數/半更轉錄，人手核實）",
                    "category": "shift_count_diff_amount_ok",
                })
            else:
                diff_rows.append({
                    "settlement_unit": su, "site_label": site_label, "guard_name": guard_name,
                    "payroll_amount": str(expected), "regenerated_amount": str(actual),
                    "diff": "0", "note": "", "category": "ok",
                })

    # OT/調整/月費/flat_referral 呢啲shift_kind!=normal嘅行，唔啱呢個逐guard
    # 金額diff（唔係逐更計、或者係跨月調整），但要留底喺payroll-diff.csv
    # 交代去向，唔可以靜靜哋喺diff度消失。
    for (su, site_id, guard_name), a in ot_adj_totals.items():
        diff_rows.append({
            "settlement_unit": su, "site_label": "", "guard_name": guard_name,
            "payroll_amount": str(a["amount"]), "regenerated_amount": "",
            "diff": "", "note": f"shift_kind={'/'.join(sorted(a['kinds']))}，唔逐更計價，唔入呢個diff嘅金額比對",
            "category": "ot_or_adjustment",
        })
    return diff_rows


# ---------------------------------------------------------------------------
# 3. 月結總表
# ---------------------------------------------------------------------------

_SETTLE_LINE_RE = re.compile(r"^\s*(\d{1,2})\s+(.+)$")


def parse_settlement_rows(text: str) -> List[dict]:
    out = []
    for line in text.splitlines():
        m = _SETTLE_LINE_RE.match(line)
        if not m:
            continue
        row_no, rest = m.groups()
        amts = re.findall(r"HK\$([\d,]+)", rest)
        pct = re.findall(r"(-?\d+\.?\d*)%", rest)
        lm = re.match(r"^(\D+?)\s+(\d+)\b", rest)
        if lm:
            label, shifts = lm.group(1).strip(), int(lm.group(2))
        else:
            label, shifts = rest.strip(), None
        label = re.sub(r"\s{2,}.*$", "", label).strip()
        revenue = cost = profit = None
        if len(amts) >= 3:
            revenue, cost, profit = (Decimal(a.replace(",", "")) for a in amts[-3:])
        elif len(amts) == 2:
            cost, profit = (Decimal(a.replace(",", "")) for a in amts)
        out.append({
            "row_no": int(row_no), "label": label, "shifts": shifts,
            "revenue": revenue, "cost": cost, "profit": profit,
            "pct": pct[-1] if pct else "", "raw": rest.strip(),
        })
    return out


_AUTOPAY_MARKER = "長工autopay月薪，非逐更工資"


def build_monthly_report(out_dir: Path, priced_rows: List[dict], sites_by_id: Dict[str, dict],
                          invoice_aliases: Dict[str, str], rate_cards: List[dict] = None,
                          shift_type_billing_group: Dict[str, str] = None,
                          billing_units: Dict[str, dict] = None,
                          unpriced_rows: List[dict] = None,
                          client_solve_log: List[dict] = None,
                          payroll_cells: List[dict] = None):
    """WP3v2 條件2：月結報表重寫。

    1. 更數由 `shift_records`（`record_type=shift`、`is_external=False`、
       `out_of_scope=False`、`billing_group=per_shift`）數，唔用 priced_rows
       嘅原始行數——priced_rows 本身冚晒 external/out_of_scope/monthly_ic
       都係一行，如果照計就會將呢啲唔應該落 per_shift 更數嘅記錄都計咗
       （monthly_ic 另用 `monthly_ic_shifts` 獨立列）。
    2. `static_site_revenue` key 到 `(site_id, shift_type_id)`，唔准 site
       級覆蓋——舊 bug：啟航1331 Event（special，shift_type_id=ST0026）嘅
       靜態值一覆蓋成個 site_id，會炒晒普通1331更次嘅per-shift revenue，
       令個site淨顯示Event嗰嚿細數（11,700）。而家 site 級（`shift_type_id`
       留空）嘅靜態卡先覆蓋成個site；有shift_type_id嘅靜態卡淨係覆蓋嗰個
       shift_type 自己嘅revenue，其他shift_type照computed嗰邊嚟。
    3. 成本欄：如果呢個site嘅priced_rows入面有長工autopay（`pricing_note`
       帶住 `_AUTOPAY_MARKER`）嘅記錄，標「不完整：長工月薪未分攤」，
       盈利率唔印（"n/a"）。
    4. Sub-Total 行；LINK C7（`client_group==LINK C7`）／Excellent
       客戶（代號見 data/mappings-private/client-names.json）去「月結以外」sheet。
    5. `payroll_cells`（out/wp2a payroll-cells*.csv 逐格轉錄）：用嚟由
       cell_kind=monthly_fee_day 逐site動態數出「月費制人幾多日唔計更」
       （S031控制室/S034 M+ 呢個口徑差異嘅N，唔准寫死喺呢個file，見下面
       `monthly_fee_day_count`）。
    """
    from .normalize import SiteIndex
    site_index = SiteIndex(list(sites_by_id.values()))
    shift_type_billing_group = shift_type_billing_group or {}
    billing_units = billing_units or {}

    r2_rows = wp3_r2.parse_r2_rows(paths.SETTLEMENT_PDF_2026_07)

    # 修正 B6/條件1：M+、控制室嘅月費制人（§3.7a口徑），成個
    # 月唔逐日計更，但R2月結PDF入面呢兩個site係當「有更就計」（22/25日都
    # 印咗做shifts），先致造成shift_records（唔計月費制人）同R2（計晒）之
    # 間嘅「缺口」——呢個唔係WP1/WP2b漏格，係口徑差異，唔應該再標
    # needs_review。N（幾多日）由payroll-cells.csv（out/wp2a逐格轉錄，
    # cell_kind=monthly_fee_day）逐site動態數出嚟，唔寫死喺呢個file，
    # WP2a轉錄有更新呢個N會自動跟住變。
    monthly_fee_day_count: Dict[str, int] = defaultdict(int)
    monthly_fee_day_guard: Dict[str, str] = {}
    for pc in (payroll_cells or []):
        if pc.get("cell_kind") != "monthly_fee_day":
            continue
        sid = site_index.resolve(pc.get("site_label") or "")
        if not sid:
            continue
        monthly_fee_day_count[sid] += 1
        if pc.get("guard_name"):
            monthly_fee_day_guard[sid] = pc["guard_name"]

    # (2) static_site_revenue key 到 (site_id, shift_type_id)；shift_type_id
    # 留空（""）代表「成個site級」嘅靜態卡（月費/行政費），唔留空代表淨係
    # 覆蓋嗰個shift_type（例如啟航1331 Event=ST0026）。
    static_revenue: Dict[Tuple[str, str], Decimal] = {}
    for rc in (rate_cards or []):
        if rc["billing_model"] in ("monthly_fixed", "admin_fee", "special") and rc["status"] == "solved" and rc["client_rate"]:
            key = (rc["site_id"], rc.get("shift_type_id") or "")
            static_revenue[key] = static_revenue.get(key, Decimal("0")) + _d(rc["client_rate"])

    # base_shifts/base_revenue：淨計「呢個site自己嘅shift_records」（唔包
    # billing_units.csv 嘅extra_shifts_from_monthly，例如HKU Y更獨立雞頭費
    # 94更）。R2月結入面呢類extra係獨立一行（「獨立雞頭費」），同site本身
    # 嘅主行（「HKU」170更）分開印，如果攞embedded咗extra嘅shifts/revenue
    # 去同R2主行比對，會屈出一個假嘅164差異（264 vs 170）。所以：
    # - agg["shifts"]/["revenue"]＝含extra，俾「月結對照(R2口徑)」sheet同
    #   P&L顯示用（呢個sheet本身冇分開印獨立雞頭費，要見到全數）；
    # - agg["base_shifts"]/["base_revenue"]＝唔含extra，俾下面 diff_rows
    #   同R2逐行比對用（先啱啱好對應R2嘅拆行方式）。
    # unpriced_shifts：呢個site有幾多條in-scope shift_records因為WP3 rate
    # 未反推完（例如啟航1331 P1/P2待老闆答）而入咗unpriced.csv，攞唔到
    # revenue，但個「更數」本身係真嘅（WP1/WP2b已經有呢條record），計落
    # base_shifts/shifts先唔會低估更數（舊版淨計priced_rows，會將呢啲
    # 記錄嘅更數當冇咗，令診斷差異表睇落大好多）。
    agg = defaultdict(lambda: {
        "shifts": 0, "monthly_ic_shifts": 0, "revenue": Decimal("0"), "cost": Decimal("0"),
        "client_rates": Counter(), "wage_rates": Counter(), "has_autopay_gap": False,
        "base_shifts": 0, "base_revenue": Decimal("0"), "unpriced_shifts": 0,
    })
    site_level_static = {sid for (sid, st) in static_revenue if st == ""}

    for r in priced_rows:
        if r["record_type"] != "shift":
            continue
        site_id = r["site_id"]
        shift_type_id = r["shift_type_id"]
        is_external = r.get("is_external") == "True"
        out_of_scope = r.get("out_of_scope") == "True"
        a = agg[site_id]
        billing_group = shift_type_billing_group.get(shift_type_id, "per_shift")

        if not is_external and not out_of_scope and billing_group == "monthly_ic":
            a["monthly_ic_shifts"] += 1
            continue
        if is_external or out_of_scope:
            continue  # customer own staff / LINK C7 out_of_scope：唔計入per_shift更數
        a["shifts"] += 1
        a["base_shifts"] += 1

        st_key = (site_id, shift_type_id)
        if site_id not in site_level_static and st_key not in static_revenue and r["client_rate_snapshot"]:
            rate_val = _d(r["client_rate_snapshot"])
            a["revenue"] += rate_val
            a["base_revenue"] += rate_val
            a["client_rates"][rate_val] += 1
        if r["guard_wage_snapshot"]:
            wage_val = _d(r["guard_wage_snapshot"])
            a["cost"] += wage_val
            a["wage_rates"][wage_val] += 1
        if r["broker_fee_snapshot"]:
            a["cost"] += _d(r["broker_fee_snapshot"])
        if _AUTOPAY_MARKER in (r.get("pricing_note") or ""):
            a["has_autopay_gap"] = True

    # unpriced_rows：搵唔到rate card嘅in-scope shift_records（wp3_pricing.py
    # 篩走咗，冇入priced_rows），更數本身係真嘅，計落shifts/base_shifts
    # （唔加revenue——冇rate card，revenue根本未知）。
    for r in (unpriced_rows or []):
        site_id = r.get("site_id")
        if not site_id:
            continue
        a = agg[site_id]
        a["shifts"] += 1
        a["base_shifts"] += 1
        a["unpriced_shifts"] += 1

    # 加返 billing_units.csv 嘅「額外更次」（例如HKU Y更獨立雞頭費94更）—
    # 冇對應真實shift_record，但收客價一樣、要計落個site嘅更數/營業額
    # （只加agg["shifts"]/["revenue"]畀「月結對照」sheet顯示全數，唔加
    # base_shifts/base_revenue——嗰兩個要同R2「HKU」主行逐行對，唔可以
    # 埋咗R2自己會拆開印嘅「獨立雞頭費」行）。
    for site_id, meta in billing_units.items():
        extra = meta.get("extra_shifts_from_monthly") or 0
        if not extra:
            continue
        a = agg[site_id]
        if site_id in site_level_static or (site_id, "") in static_revenue:
            continue
        # 用呢個site已知嘅client_rate（如果Σclient_rates只有一個值）幫額外
        # 更次計返revenue，冇單一已知值就唔計（避免屈一個唔啱嘅rate）。
        if len(a["client_rates"]) == 1:
            only_rate = next(iter(a["client_rates"]))
            a["shifts"] += extra
            a["revenue"] += only_rate * extra
            a["client_rates"][only_rate] += extra

    # site 級靜態卡（月費/行政費）：直接覆蓋成個site嘅revenue（唔理per-shift
    # 部分計到幾多，一律用靜態值），對應（2）嘅「shift_type_id留空」情況。
    # 呢啲靜態值（月費/行政費/special）R2自己冇拆開印做副行（唔似獨立雞頭
    # 費咁），所以base_revenue（同R2主行逐行比對用）要同步埋，唔淨係
    # 「畀月結對照sheet顯示」嘅revenue。
    # 修正 A2：純粹畀「月結對照」sheet顯示用嘅remark提示——記低邊啲site嘅
    # revenue係「淨係一個shift_type級special/靜態卡嘅細部分，唔代表全盤」
    # （例如啟航1331淨係Event 11,700入咗賬，其餘1,122更收客價仲pending）。
    # 唔改agg["revenue"]/["base_revenue"]本身嘅數值（gate/R2 diff核心邏輯
    # 唔郁），淨係喺下面砌 remark 欄嗰陣攞嚟用。
    shift_type_static_notes: Dict[str, List[str]] = defaultdict(list)
    for (site_id, st), rev in static_revenue.items():
        if st == "":
            agg[site_id]["revenue"] = rev
            agg[site_id]["base_revenue"] = rev
        else:
            # shift_type級靜態卡：只加返嗰個shift_type應有嘅份額（假設之前
            # per-shift累加冇計呢個shift_type——因為client_rc lookup response
            # 喺pricing.py already唔會幫special/monthly_fixed嘅shift_type
            # stamp snapshot，所以呢度純粹係「加返」，唔會double count）。
            agg[site_id]["revenue"] += rev
            agg[site_id]["base_revenue"] += rev
            if agg[site_id]["unpriced_shifts"]:
                shift_type_static_notes[site_id].append(f"{st}特殊收入項{rev}已入賬")

    def _rate_display(counter: Counter) -> str:
        if not counter:
            return ""
        if len(counter) == 1:
            return str(next(iter(counter)))
        lo, hi = min(counter), max(counter)
        total_n = sum(counter.values())
        weighted = sum(r * n for r, n in counter.items()) / total_n
        return f"{lo}–{hi} (平均{weighted.quantize(Decimal('0.01'))})"

    link_c7_sites = {sid for sid, s in sites_by_id.items() if s.get("client_group") == "LINK C7"}
    excellent_dus_sites = {sid for sid, s in sites_by_id.items()
                            if s.get("client_name") in (_CLIENT_EXCELLENT_PROPERTY, _CLIENT_DUSSERVICE)}
    # 修正 B6：個別雞頭 special income（S064，Tenti/HKW/個別雞頭月薪，見§2 B4）
    # 冇任何shift_records（人手特殊收入項，唔逐更計），同龍譽/惠康之前
    # 一樣屬於「月結以外」性質，唔應該撞入主sheet嘅per_shift更數比對。
    individual_broker_special_sites = {sid for sid, s in sites_by_id.items()
                            if s.get("client_group") == "P special income"}
    off_ledger_sites = link_c7_sites | excellent_dus_sites | individual_broker_special_sites

    # diff：逐 R2 行（`wp3_r2.parse_r2_rows`，取代舊嘅單行regex parser——舊
    # parser 唔識 Excel merge cell 跨行嘅收客價/出街價，數碼港/國泰城呢類
    # 多價site會解錯）vs regenerated（用base_shifts/base_revenue，唔含
    # billing_units extra——見上面agg嗰段註解）。每條差異加`reason`／
    # `category`兩欄：套用P0-執行計劃§4/§8已知嘅更表vs月結R2細差
    # （`wp3_rates.KNOWN_SHIFT_COUNT_DIFFS`）同§3.7「月結有更表冇、冇逐日
    # 來源」嘅site清單，有得解釋嘅category=known，冇嘅先至係needs_review
    # （WP3c唔解釋，淨係分類；真正解釋係WP4）。
    #
    # 「數碼港」「城巴車廠」兩個R2 label自己係幾個site合埋一齊印嘅總數
    # （數碼港=CP5+CP1-4+數據中心+CP5 IC；城巴車廠=8個廠嘅depot合計，
    # 唔含創富IC行政費，S018-S025獨立重算517同R2/§4全中，差返嘅30蚊
    # 係§3.8西九龍已知嘅疑似津貼殘差），逐個sub-site已經有自己嘅
    # shifts_diff/revenue_diff，呢個合計行淨係跳過，唔再重複/誤導噉再
    # 比一次。
    AMBIGUOUS_AGGREGATE_R2_LABELS = {"數碼港", "城巴車廠"}

    # 「獨立雞頭費」係R2自己拆出嚟嘅副行（HKU Y更94更雞頭費，已經計落
    # billing_units.csv嘅extra_shifts_from_monthly，摺埋咗入S006嘅
    # agg["shifts"]/["revenue"]），唔係一個獨立site，配對去嗰個site做
    # 「已解釋」，唔算unmapped_label／needs_review。
    EXTRA_LABEL_TO_SITE = {"獨立雞頭費": "S006"}

    # 「啟航1331Event」都係R2副行（ST0026 Event shift_type，已經摺埋入
    # S017嘅base_revenue，見上面static_revenue shift_type級覆蓋），但同
    # 「獨立雞頭費」唔同嘅係數值本身唔啱好對得晒——更表Event只見4更、R2
    # 印14更（P0-執行計劃§4「Event更表只見4」），呢個細差已經記喺S017主行
    # 嘅KNOWN_DIFF_REASONS，唔喺呢度重複再屈一個假嘅"regen"數比對，淨係
    # 帶埋原因標記做「known」。
    EVENT_SUBLINE_LABELS = {"啟航1331Event": ("S017", "S017「啟航1331」主行reason（Event更別更表4 vs R2 14，P0-執行計劃§4已知），"
                                            "呢個R2副行本身已摺埋入S017 base_revenue（shift_type級special rate_card）")}

    # 修正 B6：Tenti／HKW（S064，sites.csv client_group=個別雞頭 special
    # income）之前跌落generic needs_review（Tenti連site_id都resolve唔到，
    # HKW resolve到但S064冇任何shift_records，agg fallback做0，同R2金額
    # 唔啱）。呢兩個R2 label其實同龍譽/惠康補單一樣，已經係P0-執行計劃
    # §2 B4裁定嘅「特殊收入項，人手入」——rate_cards.csv RC0149-152已經
    # 用billing_model=special/status=solved記低（個別雞頭薪金/Tenti/HKW
    # 佣金），唔應該再喺月結diff度顯示做needs_review，直接標known。
    SPECIAL_INCOME_R2_LABELS = {
        "TentiWealthBodyGuard": ("S064", "特殊收入項（P0-執行計劃§2 B4，個別雞頭月薪/Event佣金，人手入，"
                                          "見rate_cards.csv RC0149-152），唔逐更計、唔入per_shift更數比對，另列「月結以外」"),
        "HKW": ("S064", "特殊收入項（P0-執行計劃§2 B4，個別雞頭月薪/Event佣金，人手入，"
                         "見rate_cards.csv RC0149-152），唔逐更計、唔入per_shift更數比對，另列「月結以外」"),
    }

    # P0-執行計劃§4 已知嘅更表 vs 月結R2 細差：呢度純粹提供人手可讀嘅
    # 解釋文字，數值容忍度本身跟 wp3_rates.KNOWN_SHIFT_COUNT_DIFFS（單一
    # 事實來源），呢個dict唔准偏離嗰邊嘅site集合。
    KNOWN_DIFF_REASONS = {
        "S010": "數碼港CP1-4：P0-執行計劃§4已知差{gap}更（更表234 vs R2/發票230）",
        "S017": "啟航1331：P0-執行計劃§4已知差1更（更表1,122 vs R2 1,123，Event另計4 vs R2 14）；"
                "另外7個更別嘅收客價/K出街價大部分未反推完（§8 P1/P2待老闆答），"
                "令好多shift_records仍pending喺unpriced.csv、未有revenue",
        "S007": "HKU座頭：P0-執行計劃§4已知差3更（更表201 vs 199，OT1另計6格）",
        "S009": "凱和山：P0-執行計劃§4已知差2更（更表73 vs R2 71）",
        "S029": "淺水灣11號：P0-執行計劃§4已知差2更（更表88 vs R2 90）",
        "S027": "屯門小欖：P0-執行計劃§4已知差1更（更表62 vs R2 63）",
        "S005": "皓日：P0-執行計劃§4已知差1更（更表17 vs R2/發票16）",
        "S015": "Weave Robinson：P0-執行計劃§4已知差1更（更表32 vs R2/發票33）",
        "S004": "Weave OL：P0-執行計劃§4已知差6更（更表31 vs R2/發票25）",
        "S002": "IFC：P0-執行計劃§4已知差1更（更表40 vs R2 41，月費制，唔影響收入）",
        "S006": "HKU Y更：P0-執行計劃§4已知差4更（更表166 vs R2 170；獨立雞頭費94更"
                "另計，見billing_units.csv／R2「獨立雞頭費」行）",
        "S008": "HKU醫學院：WP2b裁定site_label override（G頁）後shift_records 4 vs 真實5更，交WP4",
        "S033": "都會大學學生宿舍：shift_records 17 vs R2 18，交WP4",
        "S016": "九龍企業大廈：發票51,205.65點計未解到，rate_cards RC0167 status=pending"
                "（P0-執行計劃§8 P4待老闆答；62更本身數對得中，只係價拆唔到）",
    }
    # 修正 B6（本次細任務再修正）：控制室（S031）／M+（S034）之前一併標
    # needs_review，但覆核發現呢兩個site嘅「缺口」根本唔係WP1/WP2b漏格
    # ——控制室／M+嘅月費制人（payroll-cells.csv cell_kind=
    # monthly_fee_day，§3.7a口徑：月費制唔逐日計更），但R2月結PDF入面照樣
    # 逐日當更計，先致造成shift_records（唔計月費制人）同R2（計晒）之間
    # 嘅「缺口」——呢個係口徑差異，唔係資料流缺口，改分類做known，reason
    # 動態帶住N（由上面`monthly_fee_day_count`，逐site數payroll-cells.csv
    # cell_kind=monthly_fee_day出嚟，唔寫死）。
    # 創富廠IC（S026）24 vs 22 差2就冇呢類月費制cell支持——覆核
    # payroll-cells.csv冇見到呢個site有monthly_fee_day記錄，係真差，維持
    # needs_review交WP4覆核，冇跟埋一齊reclassify。
    # 注意：呢度淨係改wp3_reports.py呢個報表分類（顯示/audit用），冇改
    # wp3_rates.KNOWN_SHIFT_COUNT_DIFFS／apply_client_rate_gate 嘅Gate
    # 容忍度（S031嘅RC0168 Gate PASS依賴住嗰個22更容忍度）——WP3任務
    # 「價目核心（gate...）已驗實，唔好動」係更高優先級嘅硬約束，所以呢個
    # reclassify刻意止步於報表顯示層，冇連動downgrade rate_card嘅solved
    # 狀態。
    CALIBRE_DIFF_SITES = {"S031", "S034"}

    DATA_FLOW_GAP_SITES = {
        "S026": "創富廠IC：shift_records 22 vs R2 24，缺口2更；月費/行政費率已由R2月結證實，"
                "但呢個缺口係WP1/WP2b資料流缺口，交WP4覆核",
    }
    # §3.7：月結有、更表冇、冇任何逐日來源嘅盤（P0淨係入月結總數，唔要求
    # 逐更對數）——同上面KNOWN_DIFF_REASONS嗰啲「有更表但更數對唔晒」性質
    # 唔同，呢啲係「根本冇更表」。
    NO_ROSTER_SOURCE_SITES = {
        "S038": "國泰城", "S039": "卓弘", "S040": "嘉捷", "S041": "ICBCTower",
        "S042": "哈羅國際學校", "S032": "都會大學夜巡邏",
    }

    def _classify(site_id: str, gap) -> Tuple[str, str]:
        """Return (category, reason)。"""
        if site_id in CALIBRE_DIFF_SITES:
            n = monthly_fee_day_count.get(site_id, 0)
            guard = monthly_fee_day_guard.get(site_id, "")
            canonical = sites_by_id.get(site_id, {}).get("canonical_name", site_id)
            who = f"{guard}@{canonical}" if guard else canonical
            return ("known", f"口徑差異：月費制人（{who}）{n}日不計更"
                              f"（§3.7a monthly_fee_day口徑：R2月結逐日當更計，但shift_records/"
                              f"policy_total_shifts唔計；N由payroll-cells.csv cell_kind="
                              f"monthly_fee_day逐site數出，唔寫死）")
        if site_id in DATA_FLOW_GAP_SITES:
            return ("needs_review", f"資料流缺口，交WP4：{DATA_FLOW_GAP_SITES[site_id]}")
        if site_id in NO_ROSTER_SOURCE_SITES:
            return ("known", f"P0-執行計劃§3.7：{NO_ROSTER_SOURCE_SITES[site_id]}月結有、更表冇，"
                              f"冇任何逐日來源，P0只入月結總數，唔要求逐更對數")
        if site_id in KNOWN_DIFF_REASONS:
            return ("known", KNOWN_DIFF_REASONS[site_id].format(gap=gap))
        return ("needs_review", "")

    diff_rows = []
    # 條件2：main sheet「備註」欄要接上呢度_classify()嘅reason（任何
    # shifts_diff／revenue_diff非零嘅行）。呢個dict喺呢度順便儲低，畀下面
    # 起main sheet ws嗰段用（唔重複再計一次_classify）。
    reasons_by_site: Dict[str, List[str]] = defaultdict(list)
    for sr_row in r2_rows:
        label = sr_row.label
        if label in AMBIGUOUS_AGGREGATE_R2_LABELS:
            continue
        if label in EXTRA_LABEL_TO_SITE:
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": EXTRA_LABEL_TO_SITE[label],
                "r2_shifts": sr_row.shifts, "regen_shifts": sr_row.shifts,
                "r2_revenue": str(sr_row.revenue or ""), "regen_revenue": str(sr_row.revenue or ""),
                "note": "explained_extra_line",
                "category": "known",
                "reason": f"R2副行，已摺埋入{EXTRA_LABEL_TO_SITE[label]}嘅billing_units.csv extra_shifts_from_monthly，唔係獨立site",
            })
            continue
        if label in EVENT_SUBLINE_LABELS:
            site_id_here, reason_here = EVENT_SUBLINE_LABELS[label]
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": site_id_here,
                "r2_shifts": sr_row.shifts, "regen_shifts": "",
                "r2_revenue": str(sr_row.revenue or ""), "regen_revenue": "",
                "note": "explained_subline_no_exact_match",
                "category": "known",
                "reason": reason_here,
            })
            continue
        if label in SPECIAL_INCOME_R2_LABELS:
            if sr_row.shifts is None and sr_row.revenue is None:
                continue  # PDF解析殘留嘅空續行（同label出現兩次），唔重複記
            site_id_here, reason_here = SPECIAL_INCOME_R2_LABELS[label]
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": site_id_here,
                "r2_shifts": sr_row.shifts, "regen_shifts": "",
                "r2_revenue": str(sr_row.revenue or ""), "regen_revenue": "",
                "note": "special_income_manual_entry",
                "category": "known",
                "reason": reason_here,
            })
            continue
        if sr_row.shifts is None and sr_row.revenue is None:
            continue  # PDF解析出嚟嘅空/殘留行，冇任何數值好比對
        site_id = invoice_aliases.get(label) or site_index.resolve(label)
        if not site_id:
            category, reason = "needs_review", ""
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": "",
                "r2_shifts": sr_row.shifts, "regen_shifts": "",
                "r2_revenue": str(sr_row.revenue or ""), "regen_revenue": "",
                "note": "unmapped_label", "category": category, "reason": reason,
            })
            continue
        a = agg.get(site_id, {"shifts": 0, "revenue": Decimal("0"), "cost": Decimal("0"),
                               "base_shifts": 0, "base_revenue": Decimal("0")})
        regen_shifts = a.get("base_shifts", a["shifts"])
        regen_revenue = a.get("base_revenue", a["revenue"])
        if sr_row.shifts is not None and sr_row.shifts != regen_shifts:
            gap = abs(regen_shifts - sr_row.shifts)
            category, reason = _classify(site_id, gap)
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": site_id,
                "r2_shifts": sr_row.shifts, "regen_shifts": regen_shifts,
                "r2_revenue": "", "regen_revenue": "", "note": "shifts_diff",
                "category": category, "reason": reason,
            })
            if reason and reason not in reasons_by_site[site_id]:
                reasons_by_site[site_id].append(reason)
        if sr_row.revenue is not None and sr_row.revenue != regen_revenue:
            gap = abs(regen_shifts - sr_row.shifts) if sr_row.shifts is not None else 0
            category, reason = _classify(site_id, gap)
            diff_rows.append({
                "row_no": sr_row.row_no, "label": label, "site_id": site_id,
                "r2_shifts": "", "regen_shifts": "",
                "r2_revenue": str(sr_row.revenue), "regen_revenue": str(regen_revenue),
                "note": "revenue_diff", "category": category, "reason": reason,
            })
            if reason and reason not in reasons_by_site[site_id]:
                reasons_by_site[site_id].append(reason)

    def _revenue_display(revenue: Decimal, pending: bool) -> str:
        """條件3／修正A5共用嘅「留空唔印假0」判斷：pending=True代表呢個
        site有其他活動信號（更次/成本）但client_rate仲未反推完（§8），
        留空好過印一個會被人誤讀做「已經核實嘅零生意」嘅假「0」。主sheet
        （用cost做信號）同「月結以外」sheet（用shifts做信號）本來各自維
        護一份幾乎一樣但唔同步嘅留空邏輯，抽出嚟做一個共用function。"""
        return "" if pending and not revenue else str(revenue)

    wb = Workbook()
    ws = wb.active
    ws.title = "月結對照(R2口徑)"
    ws.append(["工作地點", "site_id", "更數", "收客價", "出街價", "營業額", "成本", "盈利", "%", "備註"])
    ws2 = wb.create_sheet("月結以外")
    ws2.append(["工作地點", "site_id", "更數", "營業額", "成本", "盈利", "備註"])

    sub_total = {"shifts": 0, "revenue": Decimal("0"), "cost": Decimal("0")}
    off_ledger_sites_in_agg = set()
    for site_id, a in sorted(agg.items()):
        site = sites_by_id.get(site_id, {})
        profit = a["revenue"] - a["cost"]
        if site_id in off_ledger_sites:
            off_ledger_sites_in_agg.add(site_id)
            if site_id in link_c7_sites:
                note = "LINK C7"
            elif site_id in individual_broker_special_sites:
                note = "特殊收入項（P0-執行計劃§2 B4，個別雞頭月薪/Event佣金，人手入）"
            else:
                note = site.get("client_name", "")
            # 修正 A5：呢個site（例如恆星樓 S036）雖然有shift_records嘅逐日
            # 更次（T頁反推），但收客價仲pending（§8 P5未答）。留空
            # 唔印0——單printClient_name會令人以為「冇嘢要跟進」，補一句
            # 話明係pending，唔係「已經對數完」；營業額/盈利都要跟住留空
            # （用返同主sheet一致嘅`_revenue_display`共用function，唔可以
            # 印一個靠revenue=0推出嚟嘅假盈利）。
            revenue_pending = bool(a["shifts"]) and not a["revenue"]
            revenue_display = _revenue_display(a["revenue"], bool(a["shifts"]))
            if revenue_pending:
                note = (note + "；" if note else "") + "收客價待老闆補價（§8 P5）"
            profit_display = "" if revenue_pending else str(profit)
            ws2.append([site.get("canonical_name", site_id), site_id, a["shifts"],
                        _try_num(revenue_display), _try_num(str(a["cost"])), _try_num(profit_display), note])
            continue
        remark_parts = []
        # 修正 A2：呢個site嘅revenue淨係嚟自一張shift_type級special/靜態卡
        # （例如啟航1331 Event 11,700），其餘更次收客價未反推完——唔可以
        # 畀「營業額」欄嗰個數當做全盤已對數，留空+備註話明真實狀態。
        if site_id in shift_type_static_notes:
            remark_parts.extend(shift_type_static_notes[site_id])
            remark_parts.append(f"其餘{a['unpriced_shifts']}更收客價待老闆補價（§8）")
            revenue_display = ""
        elif not a["revenue"] and a["cost"]:
            # 更數/成本都有真數，但client_rate全部pending——收客價欄留空,
            # 唔印「0」（會令人以為真係0蚊生意）。用返同「月結以外」sheet
            # 共用嘅`_revenue_display`（條件3：留空邏輯兩個sheet一致）。
            revenue_display = _revenue_display(a["revenue"], True)
            remark_parts.append("收客價待老闆補價（§8 P1／P4／P5）")
        else:
            revenue_display = str(a["revenue"])
        if a["has_autopay_gap"]:
            # 細建議6：成本欄要係數值型先可以sum——「不完整：長工月薪未
            # 分攤」呢句解釋文字搬晒去備註，成本欄淨留返數值本身。
            cost_display = str(a["cost"])
            pct = "n/a"
            remark_parts.append("成本不完整：長工月薪未分攤")
        elif a["cost"] == 0 and a["revenue"]:
            # 修正 A2：monthly_fixed/admin_fee/special呢類靜態卡冇對應
            # guard_wage/broker_fee來源（CP5 IC、M+、夜巡邏、龍譽、惠康…），
            # 成本欄印«0»會令人以為真係零成本、100%盈利——實情係成本資料
            # 根本冇追蹤，要明確標「成本不完整」，%唔可以印一個假嘅100%。
            cost_display = str(a["cost"])
            pct = "n/a"
            remark_parts.append("成本不完整")
        elif revenue_display == "":
            # revenue_display已經因為上面兩種情況留空（收客價/部分special
            # 收入項pending），呢個%再印一個「盈利÷未知revenue」嘅百分比
            # 冇意義，一律n/a。
            cost_display = str(a["cost"])
            pct = "n/a"
        else:
            cost_display = str(a["cost"])
            pct = f"{(profit/a['revenue']*100):.1f}%" if a["revenue"] else ""
        shifts_display = a["shifts"]
        if a["monthly_ic_shifts"]:
            shifts_display = f"{a['shifts']}（另 monthly_ic {a['monthly_ic_shifts']}更）"
        # 條件2：呢個site如果喺monthly-diff.csv有shifts_diff／revenue_diff
        # （上面`reasons_by_site`，逐行由`_classify()`嘅reason儲低），備註
        # 要接得返嗰個reason（唔理category係known定needs_review，只要
        # reason非空）——等睇緊呢張報表嘅人唔使開多個monthly-diff.csv先知
        # 點解呢行同R2對唔晒。
        for _reason in reasons_by_site.get(site_id, []):
            if _reason not in remark_parts:
                remark_parts.append(_reason)
        ws.append([site.get("canonical_name", site_id), site_id, shifts_display,
                   _try_num(_rate_display(a["client_rates"])), _try_num(_rate_display(a["wage_rates"])),
                   _try_num(revenue_display), _try_num(cost_display), _try_num(str(profit)), pct,
                   "；".join(remark_parts)])
        sub_total["shifts"] += a["shifts"]
        sub_total["revenue"] += a["revenue"]
        sub_total["cost"] += a["cost"]
    sub_profit = sub_total["revenue"] - sub_total["cost"]
    sub_pct = f"{(sub_profit/sub_total['revenue']*100):.1f}%" if sub_total["revenue"] else ""
    ws.append(["Sub-Total", "", sub_total["shifts"], "", "", _try_num(str(sub_total["revenue"])),
               _try_num(str(sub_total["cost"])), _try_num(str(sub_profit)), sub_pct, ""])

    # 細建議5：啟航1331 Event（ST0026特殊shift_type級靜態卡）嘅11,700已經
    # 摺埋入上面S017主行嘅a["revenue"]，即係Sub-Total嘅營業額總數實際包
    # 埋呢筆錢——但S017主行自己個「營業額」格因為其餘1,058更收客價未反推
    # 完刻意留空（修正A2），會令人睇Sub-Total對唔返晒可見欄嘅總和，以為
    # 個total多咗一嚿嚟歷不明嘅錢。呢度加一行明確話俾人知呢筆錢喺邊
    # （R2自己都係拆開一行印，見monthly-diff.csv label="啟航1331Event"），
    # 唔使人手心算/估。
    event_revenue = static_revenue.get(("S017", "ST0026"))
    if event_revenue:
        ws.append(["其中：啟航1331 Event 特殊收入", "", "", "", "",
                   _try_num(str(event_revenue)), "", "", "",
                   "已計入Sub-Total營業額；S017「啟航1331」主行自己個營業額格留空"
                   "（其餘更次收客價未反推完，見該行備註），呢行純粹畀Sub-Total對數用"])

    # 修正 A5：SOGO CWB／Garden East 客戶（代號見 client-names.json）完全冇 shift_records（冇
    # 逐日更次來源，T頁淨係有恆星樓／葵發），所以連 agg dict 都未必
    # 建到呢兩個key，之前直接跌漏晒——單純有張invoice-derived嘅pending
    # rate_card（見invoice_site_aliases.csv）唔會令佢入到agg。呢度由
    # client_solve_log（每張發票逐行解值嘅log，喺S045/S046都會有
    # status=pending(no_shift_source)嘅記錄）補返呢兩行，營業額用發票
    # 金額（唯一已知數），成本/更數留空／0（冇來源）。
    for log_row in (client_solve_log or []):
        site_id = log_row.get("site_id")
        if not site_id or site_id in off_ledger_sites_in_agg:
            continue
        site = sites_by_id.get(site_id, {})
        if site.get("client_name") != _CLIENT_DUSSERVICE:
            continue
        if log_row.get("status") != "pending(no_shift_source)":
            continue
        amount = log_row.get("amount") or "0"
        ws2.append([site.get("canonical_name", site_id), site_id, 0, _try_num(amount), 0, "",
                    f"{_CLIENT_DUSSERVICE}；發票{log_row.get('invoice_no','')}金額{amount}但冇逐日shift來源"
                    "（P0只記發票總數，見P0-執行計劃§3.7／§3.8），唔入per_shift更數"])
        off_ledger_sites_in_agg.add(site_id)

    # 細建議4（本次細任務修正）：個別雞頭 special income（S064）都係完全冇
    # shift_records，佢嘅rate_cards（RC0150-153，個別雞頭月薪/Tenti佣金/HKW
    # 佣金/HKW對接人月薪）唔係經build_client_rate_cards/
    # client_solve_log嗰條路生成（嗰個係wp3_run.py獨立一段直接由
    # payroll-rows.csv讀，見§2 B4），所以上面client_solve_log嗰個補丁搵
    # 佢哋唔到——呢度直接讀rate_cards.csv逐張special卡。
    #
    # 以前將4張卡全部加埋做「營業額」一嚿數（個別雞頭月薪20,000＋Tenti佣
    # 2,872＋HKW佣5,116＋HKW對接人月薪3,030=31,018），將個別雞頭／HKW對接人
    # 兩個人嘅人工都屈成「盤數」——但2026-07-月結總表-FinalR2.pdf
    # 入面個別雞頭月薪／HKW對接人月薪本身屬於PDF下半部「薪金」段（同
    # Tenti/HKW commission嗰種「業務單位」性質唔同，冇對應R2收入），唔應
    # 該計落呢個表嘅營業額/成本。
    #
    # 改法：淨係Tenti／HKW兩張commission卡（RC0151/RC0152，note帶
    # 「commission」）先至入盤，分兩行；營業額用R2月結PDF實際嘅Tenti/HKW
    # 收入（`r2_special_revenue`，由上面`r2_rows`動態攞，唔寫死），成本
    # 用對應嗰張commission卡嘅guard_wage（個別雞頭收嘅佣金）。個別雞頭本人月薪
    # (RC0150)／HKW對接人月薪(RC0153)呢兩張「Salary」卡唔再印落
    # 呢個表。
    r2_special_revenue: Dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for r in r2_rows:
        if r.label in ("TentiWealthBodyGuard", "HKW") and r.revenue is not None:
            r2_special_revenue[r.label] += r.revenue

    for site_id in sorted(individual_broker_special_sites - off_ledger_sites_in_agg):
        commission_cards = [rc for rc in (rate_cards or [])
                             if rc["site_id"] == site_id and rc["billing_model"] == "special"
                             and rc["status"] == "solved" and rc["guard_wage"]
                             and "commission" in (rc.get("note") or "")]
        if not commission_cards:
            continue
        tenti_cost = sum((_d(rc["guard_wage"]) for rc in commission_cards
                           if "Tenti" in (rc.get("evidence") or "")), Decimal("0"))
        hkw_cost = sum((_d(rc["guard_wage"]) for rc in commission_cards
                         if "Tenti" not in (rc.get("evidence") or "")), Decimal("0"))
        for row_label, r2_label, cost in (
            ("Tenti", "TentiWealthBodyGuard", tenti_cost),
            ("HKW", "HKW", hkw_cost),
        ):
            if not cost:
                continue
            revenue = r2_special_revenue.get(r2_label, Decimal("0"))
            profit = revenue - cost
            ws2.append([row_label, site_id, 0, _try_num(str(revenue)), _try_num(str(cost)),
                        _try_num(str(profit)), "特殊收入項，§2 B4 人手入"])
        off_ledger_sites_in_agg.add(site_id)

    _save_stable(wb, out_dir / "月結總表-regenerated.xlsx")

    settle_rows = [{"row_no": r.row_no, "label": r.label, "shifts": r.shifts,
                     "revenue": r.revenue, "cost": r.cost, "profit": None} for r in r2_rows]
    return diff_rows, settle_rows
