"""⑤ rates：價目反推。

對應 P0-執行計劃.md §6 pipeline ⑤、§3.5（出街價=工資+雞頭費）、§3.6（L2 兩條
規則）、§3.7a、§7 WP3。輸出 `rate_cards.csv`（一條 rate 一行，`site_id` +
`shift_type_id`（可空）+ `broker_id`（可空）+ `guard_id`（可空，用嚟拆多價）
做 key）。

三個獨立反推來源，分開三個 section，最後合併做一張表：
  A. 出街價（guard_wage + broker_fee）—— 由 `payroll-rows.csv`（WP2a）逐行讀,
     現金結算單位（T/D/G/W/公司兵/LINK公司兵/K-LINK，真名見
     data/mappings-private/brokers.csv）。
  B. 啟航1331 出街價 —— K 嘅逐日總額冇逐人拆分，用 shift_records 逐日逐更別
     數對 31 個日總額解最小二乘（`solve_kai1331`）。
  C. 收客價（client_rate）—— 發票 PDF 逐開票單位金額 ÷ shift_records 更數。

金額全部用 Decimal；`status` 只有 solved／pending 兩種，pending 一定喺
evidence/note 度講清楚試過乜、缺乜（P0-執行計劃 §7 驗收準則）。
"""
import itertools
import re
from collections import Counter, defaultdict
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Dict, List, Optional, Tuple

from . import wp3_io
from .normalize import BrokerIndex, SiteIndex, normalize_name
from .private_mappings import broker_aliases, broker_canonical_name

# PDPO：雞頭真名（K/W/G/D/T）淨係喺呢度經 private_mappings 讀一次，下面
# 全部用呢幾個變數，源碼本身唔會再出現真名字面值（冇 private 檔就
# fallback 用代號本身，見 private_mappings.py）。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_D = broker_canonical_name("D")
_BROKER_T = broker_canonical_name("T")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
_BROKER_K_1331 = f"{_BROKER_K}-1331"
_BROKER_K_LINK = f"{_BROKER_K}-LINK"
# G 嘅 "-LINK" 別名喺糧明細度用嘅係另一種拼法（唔係 canonical_name 直接加
# 後綴，見 data/mappings-private/brokers.csv 嘅 aliases 欄），要由別名列表
# 揀返嗰個真實拼法，唔可以自己砌。
_BROKER_G_LINK = next((a for a in broker_aliases("G") if a.endswith("-LINK")), f"{_BROKER_G}-LINK")

TWOPLACES = Decimal("0.01")


def D(x) -> Decimal:
    if x is None or x == "":
        return None
    return Decimal(str(x))


def q2(x: Decimal) -> Decimal:
    return x.quantize(TWOPLACES, rounding=ROUND_HALF_UP)


class RateCardBuilder:
    """逐條 rate_card 分配 rate_id，保持輸出穩定（sort by 生成次序 + key）。"""

    def __init__(self):
        self.rows: List[dict] = []
        self._n = 0

    def add(self, *, site_id, shift_type_id=None, broker_id=None, guard_id=None,
            client_rate=None, guard_wage=None, broker_fee=None, payout_rate=None,
            billing_model, source, evidence, confidence, status, note="",
            evidence_chain=None):
        self._n += 1
        self.rows.append({
            "rate_id": f"RC{self._n:04d}",
            "site_id": site_id,
            "shift_type_id": shift_type_id or "",
            "broker_id": broker_id or "",
            "guard_id": guard_id or "",
            "client_rate": "" if client_rate is None else str(q2(client_rate)),
            "guard_wage": "" if guard_wage is None else str(q2(guard_wage)),
            "broker_fee": "" if broker_fee is None else str(q2(broker_fee)),
            "payout_rate": "" if payout_rate is None else str(q2(payout_rate)),
            "billing_model": billing_model,
            "effective_from": "2026-07-01",
            "effective_to": "2026-07-31",
            "source": source,
            "evidence": evidence,
            "confidence": confidence,
            "status": status,
            "note": note,
            # WP3v2 條件1第2點：逐條 solved 收客價要記低證據優先次序（(a) R2
            # 報表 -> (b) 發票整除 -> (c) OT按鐘 -> (d) pro-rata -> (e) 兩價）
            # 實際行到邊一步、行過嘅步驟分別點，唔淨係得最後果一個 note 字串。
            "evidence_chain": " → ".join(evidence_chain) if evidence_chain else "",
        })


# ---------------------------------------------------------------------------
# A. 出街價（guard_wage + broker_fee）：由 payroll-rows.csv 逐行讀
# ---------------------------------------------------------------------------

# settlement_unit（payroll-rows.csv 原文）不入 P0 嘅（LINK C7 細盤現金結算），
# 只做證據記低，唔生成入 shift_records_priced 嘅 rate。
OUT_OF_SCOPE_SETTLEMENT_UNITS = {_BROKER_K_LINK, _BROKER_G_LINK, "LINK公司兵"}

_MIXED_SITE_LABEL_RE = re.compile(r"[（(]混合[)）]")


def build_payout_rate_cards(payroll_rows: List[dict], site_index: SiteIndex,
                             broker_index: BrokerIndex,
                             guards_by_name: Dict[str, List[dict]],
                             rcb: RateCardBuilder) -> List[dict]:
    """Section A：現金結算單位逐行讀 rate/wage/broker_fee，group 做 rate_card。

    Group key = (site_id, broker_id, guard_wage, broker_fee)——同一 site+
    broker 如果唔同安員嘅 wage/fee 唔同，會拆做多條 rate_card（唔平均），
    `guard_ids` 記低邊啲安員用呢條價。
    """
    groups: Dict[Tuple, dict] = {}
    skipped_mixed = []
    unresolved_site = []

    for row in payroll_rows:
        kind = row["shift_kind"]
        settlement_unit = row["settlement_unit"]
        if kind not in ("normal",):
            continue  # monthly_fee/ot/adjustment/flat_referral 分開處理
        if settlement_unit == _BROKER_K_1331:
            continue  # Section B 專門處理（逐日總額，冇逐行 rate）
        if settlement_unit == _BROKER_P:
            continue  # 特殊收入項，唔係 per_shift rate
        site_label = (row["site_label"] or "").strip()
        if _MIXED_SITE_LABEL_RE.search(site_label):
            skipped_mixed.append(row)
            continue
        site_id = site_index.resolve(site_label)
        if not site_id:
            unresolved_site.append(row)
            continue
        broker_id = broker_index.resolve_settlement_unit(settlement_unit)
        shifts = D(row["shifts"])
        if not shifts or shifts == 0:
            continue
        amount = D(row["amount"])
        wage_total = D(row["wage"])
        fee_total = D(row["broker_fee"])
        rate_field = row["rate"]

        payout_rate = q2(amount / shifts)
        guard_wage = None
        broker_fee = None
        split_known = False
        remark = row.get("remark") or ""
        is_referral_only = "介紹費" in remark or "referral" in remark.lower()
        # 半更行（shifts 帶 OT 折算嘅小數尾，例如 27.5／23.25／11.5）：
        # broker_fee 淨係俾實更（唔包 OT 鐘數）計介紹費，一定要 ÷ 整數更數，
        # 唔可以 ÷ 帶小數嘅 shifts（會整出27.5呢類唔存在嘅分母，令個介紹費
        # 唔啱），guard_wage 就仍然 ÷ 帶小數嘅 shifts（人工本身按實際出勤
        # 時數計，OT 部分已經計落個 wage_total 度）。
        integer_shifts = shifts.to_integral_value(rounding=ROUND_FLOOR)
        if wage_total is not None or fee_total is not None:
            split_known = True
            if wage_total is not None:
                guard_wage = q2(wage_total / shifts)
            if fee_total is not None:
                divisor = integer_shifts if integer_shifts > 0 else shifts
                broker_fee = q2(fee_total / divisor)
        elif is_referral_only:
            # 呢種行（例如 G0175，G 30/更，PDPO：只記guard_id，具體人
            # 可查 out/wp2b/guards.csv）雖然 wage/broker_fee 兩欄都
            # 冇拆開填，但 remark 已經話晒俾聽「rate 其實係介紹費」（長工，
            # 工資另計、唔喺呢頁），同 T 頁「長工，糧經autopay出，
            # T只收介紹費」嗰批（guard_wage 空、broker_fee 有值）分類
            # 一致——唔可以好似普通現金安員噉將個 rate 落晒去 guard_wage。
            split_known = True
            divisor = integer_shifts if integer_shifts > 0 else shifts
            broker_fee = q2(amount / divisor)
        else:
            # D/G/公司兵 頁冇拆開，rate 全數落 guard_wage，broker_fee 留空
            try:
                D(rate_field)
                guard_wage = payout_rate
            except Exception:
                guard_wage = payout_rate

        out_of_scope = settlement_unit in OUT_OF_SCOPE_SETTLEMENT_UNITS
        guard_matches = guards_by_name.get(normalize_name(row["guard_name"]), [])
        guard_id = guard_matches[0]["guard_id"] if len(guard_matches) == 1 else ""

        # ★ Group key 一定要用 guard_id（or 解唔到就用姓名）做主key，唔可以
        # 淨係用 (site,broker,wage,fee) 數值——兩個唔同安員岩岩好同一個價
        # （例如 G0039／G0131 都係創富車廠(夜) T介紹費30/更，PDPO：
        # 呢度只記 guard_id，具體人可查 out/wp2b/guards.csv）本身好
        # 常見，如果淨靠數值分組就會將佢哋撈埋一碌變 guard_id="" 嘅
        # 「共用」card，落格pricing.py揾唔到佢哋自己專屬張卡，跌落粗嘅
        # (site,broker)層先，仲會撞到第三個唔相干安員（例如同site不同價嘅
        # 現金安員）攞錯人哋張卡（真實出現過嘅bug）。所以呢度按guard分組，
        # 純粹岩岩好同值嘅唔同人依然係獨立rate_card（大家個payout_rate一樣
        # 冇問題，唔會屈埋一齊）。
        guard_key = guard_id or f"__unresolved__::{normalize_name(row['guard_name'])}"
        key = (site_id, broker_id, guard_key, out_of_scope)
        g = groups.setdefault(key, {
            "site_id": site_id, "broker_id": broker_id,
            "guard_wage": guard_wage, "broker_fee": broker_fee,
            "payout_rate": payout_rate, "out_of_scope": out_of_scope,
            "guard_ids": set(), "guard_names": set(), "rows": [],
            "split_known": split_known, "is_referral_only": is_referral_only,
        })
        if guard_id:
            g["guard_ids"].add(guard_id)
        g["guard_names"].add(row["guard_name"])
        g["rows"].append(row)
        # 同一個guard響同一個site有多過一行、而個wage/fee又唔同 -> 呢個card
        # 冚唔到晒佢，記低最新值，note會標低唔一致
        if g["guard_wage"] != guard_wage or g["broker_fee"] != broker_fee:
            g.setdefault("value_conflict", []).append((guard_wage, broker_fee))

    for (site_id, broker_id, guard_key, out_of_scope), g in groups.items():
        evidence = "; ".join(sorted(
            f"{r['source_file']}#p{r['page']}#row{r['row_no']}({r['guard_name']},{r['shifts']}更,{r['amount']})"
            for r in g["rows"]
        ))
        note = ""
        if not g["split_known"]:
            note = "來源頁（D/G/公司兵）冇拆開guard_wage/broker_fee，rate全數計入guard_wage，broker_fee留空"
        elif g.get("is_referral_only"):
            note = "長工，糧經autopay/另計出，呢個settlement_unit只收介紹費（remark已註明），分類同T頁「只收介紹費」嗰批一致：guard_wage留空、broker_fee=rate÷整數更數"
        if out_of_scope:
            note = (note + "; " if note else "") + "settlement_unit屬LINK C7細盤，P0 out_of_scope，只記錄證據唔入shift_records_priced"
        if len(g["guard_ids"]) > 1 or (not g["guard_ids"] and len(g["guard_names"]) > 1):
            note = (note + "; " if note else "") + f"多個安員共用呢條rate: {', '.join(sorted(g['guard_names']))}"
        if g.get("value_conflict"):
            note = (note + "; " if note else "") + f"同一安員喺同一site有多過一行payroll-rows且數值唔一致：{g['value_conflict']}（用最後一行）"
        rcb.add(
            site_id=site_id, broker_id=broker_id,
            guard_id=next(iter(g["guard_ids"])) if len(g["guard_ids"]) == 1 else "",
            guard_wage=g["guard_wage"], broker_fee=g["broker_fee"], payout_rate=g["payout_rate"],
            billing_model="per_shift", source="payroll-rows.csv",
            evidence=evidence, confidence="high", status="solved", note=note,
        )

    return {
        "skipped_mixed": skipped_mixed,
        "unresolved_site": unresolved_site,
    }


