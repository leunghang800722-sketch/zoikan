"""Load the human-editable CSV mapping tables (mappings/*.csv).

Per P0-執行計劃 §6 原則：對照表全部係人手可睇可改嘅 CSV，唔埋喺 code。
"""
import csv
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from .paths import (
    BROKERS_CSV,
    CELL_CODES_CSV,
    INVOICE_DAILY_SHIFTS_CSV,
    LONGTERM_STAFF_CSV,
    MASTER_GUARD_BROKER_CSV,
    MASTER_SITE_DAY_BROKER_CSV,
    NAMES_EN_CSV,
    PAGE_LEVEL_SETTLEMENTS_CSV,
    RANK_BILLING_CSV,
    REFERRAL_FEE_RATES_CSV,
    SITES_CSV,
    STATUS_CODES_CSV,
    STAT_ROW_LABELS_CSV,
)

DEFAULT_BILLING_GROUP = "per_shift"


def load_cell_codes(path: Path = CELL_CODES_CSV) -> Dict[str, str]:
    """Return {code: kind} e.g. {'N': 'work', 'RD': 'leave', ...}."""
    mapping = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            code = row["code"].strip()
            kind = row["kind"].strip()
            mapping[code] = kind
    return mapping


def load_cell_code_labels(path: Path = CELL_CODES_CSV) -> Dict[str, str]:
    """Return {code: description}，畀 shift_types.csv 嘅 `label` 欄用（一併做
    項目 7）——格仔代號本身喺 cell_codes.csv 已經有中文說明，唔使再開一個
    對照表。"""
    mapping = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            mapping[row["code"].strip()] = row["description"].strip()
    return mapping


def load_stat_row_labels(path: Path = STAT_ROW_LABELS_CSV) -> Dict[str, str]:
    """Return {label: role} e.g. {'Total': 'total', '所需人手': 'required', ...}."""
    mapping = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            label = row["label"].strip()
            role = row["role"].strip()
            mapping[label] = role
    return mapping


def load_rank_billing(path: Path = RANK_BILLING_CSV) -> Dict[str, str]:
    """Return {rank: billing_group}, e.g. {'早更IC': 'monthly_ic'}.

    Only *exceptions* to the default need a row here — any rank not listed
    falls back to `DEFAULT_BILLING_GROUP` ('per_shift') at the call site, so
    this table never needs to enumerate every rank in every roster file.
    """
    mapping = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rank = row["rank"].strip()
            billing_group = row["billing_group"].strip()
            mapping[rank] = billing_group
    return mapping


def _split_aliases(raw: str) -> List[str]:
    """aliases 欄用 ';' 分隔多個別名，空字串一律跳過。"""
    if not raw:
        return []
    return [a.strip() for a in raw.split(";") if a.strip()]


def load_sites(path: Path = SITES_CSV) -> List[dict]:
    """Return list of site dicts: {site_id, canonical_name, client_name,
    client_group, billing_model, monthly_fee, aliases: [str,...],
    in_p0_scope: bool, parent_site_id: str}.

    `in_p0_scope=false`（例如 LINK C7 細盤、個別雞頭 Event 嘅 HKW）同
    `parent_site_id`（例如 HKU 醫學院 嘅 parent 係 HKU座頭）係 2026-09-03
    規劃 session 決定加嘅兩個欄位，冇填就當 in_p0_scope=true、parent_site_id=''。
    `client_name`（一併做項目 7，2026-09-04：欄名由 `client` 改做
    `client_name`，同《在勤系統設計文件》§3.2 sites 表對齊）同 `monthly_fee`
    （IFC 35000、數碼港 CP5 IC 32000、M+ 16400——後者原本已經寫喺 alias
    「M+ (16400/月)」，呢度攞出嚟做正式欄位）係新加欄，冇填就係 ''。

    B2（Opus 對抗式驗收第四輪）：兩個真實客戶公司名嘅 `client_name` 喺
    `mappings/sites.csv`（會入 git）刻意
    留空（S036/S037/S045/S046），執行時經 `private_mappings.site_client_name()`
    讀 gitignored 嘅 `data/mappings-private/client-names.json` 補返；冇
    private 檔就 fallback 用空字串（同冇填一樣，行為上等於「呢個 site
    有冇特別客戶」呢個分類判斷會跳過，唔會靜默扮匹配成功）。
    """
    from .private_mappings import site_client_name

    sites = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            in_scope_raw = (row.get("in_p0_scope") or "true").strip().lower()
            site_id = row["site_id"].strip()
            client_name_val = (row.get("client_name") or "").strip()
            if not client_name_val:
                client_name_val = site_client_name(site_id)
            sites.append({
                "site_id": site_id,
                "canonical_name": row["canonical_name"].strip(),
                "client_name": client_name_val,
                "client_group": row["client_group"].strip(),
                "billing_model": row["billing_model"].strip(),
                "monthly_fee": (row.get("monthly_fee") or "").strip(),
                "aliases": _split_aliases(row["aliases"]),
                "in_p0_scope": in_scope_raw not in ("false", "0", "no"),
                "parent_site_id": (row.get("parent_site_id") or "").strip(),
            })
    return sites


