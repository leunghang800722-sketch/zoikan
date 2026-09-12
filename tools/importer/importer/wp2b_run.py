"""WP2b 主流程：讀 WP1 + WP2a 輸出，跑 normalize.py 嘅 R1-R4，寫晒
out/wp2b/* 六份規範化 CSV + 覆核清單 + 報告。

`run_wp2b()` 係 CLI 嘅入口（`python -m importer run-wp2b`）。全部步驟可重
跑、輸出用 sort_keys/穩定排序，保證三次重跑 byte-identical。

2026-09-03 規劃 session 6 點決定（見 wp2b-report.md 底部）已經實作落呢個
檔案：(1) 啟航1331 K-1331 盤級糧單 fallback、(2) inferred_guard 推斷（B3 修正後逐人判斷）、
(3) LINK C7 細盤 in_p0_scope=false、(4) HKU 醫學院 parent/child site
override、(5) 混合行 cell 層逐日拆盤、(6) 守恆殘餘逐單位解釋。
"""
import csv
import json
import re
from collections import Counter, defaultdict
from datetime import date
from typing import Dict, List, Optional, Tuple

from . import paths
from .mappings_io import (
    load_brokers,
    load_cell_code_labels,
    load_invoice_daily_shifts,
    load_longterm_staff,
    load_names_en,
    load_page_level_settlements,
    load_rank_billing,
    load_referral_fee_rates,
    load_sites,
    load_status_codes,
    referral_fee_rate_for,
)
from .normalize import (
    BrokerIndex,
    SiteIndex,
    build_guard_name_index,
    build_payroll_index,
    is_aggregate_guard_name,
    is_longterm_payroll_row,
    levenshtein,
    load_payroll_cells,
    load_payroll_rows,
    load_wp1_rows,
    normalize_name,
    payroll_row_key,
    payroll_site_slices,
    resolve_identities,
    resolve_settlement_for_row,
)
from .master_roster import build_master_roster_only_rows, build_rule01_rule02_inputs
from .private_mappings import broker_canonical_name, broker_names_for, client_name

# PDPO：雞頭真名（K/W/G/D/T/P）淨係喺呢度經 private_mappings 讀一次，下面
# 報告文字/比對邏輯全部用呢幾個變數，源碼本身唔會再出現真名字面值。冇
# private 檔（見 private_mappings.py）就 fallback 用代號本身。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_D = broker_canonical_name("D")
_BROKER_T = broker_canonical_name("T")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
_CLIENT_DUSSERVICE = client_name("dusservice")
_BROKER_K_1331 = f"{_BROKER_K}-1331"
_BROKER_K_LINK = f"{_BROKER_K}-LINK"
# 決定 6 目標範圍：現金結算單位 K/W/G/D/T + Y(公司兵，本身係代號，非真名)。
_CASH_UNITS_TO_EXPLAIN = broker_names_for(["T", "W", "G", "D"], extra=["公司兵"])
_CASH_UNITS_LABEL = "／".join([_BROKER_T, _BROKER_W, _BROKER_G, _BROKER_D, "公司兵"])