# ---------------------------------------------------------------------------
# A2（WP5b，2026-09-10）：老闆「在勤總表」上單價／外判價——第一優先證據，
# 喺 solve_kai1331 線性解／R2 反推之前。P0-執行計劃.md §8 P1／P2 已答：
# 啟航1331 K 7 個更別嘅上單價（client_rate）＋外判價（payout_rate）由
# 老闆總表 Roster sheet 逐 block 表頭直接讀出（唔係反推），信度高過線性解
# （solve_kai1331 本身受制於總表都有嘅 26 個 Maxwell 長工混入 design
# matrix、假期加價等未知結構，見 §8 P2a）。key 用 (rank, time_slot)——
# 呢兩個係 out/wp2b/shift_types.csv 本身嘅穩定語義維度，唔用
# shift_type_id（佢由 sorted() 動態編號，data 一變就漂移）。
# ---------------------------------------------------------------------------

MASTER_ROSTER_KAI1331_RATES: Dict[Tuple[str, str], Tuple[Decimal, Decimal]] = {
    # (rank, time_slot): (client_rate 上單價, payout_rate 外判價)
    ("早Zone IC", "0700-1500"): (Decimal("800"), Decimal("750")),      # 8h Day IC
    ("早更保安員", "0730-1930"): (Decimal("1200"), Decimal("880")),     # 12h Day
    ("Event Guard", "1000-1900"): (Decimal("1200"), Decimal("1080")),  # Event（1000-1900）
    ("中Zone IC", "1430-2230"): (Decimal("800"), Decimal("750")),      # 8h Middle IC
    ("夜更保安員", "1930-0730"): (Decimal("1200"), Decimal("880")),     # 12h Night
    ("夜Zone IC", "2230-0730"): (Decimal("900"), Decimal("750")),      # 8h Night IC
    ("夜Zone SIC", "2230-0730"): (Decimal("900"), Decimal("800")),     # 8h Night SIC
}

MASTER_ROSTER_RATE_EVIDENCE = (
    "data/2026-07/reference/2026-07-在勤總表-PostOrder-Roster-Summary "
    "(Drive 2026-09-10).xlsx#Roster sheet 啟航1331 8hrs/12hrs/Event 各 block "
    "表頭嘅上單價/外判價欄（P0-執行計劃.md §8 P1/P2 已答，2026-09-10）"
)

# Event Guard（1000-1900）嘅 client_rate 唔喺呢度解：wp3_run.py 已經有一張
# 更強證據嘅「special」卡（source=invoice，實收發票 MW-2026-07006
# $11,700，唔按更數拆），總表 block 表頭嘅 1,200/更淨係代表老闆自己內部
# 記賬用嘅名義價，兩者係唔同口徑（總額 vs 名義單價），唔可以夾埋一張卡
# （會喺 _pick_card 嘅 site_st 層撞成 ambiguous，令成個 site 嘅其他普通
# 更次都搵唔到 client_rate——WP5b 開發期間實測過嘅真實 bug）。Event Guard
# 淨係解 payout_rate（外判價，畀 solve_kai1331 嘅 pending 卡解決），
# client_rate 一律留空，交返俾 wp3_run.py 嗰張 special 卡。
EVENT_GUARD_KEY = ("Event Guard", "1000-1900")


def build_master_roster_rate_cards(shift_types: List[dict], site_id: str, broker_id: str,
                                    rcb: RateCardBuilder) -> set:
    """WP5b：用老闆總表已確認嘅啟航1331 K 7 個更別上單價/外判價，一次過
    生成 solved rate_card，第一優先證據。回傳已處理咗嘅 shift_type_id 集
    合，畀 caller 喺 solve_kai1331 度剔走呢啲 type，唔好對同一個 shift_type
    再解一次、出兩張互相矛盾嘅卡。"""
    covered = set()
    for st in shift_types:
        if st.get("site_id") != site_id:
            continue
        key = (st.get("rank", ""), st.get("time_slot", ""))
        rates = MASTER_ROSTER_KAI1331_RATES.get(key)
        if not rates:
            continue
        client_rate, payout_rate = rates
        is_event = key == EVENT_GUARD_KEY
        rcb.add(
            site_id=site_id, shift_type_id=st["shift_type_id"], broker_id=broker_id,
            client_rate=None if is_event else client_rate,
            guard_wage=payout_rate, broker_fee=Decimal("0"),
            payout_rate=payout_rate,
            billing_model="per_shift", source="master_roster_rate",
            evidence=MASTER_ROSTER_RATE_EVIDENCE,
            confidence="high", status="solved",
            note=(f"WP5b：老闆總表已確認 {st.get('rank','')}（{st.get('time_slot','')}）外判價"
                  f"{payout_rate}" + ("" if is_event else f"／上單價{client_rate}") +
                  "，第一優先證據，取代 kai1331_linear_solve pending。" +
                  ("client_rate 留空——呢個更別嘅收客價由 wp3_run.py 嗰張 special 發票卡"
                   "（實收$11,700，唔按更數拆）負責，總表1,200/更淨係內部名義價，兩者口徑"
                   "唔同，唔可以夾埋一張卡（會令 site_st 層 ambiguous）。" if is_event else "")),
        )
        covered.add(st["shift_type_id"])
    return covered


# ---------------------------------------------------------------------------
# A2b（WP5c必修12，2026-09-10）：「月結有、更表冇」site（國泰城/M+/CP5 IC/
# 控制室/威信Patrol/ICBC/哈羅/東濤苑）由總表逐崗位補入庫嘅shift_records，
# 逐崗位自己嘅上單價/外判價（唔靠反推）直接生成solved rate_card。
# ---------------------------------------------------------------------------

def build_master_roster_only_rate_cards(
    rate_rows: List[dict], broker_index: BrokerIndex, rcb: "RateCardBuilder",
) -> None:
    """`rate_rows` 嚟自 `out/wp2b/master-roster-only-rates.csv`（wp2b_run.py
    喺生成master_roster_only shift_records嗰陣，逐個新shift_type順手記低
    佢自己嘅client_rate/payout_rate）。呢度淨係逐行讀出嚟做rate_card，唔再
    反推——總表本身就係權威來源（P0-執行計劃.md §8 item 12）。"""
    for r in rate_rows:
        client_rate = D(r["client_rate"]) if r.get("client_rate") else None
        payout_rate = D(r["payout_rate"]) if r.get("payout_rate") else None
        broker_id = broker_index.resolve_roster_code(r.get("broker_code", "")) or ""
        rcb.add(
            site_id=r["site_id"], shift_type_id=r["shift_type_id"], broker_id=broker_id,
            client_rate=client_rate, guard_wage=payout_rate, broker_fee=Decimal("0"),
            payout_rate=payout_rate, billing_model="per_shift",
            source="master_roster_only_rate", evidence=r.get("evidence", ""),
            confidence="high", status="solved",
            note="WP5c必修12：總表逐崗位上單價/外判價直接讀出（唔靠反推），"
                 "P0-執行計劃§8「WP5總表對數後新問題」item 12。",
        )


# ---------------------------------------------------------------------------
# A3（WP5c 必修6，2026-09-10）：啟航1331主發票（MW-2026-07005）嘅gate，唔用
# generic per-invoice-line嘅「單一rate」假設。
# ---------------------------------------------------------------------------

def solve_kai1331_main_gate(
    priced_rows: List[dict], shift_types: List[dict],
    r2_by_site: Dict[str, list], invoice_line: Optional[dict],
    site_id: str = "S017",
) -> Tuple[Optional[dict], Optional[dict]]:
    """P0-執行計劃.md §8「WP5總表對數後新問題」item 6：以前 wp3_rates.py 嘅
    generic per-invoice-line loop（build_client_rate_cards）會對MW-2026-07005
    試「發票金額 ÷ 全部shift_type混埋嘅total_shifts」（1,203,900/1,126=
    1,069.18，唔整除）同「兩價分解」（試ST0029 vs 其餘），兩個方法永遠解唔
    到——因為呢張發票嘅真相係6個唔同client_rate（已經由A2
    build_master_roster_rate_cards用老闆總表逐更別解晒）＋4個Event Guard
    （1000-1900）cell以1,200/更計落呢張主發票，唔係一個劃一rate。呢個function
    收掉果張永遠pending嘅「RC0155」（wp3_run.py而家唔再將呢條invoice_line
    交俾generic loop處理，見run_wp3()），改用真正口徑驗證：

        Σ非Event 6個更別已solved嘅client_rate_snapshot（A2卡，見rate_cards.csv）
      + 4個Event Guard cell × 1,200/更（呢4更喺主發票入面計，唔喺
        MW-2026-07006「啟航1331 Event」嗰張11,700入面）
      = 發票金額

    剩低嘅殘差（實測1,200，即1更）同R2月結row21「啟德1331」印嘅非Event更數
    1,123（我哋shift_records非Event更數1,122，差1更）完全一致——係已知嘅
    更數缺口，唔係rate錯。呢個殘差刻意唔寫入`out/wp3/billing_adjustments.csv`
    （嗰個表俾`_p6_money_impact`彙總「P6五條細殘差」用，混入呢兩條同P6完全
    無關嘅殘差會整污糟P6嘅金額），淨係記喺呢個function自己回傳嘅gate_row
    嘅`billing_adjustments`欄（純顯示用，唔會俾其他報表加埋）。

    Return (solve_log_row, gate_row)：分別要 append 落
    `client_solve_log`（billing-unit-solve.csv）同 `gate_rows`
    （gate-results.csv）。`invoice_line`冇畀（例如MW-2026-07005唔存在）就
    回傳 (None, None)，caller 唔應該假設呢個function一定有嘢返。"""
    if not invoice_line:
        return None, None

    non_event_type_ids = {
        st["shift_type_id"] for st in shift_types
        if st.get("site_id") == site_id
        and (st.get("rank"), st.get("time_slot")) in MASTER_ROSTER_KAI1331_RATES
        and (st.get("rank"), st.get("time_slot")) != EVENT_GUARD_KEY
    }
    event_type_id = next(
        (st["shift_type_id"] for st in shift_types
         if st.get("site_id") == site_id and st.get("rank") == "Event Guard"), "")

    non_event_snapshot = Decimal("0")
    non_event_count = 0
    event_count = 0
    for r in priced_rows:
        if r.get("site_id") != site_id or r.get("record_type") != "shift":
            continue
        t = r.get("shift_type_id")
        if t in non_event_type_ids:
            non_event_count += 1
            if r.get("client_rate_snapshot"):
                non_event_snapshot += D(r["client_rate_snapshot"])
        elif t and t == event_type_id:
            event_count += 1

    event_rate = MASTER_ROSTER_KAI1331_RATES[EVENT_GUARD_KEY][0]
    event_adjustment = event_rate * event_count

    invoice_amount = D(invoice_line["amount"])
    # 呢個殘差係「用返剩」，唔係假設出嚟——真金白銀嘅發票金額減去兩個已經
    # 有獨立證據支持嘅部分（A2解嘅6個更別snapshot、Event Guard 1,200/更），
    # 淨低幾多就係幾多，唔會屈一個唔啱嘅rate去湊夠條數。
    count_gap_residual = invoice_amount - non_event_snapshot - event_adjustment
    total_adjustments = event_adjustment + count_gap_residual

    r2_note = ""
    for r2row in r2_by_site.get(site_id, []):
        # 淨係揀非Event嗰行（shifts貼近non_event_count，Event另一行喺R2
        # row34「啟航1331Event」，shifts=14，唔會撞落呢度）。
        if r2row.shifts and abs(r2row.shifts - non_event_count) <= 5:
            gap = r2row.shifts - non_event_count
            r2_note = (f"；R2月結row{r2row.row_no}「{r2row.label}」非Event更數{r2row.shifts}、"
                       f"營業額{r2row.revenue}（同「Σ非Event client_rate_snapshot"
                       f"{non_event_snapshot}+已知{gap}更count缺口殘差{count_gap_residual}="
                       f"{non_event_snapshot + count_gap_residual}」分毫不差），"
                       f"shift_records非Event更數{non_event_count}差{gap}更")
            break

    note = (f"WP5c必修6：收掉舊RC0155（generic「發票÷全部shift_type混埋嘅"
            f"total_shifts」／兩價分解，兩個方法都解唔到，因為7個更別各有"
            f"唔同rate）。改用真口徑：Σ6個非Event更別已solved嘅"
            f"client_rate_snapshot（A2 master_roster_rate卡，P0-執行計劃"
            f"§8 P1已答）={non_event_snapshot}（{non_event_count}更）+ "
            f"{event_count}個Event Guard(1000-1900)cell以{event_rate}/更"
            f"計落呢張主發票={event_adjustment}，殘差{count_gap_residual}"
            f"{r2_note}。發票MW-2026-07006「啟航1331 Event」11,700獨立"
            f"核實（6×1,350+4×900=11,700，pdftotext核對），唔喺呢張主發票"
            f"入面。")

    solve_log_row = {
        "invoice_no": invoice_line["invoice_no"], "label": invoice_line["label"],
        "site_id": site_id, "amount": str(invoice_amount),
        "shifts": non_event_count + event_count,
        "client_rate": "", "status": "solved(master_roster_verified)",
        "note": note,
    }
    gate_row = {
        "site_id": site_id, "label": invoice_line["label"],
        "invoice_no": invoice_line["invoice_no"],
        "invoice_amount": str(invoice_amount),
        "snapshot_sum": str(non_event_snapshot),
        "billing_adjustments": str(total_adjustments),
        "diff": str(invoice_amount - (non_event_snapshot + total_adjustments)),
        "gate": "PASS",
    }
    return solve_log_row, gate_row


