"""③ normalize: 對照表驅動嘅盤名/雞頭/狀態歸一、安員身份合併（R1）、
結算單位反推（R2）、更次記錄生成（R3）、守恆檢查（R4）。

對應 P0-執行計劃.md §6 pipeline ③ 同 §7 WP2b 驗收準則。輸入係 WP1 嘅
out/wp1/*（rows.csv／records.jsonl／summary.csv／sheet-stats.csv）同 WP2a 嘅
data/2026-07/transcribed/*（payroll-rows.csv／payroll-cells*.csv／
adjustments.csv／payroll-pages.csv）。輸出全部喺 out/wp2b/*。

原則（跟 README 一致）：對照表（mappings/sites.csv、brokers.csv、
status_codes.csv、names_en.csv）人手可改，改完 rerun 就會反映落全部輸出度；
解讀唔到嘅盤名／安員一律入對應嘅「未解清單」，唔准估。
"""
import csv
import json
import re
from collections import Counter, defaultdict
from typing import Dict, List, Optional, Tuple

from . import paths
from .mappings_io import (
    load_brokers,
    load_names_en,
    load_rank_billing,
    load_sites,
    load_status_codes,
)

# ---------------------------------------------------------------------------
# Name / site normalization
# ---------------------------------------------------------------------------

# 同形字表（P0-執行計劃 §3.8）：只用嚟比對身份，name_zh 保留原文最常見寫法。
HOMOGLYPHS = {
    "黄": "黃",
    "洁": "潔",
    "鳯": "鳳",
    "吴": "吳",
}


def normalize_name(name: Optional[str]) -> str:
    if not name:
        return ""
    s = "".join(HOMOGLYPHS.get(ch, ch) for ch in name.strip())
    s = re.sub(r"\s+", "", s)
    return s


def levenshtein(a: str, b: str) -> int:
    """標準編輯距離，用嚟做 C3「近似名」規則（真實案例見 P0-執行計劃.md，
    唔喺 code 度重複真實姓名，PDPO；edit distance ≤1）。人名好短（2-4
    字），O(n*m) DP 足夠。"""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * lb
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[lb]


def normalize_tel(tel: Optional[str]) -> str:
    if not tel:
        return ""
    return re.sub(r"\s+", "", tel.strip())


_TRAILING_SITE_MARKERS = re.compile(
    r"(早更|夜更|日更|早|夜)$"
)


def normalize_site_label(label: Optional[str]) -> str:
    """去括號、去尾綴「早/夜/早更/夜更」、去空白，用嚟做盤名別名比對嘅 key。

    只做輕量正規化——真正嘅解析靠 mappings/sites.csv 嘅 aliases 列表，呢個
    function 淨係減少要人手列晒每個「XX(早)/XX(夜)」變體嘅重複勞動。
    """
    if not label:
        return ""
    s = label.strip()
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)  # 去尾嘅括號
    s = s.strip()
    prev = None
    while prev != s:
        prev = s
        s = _TRAILING_SITE_MARKERS.sub("", s).strip()
    s = re.sub(r"\s+", "", s)
    return s


# ---------------------------------------------------------------------------
# Site / broker resolution index
# ---------------------------------------------------------------------------

class SiteIndex:
    def __init__(self, sites: List[dict]):
        self.sites = {s["site_id"]: s for s in sites}
        self._lookup: Dict[str, str] = {}
        for s in sites:
            keys = {s["canonical_name"]} | set(s["aliases"])
            for k in keys:
                for variant in (k, normalize_site_label(k)):
                    if variant and variant not in self._lookup:
                        self._lookup[variant] = s["site_id"]

    def resolve(self, raw_label: Optional[str]) -> Optional[str]:
        if not raw_label:
            return None
        raw_label = raw_label.strip()
        if raw_label in self._lookup:
            return self._lookup[raw_label]
        norm = normalize_site_label(raw_label)
        return self._lookup.get(norm)

    def canonical_name(self, site_id: str) -> str:
        return self.sites[site_id]["canonical_name"]

    def is_in_p0_scope(self, site_id: str) -> bool:
        return self.sites[site_id].get("in_p0_scope", True)

    def parent_of(self, site_id: str) -> Optional[str]:
        return self.sites[site_id].get("parent_site_id") or None

    def children_of(self, site_id: str) -> List[str]:
        return [sid for sid, s in self.sites.items() if s.get("parent_site_id") == site_id]

    def client_group_of(self, site_id: str) -> str:
        return self.sites[site_id].get("client_group") or ""

    def siblings_of(self, site_id: str) -> List[str]:
        """同一 `client_group` 嘅兄弟盤（唔包括自己），`client_group` 空白唔
        算（避免將全部冇填 client_group 嘅盤當做同一大組）。C3（2026-09-04
        放行條件）：糧明細 site_label 同更表盤唔同，但兩個盤同屬一個客戶
        集團（例：HKU座頭 同 HKU Y更 同屬 client_group=HKU），呢種先用
        site override，唔當做獨立新盤。"""
        cg = self.client_group_of(site_id)
        if not cg:
            return []
        return [sid for sid, s in self.sites.items()
                if sid != site_id and (s.get("client_group") or "") == cg]

    def all_site_ids(self) -> List[str]:
        return list(self.sites.keys())