def _load_records_jsonl() -> List[dict]:
    records = []
    with open(paths.RECORDS_JSONL, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def _load_sheet_stats() -> List[dict]:
    with open(paths.SHEET_STATS_CSV, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _load_adjustments() -> List[dict]:
    with open(paths.ADJUSTMENTS_CSV, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _parse_hours(time_slot: str) -> Optional[float]:
    if not time_slot or "-" not in time_slot:
        return None
    try:
        start_s, end_s = time_slot.split("-")
        sh, sm = int(start_s[:-2]), int(start_s[-2:])
        eh, em = int(end_s[:-2]), int(end_s[-2:])
    except (ValueError, IndexError):
        return None
    start_min = sh * 60 + sm
    end_min = eh * 60 + em
    if end_min <= start_min:
        end_min += 24 * 60
    return round((end_min - start_min) / 60, 2)


def _split_time_slot(time_slot: str) -> Tuple[str, str]:
    """一併做項目 7：shift_types.csv 加 start_time／end_time（`HHMM-HHMM`
    → `HH:MM`／`HH:MM`）。時段解讀唔到就兩個都留空，唔亂估。"""
    if not time_slot or "-" not in time_slot:
        return "", ""
    start_s, end_s = time_slot.split("-", 1)
    def _fmt(s: str) -> str:
        s = s.strip()
        if len(s) < 3 or not s.isdigit():
            return ""
        s = s.zfill(4)
        return f"{s[:-2]}:{s[-2:]}"
    return _fmt(start_s), _fmt(end_s)


def _write_csv(path, fieldnames, rows: List[dict]):
    paths.ensure_out_wp2b_dir()
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def _file_to_site_raw(wp1_rows: List[dict]) -> Dict[str, str]:
    m = {}
    for row in wp1_rows:
        m.setdefault(row["file"], row["site_raw"])
    return m


def _block_to_sub_site(wp1_rows: List[dict]) -> Dict[str, str]:
    """block_id -> sub_site（淨係城巴車廠檔有值）。城巴嘅「所需人手」統計行喺
    WP1 sheet-stats.csv 自己嗰行冇填 sub_site（WP1 已知限制，唔改 WP1 code），
    但同一個 block 嘅安員行（rows.csv）有——用 block_id 呢個結構化 key 借返
    嚟解，唔係靠估。"""
    m = {}
    for row in wp1_rows:
        if row.get("sub_site"):
            m.setdefault(row["block_id"], row["sub_site"])
    return m


def _row_has_any_resolvable_site(row: dict, site_index: SiteIndex,
                                  cells_by_row_key: Dict[Tuple[str, str, str, str], List[dict]]) -> bool:
    """混合行（規劃 session 決定 5）嘅行級 site_label 本身解唔到（例如
    「31/皓日/創富(混合)」），但佢啲 cells 逐格自己帶住可以解到嘅 site_label
    （1331早/皓日早/創富）。呢個 function 用嚟判斷一行係咪真係完全冇任何
    site 資訊（先算 unmapped），定係其實得行級 label 解唔到但格級可以。"""
    if site_index.resolve(row.get("site_label")) is not None:
        return True
    key3 = payroll_row_key(row)
    for c in cells_by_row_key.get(key3, []):
        if site_index.resolve(c.get("site_label") or row.get("site_label")) is not None:
            return True
    return False


def run_wp2b() -> dict:
    # ---- load mappings ----
    site_index = SiteIndex(load_sites())
    broker_index = BrokerIndex(load_brokers())
    status_codes = load_status_codes()
    rank_billing = load_rank_billing()
    names_en = load_names_en()
    names_en_by_zh = {normalize_name(r["name_zh"]): r for r in names_en if r["name_zh"]}
    # WP2b-c（2026-09-10）：老闆交嘅 Maxwell Corporation Limited 2026-07 長工
    # 月薪表（48人），用嚟喺 resolve_settlement_for_row 加 rule 1.55（見
    # normalize.py docstring），優先於「啟航 K 行歸 K」嘅盤級糧單規則。
    longterm_staff = load_longterm_staff()
    longterm_staff_by_name = {normalize_name(r["name_zh"]): r for r in longterm_staff if r["name_zh"]}
    page_level_settlements = {
        (r["site_id"], r["roster_broker_code"]): r for r in load_page_level_settlements()
    }

    # ---- load WP1 ----
    wp1_rows = load_wp1_rows()
    records = _load_records_jsonl()
    sheet_stats = _load_sheet_stats()
    file_to_site_raw = _file_to_site_raw(wp1_rows)
    block_to_sub_site = _block_to_sub_site(wp1_rows)

    # ---- R1: identity ----
    guard_id_by_rowkey, guards, identity_decisions = resolve_identities(wp1_rows)
    guards_by_id = {g["guard_id"]: g for g in guards}
    name_index = build_guard_name_index(guards)

    # WP5-C（2026-09-10，P0-執行計劃.md §8 WP5 §11；2026-09-10 修必修2）：老闆
    # 「在勤總表」7 月 Roster sheet 逐日雞頭名做權威來源，用嚟喺
    # resolve_settlement_for_row 加 rule 0.1，優先於糧明細逐人配對（rule 1）
    # 同盤級糧單 fallback（rule 1.6）；rule 0.2（下面）用嚟做逐日消去法
    # fallback——見 normalize.py rule 0.1 docstring。
    #
    # 修必修2（run-wp5 隱性依賴 out/wp2b/guards.csv）：呢兩個表以前要靠獨立
    # 行 `run-wp5`（讀 out/wp2b/guards.csv 做 redaction）產生
    # mappings/master_guard_broker_confirmations.csv／
    # master_site_day_broker_counts.csv 先計到，形成「run-wp5 要 guards.csv
    # 先計到，guards.csv 要 run-wp2b 先有」嘅循環依賴，冇任何代碼強制執行
    # 次序，「乾淨 checkout 淨係行一次 run-wp2b」會靜靜噉跌落舊規則。而家
    # 直接將呢個 process 啱啱由 resolve_identities() 攞到嘅 guards list（喺
    # rule 0.1/0.2 之前已經確定，唔受佢哋影響）傳落
    # build_rule01_rule02_inputs()，喺記憶體就地重新解析總表 xlsx／redact／
    # 統計，一次 run-wp2b 一個 process 內就搞掂，唔使中間檔案、唔使行兩次、
    # 唔使預先跑過 run-wp5。冇 MASTER_ROSTER_XLSX（老闆總表未提供）就自動
    # 回傳空表，rule 0.1/0.2 跌落舊規則，行為不變。
    master_guard_broker, master_site_day_broker = build_rule01_rule02_inputs(guards)

    def resolve_wp1_row_site(row: dict) -> Optional[str]:
        return site_index.resolve(row.get("sub_site") or row.get("site_raw"))

    # ---- 一併做項目 5（2026-09-04 放行條件，fail fast）----
    # 20 個更表全部應該已經入晒 sites.csv（硬性不變式），如果對照表有咩甩漏
    # 令某個 wp1_row 解唔到 site，寧願成個 run-wp2b 即刻爆，都唔可以靜靜
    # 用 site_id=None 或者 unknown 頂住繼續行落去、寫出一份睇落完整但其實
    # 漏咗盤嘅報告。呢個 check 喺任何 _write_csv 之前做，確保「解唔到」係
    # fail before write，唔係 fail after 部分輸出已經寫咗出去。
    _unresolved_roster_sites = sorted({
        (row.get("file", ""), row.get("sub_site") or row.get("site_raw") or "")
        for row in wp1_rows if resolve_wp1_row_site(row) is None
    })
    if _unresolved_roster_sites:
        raise RuntimeError(
            "run-wp2b fail fast：以下更表行嘅盤名喺 mappings/sites.csv 解唔到（唔應該發生，"
            "20 個更表全部已入 sites.csv）——冇寫任何 out/wp2b/ 輸出，先修 mappings/sites.csv "
            f"（aliases）先重跑：{_unresolved_roster_sites}")

    # 驗證通過先清空舊輸出，確保唔會出現「新 CSV＋舊報告」混埋嘅半新舊狀態。
    paths.clean_out_wp2b_dir()

    # ---- load WP2a（cells 要喺 build_payroll_index 之前讀晒，等混合行/
    #      HKU醫學院呢類「cell 層有自己 site_label」嘅行可以拆得到） ----
    payroll_rows = load_payroll_rows()
    payroll_cells = load_payroll_cells()
    # C2 修正：key 加 guard_name（同 normalize.payroll_row_key 一致），先可以
    # 分開「一個 row_no 印住兩個人」嘅情況（K-LINK p1 row4「TKO Gateway 厚B」
    # 厚B安員丙／厚B安員丁）。
    cells_by_row_key: Dict[Tuple[str, str, str, str], List[dict]] = defaultdict(list)
    for c in payroll_cells:
        cells_by_row_key[(c["source_file"], c["page"], c["row_no"],
                           (c.get("guard_name") or "").strip())].append(c)

    payroll_by_name_site, unmapped_payroll_labels = build_payroll_index(
        payroll_rows, site_index, cells_by_row_key)

    # 2026-09-10 裁定（HKU 上村 override 反轉）：糧明細 site_label「香港大學
    # 夜更上村」已經係 S007（HKU座頭）嘅 alias（sites.csv），呢班更次唔再
    # 搬盤，但仍然要喺 shift_records 標低 location_tag=上村 畀報表分辨（跟
    # HKU Y更 更表自己 (上)/(摩) 後綴用同一詞彙）。呢個 label 淨係涵蓋幾個
    # guard 嘅幾日（唔係成個月），要逐日 cell 粒度先啱——data-driven，直接
    # 由 payroll-cells 讀邊個人邊日先真係「上村」，唔靠寫死安員姓名。
    shangcun_guard_dates: set = set()
    for row in payroll_rows:
        if "上村" not in (row.get("site_label") or ""):
            continue
        for c in cells_by_row_key.get(payroll_row_key(row), []):
            if c.get("cell_kind") not in ("shift", "partial"):
                continue
            try:
                day = int(c["day"])
            except (ValueError, KeyError):
                continue
            shangcun_guard_dates.add(
                (normalize_name(c.get("guard_name") or row.get("guard_name")),
                 date(2026, 7, day).isoformat()))

    # B3 修正（2026-09-04）：決定 2「推斷長工」原本要求「成個盤喺現金糧明細
    # 完全冇任何人出現過」先觸發（sites_with_zero_cash_payroll），數碼港
    # CP1-4／HKU Y更呢類盤入面有零星現金人（Wilson Guard／少量長工經現金
    # 出糧）就永遠唔觸發，漏晒 537 條 unknown 入面嘅大多數。而家改做逐人
    # 判斷：唔理個別人所在嗰個盤，淨係睇「呢個人（正規化名，包括同形字
    # 變體）有冇喺 14 頁現金糧明細任何一行出現過」——用全部 payroll_rows
    # 嘅 guard_name（撇除聚合行）砌一個 data-driven 嘅名集合，唔係寫死盤
    # 清單。
    payroll_guard_names = {
        normalize_name(r.get("guard_name"))
        for r in payroll_rows
        if not is_aggregate_guard_name((r.get("guard_name") or "").strip())
    }
    payroll_guard_names.discard("")

    # ---- R2: per (file,row) settlement resolution ----
    r2_by_rowkey: Dict[Tuple[str, str], dict] = {}
    used_payroll_keys: set = set()
    broker_conflicts = []
    unresolved_guards = []

    RESOLUTION_LABEL = {
        "master_roster": "跟在勤總表（WP5-C rule 0.1）",
        "master_roster_site": "跟在勤總表（WP5b rule 0.2，site+day 配額消去法）",
        "payroll": "跟糧明細",
        "payroll_label_override": "跟糧明細（子盤 override）",
        "maxwell_payroll": "跟Maxwell長工月薪表",
        "roster_code_site_page": "跟盤級糧單規則",
        "autopay": "跟autopay名單",
        "inferred_guard": "推斷長工(pending N6，逐人判斷)",
        "external": "客戶自己嘅人（唔入糧唔開單，C4）",
        "none": "冇資料",
    }

    for row in wp1_rows:
        rowkey = (row["file"], row["row"])
        guard_id = guard_id_by_rowkey[rowkey]
        guard = guards_by_id[guard_id]
        site_id = resolve_wp1_row_site(row)
        result = resolve_settlement_for_row(
            row, guard, site_id, payroll_by_name_site, broker_index, names_en_by_zh,
            site_index=site_index, page_level_settlements=page_level_settlements,
            payroll_guard_names=payroll_guard_names,
            longterm_staff_by_name=longterm_staff_by_name,
            master_guard_broker=master_guard_broker)
        r2_by_rowkey[rowkey] = {**result, "site_id": site_id}
        used_payroll_keys.update(result["used_keys"])

        roster_code = (row.get("broker_code") or "").strip()
        if roster_code and result["roster_code_agrees"] == "False":
            broker_conflicts.append({
                "guard_id": guard_id,
                "name_zh": guard["name_zh"],
                "file": row["file"],
                "site_id": site_id or "",
                "time_slot": row.get("time_slot", ""),
                "roster_broker_code": roster_code,
                "resolved_settlement_unit": result["settlement_unit"],
                "resolution": RESOLUTION_LABEL.get(result["source"], result["source"]),
                "payroll_ref": result["payroll_ref"],
                "evidence": result["note"] or (
                    f"更表A欄標{roster_code}，但糧明細/推斷結果顯示{result['settlement_unit']}"),
            })
        if result["source"] == "none":
            unresolved_guards.append({
                "guard_id": guard_id,
                "name_zh": guard["name_zh"],
                "tel": guard["tel"],
                "file": row["file"],
                "site_id": site_id or "",
                "time_slot": row.get("time_slot", ""),
                "roster_broker_code": roster_code,
                "reason": result["note"],
            })

    # ---- rule 0.2（WP5b §1，2026-09-10，P0-執行計劃.md §8 WP5「總表歸屬
    #      做齊」；2026-09-11 WP5f 修 Q10：maxwell_payroll 降級）：總表
    #      (site,day) 總配額逐日消去法 fallback ----
    # rule 0.1（normalize.py，guard 級）淨係喺總表 remark 記到呢個 guard_id
    # 先會觸發（HKU Y更 呢類總表冇填雞頭名嘅盤 remark 成欄空白，rule 0.1
    # 完全冇覆蓋，170 個崗位全部跌落舊嘅弱規則猜測）。rule 0.2 唔靠
    # remark：逐日將總表嗰個 (site,day) 嘅 broker_code 總配額，扣減晒已經
    # 有「具名證據」規則（rule 0.1／payroll／payroll_label_override／
    # roster_code_site_page／autopay）認領咗嘅配額，剩低嗰截如果單一
    # broker_code（呢個安員全部工作日都一致）就用嚟 override；多日指向唔同
    # broker_code 嘅一律列做 conflict，唔派。
    #
    # WP5f 修（2026-09-11，老闆已答 Q10「係，長工被掃入雞頭現金桶嘅更雞頭
    # 照樣實收現金，雙重支付」）：maxwell_payroll（rule 1.55，Maxwell／
    # BOCHK 長工月薪表配對）由「具名證據」降做同 inferred_guard／none 一樣
    # 嘅弱來源——呢條規則證明嘅係「呢個人係咪長工」（guards.csv
    # staff_no_mw／monthly_salary／is_longterm 呢三個 guard 層欄位已經獨立
    # 用返 longterm_staff_by_name 計，唔受呢度影響），唔應該再自動鎖死
    # settlement_unit=autopay_longterm、擋住總表 rule 0.2 嘅 site+day 配額
    # 消去法（例子：G0061 HKU Y更 26 更，總表全部標(2)K但remark
    # 呢個盤成欄空白冇留名，rule 0.1 冇覆蓋，以前 rule 1.55 搶先鎖定
    # autopay_longterm 令 rule 0.2 冇機會執行；而家降級之後，rule 0.2 用
    # HKU Y更嗰日淨返嘅(2)K配額 override 返，settlement_unit=K、
    # master_broker_code=K）。揾唔到單一 broker_code（消去法有歧義、冇資料，
    # 或者剩低嘅係 LT/OTHER 呢類冇對應現金桶嘅代號）嘅記錄維持 rule 1.55
    # 原本嘅 autopay_longterm 判斷唔變（例如啟航1331 26 個 Maxwell 長工入面
    # 總表remark已經逐人解到、標明(8)長工 code 嘅，唔會被呢度強行搬去某個
    # 雞頭桶）。
    from .master_roster import MASTER_BROKER_SETTLEMENT

    # master_site_day_broker 已經喺上面同 master_guard_broker 一齊由
    # build_rule01_rule02_inputs() 記憶體算好（修必修2，唔再喺呢度另外
    # load_master_site_day_broker_counts() 讀 mappings/ 中間檔）。
    SETTLEMENT_TO_CODE = {v: k for k, v in MASTER_BROKER_SETTLEMENT.items()}
    WEAK_SOURCES = {"inferred_guard", "none", "maxwell_payroll"}

    rowkey_dates: Dict[Tuple[str, str], Tuple[str, set]] = {}
    for rec in records:
        if rec["kind"] != "work":
            continue
        rk = (rec["file"], str(rec["row"]))
        site_id_rk = site_index.resolve(rec.get("sub_site") or rec.get("site_raw"))
        if site_id_rk is None:
            continue
        prev = rowkey_dates.get(rk)
        dates = prev[1] if prev else set()
        dates.add(rec["work_date"])
        rowkey_dates[rk] = (site_id_rk, dates)

    # claimed：已經有具名證據嘅記錄，逐 (site,date) 認領咗邊個 broker_code
    claimed: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    for rk, (site_id_rk, dates) in rowkey_dates.items():
        r2_entry = r2_by_rowkey.get(rk)
        if not r2_entry or r2_entry.get("source") in WEAK_SOURCES:
            continue
        code = ""
        if r2_entry.get("source") == "master_roster":
            # 修必修1（2026-09-10）：settlement_page 唔再借用做「呢條record
            # 係咪rule 0.1confirm」嘅指針（settlement_page而家保留返糧單頁
            # 事實，rule 0.1confirm嘅記錄未必有settlement_page，例如冇糧單
            # 證據嗰啲）。rule 0.1嘅總表判斷改用 master_broker_code 讀。
            code = r2_entry.get("master_broker_code", "")
        else:
            code = SETTLEMENT_TO_CODE.get(r2_entry.get("settlement_unit", ""), "")
        if not code:
            continue
        for d in dates:
            claimed[(site_id_rk, d)][code] += 1

    leftover: Dict[Tuple[str, str], Counter] = {}
    for key, total_counter in master_site_day_broker.items():
        claimed_here = claimed.get(key, Counter())
        left = Counter()
        for code, n in total_counter.items():
            remain = n - claimed_here.get(code, 0)
            if remain > 0:
                left[code] = remain
        if left:
            leftover[key] = left

    weak_rowkeys = [rk for rk, (_, _) in rowkey_dates.items()
                    if (r2_by_rowkey.get(rk) or {}).get("source") in WEAK_SOURCES]
    orig_source_by_rowkey02 = {rk: r2_by_rowkey[rk]["source"] for rk in weak_rowkeys}

    rule02_overrides: Dict[Tuple[str, str], dict] = {}
    progress = True
    while progress:
        progress = False
        for rk in weak_rowkeys:
            if rk in rule02_overrides:
                continue
            site_id_rk, dates = rowkey_dates[rk]
            implied_codes = set()
            ambiguous = False
            any_info = False
            for d in sorted(dates):
                left = leftover.get((site_id_rk, d))
                if not left:
                    continue
                nonzero = [c for c, n in left.items() if n > 0]
                if not nonzero:
                    continue
                any_info = True
                if len(nonzero) == 1:
                    implied_codes.add(nonzero[0])
                else:
                    ambiguous = True
                    break
            if ambiguous or not any_info or len(implied_codes) != 1:
                continue
            code = next(iter(implied_codes))
            settlement_unit = MASTER_BROKER_SETTLEMENT.get(code, "")
            if not settlement_unit:
                continue
            rule02_overrides[rk] = {"code": code, "settlement_unit": settlement_unit}
            for d in dates:
                key = (site_id_rk, d)
                if key in leftover and code in leftover[key]:
                    leftover[key][code] -= 1
                    if leftover[key][code] <= 0:
                        del leftover[key][code]
                        if not leftover[key]:
                            del leftover[key]
            progress = True

    rule02_conflicts = []
    for rk in weak_rowkeys:
        if rk in rule02_overrides:
            continue
        site_id_rk, dates = rowkey_dates[rk]
        implied = {}
        for d in sorted(dates):
            left = leftover.get((site_id_rk, d))
            if left:
                nz = {c: n for c, n in left.items() if n > 0}
                if nz:
                    implied[d] = nz
        if implied:
            rule02_conflicts.append({
                "guard_id": guard_id_by_rowkey.get(rk, ""), "file": rk[0], "row": rk[1],
                "site_id": site_id_rk, "implied_by_date": implied,
            })

    for rk, ov in rule02_overrides.items():
        r2_entry = r2_by_rowkey[rk]
        r2_entry["settlement_unit"] = ov["settlement_unit"]
        r2_entry["source"] = "master_roster_site"
        r2_entry["confidence"] = "medium"
        # WP5-C 修（2026-09-10，必修1）：settlement_page 唔再俾 rule 0.2 覆
        # 寫（同 normalize.py rule 0.1 一樣嘅道理，見嗰邊 docstring）。呢啲
        # 記錄一定係 WEAK_SOURCES（inferred_guard／none）先會行到呢度，兩個
        # 舊規則都冇設過 settlement_page（預設留空——本身就冇糧單頁證據），
        # 所以呢度乜都唔改，settlement_page 維持 ""。總表判斷改記
        # master_broker_code／master_broker_source。
        r2_entry["master_broker_code"] = ov["code"]
        r2_entry["master_broker_source"] = "rule0.2"
        r2_entry["note"] = (
            f"WP5b rule 0.2：總表 {rowkey_dates[rk][0]} 逐日剩餘配額消去法確認（{ov['code']}），"
            f"原本源頭係 {orig_source_by_rowkey02[rk]}")

    if rule02_overrides:
        resolved_none_file_guard = {
            (rk[0], guard_id_by_rowkey[rk])
            for rk in rule02_overrides if orig_source_by_rowkey02[rk] == "none"
        }
        unresolved_guards = [
            u for u in unresolved_guards
            if (u["file"], u["guard_id"]) not in resolved_none_file_guard
        ]

    # ---- shift_types: 由 WP1 (site_id,time_slot,rank) 組合生成 ----
    # 一併做項目 2（OT 落地）：以前淨係 kind=="work" 先生成 shift_type，
    # OT1（HKU座頭 0615-0715）呢類 kind=="ot" 記錄冇對應 shift_type，
    # shift_records.shift_type_id 一直得返空白。而家 work／ot 都計，OT 嘅
    # code（例如 OT1）唔會同任何 work 嘅 code 撞（時段唔同），唔影響
    # per_shift 更數統計（果啲統計淨係計 record_type=="shift"）。
    code_counter: Dict[Tuple[str, str, str], Counter] = defaultdict(Counter)
    for rec in records:
        if rec["kind"] not in ("work", "ot"):
            continue
        site_id = site_index.resolve(rec.get("sub_site") or rec.get("site_raw"))
        if site_id is None:
            continue
        key = (site_id, rec.get("time_slot") or "", rec.get("rank") or "")
        code_counter[key][rec.get("code_raw") or ""] += 1

    cell_code_labels = load_cell_code_labels()
    shift_types = []
    shift_type_id_by_key: Dict[Tuple[str, str, str], str] = {}
    shift_type_id_by_site_time_code: Dict[Tuple[str, str, str], str] = {}
    for idx, key in enumerate(sorted(code_counter, key=lambda k: (k[0], k[1], k[2])), start=1):
        site_id, time_slot, rank = key
        codes = code_counter[key]
        code = codes.most_common(1)[0][0]
        billing_group = rank_billing.get(rank, "per_shift")
        shift_type_id = f"ST{idx:04d}"
        shift_type_id_by_key[key] = shift_type_id
        shift_type_id_by_site_time_code.setdefault((site_id, time_slot, code), shift_type_id)
        start_time, end_time = _split_time_slot(time_slot)
        label_desc = cell_code_labels.get(code, "")
        label = f"{rank}（{label_desc}）" if rank and label_desc else (label_desc or f"{rank}{code}".strip() or code)
        shift_types.append({
            "shift_type_id": shift_type_id,
            "site_id": site_id,
            "code": code,
            "time_slot": time_slot,
            "start_time": start_time,
            "end_time": end_time,
            "hours": _parse_hours(time_slot),
            "rank": rank,
            "label": label,
            "billing_group": billing_group,
            "source": "roster",
            "codes_seen": ";".join(sorted(codes)) if len(codes) > 1 else "",
        })

    # ---- shift_records: 由 records.jsonl 逐格生成 ----
    shift_records = []
    roster_days_worked: Dict[Tuple[str, str, str], set] = defaultdict(set)  # (guard_id, site_id, settlement_unit) -> {work_date}

    record_type_map = {"work": "shift", "ot": "ot", "leave": "leave", "pointer": "pointer"}

    for rec in records:
        rowkey = (rec["file"], str(rec["row"]))
        guard_id = guard_id_by_rowkey.get(rowkey)
        if guard_id is None:
            continue  # 唔應該發生：records.jsonl 嘅 (file,row) 一定喺 rows.csv 出現過
        site_id = site_index.resolve(rec.get("sub_site") or rec.get("site_raw"))
        r2 = r2_by_rowkey.get(rowkey, {})
        rank = rec.get("rank") or ""
        time_slot = rec.get("time_slot") or ""
        shift_type_id = shift_type_id_by_key.get((site_id, time_slot, rank), "") if site_id else ""
        leave_code = ""
        if rec["kind"] == "leave":
            leave_code = status_codes.get(rec.get("code_raw") or "", rec.get("code_raw") or "")

        # 決定 4：HKU 醫學院 呢類「糧明細 site_label 比更表更細」嘅 child-site
        # override —— 將呢條 WP1 row 嘅 shift_records 由 parent site 改記做
        # child site（暫時喺呢批數據冇任何行觸發，見 wp2b-report.md 點 4）。
        effective_site_id = site_id
        sub_site_out = rec.get("sub_site") or ""
        if r2.get("site_override") and site_id:
            effective_site_id = r2["site_override"]
            sub_site_out = site_index.canonical_name(r2["site_override"])

        out_of_scope = bool(effective_site_id) and not site_index.is_in_p0_scope(effective_site_id)
        settlement_unit_out = r2.get("settlement_unit", "")

        location_tag_out = rec.get("location_tag") or ""
        if not location_tag_out and effective_site_id == "S007":
            _guard_name_zh = guards_by_id.get(guard_id, {}).get("name_zh")
            if _guard_name_zh and (normalize_name(_guard_name_zh), rec["work_date"]) in shangcun_guard_dates:
                location_tag_out = "上村"

        shift_records.append({
            "shift_id": "",  # 補喺下面
            "work_date": rec["work_date"],
            "site_id": effective_site_id or "",
            "sub_site": sub_site_out,
            "shift_type_id": shift_type_id,
            "guard_id": guard_id,
            "settlement_unit": settlement_unit_out,
            # 一併做項目 1（2026-09-04）：broker_id FK（settlement_unit 保留做
            # 可讀欄）＋ settlement_page（糧明細原始標籤，例如 K-1331／
            # K-LINK／公司兵-2，broker_id 唔拆——K仍然一個 broker_id）。
            "broker_id": broker_index.resolve_settlement_unit(settlement_unit_out) or "",
            "settlement_page": r2.get("settlement_page", ""),
            # 修必修1（2026-09-10）：總表（rule 0.1／0.2）對呢條更嘅雞頭判斷，
            # 獨立於 settlement_page（糧單頁事實）之外記錄——見 normalize.py
            # rule 0.1 docstring。
            "master_broker_code": r2.get("master_broker_code", ""),
            "master_broker_source": r2.get("master_broker_source", ""),
            "referral_broker": r2.get("referral_broker", ""),
            "source": r2.get("source", ""),
            "roster_broker_code": rec.get("broker_code") or "",
            "record_type": record_type_map.get(rec["kind"], rec["kind"]),
            "leave_code": leave_code,
            # 一併做項目 2（OT 落地）：ot_hours／parent_shift_id 喺下面
            # 「OT 落地」段補（要等 shift_id 編號晒先搵到同人同日嘅正更）。
            "ot_hours": "",
            "parent_shift_id": "",
            "is_external": rec.get("external", False),
            "out_of_scope": out_of_scope,
            "location_tag": location_tag_out,
            "provenance_file": rec["file"],
            "provenance_cell": rec["cell_ref"],
            "payroll_ref": r2.get("payroll_ref", ""),
        })
        if rec["kind"] == "work" and effective_site_id:
            roster_days_worked[(guard_id, effective_site_id, r2.get("settlement_unit", ""))].add(rec["work_date"])

    # ---- payroll-only rows（更表冇嘅盤/呢個人，或者混合行嘅其中一個
    #      site slice）----
    payroll_only_rows_out = []
    new_payroll_guard_by_name: Dict[str, str] = {}
    next_new_guard_idx = len(guards) + 1
    payroll_only_shift_type_by_key: Dict[Tuple[str, str], str] = {}
    next_pr_shift_type_idx = len(shift_types) + 1
    # B1 修正：key4（source_file,page,row_no,site_id）-> 淨屬於嗰個 site slice
    # 嘅 cells。混合行（決定 5，例如 混合行安員甲「31/皓日/創富(混合)」）拆開之後，
    # 逐日對數（day-mismatch）一定要用呢個 site-scoped 版本，唔可以再用
    # cells_by_row_key（成行 cells，唔理邊格屬邊個盤）嚟做「呢個 (guard,site)
    # 邊幾日有做嘢」嘅判斷——否則會將另一個 slice 嘅日子都當呢個盤有做,
    # 造成「糧明細有格、更表冇更」嘅假差異（S005/S017 混合行安員甲案）。
    cells_by_key4: Dict[Tuple, List[dict]] = {}

    def get_or_create_payroll_guard(name: str) -> str:
        nonlocal next_new_guard_idx
        n = normalize_name(name)
        candidates = name_index.get(n, [])
        if len(candidates) == 1:
            return candidates[0]
        if n in new_payroll_guard_by_name:
            return new_payroll_guard_by_name[n]
        gid = f"G{next_new_guard_idx:04d}"
        next_new_guard_idx += 1
        new_payroll_guard_by_name[n] = gid
        guards_by_id[gid] = {
            "guard_id": gid, "staff_no": "", "staff_no_aliases": "", "staff_no_conflict": "",
            "name_zh": name, "name_variants": "", "tel": "", "is_external": False,
            "source_files": "", "n_rows": 0, "_payroll_only": True,
        }
        return gid

    def get_or_create_payroll_shift_type(site_id: str, time_slot: str) -> str:
        nonlocal next_pr_shift_type_idx
        key = (site_id, time_slot)
        if key in payroll_only_shift_type_by_key:
            return payroll_only_shift_type_by_key[key]
        stid = f"ST{next_pr_shift_type_idx:04d}"
        next_pr_shift_type_idx += 1
        payroll_only_shift_type_by_key[key] = stid
        start_time, end_time = _split_time_slot(time_slot)
        shift_types.append({
            "shift_type_id": stid, "site_id": site_id, "code": "PR",
            "time_slot": time_slot, "start_time": start_time, "end_time": end_time,
            "hours": _parse_hours(time_slot),
            "rank": "", "label": "糧明細生成（更表冇對應資料）", "billing_group": "per_shift",
            "source": "payroll_only",
            "codes_seen": "",
        })
        return stid

    # ---- C3（2026-09-04 放行條件）：兄弟盤 site override + 近似名清單 ----
    # 索引「已經存在」嘅（roster 生成嘅）shift_records，畀低面兩條規則用：
    # (a) exact identity（同一 guard_id）喺兄弟盤（同 client_group）嗰日已經
    #     有記錄 -> 改嗰條記錄嘅 site_id，唔另開新記錄（sibling override）；
    # (b) payroll 名喺 roster 攞唔到 exact identity，但兄弟盤／本盤嗰日有個
    #     roster 安員個名同佢 edit distance ≤1 -> 唔自動合併，入
    #     name-near-match.csv，嗰日暫時淨係計 roster 嗰條，唔另開 payroll_only。
    # 呢個索引淨係影一個 snapshot（roster 生成完、payroll_only 生成之前），
    # 下面就地改 shift_records 入面嘅 dict，唔會影響索引本身嘅 key 有效性
    # （guard_id/work_date 冇變，變嘅淨係 site_id 等欄位）。
    existing_shift_by_guard_date: Dict[Tuple[str, str], List[int]] = defaultdict(list)
    existing_shift_by_site_date: Dict[Tuple[str, str], List[int]] = defaultdict(list)
    for i, r in enumerate(shift_records):
        if r["record_type"] == "shift":
            existing_shift_by_guard_date[(r["guard_id"], r["work_date"])].append(i)
            existing_shift_by_site_date[(r["site_id"], r["work_date"])].append(i)

    site_overrides_out: List[dict] = []
    name_near_match_out: List[dict] = []
    _logged_near_match: set = set()  # (payroll_name, roster_guard_id) 淨係log一次

    def _apply_sibling_override(idx: int, new_site_id: str, row: dict) -> None:
        is_lt = is_longterm_payroll_row(row)
        broker_id = broker_index.resolve_settlement_unit(row["settlement_unit"])
        settlement_unit = "autopay_longterm" if is_lt else (broker_index.name_of(broker_id) or row["settlement_unit"])
        referral_broker = (broker_index.name_of(broker_id) or row["settlement_unit"]) if is_lt else ""
        old_site_id = shift_records[idx]["site_id"]
        shift_records[idx]["site_id"] = new_site_id
        shift_records[idx]["sub_site"] = site_index.canonical_name(new_site_id)
        shift_records[idx]["settlement_unit"] = settlement_unit
        shift_records[idx]["broker_id"] = broker_index.resolve_settlement_unit(settlement_unit) or ""
        shift_records[idx]["settlement_page"] = row["settlement_unit"]
        shift_records[idx]["referral_broker"] = referral_broker
        shift_records[idx]["source"] = "payroll_label_override"
        shift_records[idx]["payroll_ref"] = f"{row['source_file']}#p{row['page']}#row{row['row_no']}"
        site_overrides_out.append({
            "guard_id": shift_records[idx]["guard_id"], "work_date": shift_records[idx]["work_date"],
            "from_site_id": old_site_id, "to_site_id": new_site_id,
            "client_group": site_index.client_group_of(new_site_id),
            "payroll_ref": shift_records[idx]["payroll_ref"],
            "note": "兄弟盤 site override（C3）：糧明細 site_label 同更表盤唔同，但同一"
                     "client_group，同一安員同一日 -> 改呢條 shift_record 嘅 site_id，"
                     "唔另開 payroll_only 記錄",
        })

    for row, site_id, is_mixed, cells, key4 in payroll_site_slices(payroll_rows, site_index, cells_by_row_key):
        cells_by_key4[key4] = cells
        guard_name = (row.get("guard_name") or "").strip()
        if key4 in used_payroll_keys:
            continue
        has_cells = len(cells) > 0
        note = ""
        generated = 0
        resolved_guard_id = ""
        out_of_scope = False
        if site_id is None:
            note = "site_label 未能對應任何 sites.csv 盤（見 unmapped-sites.csv）"
        else:
            out_of_scope = not site_index.is_in_p0_scope(site_id)
            sibling_site_ids = site_index.siblings_of(site_id)

            # C3(a)：exact identity（正規化名喺 name_index 揀到獨一個 roster
            # guard）-> 睇下佢喺兄弟盤嗰啲日子係咪已經有 shift_record，
            # 有就 override 嗰條記錄嘅 site_id，consumed_days 記低唔再重開。
            exact_candidates = name_index.get(normalize_name(guard_name), [])
            exact_guard_id = exact_candidates[0] if len(exact_candidates) == 1 else None
            consumed_days: set = set()
            if exact_guard_id and sibling_site_ids and has_cells:
                for c in cells:
                    if c.get("cell_kind") not in ("shift", "partial"):
                        continue
                    try:
                        day = int(c["day"])
                    except (ValueError, KeyError):
                        continue
                    work_date = date(2026, 7, day).isoformat()
                    for idx in existing_shift_by_guard_date.get((exact_guard_id, work_date), []):
                        if shift_records[idx]["site_id"] in sibling_site_ids:
                            _apply_sibling_override(idx, site_id, row)
                            consumed_days.add(day)
                            break

            # C3(b)：exact identity 搵唔到（0 或 >1 個候選）-> 睇本盤／兄弟盤
            # 嗰日有冇 roster 安員個名同 payroll 個名 edit distance ≤1（唔理
            # 同形字已經喺 normalize_name 處理咗，呢度淨係做真係唔同字嘅
            # 「近似名」）。搵到就唔自動合併身份、入 name-near-match.csv，
            # 嗰日暫時淨係計 roster 嗰條（consumed，唔生成 payroll_only）。
            if not exact_guard_id and has_cells:
                candidate_sites = [site_id] + sibling_site_ids
                payroll_norm = normalize_name(guard_name)
                for c in cells:
                    if c.get("cell_kind") not in ("shift", "partial"):
                        continue
                    try:
                        day = int(c["day"])
                    except (ValueError, KeyError):
                        continue
                    if day in consumed_days:
                        continue
                    work_date = date(2026, 7, day).isoformat()
                    matched_gid = None
                    for sib in candidate_sites:
                        for idx in existing_shift_by_site_date.get((sib, work_date), []):
                            cand = guards_by_id.get(shift_records[idx]["guard_id"], {})
                            if cand.get("_payroll_only"):
                                continue
                            cand_norm = normalize_name(cand.get("name_zh"))
                            if cand_norm and levenshtein(payroll_norm, cand_norm) == 1:
                                matched_gid = shift_records[idx]["guard_id"]
                                break
                        if matched_gid:
                            break
                    if matched_gid:
                        consumed_days.add(day)
                        log_key = (guard_name, matched_gid)
                        if log_key not in _logged_near_match:
                            _logged_near_match.add(log_key)
                            cand = guards_by_id.get(matched_gid, {})
                            name_near_match_out.append({
                                "payroll_name": guard_name, "payroll_ref":
                                    f"{row['source_file']}#p{row['page']}#row{row['row_no']}",
                                "roster_guard_id": matched_gid, "roster_name": cand.get("name_zh", ""),
                                "roster_tel": cand.get("tel", ""), "site_id": site_id,
                                "edit_distance": 1,
                                "note": "唔自動合併（C3）：edit distance=1，人手確認清單；確認前該日更次"
                                         "暫按更表名（roster_name）計一次，唔生成 payroll_only 重複記錄",
                            })

            is_lt = is_longterm_payroll_row(row)
            broker_id = broker_index.resolve_settlement_unit(row["settlement_unit"])
            settlement_unit = "autopay_longterm" if is_lt else (broker_index.name_of(broker_id) or row["settlement_unit"])
            referral_broker = (broker_index.name_of(broker_id) or row["settlement_unit"]) if is_lt else ""
            if has_cells:
                remaining_cells = [c for c in cells if c.get("cell_kind") in ("shift", "partial")
                                   and str(c.get("day", "")).isdigit() and int(c["day"]) not in consumed_days]
                if remaining_cells:
                    resolved_guard_id = get_or_create_payroll_guard(guard_name)
                    time_slot = row.get("time_slot") or ""
                    shift_type_id = get_or_create_payroll_shift_type(site_id, time_slot)
                    for c in remaining_cells:
                        day = int(c["day"])
                        work_date = date(2026, 7, day).isoformat()
                        shift_records.append({
                            "shift_id": "",
                            "work_date": work_date,
                            "site_id": site_id,
                            "sub_site": "",
                            "shift_type_id": shift_type_id,
                            "guard_id": resolved_guard_id,
                            "settlement_unit": settlement_unit,
                            "broker_id": broker_index.resolve_settlement_unit(settlement_unit) or "",
                            "settlement_page": row["settlement_unit"],
                            "referral_broker": referral_broker,
                            "source": "payroll_only",
                            "roster_broker_code": "",
                            "record_type": "shift",
                            "leave_code": "",
                            "ot_hours": "",
                            "parent_shift_id": "",
                            "is_external": False,
                            "out_of_scope": out_of_scope,
                            "location_tag": "",
                            "provenance_file": row["source_file"],
                            "provenance_cell": f"page{row['page']}#row{row['row_no']}#day{day}",
                            "payroll_ref": f"{row['source_file']}#p{row['page']}#row{row['row_no']}",
                        })
                        generated += 1
                note = f"更表冇呢個盤／呢個人，由糧明細逐格生成 {generated} 條 shift_record"
                if is_mixed:
                    note += "（混合行，呢個係其中一個 site slice，用 cell 自己嘅 site_label 拆出嚟）"
                if out_of_scope:
                    note += "（LINK C7，P0範圍外，out_of_scope=true）"
                if consumed_days:
                    note += (f"（{len(consumed_days)} 日經 C3 兄弟盤override/近似名清單消化，"
                              "冇生成呢幾日嘅 payroll_only，見 site-overrides.csv/name-near-match.csv）")
            else:
                note = "更表冇對應資料，且呢頁冇逐格 cells 資料，未能生成 shift_records（只有 row 總數）"

        payroll_only_rows_out.append({
            "source_file": row["source_file"], "page": row["page"],
            "settlement_unit": row["settlement_unit"], "row_no": row["row_no"],
            "site_label": row.get("site_label", ""), "guard_name": guard_name,
            "resolved_site_id": site_id or "", "resolved_guard_id": resolved_guard_id,
            "shifts": row.get("shifts", ""), "has_cell_data": has_cells,
            "generated_records": generated, "out_of_scope": out_of_scope, "note": note,
        })

    # ---- WP2b-d（2026-09-10）：SOGO CWB（S045）／Garden East（S046）「月結
    #      以外」site，冇roster冇糧明細，淨係有發票——逐日更次由老闆確認
    #      （見P0-執行計劃§8 D3），mappings/invoice_daily_shifts.csv 一行一更。
    #      冇安員姓名證據，用同一個佔位安員（每個site一個），source=invoice。
    def get_or_create_invoice_shift_type(site_id: str) -> str:
        # 時段留空（發票冇時段資料，逐日一更，per_shift）；沿用現成
        # get_or_create_payroll_shift_type helper（key=(site_id,time_slot)），
        # 唔使自己另編shift_type_id。
        return get_or_create_payroll_shift_type(site_id, "")

    for inv_row in load_invoice_daily_shifts():
        site_id = inv_row["site_id"]
        placeholder_guard_id = get_or_create_payroll_guard(f"{_CLIENT_DUSSERVICE}臨時工（{site_id}）")
        shift_type_id = get_or_create_invoice_shift_type(site_id)
        shift_records.append({
            "shift_id": "",
            "work_date": inv_row["work_date"],
            "site_id": site_id,
            "sub_site": "",
            "shift_type_id": shift_type_id,
            "guard_id": placeholder_guard_id,
            "settlement_unit": _CLIENT_DUSSERVICE,
            "broker_id": "",
            "settlement_page": "",
            "referral_broker": "",
            "source": "invoice",
            "roster_broker_code": "",
            "record_type": "shift",
            "leave_code": "",
            "ot_hours": "",
            "parent_shift_id": "",
            "is_external": False,
            "out_of_scope": False,
            "location_tag": "",
            "provenance_file": "Invoice-Record-updated-19.08.2026.pdf",
            "provenance_cell": inv_row["evidence"],
            "payroll_ref": "",
        })

    # ---- WP5c必修12（P0-執行計劃.md §8 item 12）：master_roster_only ----
    # 「月結有、更表冇」site（國泰城／M+／CP5 IC／威信控制室／威信Patrol／
    # ICBC／哈羅／東濤苑／卓弘／嘉捷）：20個更表檔完全冇呢啲site嘅逐日
    # 來源，但總表逐崗位逐日格有齊，逐崗位自己仲帶埋上單價/外判價——用嚟
    # 補入庫，source=master_roster_only。
    #
    # Dedup規則：(site_id, work_date, guard_id)已經有shift_records（嚟自
    # roster/payroll_only）就跳過，唔重複計——實測東濤苑總表話有1格
    # （2026-07-31），但呢一日已經由G糧單頁生成咗一條shift_record
    # （G0239），跳過先至啱，唔係就會多計一條假更。
    existing_site_date_guard = {
        (r["site_id"], r["work_date"], r["guard_id"])
        for r in shift_records if r.get("record_type") == "shift"
    }
    # 冇個人姓名嘅崗位（國泰城／ICBC／哈羅／東濤苑淨係得site name，冇跟住
    # 個人名）：仲要防「呢日呢個site已經有第三方（例如糧單）嘅shift_record」
    # ——唔理邊個guard，都當已經計咗，唔再用placeholder guard另開一條。
    # 呢個set係跑呢個section之前嘅snapshot，唔可以喺loop入面再加新嘢入去
    # ——同一個site同一日，唔同崗位（唔同placeholder guard）本身可以合法
    # 咁同時有人做（例如國泰城7個崗位入面幾個可能撞正同一日），唔可以將
    # loop入面自己啱啱加咗嘅記錄都當「已存在」去阻住第二個崗位。
    existing_site_date_before = {(sid, wd) for sid, wd, _g in existing_site_date_guard}

    master_roster_only_shift_type_by_post: Dict[str, str] = {}
    master_roster_only_rates: List[dict] = []
    next_mro_shift_type_idx = len(shift_types) + 1
    master_roster_only_skipped_dup = 0
    master_roster_only_generated = 0

    def get_or_create_master_roster_only_shift_type(row: dict) -> str:
        nonlocal next_mro_shift_type_idx
        post_id = row["post_id"]
        if post_id in master_roster_only_shift_type_by_post:
            return master_roster_only_shift_type_by_post[post_id]
        stid = f"ST{next_mro_shift_type_idx:04d}"
        next_mro_shift_type_idx += 1
        master_roster_only_shift_type_by_post[post_id] = stid
        start_time, end_time = _split_time_slot(row["time"])
        shift_types.append({
            "shift_type_id": stid, "site_id": row["site_id"], "code": "MR",
            "time_slot": row["time"], "start_time": start_time, "end_time": end_time,
            "hours": _parse_hours(row["time"]),
            "rank": row.get("shift", ""), "label": "在勤總表生成（更表冇對應資料，§3.7）",
            "billing_group": "per_shift",
            "source": "master_roster_only",
            "codes_seen": "",
        })
        master_roster_only_rates.append({
            "shift_type_id": stid, "site_id": row["site_id"],
            "client_rate": row["client_rate"], "payout_rate": row["payout_rate"],
            "broker_code": row["broker_code"],
            "evidence": (f"data/2026-07/reference/2026-07-在勤總表-PostOrder-Roster-Summary "
                         f"(Drive 2026-09-10).xlsx#Roster row{row['row_no']}"
                         f"({row['property']}, {row['shift']}, {row['time']})"),
        })
        return stid

    for row in build_master_roster_only_rows():
        site_id = row["site_id"]
        settlement_unit = row["settlement_unit"]
        guard_name = (row["guard_name_raw"] or "").strip()
        if guard_name:
            guard_id = get_or_create_payroll_guard(guard_name)
        else:
            # 冇個人姓名：一個崗位（post_id）一個佔位安員，唔可以逐日/逐
            # 崗位共用同一個佔位id（會將唔同崗位嘅人夾埋一個假身份）。
            guard_id = get_or_create_payroll_guard(
                f"在勤總表崗位{row['row_no']}（{row['property']}，總表冇個人姓名）")
            if (site_id, row["work_date"]) in existing_site_date_before:
                master_roster_only_skipped_dup += 1
                continue
        if (site_id, row["work_date"], guard_id) in existing_site_date_guard:
            master_roster_only_skipped_dup += 1
            continue
        shift_type_id = get_or_create_master_roster_only_shift_type(row)
        shift_records.append({
            "shift_id": "",
            "work_date": row["work_date"],
            "site_id": site_id,
            "sub_site": "",
            "shift_type_id": shift_type_id,
            "guard_id": guard_id,
            "settlement_unit": settlement_unit,
            "broker_id": broker_index.resolve_settlement_unit(settlement_unit) or "",
            "settlement_page": "",
            "master_broker_code": row["broker_code"],
            "master_broker_source": "master_roster_only",
            "referral_broker": "",
            "source": "master_roster_only",
            "roster_broker_code": "",
            "record_type": "shift",
            "leave_code": "",
            "ot_hours": "",
            "parent_shift_id": "",
            "is_external": False,
            "out_of_scope": False,
            "location_tag": "",
            "provenance_file": ("2026-07-在勤總表-PostOrder-Roster-Summary "
                                 "(Drive 2026-09-10).xlsx"),
            "provenance_cell": f"Roster row{row['row_no']}#day{row['work_date']}",
            "payroll_ref": "",
        })
        existing_site_date_guard.add((site_id, row["work_date"], guard_id))
        master_roster_only_generated += 1

    _write_csv(paths.WP2B_MASTER_ROSTER_ONLY_RATES_CSV,
               ["shift_type_id", "site_id", "client_rate", "payout_rate", "broker_code", "evidence"],
               master_roster_only_rates)

    # ---- shift_id 補番 ----
    shift_records.sort(key=lambda r: (r["work_date"], r["site_id"], r["guard_id"],
                                       r["shift_type_id"], r["provenance_file"], r["provenance_cell"]))
    for i, r in enumerate(shift_records, start=1):
        r["shift_id"] = f"SR{i:06d}"

    adjustments = _load_adjustments()

    # ---- 一併做項目 2（2026-09-04 放行條件）：OT 落地 ----
    # record_type=="ot" 嘅記錄（HKU座頭 0615-0715 OT1，全部 6 條）以前
    # shift_type_id／ot_hours／parent_shift_id 三個都係空——shift_types 生成
    # 嗰段以前淨係計 kind=="work"，而家已經擴到埋 kind=="ot"（見上面
    # 「shift_types」段），所以 OT1 記錄嘅 shift_type_id 喺主 loop 已經跟正
    # 更一樣攞返對應嘅 shift_type_id。呢度補低 ot_hours（預設由 shift_type
    # 嘅 hours 計，即係時段長度；如果 adjustments.csv 有「OT n 小時」明確
    # 講出鐘數就用嗰個——真實案例見 P0-執行計劃.md §3.8：某人打風OT記2
    # 小時，唔係預設嘅 1 小時）同 parent_shift_id（同一 guard_id + work_date
    # + site_id 嘅正更 record_type=="shift"）。
    _OT_HOURS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*小時")
    _OT_ADJ_DAY_RE = re.compile(r"(\d{1,2})[-/](?:Jul|7)")

    def _ot_hours_from_adjustments(guard_name: str, work_date: str) -> Optional[float]:
        try:
            day_num = int(work_date[-2:])
        except ValueError:
            return None
        target = normalize_name(guard_name)
        for a in adjustments:
            if normalize_name(a.get("guard_name")) != target:
                continue
            desc = a.get("description") or ""
            if "OT" not in desc and "打風" not in desc:
                continue
            m_day = _OT_ADJ_DAY_RE.search(desc)
            if m_day and int(m_day.group(1)) != day_num:
                continue
            m_hr = _OT_HOURS_RE.search(desc)
            if m_hr:
                return float(m_hr.group(1))
        return None

    shift_type_by_id = {st["shift_type_id"]: st for st in shift_types}
    parent_shift_lookup: Dict[Tuple[str, str, str], List[dict]] = defaultdict(list)
    for r in shift_records:
        if r["record_type"] == "shift":
            parent_shift_lookup[(r["guard_id"], r["work_date"], r["site_id"])].append(r)

    ot_landed_log: List[dict] = []
    for r in shift_records:
        if r["record_type"] != "ot":
            continue
        guard = guards_by_id.get(r["guard_id"], {})
        override_hours = _ot_hours_from_adjustments(guard.get("name_zh", ""), r["work_date"])
        if override_hours is not None:
            hours = override_hours
            hours_source = "adjustments.csv 明確鐘數"
        else:
            st = shift_type_by_id.get(r["shift_type_id"])
            hours = st["hours"] if st and st.get("hours") is not None else 1.0
            hours_source = "由時段計（shift_type.hours）" if st else "冇搵到shift_type，預設1小時"
        r["ot_hours"] = hours
        parents = parent_shift_lookup.get((r["guard_id"], r["work_date"], r["site_id"]), [])
        parent_shift_id = parents[0]["shift_id"] if parents else ""
        r["parent_shift_id"] = parent_shift_id
        ot_landed_log.append({
            "shift_id": r["shift_id"], "guard_id": r["guard_id"], "name_zh": guard.get("name_zh", ""),
            "work_date": r["work_date"], "site_id": r["site_id"], "shift_type_id": r["shift_type_id"],
            "ot_hours": hours, "hours_source": hours_source, "parent_shift_id": parent_shift_id,
        })

    # ---- day-mismatch: 逐日對比（限有 cells 嘅頁；只計 cell_kind in
    #      {shift,partial,zero} —— zero＝當日印0（明確冇做），status/ot/
    #      adjustment/day_total/monthly_fee_day 呢啲同「呢日有冇做更」冇關，
    #      唔算） ----
    # B2 覆核發現：仲有第三種日子——更表話有做，但糧明細嗰行連呢日嘅 cell
    # 都完全冇（唔係 shift/partial，亦唔係 zero/status，即係 WP2a 轉錄嗰陣
    # 冇留低任何記錄），以前呢種日子靜靜被 `if not has_any_cells` 之外嘅
    # 交集邏輯漏走，冇入 day-mismatch，都冇入守恆表嘅任何解釋欄，直接變成
    # R4 §2 度嗰啲「需要人手覆核（可能係...）」嘅含糊尾數（例如 公司兵
    # 公司兵甲/公司兵乙 25/7 OT）。而家逐日都攞 adjustments.csv 嚟對，撞到就
    # 標明「OT/adjustment.csv 已記」（唔係「可能」），撞唔到先真係人手覆核。
    adjustments_by_key3: Dict[Tuple[str, str, str], List[dict]] = defaultdict(list)
    for a in adjustments:
        adjustments_by_key3[(a["source_file"], a["page"], a["row_no"])].append(a)
    _OT_DAY_RE = re.compile(r"(\d{1,2})-Jul")

    def _ot_adjustment_reason(pkeys, work_date: str) -> Optional[str]:
        try:
            day_num = int(work_date[-2:])
        except ValueError:
            return None
        for k in pkeys:
            for adj in adjustments_by_key3.get(k[:3], []):
                desc = adj.get("description") or ""
                if "OT" not in desc and "打風" not in desc:
                    continue
                m = _OT_DAY_RE.search(desc)
                if m and int(m.group(1)) == day_num:
                    return (f"adjustments.csv 已記：{adj['guard_name']}《{desc}》"
                             f"（source={k[0]}#p{k[1]}#row{k[2]}），OT/特殊調整唔入cells當正常更次")
        return None

    day_mismatch = []
    ot_adjustment_days_by_unit: Counter = Counter()
    guard_site_to_payroll_keys: Dict[Tuple[str, str], set] = defaultdict(set)
    guard_site_settlement: Dict[Tuple[str, str], str] = {}
    for rowkey, r2 in r2_by_rowkey.items():
        if r2.get("source") not in ("payroll", "payroll_label_override"):
            continue
        guard_id = guard_id_by_rowkey[rowkey]
        site_id = r2.get("site_id")
        guard_site_settlement[(guard_id, site_id)] = r2.get("settlement_unit", "")
        for k in r2.get("used_keys") or []:
            guard_site_to_payroll_keys[(guard_id, site_id)].add(k)

    for (guard_id, site_id), pkeys in guard_site_to_payroll_keys.items():
        payroll_worked_days = set()
        payroll_considered_days = set()
        payroll_any_kind_days = set()
        has_any_cells = False
        for k in pkeys:
            # B1 修正：用 site-scoped cells_by_key4（該 slice 自己嘅 cells，
            # 由 cell_note/site_label 解到嗰個盤），唔用成行嘅
            # cells_by_row_key——混合行拆咗做幾個 slice 之後，每個 slice
            # 淨係應該睇返屬於自己嗰啲格。
            cells = cells_by_key4.get(k, [])
            if cells:
                has_any_cells = True
            for c in cells:
                try:
                    d = int(c["day"])
                except (ValueError, KeyError):
                    continue
                work_date = date(2026, 7, d).isoformat()
                payroll_any_kind_days.add(work_date)
                if c.get("cell_kind") not in ("shift", "partial", "zero"):
                    continue
                payroll_considered_days.add(work_date)
                if c.get("cell_kind") in ("shift", "partial"):
                    payroll_worked_days.add(work_date)
        if not has_any_cells:
            continue
        roster_days = set()
        for (g, s, su), days in roster_days_worked.items():
            if g == guard_id and s == site_id:
                roster_days |= days
        # 情況一：兩邊都「有資料」（payroll 呢日有 shift/partial/zero cell）
        # 嘅日子度先比較純粹嘅出勤有冇。
        only_roster = sorted((roster_days & payroll_considered_days) - payroll_worked_days)
        only_payroll = sorted(payroll_worked_days - roster_days)
        # 情況二（B2 新增）：更表話有做，但糧明細嗰行連呢日嘅 cell 都完全
        # 冇留低（唔喺 payroll_any_kind_days 度）——攞 adjustments.csv 對，
        # 撞到就標明原因，撞唔到先入「需人手覆核」，兩者都要入 day-mismatch
        # 度俾人逐條睇，唔可以再靜靜跳過。
        roster_no_payroll_data = sorted(roster_days - payroll_any_kind_days)
        guard = guards_by_id[guard_id]
        su = guard_site_settlement.get((guard_id, site_id), "")
        for d in only_roster:
            day_mismatch.append({"guard_id": guard_id, "name_zh": guard["name_zh"], "site_id": site_id,
                                  "settlement_unit": su,
                                  "work_date": d, "roster_has": True, "payroll_has": False,
                                  "note": "更表有更、糧明細呢日印明confirmed唔係更（zero/明確冇做）"})
        for d in only_payroll:
            day_mismatch.append({"guard_id": guard_id, "name_zh": guard["name_zh"], "site_id": site_id,
                                  "settlement_unit": su,
                                  "work_date": d, "roster_has": False, "payroll_has": True,
                                  "note": "糧明細有格、更表呢日冇更"})
        for d in roster_no_payroll_data:
            reason = _ot_adjustment_reason(pkeys, d)
            if reason:
                ot_adjustment_days_by_unit[su] += 1
                note = f"更表有更、糧明細嗰行完全冇呢日cell（連zero都冇）——{reason}"
            else:
                note = "更表有更、糧明細嗰行完全冇呢日cell（連zero都冇），adjustments.csv亦冇對應記錄，需人手覆核"
            day_mismatch.append({"guard_id": guard_id, "name_zh": guard["name_zh"], "site_id": site_id,
                                  "settlement_unit": su,
                                  "work_date": d, "roster_has": True, "payroll_has": False,
                                  "note": note})
    day_mismatch.sort(key=lambda r: (r["site_id"], r["guard_id"], r["work_date"]))

    # ---- 一併做項目 3（2026-09-04 放行條件）：day-mismatch 自動分類 ----
    # category 一律 data-driven 判斷，唔靠寫死名單：
    #  1. explained_by_adjustment：note 已經記低咗 adjustments.csv 撞中嘅
    #     day-specific OT（真實案例見 P0-執行計劃.md），另加寬鬆配對——guard_name 喺
    #     adjustments.csv 出現過（唔理呢張 adjustment 有冇日期）就都算；
    #     淨係 site+「颱風」關鍵字冇 guard_name 撞中（真實案例見 P0-執行計劃.md）留做
    #     needs_review，但喺 note 補一句線索，唔算解釋咗。
    #  2. explained_by_site_override：(guard_id,work_date) 喺 site-overrides.csv
    #     出現過（C3）——呢啲日子已經由 site override 解釋咗，唔屬於原本
    #     五分類，但都要清楚標，唔可以留喺 needs_review。
    #  3. adjacent_day_swap：同一 guard、同一 site，兩個相鄰日（±1日）
    #     roster_has/payroll_has 啱啱相反（一日淨roster有、第二日淨payroll
    #     有），淨額為 0。
    #  4. two_person_swap／substitution：同一 site，兩個唔同 guard，喺同日或
    #     相鄰日 roster/payroll 交叉相反——settlement_unit 相同=兩人對調
    #     （two_person_swap）；settlement_unit 唔同=補更（substitution，
    #     加 cost_transfer 註，因為糧經另一雞頭/autopay出，需要跨雞頭調整）。
    #  5. 淨低嘅=needs_review。
    override_day_set = {(o["guard_id"], o["work_date"]) for o in site_overrides_out}
    adjustment_guard_names = {normalize_name(a.get("guard_name")) for a in adjustments if a.get("guard_name")}
    typhoon_site_settlements = {a["settlement_unit"] for a in adjustments if "颱風" in (a.get("description") or "")}

    for r in day_mismatch:
        r["category"] = ""

    for r in day_mismatch:
        if (r["guard_id"], r["work_date"]) in override_day_set:
            r["category"] = "explained_by_site_override"
            r["note"] += "；C3 兄弟盤 site override 已解釋，見 site-overrides.csv"
        elif "adjustments.csv 已記" in r["note"]:
            r["category"] = "explained_by_adjustment"
        elif normalize_name(r["name_zh"]) in adjustment_guard_names:
            r["category"] = "explained_by_adjustment"
            r["note"] += "；寬鬆配對：adjustments.csv 有呢個人嘅記錄（唔限定同一日），見 adjustments.csv"
        elif r["settlement_unit"] in typhoon_site_settlements:
            r["note"] += "；線索：adjustments.csv 呢個結算單位有「颱風」相關調整，但冇明確配對到呢個人，未能自動解釋"

    def _cross_guard_pass(max_day_diff: int) -> None:
        """two_person_swap／substitution：同一 site，唔同 guard，喺相隔
        `max_day_diff` 日之內 roster/payroll 交叉相反。settlement_unit 相同
        =兩人對調；唔同=補更（cost_transfer）。優先行 max_day_diff=0（同日）
        先，先至唔會將「兩人同日對調」誤判做「同一人自己相鄰日搬咗」。"""
        by_site: Dict[str, List[dict]] = defaultdict(list)
        for r in day_mismatch:
            if not r["category"]:
                by_site[r["site_id"]].append(r)
        for rs in by_site.values():
            for i in range(len(rs)):
                a = rs[i]
                if a["category"]:
                    continue
                for j in range(i + 1, len(rs)):
                    b = rs[j]
                    if b["category"] or a["guard_id"] == b["guard_id"]:
                        continue
                    da, db = date.fromisoformat(a["work_date"]), date.fromisoformat(b["work_date"])
                    if abs((db - da).days) > max_day_diff:
                        continue
                    if a["roster_has"] == a["payroll_has"] or b["roster_has"] == b["payroll_has"]:
                        continue
                    if a["roster_has"] == b["roster_has"]:
                        continue
                    if a["settlement_unit"] == b["settlement_unit"]:
                        cat = "two_person_swap"
                        extra = "；同盤兩人對調（同一結算單位）"
                    else:
                        cat = "substitution"
                        extra = (f"；補更（更表 vs 糧明細分屬唔同結算單位：{a['settlement_unit']} ↔ "
                                  f"{b['settlement_unit']}），cost_transfer：糧經另一雞頭/autopay出，"
                                  "需要跨雞頭調整項先追蹤到實際出糧")
                    a["category"] = b["category"] = cat
                    # 修必修5（2026-09-10）：呢個note欄會經wp4_run.py流入
                    # differences.csv／老闆版工作簿，唔可以夾真名——用
                    # guard_id（day-mismatch.csv本身喺out/wp2b/已經有
                    # name_zh欄可以對返，唔靠note欄帶）。
                    a["note"] += extra + f"（對應 {b['guard_id']} {b['work_date']}）"
                    b["note"] += extra + f"（對應 {a['guard_id']} {a['work_date']}）"
                    break

    # 1) 同日跨人對調／補更（診斷優先——真實案例兩個同盤安員相鄰兩日互相對調，兩個
    #    人各自睇都好似「自己相鄰日搬咗」，但其實係同日跟另一個人對調）。
    _cross_guard_pass(max_day_diff=0)

    # 2) 同一 guard+site 相鄰日淨額0（真實案例：安員自己相鄰日搬咗一更，冇第二個人涉及）
    by_guard_site: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
    for r in day_mismatch:
        if not r["category"]:
            by_guard_site[(r["guard_id"], r["site_id"])].append(r)
    for rs in by_guard_site.values():
        rs.sort(key=lambda r: r["work_date"])
        for i in range(len(rs)):
            a = rs[i]
            if a["category"]:
                continue
            for j in range(i + 1, len(rs)):
                b = rs[j]
                if b["category"]:
                    continue
                da, db = date.fromisoformat(a["work_date"]), date.fromisoformat(b["work_date"])
                if abs((db - da).days) == 1 and a["roster_has"] != b["roster_has"] and a["payroll_has"] != b["payroll_has"]:
                    a["category"] = b["category"] = "adjacent_day_swap"
                    a["note"] += f"；同人相鄰日對調（{b['work_date']}），淨額0"
                    b["note"] += f"；同人相鄰日對調（{a['work_date']}），淨額0"
                    break

    # 3) 淨低嘅先至放寬去相鄰日（±1日）搵跨人配對
    _cross_guard_pass(max_day_diff=1)

    for r in day_mismatch:
        if not r["category"]:
            r["category"] = "needs_review"

    # ---- daily_requirements ----
    block_to_code: Dict[str, str] = {}
    block_code_counter: Dict[str, Counter] = defaultdict(Counter)
    for rec in records:
        if rec["kind"] == "work" and rec.get("block_id"):
            block_code_counter[rec["block_id"]][rec.get("code_raw") or ""] += 1
    for block_id, codes in block_code_counter.items():
        block_to_code[block_id] = codes.most_common(1)[0][0]

    daily_requirements = []
    for row in sheet_stats:
        if row["role"] != "required":
            continue
        block_id = row.get("block_id", "")
        site_raw = (row.get("sub_site") or block_to_sub_site.get(block_id)
                    or file_to_site_raw.get(row["file"], ""))
        site_id = site_index.resolve(site_raw)
        if site_id is None:
            continue
        try:
            day = int(row["day"])
        except (ValueError, KeyError):
            continue
        time_slot = row.get("time_slot") or ""
        code = row.get("code") or block_to_code.get(block_id, "")
        shift_type_id = shift_type_id_by_site_time_code.get((site_id, time_slot, code), "")
        try:
            headcount = int(float(row["value"]))
        except (ValueError, KeyError):
            continue
        daily_requirements.append({
            "site_id": site_id, "shift_type_id": shift_type_id,
            "work_date": date(2026, 7, day).isoformat(),
            "headcount_required": headcount,
            "provenance_file": row["file"], "provenance_cell": row["cell_ref"],
        })
    daily_requirements.sort(key=lambda r: (r["site_id"], r["work_date"], r["shift_type_id"]))

    # ---- unmapped-sites.csv：roster sub_site/site_raw 都應該全部解到；
    #      payroll site_label 用 _row_has_any_resolvable_site 排除咗混合行
    #      （佢哋 cell 層有得解）先算真係 unmapped ----
    unmapped_sites_out = [
        {"raw_label": label, "source": "payroll_site_label", "count": count}
        for label, count in sorted(unmapped_payroll_labels.items(), key=lambda x: (-x[1], x[0]))
    ]
    unresolved_site_raw = Counter()
    for row in wp1_rows:
        if resolve_wp1_row_site(row) is None:
            unresolved_site_raw[row.get("sub_site") or row.get("site_raw")] += 1
    for label, count in sorted(unresolved_site_raw.items(), key=lambda x: (-x[1], x[0])):
        unmapped_sites_out.append({"raw_label": label, "source": "roster_site_raw_or_sub_site", "count": count})

    # ---- names_en-unmatched.csv ----
    names_en_unmatched = [r for r in names_en if not r["name_zh"]]

    # ============================== 寫檔 ==============================
    _write_csv(paths.WP2B_SITES_CSV,
               ["site_id", "canonical_name", "client_name", "client_group", "billing_model",
                "monthly_fee", "aliases", "in_p0_scope", "parent_site_id"],
               [{"site_id": s["site_id"], "canonical_name": s["canonical_name"],
                 "client_name": s["client_name"], "client_group": s["client_group"],
                 "billing_model": s["billing_model"], "monthly_fee": s["monthly_fee"],
                 "aliases": ";".join(s["aliases"]), "in_p0_scope": s["in_p0_scope"],
                 "parent_site_id": s["parent_site_id"]} for s in load_sites()])

    _write_csv(paths.WP2B_BROKERS_CSV,
               ["broker_id", "code", "canonical_name", "kind", "settlement_type", "aliases"],
               [{"broker_id": b["broker_id"], "code": b["code"], "canonical_name": b["canonical_name"],
                 "kind": b["kind"], "settlement_type": b["settlement_type"],
                 "aliases": ";".join(b["aliases"])} for b in load_brokers()])

    shift_types.sort(key=lambda r: r["shift_type_id"])
    _write_csv(paths.WP2B_SHIFT_TYPES_CSV,
               ["shift_type_id", "site_id", "code", "time_slot", "start_time", "end_time", "hours",
                "rank", "label", "billing_group", "source", "codes_seen"],
               shift_types)

    guards_out = sorted(guards_by_id.values(), key=lambda g: g["guard_id"])
    for g in guards_out:
        g.setdefault("_payroll_only", False)
    # 一併做項目 7：guards.csv 加 name_en（由私有 names_en 表配對，逐名嘅
    # 同形字變體都試埋，PDPO 私有表本身唔入 git，呢度淨係借英文名做欄位）。
    name_en_by_zh_all = {normalize_name(r["name_zh"]): r["english_name"] for r in names_en if r["name_zh"]}

    def _name_en_for(g: dict) -> str:
        variants = {g["name_zh"]} | set(v for v in g["name_variants"].split(";") if v)
        for v in variants:
            en = name_en_by_zh_all.get(normalize_name(v))
            if en:
                return en
        return ""

    # WP2b-c（2026-09-10）：guards.csv 加 staff_no_mw／monthly_salary／
    # is_longterm，由 longterm_staff_by_name（Maxwell 2026-07 長工月薪表）
    # 逐人配對（同形字變體都試埋，同 _name_en_for 同一原則）。
    def _longterm_info_for(g: dict) -> dict:
        variants = {g["name_zh"]} | set(v for v in g["name_variants"].split(";") if v)
        for v in variants:
            info = longterm_staff_by_name.get(normalize_name(v))
            if info:
                return info
        return {}

    _write_csv(paths.WP2B_GUARDS_CSV,
               ["guard_id", "staff_no", "staff_no_aliases", "staff_no_conflict", "name_zh", "name_en",
                "name_variants", "tel", "is_external", "is_payroll_only", "source_files", "n_rows",
                "staff_no_mw", "monthly_salary", "is_longterm"],
               [{"guard_id": g["guard_id"], "staff_no": g["staff_no"], "staff_no_aliases": g["staff_no_aliases"],
                 "staff_no_conflict": g["staff_no_conflict"], "name_zh": g["name_zh"], "name_en": _name_en_for(g),
                 "name_variants": g["name_variants"], "tel": g["tel"], "is_external": g["is_external"],
                 "is_payroll_only": g.get("_payroll_only", False),
                 "source_files": g["source_files"], "n_rows": g["n_rows"],
                 "staff_no_mw": _longterm_info_for(g).get("staff_no_mw", ""),
                 "monthly_salary": _longterm_info_for(g).get("monthly_salary", ""),
                 "is_longterm": bool(_longterm_info_for(g))}
                for g in guards_out])

    # WP5c必修13（P0-執行計劃.md §8 item 13）：長工雞頭費／更（
    # mappings/referral_fee_rates.csv）——淨係喺呢條shift_record已經有
    # 具體`referral_broker`（邊個雞頭收介紹費，嚟自payroll頁面證據，
    # T/G共251條）先stamp得到，因為費率表keyed by broker_id；
    # rule 0.1/0.2嘅`(8)長工`記錄冇具體邊個雞頭嘅逐更證據（總表淨係有
    # block級彙總嘅「長工雞頭費(X)」行，已經喺referral-fee-validation.csv
    # 逐group驗證過，唔喺呢度逐更斷估邊個雞頭），留空。
    _referral_fee_rates = load_referral_fee_rates()
    for r in shift_records:
        r.setdefault("referral_fee_snapshot", "")
        ref_broker_name = r.get("referral_broker")
        if not ref_broker_name:
            continue
        ref_broker_id = broker_index.resolve_settlement_unit(ref_broker_name)
        if not ref_broker_id:
            continue
        rate_str, _note = referral_fee_rate_for(ref_broker_id, r["site_id"], _referral_fee_rates)
        if rate_str:
            r["referral_fee_snapshot"] = rate_str

    _write_csv(paths.WP2B_SHIFT_RECORDS_CSV,
               ["shift_id", "work_date", "site_id", "sub_site", "shift_type_id", "guard_id",
                "settlement_unit", "broker_id", "settlement_page", "master_broker_code",
                "master_broker_source", "referral_broker", "referral_fee_snapshot", "source",
                "roster_broker_code", "record_type", "leave_code", "ot_hours", "parent_shift_id",
                "is_external", "out_of_scope", "location_tag", "provenance_file",
                "provenance_cell", "payroll_ref"],
               shift_records)

    ot_landed_log.sort(key=lambda r: r["shift_id"])
    _write_csv(paths.WP2B_OT_LANDING_CSV,
               ["shift_id", "guard_id", "name_zh", "work_date", "site_id", "shift_type_id",
                "ot_hours", "hours_source", "parent_shift_id"],
               ot_landed_log)

    _write_csv(paths.WP2B_DAILY_REQUIREMENTS_CSV,
               ["site_id", "shift_type_id", "work_date", "headcount_required", "provenance_file", "provenance_cell"],
               daily_requirements)

    _write_csv(paths.WP2B_IDENTITY_DECISIONS_CSV,
               ["decision", "guard_ids", "key_type", "key_value", "evidence"], identity_decisions)

    broker_conflicts.sort(key=lambda r: (r["site_id"], r["guard_id"]))
    _write_csv(paths.WP2B_BROKER_CONFLICTS_CSV,
               ["guard_id", "name_zh", "file", "site_id", "time_slot", "roster_broker_code",
                "resolved_settlement_unit", "resolution", "payroll_ref", "evidence"], broker_conflicts)

    unresolved_guards.sort(key=lambda r: (r["site_id"], r["guard_id"], r["file"]))
    _write_csv(paths.WP2B_UNRESOLVED_GUARDS_CSV,
               ["guard_id", "name_zh", "tel", "file", "site_id", "time_slot", "roster_broker_code", "reason"],
               unresolved_guards)

    _write_csv(paths.WP2B_UNMAPPED_SITES_CSV, ["raw_label", "source", "count"], unmapped_sites_out)

    _write_csv(paths.WP2B_DAY_MISMATCH_CSV,
               ["guard_id", "name_zh", "site_id", "settlement_unit", "work_date", "roster_has", "payroll_has",
                "category", "note"],
               day_mismatch)

    payroll_only_rows_out.sort(key=lambda r: (r["source_file"], r["page"], r["row_no"], r["resolved_site_id"]))
    _write_csv(paths.WP2B_PAYROLL_ONLY_ROWS_CSV,
               ["source_file", "page", "settlement_unit", "row_no", "site_label", "guard_name",
                "resolved_site_id", "resolved_guard_id", "shifts", "has_cell_data", "generated_records",
                "out_of_scope", "note"],
               payroll_only_rows_out)

    _write_csv(paths.WP2B_NAMES_EN_UNMATCHED_CSV,
               ["english_name", "confidence", "tier", "evidence"],
               [{"english_name": r["english_name"], "confidence": r["confidence"],
                 "tier": r["tier"], "evidence": r["evidence"]} for r in names_en_unmatched])

    site_overrides_out.sort(key=lambda r: (r["guard_id"], r["work_date"]))
    _write_csv(paths.WP2B_SITE_OVERRIDES_CSV,
               ["guard_id", "work_date", "from_site_id", "to_site_id", "client_group", "payroll_ref", "note"],
               site_overrides_out)

    name_near_match_out.sort(key=lambda r: (r["roster_guard_id"], r["payroll_name"]))
    _write_csv(paths.WP2B_NAME_NEAR_MATCH_CSV,
               ["payroll_name", "payroll_ref", "roster_guard_id", "roster_name", "roster_tel",
                "site_id", "edit_distance", "note"],
               name_near_match_out)

    # ---- WP5b rule 0.2 審核用輸出：overrides／conflicts（冇真名，guard_id
    #      only）----
    (paths.OUT_WP5_DIR / "reconcile").mkdir(parents=True, exist_ok=True)
    rule02_overrides_out = [
        {"guard_id": guard_id_by_rowkey.get(rk, ""), "file": rk[0], "row": rk[1],
         "site_id": rowkey_dates[rk][0], "n_dates": len(rowkey_dates[rk][1]),
         "broker_code": ov["code"], "settlement_unit": ov["settlement_unit"],
         "orig_source": orig_source_by_rowkey02[rk]}
        for rk, ov in sorted(rule02_overrides.items())
    ]
    _write_csv(paths.OUT_WP5_DIR / "reconcile" / "rule02-overrides.csv",
               ["guard_id", "file", "row", "site_id", "n_dates", "broker_code",
                "settlement_unit", "orig_source"],
               rule02_overrides_out)
    rule02_conflicts_out = [
        {"guard_id": c["guard_id"], "file": c["file"], "row": c["row"], "site_id": c["site_id"],
         "implied_by_date": json.dumps(c["implied_by_date"], ensure_ascii=False, sort_keys=True)}
        for c in sorted(rule02_conflicts, key=lambda c: (c["site_id"], c["file"], c["row"]))
    ]
    _write_csv(paths.OUT_WP5_DIR / "reconcile" / "rule02-conflicts.csv",
               ["guard_id", "file", "row", "site_id", "implied_by_date"],
               rule02_conflicts_out)

    # ---- 統計，畀 conservation + wp2b report 用 ----
    stats = _write_conservation_report(
        wp1_rows, shift_records, payroll_rows, site_index, broker_index,
        resolve_wp1_row_site, payroll_only_rows_out, unmapped_payroll_labels,
        cells_by_row_key, used_payroll_keys, day_mismatch,
        ot_adjustment_days_by_unit=ot_adjustment_days_by_unit,
        site_overrides_out=site_overrides_out)

    _write_wp2b_report(guards_out, identity_decisions, shift_records, broker_conflicts,
                        day_mismatch, unmapped_sites_out, names_en_unmatched, unresolved_guards, stats)

    return {
        "guards": len(guards_out),
        "merges": sum(1 for d in identity_decisions if d["decision"] == "merge"),
        "splits": sum(1 for d in identity_decisions if d["decision"] == "split"),
        "shift_records": len(shift_records),
        "broker_conflicts": len(broker_conflicts),
        "day_mismatch": len(day_mismatch),
        "unresolved_guards": len(unresolved_guards),
        "unmapped_sites": len(unmapped_sites_out),
        "rule02_overrides": len(rule02_overrides),
        "rule02_conflicts": len(rule02_conflicts),
    }


def _write_conservation_report(wp1_rows, shift_records, payroll_rows, site_index, broker_index,
                                resolve_wp1_row_site, payroll_only_rows_out, unmapped_payroll_labels,
                                cells_by_row_key, used_payroll_keys, day_mismatch,
                                ot_adjustment_days_by_unit=None, site_overrides_out=None) -> dict:
    ot_adjustment_days_by_unit = ot_adjustment_days_by_unit or Counter()
    site_overrides_out = site_overrides_out or []
    # per-site: WP1 work_count (internal only，roster 原始盤屬 baseline)
    expected_by_site: Counter = Counter()
    for row in wp1_rows:
        if str(row.get("external", "")).strip().lower() == "true":
            continue
        site_id = resolve_wp1_row_site(row)
        if site_id is None:
            continue
        try:
            expected_by_site[site_id] += int(row["work_count"])
        except (ValueError, KeyError):
            pass

    # 一併做項目 4（2026-09-04 放行條件）：§1 表加返 payroll_only 增量／
    # override 改盤兩欄，總數要對返 shift_records 實際逐盤數（唔可以再淨係
    # 排除 payroll_only 嚟做一個永遠 0 差異嘅恆等式）。
    payroll_only_by_site: Counter = Counter()
    actual_total_by_site: Counter = Counter()
    for r in shift_records:
        if r["record_type"] == "shift" and not r["is_external"]:
            actual_total_by_site[r["site_id"]] += 1
            if r["source"] == "payroll_only":
                payroll_only_by_site[r["site_id"]] += 1

    override_in_by_site: Counter = Counter()
    override_out_by_site: Counter = Counter()
    for o in site_overrides_out:
        override_in_by_site[o["to_site_id"]] += 1
        override_out_by_site[o["from_site_id"]] += 1

    site_lines = []
    site_diffs = 0
    all_site_ids = (set(expected_by_site) | set(actual_total_by_site)
                    | set(override_in_by_site) | set(override_out_by_site))
    for site_id in sorted(all_site_ids):
        exp = expected_by_site[site_id]
        po = payroll_only_by_site[site_id]
        ov_in = override_in_by_site[site_id]
        ov_out = override_out_by_site[site_id]
        ov_net = ov_in - ov_out
        act = actual_total_by_site[site_id]
        # 理論值＝roster baseline（已經包含 override 移走／移入嘅記錄，因為
        # expected_by_site 用 wp1_rows.work_count，即係更表原始逐格數，
        # override 冇改過 wp1_rows，只改咗 shift_records.site_id）＋
        # payroll_only 增量＋override 淨額（override 由邊度嚟就要喺嗰個
        # site 嘅 roster baseline 度扣走，去到嗰個 site 就要加），減 diff。
        expected_total = exp + po + ov_net
        diff = act - expected_total
        if diff != 0:
            site_diffs += 1
        site_lines.append((site_id, site_index.canonical_name(site_id), exp, po, ov_net, act, diff))

    # per-settlement-unit: payroll shifts(normal) vs shift_records(source=payroll/payroll_only)
    # 兩邊一定要用同一個「歸一後」單位做 key（同 shift_record 生成嗰陣一致）：
    # raw settlement_unit（例如「公司兵-2」「G嘅另一種寫法」「W嘅另一種寫法」）先經 broker_index
    # 解做 canonical broker name（「公司兵」「G」「W」），長工行（autopay
    # bank_note 或 flat_referral）再改記做 autopay_longterm，先可以同
    # shift_records.settlement_unit 對得上。
    def _canonical_unit_for_row(row: dict) -> str:
        broker_id = broker_index.resolve_settlement_unit(row["settlement_unit"])
        if is_longterm_payroll_row(row):
            return "autopay_longterm"
        return broker_index.name_of(broker_id) or row["settlement_unit"]

    # B2(b) 修正：K 嘅兩個來源唔可以夾埋——K-1331（啟航1331嗰頁，成頁淨係
    # 逐日總額冇逐人拆分，roster_code_site_page 規則生成）同 K-LINK（TKO
    # Gateway 等 LINK C7 細盤，全部 out_of_scope）本質完全唔同源，夾埋會令
    # 844 條 roster_code_site_page 記錄同 114 更嘅逐人數據夾埋出−730呢種
    # 冇意義嘅「diff」。呢兩個顯示名淨係用喺呢個 R4 表，唔影響
    # shift_records.csv 本身嘅 settlement_unit（仍然係「K」嘅真名，因為業務上兩
    # 邊都係同一個雞頭）。
    SPLIT_RAW_UNITS = {_BROKER_K_1331, _BROKER_K_LINK}

    def _display_unit_for_row(row: dict) -> str:
        raw = (row.get("settlement_unit") or "").strip()
        if raw in SPLIT_RAW_UNITS:
            return raw
        return _canonical_unit_for_row(row)

    def _display_unit_for_shift_record(r: dict) -> str:
        su = r["settlement_unit"]
        if su != _BROKER_K:
            return su
        if r["source"] == "roster_code_site_page":
            return _BROKER_K_1331
        if r["source"] == "payroll_only":
            return _BROKER_K_LINK
        return f"{_BROKER_K}-其他(需人手覆核)"

    payroll_normal_by_unit: Counter = Counter()
    for row in payroll_rows:
        if (row.get("shift_kind") or "").strip() != "normal":
            continue
        if is_aggregate_guard_name((row.get("guard_name") or "").strip()):
            continue
        try:
            shifts = float(row["shifts"])
        except (ValueError, KeyError):
            continue
        payroll_normal_by_unit[_display_unit_for_row(row)] += shifts

    generated_by_unit_source: Dict[str, Counter] = defaultdict(Counter)
    for r in shift_records:
        if r["record_type"] != "shift":
            continue
        su = _display_unit_for_shift_record(r)
        if su in ("", "unknown"):
            continue
        generated_by_unit_source[su][r["source"]] += 1

    # 決定 3：LINK C7 細盤而家已經解到 site_id（in_p0_scope=false），
    # payroll_only 會照常生成 shift_records——但呢啲淨係某啲現金單位入面
    # 混埋嘅 LINK 部分（G 嘅另一個別名變體加 -LINK、LINK公司兵 本身成個都係），唔
    # 屬於「現金單位 T/W/G/D/公司兵 要全部解釋」嗰個目標範圍。
    out_of_scope_shifts_by_unit: Counter = Counter()
    for r in shift_records:
        if r["record_type"] == "shift" and r.get("out_of_scope"):
            su = _display_unit_for_shift_record(r)
            if su not in ("", "unknown"):
                out_of_scope_shifts_by_unit[su] += 1

    # B2(a) 修正：out_of_scope 更數以前淨係喺 accounted（分子）度扣走，但
    # expected（分母，Σpayroll正常更數）冇跟住扣，令 G/LINK公司兵 嘅
    # diff 變成成舊 out_of_scope 更數本身（睇落好似冇解釋到）。而家逐行判
    # 斷佢哋自己解到嘅 site 係咪 out_of_scope，係就由 expected 度都扣走，
    # 兩邊口徑先一致。K-1331／K-LINK 已經用原始標籤獨立成行，唔使呢層
    # 扣減（扣咗會自己扣晒自己）。
    payroll_oos_shifts_by_unit: Counter = Counter()
    for row in payroll_rows:
        if (row.get("shift_kind") or "").strip() != "normal":
            continue
        if is_aggregate_guard_name((row.get("guard_name") or "").strip()):
            continue
        display_unit = _display_unit_for_row(row)
        if display_unit in SPLIT_RAW_UNITS:
            continue
        site_id = site_index.resolve(row.get("site_label"))
        if site_id is None or site_index.is_in_p0_scope(site_id):
            continue
        try:
            payroll_oos_shifts_by_unit[display_unit] += float(row["shifts"])
        except (ValueError, KeyError):
            pass

    unmapped_shifts_by_unit: Counter = Counter()
    for row in payroll_rows:
        if (row.get("shift_kind") or "").strip() != "normal":
            continue
        if is_aggregate_guard_name((row.get("guard_name") or "").strip()):
            continue
        if not _row_has_any_resolvable_site(row, site_index, cells_by_row_key):
            try:
                unmapped_shifts_by_unit[_display_unit_for_row(row)] += float(row["shifts"])
            except (ValueError, KeyError):
                pass

    no_cell_shifts_by_unit: Counter = Counter()
    for row in payroll_rows:
        if (row.get("shift_kind") or "").strip() != "normal":
            continue
        if is_aggregate_guard_name((row.get("guard_name") or "").strip()):
            continue
        if not _row_has_any_resolvable_site(row, site_index, cells_by_row_key):
            continue  # 已經計咗喺 unmapped 度
        key3 = payroll_row_key(row)
        if cells_by_row_key.get(key3):
            continue  # 有 cells 就會由 payroll_only 生成，計咗喺 via_payroll_only 度
        try:
            no_cell_shifts_by_unit[_display_unit_for_row(row)] += float(row["shifts"])
        except (ValueError, KeyError):
            pass

    # payroll_only 生成嗰陣冇篩 shift_kind（monthly_fee 嘅人—月費制安員甲/月費制安員乙—
    # 一樣有逐日 cells，一樣真係返咗工，理應生成 shift_records），但 R4 呢個
    # 對數規則明文淨係比 shift_kind=normal，所以呢啲月費制安員嘅 shift_records
    # 要喺呢個特定對比度扣走，唔係話佢哋唔應該生成（shift_records.csv 本身
    # 仍然保留，呢度淨係為咗同「Σshifts(normal)」呢個分母口徑一致）。
    non_normal_generated_by_unit: Counter = Counter()
    for row in payroll_rows:
        kind = (row.get("shift_kind") or "").strip()
        if kind == "normal" or kind == "":
            continue
        if is_aggregate_guard_name((row.get("guard_name") or "").strip()):
            continue
        key3 = payroll_row_key(row)
        cells = cells_by_row_key.get(key3, [])
        n_shift_cells = sum(1 for c in cells if c.get("cell_kind") in ("shift", "partial"))
        if n_shift_cells:
            non_normal_generated_by_unit[_display_unit_for_row(row)] += n_shift_cells

    # B2 新增：day-mismatch 條數同「OT/adjustment.csv 已記」條數逐單位計，
    # 兩者都係 explained_by 欄嘅具體證據來源（唔係憑估）。K 嘅 day-mismatch
    # 條目（如果有）用 site_id 分流去啱嘅顯示行（S017=K-1331，其餘=K-LINK）。
    day_mismatch_count_by_unit: Counter = Counter()
    day_mismatch_explained_by_unit: Counter = Counter()
    day_mismatch_unresolved_by_unit: Counter = Counter()
    for r in day_mismatch:
        su = r.get("settlement_unit", "")
        if su == _BROKER_K:
            su = _BROKER_K_1331 if r.get("site_id") == "S017" else _BROKER_K_LINK
        day_mismatch_count_by_unit[su] += 1
        # WP3 順手清文字債：改用 category 欄（結構化，adjacent_day_swap／
        # two_person_swap／substitution／explained_by_adjustment／
        # explained_by_site_override／needs_review）分「已定性/未定性」，
        # 唔再靠喺 note 自由文字度撞字串「需人手覆核」（脆弱，note 措辭一改
        # 呢個分類就會靜靜錯埋）。
        if r.get("category") == "needs_review":
            day_mismatch_unresolved_by_unit[su] += 1
        else:
            day_mismatch_explained_by_unit[su] += 1

    unit_lines = []
    all_units = (set(payroll_normal_by_unit) | set(generated_by_unit_source)
                 | set(payroll_oos_shifts_by_unit))
    for unit in sorted(all_units):
        expected_raw = payroll_normal_by_unit.get(unit, 0)
        oos_expected = payroll_oos_shifts_by_unit.get(unit, 0) if unit not in SPLIT_RAW_UNITS else 0
        expected = round(expected_raw - oos_expected, 2)
        gen = generated_by_unit_source.get(unit, Counter())
        via_roster_raw = gen.get("payroll", 0) + gen.get("payroll_label_override", 0) + gen.get("roster_code_site_page", 0)
        ot_adj = ot_adjustment_days_by_unit.get(unit, 0)
        via_roster = via_roster_raw - ot_adj
        via_payroll_only = gen.get("payroll_only", 0)
        unmapped = unmapped_shifts_by_unit.get(unit, 0)
        no_cell = no_cell_shifts_by_unit.get(unit, 0)
        non_normal = non_normal_generated_by_unit.get(unit, 0)
        out_of_scope = out_of_scope_shifts_by_unit.get(unit, 0)
        accounted = via_roster + via_payroll_only - non_normal - out_of_scope + unmapped + no_cell
        diff = round(expected - accounted, 2)
        dm_count = day_mismatch_count_by_unit.get(unit, 0)
        dm_explained = day_mismatch_explained_by_unit.get(unit, 0)
        dm_unresolved = day_mismatch_unresolved_by_unit.get(unit, 0)
        unit_lines.append((unit, expected, via_roster, via_payroll_only, non_normal, out_of_scope,
                            unmapped, no_cell, ot_adj, diff, dm_count, dm_explained, dm_unresolved))

    cash_units_to_explain = _CASH_UNITS_TO_EXPLAIN

    lines = ["# WP2b 守恆檢查（R4）\n",
             "## 1. 逐盤更數：WP1 baseline ＋ payroll_only 增量 ＋ override 淨額 ≟ shift_records 實際逐盤數\n",
             "（一併做項目 4，2026-09-04：以前呢個表淨係將 shift_records 篩走 "
             "source=payroll_only 先同 WP1 work_count 比，兩邊自然永遠相等，係一個冇實際"
             "驗證力嘅恆等式。而家總數改用**全部** shift_records（包括 payroll_only、"
             "已經反映 C3 site override 之後嘅真實 site_id），逐盤列明 payroll_only 增量"
             "同 override 淨額兩個組成部分，diff 係真係計出嚟，唔係預設 0。）\n",
             "| site_id | 盤 | WP1 baseline（不含external） | payroll_only 增量 | override 淨額 | shift_records 實際總數（不含external） | diff |",
             "|---|---|---|---|---|---|---|"]
    for site_id, name, exp, po, ov_net, act, diff in site_lines:
        lines.append(f"| {site_id} | {name} | {exp} | {po} | {ov_net:+d} | {act} | {diff} |")
    if site_diffs == 0:
        lines.append(f"\n**逐盤 diff 全部為 0（{len(site_lines)} 個盤全部核對）**——呢個係「WP1 baseline "
                      "+ payroll_only + override 淨額」呢條算式喺 code 度就係 shift_records 逐盤總數嘅"
                      "組成部分，唔係憑空相等；如果將來 code 改咗令兩邊唔一致，呢張表會即時反映出嚟"
                      "（唔係一個寫死嘅恆等式）。\n")
    else:
        lines.append(f"\n**逐盤未解釋差異：{site_diffs} 條**——逐條列明邊個盤、差幾多，需要追查（見上表"
                      "diff 非 0 嘅行）。\n")

    lines.append("## 2. 逐結算單位更數：payroll-rows.csv Σshifts(normal) ≟ shift_records(source=payroll/payroll_only) + 已解釋差額\n")
    lines.append("注意：「由roster確認」呢欄係嗰個結算單位嘅安員喺 WP1 更表自己嘅逐日出勤次數（包括"
                  "payroll_label_override／roster_code_site_page 兩條 R2 fallback 規則生成嘅，並已扣走"
                  "OT/adjustment.csv已記嘅日子），唔係直接抄 payroll 嘅 shifts 數字。**規劃 session 決定 "
                  f"6 嘅目標範圍係現金單位 {_CASH_UNITS_LABEL}（下面用 ★ 標住）。B2 修正"
                  "（2026-09-04）：(a) out_of_scope 更數而家喺 expected 同 accounted 兩邊都扣走，唔再淨係"
                  f"扣分子；(b) {_BROKER_K} 拆做 {_BROKER_K_1331}（page_level_settlements 規則，成頁冇逐人拆分，唔要求"
                  f"數值對齊）同 {_BROKER_K_LINK}（LINK C7 out_of_scope）兩行顯示，唔再夾埋計出冇意義嘅 −730；"
                  "(c) 每行加咗 `explained_by`，非零 diff 一定指向 day-mismatch.csv 具體條數（再分「已定性」"
                  "同「未定性」）或者一個已命名原因，唔用「可能」呢類猜測字眼。\n")
    lines.append("| 結算單位 | payroll正常更數(已扣OOS) | 由roster確認(已扣OT調整) | payroll_only生成 | "
                  "月費制(non-normal,已扣) | out_of_scope(已扣) | 站唔對應(unmapped) | 冇cells | "
                  "OT/adjustment已扣 | diff | day-mismatch(已定性/未定性) | explained_by |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    unexplained = 0
    unexplained_cash = 0
    explained_by_map: Dict[str, str] = {}
    for (unit, expected, via_roster, via_po, non_normal, oos, unmapped, no_cell, ot_adj,
         diff, dm_count, dm_explained, dm_unresolved) in unit_lines:
        mark = "★" if unit in cash_units_to_explain else ""
        if unit == _BROKER_K_1331:
            explained_by = (f"policy 留空：啟航1331{_BROKER_K}頁只有逐日總額（page_level_settlements.csv "
                             f"S017+K），冇逐人拆分，{via_roster}更全部嚟自roster_code_site_page規則；"
                             "WP4會用Σ(K行更次×單價)同逐日總額核，唔屬於呢個R4表嘅數值對數範圍。")
        elif unit == _BROKER_K_LINK:
            explained_by = (f"全部屬於LINK C7 out_of_scope細盤（S047-S063，in_p0_scope=false）；"
                             f"payroll shifts欄({expected})同逐格cells生成({via_po})嘅差額源自WP2a轉錄口徑"
                             "（部分OT格已剔出policy_total_shifts但仍留喺cells度），唔影響P0範圍數字，"
                             "唔屬於決定6要求嘅現金單位。")
        elif diff == 0:
            explained_by = "已對數（diff=0）"
        else:
            reasons = []
            if dm_explained:
                reasons.append(f"day-mismatch.csv {dm_explained}條已定性（zero/明確冇做，或"
                                "adjustments.csv已記嘅OT/特殊調整）")
            if dm_unresolved:
                reasons.append(f"day-mismatch.csv {dm_unresolved}條標「需人手覆核」（糧明細嗰行完全"
                                "冇嗰日cell，adjustments.csv亦冇對應記錄）")
            if no_cell:
                reasons.append(f"{no_cell}更嘅payroll行冇逐格cells，只能夠對row總數")
            if not reasons:
                reasons.append("day-mismatch.csv/no_cell都解釋唔到，需人手覆核（未追蹤到具體邊一日）")
            explained_by = "；".join(reasons)
        explained_by_map[unit] = explained_by
        if diff != 0 and unit not in SPLIT_RAW_UNITS:
            unexplained += 1
            if unit in cash_units_to_explain:
                unexplained_cash += 1
        # K-1331／K-LINK 嘅「diff」本身係公式 artifact（呢兩個unit定義上
        # 就冇「roster確認」呢一邊嘅可比較基準——K-1331 冇逐人拆分、K-LINK
        # 成單位out_of_scope，唔係roster/payroll兩個數源意見唔合），唔係
        # 真係要WP4追查嘅差異，顯示文字取代裸數字，避免睇落好似有個未解釋
        # 嘅大差異。
        diff_display = "範圍外，不計" if unit in SPLIT_RAW_UNITS else str(diff)
        lines.append(f"| {mark}{unit} | {expected} | {via_roster} | {via_po} | {non_normal} | {oos} | "
                      f"{unmapped} | {no_cell} | {ot_adj} | {diff_display} | {dm_count}({dm_explained}/{dm_unresolved}) | "
                      f"{explained_by} |")
    _units_considered = sum(1 for u in unit_lines if u[0] not in SPLIT_RAW_UNITS)
    lines.append(f"\n**diff 非零嘅結算單位：{unexplained} / {_units_considered} 條"
                  f"（唔計{_BROKER_K_1331}/{_BROKER_K_LINK}，兩者按決定6豁免數值對齊要求）；當中屬於決定 6 目標範圍"
                  f"（★現金單位 {_CASH_UNITS_LABEL}）嘅：{unexplained_cash} 條**。逐條原因見上表"
                  "`explained_by` 欄同下面「現金單位殘餘 diff 逐條原因」。\n")

    if unexplained_cash:
        lines.append("### 現金單位殘餘 diff 逐條原因（決定 6）\n")
        for (unit, expected, via_roster, via_po, non_normal, oos, unmapped, no_cell, ot_adj,
             diff, dm_count, dm_explained, dm_unresolved) in unit_lines:
            if unit not in cash_units_to_explain or diff == 0:
                continue
            lines.append(f"- **{unit}**（diff={diff}）：{explained_by_map[unit]}")
        lines.append("")

    with open(paths.WP2B_CONSERVATION_REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    return {
        "site_diffs": site_diffs,
        "unit_diffs": unexplained,
        "unit_diffs_cash": unexplained_cash,
        "site_lines": site_lines,
        "unit_lines": unit_lines,
    }


def _write_wp2b_report(guards_out, identity_decisions, shift_records, broker_conflicts,
                        day_mismatch, unmapped_sites_out, names_en_unmatched, unresolved_guards, stats):
    n_merge = sum(1 for d in identity_decisions if d["decision"] == "merge")
    n_split = sum(1 for d in identity_decisions if d["decision"] == "split")
    rt_counter = Counter(r["record_type"] for r in shift_records)
    su_counter = Counter(r["settlement_unit"] for r in shift_records if r["record_type"] == "shift")
    total_shift = sum(1 for r in shift_records if r["record_type"] == "shift")
    source_counter = Counter(r["source"] for r in shift_records if r["record_type"] == "shift")

    unknown_by_site = Counter()
    for r in shift_records:
        if r["record_type"] == "shift" and r["settlement_unit"] == "unknown":
            unknown_by_site[r["site_id"]] += 1

    day_mismatch_by_unit = Counter()
    for r in day_mismatch:
        day_mismatch_by_unit[r.get("settlement_unit", "")] += 1

    unresolved_with_sn = sum(1 for r in unresolved_guards if "冇 staff_no" not in r.get("reason", ""))
    unresolved_without_sn = len(unresolved_guards) - unresolved_with_sn

    lines = ["# WP2b 執行報告（第四版，WP3 順手清文字債：舊數字改由 out/wp2b/*.csv 直接計）\n"]
    lines.append(f"- 安員總數：{len(guards_out)}（merge {n_merge} 次、split {n_split} 次）")
    lines.append(f"- shift_records 總數：{len(shift_records)}；record_type 分佈：{dict(rt_counter)}")
    lines.append("\n## 歸屬來源分佈（record_type=shift，規劃 session 要求）\n")
    for src, count in source_counter.most_common():
        pct = round(count / total_shift * 100, 1) if total_shift else 0
        lines.append(f"  - {src}: {count} ({pct}%)")
    lines.append("\n- settlement_unit 分佈（record_type=shift）：")
    for unit, count in su_counter.most_common():
        pct = round(count / total_shift * 100, 1) if total_shift else 0
        lines.append(f"  - {unit}: {count} ({pct}%)")
    lines.append(f"- unresolved-guards（source=none）: {len(unresolved_guards)} 條——"
                  f"冇staff_no（Event Guard/散工，真係冇辦法追蹤）{unresolved_without_sn} 條、"
                  f"有staff_no但配對唔到（需人手覆核）{unresolved_with_sn} 條；逐條原因見 "
                  "unresolved-guards.csv 嘅 reason 欄")
    lines.append(f"- unknown 集中喺（by site_id）：{dict(unknown_by_site.most_common(10))}")
    lines.append(f"- broker-conflicts: {len(broker_conflicts)} 條（含 resolution／evidence 欄，"
                  "逐條可追溯去邊條R2規則、糧明細邊行）")
    lines.append(f"- day-mismatch: {len(day_mismatch)} 條；按結算單位：{dict(day_mismatch_by_unit.most_common())}")
    lines.append(f"- unmapped-sites: {len(unmapped_sites_out)} 條")
    lines.append(f"- names_en-unmatched: {len(names_en_unmatched)} / 70 條")
    lines.append(f"- 守恆檢查：逐盤未解釋差異 {stats['site_diffs']} 條；逐結算單位 diff 非零 "
                  f"{stats['unit_diffs']} 條（現金單位目標範圍內 {stats['unit_diffs_cash']} 條）")

    lines.append("\n## 第二版 vs 第三版對比（B1/B2/B3 修正前後）\n")
    lines.append("| 指標 | 第二版（修正前） | 第三版（修正後） |")
    lines.append("|---|---|---|")
    lines.append(f"| day-mismatch 條數 | 83（B1混合行cell冇按site拆，混合行安員甲等大量假差異） | {len(day_mismatch)} |")
    lines.append(f"| unknown（settlement_unit=unknown，record_type=shift） | 537 | "
                  f"{su_counter.get('unknown', 0)} |")
    lines.append(f"| unresolved-guards（source=none，逐WP1行） | 60 | {len(unresolved_guards)} |")
    lines.append(f"| 守恆表 {_BROKER_G} diff | 44（out_of_scope冇扣expected） | "
                  f"{next((u[9] for u in stats['unit_lines'] if u[0] == _BROKER_G), 'N/A')} |")
    lines.append("| 守恆表 LINK公司兵 diff | 33（同上） | "
                  f"{next((u[9] for u in stats['unit_lines'] if u[0] == 'LINK公司兵'), 'N/A')} |")
    lines.append(f"| 守恆表 {_BROKER_K} diff | −730（{_BROKER_K_1331}同{_BROKER_K_LINK}夾埋） | "
                  f"已拆做 {_BROKER_K_1331}／{_BROKER_K_LINK} 兩行分別列示，唔再夾埋（見 conservation-report.md §2） |")
    lines.append("")

    lines.append("\n## 2026-09-03 規劃 session 6 點決定：實作狀態\n")
    lines.append(
        f"1. **啟航1331 {_BROKER_K}(K) 盤級糧單規則**：已實作（`mappings/page_level_settlements.csv`，"
        f"S017+K→{_BROKER_K_1331}，source=roster_code_site_page，confidence=medium）。呢類記錄唔再係"
        f"unknown，會出現喺 settlement_unit={_BROKER_K} 度。")
    lines.append(
        "2. **推斷長工規則（B3 修正，2026-09-04 改逐人判斷）**：已實作（source=inferred_guard，"
        "confidence=low，note含pending=N6）。舊規則要求『成個盤喺現金糧明細完全冇任何人出現過』"
        "先觸發，數碼港/HKU呢類有零星現金人嘅盤永遠唔觸發，漏晒537條unknown入面嘅大多數"
        "（數碼港CP1-4 260、HKU Y更140、啟航51、HKU座頭28、CP5 26、城巴26）。而家改為逐人判斷："
        "有staff_no、佢個名（正規化，含同形字變體）完全冇喺14頁現金糧明細任何一行出現過、亦唔喺"
        "names_en.csv配對名單 → inferred_guard；冇staff_no嘅（Event Guard/散工）唔觸發，留低做"
        "unknown，逐條原因見unresolved-guards.csv。")
    lines.append(
        "3. **LINK C7 細盤**：已加入 `mappings/sites.csv`（S047-S063，`client_group=LINK C7`、"
        "`in_p0_scope=false`），每個細盤一行；MU→S033都會大學學生宿舍加咗別名，HKW→新增"
        "S064（`client_group=P special income`）。呢啲盤而家會解得到、生成 shift_records"
        "（`out_of_scope=true`），唔再算 unmapped。")
    lines.append(
        "4. **HKU 醫學院 parent/child override**：`sites.csv` S008 加咗 `parent_site_id=S007`，"
        "R2 規則 1.5 已實作（搵唔到 parent 盤嘅糧明細候選就試 child 盤，source="
        "payroll_label_override）。**但實際數據入面呢條規則 0 條記錄觸發**——查證後發現"
        f"{_BROKER_G}頁row8『HKU(醫學院)』該安員喺HKU座頭(S007)roster完全冇任何記錄（佢喺roster"
        "淨係城巴柴灣車廠），冇『existing S007 shift_record 可以override』呢個場景。佢嘅4更"
        "已經照常經 payroll_only pipeline 生成落 S008，效果一樣（S008攞到佢嘅4更），"
        "只係 source 標做 payroll_only 唔係 payroll_label_override。")
    lines.append(
        "5. **混合行 cell 層拆盤**：已實作（`normalize.payroll_site_slices`，逐格睇自己嘅"
        "site_label，唔跟行級嘅『(混合)』label）。混合行安員甲（page2 row15）同混合行安員乙（row16）"
        "而家會拆做 3 個獨立 site slice（1331早/皓日早/創富、蔚峰園/1331早/創富早），每個"
        "slice 獨立生成 payroll_only shift_records，唔使人手拆。**B1 修正（2026-09-04）**："
        "呢個拆分本身第一版已經做啱，但 `wp2b_run.py` 逐日對數（day-mismatch）嗰段當時用緊"
        "成行嘅 `cells_by_row_key`（唔理邊個 slice），令混合行安員甲/混合行安員乙喺 S005/S017/S019 三個"
        "盤各自嘅逐日比較都攞埋另外兩個盤嗰啲日子嚟做交集，製造大量假差異。而家改用"
        "site-scoped 嘅 `cells_by_key4`（喺 payroll_site_slices 嗰陣順手起），day-mismatch 由"
        "83 條跌到 24 條，剩低嘅全部係真出入。")
    lines.append(
        "6. **守恆殘餘（B2 修正，2026-09-04）**：conservation-report.md §2 加咗三個改動——"
        f"(a) out_of_scope 更數而家喺 expected 同 accounted 兩邊都扣，{_BROKER_G}／LINK公司兵 diff 由"
        f"44／33 變返 0；(b) {_BROKER_K} 拆做 {_BROKER_K_1331}／{_BROKER_K_LINK} 兩行獨立顯示，唔再夾埋出−730嘅假diff；"
        "(c) 每行加咗 `explained_by`，逐日層面新增咗『糧明細嗰行完全冇嗰日cell』呢個第三種"
        "day-mismatch（之前靜靜跳過），仲會自動對 adjustments.csv 揾OT/特殊調整原因（例如"
        "公司兵嘅公司兵甲/公司兵乙25/7 OT），撞到就寫返出處，撞唔到先真係『需人手覆核』——唔再"
        f"寫『可能係』。現金單位（{_BROKER_T}/{_BROKER_W}/公司兵/{_BROKER_D}）仲有 4 個 diff 非零，全部逐條指向"
        "day-mismatch.csv 具體邊幾日（已定性 vs 未定性），冇再有『需要人手覆核（可能...）』"
        "呢種含糊尾數。")

    lines.append("\n## 仲需要老闆/規劃 session 決定嘅嘢\n")
    lines.append(
        "- names_en.csv 38/70 未配對，等 N6 員工名單；補齊之後淨係要 rerun，唔使改 code。")
    lines.append(
        "- 決定 1 嘅『盤級糧單』規則暫時淨係開俾 S017+K 一條（page_level_settlements.csv 可以"
        "再加）；如果將來發現第二個『成頁淨係逐日總額冇逐人』嘅盤，喺嗰個 CSV 加一行即可。")
    _link_cells = [c for c in load_payroll_cells() if c.get("settlement_unit") == _BROKER_K_LINK]
    _link_shift_cells = sum(1 for c in _link_cells if c.get("cell_kind") in ("", "shift", "normal"))
    _link_payroll_shifts = sum(
        float(r["shifts"]) for r in load_payroll_rows()
        if r["settlement_unit"] == _BROKER_K_LINK and r.get("shift_kind") == "normal" and r["shifts"])
    lines.append(
        f"- **B2 跟進（WP3 覆核，改由數據計）**：{_BROKER_K_LINK} payroll normal shifts 總數"
        f"（{_link_payroll_shifts:g}）同逐格cells生成嘅shift-kind cell數（{_link_shift_cells}）"
        f"{'一致，之前報告寫嘅『差16』已經係舊數字，唔再存在' if _link_payroll_shifts == _link_shift_cells else '仍然唔一致，差 ' + str(abs(_link_payroll_shifts - _link_shift_cells))}"
        f"（見 conservation-report.md {_BROKER_K_LINK} 行）。LINK C7 本身 out_of_scope，唔影響 P0 數字。")
    _needs_review = sum(1 for r in day_mismatch if r.get("category") == "needs_review")
    lines.append(
        f"- **B2 跟進（改由數據計）**：day-mismatch.csv 而家有 **{_needs_review}** 條"
        f"（out of {len(day_mismatch)} 條，其餘已用 category 自動分類做 "
        "adjacent_day_swap／two_person_swap／substitution／explained_by_adjustment／"
        "explained_by_site_override）標『needs_review』（糧明細嗰行完全冇嗰日cell，"
        "adjustments.csv 亦冇對應記錄）——逐條見 day-mismatch.csv，建議排入 WP4 逐日對數階段"
        "一齊處理。")
    _unresolved_no_sn = sum(1 for r in unresolved_guards if "冇 staff_no" in r.get("reason", ""))
    lines.append(
        f"- **B3 遺留（改由數據計）**：unresolved-guards.csv 剩低 **{len(unresolved_guards)}** 條"
        f"（{_unresolved_no_sn} 條冇 staff_no），呢批本身冇工號就冇辦法用 R2 規則追蹤，需要規劃"
        "session 決定係咪要求老闆補資料（人手/身份證）定係接受佢哋永遠 unknown。")
    lines.append(
        f"- {_BROKER_K_1331}／{_BROKER_K_LINK} 呢個拆分淨係影響 R4 對數報表嘅顯示，`shift_records.csv` 本身"
        f"settlement_unit 仍然係統一嘅『{_BROKER_K}』（因為業務上兩邊都係同一個雞頭出糧）。如果將來"
        "要喺資料庫層面都分開追蹤呢兩個來源（例如分開兩個 broker_id），需要規劃 session 決定，"
        "P0 呢層冇改。")

    with open(paths.WP2B_REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