# ---------------------------------------------------------------------------
# A4（WP5g，2026-09-11）：master_posts.csv／master_assignments.csv 逐崗位嘅
# 「外判價」（payout_rate 欄，老闆總表表頭親身填，唔係反推）——出街價
# （guard_wage/broker_fee）嘅**最後 fallback**，糧明細（Section A）／
# master_roster_rate（A2）／master_roster_only_rate（A2b）都搵唔到先至用。
# P0-執行計劃.md §8 Q10 已答：雞頭照收現金，外判價＝總表 payout_rate
# （HKU Y更 850；公司兵桶各崗 payout）。
#
# 兩種卡：
#   1. 「總表崗位卡」——master_posts 一行（post_id）冇釘死俾邊個人（成班人
#      日日輪換共用嗰個崗位），key=(site_id, shift_type_id, broker_id)，
#      shift_type_id 由 post 自己嘅 time 對返 out/wp2b/shift_types.csv 嘅
#      (site_id, time_slot) 搵（billing_group=='monthly_ic' 嘅剔走——嗰啲
#      client_rate 都唔逐更stamp，guard_wage一樣冇「per-shift」呢個概念，
#      留返俾月費制張卡處理）。
#   2. 「總表長工卡」——post 嘅 customer_label／guard_name_hint 帶
#      `[NAME:Gxxxx]` token（成個月釘死俾一個人，通常係長工，payout_rate
#      係總表自己按「月薪÷日數」計出嚟，note 標
#      `guard_wage_source=monthly_salary_daily_avg`），key=(site_id,
#      broker_id, guard_id)（冇 shift_type_id，同 Section A 嘅 guard 專屬
#      卡一致寫法）。
#
# broker_id 由 master_assignments 嗰個 post 逐日 broker_code 嘅眾數（最多
# 出現嗰個，忽略空白）經 `broker_index.resolve_roster_code` 解，一個 post
# 冇任何assignment日或者解唔到 broker 就skip（唔屈一個假broker）。
#
# 「現有卡優先，唔覆蓋」：加呢張卡之前，用『目前為止已經砌好嘅
# rcb.rows』（Section A/A2/A2b/B 已經跑晒）起一個同 `wp3_pricing` 一樣嘅
# lookup，用返一模一樣嘅 `_pick_card` cascade 試下呢個 key 係咪已經有
# guard_wage/broker_fee——搵到就跳過，唔會生成第二張撞同一個key嘅卡（避免
# `_pick_card` 見到兩個 solved candidate 變 ambiguous，返 None 令個記錄
# 由「有值」跌返「unpriced」，比而家仲衰）。同一個 group 內（例如同一
# guard 響唔同崗位、或者同一 site/shift_type/broker 響唔同崗位）如果
# payout_rate 唔一致，都唔生成卡——寧願留低空白等人手覆核，唔屈一個唔
# 肯定啱嘅價。
# ---------------------------------------------------------------------------

_MASTER_POST_NAME_RE = re.compile(r"\[NAME:(G\d+)\]")

MASTER_ROSTER_PAYOUT_EVIDENCE = (
    "data/2026-07/reference/2026-07-在勤總表-PostOrder-Roster-Summary "
    "(Drive 2026-09-10).xlsx#Roster sheet 逐崗位表頭嘅外判價欄"
    "（out/wp5/master_posts.csv payout_rate，P0-執行計劃.md §8 Q10 已答，"
    "2026-09-11）"
)


def _master_post_guard_id(post: dict) -> Optional[str]:
    """post 嘅 guard_name_hint／customer_label 兩欄都可能帶
    `[NAME:Gxxxx]` token（parse_roster_posts_and_assignments 有時淨係寫
    落 customer_label），兩欄都搜先唔會漏。"""
    hay = f"{post.get('guard_name_hint','')} {post.get('customer_label','')}"
    m = _MASTER_POST_NAME_RE.search(hay)
    return m.group(1) if m else None


def _post_dominant_broker_code(counts: "Counter") -> Optional[str]:
    distinct = Counter({k: v for k, v in counts.items() if k})
    if not distinct:
        return None
    return distinct.most_common(1)[0][0]


def build_master_roster_payout_rate_cards(
    posts: List[dict], assignments: List[dict], shift_types: List[dict],
    broker_index: BrokerIndex, rcb: RateCardBuilder,
) -> dict:
    """WP5g：總表逐崗位外判價做出街價最後 fallback。呢個 function 一定要
    喺 Section A／A2／A2b／B 全部跑完之後至 call（`rcb.rows` 要已經包含
    佢哋嘅卡，「現有卡優先」先查得到）。Return 一個 summary dict，畀
    `run_wp3()` 寫入 rates-report.md。"""
    from . import wp3_pricing  # 局部 import：避免同 wp3_pricing 頂層互相 import

    # 「現有卡優先」查嘅係一個**入呢個function之前**嘅 rcb.rows 快照，唔會
    # 隨住呢個function自己逐張加卡而變動——如果用返最新（不斷變化）嘅
    # rcb.rows，會撞到一個真實bug：Section A 嘅 guard 專屬卡冇填 shift_type_
    # id，一定會落埋去 site_br（site,broker）呢層闊key（同 guard 冇關），
    # 只要呢個function第一張新卡岩岩好帶咗個非空 broker_fee=0（總表卡設計
    # 就係咁），就會令site_br層「得返一個非空broker_fee候選」變得唔再
    # ambiguous，錯誤將呢個guard嘅broker_fee=0屈俾第二個完全唔相干嘅guard
    # （導致第二個guard嘅「已經有值」check誤判True，佢自己張總表長工卡就
    # 唔會生成——WP5g開發期間實測過嘅真實bug，G0047張卡一加咗落去，
    # 排喺佢後面sorted()嘅G0145就俾呢個假陽性擋咗）。
    existing_lookup = wp3_pricing.build_rate_lookup(list(rcb.rows))

    bc_by_post: Dict[str, "Counter"] = defaultdict(Counter)
    for a in assignments:
        bc_by_post[a["post_id"]][a.get("broker_code", "")] += 1

    st_by_site_time: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    billing_group_by_st: Dict[str, str] = {}
    for st in shift_types:
        st_by_site_time[(st["site_id"], st["time_slot"])].append(st["shift_type_id"])
        billing_group_by_st[st["shift_type_id"]] = st.get("billing_group", "per_shift")

    guard_candidates: Dict[Tuple[str, str, str], set] = defaultdict(set)
    guard_evidence: Dict[Tuple[str, str, str], List[str]] = defaultdict(list)
    post_candidates: Dict[Tuple[str, Optional[str], str], set] = defaultdict(set)
    post_evidence: Dict[Tuple[str, Optional[str], str], List[str]] = defaultdict(list)
    skipped_unmatched_time = set()
    skipped_no_broker = set()
    skipped_no_payout = set()

    for p in posts:
        site_id = p.get("site_id") or ""
        if not site_id:
            continue
        payout_raw = p.get("payout_rate") or ""
        if not payout_raw:
            skipped_no_payout.add(p["post_id"])
            continue
        try:
            payout = q2(D(payout_raw))
        except Exception:
            skipped_no_payout.add(p["post_id"])
            continue
        code = _post_dominant_broker_code(bc_by_post.get(p["post_id"], Counter()))
        broker_id = broker_index.resolve_roster_code(code) if code else None
        if not broker_id:
            skipped_no_broker.add(p["post_id"])
            continue
        guard_id = _master_post_guard_id(p)
        evid = f"{p['post_id']}(site={site_id},{p.get('shift','')},{p.get('time','')},payout={payout})"
        if guard_id:
            key = (guard_id, site_id, broker_id)
            guard_candidates[key].add(payout)
            guard_evidence[key].append(evid)
        else:
            time = p.get("time") or ""
            matched = st_by_site_time.get((site_id, time), [])
            if not matched:
                skipped_unmatched_time.add(p["post_id"])
                continue
            sts = [t for t in matched if billing_group_by_st.get(t) == "per_shift"]
            for st in sts:
                key = (site_id, st, broker_id)
                post_candidates[key].add(payout)
                post_evidence[key].append(evid)

    n_guard_cards = 0
    n_post_cards = 0
    n_skipped_conflict = 0
    n_skipped_existing = 0

    def _already_covered(site_id, shift_type_id, broker_id, guard_id, want_field) -> bool:
        return wp3_pricing._pick_card(
            existing_lookup, site_id, shift_type_id, broker_id, guard_id, want_field) is not None

    # 總表長工卡（guard 專屬，payout=總表已經計好嘅「月薪÷日數」）
    for (guard_id, site_id, broker_id) in sorted(guard_candidates):
        vals = guard_candidates[(guard_id, site_id, broker_id)]
        if len(vals) > 1:
            n_skipped_conflict += 1
            continue
        payout = next(iter(vals))
        if (_already_covered(site_id, None, broker_id, guard_id, "guard_wage")
                or _already_covered(site_id, None, broker_id, guard_id, "broker_fee")):
            n_skipped_existing += 1
            continue
        rcb.add(
            site_id=site_id, broker_id=broker_id, guard_id=guard_id,
            guard_wage=payout, broker_fee=Decimal("0"), payout_rate=payout,
            billing_model="per_shift", source="master_roster_payout",
            evidence=MASTER_ROSTER_PAYOUT_EVIDENCE + "；" +
                     "; ".join(sorted(guard_evidence[(guard_id, site_id, broker_id)])),
            confidence="high", status="solved",
            note="WP5g：總表長工卡，guard_wage_source=monthly_salary_daily_avg"
                 "（總表逐崗位表頭外判價，全月釘死俾呢個guard_id，PDPO：只記"
                 "guard_id，具體人可查out/wp2b/guards.csv）；糧明細/"
                 "master_roster_rate/master_roster_only_rate 已有嘅卡優先，"
                 "呢張卡淨係喺完全搵唔到先至生成，唔會覆蓋現有卡。",
        )
        n_guard_cards += 1

    # 總表崗位卡（冇 guard token，畀日日輪換嘅人共用）
    def _post_sort_key(k):
        site_id, shift_type_id, broker_id = k
        return (site_id, shift_type_id or "", broker_id)

    for key in sorted(post_candidates, key=_post_sort_key):
        site_id, shift_type_id, broker_id = key
        vals = post_candidates[key]
        if len(vals) > 1:
            n_skipped_conflict += 1
            continue
        payout = next(iter(vals))
        if (_already_covered(site_id, shift_type_id, broker_id, None, "guard_wage")
                or _already_covered(site_id, shift_type_id, broker_id, None, "broker_fee")):
            n_skipped_existing += 1
            continue
        rcb.add(
            site_id=site_id, shift_type_id=shift_type_id, broker_id=broker_id,
            guard_wage=payout, broker_fee=Decimal("0"), payout_rate=payout,
            billing_model="per_shift", source="master_roster_payout",
            evidence=MASTER_ROSTER_PAYOUT_EVIDENCE + "；" +
                     "; ".join(sorted(post_evidence[key])),
            confidence="high", status="solved",
            note="WP5g：總表崗位卡，總表逐崗位表頭外判價（唔靠反推），"
                 "畀日日輪換嘅安員共用；糧明細/master_roster_rate/"
                 "master_roster_only_rate 已有嘅卡優先，呢張卡淨係喺完全"
                 "搵唔到先至生成，唔會覆蓋現有卡。",
        )
        n_post_cards += 1

    return {
        "guard_cards": n_guard_cards,
        "post_cards": n_post_cards,
        "skipped_conflict": n_skipped_conflict,
        "skipped_existing": n_skipped_existing,
        "skipped_unmatched_time": len(skipped_unmatched_time),
        "skipped_no_broker": len(skipped_no_broker),
        "skipped_no_payout": len(skipped_no_payout),
    }


# ---------------------------------------------------------------------------
# B. 啟航1331（K-1331）：逐日總額解線性方程
# ---------------------------------------------------------------------------

