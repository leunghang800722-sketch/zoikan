"""WP5：解析老闆 2026-09-10 交嘅「在勤總表」7 月版（Roster + Summary sheet），
做權威來源重做歸屬同三層對數。對應 P0-執行計劃.md §8 WP5 章節。

輸入：`data/2026-07/reference/2026-07-在勤總表-PostOrder-Roster-Summary
(Drive 2026-09-10).xlsx` 嘅 `Roster` sheet（2,996 行 × 238 欄：row 7 表頭，
基本 7 欄 + 31 日 × 7 欄嘅逐日格）同 `Summary` sheet（逐雞頭逐日 Net／
UnBilled／Billed／PAID 更數 + PAID Amount 全月／上半／下半）。

輸出（`out/wp5/`，PDPO：唔入 git；run-wp5 每次清空重寫）：
  - master_posts.csv                      —— 逐崗位（block/sub_block/customer_label/...)
  - master_assignments.csv                —— 逐崗位逐日格
  - master_summary.csv                    —— Summary sheet 逐雞頭逐日／全月統計
  - unmapped-master.csv                   —— 對唔到 site_id 嘅崗位
  - master_site_map.csv                   —— block/sub_block/property code/
                                              customer_label pattern → site_id
                                              對照表（由 SITE_MAP_RULES 生成，
                                              人手改係改 SITE_MAP_RULES 本身，
                                              唔係呢個輸出檔；唔含真名）
  - master_guard_broker_confirmations.csv —— 逐 guard_id 總表 broker 分佈確認
                                              （診斷/審核用；wp2b_run.py 唔再
                                              靠呢個檔，見下段同必修2）
  - master_site_day_broker_counts.csv     —— 逐 (site,day) broker 分佈（同上，
                                              診斷/審核用）

2026-09-10 修（必修2，破循環依賴）：以前 `run-wp2b` 嘅 rule 0.1／0.2 要靠
獨立行 `run-wp5`（讀 `out/wp2b/guards.csv` 做 redaction）先產生到
`master_guard_broker_confirmations.csv`／`master_site_day_broker_counts.csv`
兩個表，而行 `run-wp5` 又要 `out/wp2b/guards.csv` 已經存在（先前行過
run-wp2b）——形成循環依賴，冇代碼強制兩次 run-wp2b 嘅執行次序，「乾淨
checkout 淨係行一次」會靜靜跌落舊規則，同「跑足流程」結果唔一致。而家
`wp2b_run.py` 唔再經呢兩個 CSV：改用 `build_rule01_rule02_inputs(guards)`
喺同一個 run-wp2b process 入面、用自己啱啱由 `resolve_identities()` 攞到
嘅 guards list（喺 rule 0.1/0.2 之前已經確定，唔受佢哋影響）就地重新解析
總表 xlsx、就地 redact、就地統計——一次過搞掂，唔使中間檔、唔使跑兩次、
唔使預先行過 `run-wp5`。獨立 `run-wp5` CLI 命令仍然保留（寫呢 5 個 out/wp5/
檔案，畀人手審核/PDPO 掃描用），但已經唔係 `run-wp2b` 嘅依賴。

PDPO：呢個模組讀嘅原始 Excel 有真人姓名（`remark`／`customer_label` 後綴）。
根據任務要求「真名唔准入 tools/」，本模組將所有解析到嘅真名一律用
`out/wp2b/guards.csv`（或者 `build_rule01_rule02_inputs()` 傳入嘅記憶體
guards list）嘅 guard_id 代替（搵唔到就用 `[NAME:?]` 呢個唔可逆嘅佔位
符），先至寫落 out/wp5/ 嘅 CSV——`customer_label`／`guard_name_hint`／
`remark` 三個欄都經過 `_redact()`，原始姓名唔會進入 tools/ 任何檔案。
"""
import csv
import re
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import openpyxl

from . import paths
from .normalize import normalize_name
from .private_mappings import broker_canonical_name, broker_master_roster_aliases

# PDPO：雞頭真名（K/W/G/D/T）淨係喺呢度經 private_mappings 讀一次，下面
# 對照表全部用呢幾個變數，源碼本身唔會再出現真名字面值。冇 private 檔
# 就 fallback 用代號本身（見 private_mappings.py）。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_D = broker_canonical_name("D")
_BROKER_T = broker_canonical_name("T")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
# 總表用姓氏稱呼 T（見 data/mappings-private/brokers.csv
# master_roster_aliases）；冇 private 檔就冧返用代號 "T" 本身。
_BROKER_T_SURNAME = (broker_master_roster_aliases("T") or [_BROKER_T])[0]

# ---------------------------------------------------------------------------
# 讀 workbook（用 iter_rows(values_only=True) 一次過攞晒行，快過逐格 .cell()）
# ---------------------------------------------------------------------------

BASE_COLS = 7  # 客戶名稱/Customer Code/物業名稱/更份/上單價/外判價/時間
DAY_BLOCK_WIDTH = 7  # 日期/雞頭名/備註/其他/救更價/Unbilled/Paid
N_DAYS = 31
ROSTER_HEADER_ROW = 7  # 1-indexed；資料由 row 8 開始
ROSTER_SHEET = "Roster"
SUMMARY_SHEET = "Summary"


def _load_sheet_rows(xlsx_path: Path, sheet_name: str) -> List[tuple]:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    ws = wb[sheet_name]
    rows = [row for row in ws.iter_rows(values_only=True)]
    wb.close()
    return rows


def _day_col_offset(day_idx: int) -> int:
    """day_idx 由 1 開始。回傳 0-indexed tuple 位置（date 欄）。"""
    return BASE_COLS + (day_idx - 1) * DAY_BLOCK_WIDTH


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _text(v) -> str:
    if v is None:
        return ""
    return str(v).strip()


# ---------------------------------------------------------------------------
# 姓名去識別化（PDPO：真名唔准入 tools/）
# ---------------------------------------------------------------------------

CJK_RUN_RE = re.compile(r"[一-鿿]{2,6}")

# 呢啲詞喺 customer_label／remark 度出現，係崗位/更份/財務詞彙，唔係人名，
# redact() 唔會當佢哋係名（連同 site canonical_name/alias、block base、
# property code 一齊喺 build_name_index() 動態加入白名單）。
COMMON_NON_NAME_TERMS = {
    "雞頭費", "長工", "救更", "打風", "半更", "補車費", "現金糧", "月薪",
    "佣金", "夜更", "早更", "貨倉", "物業服務", "有限公司", "職員宿舍",
    "控制室", "數據中心", "企業大廈", "集團中心", "國際學校", "大學",
    "夜巡邏", "學生宿舍", "車廠", "花園", "貨倉早", "貨倉夜", "威信",
    "現金", "打風半更", "介紹費",
}


def _guard_name_index_from_rows(rows) -> Dict[str, set]:
    """{normalize_name(name): {guard_id,...}}，由一串 guard dict/CSV row
    （要有 guard_id／name_zh／name_variants，name_en 有就一併收）砌名索引。
    WP5-C（2026-09-10 修）：呢個 helper 唔再淨係識讀 CSV——wp2b_run.py 而家
    可以直接傳自己 resolve_identities() 喺記憶體度already有嘅 guards
    list，唔使等 out/wp2b/guards.csv 寫落磁盤先讀返（打破 wp5→wp2b 循環
    依賴，見 build_rule01_rule02_inputs() docstring）。"""
    idx: Dict[str, set] = defaultdict(set)
    for row in rows:
        gid = (row.get("guard_id") or "").strip()
        if not gid:
            continue
        names = set()
        if row.get("name_zh"):
            names.add(row["name_zh"])
        if row.get("name_en"):
            names.add(row["name_en"])
        for v in (row.get("name_variants") or "").split(";"):
            v = v.strip()
            if v:
                names.add(v)
        for n in names:
            key = normalize_name(n)
            if key:
                idx[key].add(gid)
    return idx