def load_page_level_settlements(path: Path = PAGE_LEVEL_SETTLEMENTS_CSV) -> List[dict]:
    """規劃 session 決定嘅「盤級糧單」規則：邊個盤嘅糧明細只有逐日總額冇逐人
    拆分（例如啟航1331嘅K-1331頁），呢種情況先准用更表 A 欄 broker_code
    做 fallback。回傳 [{site_id, roster_broker_code, settlement_unit,
    confidence, note}, ...]。

    PDPO：`settlement_unit` 欄喺 git-tracked 嘅
    `mappings/page_level_settlements.csv` 用代號前綴 template（例如
    `K-1331`）存，呢度經 `private_mappings.resolve_settlement_unit_template`
    換返真名（冇 private 檔就原句返回代號 template，唔會靜默扮成功）。"""
    from .private_mappings import resolve_settlement_unit_template

    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            roster_broker_code = row["roster_broker_code"].strip()
            rows.append({
                "site_id": row["site_id"].strip(),
                "roster_broker_code": roster_broker_code,
                "settlement_unit": resolve_settlement_unit_template(
                    row["settlement_unit"].strip(), roster_broker_code),
                "confidence": row["confidence"].strip(),
                "note": row["note"].strip(),
            })
    return rows


def load_referral_fee_rates(path: Path = REFERRAL_FEE_RATES_CSV) -> List[dict]:
    """WP5c必修13（P0-執行計劃.md §8 item 13）：長工雞頭費／更嘅人手費率表
    （broker_id, site_id 或 'DEFAULT', rate_per_shift）。由老闆總表「長工
    雞頭費」20行逐block反推證實（見`master_roster.validate_referral_fee_
    rates()`）——大部分盤 50（K）／30（W/T/G），啟航1331（K
    60／W 50）同Weave（T 50）係高單價例外（真名見
    data/mappings-private/brokers.csv）。"""
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rows.append({
                "broker_id": row["broker_id"].strip(),
                "site_id": row["site_id"].strip(),
                "rate_per_shift": row["rate_per_shift"].strip(),
                "note": row["note"].strip(),
            })
    return rows


def referral_fee_rate_for(broker_id: str, site_id: str,
                           rates: List[dict] = None) -> Tuple[str, str]:
    """回傳 (rate_per_shift_str, evidence_note) 或者 ('', '') 搵唔到。site_id
    專屬rate優先於呢個broker嘅DEFAULT rate。"""
    rates = rates if rates is not None else load_referral_fee_rates()
    by_key = {(r["broker_id"], r["site_id"]): r for r in rates}
    r = by_key.get((broker_id, site_id)) or by_key.get((broker_id, "DEFAULT"))
    if not r:
        return "", ""
    return r["rate_per_shift"], r["note"]


def load_master_guard_broker(path: Path = MASTER_GUARD_BROKER_CSV) -> Dict[str, dict]:
    """WP5-C §11：逐 guard_id 由老闆「在勤總表」逐日 broker 分佈確認嘅
    settlement_unit（`master_roster.build_guard_broker_confirmations()` 產生，
    冇真名）。回傳 {guard_id: {confirmed_broker_code, confirmed_settlement_unit,
    confidence, note, n_matched, n_total}}；冇檔（未行過 `run-wp5`）就回傳
    空 dict，normalize.py 嘅 rule 0.1 會自動跌落舊規則，唔會 fail。"""
    if not path.exists():
        return {}
    out: Dict[str, dict] = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            gid = row["guard_id"].strip()
            if not gid:
                continue
            out[gid] = {
                "confirmed_broker_code": row["confirmed_broker_code"].strip(),
                "confirmed_settlement_unit": row["confirmed_settlement_unit"].strip(),
                "confidence": row["confidence"].strip(),
                "note": row["note"].strip(),
                "n_matched": row["n_matched"].strip(),
                "n_total": row["n_total"].strip(),
            }
    return out


def load_master_site_day_broker_counts(path: Path = MASTER_SITE_DAY_BROKER_CSV) -> Dict[Tuple[str, str], "Counter"]:
    """WP5b rule 0.2：{(site_id, work_date): Counter({broker_code: count})}，
    由 `master_roster.build_site_day_broker_counts()` 產生（冇真名），畀
    normalize.py 嘅 rule 0.2 做逐日消去法 fallback。冇檔（未行過 run-wp5）
    就回傳空 dict，rule 0.2 自動跌落舊規則，唔會 fail。"""
    from collections import Counter
    out: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    if not path.exists():
        return out
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            site_id = row["site_id"].strip()
            work_date = row["work_date"].strip()
            code = row["broker_code"].strip()
            try:
                n = int(row["count"])
            except (KeyError, ValueError):
                continue
            if site_id and work_date and code:
                out[(site_id, work_date)][code] += n
    return out