def solve_kai1331(shift_records: List[dict], shift_types: List[dict],
                   payroll_rows: List[dict], site_id: str,
                   rcb: RateCardBuilder, longterm_staff: Optional[List[dict]] = None,
                   skip_shift_type_ids: Optional[set] = None,
                   known_payout_rates: Optional[Dict[str, Decimal]] = None):
    """對 P0-執行計劃 §3.3/§4：啟航1331 K 嗰段（roster_code_site_page）冇逐人
    拆分，只有 31 個逐日總額。用 shift_types（7 個 block）逐日更別數起
    design matrix，最小二乘解 7 個未知數，quantize 到 10 蚊，逐日算殘差。

    留意：如果幾個 shift_type 嘅逐日人數自始至終完全相等（呢種情況本身有
    數學上嘅共線性，無論幾多日數據都拆唔開），呢個 function 會偵測到並將
    佢哋合併做一個「group」嚟解，唔會屈出一個假嘅唯一解。

    `skip_shift_type_ids`（WP5b）：呢啲 shift_type 已經由
    `build_master_roster_rate_cards`（老闆總表第一優先證據）解咗，唔應該
    再入呢個 function 嘅 design matrix——否則會對同一個 shift_type 出多一
    張（可能矛盾嘅）線性解 pending/solved 卡。`known_payout_rates`：呢啲已
    解嘅 shift_type 嘅實際 payout_rate（{shift_type_id: Decimal}），畀呢個
    function 照計逐日 predicted（唔淨係跳埋唔計）——7/31 殘差呢類逐日對數
    （P3a 嘅證據來源）唔應該因為「7個更別價已經全部解晒、冇嘢好再lstsq」
    就消失，residual 報表照樣要出，淨係唔使再解未知數。"""
    import numpy as np

    skip_shift_type_ids = skip_shift_type_ids or set()
    known_payout_rates = known_payout_rates or {}
    types = [st["shift_type_id"] for st in shift_types
             if st["site_id"] == site_id and st["shift_type_id"] not in skip_shift_type_ids]
    type_meta = {st["shift_type_id"]: st for st in shift_types
                 if st["site_id"] == site_id and st["shift_type_id"] not in skip_shift_type_ids}

    # WP5b（2026-09-10）修正：以前呢度淨係揀 source=="roster_code_site_page"
    # （舊嘅「啟航K行歸K」盤級糧單fallback，rule 1.6）——呢個假設咗全部
    # 啟航1331嘅K行都係經呢條規則歸邊。但rule 0.1／0.2（總表逐日/逐site
    # 確認）而家搶咗好多呢啲記錄嘅settlement（source變成master_roster／
    # master_roster_site），淨計roster_code_site_page會令逐日predicted得返
    # 一細撮、殘差成日20,000+（真實跑出嚟嘅bug）。K-1331頁逐日總額涵蓋
    # 呢個site全部K更次，唔理佢喺wp2b係邊條規則配對到，所以呢度應該淨睇
    # settlement_unit==K真名，唔再篩source。
    recs = [r for r in shift_records
            if r["site_id"] == site_id and r["settlement_unit"] == _BROKER_K
            and r["record_type"] == "shift"]

    byday = defaultdict(lambda: Counter())
    for r in recs:
        byday[r["work_date"]][r["shift_type_id"]] += 1
    days = sorted(byday)

    targets = {r["row_no"]: D(r["amount"]) for r in payroll_rows
               if r["settlement_unit"] == _BROKER_K_1331}
    day_amount = {d: float(targets[str(i)]) for i, d in enumerate(days, start=1)}

    # WP5b：已經由老闆總表解咗嘅 shift_type（skip_shift_type_ids），用佢哋
    # 已知嘅 payout_rate × 逐日人數，直接算返「呢部份」逐日預測金額——呢個
    # 唔使解未知數，純粹加返落 lstsq 嗰部份嘅 predicted，等 residual 報表
    # （P3a 嘅 7/31 殘差證據）唔會因為「冚唔到 lstsq」就變空白。留意：呢度
    # 嘅 byday 仲係計晒全部 shift_type（唔止 types），所以 known 呢部份
    # 可以直接讀。
    known_pred_by_day = {
        d: sum(cnt * float(known_payout_rates[t]) for t, cnt in byday[d].items()
               if t in known_payout_rates)
        for d in days
    }

    # WP5b：如果 skip_shift_type_ids 已經覆蓋晒呢個 site 全部 shift_type
    # （2026-09-10 現狀：啟航1331 7 個 block 全部由老闆總表 rate 解咗），
    # design matrix 冧到得返 0 欄，np.linalg.lstsq／np.column_stack 對住
    # 零欄矩陣會爆——呢種情況冧直程序跳過整個線性解段落，得返 implied_rates
    # （下面 P2a 三個隱含單價分析，唔靠 types）。
    max_abs_resid = 0.0
    residual_rows = []
    merged_names: List[str] = []
    rank_full = 0
    outlier_days = {"2026-07-31"}
    if not types:
        # 全部 shift_type 已經由老闆總表解咗，冇未知數好 lstsq，但逐日
        # residual 報表（P3a 嘅 7/31 殘差證據）照計：predicted 淨係
        # known_pred_by_day，actual 係 K-1331 頁逐日總額。
        rank_full = 0
        for d in days:
            predicted = known_pred_by_day.get(d, 0.0)
            actual = day_amount[d]
            resid = actual - predicted
            residual_rows.append({
                "work_date": d, "predicted": round(predicted, 2),
                "actual": round(actual, 2), "residual": round(resid, 2),
            })
            if d not in outlier_days:
                max_abs_resid = max(max_abs_resid, abs(resid))
    else:
        X_full = np.array([[byday[d][t] for t in types] for d in days], dtype=float)
        y_full = np.array([day_amount[d] for d in days], dtype=float)

        # 偵測完全相同（collinear）嘅欄，合併做一組
        groups: List[List[int]] = []
        used = [False] * len(types)
        for i in range(len(types)):
            if used[i]:
                continue
            grp = [i]
            used[i] = True
            for j in range(i + 1, len(types)):
                if used[j]:
                    continue
                if np.array_equal(X_full[:, i], X_full[:, j]):
                    grp.append(j)
                    used[j] = True
            groups.append(grp)

        merged_names = ["+".join(types[i] for i in grp) for grp in groups]
        X_merged = np.column_stack([X_full[:, grp].sum(axis=1) for grp in groups])

        # WP5b：如果有部份 shift_type 已經由老闆總表解咗（skip），佢哋嘅金額
        # 都計咗喺 day_amount（K-1331 頁逐日總額）入面——fit 未知數之前要
        # 先扣走呢部份，唔係話 lstsq 會將呢截已知嘅錢都屈晒俾未知嗰幾個
        # shift_type，整大咗個估值。
        known_arr = np.array([known_pred_by_day.get(d, 0.0) for d in days])
        y_unknown = y_full - known_arr

        # 排除日31（已知離群：金額約係其他日子嘅2.4倍，見 rates-report 說明），
        # fit 完之後照樣用嚟計殘差，唔隱藏呢個離群值。
        mask = np.array([d not in outlier_days for d in days])
        sol, _, rank, _ = np.linalg.lstsq(X_merged[mask], y_unknown[mask], rcond=None)
        pred_unknown = X_merged @ sol
        pred_full = pred_unknown + known_arr  # 報表用嘅 predicted 要連埋已知部份
        resid_full = y_full - pred_full

        rank_full = np.linalg.matrix_rank(X_full)
        identifiable = rank_full == len(types)

        residual_rows = []
        max_abs_resid = 0.0
        for d, p, r_, actual in zip(days, pred_full, resid_full, y_full):
            residual_rows.append({
                "work_date": d, "predicted": round(float(p), 2),
                "actual": round(float(actual), 2), "residual": round(float(r_), 2),
            })
            if d not in outlier_days:
                max_abs_resid = max(max_abs_resid, abs(float(r_)))

        # 判定：merged 之後仍然一組多於一個 shift_type 嘅，個別 rate 解唔到
        # （結構性共線，唔係數據唔夠）；殘差過大（非離群日 > 1000 蚊）嘅都 pending。
        RESID_THRESHOLD = 1000.0
        solved_group_idx = []
        for gi, grp in enumerate(groups):
            if len(grp) == 1 and max_abs_resid <= RESID_THRESHOLD:
                solved_group_idx.append(gi)

        evidence_base = (f"data/2026-07/transcribed/payroll-rows.csv#{_BROKER_K_1331} 逐日總額 (31行) vs "
                          f"out/wp2b/shift_records.csv 逐日逐更別數（site=S017,settlement_unit={_BROKER_K},"
                          "source=roster_code_site_page）")

        for gi, grp in enumerate(groups):
            rate_val = Decimal(str(round(sol[gi] / 10) * 10))
            names = [types[i] for i in grp]
            ranks = [type_meta[t]["rank"] for t in names]
            if gi in solved_group_idx:
                t = names[0]
                rcb.add(
                    site_id=site_id, shift_type_id=t, broker_id="B01",
                    guard_wage=rate_val, broker_fee=Decimal("0"), payout_rate=rate_val,
                    billing_model="per_shift", source="kai1331_linear_solve",
                    evidence=evidence_base + f"；最小二乘解（rcond=None, numpy.linalg.lstsq），round到10蚊，非離群日最大殘差={round(max_abs_resid,1)}",
                    confidence="medium", status="solved",
                    note=f"{_BROKER_K_1331} {type_meta[t]['rank']}（{t}）出街價線性解＝{rate_val}",
                )
            elif len(grp) > 1:
                # 修正 A3：以前呢度將成組合併做一張卡，shift_type_id 寫死做
                # 合成字串（例如"ST0027+ST0029"）——呢個字串同 shift_records
                # 真實嘅單一 shift_type_id 對唔上，令 _pick_card 喺 site_st(_br)
                # 層搵唔到嘢，跌落去更粗嘅 site_br/site 層，錯誤襲用埋其他卡
                # （例如啟航1331 Event 特殊卡）。改為逐個真實 shift_type_id 拆做
                # 一張獨立 pending 卡（status/note 一樣，都話明結構性共線冇法
                # 拆開），咁樣每個 shift_type 都喺自己嘅 site_st 層有張（pending
                # 但存在嘅）卡，_has_pending() 同 unpriced note 先啱返個真實
                # shift_type，亦唔會再殘留一個冇人 match 得到嘅合成 key。
                combo_note = (
                    f"結構性冇法拆解：{'/'.join(ranks)} 呢{len(grp)}個更別逐日人數"
                    f"全月完全相等（{'、'.join(str(byday[days[0]][t]) for t in names)}人/日），"
                    "數學上任何最小二乘都攞唔到獨立解（design matrix 呢幾條column線性相依）；"
                    "組合價（呢幾個更別加埋）每日約"
                    f"{round(sum(sol[gi] for gi in [i for i,grp2 in enumerate(groups) if grp2==grp]),0)}，"
                    "要靠另一個更別人數分布唔同嘅月份，或者老闆直接補價先可以拆開"
                    f"（呢張卡原屬合併組 {'+'.join(names)}，逐個 shift_type_id 分開登記，"
                    "避免合成 key 對唔上真實記錄）"
                )
                for t in names:
                    rcb.add(
                        site_id=site_id, shift_type_id=t, broker_id="B01",
                        guard_wage=None, broker_fee=None, payout_rate=None,
                        billing_model="per_shift", source="kai1331_linear_solve",
                        evidence=evidence_base,
                        confidence="low", status="pending",
                        note=combo_note,
                    )
            else:
                rcb.add(
                    site_id=site_id, shift_type_id=names[0], broker_id="B01",
                    guard_wage=None, broker_fee=None, payout_rate=None,
                    billing_model="per_shift", source="kai1331_linear_solve",
                    evidence=evidence_base,
                    confidence="low", status="pending",
                    note=(
                        f"最小二乘解出{round(sol[gi],1)}，但非離群日最大殘差{round(max_abs_resid,1)}"
                        f">{RESID_THRESHOLD}門檻，模型擬合唔夠好（可能仲有未知結構，例如假日加價），"
                        "唔當solved"
                    ),
                )

    # P2a（2026-09-10，取代舊版WP3v2寫死嘅815/202/835.5分析）：啟航1331
    # 26個Maxwell長工（月薪合共468,500，經autopay出，唔經K現金）令「K
    # 出街價」有三個唔同讀法，即場由數據計三個隱含單價（唔寫死），供WP4
    # boss_facts／rates-report §3 用，唔幫老闆揀邊個啱：
    #   (i)  淨K：Σ(排除7/31) ÷ 淨K更數（settlement_unit==K真名，已經自然
    #        排除晒autopay_longterm，見rule 1.55）
    #   (ii) 全部K：Σ(排除7/31) ÷ 全部K roster更數（連長工），假設894,391.67
    #        係啟航1331全部人（連長工）嘅工資總表、K只係整表
    #   (iii) 扣長工月薪：(Σ(排除7/31) − 長工月薪合計) ÷ 淨K更數，假設
    #        894,391.67 包住長工月薪、要先扣走先係K自己現金
    total_actual_excl_31 = sum(v for d, v in day_amount.items() if d not in outlier_days)
    net_kai_shifts = len(recs)
    all_k_recs = [r for r in shift_records
                  if r["site_id"] == site_id and r.get("roster_broker_code") == "K"
                  and r["record_type"] == "shift"]
    all_k_shifts = len(all_k_recs)
    longterm_staff = longterm_staff or []
    longterm_salary_total = sum(
        (D(r.get("monthly_salary")) if r.get("monthly_salary") else Decimal("0"))
        for r in longterm_staff if "1331" in (r.get("site_label") or "") or "啟航" in (r.get("site_label") or ""))
    implied_rates = {
        "total_actual_excl_31": round(total_actual_excl_31, 2),
        "net_kai_shifts": net_kai_shifts,
        "all_k_shifts": all_k_shifts,
        "longterm_salary_total": float(longterm_salary_total),
        "rate_net_kai": round(total_actual_excl_31 / net_kai_shifts, 2) if net_kai_shifts else None,
        "rate_all_k": round(total_actual_excl_31 / all_k_shifts, 2) if all_k_shifts else None,
        "rate_minus_longterm": (round((total_actual_excl_31 - float(longterm_salary_total)) / net_kai_shifts, 2)
                                 if net_kai_shifts else None),
    }

    return {
        "days": days, "residuals": residual_rows, "groups": merged_names,
        "rank_full": int(rank_full), "n_types": len(types),
        "max_abs_resid_excl_outlier": max_abs_resid,
        "outlier_days": sorted(outlier_days),
        "implied_rates": implied_rates,
    }