def _load_guard_name_index() -> Dict[str, set]:
    """{normalize_name(name): {guard_id,...}}，來源 out/wp2b/guards.csv（既有
    pipeline 嘅安員登記，name_zh／name_en／name_variants 全部收）。搵唔到就
    表示 out/wp2b/ 未跑過（run-wp1→wp2b 之前跑 wp5），呢種情況下 index 淨係
    得空 dict，全部名一律 redact 做 `[NAME:?]`（唔會外洩，淨係少咗
    guard_id cross-reference）。呢個 CSV 版本淨係畀「獨立行 run-wp5」（CLI／
    test_wp5.py）用；wp2b_run.py 內部而家用 _guard_name_index_from_rows()
    直接傳記憶體 guards list，唔經呢個函數。"""
    guards_csv = paths.OUT_WP2B_DIR / "guards.csv"
    if not guards_csv.exists():
        return defaultdict(set)
    with open(guards_csv, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    return _guard_name_index_from_rows(rows)


def _build_site_vocab(sites: List[dict], block_bases: set, property_codes: set) -> set:
    vocab = set(COMMON_NON_NAME_TERMS)
    for s in sites:
        vocab.add(s["canonical_name"])
        for a in s.get("aliases", []):
            vocab.add(a)
        if s.get("client_name"):
            vocab.add(s["client_name"])
        if s.get("client_group"):
            vocab.add(s["client_group"])
    vocab |= {b for b in block_bases if b}
    vocab |= {p for p in property_codes if p}
    return vocab


class Redactor:
    """將 customer_label／guard_name_hint／remark 入面搵到嘅真人姓名代做
    guard_id（搵唔到就 `[NAME:?]`）。CJK 2-6 字連續片段先會被當做候選姓名。

    重要：唔可以淨係用「呢個 run 係咪某個詞彙表詞語嘅子字串」嚟判斷唔係
    人名——「某人打風OT」呢類「姓名+旗標詞冇分隔符直接黐埋」嘅片段（真實
    例子：`master_posts.csv` row267 九龍企業大廈嘅打風OT行），如果淨係查
    「"打風" in "某人打風"」就會將成個 run（連埋姓名）都當做詞彙表放過，
    導致真名漏 redact。所以呢度用「由兩端剝走已知詞彙表詞語」嘅做法：
    反覆由 run 頭／尾剝走匹配嘅詞彙表詞（長詞優先），剩低嗰截先當姓名候選
    去查 guard 名冊；剝到晒都仲有嘢剩就一定要 redact（搵唔到就 `[NAME:?]`），
    唔會因為部分匹配就放過成個 run。"""

    def __init__(self, name_index: Dict[str, set], vocab: set):
        self.name_index = name_index
        self.vocab_set = set(vocab)
        # 剝詞只用 >=2 字嘅詞彙（1 字詞剝落去風險太高、容易錯剝），由長至短
        # 排序令長詞優先於短詞（例如「企業大廈」優先於「企業」）。
        self.vocab_terms = sorted({v for v in vocab if v and len(v) >= 2}, key=len, reverse=True)
        self.unresolved_count = 0
        self.resolved_count = 0

    def _resolve_fragment(self, frag: str) -> str:
        key = normalize_name(frag)
        gids = self.name_index.get(key)
        if gids:
            self.resolved_count += 1
            if len(gids) == 1:
                return f"[NAME:{next(iter(gids))}]"
            return f"[NAME:{'|'.join(sorted(gids))}]"
        self.unresolved_count += 1
        return "[NAME:?]"

    def _process_run(self, run: str) -> str:
        if run in self.vocab_set:
            return run
        prefix, suffix, remaining = "", "", run
        changed = True
        while changed and remaining:
            changed = False
            for t in self.vocab_terms:
                if len(t) > len(remaining):
                    continue
                if remaining.startswith(t):
                    prefix += t
                    remaining = remaining[len(t):]
                    changed = True
                    break
                if remaining.endswith(t):
                    suffix = t + suffix
                    remaining = remaining[:len(remaining) - len(t)]
                    changed = True
                    break
        if not remaining:
            return prefix + suffix
        if remaining in self.vocab_set:
            return prefix + remaining + suffix
        return prefix + self._resolve_fragment(remaining) + suffix

    def redact(self, text: str) -> str:
        if not text:
            return text
        return CJK_RUN_RE.sub(lambda m: self._process_run(m.group(0)), text)


# ---------------------------------------------------------------------------
# Roster 解析：block／sub_block／post 三層
# ---------------------------------------------------------------------------

SUB_BLOCK_RE = re.compile(r"^\s*\d+\s*hrs?\s*\([A-Za-z/]+\)\s*$")


def _strip_block_suffix(text: str) -> str:
    """由 block header 文字推 base_name（畀 guard_name_hint 用嚟斬客戶名稱
    前綴），例如「數碼港 12hrs (D/S)」→「數碼港」、「凱和山 27000/M」→
    「凱和山」、「啟航1331 Event」→「啟航1331」。"""
    t = text
    t = re.sub(r"\s*\d+\s*hrs?\s*\([A-Za-z/]+\)\s*$", "", t)
    t = re.sub(r"\s*[\d,]+\s*/\s*M\s*$", "", t)
    t = re.sub(r"\s*Event\s*$", "", t)
    return t.strip()


def parse_roster_posts_and_assignments(rows: List[tuple]):
    """回傳 (posts: List[dict], assignments: List[dict])，未做 redact／site
    mapping（純結構解析），畀 run_wp5() 再加工。"""
    day_dates: List[Optional[date]] = []
    header_row = rows[ROSTER_HEADER_ROW - 1] if len(rows) >= ROSTER_HEADER_ROW else ()
    for d in range(1, N_DAYS + 1):
        col = _day_col_offset(d)
        v = header_row[col] if col < len(header_row) else None
        if isinstance(v, datetime):
            day_dates.append(v.date())
        elif isinstance(v, date):
            day_dates.append(v)
        else:
            day_dates.append(None)

    posts: List[dict] = []
    assignments: List[dict] = []

    prev_kind = None  # 'header' | 'post' | None —— 追蹤上一條非空行係咪 header
    cur_block = None
    cur_sub_block = None
    cur_block_base = None  # 由 cur_block 斬完 shift-descriptor 後嘅底

    for i in range(ROSTER_HEADER_ROW, len(rows)):
        r = rows[i]
        row_no = i + 1
        base = r[0:BASE_COLS] if len(r) >= BASE_COLS else tuple(r) + (None,) * (BASE_COLS - len(r))
        customer, code, prop, shift, client_rate, payout_rate, time_ = base
        if all(v is None for v in base):
            continue  # 完全空行，唔改 prev_kind（容許 header/posts 中間隔空行）

        customer_s = _text(customer)
        prop_s = _text(prop)
        if not customer_s and not prop_s:
            continue  # 格仔殘留雜訊（例如純空白字符），唔算行

        is_header = bool(customer_s) and not prop_s
        if is_header:
            # 純「N hrs (D/S)」呢類時段小標題（例：「8 hrs (M/S)」）一律當
            # sub_block，唔理上一行係咪已經有 post——啟航1331 每個時段小標題
            # 之前都跟住成組 post 行先出現下一個小標題，用「上一行係咪
            # header」判斷會將第二個之後嘅小標題誤判做新 top block（cur_block
            # 走失），要用正則（係咪淨係時段描述、冇客戶名）先分辨得到。
            if SUB_BLOCK_RE.match(customer_s):
                cur_sub_block = customer_s
            else:
                cur_block = customer_s
                cur_block_base = _strip_block_suffix(customer_s)
                cur_sub_block = None
            prev_kind = "header"
            continue

        # post row
        prev_kind = "post"
        post_id = f"MP{row_no:04d}"
        base_for_hint = cur_block_base or ""
        if base_for_hint and customer_s.startswith(base_for_hint):
            guard_hint = customer_s[len(base_for_hint):].strip()
        else:
            guard_hint = ""
        is_broker_fee = customer_s.startswith("長工雞頭費")

        posts.append({
            "post_id": post_id,
            "row_no": row_no,
            "block": cur_block or "",
            "sub_block": cur_sub_block or "",
            "customer_label": customer_s,
            "guard_name_hint": guard_hint,
            "property": prop_s,
            "shift": _text(shift),
            "time": _text(time_),
            "client_rate": _num(client_rate),
            "payout_rate": _num(payout_rate),
            "customer_code": _text(code),
            "is_broker_fee_row": is_broker_fee,
        })

        for d in range(1, N_DAYS + 1):
            col = _day_col_offset(d)
            cell_value = r[col] if col < len(r) else None
            broker_raw = r[col + 1] if col + 1 < len(r) else None
            remark = r[col + 2] if col + 2 < len(r) else None
            other = r[col + 3] if col + 3 < len(r) else None
            rescue_rate = r[col + 4] if col + 4 < len(r) else None
            unbilled = r[col + 5] if col + 5 < len(r) else None
            paid = r[col + 6] if col + 6 < len(r) else None
            if all(v is None for v in (cell_value, broker_raw, remark, other, rescue_rate, unbilled, paid)):
                continue
            assignments.append({
                "post_id": post_id,
                "row_no": row_no,
                "day": d,
                "work_date": day_dates[d - 1].isoformat() if day_dates[d - 1] else "",
                "cell_value": _text(cell_value),
                "broker_raw": _text(broker_raw),
                "remark": _text(remark),
                "other": _text(other),
                "rescue_rate": _num(rescue_rate),
                "unbilled": _text(unbilled),
                "paid": _text(paid),
            })

    return posts, assignments


BROKER_CODE_RE = re.compile(r"^\(\s*(\d+)\s*\)\s*(.+)$")

# 總表雞頭欄 (N) 中文 → mappings/brokers.csv broker code（Q7 已答，
# P0-執行計劃.md §8）。(5)富/(6)威信/(9)譚/(12)堡全/(14)余 7 月全部 0，
# 唔使 map；如果日後出現就會跌落 unmapped_broker_raw。
MASTER_BROKER_TO_CODE = {
    "1": "Y",     # 公司兵
    "2": "K",     # K 真名見 data/mappings-private/brokers.csv
    "3": "W",     # W 真名見 data/mappings-private/brokers.csv
    "4": "T",     # 總表用姓氏稱呼，T 真名／稱呼見 data/mappings-private/brokers.csv
    "7": "P",     # 個別雞頭（B08，brokers.csv 而家有 code=P，見 data/mappings-private/brokers.csv）
    "8": "LT",    # 長工＝autopay_longterm（唔係 brokers.csv 嘅 code，特殊值）
    "10": "OTHER",  # 其他
    "11": "D",    # D 真名見 data/mappings-private/brokers.csv
    "13": "G",    # G 真名嘅另一種寫法，見 data/mappings-private/brokers.csv
}


def resolve_broker_code(broker_raw: str) -> Tuple[str, str]:
    """回傳 (broker_code, broker_label)。broker_code 對應 mappings/brokers.csv
    嘅 code 欄（K/W/G/D/T/Y/P），或者特殊值 LT（長工/autopay_longterm）、
    OTHER（其他）、EXTERNAL（客戶自己嘅人）。"""
    if not broker_raw:
        return "", ""
    if broker_raw.strip() == "客戶":
        return "EXTERNAL", "客戶"
    m = BROKER_CODE_RE.match(broker_raw.strip())
    if not m:
        return "UNKNOWN", broker_raw
    num, label = m.group(1), m.group(2).strip()
    code = MASTER_BROKER_TO_CODE.get(num)
    if code is None:
        return "UNKNOWN", label
    return code, label


# ---------------------------------------------------------------------------
# Summary sheet 解析
# ---------------------------------------------------------------------------

SUMMARY_SECTIONS = [
    # (section 名, 第一個 broker 行的 1-indexed row number)
    ("Net", 4),
    ("UnBilled", 28),
    ("Billed", 50),
    ("PAID_count", 75),
    ("Variance_vs_Paid", 98),
    ("PAID_Amount", 123),
]
SUMMARY_BROKER_ROWS = 14  # (1)..(14) 連續 14 行


def parse_summary(rows: List[tuple]):
    """回傳 List[dict]：逐 section 逐雞頭 一行，帶 day1..day31／month_total／
    first_half／second_half。Summary sheet 欄位：col idx2..32＝day1..31，
    col idx34＝全月，idx35＝1-15，idx36＝16-31（0-indexed，見 dump 驗證）。"""
    out = []
    for section, start_row in SUMMARY_SECTIONS:
        for k in range(SUMMARY_BROKER_ROWS):
            row_no = start_row + k
            if row_no - 1 >= len(rows):
                continue
            r = rows[row_no - 1]
            label = _text(r[0]) if len(r) > 0 else ""
            if not label:
                continue
            m = BROKER_CODE_RE.match(label)
            num = m.group(1) if m else ""
            code, _lbl = resolve_broker_code(f"({num}) x") if num else ("", "")
            days = [_num(r[2 + d]) if 2 + d < len(r) else None for d in range(N_DAYS)]
            month_total = _num(r[34]) if len(r) > 34 else None
            first_half = _num(r[35]) if len(r) > 35 else None
            second_half = _num(r[36]) if len(r) > 36 else None
            entry = {
                "section": section,
                "broker_num": num,
                "broker_label": label,
                "broker_code": code,
            }
            for d in range(N_DAYS):
                entry[f"day{d + 1}"] = days[d]
            entry["month_total"] = month_total
            entry["first_half"] = first_half
            entry["second_half"] = second_half
            out.append(entry)
    return out


# ---------------------------------------------------------------------------
# Site map：block / sub_block / property code / customer_label pattern
#   → site_id（人手權威表，per P0-執行計劃.md §8 WP5-A4 指引寫死）
# ---------------------------------------------------------------------------

# 每條 rule：(match_kind, pattern, site_id, note)
#   match_kind='property'      pattern 同 post['property'].strip() 完全相等
#   match_kind='property_ic'   property 相等 且 customer_label 含 'IC'
#   match_kind='property_dc'   property 相等 且 customer_label 含 '數據中心'
#   match_kind='property_block' property 相等 且 block 含 pattern[1]（用嚟分
#                                 啟航 OT 呢種泛用 code）
#   match_kind='customer_contains' customer_label 含 pattern
#   match_kind='block'         post['block'] == pattern
# 規則由上至下試，第一條中就用；全部唔中先跌落 unmapped。
SITE_MAP_RULES: List[Tuple[str, object, str, str]] = [
    ("property_ic", "CP5", "S012", "數碼港 CP5 IC（月費 32000 IC 崗）"),
    ("property_dc", "CP5", "S013", "數碼港 CP5 數據中心"),
    ("property", "CP5", "S011", "數碼港 CP5"),
    ("property", "DC", "S013", "數碼港 數據中心"),
    ("property", "數碼", "S010", "數碼港 CP1-4"),
    ("property", "醫學院", "S008", "HKU 醫學院"),
    ("property", "港C1", "S007", "HKU座頭 8hrs"),
    ("property", "港C", "S007", "HKU座頭 8hrs（含上村 override）"),
    ("property", "港Y", "S006", "HKU Y更 12hrs"),
    ("property", "IFC", "S002", "IFC"),
    ("property", "RR", "S015", "Weave Robinson（羅便臣道68號）"),
    ("property", "ML", "S014", "Weave Mid-level／醫院道8號（待確認）"),
    ("property", "OL", "S004", "Weave OL（Weave Olympic）"),
    ("property", "皓日", "S005", "皓日"),
    ("property_ic", "創富廠", "S026", "創富廠IC"),
    ("property", "創富廠", "S019", "城巴-創富車廠"),
    ("property", "柴廠", "S018", "城巴-柴灣車廠"),
    ("property", "屯廠", "S020", "城巴-屯門車廠"),
    ("property", "東廠", "S021", "城巴-東涌車廠"),
    ("property", "將廠", "S022", "城巴-將軍澳車廠"),
    ("property", "黃竹廠", "S023", "城巴-黃竹坑車廠"),
    ("property", "西九廠", "S024", "城巴-西九龍車廠"),
    ("property", "上環廠", "S025", "城巴-上環車廠"),
    ("property", "東濤苑", "S035", "東濤苑"),
    ("property", "M+", "S034", "M+"),
    ("property", "控制室", "S031", "威信控制室"),
    # WP5b（2026-09-10）：威信Patrol＝都會大學夜巡邏（S032），唔係控制室
    # （S031）——同雞頭（威信）但獨立崗位，答案已確認（見P0-執行計劃.md
    # §8 Q8：威信Patrol公司兵一位安員20更，上單價19,804/月，＝都會大學夜
    # 巡邏19,804；PDPO：安員真名唔喺source code，可查out/wp2b/guards.csv）。
    ("property", "Patrol", "S032", "威信Patrol＝都會大學夜巡邏（唔係控制室，已確認）"),
    ("property", "MU", "S033", "都會大學（sites.csv alias MU）"),
    ("property", "粉嶺倉", "S003", "粉嶺安樂村貨倉"),
    ("property", "殷樺", "S001", "殷樺花園"),
    ("property", "小欖", "S027", "屯門小欖樂怡街5號"),
    ("property", "凱和", "S009", "屯門凱和山"),
    ("property", "蔚峰園", "S029", "淺水灣道11號蔚峰園"),
    ("property", "企業", "S016", "九龍企業大廈"),
    ("property", "OT3", "S016", "九龍企業大廈打風OT"),
    ("property", "怡安168", "S028", "怡安168"),
    ("property", "哈羅", "S042", "哈羅國際學校"),
    ("property", "美心", "S030", "美心集團中心"),
    ("property_block", ("OT", "啟航"), "S017", "啟航1331 OT"),
    ("property", "啟航", "S017", "啟航1331"),
    ("property", "葵發", "S037", "葵發大廈（卓弘，代號見 client-names.json，D3a）"),
    ("property", "恆星樓", "S036", "恆星樓（卓弘，代號見 client-names.json，D3a）"),
    ("property", "半更", "S036", "恆星樓打風OT半更"),
    ("property", "ICBC", "S041", "ICBC Tower"),
    ("property", "龍譽", "S043", "補龍譽早（特殊收入項，D3）"),
    ("property", "貨倉", "S044", "惠康貨倉（特殊收入項，D3）"),
    ("property", "Sogo", "S045", "SOGO CWB（嘉捷，代號見 client-names.json，D3a）"),
    ("property", "Garden East", "S046", "Garden East（嘉捷，代號見 client-names.json，D3a）"),
    ("property", "HKW", "S064", "HKW（個別雞頭 Event 客戶，sites.csv alias HKW）"),
    ("property", "國泰城", "S038", "國泰城"),
    ("property", "CX", "S038", "國泰城"),
]

# 呢啲 property code 已知冇對應 site_id（D4／N3／P6 未答，或者根本唔係
# 「盤」— HQ現金糧／個別雞頭佣金／Bogh Guard／Tenti Body Guard 呢類特殊收入項），
# 逐條原因記低，唔畀佢哋靜雞跌落 unmapped 冇解釋。
KNOWN_UNMAPPED_REASONS = {
    "國泰坊": "同國泰城(S038)價目/時段一樣但客戶名稱唔同，可能係打字別名或者真係獨立客戶——"
              "需要老闆確認係咪 S038 嘅別名（新問題，見報告）。",
    "海洋廠": "海洋公園城巴車廠，sites.csv 冇呢個盤（S018-S025 只有 8 個），可能係新盤或者"
              "併入某個現有車廠——需要老闆確認（新問題）。",
    "Bogh": "Bogh Guard，個別雞頭客戶（Bogh Guard佣金/個別雞頭佣金 同組），唔喺 sites.csv，"
            "屬於 D3 已答嘅個別雞頭特殊收入項範圍，唔算「盤」。",
    "HQ": "HQ 現金糧——財務項目（一次過現金出糧），唔係「盤」，唔使 site_id。",
    "BG": "Tenti Body Guard，個別雞頭 Event 特殊收入項（D3 已答，發票 07001）。",
    _BROKER_P: "個別雞頭月薪/佣金/Ling糧——個別雞頭個人薪酬同佣金項目（P0-執行計劃§8 D3 個別雞頭 Event"
             "特殊收入項同類），唔係「盤」，唔使 site_id。",
    _BROKER_K: "長工雞頭費 (K) 呢類 property=雞頭名 嘅行係雞頭介紹費行（P3a），唔係崗位，唔使 site_id。",
    _BROKER_W: "長工雞頭費 (W) 同上，雞頭介紹費行。",
    _BROKER_T_SURNAME: "長工雞頭費 (T，總表用姓氏稱呼) 同上，雞頭介紹費行。",
    _BROKER_G: "長工雞頭費 (G) 同上，雞頭介紹費行。",
}


def resolve_site_id(post: dict) -> Tuple[str, str]:
    """回傳 (site_id, rule_note)；搵唔到就 site_id=''。"""
    prop = post["property"]
    label = post["customer_label"]
    block = post["block"]
    for kind, pattern, site_id, note in SITE_MAP_RULES:
        if kind == "property":
            if prop == pattern:
                return site_id, note
        elif kind == "property_ic":
            if prop == pattern and "IC" in label:
                return site_id, note
        elif kind == "property_dc":
            if prop == pattern and "數據中心" in label:
                return site_id, note
        elif kind == "property_block":
            p_code, block_sub = pattern
            if prop == p_code and block_sub in block:
                return site_id, note
        elif kind == "customer_contains":
            if pattern in label:
                return site_id, note
        elif kind == "block":
            if block == pattern:
                return site_id, note
    return "", ""


def write_master_site_map_csv(path: Path) -> None:
    """將 SITE_MAP_RULES 寫做 out/wp5/master_site_map.csv（診斷/審核用，冇
    真名；2026-09-10 修必修10，由 mappings/ 搬過嚟——呢個係自動生成檔，
    唔係人手表，人手要改就改 SITE_MAP_RULES 呢個常數本身）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["match_kind", "pattern", "site_id", "note"])
        for kind, pattern, site_id, note in SITE_MAP_RULES:
            pattern_s = "|".join(pattern) if isinstance(pattern, tuple) else pattern
            w.writerow([kind, pattern_s, site_id, note])


# ---------------------------------------------------------------------------
# Orchestrator：run-wp5
# ---------------------------------------------------------------------------

POSTS_FIELDS = [
    "post_id", "row_no", "block", "sub_block", "customer_label",
    "guard_name_hint", "property", "shift", "time", "client_rate",
    "payout_rate", "customer_code", "is_broker_fee_row", "site_id",
    "site_map_note",
]

ASSIGN_FIELDS = [
    "post_id", "row_no", "day", "work_date", "site_id", "cell_value",
    "broker_raw", "broker_code", "broker_label", "remark", "other",
    "rescue_rate", "unbilled", "paid",
]

SUMMARY_FIELDS = (
    ["section", "broker_num", "broker_label", "broker_code"]
    + [f"day{d}" for d in range(1, N_DAYS + 1)]
    + ["month_total", "first_half", "second_half"]
)

UNMAPPED_FIELDS = ["post_id", "row_no", "block", "sub_block", "property", "customer_label_redacted", "reason"]


def run_wp5_parse() -> dict:
    """讀 Roster/Summary sheet，寫 out/wp5/master_posts.csv、
    master_assignments.csv、master_summary.csv、unmapped-master.csv、
    master_site_map.csv、master_guard_broker_confirmations.csv、
    master_site_day_broker_counts.csv（2026-09-10 修必修10：呢三個自動生成
    檔已經由 mappings/ 搬去 out/wp5/，mappings/ 淨係留人手表）。回傳統計
    摘要 dict。

    真名去識別化：先解析原始文字，最後先至用 Redactor 將真名代做 guard_id
    先寫落 CSV——tools/ 底下嘅 out/wp5/*.csv 全部唔會出現真人姓名。
    """
    paths.clean_out_wp5_dir()

    rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)
    summary_rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, SUMMARY_SHEET)

    raw_posts, raw_assignments = parse_roster_posts_and_assignments(rows)

    from .mappings_io import load_sites
    sites = load_sites()
    block_bases = {p.get("block", "") for p in raw_posts} | {_strip_block_suffix(p.get("block", "")) for p in raw_posts}
    property_codes = {p["property"] for p in raw_posts}
    vocab = _build_site_vocab(sites, block_bases, property_codes)
    name_index = _load_guard_name_index()
    redactor = Redactor(name_index, vocab)

    posts_out = []
    unmapped_out = []
    site_counter = Counter()
    for p in raw_posts:
        site_id, note = ("", "") if p["is_broker_fee_row"] else resolve_site_id(p)
        row = dict(p)
        row["customer_label"] = redactor.redact(p["customer_label"])
        row["guard_name_hint"] = redactor.redact(p["guard_name_hint"])
        row["site_id"] = site_id
        row["site_map_note"] = note
        posts_out.append(row)
        site_counter[site_id or "(unmapped)"] += 1
        if not site_id and not p["is_broker_fee_row"]:
            reason = KNOWN_UNMAPPED_REASONS.get(p["property"], "")
            unmapped_out.append({
                "post_id": p["post_id"], "row_no": p["row_no"], "block": p["block"],
                "sub_block": p["sub_block"], "property": p["property"],
                "customer_label_redacted": row["customer_label"],
                "reason": reason or "冇對應規則，待人手核對",
            })

    post_site_by_id = {p["post_id"]: p["site_id"] for p in posts_out}
    posts_fee_rows = sum(1 for p in raw_posts if p["is_broker_fee_row"])
    posts_mapped_to_site = sum(1 for row in posts_out if row["site_id"])

    assign_out = []
    broker_counter = Counter()
    unknown_broker_raw = Counter()
    for a in raw_assignments:
        code, label = resolve_broker_code(a["broker_raw"])
        if a["broker_raw"] and code in ("", "UNKNOWN"):
            unknown_broker_raw[a["broker_raw"]] += 1
        row = dict(a)
        row["broker_code"] = code
        row["broker_label"] = label
        row["remark"] = redactor.redact(a["remark"])
        row["site_id"] = post_site_by_id.get(a["post_id"], "")
        assign_out.append(row)
        # WP5c必修7：broker_dist（畀CLI summary/report用嘅「更次」口徑）要
        # 隔走「甩更／取消」呢3格——呢3格代表冇實際做過嘅更，計落broker
        # 分佈會整多3。master_assignments.csv本身（assign_out）唔受影響，
        # 逐日格總數（3,393）保留原始解析。
        if code and a["other"] not in NO_SHOW_OTHER_VALUES:
            broker_counter[code] += 1

    summary_out = parse_summary(summary_rows)

    paths.ensure_out_wp5_dir()
    with open(paths.WP5_MASTER_POSTS_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=POSTS_FIELDS)
        w.writeheader()
        for row in posts_out:
            w.writerow({k: row.get(k, "") for k in POSTS_FIELDS})

    with open(paths.WP5_MASTER_ASSIGNMENTS_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=ASSIGN_FIELDS)
        w.writeheader()
        for row in assign_out:
            w.writerow({k: row.get(k, "") for k in ASSIGN_FIELDS})

    with open(paths.WP5_MASTER_SUMMARY_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=SUMMARY_FIELDS)
        w.writeheader()
        for row in summary_out:
            w.writerow({k: row.get(k, "") for k in SUMMARY_FIELDS})

    with open(paths.WP5_UNMAPPED_MASTER_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=UNMAPPED_FIELDS)
        w.writeheader()
        for row in unmapped_out:
            w.writerow({k: row.get(k, "") for k in UNMAPPED_FIELDS})

    write_master_site_map_csv(paths.MASTER_SITE_MAP_CSV)
    guard_broker_rows = write_guard_broker_confirmations_csv(paths.MASTER_GUARD_BROKER_CSV)
    site_day_broker_rows = write_site_day_broker_counts_csv(paths.MASTER_SITE_DAY_BROKER_CSV)
    referral_fee_rows = write_referral_fee_validation_csv(paths.WP5_REFERRAL_FEE_VALIDATION_CSV)

    # WP5c必修7：口徑要喺summary明文分開講——master_assignments.csv 逐日格
    # 總數（3,393，唔變，原始解析）vs 隔走「甩更／取消」之後嘅「更次」總數
    # （broker_dist總和，預期3,390）。
    no_show_cells = sum(
        1 for row in assign_out
        if row.get("broker_code") and row.get("other", "") in NO_SHOW_OTHER_VALUES
    )
    broker_dist_total = sum(broker_counter.values())

    stats = {
        "posts": len(posts_out),
        "assignments": len(assign_out),
        "summary_rows": len(summary_out),
        "unmapped_posts": len(unmapped_out),
        "broker_dist": dict(broker_counter),
        "unknown_broker_raw": dict(unknown_broker_raw),
        "site_dist": dict(site_counter),
        "name_redacted_resolved": redactor.resolved_count,
        "name_redacted_unresolved": redactor.unresolved_count,
        "guard_broker_confirmations": len(guard_broker_rows),
        "guard_broker_confirmed_high": sum(
            1 for r in guard_broker_rows if r["confirmed_broker_code"]
        ),
        "site_day_broker_rows": len(site_day_broker_rows),
        "assignments_no_show_excluded": no_show_cells,
        "broker_dist_total": broker_dist_total,
        "referral_fee_rows": len(referral_fee_rows),
        "referral_fee_groups_diff": len({
            r["group_key"] for r in referral_fee_rows if r["status"] == "diff"
        }),
        "posts_fee_rows": posts_fee_rows,
        "posts_mapped_to_site": posts_mapped_to_site,
    }

    write_wp5_report(paths.WP5_REPORT_MD, stats, unmapped_out, assign_out, referral_fee_rows)

    return stats


if __name__ == "__main__":
    import json
    print(json.dumps(run_wp5_parse(), ensure_ascii=False, indent=2, sort_keys=True))


# ---------------------------------------------------------------------------
# WP5-C（§11）：guard_id → 總表確認嘅 broker_code，畀 normalize.py 加做
# 最高優先級 rule 0（總表有覆蓋嘅安員 → settlement_unit 跟總表，唔理現有
# 糧明細/盤級規則點講）。用 guard_id 唔用真名（PDPO），對照表放
# mappings/（入 git，冇真名）。
# ---------------------------------------------------------------------------

GUARD_ID_RE = re.compile(r"^\[NAME:(G\d+)\]$")

MASTER_BROKER_SETTLEMENT = {
    # 總表 broker_code → mappings/brokers.csv canonical_name（settlement_unit
    # 欄用嘅字串，K/W/G/D/T 真名經 private_mappings 讀，見檔頭）。
    # LT／OTHER／EXTERNAL／UNKNOWN 特殊值另外處理（P＝個別雞頭 B08，已經
    # 併入正常代號流程，唔再用獨立 sentinel）。
    "K": _BROKER_K, "W": _BROKER_W, "G": _BROKER_G, "D": _BROKER_D, "T": _BROKER_T, "Y": "公司兵",
}

GUARD_BROKER_CONFIRM_FIELDS = [
    "guard_id", "confirmed_broker_code", "confirmed_settlement_unit",
    "n_matched", "n_total", "confidence", "note",
]


def build_guard_broker_confirmations(min_ratio: float = 0.7, assignments: Optional[List[dict]] = None) -> List[dict]:
    """逐 guard_id 統計佢喺總表出現嘅逐日 broker_code 分佈（掃 `remark` 欄，
    已經 redact 做 `[NAME:guard_id]`）。如果單一 broker_code 佔 >= min_ratio
    （預設 70%），就當呢個 guard 嘅 settlement_unit 由總表確認（confidence=
    high，n_matched/n_total 全部一致就係 100%）。呢個表取代舊嘅
    page_level_settlements.csv（單一 site+roster_code fallback），變成逐
    人、由總表逐日數據驅動嘅確認。

    WP5-C（2026-09-10 修，§2 修必修1「run-wp5 隱性依賴 out/wp2b/guards.csv」）：
    `assignments` 冇畀（None）就讀 out/wp5/master_assignments.csv（獨立
    `run-wp5` CLI／test_wp5.py 用嘅舊行為）；有畀就直接用嗰個記憶體 list
    （wp2b_run.py 而家用呢個入口，見 build_rule01_rule02_inputs()——打破
    wp5→wp2b 嘅循環依賴，唔使 out/wp5/*.csv 已經寫咗落磁盤先計到）。"""
    if assignments is None:
        if not paths.WP5_MASTER_ASSIGNMENTS_CSV.exists():
            return []
        with open(paths.WP5_MASTER_ASSIGNMENTS_CSV, encoding="utf-8", newline="") as fh:
            assignments = list(csv.DictReader(fh))
    guard_broker: Dict[str, Counter] = defaultdict(Counter)
    for row in assignments:
        remark = row.get("remark", "")
        code = row.get("broker_code", "")
        if not remark or not code:
            continue
        m = GUARD_ID_RE.match(remark)
        if not m:
            continue
        guard_broker[m.group(1)][code] += 1

    out = []
    for gid, counter in sorted(guard_broker.items()):
        total = sum(counter.values())
        top_code, top_n = counter.most_common(1)[0]
        ratio = top_n / total if total else 0.0
        if ratio < min_ratio:
            note = f"總表逐日 broker 分佈唔夠集中（{dict(counter)}），唔做 rule 0 override"
            confidence = "low"
        else:
            note = f"總表逐日 broker 分佈：{dict(counter)}"
            confidence = "high" if ratio >= 0.95 else "medium"
        settlement_unit = MASTER_BROKER_SETTLEMENT.get(top_code, "")
        if top_code == "LT":
            settlement_unit = "autopay_longterm"
        elif top_code == "P":
            settlement_unit = _BROKER_P
        elif top_code == "EXTERNAL":
            settlement_unit = "external"
        elif top_code == "OTHER":
            settlement_unit = ""  # 「其他」冇對應嘅具體結算單位，唔做 override
        out.append({
            "guard_id": gid,
            "confirmed_broker_code": top_code if ratio >= min_ratio else "",
            "confirmed_settlement_unit": settlement_unit if ratio >= min_ratio else "",
            "n_matched": top_n,
            "n_total": total,
            "confidence": confidence,
            "note": note,
        })
    return out


def write_guard_broker_confirmations_csv(path: Path, min_ratio: float = 0.7) -> List[dict]:
    rows = build_guard_broker_confirmations(min_ratio=min_ratio)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=GUARD_BROKER_CONFIRM_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in GUARD_BROKER_CONFIRM_FIELDS})
    return rows


# ---------------------------------------------------------------------------
# WP5b rule 0.2（P0-執行計劃.md §8 WP5「總表歸屬做齊」）：逐 (site_id,
# work_date) 嘅總表 broker_code 分佈——冇任何姓名／guard_id，純數字統計，
# 畀 normalize.py 喺 rule 0.1（guard 級）冇覆蓋到嘅記錄度，用「呢日呢盤總表
# 剩低配額淨係得一個 broker」嘅消去法補歸屬。呢個同 build_guard_broker_
# confirmations() 唔同：嗰個係逐 guard_id（要 remark 有 [NAME:guard_id]），
# 呢個係逐 site+day 嘅崗位總數（唔理 remark 有冇名，總表逐格都計），所以
# 覆蓋面大好多（HKU Y更 呢類 remark 成欄空白嘅盤，rule 0.1 完全冇覆蓋，但
# rule 0.2 就用到）。
# ---------------------------------------------------------------------------

SITE_DAY_BROKER_FIELDS = ["site_id", "work_date", "broker_code", "count"]

# WP5c必修7（2026-09-10，P0-執行計劃.md §8 WP5 item 7）：總表「其他」欄
# （assignments 嘅 `other` 欄）寫住「甩更」（no-show，安員冇返，八月扣糧）
# 或者「取消」（呢更整個取消）嘅格，代表個崗位事實上冇人做過呢更，唔應該
# 當一個真.更次計入 rule 0.2 嘅逐(site,day) broker 配額——實測 3 格（row116
# d8=2026-07-08「無返,8月扣」＋(10)其他甩更、row174 d14=2026-07-14 (10)其他
# 甩更、row175 d10=2026-07-10 客戶(EXTERNAL)取消），全部由總表原始xlsx直接
# 讀出（唔係估計）。口徑：master_assignments.csv 逐日格總數（3,393）唔變
# （保留原始解析），但 build_site_day_broker_counts()／rule 0.2 用嘅「更次」
# 口徑隔走呢3格，變 3,390。
NO_SHOW_OTHER_VALUES = {"甩更", "取消"}


def build_site_day_broker_counts(assignments: Optional[List[dict]] = None) -> List[dict]:
    """回傳 [{site_id, work_date, broker_code, count}, ...]，逐
    (site_id, work_date, broker_code) 一行，count=嗰日嗰盤總表記做呢個
    broker_code 嘅崗位格數（唔理有冇 remark）。只計 site_id／broker_code
    都非空嘅格（unmapped post 或 broker_raw 解唔到嘅唔計，因為對唔落我哋
    自己嘅 shift_records），同埋 `other` 欄唔係 NO_SHOW_OTHER_VALUES（甩更／
    取消——WP5c必修7，呢啲格代表冇實際做過呢更，計落 rule 0.2 配額會整多
    咗，見上面常數嘅註解）。

    `assignments` 冇畀就讀 out/wp5/master_assignments.csv（獨立 run-wp5
    行為）；有畀（wp2b_run.py 傳記憶體 list）就直接用，見
    build_guard_broker_confirmations() 同一個修法。"""
    if assignments is None:
        if not paths.WP5_MASTER_ASSIGNMENTS_CSV.exists():
            return []
        with open(paths.WP5_MASTER_ASSIGNMENTS_CSV, encoding="utf-8", newline="") as fh:
            assignments = list(csv.DictReader(fh))
    counts: Dict[Tuple[str, str, str], int] = defaultdict(int)
    for row in assignments:
        site_id = row.get("site_id", "")
        work_date = row.get("work_date", "")
        code = row.get("broker_code", "")
        if not site_id or not work_date or not code:
            continue
        if row.get("other", "") in NO_SHOW_OTHER_VALUES:
            continue
        counts[(site_id, work_date, code)] += 1
    out = [
        {"site_id": k[0], "work_date": k[1], "broker_code": k[2], "count": v}
        for k, v in sorted(counts.items())
    ]
    return out


def write_site_day_broker_counts_csv(path: Path) -> List[dict]:
    rows = build_site_day_broker_counts()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=SITE_DAY_BROKER_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in SITE_DAY_BROKER_FIELDS})
    return rows


# ---------------------------------------------------------------------------
# WP5-C 修（2026-09-10，P0-執行計劃.md §8 WP5 必修2「run-wp5 隱性依賴
# out/wp2b/guards.csv」）：畀 wp2b_run.py 用嘅記憶體版入口——一次過由總表
# xlsx 算返 rule 0.1／0.2 要嘅兩個表，唔經 out/wp5/*.csv 中間檔，亦唔使
# out/wp2b/guards.csv 已經喺磁盤出現先計到（打破循環依賴）。
# ---------------------------------------------------------------------------

def build_rule01_rule02_inputs(
    guards: List[dict], min_ratio: float = 0.7
) -> Tuple[Dict[str, dict], Dict[Tuple[str, str], Counter]]:
    """回傳 (master_guard_broker, master_site_day_broker)，形狀同
    mappings_io.load_master_guard_broker()／load_master_site_day_broker_counts()
    一樣（wp2b_run.py 直接掉包用嗰兩個函數）。

    之前嘅做法要求執行者手動行兩次 run-wp2b：第一次（bootstrap，master
    data 未有）產生 out/wp2b/guards.csv → 行 run-wp5（讀 guards.csv 做
    redaction，寫 mappings/master_guard_broker_confirmations.csv）→ 第二次
    run-wp2b 先用得到 rule 0.1／0.2。呢個兩趟 pipeline 冇任何代碼強制
    順序，「乾淨 checkout 淨係行一次」會靜靜噉跌落舊規則（唔錯，但同
    「跑三次」嘅老手順序結果唔一致）。

    而家 wp2b_run.py 喺自己嘅 resolve_identities() 已經有齊 guards list
    （guard_id／name_zh／name_variants，呢啲喺 R2 settlement 判斷之前已經
    確定，唔受 rule 0.1／0.2 影響——身份合併純粹睇 staff_no/姓名/電話），
    可以直接將呢個 list 傳落嚟，喺同一個 run-wp2b process 入面就地重新解
    析總表 xlsx、就地 redact、就地統計，一個 process 一次過搞掂，唔使兩次
    run-wp2b、唔使中間檔案。

    冇 MASTER_ROSTER_XLSX（老闆總表未提供）就回傳 ({}, {})，rule 0.1/0.2
    自動跌落舊規則，同舊行為一致。

    獨立 `run-wp5` CLI 命令（同 test_wp5.py）保留原本行為（讀/寫
    out/wp5/*.csv），純粹畀人手審核/PDPO 掃描用，唔再係 wp2b 嘅依賴——見
    write_guard_broker_confirmations_csv()／write_site_day_broker_counts_csv()
    嘅 docstring 更新。"""
    if not paths.MASTER_ROSTER_XLSX.exists():
        return {}, defaultdict(Counter)

    rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)
    raw_posts, raw_assignments = parse_roster_posts_and_assignments(rows)

    from .mappings_io import load_sites
    sites = load_sites()
    block_bases = {p.get("block", "") for p in raw_posts} | {
        _strip_block_suffix(p.get("block", "")) for p in raw_posts
    }
    property_codes = {p["property"] for p in raw_posts}
    vocab = _build_site_vocab(sites, block_bases, property_codes)
    name_index = _guard_name_index_from_rows(guards)
    redactor = Redactor(name_index, vocab)

    post_site_by_id: Dict[str, str] = {}
    for p in raw_posts:
        site_id, _note = ("", "") if p["is_broker_fee_row"] else resolve_site_id(p)
        post_site_by_id[p["post_id"]] = site_id

    assign_mem: List[dict] = []
    for a in raw_assignments:
        code, _label = resolve_broker_code(a["broker_raw"])
        assign_mem.append({
            "remark": redactor.redact(a["remark"]),
            "broker_code": code,
            "site_id": post_site_by_id.get(a["post_id"], ""),
            "work_date": a["work_date"],
            # WP5c必修7：一定要傳埋 other 先至可以喺 build_site_day_broker_
            # counts() 隔走「甩更／取消」3格，唔係就算個function識過濾都
            # 冇嘢好過濾（呢個記憶體版assign_mem以前冇帶呢個欄）。
            "other": a["other"],
        })

    confirm_rows = build_guard_broker_confirmations(min_ratio=min_ratio, assignments=assign_mem)
    master_guard_broker = {r["guard_id"]: r for r in confirm_rows}

    site_day_rows = build_site_day_broker_counts(assignments=assign_mem)
    master_site_day_broker: Dict[Tuple[str, str], Counter] = defaultdict(Counter)
    for r in site_day_rows:
        master_site_day_broker[(r["site_id"], r["work_date"])][r["broker_code"]] += r["count"]

    return master_guard_broker, master_site_day_broker


# ---------------------------------------------------------------------------
# WP5c必修12（2026-09-10，P0-執行計劃.md §8「WP5總表對數後新問題」item 12）：
# 「月結有、更表冇」嘅盤（P0-執行計劃§3.7）——20個更表檔完全冇呢啲盤嘅逐日
# 來源，但總表逐崗位逐日格有齊（同埋逐崗位自己嘅上單價/外判價欄），可以
# 補入庫做 shift_records（source=master_roster_only）。
# ---------------------------------------------------------------------------

MASTER_ROSTER_ONLY_SITE_IDS = {
    "S038",  # 國泰城
    "S034",  # M+
    "S012",  # 數碼港 CP5 IC
    "S031",  # 威信控制室
    "S032",  # 威信Patrol（都會大學夜巡邏）
    "S041",  # ICBC Tower
    "S042",  # 哈羅國際學校
    "S035",  # 東濤苑
    "S039",  # 卓弘（代號見 client-names.json，如未有—實測總表冇呢個盤嘅post，見report）
    "S040",  # 嘉捷（代號見 client-names.json，如未有—實測總表冇呢個盤嘅post，見report）
}


# 呢啲site嘅customer_label有真名後綴，但個「崗位標籤」前綴唔喺sites.csv嘅
# canonical_name／aliases度（威信控制室／威信Patrol係總表自己嘅寫法，
# sites.csv記嘅係「控制室」「都會大學夜巡邏」呢啲另一套正名，見D3a/正名
# 決定），要另外補一個前綴清單先剝到走前綴留低真名——呢啲字串本身係崗位
# 標籤（同SITE_MAP_RULES嘅note一樣性質），唔係人名，唔犯「真名唔准入
# tools/」。
_MASTER_ROSTER_ONLY_LABEL_PREFIXES: Dict[str, List[str]] = {
    "S031": ["威信控制室"],
    "S032": ["威信Patrol"],
}


def _extract_master_roster_only_guard_name(customer_label: str, site_id: str,
                                             sites_by_id: Dict[str, dict]) -> str:
    """由post嘅customer_label剝走已知嘅「崗位標籤」前綴，留低嘅就係安員
    真名（冇剩就代表呢個崗位總表根本冇填人名，例如國泰城/ICBC/哈羅/東濤苑
    嘅post）。剝法：試site嘅canonical_name／aliases（sites.csv）＋
    `_MASTER_ROSTER_ONLY_LABEL_PREFIXES`嘅override，由長至短排序（長prefix
    優先，避免「數碼港」剝走咗但漏低「CP5 IC」）。剝完淨低嘅殘留仲要清走
    包住嘅括號（CP5 IC嗰個post用「數碼港 CP5 IC (姓名)」呢種括號寫法，
    唔同威信控制室/威信Patrol/M+嘅純空格寫法）。"""
    label = customer_label.strip()
    site = sites_by_id.get(site_id, {})
    prefixes = list(_MASTER_ROSTER_ONLY_LABEL_PREFIXES.get(site_id, []))
    if site.get("canonical_name"):
        prefixes.append(site["canonical_name"])
    prefixes.extend(site.get("aliases") or [])
    for p in sorted(set(prefixes), key=len, reverse=True):
        if label == p:
            return ""
        if label.startswith(p):
            remainder = label[len(p):].strip()
            if remainder.startswith("(") and remainder.endswith(")"):
                remainder = remainder[1:-1].strip()
            return remainder
    # 冇任何已知前綴匹配——如果成個label本身睇落已經冇多餘字（同site
    # canonical_name長度差好遠），就當佢係未見過嘅格式，原句返去畀caller
    # 決定（唔靜靜吞咗）。
    return label


def build_master_roster_only_rows(site_ids: Optional[set] = None) -> List[dict]:
    """回傳呢啲「月結有、更表冇」site嘅逐日候選記錄（未經redact——真名喺
    `guard_name_raw`，caller（wp2b_run.py）負責身份解析，PDPO由caller嗰邊
    嘅現有機制（guards.csv本身就存真名，跟`get_or_create_payroll_guard`
    同一個做法）負責，呢個function嘅結果純粹喺記憶體用，唔經CSV寫落
    `out/wp5/`（避免同`run_wp5_parse()`嘅redact-before-write承諾矛盾）。

    每條記錄帶埋嗰個崗位（post）自己嘅client_rate／payout_rate（總表逐
    post表頭嘅上單價/外判價欄）——呢啲post之間即使time_slot一樣，rate都
    可能唔同（例如威信控制室3個post全部1930-0730，但1930-0730）但3個
    rate 840/840/901.36 唔同——所以唔可以用(site_id,time_slot)做shift_type
    key（會屈埋唔同rate嘅post，令pricing.py搵唔到啱嘅client_rate），
    caller要逐post自己keyingshift_type。

    冇MASTER_ROSTER_XLSX（老闆總表未提供）就回傳[]，同其他master_roster_*
    function一致嘅降級行為。"""
    if not paths.MASTER_ROSTER_XLSX.exists():
        return []
    site_ids = site_ids or MASTER_ROSTER_ONLY_SITE_IDS
    rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)
    raw_posts, raw_assignments = parse_roster_posts_and_assignments(rows)
    post_by_id = {p["post_id"]: p for p in raw_posts}

    from .mappings_io import load_sites
    sites_by_id = {s["site_id"]: s for s in load_sites()}

    out = []
    for a in raw_assignments:
        post = post_by_id.get(a["post_id"])
        if not post or post["is_broker_fee_row"]:
            continue
        site_id, _note = resolve_site_id(post)
        if site_id not in site_ids:
            continue
        code, _label = resolve_broker_code(a["broker_raw"])
        if code not in MASTER_BROKER_SETTLEMENT:
            # OTHER／EXTERNAL／UNKNOWN／空——冇對應嘅現金結算單位，唔生成
            # shift_record（呢8+2個site實測冇呢類格，見report，寫呢個
            # guard係俾將來資料變動做防禦）。
            continue
        if a.get("other", "") in NO_SHOW_OTHER_VALUES:
            continue
        guard_name_raw = _extract_master_roster_only_guard_name(
            post["customer_label"], site_id, sites_by_id)
        out.append({
            "post_id": post["post_id"], "row_no": post["row_no"],
            "site_id": site_id, "property": post["property"],
            "block": post["block"], "sub_block": post["sub_block"],
            "shift": post["shift"], "time": post["time"],
            "client_rate": post["client_rate"], "payout_rate": post["payout_rate"],
            "guard_name_raw": guard_name_raw,
            "broker_code": code,
            "settlement_unit": MASTER_BROKER_SETTLEMENT[code],
            "work_date": a["work_date"],
        })
    return out


# ---------------------------------------------------------------------------
# WP5c必修13（2026-09-10，P0-執行計劃.md §8「WP5總表對數後新問題」item
# 13）：長工雞頭費（referral fee）人手費率表驗證。
# ---------------------------------------------------------------------------

# 總表「長工雞頭費 (X)」行嘅property欄＝雞頭真名/總表稱呼，對應
# mappings/brokers.csv嘅broker_id（Q7已答；真名經private_mappings讀，見
# 檔頭 _BROKER_* / _BROKER_T_SURNAME）。
_REFERRAL_FEE_BROKER_ID = {
    _BROKER_K: "B01", _BROKER_W: "B02", _BROKER_T_SURNAME: "B05", _BROKER_G: "B03",
}

REFERRAL_FEE_VALIDATION_FIELDS = [
    "post_id", "row_no", "block", "sub_block", "shift", "broker_id",
    "amount", "rate_per_shift", "implied_shifts", "group_key",
    "group_implied_total", "group_actual_lt_shifts", "group_diff", "status",
]


def _referral_fee_site_key_for_block(block: str) -> str:
    """總表「長工雞頭費」行嘅block文字→referral_fee_rates.csv嘅site_id
    key。啟航1331／Weave係高單價tier，用返嗰個site_id先查到專屬rate；
    其餘（城巴／港大／九龍企業／卓弘…）全部用DEFAULT（呢啲盤嘅rate喺
    referral_fee_rates.csv本身就係跨site劃一，唔使逐個site_id列）。"""
    if "啟航" in block:
        return "S017"
    if "Weave" in block:
        return "S004"  # Weave OL／ML／RR 三個site.rate一樣（50），揀邊個都得
    return "DEFAULT"


def validate_referral_fee_rates(posts: Optional[List[dict]] = None,
                                 assignments: Optional[List[dict]] = None) -> List[dict]:
    """回傳逐條「長工雞頭費」行嘅驗證結果（唔含真名——property欄本身就係
    雞頭簡稱，唔係安員名）。方法：`amount ÷ mappings/referral_fee_rates.csv`
    嘅rate＝implied長工更數，同總表同一(block,sub_block,shift) group底下
    實際`(8)長工`格數比較——多條費用行可以共用同一個group（例如「城巴車廠
    12hrs(N/S)」有4條分開嘅費用行：W一條、T(總表姓氏稱呼)三條），要group加埋先同
    actual比先啱。

    `posts`/`assignments` 冇畀就自己讀MASTER_ROSTER_XLSX（獨立run-wp5行
    為）；有畀（未來wp2b想順手驗證都得）就直接用，同其他master_roster_*
    function一致嘅記憶體入口設計。冇MASTER_ROSTER_XLSX就回傳[]。"""
    if posts is None or assignments is None:
        if not paths.MASTER_ROSTER_XLSX.exists():
            return []
        rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)
        posts, assignments = parse_roster_posts_and_assignments(rows)

    posts_by_id = {p["post_id"]: p for p in posts}
    fee_rows = [p for p in posts if p["is_broker_fee_row"]]

    # 三層fallback（同build_site_day_broker_counts嘅精神一致：越精細越
    # 準）：費用行嘅sub_block／shift經常留空（總表寫呢類彙總行慣例），要
    # 逐級撞唔到先降級——(block,sub_block,shift)精確 → (block,sub_block)
    # 加埋幾個shift → (block)加埋成個block。啟航1331有sub_block（8/12hrs
    # D/M/N）分得夠細，用第一層就啱；城巴車廠/港大/九龍企業/卓弘嘅費用行
    # sub_block／shift留空，要跌落第三層（成個block加埋）。
    lt_by_key: Dict[Tuple[str, str, str], int] = defaultdict(int)
    lt_by_block_sub: Dict[Tuple[str, str], int] = defaultdict(int)
    lt_by_block: Dict[str, int] = defaultdict(int)
    for a in assignments:
        post = posts_by_id.get(a["post_id"])
        if not post or post["is_broker_fee_row"]:
            continue
        code, _label = resolve_broker_code(a["broker_raw"])
        if code != "LT":
            continue
        lt_by_key[(post["block"], post["sub_block"], post["shift"])] += 1
        lt_by_block_sub[(post["block"], post["sub_block"])] += 1
        lt_by_block[post["block"]] += 1

    def _actual_lt_count(block: str, sub_block: str, shift: str) -> int:
        if sub_block or shift:
            hit = lt_by_key.get((block, sub_block, shift))
            if hit:
                return hit
        if sub_block:
            hit = lt_by_block_sub.get((block, sub_block))
            if hit:
                return hit
        return lt_by_block.get(block, 0)

    from .mappings_io import load_referral_fee_rates, referral_fee_rate_for
    rates = load_referral_fee_rates()

    # 費用行分組亦要跟返同一個fallback邏輯：同一(block,sub_block)之下、
    # 冚唪唥shift留空嘅費用行（例如城巴車廠12hrs(N/S)嗰4條T(姓氏稱呼)/W）要當
    # 一組一齊同actual比，先至同「total表冇拆開邊個shift」呢個事實一致；
    # 有sub_block（啟航1331）嘅費用行本身已經夠細，唔使夾埋唔同sub_block。
    def _group_key_for_fee_row(p: dict) -> Tuple[str, str, str]:
        if p["sub_block"]:
            return (p["block"], p["sub_block"], p["shift"])
        return (p["block"], "", "")

    groups: Dict[Tuple[str, str, str], List[dict]] = defaultdict(list)
    for p in fee_rows:
        groups[_group_key_for_fee_row(p)].append(p)

    out = []
    for key, group_posts in sorted(groups.items()):
        block, sub_block, shift = key
        site_key = _referral_fee_site_key_for_block(block)
        implied_total = Decimal("0")
        detail = []
        for p in sorted(group_posts, key=lambda x: x["row_no"]):
            broker_id = _REFERRAL_FEE_BROKER_ID.get(p["property"], "")
            rate_str, _note = referral_fee_rate_for(broker_id, site_key, rates)
            amount = Decimal(str(p["payout_rate"] or 0))
            implied = (amount / Decimal(rate_str)) if rate_str else None
            if implied is not None:
                implied_total += implied
            detail.append((p, broker_id, amount, rate_str, implied))
        actual = Decimal(_actual_lt_count(block, sub_block, shift))
        group_diff = implied_total - actual
        group_status = "match" if group_diff == 0 else "diff"
        group_label = f"{block}|{sub_block}|{shift}"
        for p, broker_id, amount, rate_str, implied in detail:
            out.append({
                "post_id": p["post_id"], "row_no": p["row_no"], "block": block,
                "sub_block": sub_block, "shift": shift, "broker_id": broker_id,
                "amount": str(amount), "rate_per_shift": rate_str,
                "implied_shifts": str(implied) if implied is not None else "",
                "group_key": group_label,
                "group_implied_total": str(implied_total),
                "group_actual_lt_shifts": str(actual),
                "group_diff": str(group_diff),
                "status": group_status,
            })
    return out


def write_referral_fee_validation_csv(path: Path) -> List[dict]:
    rows = validate_referral_fee_rates()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=REFERRAL_FEE_VALIDATION_FIELDS)
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in REFERRAL_FEE_VALIDATION_FIELDS})
    return rows


# ---------------------------------------------------------------------------
# 順手（P0-執行計劃.md §8「WP5總表對數後新問題」逐項尾句）：out/wp5/
# wp5-report.md——解析統計、口徑、site map、K逐日表、雞頭PAID對數。全部
# 數字即場由交付檔計，唔寫死（run_wp5_parse()嘅summary dict/CSV輸出
# 本身已經係逐次重算，呢個function淨係加多一層人話報告）。
# ---------------------------------------------------------------------------

def _kai1331_k_broker_daily_table() -> Tuple[List[dict], dict]:
    """啟航1331（S017）K嘅逐日缺口：總表逐日K-coded格數 vs
    out/wp2b/shift_records.csv 逐日settlement_unit==K真名嘅更數。兩份資料
    冇齊就回傳([], {})（run-wp5獨立跑、未行過run-wp2b/總表未提供都會
    行到呢個分支）。回傳(逐日detail rows, summary dict)。"""
    if not paths.WP2B_SHIFT_RECORDS_CSV.exists() or not paths.MASTER_ROSTER_XLSX.exists():
        return [], {}
    ours: Counter = Counter()
    with open(paths.WP2B_SHIFT_RECORDS_CSV, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("site_id") == "S017" and row.get("record_type") == "shift" \
                    and row.get("settlement_unit") == _BROKER_K:
                ours[row["work_date"]] += 1

    rows = _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)
    raw_posts, raw_assignments = parse_roster_posts_and_assignments(rows)
    post_by_id = {p["post_id"]: p for p in raw_posts}
    theirs: Counter = Counter()
    for a in raw_assignments:
        post = post_by_id.get(a["post_id"])
        if not post or post["is_broker_fee_row"]:
            continue
        site_id, _note = resolve_site_id(post)
        if site_id != "S017":
            continue
        code, _label = resolve_broker_code(a["broker_raw"])
        if code != "K":
            continue
        theirs[a["work_date"]] += 1

    all_dates = sorted(set(ours) | set(theirs))
    detail = []
    total_diff = 0
    for d in all_dates:
        o, t = ours.get(d, 0), theirs.get(d, 0)
        diff = o - t
        if diff != 0:
            detail.append({"work_date": d, "ours": o, "theirs": t, "diff": diff})
            total_diff += diff
    summary = {
        "ours_total": sum(ours.values()), "theirs_total": sum(theirs.values()),
        "total_diff": total_diff,
    }
    return detail, summary


def _unmapped_post_shift_counts(unmapped_out: List[dict],
                                 assign_out: List[dict]) -> Dict[str, int]:
    ids = {u["post_id"] for u in unmapped_out}
    counts: Dict[str, int] = {pid: 0 for pid in ids}
    for a in assign_out:
        if a.get("post_id") in counts:
            counts[a["post_id"]] += 1
    return counts


def build_wp5_report(stats: dict, unmapped_out: List[dict], assign_out: List[dict],
                      referral_fee_rows: List[dict]) -> str:
    """回傳wp5-report.md嘅內容（人話中文），全部數字由`stats`（
    run_wp5_parse()嘅summary dict）／`unmapped_out`／`assign_out`／
    `referral_fee_rows`呢啲即場算好嘅結構即場讀，唔寫死。"""
    lines: List[str] = []
    lines.append("# WP5 — 在勤總表解析報告\n\n")
    lines.append(f"> 由 `run_wp5_parse()` 即場生成（{stats['posts']} 個崗位、"
                 f"{stats['assignments']} 個逐日格）。全部數字逐次重算，唔寫死。\n\n")

    lines.append("## 1. 解析統計\n\n")
    lines.append(f"- 崗位（post）總數：{stats['posts']}\n")
    lines.append(f"- 逐日格（assignment）總數：{stats['assignments']}\n")
    lines.append(f"- 「其他∈{{甩更,取消}}」隔走格數（WP5c必修7）：{stats['assignments_no_show_excluded']}"
                 f"（隔走之後嘅「更次」口徑總數：{stats['broker_dist_total']}）\n")
    lines.append(f"- broker 分佈（隔走甩更/取消之後）：{stats['broker_dist']}\n\n")

    lines.append("## 2. 崗位對 site_id 口徑\n\n")
    n_total = stats["posts"]
    n_unmapped = len(unmapped_out)
    mapped = stats["posts_mapped_to_site"]
    fee_rows = stats["posts_fee_rows"]
    lines.append(f"- {n_total} 個崗位入面：{mapped} 個成功對到 site_id、"
                 f"{fee_rows} 個係「長工雞頭費」彙總行（`is_broker_fee_row=True`，本身唔係"
                 f"崗位，見§8 item13）、{n_unmapped} 個真.unmapped（合計 {fee_rows + n_unmapped} "
                 "對唔到 site_id，見下面）。\n\n")

    shift_counts = _unmapped_post_shift_counts(unmapped_out, assign_out)
    zero_shift = [u for u in unmapped_out if shift_counts.get(u["post_id"], 0) == 0]
    nonzero_shift = [u for u in unmapped_out if shift_counts.get(u["post_id"], 0) > 0]
    lines.append(f"- 14 條真.unmapped 入面：{len(zero_shift)} 條 7 月全 0 更（純佔位/待人手核對）、"
                 f"{len(nonzero_shift)} 條各有 {sorted(set(shift_counts[u['post_id']] for u in nonzero_shift)) or ''}"
                 " 更（個別雞頭個人薪酬/佣金、HQ現金糧、Tenti Body Guard 呢類特殊收入項，"
                 "已喺D3/§8 D3同類機制處理，唔係「盤」，見P0-執行計劃§8）。\n\n")
    lines.append("| post_id | 崗位標籤 | 7月更數 | 原因 |\n|---|---|---|---|\n")
    for u in sorted(unmapped_out, key=lambda x: int(x["row_no"])):
        reason_short = u["reason"][:36] + ("…" if len(u["reason"]) > 36 else "")
        lines.append(f"| {u['post_id']} | {u['customer_label_redacted']} | "
                     f"{shift_counts.get(u['post_id'], 0)} | {reason_short} |\n")
    lines.append("\n")

    lines.append("## 3. Site map\n\n")
    lines.append("- 對照規則見 `out/wp5/master_site_map.csv`（`SITE_MAP_RULES` 常數生成，"
                 "人手要改係改常數本身，唔係呢個CSV）。\n\n")

    lines.append("## 4. 啟航1331（S017）K逐日缺口\n\n")
    detail, kh_summary = _kai1331_k_broker_daily_table()
    if kh_summary:
        lines.append(f"- 總表 K-coded：{kh_summary['theirs_total']} 更；"
                     f"`out/wp2b/shift_records.csv` settlement_unit={_BROKER_K}：{kh_summary['ours_total']} 更；"
                     f"差 {kh_summary['total_diff']} 更（我哋少）。\n\n")
        lines.append("| 日期 | 我哋 | 總表 | 差 |\n|---|---|---|---|\n")
        for r in detail:
            lines.append(f"| {r['work_date']} | {r['ours']} | {r['theirs']} | {r['diff']:+d} |\n")
        lines.append("\n")
    else:
        lines.append("（`out/wp2b/shift_records.csv` 未存在，冇得比——要先行 `run-wp2b`。）\n\n")

    lines.append("## 5. 長工雞頭費 PAID 對數（WP5c必修13）\n\n")
    if referral_fee_rows:
        diff_groups = sorted({r["group_key"] for r in referral_fee_rows if r["status"] == "diff"})
        match_groups = {r["group_key"] for r in referral_fee_rows if r["status"] == "match"}
        lines.append(f"- 逐 block 對數（`out/wp5/referral-fee-validation.csv`）：{len(match_groups)} 組 match、"
                     f"{len(diff_groups)} 組 diff。\n")
        for g in diff_groups:
            row = next(r for r in referral_fee_rows if r["group_key"] == g)
            lines.append(f"  - `{g}`：implied {row['group_implied_total']} 更 vs 實際 "
                         f"{row['group_actual_lt_shifts']} 更（差 {row['group_diff']}）——掛 P3a。\n")
        lines.append("\n")
    else:
        lines.append("（總表未提供或者冇長工雞頭費行。）\n\n")

    return "".join(lines)


def write_wp5_report(path: Path, stats: dict, unmapped_out: List[dict],
                      assign_out: List[dict], referral_fee_rows: List[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = build_wp5_report(stats, unmapped_out, assign_out, referral_fee_rows)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