def load_invoice_daily_shifts(path: Path = INVOICE_DAILY_SHIFTS_CSV) -> List[dict]:
    """WP2b-d（2026-09-10）：SOGO CWB（S045）／Garden East（S046）呢類「月結
    以外」site，發票逐日更次由老闆確認（見P0-執行計劃§8 D3）；一行一更
    （同一日多過一更就重複幾行，例如SOGO 7/21兩行）。冇檔案（例如未來月
    份未補資料）就回傳空list，唔阻住run-wp2b。"""
    if not path.exists():
        return []
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rows.append({
                "site_id": row["site_id"].strip(),
                "work_date": row["work_date"].strip(),
                "evidence": row["evidence"].strip(),
            })
    return rows


def load_brokers(path: Path = BROKERS_CSV) -> List[dict]:
    """Return list of broker dicts: {broker_id, code, canonical_name,
    aliases: [str,...], kind, settlement_type}.

    PDPO：雞頭真名（代號 K／W／G／D／T）嘅 `canonical_name`／`aliases` 喺
    `mappings/brokers.csv`（會入 git）刻意留空，執行時經
    `private_mappings.py` 讀 `data/mappings-private/brokers.csv`
    （gitignore，本機專用）補返真名同糧明細頁實際出現嘅別名寫法（例如
    糧明細頁實際寫法）；冇 private 檔就 fallback 用代號本身，並 log warning（見
    `private_mappings.broker_canonical_name`），唔會靜默扮有真名比對成功。
    其餘代號（Y＝公司兵、B08＝個別雞頭 等內部/業務稱呼，唔係要保密嘅個人
    PDPO 資料）嘅 canonical_name 直接喺呢個 git-tracked 檔，唔使查 private
    檔。"""
    from .private_mappings import broker_aliases, broker_canonical_name, load_private_brokers

    private = load_private_brokers()
    brokers = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            code = row["code"].strip()
            canonical_name = row["canonical_name"].strip()
            aliases = _split_aliases(row["aliases"])
            if not canonical_name and code:
                canonical_name = broker_canonical_name(code, private)
                aliases = aliases + broker_aliases(code, private)
            brokers.append({
                "broker_id": row["broker_id"].strip(),
                "code": code,
                "canonical_name": canonical_name,
                "aliases": aliases,
                "kind": row["kind"].strip(),
                "settlement_type": row["settlement_type"].strip(),
            })
    return brokers


def load_status_codes(path: Path = STATUS_CODES_CSV) -> Dict[str, str]:
    """Return {code: normalized} e.g. {'OFF': 'RD', 'NPL': 'NL', ...}."""
    mapping = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            mapping[row["code"].strip()] = row["normalized"].strip()
    return mapping


def load_names_en(path: Path = NAMES_EN_CSV) -> List[dict]:
    """Return list of {english_name, name_zh, confidence, tier, evidence}."""
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rows.append({
                "english_name": row["english_name"].strip(),
                "name_zh": row["name_zh"].strip(),
                "confidence": row["confidence"].strip(),
                "tier": row["tier"].strip(),
                "evidence": row["evidence"].strip(),
            })
    return rows


def load_longterm_staff(path: Path = LONGTERM_STAFF_CSV) -> List[dict]:
    """WP2b-c：讀 Maxwell Corporation Limited 2026-07 長工月薪表（老闆交，
    `data/mappings-private/longterm_staff_2026-07.csv`，48 人）。Return
    list of {staff_no_mw, name_zh, name_en, site_label, position,
    working_hour, monthly_salary, daily_avg, working_days, net_basic}。

    呢張表用嚟喺 `resolve_settlement_for_row` 加一層優先規則：安員（正規化
    中文名）喺呢張表出現 → settlement_unit=autopay_longterm，
    source=maxwell_payroll，confidence=high，排喺「糧明細逐人」之後、
    「盤級糧單規則（例如啟航1331 K 行歸 K）」之前——長工月薪由公司直接
    出糧，唔應該因為更表 A 欄寫住雞頭代號就被歸做嗰個雞頭嘅更次。
    """
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            rows.append({
                "staff_no_mw": row["staff_no_mw"].strip(),
                "name_zh": row["name_zh"].strip(),
                "name_en": row["name_en"].strip(),
                "site_label": row["site_label"].strip(),
                "position": row["position"].strip(),
                "working_hour": row["working_hour"].strip(),
                "monthly_salary": row["monthly_salary"].strip(),
                "daily_avg": row["daily_avg"].strip(),
                "working_days": row["working_days"].strip(),
                "net_basic": row["net_basic"].strip(),
            })
    return rows