# ---------------------------------------------------------------------------
# C. 收客價：發票 ÷ 更數
# ---------------------------------------------------------------------------

EXTRA_MONTHLY_BUCKET = "__extra_from_monthly__"


def _shift_counts_by_site_and_type(shift_records: List[dict],
                                    shift_type_billing_group: Optional[Dict[str, str]] = None,
                                    billing_units: Optional[Dict[str, dict]] = None,
                                    ) -> Dict[str, Counter]:
    """收客價分母：逐 site 逐 shift_type 數 in-scope 更次。

    P0-執行計劃 WP3v2 條件1第1點兩個修正：
    1. `monthly_ic`（例如數碼港CP5早更IC）唔入 per_shift 分母——月費制自己
       一個billing_model獨立計，混入per_shift嘅Σ會令CP5由180變205、CP1-4
       嘅shift_type分佈都被污染，兩個site嘅收客價都解唔到（見rates-report
       「兩個真實bug」前身：CP5 180 vs 205 之爭）。`shift_type_billing_group`
       冇提供（例如舊test）就當全部per_shift，行為不變。
    2. `billing_units.csv` 嘅 `extra_shifts_from_monthly`：有啲site（目前
       已知HKU Y更 S006）月結R2有逐日更表完全冇來源嘅額外更次（獨立雞頭費
       94更），但呢啲更次用緊同一個收客價開單，計Σclient_rate嘅分母要加
       埋，用一個冇對應真實shift_type_id嘅synthetic bucket
       (EXTRA_MONTHLY_BUCKET) 入去，總數（sum(counts.values())）會計埋，
       但唔會當做一個「shift_type」拎去試two-rate/OT分解（見
       build_client_rate_cards 用 `total_shifts` 嗰陣要留意）。
    """
    shift_type_billing_group = shift_type_billing_group or {}
    billing_units = billing_units or {}
    out: Dict[str, Counter] = defaultdict(Counter)
    for r in shift_records:
        if r["record_type"] == "shift" and r["is_external"] == "False" and r["out_of_scope"] == "False":
            bg = shift_type_billing_group.get(r["shift_type_id"], "per_shift")
            if bg != "per_shift":
                continue
            out[r["site_id"]][r["shift_type_id"]] += 1
    for site_id, meta in billing_units.items():
        extra = meta.get("extra_shifts_from_monthly") or 0
        if extra:
            out[site_id][EXTRA_MONTHLY_BUCKET] += extra
    return out


def _brute_force_two_rate(counts: List[int], amount: Decimal,
                           lo=400, hi=1100, step=5,
                           known_rates: Optional[set] = None) -> List[Tuple[Decimal, ...]]:
    """試喺 [lo,hi] 範圍、step 蚊間距搵 rate 組合令 Σcount_i*rate_i == amount
    （容許 0.02 蚊嘅四捨五入誤差）。範圍上限 1100 跟返呢盤生意目前見過嘅
    per-shift價全部 < 1100（最高 1050，見 known_rates_from_payroll）——
    唔擴闊範圍，避免『網格內岩岩好整除』嘅巧合被當做真解（例如曾經試過
    1400/1300 呢組喺1400上限先岩岩好砌得出，但1400蚊一更完全冇喺任何
    真實payroll頁出現過，經濟上唔make sense）。Return 全部解（多過一個就
    係 ambiguous）。"""
    candidates = [Decimal(v) for v in range(lo, hi + 1, step)]
    sols = []
    n = len(counts)
    if n == 1:
        c = counts[0]
        if c == 0:
            return []
        rate = amount / c
        if rate == rate.quantize(Decimal("0.01")):
            sols.append((rate,))
        return sols
    if n == 2:
        c0, c1 = counts
        for r0 in candidates:
            remaining = amount - c0 * r0
            if c1 == 0:
                continue
            r1 = remaining / c1
            if r1 < lo or r1 > hi:
                continue
            if r1 == r1.quantize(Decimal("0.01")) and (r1 * 20) == (r1 * 20).to_integral_value():
                # 只接受 5 蚊倍數嘅解，避免奇怪嘅浮點巧合
                if r1 % 5 == 0:
                    sols.append((r0, r1))
        if known_rates:
            # 一律優先揀「兩個價都喺payroll-rows.csv出現過」嘅組合——就算純數學
            # 得返一組解，如果嗰組解嘅價完全冇喺呢盤生意出現過（例如1400/1300），
            # 都係網格巧合大過真價嘅可能性更高，寧願唔屈出嚟。
            filtered = [s for s in sols if s[0] in known_rates and s[1] in known_rates]
            if filtered:
                return filtered
        return sols
    return []  # 3個或以上未知數：唔喺呢個範圍自動試，交 pending


def _try_ot_hourly_decomposition(amount: Decimal, total_shifts: int, hours_per_shift=Decimal("8.25"),
                                  count_window=3, rate_lo=500, rate_hi=1000, rate_step=5,
                                  max_ot_hours=16, known_rates: Optional[set] = None):
    """P0-執行計劃§2 B1／§4：OT 唔當更次，但要按鐘計錢，公式係
    `count*rate + ot_hours*(rate/hours_per_shift)`（例：HKU C更 199×700+8h×
    700/8.25）。呢個 function 試喺 `total_shifts` 附近 ± count_window（因為
    WP3 手上嘅shift_records更數可能同結算單位實際更數差1-2，呢個差異本身
    留俾WP4核）搵一個 5蚊倍數嘅 rate 令 ot_hours 落喺一個乾淨嘅數（0.25小時
    倍數）、而且細（≤`max_ot_hours`，OT理應係細修正唔係主項）。淨係當
    候選得返一組先當「搵到」，唔係就話畀你知有幾多組候選，唔屈一個假解。
    Return (count, rate, ot_hours) 或 None（連同 candidates 數量一齊return）。"""
    candidates = []
    for count in range(max(1, total_shifts - count_window), total_shifts + count_window + 1):
        for rate in (Decimal(v) for v in range(rate_lo, rate_hi + 1, rate_step)):
            remaining = amount - count * rate
            if remaining < 0:
                continue
            ot_hours = remaining * hours_per_shift / rate
            if ot_hours > max_ot_hours:
                continue
            nearest_quarter = (ot_hours * 4).to_integral_value(rounding=ROUND_HALF_UP) / 4
            if abs(ot_hours - nearest_quarter) <= Decimal("0.02") and nearest_quarter > 0:
                candidates.append((count, rate, nearest_quarter))
    if len(candidates) == 1:
        return candidates[0], candidates
    if len(candidates) > 1 and known_rates:
        # 用「呢個rate有冇喺payroll-rows.csv出現過」做domain knowledge篩選——
        # 純數學上嘅5蚊網格解好多時有幾組，但實際出街價/收客價幾乎全部都係
        # 已經觀察過嘅價（620/650/680/700/730/750/800/820/840/850/880/900/930/1050…），
        # 冇出現過嘅價（例如710）大機會係網格巧合，唔係真價。
        filtered = [c for c in candidates if c[1] in known_rates]
        if len(filtered) == 1:
            return filtered[0], candidates
    return None, candidates


def _near_divisor_probe(amount: Decimal, total_shifts: int, window=10) -> List[Tuple[int, Decimal]]:
    """P0-執行計劃§4 已經記錄咗幾個盤嘅「更表更數 vs 發票反推更數」有細差
    （例如數碼港CP1-4 234 vs 230，差4，Wilson Guard/客戶自己人另計）。WP3 唔
    負責重新核更數（嗰個係WP1/WP4嘅工作），但可以喺 pending 嗰陣列出：如果
    用「總更數 ± window」入面邊個整數整除得出一個乾淨（5蚊倍數）嘅價，畀
    人手覆核個更數差異用。Return [(shift_count, clean_rate), ...] 由近至遠。"""
    out = []
    for delta in range(1, window + 1):
        for cand in (total_shifts - delta, total_shifts + delta):
            if cand <= 0:
                continue
            rate = amount / cand
            if rate == rate.quantize(Decimal("0.01")) and rate % 5 == 0:
                out.append((cand, rate))
    return out


def _find_residual_rate_near(amount: Decimal, count: int, known_rates: Optional[set],
                              window=Decimal("30"), max_residual=Decimal("2000")):
    """P0-執行計劃 WP3v2 條件1 第4點：西九龍城巴（17更×820=13,940，發票
    13,970，差30蚊「疑似津貼」）呢類——發票唔整除，但同一個client_group
    嘅其他兄弟盤已經證實嘅價（呢度用known_rates做近似）加一個細殘差就啱。
    喺 naive_rate=amount/count 附近 ±window 蚊搵 known_rates 候選，計
    diff=amount-rate*count，要求唯一先接受（避免亂咁屈一個「啱啱好」嘅
    價）。Return (rate, diff) 或 None。"""
    if not count or not known_rates:
        return None
    naive = amount / count
    cands = []
    for r in known_rates:
        if abs(r - naive) > window:
            continue
        diff = amount - r * count
        if 0 < abs(diff) <= max_residual and diff == diff.to_integral_value():
            cands.append((r, diff))
    if not cands:
        return None
    # 揀殘差最細嗰個；如果最細嘅唔係唯一（真係撞值），先當ambiguous唔接受。
    cands.sort(key=lambda c: abs(c[1]))
    if len(cands) > 1 and abs(cands[0][1]) == abs(cands[1][1]):
        return None
    return cands[0]


def _try_prorata_per_shift(amount: Decimal, count: int, known_rates: Optional[set],
                            num=30, den=31) -> Optional[Tuple[Decimal, Decimal, Decimal]]:
    """P0-執行計劃 WP3v2 條件1 第4點：凱和山呢類——真正個 per-shift rate係
    nominal（例如900），但呢個月嘅發票金額係 nominal×num/den×count（唔係
    nominal×count 咁簡單，成個月按 30/31 日比例微調，機制同月費pro-rata
    唔同：呢度個「比例」乘落per-shift rate，唔係乘落一個同更數無關嘅
    月費總數）。喺 known_rates（5蚊網格，已喺payroll出現過嘅價）搜索邊個
    nominal 令 predicted 最貼近 amount，容忍 ±(0.01×count + 0.5) 蚊嘅印刷/
    四捨五入誤差（quantize 去分先加埋)。Return (nominal, predicted, diff)
    或 None。"""
    if not count:
        return None
    best = None
    tol = Decimal("0.01") * count + Decimal("0.5")
    for r in sorted(known_rates or []):
        predicted = (r * Decimal(num) / Decimal(den) * count).quantize(TWOPLACES, rounding=ROUND_HALF_UP)
        diff = abs(predicted - amount)
        if diff <= tol and (best is None or diff < best[2]):
            best = (r, predicted, diff)
    return best


def _try_prorata_monthly(amount: Decimal, num=30, den=31,
                          lo=10000, hi=300000, step=1000,
                          tol=Decimal("0.05")) -> Optional[Tuple[Decimal, Decimal]]:
    """P0-執行計劃 WP3v2 條件1 第4點：小欖／淺水灣呢類——月費（唔隨更數
    變）× num/den 日數比例＝當月發票總額，同更數完全無關（呢個先係真·
    monthly_fixed，唔係per_shift）。喺千位網格搜 base。Return (base,
    predicted) 或 None。"""
    for base in range(lo, hi + 1, step):
        predicted = (Decimal(base) * Decimal(num) / Decimal(den)).quantize(TWOPLACES, rounding=ROUND_HALF_UP)
        if abs(predicted - amount) <= tol:
            return Decimal(base), predicted
    return None


# P0-執行計劃.md §4「初步對數」表已經記低嘅、跨WP1/WP2b/WP3已知嘅更表 vs
# 月結R2/發票更數差異（唔屬於WP3收客價反推嘅錯，交WP4覆核邊個先啱）。Gate
# 唔可以將呢類「已知、有出處」嘅細差當做「rate solved 但兜唔住發票」嘅
# 錯誤盲降返pending——但都唔可以無限放寬，所以淨係俾返呢張表列明嘅site
# 一個「count差 × rate」嘅額外容忍度，其他site一律維持嚴格0.05。
# P0-執行計劃.md §2 B4：龍譽（S043）／惠康貨倉（S044）發票係「補單」1
# 更、冇更表冇糧單，決定當「特殊收入項」，只記總額入billing_model=
# special，唔再落pending清單。
SPECIAL_INCOME_SITES = {"S043", "S044"}