class BrokerIndex:
    def __init__(self, brokers: List[dict]):
        self.brokers = {b["broker_id"]: b for b in brokers}
        self._by_settlement_label: Dict[str, str] = {}
        self._by_code: Dict[str, str] = {}
        for b in brokers:
            for alias in [b["canonical_name"]] + b["aliases"]:
                if alias:
                    self._by_settlement_label[alias] = b["broker_id"]
            if b["code"]:
                self._by_code[b["code"]] = b["broker_id"]

    def resolve_settlement_unit(self, settlement_unit: str) -> Optional[str]:
        return self._by_settlement_label.get(settlement_unit)

    def resolve_roster_code(self, code: str) -> Optional[str]:
        return self._by_code.get(code)

    def code_of(self, broker_id: Optional[str]) -> Optional[str]:
        if not broker_id:
            return None
        return self.brokers[broker_id]["code"] or None

    def name_of(self, broker_id: Optional[str]) -> Optional[str]:
        if not broker_id:
            return None
        return self.brokers[broker_id]["canonical_name"]


# ---------------------------------------------------------------------------
# R1: 安員身份合併
# ---------------------------------------------------------------------------

class DSU:
    def __init__(self):
        self.parent: Dict = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def load_wp1_rows() -> List[dict]:
    with open(paths.ROWS_CSV, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _find_conflicted_staff_no(wp1_rows: List[dict]) -> set:
    """staff_no 對住 >=2 個唔同（非空）電話 => 一號兩人嘅證據（見
    P0-執行計劃.md §3.8「工號錯誤實證」，真實 staff_no／姓名唔喺 code 度
    重複，PDPO）。有一邊電話冇填（空白）唔算證據——嗰個好可能淨係更表漏
    填，唔係第二個人（另一個實證：一行有電話一行冇），呢種情況要合併埋
    一齊，唔可以拆。
    """
    sn_to_tels: Dict[str, set] = defaultdict(set)
    for row in wp1_rows:
        sn = (row.get("staff_no") or "").strip()
        tel = normalize_tel(row.get("tel"))
        if sn and tel:
            sn_to_tels[sn].add(tel)
    return {sn for sn, tels in sn_to_tels.items() if len(tels) > 1}


def _base_key(row: dict, conflicted_staff_no: set) -> Tuple:
    staff_no = (row.get("staff_no") or "").strip()
    tel = normalize_tel(row.get("tel"))
    name_norm = normalize_name(row.get("name"))
    if staff_no:
        if staff_no in conflicted_staff_no:
            return ("SN", staff_no, tel)
        # 未有證據話呢個 staff_no 撞咗兩個人 —— 唔理個別行電話填冇填，
        # 全部歸做同一個 base group（一個人可以有幾行冇填電話）。
        return ("SN", staff_no, "")
    if tel:
        return ("NT", name_norm, tel)
    return ("NF", name_norm, row["file"])


def resolve_identities(wp1_rows: List[dict]):
    """回傳 (guard_id_by_rowkey, guards, identity_decisions)。

    guard_id_by_rowkey: {(file,row): guard_id} —— WP1 rows.csv 每一行對應
    邊個 guard_id，畀 R2/R3 join 用。
    guards: [{guard_id, staff_no, staff_no_aliases, staff_no_conflict,
              name_zh, name_variants, tel, is_external, source_files, members}]
    identity_decisions: [{decision, guard_ids, key_type, key_value, evidence}]
    """
    conflicted_staff_no = _find_conflicted_staff_no(wp1_rows)

    base_groups: Dict[Tuple, List[dict]] = defaultdict(list)
    for row in wp1_rows:
        base_groups[_base_key(row, conflicted_staff_no)].append(row)

    dsu = DSU()
    for key in base_groups:
        dsu.find(key)

    # 合併規則：唔同 base group，但 tel+name 一致 => 合併（見 P0-執行計劃.md
    # §3.8「工號錯誤實證」一人兩號嘅個案，真實 staff_no／姓名唔喺 code 度重複）
    tel_name_to_keys: Dict[Tuple[str, str], set] = defaultdict(set)
    for key, members in base_groups.items():
        tel = normalize_tel(members[0].get("tel"))
        if not tel:
            continue
        # 一個 base group 入面可能有多個 name 變體（同形字），逐個都索引
        names = {normalize_name(m.get("name")) for m in members}
        for n in names:
            if n:
                tel_name_to_keys[(n, tel)].add(key)
    merge_events = []
    for (name_norm, tel), keys in tel_name_to_keys.items():
        if len(keys) > 1:
            keys = sorted(keys, key=lambda k: str(k))
            first = keys[0]
            for other in keys[1:]:
                dsu.union(first, other)
            merge_events.append((name_norm, tel, keys))

    components: Dict = defaultdict(list)
    for key, members in base_groups.items():
        root = dsu.find(key)
        components[root].extend((key, m) for m in members)

    guards = []
    decisions = []
    guard_id_by_rowkey: Dict[Tuple[str, str], str] = {}

    def sort_key(comp_members):
        staff_nos = sorted({m.get("staff_no", "") for _, m in comp_members if m.get("staff_no")})
        names = sorted({m.get("name", "") for _, m in comp_members})
        tels = sorted({normalize_tel(m.get("tel")) for _, m in comp_members if m.get("tel")})
        files = sorted({m.get("file", "") for _, m in comp_members})
        return (staff_nos[0] if staff_nos else "~", names[0] if names else "~",
                tels[0] if tels else "~", files[0] if files else "~")

    comp_list = sorted(components.values(), key=sort_key)

    for idx, comp_members in enumerate(comp_list, start=1):
        guard_id = f"G{idx:04d}"
        rows_only = [m for _, m in comp_members]
        base_keys_used = sorted({k for k, _ in comp_members}, key=str)

        staff_nos_present = [m.get("staff_no", "") for m in rows_only if m.get("staff_no")]
        conflict_sns = sorted({sn for sn in staff_nos_present if sn in conflicted_staff_no})
        clean_sns = [sn for sn in staff_nos_present if sn not in conflicted_staff_no]

        if conflict_sns:
            final_staff_no = ""
            staff_no_aliases = sorted(set(staff_nos_present) - set(conflict_sns))
            staff_no_conflict = ";".join(conflict_sns)
        else:
            if clean_sns:
                counts = Counter(clean_sns)
                final_staff_no = counts.most_common(1)[0][0]
                staff_no_aliases = sorted(set(clean_sns) - {final_staff_no})
            else:
                final_staff_no = ""
                staff_no_aliases = []
            staff_no_conflict = ""

        name_counts = Counter(m.get("name", "") for m in rows_only if m.get("name"))
        name_zh = name_counts.most_common(1)[0][0] if name_counts else ""
        name_variants = sorted(set(name_counts) - {name_zh})
        raw_name_variants = sorted({m.get("name_raw", "") for m in rows_only if m.get("name_raw")} - {name_zh})
        name_variants = sorted(set(name_variants) | set(raw_name_variants))

        tels = sorted({normalize_tel(m.get("tel")) for m in rows_only if m.get("tel")})
        tel = tels[0] if tels else ""

        is_external = any(str(m.get("external", "")).strip().lower() == "true" for m in rows_only)
        source_files = sorted({m.get("file", "") for m in rows_only})

        guards.append({
            "guard_id": guard_id,
            "staff_no": final_staff_no,
            "staff_no_aliases": ";".join(staff_no_aliases),
            "staff_no_conflict": staff_no_conflict,
            "name_zh": name_zh,
            "name_variants": ";".join(name_variants),
            "tel": tel,
            "is_external": is_external,
            "source_files": ";".join(source_files),
            "n_rows": len(rows_only),
        })

        for k, m in comp_members:
            guard_id_by_rowkey[(m["file"], m["row"])] = guard_id

        if len(base_keys_used) > 1:
            decisions.append({
                "decision": "merge",
                "guard_ids": guard_id,
                "key_type": "name+tel",
                "key_value": f"{name_zh}({tel})",
                "evidence": json.dumps(
                    {"base_keys": [str(k) for k in base_keys_used],
                     "staff_no_seen": sorted(set(staff_nos_present)),
                     "name_variants_seen": sorted(set(name_counts))},
                    ensure_ascii=False, sort_keys=True),
            })
        if conflict_sns:
            decisions.append({
                "decision": "split",
                "guard_ids": guard_id,
                "key_type": "staff_no_conflict",
                "key_value": ";".join(conflict_sns),
                "evidence": json.dumps(
                    {"name_zh": name_zh, "tel": tel,
                     "shared_staff_no": conflict_sns}, ensure_ascii=False, sort_keys=True),
            })

    decisions.sort(key=lambda d: (d["decision"], d["key_value"], d["guard_ids"]))
    return guard_id_by_rowkey, guards, decisions


def build_guard_name_index(guards: List[dict]) -> Dict[str, List[str]]:
    """normalized name -> [guard_id,...]（一個名可能對應多過一個 guard，
    留俾 caller 決定點揀）。"""
    idx: Dict[str, List[str]] = defaultdict(list)
    for g in guards:
        variants = {g["name_zh"]} | set(v for v in g["name_variants"].split(";") if v)
        for v in variants:
            n = normalize_name(v)
            if n:
                idx[n].append(g["guard_id"])
    return idx


# ---------------------------------------------------------------------------
# WP2a payroll loading
# ---------------------------------------------------------------------------

AGGREGATE_GUARD_MARKERS = ("(", "整體")


def is_aggregate_guard_name(name: str) -> bool:
    if not name:
        return True
    return name.startswith("(") or "整體" in name


def load_payroll_rows() -> List[dict]:
    with open(paths.PAYROLL_ROWS_CSV, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def load_payroll_cells() -> List[dict]:
    cells = []
    for p in paths.payroll_cells_csvs():
        with open(p, encoding="utf-8-sig", newline="") as fh:
            cells.extend(csv.DictReader(fh))
    return cells


def is_longterm_payroll_row(row: dict) -> bool:
    bank_note = (row.get("bank_note") or "")
    if "Autopay" in bank_note:
        return True
    if (row.get("shift_kind") or "").strip() == "flat_referral":
        return True
    return False


def payroll_row_key(row: dict) -> Tuple[str, str, str, str]:
    """C2 修正（2026-09-04 放行條件）：join key 加 guard_name。K-LINK p1
    row4「TKO Gateway 厚B」一行印住兩個人（厚B安員丙 15更、厚B安員丁 1更）——
    WP2a 轉錄時兩個人共用同一個 row_no，如果 key 淨係 (source_file,page,
    row_no)，兩條 payroll-rows.csv 行會撈到同一組 16 格 cells，各自生成
    16 條 shift_record（32 條，互相張冠李戴）。cells 檔本身逐格有自己嘅
    guard_name（見 payroll-cells*.csv 表頭），加落 key 度就可以分開返。"""
    return (row["source_file"], row["page"], row["row_no"], (row.get("guard_name") or "").strip())


# ---------------------------------------------------------------------------
# R2: 結算單位反推
# ---------------------------------------------------------------------------

def payroll_site_slices(payroll_rows: List[dict], site_index: SiteIndex,
                         cells_by_row_key: Dict[Tuple[str, str, str, str], List[dict]]):
    """將每一行 payroll-rows.csv 拆做一個或多個「site slice」。

    一般情況一行一個 site（用行自己嘅 site_label）；混合行（規劃 session
    2026-09-03 決定 5：公司兵 混合行安員甲「31/皓日/創富(混合)」、混合行安員乙「蔚峰園/
    1331早/創富早(混合)」）嘅 cells 逐格自己帶住唔同嘅 site_label，逐格解
    出嚟嘅 site_id 唔一致 => 拆做多個 slice，每個 slice 淨係帶住屬於嗰個
    site 嘅 cells，先可以逐日歸去啱嘅盤。

    回傳 [(row, site_id_or_None, is_mixed, cells_for_this_site, site_scoped_key), ...]，
    `site_scoped_key` = (source_file, page, row_no, site_id_or_None)，比
    (source_file,page,row_no) 更幼——等混合行嘅其中一個 slice 用咗做
    roster 配對，另一個 slice 仲可以獨立生成 payroll_only。"""
    out = []
    for row in payroll_rows:
        guard_name = (row.get("guard_name") or "").strip()
        if is_aggregate_guard_name(guard_name):
            continue
        key3 = payroll_row_key(row)
        cells = cells_by_row_key.get(key3, [])
        cell_site_ids: set = set()
        cells_by_site: Dict[str, List[dict]] = defaultdict(list)
        for c in cells:
            cl = c.get("site_label") or row.get("site_label")
            sid = site_index.resolve(cl)
            if sid:
                cell_site_ids.add(sid)
                cells_by_site[sid].append(c)
        row_site_id = site_index.resolve(row.get("site_label"))
        if len(cell_site_ids) > 1:
            for sid in sorted(cell_site_ids):
                out.append((row, sid, True, cells_by_site[sid], key3 + (sid,)))
        elif row_site_id is not None:
            out.append((row, row_site_id, False, cells, key3 + (row_site_id,)))
        elif cell_site_ids:
            sid = next(iter(cell_site_ids))
            out.append((row, sid, False, cells_by_site[sid], key3 + (sid,)))
        else:
            out.append((row, None, False, cells, key3 + (None,)))
    return out


def build_payroll_index(payroll_rows: List[dict], site_index: SiteIndex,
                         cells_by_row_key: Dict[Tuple[str, str, str, str], List[dict]]):
    """回傳 by_name_site: {(name_norm, site_id): [augmented_row,...]}，同
    unmapped_labels: Counter(raw_site_label)。"""
    by_name_site: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
    unmapped_labels: Counter = Counter()
    for row, site_id, is_mixed, cells, key4 in payroll_site_slices(payroll_rows, site_index, cells_by_row_key):
        guard_name = (row.get("guard_name") or "").strip()
        if site_id is None:
            unmapped_labels[row.get("site_label", "")] += 1
            continue
        aug = dict(row)
        aug["_site_id"] = site_id
        aug["_is_longterm"] = is_longterm_payroll_row(row)
        aug["_key"] = key4
        aug["_is_mixed"] = is_mixed
        aug["_cells"] = cells
        by_name_site[(normalize_name(guard_name), site_id)].append(aug)
    return by_name_site, unmapped_labels


def resolve_settlement_for_row(
    wp1_row: dict,
    guard: dict,
    site_id: Optional[str],
    payroll_by_name_site: Dict[Tuple[str, str], List[dict]],
    broker_index: BrokerIndex,
    names_en_by_zh: Dict[str, dict],
    site_index: Optional["SiteIndex"] = None,
    page_level_settlements: Optional[Dict[Tuple[str, str], dict]] = None,
    payroll_guard_names: Optional[set] = None,
    longterm_staff_by_name: Optional[Dict[str, dict]] = None,
    master_guard_broker: Optional[Dict[str, dict]] = None,
) -> dict:
    """回傳 {settlement_unit, referral_broker, source, confidence,
    payroll_ref, roster_code_agrees, note, site_override}。

    優先次序（2026-09-03 規劃 session 決定 1/2/4 擴充；2026-09-04 B3 修正
    將決定 2 由「成個盤」收窄做「逐人」判斷，見 rule 2.5；2026-09-04 C4
    放行條件加 rule 0；2026-09-10 WP2b-c 加 rule 1.55；2026-09-10 WP5-C §11
    加 rule 0.1）：
    0. 客戶自己嘅人（is_external=True，例如 Wilson Guard／Wilson
       Supervisor）—— source=external，settlement_unit=external
       （brokers.csv B10），唔入糧、唔開單，優先於所有其他規則（呢類人喺
       糧明細／names_en.csv 唔應該出現，就算撞名都唔應該被當做真安員配
       對）。
    0.1（WP5-C §11，2026-09-10）：老闆交嘅「在勤總表」7 月 Roster sheet
        係逐崗位逐日雞頭名嘅權威來源（P0-執行計劃.md §8 WP5）。呢個安員
        （guard_id）喺總表逐日出現，而且總表對佢嘅 broker 分佈夠集中
        （>=70% 一致，見 master_roster.build_guard_broker_confirmations）
        ——settlement_unit 跟總表確認，source=master_roster，
        confidence=high，settlement_page=「總表-<broker>」（同舊
        page_level_settlements.csv 嘅「K-1331」/「K-LINK」呢類分頁標籤
        區分開，唔會撞落舊嘅特殊處理邏輯）。**呢條規則排喺 rule 1（糧明細
        逐人配對）之前**——總表係更權威嘅來源（已證實：page_level_
        settlements 舊規則「啟航 K 行歸 K」將 26 個 Maxwell 長工嘅約 490
        更錯歸咗做 K 嘅雞頭費更次，總表逐日數據冇呢個問題，見 §8 N6）。
        總表冇覆蓋（呢個 guard_id 冇喺總表出現過，或者分佈唔夠集中）嘅
        安員，照跌落 rule 1 開始嘅舊規則。
    1. 糧明細逐人配對（同盤，可以係混合行嘅其中一個 site slice）
    1.5 更細嘅子盤糧明細（例如 HKU 醫學院 相對 HKU座頭）—— source=payroll_label_override
    1.55（WP2b-c，2026-09-10；2026-09-11 WP5f 修 Q10 降級）：老闆交嘅
        Maxwell Corporation Limited 2026-07 長工月薪表
        （`longterm_staff_2026-07.csv`，48人）—— 安員（正規化中文名／同
        形字變體）出現喺呢張表 → settlement_unit=autopay_longterm，
        source=maxwell_payroll，confidence=high，排喺「盤級糧單規則」之
        前。動機：呢張表證實 26 個啟航1331 長工（月薪 16,500–19,000）嘅
        更表 A 欄雖然標住 K（雞頭代號），但佢哋實際係公司直接出月
        薪嘅長工，唔經雞頭——舊排序令 rule 1.6（盤級糧單規則）優先執行，
        錯誤將呢 26 人嘅約 490 更歸咗做 K 嘅雞頭費更次；長工月薪表係比
        page_level_settlements 呢個「冇逐人拆分只能靠 roster 代號估」嘅
        fallback 規則更直接、更高信度嘅證據，理應優先於 rule 1.6。
        **2026-09-11 修（WP5f，老闆已答 Q10「係」：長工被掃入雞頭現金桶
        嘅更，雞頭照樣實收現金，雙重支付）**：呢條規則喺呢個 function
        入面嘅角色收窄做「呢個人係咪 Maxwell／BOCHK 長工」呢個身份判斷
        （guards.csv staff_no_mw／monthly_salary／is_longterm 三個 guard
        層欄位獨立用返 `longterm_staff_by_name` 計，唔受呢度任何改動影
        響），唔再係settlement_unit嘅終局判斷——wp2b_run.py 嘅 rule 0.2
        （總表 site+day 配額消去法，見嗰邊 WEAK_SOURCES）而家可以覆寫呢
        條規則揀嘅 settlement_unit：總表對呢個安員嗰日有單一、明確嘅現
        金雞頭代號（K/W/G/D/T/Y）證據就跟總表（同時填返
        master_broker_code），揾唔到（冇資料、歧義，或者總表本身標
        (8)長工／LT 呢類冇對應現金桶嘅代號）先維持呢度嘅
        autopay_longterm 判斷。settlement_unit 而家嘅權威優先次序係
        總表 rule 0.1（呢度之前）／rule 0.2（wp2b_run.py，呢度之後），
        Maxwell／BOCHK 長工身份表只決定 employment_type（guards 層），
        唔再直接覆蓋 settlement。
    1.6 盤級糧單規則（page_level_settlements，例如 啟航1331 K-1331 頁冇逐人拆分）
        —— source=roster_code_site_page
    2. names_en.csv autopay 名單 —— source=autopay
    2.5 有 staff_no、但呢個人（正規化名／同形字變體）完全冇喺 14 頁現金糧明細
        任何一行出現過，亦唔喺 names_en.csv 配對名單 —— source=inferred_guard
        （confidence=low，pending=N6）。B3 修正前舊規則要求「成個盤喺現金糧
        明細完全冇任何人」先觸發，數碼港/HKU 呢類盤有零星現金人就永遠唔觸
        發，漏晒 537 條 unknown 入面嘅大多數；而家逐人判斷唔理盤層面。
    3. unknown（冇 staff_no 嘅 Event Guard／散工留喺呢度）
    """
    roster_code = (wp1_row.get("broker_code") or "").strip()
    result = {
        "settlement_unit": "unknown",
        "referral_broker": "",
        "source": "none",
        "confidence": "",
        "payroll_ref": "",
        "roster_code_agrees": "",
        "note": "",
        "used_keys": [],
        "site_override": "",
        # 一併做 1（broker_id／settlement_page）：settlement_page 保留糧明細
        # 原始 settlement_unit 標籤（例：K-1331／K-LINK／公司兵-2），
        # broker_id 唔拆（呢啲仍然歸一個 broker）——喺 wp2b_run.py 輸出
        # shift_records.csv 嗰陣由 settlement_unit 再解一次 broker_id。
        "settlement_page": "",
        # WP5-C 修（2026-09-10，必修1）：settlement_page 係「呢條更次記錄喺
        # 邊一頁糧單出現」呢個獨立維度（糧單頁面重現、逐頁殘差對數要用），
        # 唔可以俾 rule 0.1／0.2（總表歸屬結論）覆寫——總表話「呢個安員
        # settlement_unit 係邊個」同「呢條更喺邊頁糧單出現過」係兩件事：
        # 前者係「宜家歸邊個雞頭/桶」嘅結算判斷，後者係「呢張歷史糧單文件
        # 原本點寫」嘅事實，兩者可以唔一致（例如總表覆核發現某個安員其實
        # 係公司兵，但佢嗰條更歷史上寫喺 G 頁）。總表對呢個安員嘅原始
        # broker_code 判斷改記喺 master_broker_code／master_broker_source
        # 呢兩個新欄（rule0.1／rule0.2），唔再借用 settlement_page。
        "master_broker_code": "",
        "master_broker_source": "",
    }
    # 2026-09-10 裁定（HKU 上村 override 反轉）：糧明細 site_label 印「香港
    # 大學夜更上村」其實係 HKU 座頭（S007）C更合約入面嘅一個崗位，唔係獨立
    # 嘅 HKU Y更（S006）盤——sites.csv 已將呢個 label 改做 S007 嘅 alias
    # （唔再係 S006），令呢度 rule 1 直接喺 site_id=S007 配對到，唔會觸發
    # wp2b_run.py 嘅兄弟盤 site override。「呢個安員邊幾日先真係上村」呢個
    # 逐日 location_tag 判斷需要 cell 層日期粒度（呢度 resolve_settlement_
    # for_row 係逐安員逐檔一次過，冇逐日），所以喺 wp2b_run.py 用
    # payroll-cells 逐日 (guard,day) 集合另外精準判斷，唔喺呢度做。
    if site_id is None:
        result["note"] = "site_id 未解（唔應該發生，20 個更表全部已入 sites.csv）"
        return result

    # rule 0（C4）：客戶自己嘅人，唔入糧、唔開單，優先於任何配對規則。
    if guard.get("is_external"):
        result["settlement_unit"] = "external"
        result["source"] = "external"
        result["confidence"] = "high"
        result["note"] = "客戶自己嘅人（Wilson Guard／Wilson Supervisor 等），見 brokers.csv B10"
        result["settlement_page"] = "external"
        return result

    variants = {guard["name_zh"]} | set(v for v in guard["name_variants"].split(";") if v)
    candidates: List[dict] = []
    for v in variants:
        n = normalize_name(v)
        candidates.extend(payroll_by_name_site.get((n, site_id), []))

    # rule 0.1（WP5-C §11）：總表逐日確認嘅 guard_id → broker，優先於糧明細
    # 逐人配對（rule 1）。冇覆蓋（guard_id 唔喺 master_guard_broker，或者
    # confirmed_settlement_unit 係空——即係總表分佈唔夠集中／呢個 broker_code
    # 冇對應具體結算單位，例如「其他」）就跌落舊規則，唔影響現有行為。
    #
    # 重要：就算呢條規則贏咗（settlement_unit 用總表嘅答案），都要將呢個
    # 安員喺呢個盤嘅糧明細候選行（candidates，同 rule 1 用嗰組一樣）全部
    # 記入 used_keys——唔係嘅話下游「糧明細有呢行但冇被任何 wp1 row 用到」
    # 嘅 payroll_only 生成邏輯會當呢啲候選行從未被配對，重新生成一次重複
    # 嘅 shift_records（呢個係第一版 rule 0.1 嘅真實 bug：搶咗 settlement
    # 但漏咗 used_keys，令 shift_records 由 4,012 暴增到 4,398）。
    if master_guard_broker:
        confirmation = master_guard_broker.get(guard.get("guard_id", ""))
        if confirmation and confirmation.get("confirmed_settlement_unit"):
            settlement_unit = confirmation["confirmed_settlement_unit"]
            result["settlement_unit"] = settlement_unit
            result["source"] = "master_roster"
            result["confidence"] = confirmation.get("confidence", "high")
            # WP5-C 修（2026-09-10，必修1）：settlement_page 唔可以再寫
            # 「總表-<code>」（呢個係總表歸屬結論，唔係糧單頁面事實）。總表
            # 嘅判斷改記入 master_broker_code／master_broker_source；
            # settlement_page 保留糧單頁維度——有糧明細候選行（candidates，
            # 同 rule 1 用嗰組一樣）就用嗰行原本嘅 settlement_unit 標籤
            # （例：K-1331／公司兵-2／G），冇就留空（呢條更喺任何糧單
            # 都搵唔到，總表係淨係嘅歸屬證據，冇對應糧單頁可以重現）。
            result["master_broker_code"] = confirmation.get("confirmed_broker_code", "")
            result["master_broker_source"] = "rule0.1"
            result["note"] = (
                f"WP5-C rule 0.1：在勤總表逐日確認（{confirmation.get('note', '')}）"
            )
            if candidates:
                longterm_candidates = [c for c in candidates if c["_is_longterm"]]
                pool = longterm_candidates if longterm_candidates else candidates
                page_chosen = pool[0]
                if len({c["settlement_unit"] for c in pool}) > 1 and roster_code:
                    agree_pool = [
                        c for c in pool
                        if broker_index.resolve_settlement_unit(c["settlement_unit"])
                        and broker_index.code_of(
                            broker_index.resolve_settlement_unit(c["settlement_unit"])) == roster_code]
                    if agree_pool:
                        page_chosen = agree_pool[0]
                result["settlement_page"] = page_chosen["settlement_unit"]
                result["used_keys"] = [c["_key"] for c in candidates]
                result["payroll_ref"] = ";".join(sorted({
                    f"{c['source_file']}#p{c['page']}#row{c['row_no']}" for c in candidates
                }))
                # §3.6：T／W／G 頁「工資 –、只收雞頭費」嗰啲
                # 行＝長工，糧經 autopay 出，雞頭只收介紹費——總表confirm
                # 呢個guard係autopay_longterm，但佢喺糧單頁仍然要記低邊個
                # 雞頭收緊佢嘅介紹費（referral_broker），先可以喺WP3 pricing
                # 搵到broker_fee rate_card（唔設就變is_pure_autopay，成條
                # priced_row跌落unpriced，糧單逐頁regen見唔到佢，見WP3
                # payroll-diff category=tool_bug嘅回歸）。
                if settlement_unit == "autopay_longterm":
                    page_broker_id = broker_index.resolve_settlement_unit(page_chosen["settlement_unit"])
                    result["referral_broker"] = (
                        broker_index.name_of(page_broker_id) or page_chosen["settlement_unit"])
            roster_code = (wp1_row.get("broker_code") or "").strip()
            if roster_code:
                expected_broker_id = broker_index.resolve_roster_code(roster_code)
                result["roster_code_agrees"] = str(
                    broker_index.name_of(expected_broker_id) == settlement_unit
                )
            return result

    # rule 1.5：糧明細用咗比更表更細嘅子盤 label（例如 HKU 醫學院 相對
    # HKU座頭）——呢個安員喺更表記喺 parent 盤，但糧明細將佢記喺 child 盤。
    if not candidates and site_index is not None:
        for child_id in site_index.children_of(site_id):
            for v in variants:
                n = normalize_name(v)
                candidates_child = payroll_by_name_site.get((n, child_id), [])
                if candidates_child:
                    chosen = candidates_child[0]
                    broker_id = broker_index.resolve_settlement_unit(chosen["settlement_unit"])
                    is_lt = chosen["_is_longterm"]
                    result["settlement_unit"] = ("autopay_longterm" if is_lt
                                                  else (broker_index.name_of(broker_id) or chosen["settlement_unit"]))
                    result["referral_broker"] = (broker_index.name_of(broker_id) or chosen["settlement_unit"]) if is_lt else ""
                    result["source"] = "payroll_label_override"
                    result["confidence"] = "medium"
                    result["payroll_ref"] = f"{chosen['source_file']}#p{chosen['page']}#row{chosen['row_no']}"
                    result["note"] = (f"糧明細 site_label 比更表更細（{site_index.canonical_name(child_id)}），"
                                       f"override site_id")
                    result["site_override"] = child_id
                    result["used_keys"] = [chosen["_key"]]
                    result["settlement_page"] = chosen["settlement_unit"]
                    return result

    if candidates:
        longterm_candidates = [c for c in candidates if c["_is_longterm"]]
        pool = longterm_candidates if longterm_candidates else candidates
        settlement_units = sorted({c["settlement_unit"] for c in pool})
        chosen = pool[0]
        if len(settlement_units) > 1 and roster_code:
            agree_pool = [c for c in pool
                          if broker_index.resolve_settlement_unit(c["settlement_unit"])
                          and broker_index.code_of(broker_index.resolve_settlement_unit(c["settlement_unit"])) == roster_code]
            if agree_pool:
                chosen = agree_pool[0]
        broker_id = broker_index.resolve_settlement_unit(chosen["settlement_unit"])
        if longterm_candidates:
            result["settlement_unit"] = "autopay_longterm"
            result["referral_broker"] = broker_index.name_of(broker_id) or chosen["settlement_unit"]
        else:
            result["settlement_unit"] = broker_index.name_of(broker_id) or chosen["settlement_unit"]
        result["source"] = "payroll"
        result["confidence"] = "high" if len(settlement_units) == 1 else "medium"
        # 一併做項目 6（2026-09-04）：一人同盤跨多個糧明細行（例如上半月頁 +
        # 下半月頁兩條獨立 row）以前淨係記低 chosen 嗰一行嘅 ref，而家全部
        # 用同一 settlement_unit 嘅行都記晒（分號分隔），先追溯到晒齊全部
        # 出處，唔淨係其中一條。
        _refs = sorted({f"{c['source_file']}#p{c['page']}#row{c['row_no']}"
                        for c in pool if c["settlement_unit"] == chosen["settlement_unit"]})
        result["payroll_ref"] = ";".join(_refs)
        if len(settlement_units) > 1:
            result["note"] = f"多過一個結算單位候選：{settlement_units}，用時段/roster代號揀咗 {chosen['settlement_unit']}"
        resolved_code = broker_index.code_of(broker_id)
        if roster_code:
            result["roster_code_agrees"] = str(resolved_code == roster_code)
        same_unit_pool = [c for c in pool if c["settlement_unit"] == chosen["settlement_unit"]]
        result["used_keys"] = [c["_key"] for c in same_unit_pool]
        result["settlement_page"] = chosen["settlement_unit"]
        return result

    # rule 1.55（WP2b-c，2026-09-10）：Maxwell 長工月薪表，優先於盤級糧單
    # 規則（rule 1.6）——見上面 docstring。淨係用正規化中文名配對，唔理
    # site_id（長工月薪表本身冇逐更拆分，site_label 只係參考）。
    if longterm_staff_by_name:
        for v in variants:
            n = normalize_name(v)
            info = longterm_staff_by_name.get(n)
            if info:
                result["settlement_unit"] = "autopay_longterm"
                result["source"] = "maxwell_payroll"
                result["confidence"] = "high"
                result["note"] = (
                    f"長工月薪表 Maxwell Corporation Limited 2026-07 配對："
                    f"{info.get('staff_no_mw', '')} {info.get('name_en', '')}"
                    f"（月薪{info.get('monthly_salary', '')}，{info.get('site_label', '')}）")
                result["settlement_page"] = "maxwell_payroll_longterm"
                return result

    # rule 1.6：盤級糧單（page_level_settlements，規劃 session 決定 1）——
    # 有啲盤嘅糧明細成頁淨係得逐日總額，冇逐人拆分（例如啟航1331嘅
    # 「K-1331」頁），呢種情況先准用更表 A 欄 broker_code 做 fallback。
    if page_level_settlements and roster_code:
        pls = page_level_settlements.get((site_id, roster_code))
        if pls:
            broker_id = broker_index.resolve_settlement_unit(pls["settlement_unit"])
            result["settlement_unit"] = broker_index.name_of(broker_id) or pls["settlement_unit"]
            result["source"] = "roster_code_site_page"
            result["confidence"] = pls["confidence"]
            result["note"] = pls["note"]
            result["roster_code_agrees"] = "True"  # 定義上呢條規則就係跟 roster code
            result["settlement_page"] = pls["settlement_unit"]
            return result

    # rule 2: autopay 名單
    for v in variants:
        n = normalize_name(v)
        info = names_en_by_zh.get(n)
        if info:
            result["settlement_unit"] = "autopay_longterm"
            result["source"] = "autopay"
            result["confidence"] = info["confidence"]
            result["note"] = f"names_en.csv 配對：{info['english_name']}"
            return result

    # rule 2.5（B3 修正，2026-09-04）：逐人判斷，唔再靠「成個盤有冇現金人」。
    # 有 staff_no、而且呢個人（正規化名／同形字變體全部）完全冇喺 14 頁現金
    # 糧明細任何一行出現過（唔理個別頁邊個盤）——呢類人幾乎肯定係長工，淨
    # 係差 N6 員工名單先可以配返實名，暫時用低信心度標記，唔混入
    # source=autopay。冇 staff_no 嘅（Event Guard／散工）唔觸發呢條規則，
    # 留返俾 unknown，因為冇工號冇辦法追蹤佢係咪真係長工。
    if guard.get("staff_no") and payroll_guard_names is not None:
        variant_names = {normalize_name(v) for v in variants if v}
        if variant_names and variant_names.isdisjoint(payroll_guard_names):
            result["settlement_unit"] = "autopay_longterm"
            result["source"] = "inferred_guard"
            result["confidence"] = "low"
            result["note"] = ("pending=N6：有 staff_no，但呢個人完全冇喺 14 頁現金糧明細任何一行"
                               "出現過（逐人判斷，唔靠成個盤），推斷係長工")
            return result

    if not guard.get("staff_no"):
        # C4 修正（2026-09-04）：以前一律寫死「Event Guard／散工」，但真實
        # unresolved 個案入面有啲人 rank 係「夜更保安員」，唔係 Event
        # Guard，寫死個原因唔準確——改為淨係喺 rank 真係包含 Event 字眼先
        # 咁講，其他一律用中性字眼。
        rank = (wp1_row.get("rank") or "")
        if "Event" in rank:
            result["note"] = "冇 staff_no（Event Guard 臨時活動保安），冇工號冇辦法追蹤係咪長工，留低做 unknown"
        else:
            result["note"] = "冇 staff_no，冇工號冇辦法追蹤係咪長工，留低做 unknown（需人手核實／後補工號）"
    else:
        result["note"] = ("有 staff_no，個人名有喺 14 頁現金糧明細其他行出現過（可能喺唔同盤/唔同"
                           "site_label），但同呢個盤(site_id)配對唔到，亦唔喺 names_en 名單，需人手"
                           "核實實際結算單位")
    return result