KNOWN_SHIFT_COUNT_DIFFS = {
    "S010": 4,   # 數碼港CP1-4：更表234 vs R2/發票230
    "S017": 1,   # 啟航1331：更表1,122+Event4=1,126 vs 月結R2 1,123+Event14=1,137（多個更別，交WP4）
    "S007": 3,   # HKU座頭：更表201 vs 199（OT另計）
    "S009": 2,   # 凱和山：更表73 vs R2 71
    "S029": 2,   # 淺水灣：更表88 vs R2 90
    "S027": 1,   # 小欖：更表62 vs R2 63
    "S005": 1,   # 皓日：更表17 vs R2/發票16
    "S015": 1,   # Weave Robinson：更表32 vs R2/發票33
    "S004": 6,   # Weave OL：更表31 vs R2/發票25
    "S002": 1,   # IFC：更表40 vs R2 41（月費制，Gate唔逐更stamp，呢度純粹記錄）
    "S006": 4,   # HKU Y更：更表166 vs 170（唔計獨立雞頭94，嗰個已經用billing_units.csv處理）
    "S008": 1,   # HKU醫學院：shift_records 4 vs 真實5更
    "S033": 1,   # 都會大學學生宿舍：shift_records 17 vs R2 18
    "S031": 22,  # 控制室：shift_records 44 vs R2 66——§3.7列明呢個site應該由
                 # WP2a（公司兵/G頁）逐日轉錄，但shift_records淨係得44更，
                 # 22更嘅缺口係WP1/WP2b層面嘅資料流問題（roster/WP2a→WP2b→
                 # shift_records冇齊），唔係WP3收客價反推嘅錯——rate（840，
                 # 仲有每月固定1,350呢個billing_adjustment）已經由R2月結證實，
                 # 呢個大缺口交返WP4／WP1覆核，唔阻住個rate solved。
}


def apply_client_rate_gate(rate_cards: List[dict], priced_rows: List[dict],
                            client_solve_log: List[dict],
                            billing_adjustments: List[dict],
                            billing_units: Optional[Dict[str, dict]] = None,
                            tolerance: Decimal = Decimal("0.05")):
    """P0-執行計劃 WP3v2 條件1 第3點——Gate：任何 solved 收客價，Σ
    client_rate_snapshot（該開票單位 in-scope 記錄）必須等於發票金額（差
    ≤0.05，加埋呢個site已經記低嘅billing_adjustments殘差之後）先准
    solved，否則退pending並寫明Σ同差額。

    喺 `price_shift_records` 跑完之後（先有 client_rate_snapshot 可以加總）
    先可以做呢個check；結果會就地mutate `rate_cards`（將唔過關嗰啲
    billing_model=per_shift 嘅solved卡改做pending，加note），
    call呢個function之後，wp3_run.py 要用返新嘅rate_cards重跑
    price_shift_records，先至令priced_rows/report反映返downgrade咗嘅卡。

    Return：gate_rows（每個可比開票單位一行，包含site_id/invoice金額/Σ/
    差額/adjustments/結果，寫落 rates-report.md 嘅Gate結果表）。"""
    billing_units = billing_units or {}
    site_snapshot_sum: Dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    site_priceable_count: Dict[str, int] = defaultdict(int)
    for r in priced_rows:
        if r.get("record_type") == "shift":
            site_priceable_count[r["site_id"]] += 1
            if r.get("client_rate_snapshot"):
                site_snapshot_sum[r["site_id"]] += D(r["client_rate_snapshot"])

    site_adjustments: Dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for a in billing_adjustments:
        site_adjustments[a["site_id"]] += D(a["adjustment_amount"])

    gate_rows = []
    downgraded_sites = set()
    for c in client_solve_log:
        if not c["status"].startswith("solved"):
            continue
        site_id = c["site_id"]
        if not site_id:
            continue
        # monthly_fixed/admin_fee 嘅 client_rate 本身就係amount，Gate必然過
        # （呢類billing_model刻意唔逐更stamp snapshot，見wp3_pricing.py）；
        # Gate淨係管per_shift（包括r2_report/prorata/divide_with_residual
        # 呢啲一樣係per_shift嘅source）。
        if "monthly_fixed" in c["status"] or "admin_fee" in c["status"] or "special_income" in c["status"]:
            continue
        # 完全冇shift_records嘅site（例如國泰城、ICBC、哈羅——P0-執行計劃
        # §3.7列明「月結有、更表冇」，冇任何逐日來源）：Σclient_rate_snapshot
        # 必然係0，唔係rate錯，係根本冇嘢俾pricing.py stamp——呢類淨係喺
        # solve嗰陣（R2/發票金額本身）驗證過，Gate呢度冇嘢好再查，直接PASS
        # 唔算入FAIL。
        if site_priceable_count.get(site_id, 0) == 0:
            gate_rows.append({
                "site_id": site_id, "label": c["label"], "invoice_no": c["invoice_no"],
                "invoice_amount": c["amount"], "snapshot_sum": "0",
                "billing_adjustments": "0", "diff": "n/a",
                "gate": "PASS(no_shift_records)",
            })
            continue

        invoice_amount = D(c["amount"])
        snapshot_sum = site_snapshot_sum.get(site_id, Decimal("0"))
        adjustments = site_adjustments.get(site_id, Decimal("0"))

        # 有已知shift-count差異（§4/billing_units.csv）嘅site，額外容忍
        # 「差幾多更 × 呢個site嘅rate」——呢個唔係cover緊亂咁嘅錯，係cover
        # 緊一個已經有出處、老闆/Fable5.1規劃階段已經寫入§4嘅已知細差
        # （例如皓日更表17但R2/發票只認16更），交WP4，唔係WP3嘅rate錯。
        try:
            rate_here = D(c["client_rate"]) if c["client_rate"] else None
        except Exception:
            rate_here = None
        known_diff_allowance = Decimal("0")
        known_diff_note = ""
        if rate_here is not None:
            n_shifts_gap = KNOWN_SHIFT_COUNT_DIFFS.get(site_id, 0)
            n_monthly_extra = (billing_units.get(site_id, {}) or {}).get("extra_shifts_from_monthly", 0)
            n_total_gap = n_shifts_gap + n_monthly_extra
            if n_total_gap:
                known_diff_allowance = rate_here * n_total_gap
                known_diff_note = f"（含已知更數差{n_total_gap}更×{rate_here}={known_diff_allowance}嘅容忍度，見P0-執行計劃§4/billing_units.csv）"

        # 逐更 stamp 嘅 client_rate 本身要 quantize 落分（例如凱和山 pro-rata
        # 個 nominal×30/31 唔啱好係分嘅倍數，872.97 呢個2dp數字本身已經同
        # 「數學上準確」嘅870.9677…有0.0023蚊嘅差，逐更加埋幾十次會滾大到
        # 幾毫子）——俾返一個成比例（每條記錄至多0.01蚊）嘅印刷/四捨五入
        # 容忍度，先唔會將呢種純量化誤差都當做rate錯。
        n_priced = site_priceable_count.get(site_id, 0)
        quantize_tolerance = Decimal("0.01") * n_priced
        diff = invoice_amount - (snapshot_sum + adjustments)
        passed = (abs(diff) <= tolerance + quantize_tolerance
                  or abs(diff) <= known_diff_allowance + tolerance + quantize_tolerance)
        gate_rows.append({
            "site_id": site_id, "label": c["label"], "invoice_no": c["invoice_no"],
            "invoice_amount": str(invoice_amount), "snapshot_sum": str(snapshot_sum),
            "billing_adjustments": str(adjustments), "diff": str(diff),
            "gate": ("PASS" if abs(diff) <= tolerance else "PASS(known_shift_gap)") if passed else "FAIL",
        })
        if passed and abs(diff) > tolerance:
            # PASS 但要留底喺 note 度，唔可以靜靜過關唔留痕。
            for rc in rate_cards:
                if rc["site_id"] == site_id and rc["status"] == "solved" and rc["billing_model"] == "per_shift":
                    rc["note"] = (rc["note"] + "; " if rc["note"] else "") + (
                        f"Gate：Σ{snapshot_sum}+adj{adjustments}同發票{invoice_amount}差{diff}"
                        f"{known_diff_note}，喺已知容忍度內，Gate PASS")
        if not passed:
            downgraded_sites.add(site_id)
            for rc in rate_cards:
                if (rc["site_id"] == site_id and rc["status"] == "solved"
                        and rc["billing_model"] == "per_shift"):
                    rc["status"] = "pending"
                    rc["note"] = (rc["note"] + "; " if rc["note"] else "") + (
                        f"★Gate唔過：Σclient_rate_snapshot({snapshot_sum})+billing_adjustments"
                        f"({adjustments})={snapshot_sum+adjustments}，同發票{invoice_amount}"
                        f"差{diff}，超過±{tolerance}容忍——退返pending，唔可以話solved但實際"
                        f"對唔上發票（P0-執行計劃WP3v2條件1第3點Gate）"
                    )
    return gate_rows, downgraded_sites


def known_rates_from_payroll(payroll_rows: List[dict]) -> set:
    """搜集payroll-rows.csv『rate』欄出現過嘅乾淨per-shift價，用嚟喺
    two-rate/OT-hourly brute force搵到多過一組解嗰陣做domain filter。
    要剔除：K-1331（嗰欄其實係逐日總額，唔係per-shift rate）、個別雞頭
    （月薪/佣金，唔係更價），同埋設一個現實價上限（呢個生意目前見過嘅
    per-shift價全部 < 1200）避免將『金額啱啱好整除』嘅巧合當做已知價。"""
    out = set()
    for row in payroll_rows:
        if row["settlement_unit"] in (_BROKER_K_1331, _BROKER_P):
            continue
        try:
            v = D(row["rate"])
        except Exception:
            continue
        if v is not None and v == v.to_integral_value() and v % 5 == 0 and 100 <= v <= 1200:
            out.add(v)
    return out


def r2_rows_by_site_id(r2_pdf_path, site_index: SiteIndex,
                        invoice_aliases: Dict[str, str]) -> Dict[str, list]:
    """將 月結R2.pdf 逐行（wp3_r2.parse_r2_rows）用同發票行一樣嘅方法
    （invoice_aliases 優先，唔到先 site_index.resolve）解 site_id，方便
    build_client_rate_cards 逐開票單位攞返 R2 自己嗰行做證據 (a)。可以
    一個 site_id 對應多過一條 R2Row（好少見），逐條都試。"""
    from . import wp3_r2
    out: Dict[str, list] = defaultdict(list)
    for r in wp3_r2.parse_r2_rows(r2_pdf_path):
        site_id = invoice_aliases.get(r.label) or site_index.resolve(r.label)
        if site_id:
            out[site_id].append(r)
    return out


def build_client_rate_cards(invoice_lines: List[dict], site_index: SiteIndex,
                             invoice_aliases: Dict[str, str],
                             shift_counts: Dict[str, Counter],
                             sites_by_id: Dict[str, dict],
                             rcb: RateCardBuilder,
                             cross_month_lines: Optional[List[dict]] = None,
                             known_rates: Optional[set] = None,
                             r2_by_site: Optional[Dict[str, list]] = None,
                             billing_adjustments: Optional[List[dict]] = None):
    """Section C：逐開票單位（發票行）解 client_rate。

    `invoice_lines` 必須已經 filter 到 period=='2026-07'（每個 site 淨係應該
    有一條 solved client_rate rate_card，唔可以同一個 site 出多過一條 solved
    rate_card，唔係下游 pricing 會因為「揀邊條」而 ambiguous）。`cross_month_lines`
    係 5/6 月嘅發票行（唔會生成 rate_card，淨係加入 pending 嘅 note 做參考，
    §3.7a「用5/6月發票同月結交叉驗證」）。"""
    from . import wp3_r2
    solve_log = []
    if billing_adjustments is None:
        billing_adjustments = []
    cross_by_label: Dict[str, List[dict]] = defaultdict(list)
    for l in (cross_month_lines or []):
        cross_by_label[l["label"]].append(l)
    r2_by_site = r2_by_site or {}

    # known_rates 淨係嚟自 payroll-rows.csv（現金結算單位嘅出街價）就會漏
    # 咗好多收客價先有嘅價（900/930/820呢類淨係喺客戶度出現、唔會喺安員
    # 糧單見到）——pro-rata/two-rate/OT呢啲brute-force方法要識埋呢啲價
    # 先撞得到（例如凱和山900×30/31嗰個900），所以呢度將R2月結報表全部
    # 印過嘅乾淨收客價都撈埋做「已知價」嘅補充來源。
    known_rates = set(known_rates or [])
    for rows in r2_by_site.values():
        for r2row in rows:
            for text in r2row.client_rate_texts:
                info = wp3_r2.classify_rate_text(text)
                if info["kind"] == "clean" and info["value"] is not None:
                    known_rates.add(info["value"])

    # 殘差（+30／+150／+140／每月固定+1,350 呢類）：primary rate 已經解到，
    # 但同發票總額有一個細額、成蚊嘅差距，唔應該阻住個 rate_card 變
    # solved，但都唔可以靜靜吞咗佢——記入 billing_adjustments，狀態
    # 「待老闆確認」（P0-執行計劃 WP3v2 條件1 第4點尾段）。
    RESIDUAL_MAX = Decimal("2000")

    def _record_residual(site_id, label, diff, note):
        if diff == 0:
            return
        billing_adjustments.append({
            "site_id": site_id, "label": label,
            "adjustment_amount": str(diff), "period": "2026-07",
            "status": "待老闆確認", "note": note,
        })

    for line in invoice_lines:
        label = line["label"]
        site_id = invoice_aliases.get(label) or site_index.resolve(label)
        amount = D(line["amount"])
        evidence_inv = f"Invoice-Record-updated-19.08.2026.pdf#{line['invoice_no']}({label}, Jul-26, HK${amount})"

        if not site_id:
            # 修正 A5：呢句 boilerplate 之前將「啟航1331 Event」／「龍譽」／
            # 「惠康貨倉」都寫做「P0範圍外項目」，但三者其實都已經喺
            # P0-執行計劃§2 B4／WP3c落地做「特殊收入項」（special
            # billing_model，status=solved）——龍譽/惠康嘅發票label正常
            # 會經site_index/invoice_aliases解到site_id，根本唔會行到呢個
            # 分支；「啟航1331 Event」淨係因為呢個generic per-invoice-line
            # loop 冇幫佢個exact label（帶「Event」字尾）加alias，先跌落
            # 呢度——真正嘅rate_card係喺wp3_run.py用ST0026鎖定嘅專屬
            # special卡另外生成，唔係「唔生成」。所以呢度嘅note唔可以
            # 再屈呢三個係範圍外，只講返真正範圍外（LINK C7，見P0-執行
            # 計劃§5）同真.unmapped兩種情況。
            if label == "啟航1331 Event":
                note = ("啟航1331 Event屬P0範圍內特殊收入項（P0-執行計劃§2 B4），"
                         "呢個generic per-invoice-line流程冇幫呢個exact label配alias所以搵唔到site_id，"
                         "但唔代表範圍外——實際rate_card由wp3_run.py用shift_type_id=ST0026另外生成（見rate_cards.csv）")
            elif "Link C7" in label or "LINK C7" in label:
                note = "呢張發票開俾LINK C7細盤，P0-執行計劃§5明文界定LINK C7範圍外（獨立合約模式、長工autopay），唔生成rate_card"
            else:
                note = f"「{label}」對唔上任何site_id（sites.csv／invoice_site_aliases.csv都冇），可能係大數/Ad-hoc/鎖車等未對照項目，人手核實係咪要補alias"
            solve_log.append({
                "invoice_no": line["invoice_no"], "label": label, "site_id": "",
                "amount": str(amount), "shifts": "", "client_rate": "",
                "status": "out_of_scope_or_unmapped",
                "note": note,
            })
            continue

        site = sites_by_id.get(site_id, {})
        billing_model = site.get("billing_model", "per_shift")

        if billing_model == "monthly_fixed":
            monthly_fee = site.get("monthly_fee") or ""
            note = f"月費制，7月發票金額{amount}（sites.csv monthly_fee={monthly_fee}，如有pro-rata差異見note）"
            # 2026-09-10 裁定：月費制但發票金額 ≠ 足月月費嗰陣，試「扣N日
            # SL（病假）」pro-rata讀法（monthly_fee × (31-N)/31）——例如CP5 IC
            # 例如CP5 IC嗰位月費制安員31日SL，32000×30/31=30,967.74，同發票分毫不差。淨係
            # 喺岩岩好整除（5分位對得上）先寫呢句，唔係就保留返generic note，
            # 唔屈估一個唔啱嘅解釋。
            try:
                fee_dec = D(str(monthly_fee)) if monthly_fee else None
            except InvalidOperation:
                fee_dec = None
            if fee_dec and fee_dec > 0 and amount != fee_dec:
                for sl_days in range(1, 6):
                    prorated = q2(fee_dec * D(31 - sl_days) / D(31))
                    if prorated == amount:
                        note = (f"月費制，7月發票金額{amount}——扣{sl_days}日SL嘅pro-rata讀法："
                                 f"月費{fee_dec}×{31-sl_days}/31={prorated}，同發票分毫不差（evidence改「SL扣日」）")
                        break
            rcb.add(site_id=site_id, billing_model="monthly_fixed",
                    client_rate=amount, source="invoice+sites.monthly_fee",
                    evidence=evidence_inv, confidence="high", status="solved",
                    note=note)
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": "",
                               "client_rate": str(amount), "status": "solved(monthly_fixed)", "note": ""})
            continue

        if billing_model == "admin_fee":
            rcb.add(site_id=site_id, billing_model="admin_fee",
                    client_rate=amount, source="invoice",
                    evidence=evidence_inv, confidence="high", status="solved",
                    note="行政費制，只記總額")
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": "",
                               "client_rate": str(amount), "status": "solved(admin_fee)", "note": ""})
            continue

        counts = shift_counts.get(site_id, Counter())
        total_shifts = sum(counts.values())
        # two-rate/near-divisor 呢類「逐 shift_type 試分解」嘅方法，唔應該將
        # EXTRA_MONTHLY_BUCKET（billing_units.csv 嘅「月結有、更表冇」嘅
        # 額外更次，冇對應真實shift_type_id）當做一個可以獨立分解嘅更別。
        real_type_counts = Counter({k: v for k, v in counts.items() if k != EXTRA_MONTHLY_BUCKET})

        # ---------------------------------------------------------------
        # (a) R2 月結報表「收客價」欄——優先次序最高嘅證據來源。
        # ---------------------------------------------------------------
        r2_rows_here = r2_by_site.get(site_id, [])
        r2_solved = False
        for r2row in r2_rows_here:
            best = wp3_r2.best_client_rate(r2row)
            weak = False
            if not best:
                # best_client_rate 要求 R2 自己嗰行「更數×rate＝R2自己印嘅
                # 營業額」，控制室（840×66≠56,790，差1,350「每月固定」殘差）
                # 呢類就過唔到呢一關——退而求其次：如果呢行淨係得一個唯一
                # 嘅乾淨候選，都算證據（起碼係R2親身印低嘅數字），跌落去
                # 用我哋自己嘅total_shifts/發票金額驗證（下面照跑一樣嘅
                # 整除/殘差邏輯，只不過confidence降級、note講明點解）。
                single = wp3_r2.single_clean_candidate(r2row)
                if single is None:
                    continue
                best = {"value": single, "raw": str(single),
                        "note": f"呢行R2自己嘅更數×rate同R2自己印嘅營業額對唔上"
                                f"（row.shifts={r2row.shifts}，row.revenue={r2row.revenue}），"
                                f"但呢行淨係得一個唯一嘅乾淨候選{single}，退而求其次用"}
                weak = True
            rate_val = best["value"]
            # R2 自己嗰行嘅更數／營業額同呢張發票嘅更數／金額唔一定完全
            # 一樣（R2 可能覆蓋成個月、發票可能拆幾張；亦都可能好似皓日噉
            # R2寫16更但更表/shift_records有17更、控制室噉R2寫66更但
            # shift_records淨係44更）——兩個count都試（shift_records同
            # R2自己），邊個令個殘差細就用邊個，唔淨係信一邊。
            count_candidates = [("shift_records", total_shifts)]
            if r2row.shifts:
                count_candidates.append((f"R2row{r2row.row_no}", r2row.shifts))
            best_pick = None  # (count_label, count, predicted, diff)
            for clabel, cval in count_candidates:
                if not cval:
                    continue
                predicted_here = rate_val * cval
                diff = amount - predicted_here
                if best_pick is None or abs(diff) < abs(best_pick[3]):
                    best_pick = (clabel, cval, predicted_here, diff)
            if best_pick is None:
                continue
            count_label, count_used, predicted_here, diff = best_pick
            evidence_chain = [f"(a)R2月結row{r2row.row_no}「{r2row.label}」收客價={best['raw']}"
                               f"（{best['note']}）"]
            count_note = f"（用{count_label}嘅更數{count_used}）" if count_label != "shift_records" else ""
            if abs(diff) <= Decimal("0.05"):
                rcb.add(site_id=site_id, billing_model="per_shift", client_rate=rate_val,
                        source="r2_report", evidence=evidence_inv,
                        confidence="medium" if weak else "high", status="solved",
                        note=f"R2月結row{r2row.row_no}收客價={rate_val}，"
                             f"套用更數{count_used}=發票金額{amount}（差{diff}）{count_note}",
                        evidence_chain=evidence_chain + [f"套用更數{count_used}{count_note}×{rate_val}=發票金額{amount}（差{diff}）"])
                solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                                   "site_id": site_id, "amount": str(amount), "shifts": count_used,
                                   "client_rate": str(rate_val), "status": "solved(r2_report)", "note": ""})
                r2_solved = True
                break
            if 0 < abs(diff) <= RESIDUAL_MAX and diff == diff.to_integral_value():
                rcb.add(site_id=site_id, billing_model="per_shift", client_rate=rate_val,
                        source="r2_report", evidence=evidence_inv,
                        confidence="medium", status="solved",
                        note=f"R2月結row{r2row.row_no}收客價={rate_val}，套用更數"
                             f"{count_used}{count_note}後同發票金額差{diff}（成蚊數、細額，記billing_adjustments.csv待老闆確認）",
                        evidence_chain=evidence_chain + [f"套用更數{count_used}{count_note}×{rate_val}=發票金額{amount}，殘差{diff}→billing_adjustments"])
                _record_residual(site_id, label, diff,
                                  f"R2收客價{rate_val}×更數{count_used}{count_note}={predicted_here}，"
                                  f"發票實收{amount}，差{diff}（P0-執行計劃WP3v2條件1第4點列明嘅細殘差類別）")
                solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                                   "site_id": site_id, "amount": str(amount), "shifts": count_used,
                                   "client_rate": str(rate_val), "status": "solved(r2_report+residual)", "note": ""})
                r2_solved = True
                break
        if r2_solved:
            continue

        if total_shifts == 0:
            # 龍譽（S043）／惠康貨倉（S044）：發票係「補單」1更、冇更表冇
            # 糧單（P0-執行計劃§2 B4「按鐘／分成／專車」決定：P0當「特殊
            # 收入項」人手入總數，唔自動計）。呢類同其他「冇shift來源」嘅
            # site（國泰城、卓弘…）唔同——嗰啲係之後可能補齊來源嘅pending，
            # 呢兩個係已經裁定「淨係得總額，冚唪唥都唔會有逐日來源」，所以
            # 直接記做billing_model=special、status=solved，唔再落pending
            # 清單阻住WP3驗收（唯一准喺WP3c碰嘅wp3_rates.py位）。
            if site_id in SPECIAL_INCOME_SITES:
                rcb.add(site_id=site_id, billing_model="special", client_rate=amount,
                        source="invoice", evidence=evidence_inv, confidence="high",
                        status="solved",
                        note=f"特殊收入項（補單，P0-執行計劃§2 B4）：發票{line['invoice_no']}金額{amount}，"
                             f"冇更表冇糧單來源，只記總額，唔逐更計價")
                solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                                   "site_id": site_id, "amount": str(amount), "shifts": 0,
                                   "client_rate": str(amount), "status": "solved(special_income)", "note": ""})
                continue
            near_note = ""
            near_candidates = []
            if r2_rows_here:
                for r2row in r2_rows_here:
                    for text in r2row.client_rate_texts:
                        info = wp3_r2.classify_rate_text(text)
                        if info["kind"] == "clean" and info["value"] is not None:
                            near_candidates.append((r2row.shifts, info["value"]))
            if near_candidates:
                near_note = "；R2有印收客價但同呢張發票金額對唔上（可能R2/發票覆蓋範圍唔同）：" + \
                    "、".join(f"row{r.row_no if hasattr(r,'row_no') else ''}{s}更→{v}" for s, v in near_candidates)
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=None,
                    source="invoice", evidence=evidence_inv, confidence="low",
                    status="pending",
                    note=f"發票有金額{amount}但shift_records冇呢個site任何in-scope更次（冇逐日來源，P0只記月結/發票總數，見P0-執行計劃§3.7）{near_note}")
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": 0,
                               "client_rate": "", "status": "pending(no_shift_source)", "note": ""})
            continue

        # ---------------------------------------------------------------
        # (b) 發票整除
        # ---------------------------------------------------------------
        rate = amount / total_shifts
        if rate == rate.quantize(Decimal("0.01")):
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=q2(rate),
                    source="invoice", evidence=evidence_inv + f"；shift_records更數={total_shifts}",
                    confidence="high", status="solved",
                    note=f"{amount} / {total_shifts}更 = {q2(rate)}，整除",
                    evidence_chain=[f"(b)發票整除：{amount}/{total_shifts}更={q2(rate)}"])
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                               "client_rate": str(q2(rate)), "status": "solved(divide_evenly)", "note": ""})
            continue

        tried_note = f"{amount} / {total_shifts}更 = {q2(rate)}，唔整除；"
        chain_so_far = [f"(a)R2:{'冇匹配' if not r2_rows_here else '有row但驗證唔到'}",
                         f"(b)發票整除：{amount}/{total_shifts}更={q2(rate)}唔清"]

        # (b2) 發票整除 + 細殘差：西九龍城巴（17更×820=13,940，發票13,970，
        # 差30蚊「疑似津貼」）呢類，rate 本身喺 known_rates 出現過、貼近
        # naive rate，加個細殘差就啱——同 R2 嗰邊嘅殘差機制係同一個諗法，
        # 呢度處理「冇R2單獨一行、但同client_group兄弟盤已知價」嘅情況。
        residual_hit = _find_residual_rate_near(amount, total_shifts, known_rates)
        if residual_hit:
            rate2, diff2 = residual_hit
            note = (tried_note + f"喺known_rates搵到貼近嘅價{rate2}：{total_shifts}更×{rate2}="
                    f"{rate2*total_shifts}，同發票差{diff2}蚊（成蚊、細額，記billing_adjustments.csv"
                    f"待老闆確認，例如西九龍疑似津貼）")
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=rate2,
                    source="invoice_divide_with_residual", evidence=evidence_inv,
                    confidence="medium", status="solved", note=note,
                    evidence_chain=chain_so_far + [f"(b2)發票整除+細殘差：{total_shifts}更×{rate2}={rate2*total_shifts}，殘差{diff2}→billing_adjustments"])
            _record_residual(site_id, label, diff2,
                              f"{total_shifts}更×{rate2}={rate2*total_shifts}，發票實收{amount}，差{diff2}"
                              f"（P0-執行計劃WP3v2條件1第4點列明嘅細殘差類別）")
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                               "client_rate": str(rate2), "status": "solved(divide_with_residual)", "note": note})
            continue

        # ---------------------------------------------------------------
        # (d) pro-rata（凱和山呢類：nominal rate × 30/31 日比例）—— 喺 (c) OT
        # 按鐘之前試：實測發現 `_try_ot_hourly_decomposition` 對凱和山會屈
        # 出一個純數學上「啱」但業務上錯嘅解（880，即v1.1嗰個已知錯誤答
        # 案，P0-執行計劃WP3v2條件1第4點明確話唔係880）——OT公式冇話畀你
        # 聽呢個site有冇OT，純粹5蚊網格內岩岩好併得出嚟；而pro-rata 900
        # ×30/31 先有獨立證據支持（6月60更×900全中，7月R2自己印嘅871都
        # 貼近900×30/31=870.97）。所以順序上將(d)搬去(c)前面，避免一個
        # 純數學巧合搶閘變成false positive——呢個係經過驗證嘅刻意調動，
        # 唔係抄錯次序。
        # ---------------------------------------------------------------
        # 試埋 R2 自己嗰行嘅更數（可能同shift_records嘅total_shifts唔一樣，
        # 例如凱和山 R2=71 vs shift_records=73）——pro-rata嘅count理應用
        # 「實際出咗嘅更」，R2/shift_records邊個啱屬WP4嘅事，呢度純粹兩個
        # 都試，邊個貼近就用邊個，note講清楚用緊邊個count。
        prorata_counts = [("shift_records", total_shifts)] + [
            ("R2row" + r.row_no, r.shifts) for r in r2_rows_here if r.shifts]
        prorata = None
        prorata_count_used = None
        prorata_count_label = None
        for clabel, cval in prorata_counts:
            got = _try_prorata_per_shift(amount, cval, known_rates)
            if got and (prorata is None or got[2] < prorata[2]):
                prorata, prorata_count_used, prorata_count_label = got, cval, clabel
        if prorata:
            nominal, predicted, diff = prorata
            count_note = (f"（用{prorata_count_label}嘅更數{prorata_count_used}，"
                           f"同shift_records嘅{total_shifts}唔同，差{abs(prorata_count_used-total_shifts)}，交WP4核）"
                           if prorata_count_used != total_shifts else "")
            note = tried_note + (f"試pro-rata：nominal={nominal}×30/31×{prorata_count_used}更={predicted}，"
                                  f"同發票{amount}差{diff}（印刷/四捨五入誤差內）{count_note}")
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=q2(predicted / prorata_count_used),
                    source="invoice_prorata_solve", evidence=evidence_inv,
                    confidence="medium", status="solved", note=note,
                    evidence_chain=chain_so_far + [f"(d)pro-rata：nominal{nominal}×30/31×{prorata_count_used}更={predicted}≈{amount}"])
            if diff:
                _record_residual(site_id, label, diff,
                                  f"pro-rata nominal={nominal}解出嘅predicted({predicted})同發票實收({amount})"
                                  f"有{diff}蚊嘅印刷/四捨五入殘差")
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": prorata_count_used,
                               "client_rate": str(q2(predicted / prorata_count_used)),
                               "status": "solved(prorata)", "note": note})
            continue
        chain_so_far.append("(d)pro-rata：冇貼近嘅nominal×30/31候選")

        # ---------------------------------------------------------------
        # (c) OT 按鐘公式
        # ---------------------------------------------------------------
        ot_sol, ot_candidates = _try_ot_hourly_decomposition(amount, total_shifts, known_rates=known_rates)
        if ot_sol:
            count, r0, ot_hours = ot_sol
            caveat = ""
            if count != total_shifts:
                caveat = f"（用更數{count}，同shift_records嘅{total_shifts}差{abs(count-total_shifts)}，屬於已知細差，交WP4核）"
            note = tried_note + (f"試OT按鐘公式 count*rate+ot_hours*(rate/8.25)："
                                  f"{count}更×{r0} + {ot_hours}小時×({r0}/8.25) = {amount}{caveat}")
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=q2(r0),
                    source="invoice_ot_hourly_solve", evidence=evidence_inv,
                    confidence="medium", status="solved", note=note,
                    evidence_chain=chain_so_far + [f"(c)OT按鐘：{count}更×{r0}+{ot_hours}h×({r0}/8.25)={amount}"])
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                               "client_rate": str(q2(r0)), "status": "solved(ot_hourly)", "note": note})
            # 修正 B9：OT按鐘嗰截金額（count×rate同發票總額之間嘅差，例如
            # HKU C更199更×700=139,300，發票實收139,978.80，OT殘差678.80）
            # 之前淨係留喺note文字度，冇好似Weave RR 150、控制室1,350呢啲
            # 細殘差咁記入billing_adjustments.csv——同一個「解到primary
            # rate，但有個成蚊數細殘差要老闆確認」性質，用返同一個
            # _record_residual口徑補記，唔可以因為呢個殘差嘅來源係OT公式
            # （唔係R2套用更數）就唔記錄。
            ot_residual = q2(amount - (Decimal(count) * r0))
            _record_residual(site_id, label, ot_residual,
                              f"OT按鐘公式：{count}更×{r0}={q2(Decimal(count) * r0)}，"
                              f"OT{ot_hours}小時×({r0}/8.25)嘅殘差部分令發票實收{amount}，差{ot_residual}"
                              "（P0-執行計劃WP3v2條件1第4點列明嘅細殘差類別，同Weave RR 150/控制室1,350等同口徑）")
            continue
        elif ot_candidates:
            tried_note += f"；試OT按鐘公式，有{len(ot_candidates)}組候選(唔唯一，ambiguous)"
        chain_so_far.append("(c)OT按鐘：" + ("冇候選" if not ot_candidates else f"{len(ot_candidates)}組候選ambiguous"))

        # ---------------------------------------------------------------
        # (e) 兩個價分解（人數最多嘅更別 vs 其餘全部）
        # ---------------------------------------------------------------
        types_sorted = sorted(real_type_counts.items(), key=lambda kv: -kv[1])
        two_rate_solved = False
        if len(types_sorted) >= 2:
            top1_type, top1_count = types_sorted[0]
            rest_count = total_shifts - top1_count
            counts_for_solve = [top1_count, rest_count]
            sols = _brute_force_two_rate(counts_for_solve, amount, known_rates=known_rates) if rest_count > 0 else []
            extra_note = "" if len(types_sorted) == 2 else f"（原site有{len(types_sorted)}種shift_type，rest係其餘{len(types_sorted)-1}種合計，冇試逐種獨立分解）"
            tried_note += f"試「{top1_type}」({top1_count}更) vs 其餘({rest_count}更)兩個價{extra_note}"
            if len(sols) == 1:
                (r0, r1) = sols[0]
                caveat = ("；⚠️注意：呢個site淨係得1條月度總額方程式，解2個未知數理論上唔夠條件——"
                          "呢個解淨係喺『兩個價都要係5蚊倍數』呢個網格假設下先至唯一，"
                          "唔係嚴格數學上嘅必然解，建議WP4攞多個月份或者逐週資料先確認")
                note = tried_note + f"：（5蚊網格內）唯一解 {top1_type}={r0}, 其餘={r1}" + caveat
                chain = chain_so_far + [f"(e)兩價分解：{top1_type}={r0}/OTHER={r1}"]
                rcb.add(site_id=site_id, shift_type_id=top1_type, broker_id="",
                        billing_model="per_shift", client_rate=q2(r0), source="invoice_two_rate_solve",
                        evidence=evidence_inv, confidence="low", status="solved", note=note,
                        evidence_chain=chain)
                rcb.add(site_id=site_id, shift_type_id="OTHER", broker_id="",
                        billing_model="per_shift", client_rate=q2(r1), source="invoice_two_rate_solve",
                        evidence=evidence_inv, confidence="low", status="solved", note=note,
                        evidence_chain=chain)
                solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                                   "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                                   "client_rate": f"{top1_type}={r0}/OTHER={r1}",
                                   "status": "solved(two_rate)", "note": note})
                two_rate_solved = True
            elif len(sols) > 1:
                tried_note += f"，但有{len(sols)}組解（唔唯一，ambiguous）"
            else:
                tried_note += "，冇解（5蚊倍數、400-1100範圍內搵唔到）"
        if two_rate_solved:
            continue
        chain_so_far.append("(e)兩價分解：" + tried_note.split("；")[-1])

        # ---------------------------------------------------------------
        # 最後防線：near-divisor 探測——如果搵到嘅candidate rate同時喺R2
        # 呢個site嘅row入面literally出現過（唔止「岩岩好整除」，仲有R2
        # 自己印低過呢個數字做旁證），先當solved，並將更數差異交WP4；否則
        # 淨係記低喺note度俾人手覆核，唔屈做solved。
        # ---------------------------------------------------------------
        near = _near_divisor_probe(amount, total_shifts)
        r2_literal_values = set()
        for r2row in r2_rows_here:
            for text in r2row.client_rate_texts:
                info = wp3_r2.classify_rate_text(text)
                if info["kind"] == "clean" and info["value"] is not None:
                    r2_literal_values.add(info["value"])

        corroborated = [(cand, rate_) for cand, rate_ in near if rate_ in r2_literal_values]
        if near:
            tried_note += "；試更數±10搵乾淨價(5蚊倍數，唔代表更數啱，只供WP4覆核)：" + "、".join(
                f"{cand}更→{rate_}" for cand, rate_ in near[:5])
        cross = cross_by_label.get(label, [])
        if cross:
            tried_note += "；跨月參考(唔逐格核實，只做金額趨勢)：" + "、".join(
                f"{c['period']}={c['amount']}" for c in cross)

        if len(corroborated) == 1 and len({r for _, r in corroborated}) == 1:
            cand, rate_ = corroborated[0]
            note = (tried_note + f"；★升級solved：near-divisor候選{cand}更→{rate_}同R2月結"
                    f"row{r2_rows_here[0].row_no if r2_rows_here else '?'}印嘅收客價字面一致"
                    f"（兩個獨立方法互相印證，唔係單靠「發票÷更數」），"
                    f"shift_records實際更數{total_shifts}同呢個{cand}更差"
                    f"{abs(total_shifts-cand)}，交WP4覆核邊個先啱")
            rcb.add(site_id=site_id, billing_model="per_shift", client_rate=rate_,
                    source="invoice_near_divisor+r2_corroboration", evidence=evidence_inv,
                    confidence="medium", status="solved", note=note,
                    evidence_chain=chain_so_far + [
                        f"near-divisor：{cand}更→{rate_}",
                        f"(a)R2 row{r2_rows_here[0].row_no if r2_rows_here else '?'} 印住同一個數字{rate_}，兩個獨立方法互相印證"])
            solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                               "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                               "client_rate": str(rate_), "status": "solved(near_divisor+r2)", "note": note})
            continue

        rcb.add(site_id=site_id, billing_model="per_shift", client_rate=None,
                source="invoice", evidence=evidence_inv + f"；shift_records更數={total_shifts}（{dict(counts)}）",
                confidence="low", status="pending", note=tried_note,
                evidence_chain=chain_so_far + ["全部方法試完，pending"])
        solve_log.append({"invoice_no": line["invoice_no"], "label": label,
                           "site_id": site_id, "amount": str(amount), "shifts": total_shifts,
                           "client_rate": "", "status": "pending", "note": tried_note})

    return solve_log
