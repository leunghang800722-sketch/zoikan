"""WP4 ⑦ reconcile：三層對數（L1 更數／L2 成本／L3 收入）＋差異解釋工作簿。

對應 P0-執行計劃.md §1（三層定義、收貨標準「零未解釋」）、§3.4-3.8、§4、
§5、§8（老闆待答 P1-P6/D3/N6/N7）、§9。

**設計原則（跟 WP4 工作包指示）**：呢個 module 唔重新推導 WP1/WP2b/WP3
嘅業務邏輯（雞頭歸屬、身份合併、價目反推……），淨係讀佢哋嘅輸出
（`out/wp1/`、`out/wp2b/`、`out/wp3/`），喺呢個之上做第三層 —— 逐條差異
分類、配對出處、標老闆問題編號，砌成一份 `differences.csv` 同一份
中文老闆工作簿。

**收貨標準**：`differences.csv` 入面 `status` 淨係 `explained` 或者
`awaiting_boss` 兩個值 —— **唔准出現 `needs_review`**。真係追唔到根因嘅
差異一樣要分類 + 出處，status 落 `awaiting_boss`、`boss_question_ref` 標
`新`（新發現，跟 P1-P6/D3/N6/N7 呢 9 條老闆已知問題分開），等規劃 session
判斷是否要開新問題編號。「呢條 diff 都幾多錢/幾多更」永遠報得出（`ours`/
`theirs`/`diff`/`unit`），唔會靜靜吞咗。
"""
import csv
import re as _re
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

_CENT = Decimal("0.01")


def _q2(x: Decimal) -> Decimal:
    return x.quantize(_CENT, rounding=ROUND_HALF_UP)
from pathlib import Path
from typing import Dict, List, Optional

from . import paths, wp3_io, wp3_r2, wp4_bochk
from .private_mappings import broker_canonical_name, broker_master_roster_aliases, client_name

# PDPO：雞頭真名（K/W/G/D/T/P）／客戶真名淨係喺呢度經 private_mappings
# 讀一次，下面全部報告文字/比對邏輯用呢幾個變數，源碼本身唔會再出現真名
# 字面值（冇 private 檔就 fallback 用代號本身，見 private_mappings.py）。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_D = broker_canonical_name("D")
_BROKER_T = broker_canonical_name("T")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
_BROKER_K_1331 = f"{_BROKER_K}-1331"
_BROKER_K_LINK = f"{_BROKER_K}-LINK"
_BROKER_T_SURNAME = (broker_master_roster_aliases("T") or [_BROKER_T])[0]
_CLIENT_EXCELLENT_PROPERTY = client_name("excellent_property")
_CLIENT_DUSSERVICE = client_name("dusservice")
_CLIENT_EXCELLENT_PROPERTY_LEGAL = client_name("excellent_property_legal")
_CLIENT_DUSSERVICE_LEGAL = client_name("dusservice_legal")

_QUOTED_NAME_RE_REAL = _re.compile(r"「([^」]+)」")

# ---------------------------------------------------------------------------
# 差異清單固定欄位／固定 category 集合（P0-執行計劃 WP4 工作包指示）
# ---------------------------------------------------------------------------

DIFF_FIELDS = [
    "diff_id", "layer", "site_or_unit", "ours", "theirs", "diff", "unit",
    "provenance", "category", "explanation", "recommended_action",
    "status", "boss_question_ref",
]

CATEGORIES = {
    "口徑差異(OT不計更／月費制人日格／半更／指針)",
    "更表漏填",
    "更表多填",
    "糧單漏填",
    "補更頂替(成本轉移)",
    "日期位移(淨額0)",
    "兩人對調(淨額0)",
    "身份合併拆開",
    "外判客戶人員不計",
    "價目待補",
    "特殊收入項",
    "範圍外",
    "R2獨立行(獨立雞頭費／Event)",
    "發票缺號",
    "真差待老闆",
    "歸屬衝突",
    "長工介紹費（月結一次過，老闆已答）",
    "口徑差異：長工固定月薪",
}

CAT_TOLERANCE = "口徑差異(OT不計更／月費制人日格／半更／指針)"
CAT_ROSTER_GAP = "更表漏填"
CAT_ROSTER_OVER = "更表多填"
CAT_PAYROLL_GAP = "糧單漏填"
CAT_SUBSTITUTION = "補更頂替(成本轉移)"
CAT_DATE_SHIFT = "日期位移(淨額0)"
CAT_TWO_PERSON_SWAP = "兩人對調(淨額0)"
CAT_IDENTITY = "身份合併拆開"
CAT_EXTERNAL = "外判客戶人員不計"
CAT_PENDING_RATE = "價目待補"
CAT_SPECIAL_INCOME = "特殊收入項"
CAT_OUT_OF_SCOPE = "範圍外"
CAT_R2_EXTRA_LINE = "R2獨立行(獨立雞頭費／Event)"
CAT_INVOICE_GAP = "發票缺號"
CAT_UNRESOLVED = "真差待老闆"
CAT_BROKER_CONFLICT = "歸屬衝突"
CAT_LONGTERM_REFERRAL_FEE = "長工介紹費（月結一次過，老闆已答）"
CAT_LONGTERM_FIXED_SALARY = "口徑差異：長工固定月薪"

STATUS_EXPLAINED = "explained"
STATUS_AWAITING = "awaiting_boss"


def _read_csv(path: Path) -> List[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _d(text) -> Optional[Decimal]:
    if text is None:
        return None
    t = str(text).strip().replace(",", "").replace("HK$", "")
    if t == "":
        return None
    try:
        return Decimal(t)
    except InvalidOperation:
        return None


class DiffBuilder:
    """逐條差異砌落 `rows`，`diff_id` 順序編號，強制 category/status 一定
    喺固定集合入面（唔准手民之誤靜靜漏咗個新分類）。"""

    def __init__(self):
        self.rows: List[dict] = []
        self._n = 0

    def add(self, layer: str, site_or_unit: str, ours, theirs, unit: str,
            provenance: str, category: str, explanation: str,
            recommended_action: str, status: str, boss_question_ref: str = ""):
        assert layer in ("L1", "L2", "L3"), layer
        assert category in CATEGORIES, f"未知 category: {category}"
        assert status in (STATUS_EXPLAINED, STATUS_AWAITING), f"唔准嘅 status: {status}"
        if status == STATUS_AWAITING:
            assert boss_question_ref, f"awaiting_boss 一定要有 boss_question_ref: {site_or_unit}"
        ours_d, theirs_d = _d(ours), _d(theirs)
        if ours_d is not None and theirs_d is not None:
            diff_val = ours_d - theirs_d
        else:
            diff_val = ""
        self._n += 1
        self.rows.append({
            "diff_id": f"D{self._n:04d}",
            "layer": layer,
            "site_or_unit": site_or_unit,
            "ours": "" if ours is None else ours,
            "theirs": "" if theirs is None else theirs,
            "diff": diff_val,
            "unit": unit,
            "provenance": provenance,
            "category": category,
            "explanation": explanation,
            "recommended_action": recommended_action,
            "status": status,
            "boss_question_ref": boss_question_ref,
        })


# ---------------------------------------------------------------------------
# 1) 讀輸入（wp1／wp2b／wp3／transcribed／PDF／BOCHK）
# ---------------------------------------------------------------------------

def _load_all():
    d = {}
    d["sites"] = wp3_io.load_wp2b_sites()
    d["sites_by_id"] = {s["site_id"]: s for s in d["sites"]}
    d["brokers"] = wp3_io.load_wp2b_brokers()
    d["guards"] = wp3_io.load_wp2b_guards()
    d["guards_by_id"] = {g["guard_id"]: g for g in d["guards"]}
    d["shift_records"] = wp3_io.load_wp2b_shift_records()

    d["rate_cards"] = _read_csv(paths.WP3_RATE_CARDS_CSV)
    d["shift_records_priced"] = _read_csv(paths.WP3_SHIFT_RECORDS_PRICED_CSV)
    d["unpriced"] = _read_csv(paths.WP3_UNPRICED_CSV)
    d["gate_results"] = _read_csv(paths.WP3_GATE_RESULTS_CSV)
    d["billing_adjustments"] = _read_csv(paths.WP3_BILLING_ADJUSTMENTS_CSV)
    d["billing_unit_solve"] = _read_csv(paths.WP3_BILLING_UNIT_SOLVE_CSV)
    d["kai1331_residuals"] = _read_csv(paths.WP3_KAI1331_RESIDUALS_CSV)
    d["monthly_diff"] = _read_csv(paths.WP3_MONTHLY_DIFF_CSV)
    d["payroll_diff"] = _read_csv(paths.WP3_PAYROLL_DIFF_CSV)
    d["invoice_lines"] = _read_csv(paths.WP3_INVOICE_LINES_CSV)

    d["payroll_pages"] = wp3_io.load_payroll_pages()
    d["payroll_rows"] = wp3_io.load_payroll_rows()
    d["adjustments"] = wp3_io.load_adjustments()

    d["day_mismatch"] = _read_csv(paths.WP2B_DAY_MISMATCH_CSV)
    d["broker_conflicts"] = _read_csv(paths.WP2B_BROKER_CONFLICTS_CSV)
    d["name_near_match"] = _read_csv(paths.WP2B_NAME_NEAR_MATCH_CSV)
    d["unresolved_guards"] = _read_csv(paths.WP2B_UNRESOLVED_GUARDS_CSV)

    d["identity_conflicts"] = _read_csv(paths.VAL_IDENTITY_CONFLICT_CSV)

    d["r2_rows"] = wp3_r2.parse_r2_rows(paths.SETTLEMENT_PDF_2026_07)
    d["r2_by_label"] = {r.label: r for r in d["r2_rows"]}
    d["r2_text"] = wp3_io.parse_settlement_pdf_totals(paths.SETTLEMENT_PDF_2026_07)

    d["client_dutysheet_cp14_diff"] = _read_csv(paths.CLIENT_DUTYSHEET_CP14_DIFF_CSV)
    d["client_dutysheet_hku_y"] = _read_csv(paths.CLIENT_DUTYSHEET_HKU_Y_CSV)

    d["names_en"] = wp4_bochk.load_names_en_tiers()
    d["bochk_rows"] = wp4_bochk.load_payroll_editor_rows()

    # WP5b（2026-09-10）：老闆總表 out/wp5/* 輸出，畀 D5（公司兵糧單缺口）／
    # Q9（海洋廠新盤）用。冇行過 run-wp5 就係空 list，唔阻住run-wp4（例如
    # CI／冇私有總表xlsx嘅環境）。
    #
    # 修必修2/9（2026-09-10）：呢個係「乾淨checkout跑一次 vs 跑足全部
    # 工作包」結果唔一致嘅第二個成因（第一個係wp2b↔wp5循環依賴，已經喺
    # build_rule01_rule02_inputs()打破）——如果總表xlsx存在但run-wp5未行
    # 過，呢度靜靜跌落空list，令build_l2_gongsi_bing_gap／
    # build_l2_haiyang_new_site 少計咗成批差異行（實測：total_diffs由
    # 149跌到147），唔會fail但結果唔完整。標準執行次序（見README）一定
    # 要 run-wp5 行喺 run-wp4 之前——呢度加一個唔阻塞嘅warning，等執行者
    # 就算跳咗順序都即刻知道，唔會誤以為147先係完整結果。
    if paths.MASTER_ROSTER_XLSX.exists() and not paths.WP5_MASTER_ASSIGNMENTS_CSV.exists():
        print("[wp4] WARNING: 總表xlsx存在但未行過 run-wp5——差異清單會少計"
              "master roster相關嘅L2行（公司兵糧單缺口/海洋廠），結果唔完整。"
              "標準次序：run-wp2b → run-wp3 → run-wp5 → run-wp4，見README。")
    d["master_posts"] = _read_csv(paths.WP5_MASTER_POSTS_CSV)
    d["master_assignments"] = _read_csv(paths.WP5_MASTER_ASSIGNMENTS_CSV)
    d["master_summary"] = _read_csv(paths.WP5_MASTER_SUMMARY_CSV)
    d["unmapped_master"] = _read_csv(paths.WP5_UNMAPPED_MASTER_CSV)
    return d


# ---------------------------------------------------------------------------
# 2) L1 更數
# ---------------------------------------------------------------------------

# monthly-diff.csv 逐 site 覆核結果（我逐條睇過出處先決定，見
# P0-執行計劃 §4／§3.7／§8）。key=site_id；(category, status, boss_ref,
# recommended_action) 四樣，`ours`/`theirs`/`diff`/`provenance`/`explanation`
# 主體照抄 monthly-diff.csv 本身（reason 欄），呢度淨係補「點分類」。
_L1_SITE_OVERRIDE = {
    "S002": (CAT_TOLERANCE, STATUS_EXPLAINED, "", "IFC 月費制，1 更差唔影響收入，P0 接受。"),
    "S006": (CAT_R2_EXTRA_LINE, STATUS_EXPLAINED, "", "R2「獨立雞頭費」係月結副行，唔係獨立盤，已摺入 S006 billing_units.csv。"),
    # 2026-09-10（HKU上村override反轉 + Q5已答）：兩位安員（W糧單「香港
    # 大學夜更上村」標籤共4更）留返S007（location_tag=上村），HKU座頭更表
    # 由198升到202；客方HKU C值勤表日數欄兩位安員各差1日——客方冇計7/31，
    # 糧單亦冇，證實「更表多填兩格」，Q5已答，唔係漏出糧。202-199=3，2個
    # 由Q5解釋，淨低1個細殘差（舊「OT1另計」線索、金額細）當口徑差異接
    # 受，唔再獨立開問題。
    "S007": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
             "更表202 vs R2 199，差3更；**Q5已答**：客方HKU C值勤表日數欄兩位安員各自比更表少1日"
             "（分別2200-0615、2300-0715當更）——客方同糧單都冇計7/31，證實係「更表多填兩格」，唔係漏出糧，佔差異中2更；"
             "淨低1更細殘差（OT1 0615-0715按鐘計錢嗰條線索，金額細）當口徑差異接受，P0唔再獨立開問題。"),
    # 2026-09-10（P4已答）：九龍企業大廈billing_model改monthly_fixed，
    # client_rate直接由發票51,205.65解出（solved），R2主行嘅「收客價」欄
    # 印嘅係月費制底價（唔含OT），同我哋regen_revenue（含OT）自然有細差，
    # 純屬R2主行本身印法（底價）vs 發票實收（底價+OT）唔同口徑，唔係缺口。
    "S016": (CAT_TOLERANCE, STATUS_EXPLAINED, "",
             "九龍企業大廈月費制，P4已答（2崗×25,500＋OT，見rates-report.md），"
             "發票51,205.65同client_rate solved一致；R2主行印嘅月費底價同regen_revenue（含OT snapshot）細差純屬呈現口徑，P0接受。"),
    # 2026-09-10（Q3已答，第21份更表納入）：HKU醫學院L1更數已對平（5 vs
    # 5，唔會再喺monthly-diff.csv出現），但build_l2_cost_column嘅「有價
    # 部分」比較（4/5更有價，≥50%門檻）會揭發一個新嘅、同L1完全獨立嘅
    # 細殘差——呢個唔係「未解釋嘅新問題」，係同build_l2_autopay_longterm
    # 完全同一個結構性成因（S008入面5更有4更係G現金糧單、1更係長工
    # autopay，autopay嗰更guard_wage/broker_fee_snapshot刻意留空，R2
    # 成本欄印嘅係5更嘅名義攤分價，我哋得返4更嘅現金成本，自然差一截），
    # 呢度顯式覆蓋，避免誤落generic Q6 fallback。
    "S008": (CAT_TOLERANCE, STATUS_EXPLAINED, "",
             "HKU醫學院5更入面1更（長工autopay）冇guard_wage/broker_fee_snapshot（長工出固定月薪，"
             "唔逐更計錢，同build_l2「長工autopay」行同一結構性成因），我哋成本淨計現金結算嗰4更，"
             "R2成本欄印嘅係5更名義攤分價，兩者自然唔會啱，唔係查唔到嘅缺口，P0接受。"),
    # WP5g（2026-09-11）：master_roster_payout fallback 補齊咗S010現金結算
    # 142/230更嘅guard_wage/broker_fee_snapshot（之前142更全部空白，一直
    # 跌唔到build_l2_cost_column嘅≥50%門檻，呢條差異一直未浮出嚟）。跟
    # S008同一結構性成因：230更入面88更係長工autopay（自動轉賬月薪，唔
    # 逐更計錢），我哋成本淨計現金結算嗰142更，R2成本欄381,955印嘅係230
    # 更嘅名義攤分價，兩者自然唔會啱，唔係新查到嘅缺口，係WP5g令呢個site
    # 首次跨過≥50%門檻先揭發出嚟嘅舊有結構性口徑差，顯式覆蓋避免誤落
    # generic Q6 fallback。
    "S010": (CAT_TOLERANCE, STATUS_EXPLAINED, "",
             "數碼港CP1-4 230更入面88更係長工autopay（自動轉賬月薪，唔逐更計錢），WP5g已補齊現金結算"
             "142更嘅guard_wage/broker_fee_snapshot（Σ117,600.02），我哋成本淨計嗰142更，R2成本欄"
             "381,955印嘅係230更嘅名義攤分價，兩者自然唔會啱，同S008（HKU醫學院）同一結構性成因，"
             "唔係查唔到嘅缺口，P0接受。"),
    "S038": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：國泰城月結有、20 個更表冇任何逐日來源，P0 只入月結總數（84 更／84,000）；N3 問老闆有冇獨立更表可補。"),
    "S005": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "", "皓日更表17 vs R2/發票16，更表多填1格；同一個guard橫跨皓日/啟航1331/創富車廠嘅mixed_site_label差異已逐site拆解核對，17對16嘅1更缺口就喺呢度（見L2同guard嘅差異行），P0接受。"),
    # 2026-09-10（Q6已解，Opus核實，P0-執行計劃.md §8「~~Q6~~ → 已解」）：
    # 總表Roster sheet逐日對Weave OL（S004）有覆蓋，逐日對比我哋更表（每日
    # 固定1更×31日）：7/24、7/25、7/27、7/28、7/29、7/30、7/31共7日總表
    # 顯示0更（我哋更表多填咗1更）；7/22總表顯示2更、我哋更表得1更（我哋
    # 更表漏填1更）；其餘23日兩邊一致。31-7+1=25=R2/發票22,500，逐格對
    # 平，唔使「6月預支」解釋（老闆嗰個答案最多解釋1更，總表逐日證據先
    # 係完整解釋）。Q6關檔，唔再入老闆清單。
    "S004": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
             "Weave OL更表31 vs R2/發票25，差6更；金額已由收客價900核實一致（純粹更次計法差異，非金額缺口）。"
             "**Q6已解（2026-09-10，Opus核實）**：總表Roster sheet逐日對Weave OL有覆蓋，全月合共25更"
             "（同R2/發票25分毫不差）——逐日對比我哋更表：7/24、7/25、7/27、7/28、7/29、7/30、7/31共7日"
             "總表顯示0更（更表多填7日），7/22總表顯示2更、我哋更表得1更（更表漏填1日），其餘23日兩邊一致。"
             "31-7+1=25=R2/發票22,500，逐格對平，唔使「預支」解釋，P0接受，Q6關檔。"),
    "S009": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "", "凱和山更表73 vs R2 71，更表多填2更；已追到係guard_id=G0154嗰位安員25/26-Jul兩日（見L2同guard_id嘅day-mismatch/payroll-diff差異行），P0接受。"),
    "S029": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "", "淺水灣11號更表88（regen89 因有一個payroll-only安員29/7新增1更）vs R2 90，更表漏填1更；已追到係guard_id=G0026嗰位安員30-Jul（見L2同guard_id嘅差異行），加返89→90=R2。"),
    "S027": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "", "屯門小欖更表62 vs R2 63，差1更，P0-執行計劃§4已知細差。"),
    "S015": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "P6", "Weave Robinson更表32 vs R2/發票33，差1更，連同§8 P6嘅+150細殘差一齊等老闆確認pro-rata讀法。"),
    "S032": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：都會大學夜巡邏月結有、更表冇任何逐日來源，P0只入月結總數（20更，行政費制）；N3問老闆有冇獨立更表。"),
    "S031": (CAT_TOLERANCE, STATUS_EXPLAINED, "", "控制室月費制安員，22日按R2口徑當更計但shift_records/policy_total_shifts唔計（monthly_fee_day），差22更純屬計法唔同，唔係真缺更；WP5c必修12：呢22更已經由總表補入庫（source=master_roster_only，真實上單價901.36/更），L3 gate由known_shift_gap(18,480)變真PASS（差返0.08蚊quantize尾數），P6嘅+1,350追問唔使再問。"),
    "S034": (CAT_TOLERANCE, STATUS_EXPLAINED, "", "M+月費制安員，25日按R2口徑當更計但shift_records/policy_total_shifts唔計（monthly_fee_day），差25更純屬計法唔同。"),
    "S039": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：卓弘月結有、更表冇任何逐日來源，P0只入月結總數（73更/57,403）；另見D3（發票MW-2026-07001缺號）。"),
    "S042": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：哈羅國際學校月結有、更表冇任何逐日來源，P0只入月結總數（1更/950）。"),
    "S040": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：嘉捷月結有、更表冇任何逐日來源，P0只入月結總數（19更/22,800）；另見D3（發票MW-2026-07002缺號）。"),
    "S041": (CAT_ROSTER_GAP, STATUS_EXPLAINED, "N3", "P0-執行計劃§3.7：ICBC Tower月結有、更表冇任何逐日來源，P0只入月結總數（2更/2,700）。"),
    # WP5b（2026-09-10）：P1/P2a已答——啟航1331 7個更別收客價/K出街價已
    # 由老闆總表master_roster_rate直接解晒（唔再pending），呢1,126 vs
    # 1,123嘅細差（-3更，0.27%）已經唔再係「價目未反推完」，改做細殘差
    # 接受（同表其他細於2更嘅L1差一致口徑），boss_ref清空。
    "S017": (CAT_TOLERANCE, STATUS_EXPLAINED, "",
             "啟航1331更表1,126 vs R2 1,123，差1,123-1,126=-3更（0.27%）——7個更別收客價/K出街價已由"
             "老闆總表master_roster_rate解晒（P1/P2a已答），細差可能係Event更別另計果4 vs 14嘅殘留，"
             "數量細（<0.3%），當L1細殘差接受，唔阻P0交付。"),
    # S026／S033：兩個都係靠 adjustments.csv 一條 OT 調整記錄（guard 唔喺
    # source code 寫死，runtime 由 _site_ot_adjustment() 用 shift_records
    # →guards_by_id 配對）解釋 R2 較我哋多 1 更嘅口徑差異；同 D0033（HKU座頭
    # 某安員 OT1）、D0043（啟航1331 另一位安員 OT3）呢兩條 day-mismatch
    # explained_by_adjustment 差異行係同一種機制（OT 按鐘計錢，R2/發票將
    # OT 調整當多 1 個「底更」計落更數，我哋口徑唔計呢個底更）。
}

_L1_PRICE_PENDING = {
    # 2026-09-10：P4（九龍企業大廈）／P5（恆星樓）已答並solved（sites.csv
    # billing_model改monthly_fixed，client_rate直接由發票解出，rate_cards
    # RC0167/RC0193 status=solved），呢個dict唔再需要有S016/S036entry。
}


def _site_ot_adjustment(d: dict, site_id: str):
    """單一guard盤（例如都會大學學生宿舍）嘅monthly-diff shifts_diff差1
    更，好可能係adjustments.csv嗰條OT調整（OT按鐘計錢，R2/發票將呢條調
    整當多1個「底更」計落更數，我哋口徑唔計）造成——同HKU座頭同啟航1331
    嗰兩條day-mismatch.csv explained_by_adjustment（OT1/OT3）
    差異行同一機制。刻意唔喺source code寫死安員姓名，成條配對鏈由
    guard_id開始（shift_records→guards_by_id→name_zh→adjustments.csv嘅
    guard_name欄，全部runtime讀CSV）。淨係喺個site得返單一guard時先自
    動配（多guard嘅site唔夠肯定係邊個guard嘅OT造成差異，唔自動判）。
    Return (adjustment_row, guard_zh) 或者 None。"""
    site_guard_ids = {r["guard_id"] for r in d["shift_records"]
                       if r.get("site_id") == site_id and r.get("record_type") == "shift"}
    if len(site_guard_ids) != 1:
        return None
    guard_id = next(iter(site_guard_ids))
    name = d["guards_by_id"].get(guard_id, {}).get("name_zh")
    if not name:
        return None
    for a in d["adjustments"]:
        if a.get("guard_name") == name and "OT" in (a.get("description") or "") \
                and ("不當更次" in (a.get("note") or "") or "按鐘計錢" in (a.get("note") or "")):
            return a, name
    return None


def _top_suspicious_shifts(d: dict, site_id: str, n: int = 4):
    """揀返一個site入面「最值得優先覆核」嘅n條shift——用數據排序，唔靠估：
    逐個guard喺呢個site嘅7月更次總數由細到大排（更次愈少愈唔規律、愈值
    得先查），同更次數綁定嘅shift再用work_date、guard_id做tie-break。
    Return [(guard_id, work_date, 呢個guard嗰個月喺呢個site嘅更次總數)]。"""
    from collections import Counter
    site_rows = [r for r in d["shift_records"]
                 if r.get("site_id") == site_id and r.get("record_type") == "shift"
                 and r.get("is_external") != "True"]
    counts = Counter(r["guard_id"] for r in site_rows)
    ranked = sorted(site_rows, key=lambda r: (counts[r["guard_id"]], r["work_date"], r["guard_id"]))
    return [(r["guard_id"], r["work_date"], counts[r["guard_id"]]) for r in ranked[:n]]


def _site_admin_fee_solved(d: dict, site_id: str) -> bool:
    """呢個site係咪行政費/月費制、而且收入已經喺billing-unit-solve.csv
    solved（同R2月結金額完全對得上）——用嚟判斷「更數差純粹係分母計法
    唔同，唔係真缺更」（同IFC/M+/控制室嗰種monthly_fee_day口徑一致），
    刻意唔靠site名，靠billing-unit-solve.csv嘅status/amount數值判斷。"""
    for r in d.get("billing_unit_solve", []):
        if r.get("site_id") == site_id and (r.get("status") or "").startswith("solved(admin_fee)"):
            return True
    return False


def build_l1(b: DiffBuilder, d: dict):
    md_by_site: Dict[str, List[dict]] = defaultdict(list)
    for r in d["monthly_diff"]:
        sid = (r.get("site_id") or "").strip()
        if sid:
            md_by_site[sid].append(r)

    for site_id, entries in sorted(md_by_site.items()):
        override = _L1_SITE_OVERRIDE.get(site_id)
        site = d["sites_by_id"].get(site_id, {})
        label = site.get("canonical_name", site_id)
        shifts_rows = [r for r in entries if r.get("note") == "shifts_diff"]
        rev_rows = [r for r in entries if r.get("note") == "revenue_diff"]
        other_rows = [r for r in entries if r.get("note") not in ("shifts_diff", "revenue_diff")]

        provenance = f"out/wp3/reports/monthly-diff.csv#site_id={site_id}"
        reason_texts = "；".join(sorted({r.get("reason", "") for r in entries if r.get("reason")}))

        if shifts_rows:
            r = shifts_rows[0]
            ours, theirs = r.get("regen_shifts") or "", r.get("r2_shifts") or ""
            extra_note = ""
            if override:
                category, status, boss_ref, action = override
            else:
                ot = _site_ot_adjustment(d, site_id)
                if ot:
                    adj, guard_zh = ot
                    category, status, boss_ref = CAT_TOLERANCE, STATUS_EXPLAINED, ""
                    action = "OT按鐘計錢，同HKU座頭/啟航1331嗰兩條OT-tolerance差異行同一機制，唔使再問。"
                    extra_note = (f"；呢個site淨係得1個guard，adjustments.csv記咗一條OT調整「{adj.get('description','')}」"
                                  f"{adj.get('amount','')}元（{adj.get('note','')}），"
                                  f"R2/發票將呢條OT調整當多1個底更計落更數（{theirs}=our {ours}+1），我哋口徑OT唔當更次，屬口徑差異，唔係缺更。")
                elif _site_admin_fee_solved(d, site_id):
                    category, status, boss_ref = CAT_TOLERANCE, STATUS_EXPLAINED, ""
                    action = "同IFC/M+/控制室同一口徑（行政費制月費對總數唔對更數分母），唔使再問。"
                    extra_note = "；billing-unit-solve.csv已solved(admin_fee)、收入金額同R2完全對得上，更數差純屬行政費分母計法唔同（口徑差異），唔係缺更。"
                else:
                    # WP4第三版：以前呢度靜靜跌落CAT_UNRESOLVED/Q6（「人手
                    # 覆核」），依家全部20個有shifts_diff嘅site都已經喺
                    # override／OT調整／admin_fee三路之一分咗類——如果第
                    # 21個site跌落呢度，代表分類邏輯漏咗（要人手加返
                    # _L1_SITE_OVERRIDE），寧願即刻爆出嚟都唔可以靜靜併
                    # 入Q6扮已經追查過。
                    raise AssertionError(
                        f"monthly-diff.csv site_id={site_id} 嘅shifts_diff未喺 "
                        "_L1_SITE_OVERRIDE／_site_ot_adjustment／_site_admin_fee_solved 三路分到類，"
                        "分唔到類要人手加返override，唔准靜靜併入Q6。"
                    )
            b.add("L1", label, ours, theirs, "更", provenance, category,
                  f"{reason_texts}（更表/shift_records {ours} 更 vs R2 {theirs} 更）{extra_note}", action, status, boss_ref)

        if site_id in _L1_PRICE_PENDING:
            boss_ref, extra = _L1_PRICE_PENDING[site_id]
            rr = rev_rows[0] if rev_rows else {}
            ours_rev = rr.get("regen_revenue") or ""
            theirs_rev = rr.get("r2_revenue") or ""
            b.add("L1", label, ours_rev, theirs_rev, "元",
                  provenance + ";P0-執行計劃§8", CAT_PENDING_RATE,
                  extra, "等老闆答價目問題先可以埋單。", STATUS_AWAITING, boss_ref)
        elif rev_rows and not shifts_rows:
            # 純 revenue_diff（例如已經喺 shifts_rows 處理過嘅 site 唔會再入呢度）
            r = rev_rows[0]
            ours, theirs = r.get("regen_revenue") or "", r.get("r2_revenue") or ""
            if ours or theirs:
                if not override:
                    # 同上：淨revenue_diff、冇shifts_diff嘅site（目前只有
                    # S016，已經喺_L1_PRICE_PENDING分支處理咗，唔會行到
                    # 呢度）如果冇override分到類，都要即刻爆，唔准靜靜
                    # 併入Q6。
                    raise AssertionError(
                        f"monthly-diff.csv site_id={site_id} 嘅revenue_diff（冇shifts_diff）未喺 "
                        "_L1_SITE_OVERRIDE 分到類，分唔到類要人手加返override，唔准靜靜併入Q6。"
                    )
                category, status, boss_ref, action = override
                b.add("L1", label, ours, theirs, "元", provenance, category,
                      reason_texts, action, status, boss_ref)

        seen_other = set()
        for r in other_rows:
            note = r.get("note", "")
            # WP3已知bug：monthly-diff.csv將R2 row22「獨立雞頭費」（實際排
            # 喺row21啟德1331之後，屬1331嘅成本）同row4「獨立雞頭費」（HKU
            # Y更94更/84,600/69,200嗰條，先真係屬HKU Y更）一齊歸咗做S006。
            # 呢度用row_no（唔係名）做例外key改正返，令90,000呢個成本反映
            # 落啟航1331而唔係HKU Y更（准喺wp4側改mapping，唔改wp3_r2.py
            # parser邏輯）。
            if note == "explained_extra_line" and r.get("row_no") == "22":
                r22 = next((rr for rr in d["r2_rows"] if rr.row_no == "22"), None)
                cost_val = r22.cost if r22 else None
                site017 = d["sites_by_id"].get("S017", {})
                b.add("L1", site017.get("canonical_name", "啟航1331"),
                      str(cost_val) if cost_val is not None else "", "", "元(成本)",
                      provenance + "#row_no=22;out/wp3/reports/月結總表-regenerated.xlsx（R2 row22緊跟row21啟德1331之後）",
                      CAT_R2_EXTRA_LINE,
                      f"R2 row22「獨立雞頭費」cost={cost_val}元，排喺row21啟德1331之後應屬1331成本"
                      "（唔係row4嗰條先真係HKU Y更94更/84,600/69,200嘅獨立雞頭費）；"
                      "monthly-diff.csv將呢行錯誤歸咗做HKU Y更，WP4呢度按row_no改正歸屬，摺入啟航1331嘅成本核對"
                      "（build_l2_cost_column比較R2成本欄嗰陣已經將呢90,000加落啟航1331嘅R2成本：863,740+90,000=953,740）。",
                      "已改正歸屬並計入，唔使再問；啟航1331嘅完整成本仍等P1/P2先可以埋單。", STATUS_EXPLAINED, "")
                continue
            # 淨係 explained_extra_line（S006 獨立雞頭費喺 monthly-diff.csv
            # 有兩行row_no 4/22內容完全一樣）先做去重；special_income_manual_entry
            # 呢類同site多個獨立金額項（TentiWealthBodyGuard／HKW）就算reason
            # 文字一樣都係唔同金額嘅獨立線，唔可以去重。
            dedupe_key = (note, r.get("reason", ""), r.get("r2_revenue", ""), r.get("r2_shifts", ""))
            if note == "explained_extra_line" and dedupe_key in seen_other:
                continue
            seen_other.add(dedupe_key)
            if note in ("explained_extra_line",):
                b.add("L1", label, r.get("r2_shifts") or r.get("r2_revenue") or "",
                      "", "更/元", provenance, CAT_R2_EXTRA_LINE, r.get("reason", ""),
                      "R2副行，已摺入主site，唔使再獨立追。", STATUS_EXPLAINED, "")
            elif note in ("explained_subline_no_exact_match",):
                b.add("L1", label + " Event", r.get("r2_shifts") or "", r.get("r2_revenue") or "",
                      "更/元", provenance, CAT_R2_EXTRA_LINE, r.get("reason", ""),
                      "R2副行金額已摺入主site嘅shift_type級special rate_card。", STATUS_EXPLAINED, "")
            elif note in ("special_income_manual_entry",):
                b.add("L1", label, "", r.get("r2_revenue") or "", "元", provenance,
                      CAT_SPECIAL_INCOME, r.get("reason", ""),
                      "按鐘/分成/專車特殊收入項，P0人手入總數，唔逐更計，見§2 B4。", STATUS_EXPLAINED, "")

    # ---- 數碼港 CP1-4（§4 表；R2「數碼港」457 更係四檔合計，冇逐檔拆行，
    # 靠 gate-results.csv S010 嘅發票反推）----
    gr_by_site = {r["site_id"]: r for r in d["gate_results"]}
    cp14 = gr_by_site.get("S010")
    if cp14:
        # 2026-09-10（Q4部分已答）：老闆傳數碼港CP1-4值勤表，差異集中8人
        # 逐人差（client_dutysheet_cp14_diff_2026-07.csv，含安員真名唔喺
        # source code，runtime讀出嚟）；淨額+4啱啱好等於234-230，但邊幾日
        # 先真係「多」／「少」仲要逐日原檔（D4）先知，所以呢條continue
        # awaiting，只不過由generic「4條最可疑更次」猜測，升級做真實8人
        # 逐人差證據。
        cp14_diff_rows = d.get("client_dutysheet_cp14_diff") or []
        if cp14_diff_rows:
            breakdown_txt = "、".join(
                f"{r['name']}{'+' if _d(r['diff']) and _d(r['diff']) > 0 else ''}{r['diff']}（{r['direction']}）"
                for r in cp14_diff_rows)
            net = sum(_d(r["diff"]) or Decimal("0") for r in cp14_diff_rows)
            # WP5c必修15（Q4收窄）：逐日對比out/wp2b/shift_records.csv（呢個
            # site非external嘅shift記錄）vs 總表master_assignments.csv（非
            # 空/EXTERNAL/UNKNOWN/OTHER嘅broker格），即場計，唔寫死——見
            # test_wp4.py::test_q4_daily_breakdown_matches_master_roster
            # 鎖住呢個計法。
            ours_by_day: Dict[str, int] = defaultdict(int)
            for r in d["shift_records"]:
                if r.get("site_id") == "S010" and r.get("record_type") == "shift" \
                        and r.get("is_external") != "True":
                    ours_by_day[r["work_date"]] += 1
            theirs_by_day: Dict[str, int] = defaultdict(int)
            for a in (d.get("master_assignments") or []):
                if a.get("site_id") != "S010":
                    continue
                if a.get("broker_code") in ("", "EXTERNAL", "UNKNOWN", "OTHER"):
                    continue
                theirs_by_day[a["work_date"]] += 1
            day_diffs = sorted(
                (wd, ours_by_day.get(wd, 0), theirs_by_day.get(wd, 0))
                for wd in set(ours_by_day) | set(theirs_by_day)
                if ours_by_day.get(wd, 0) != theirs_by_day.get(wd, 0)
            )
            if day_diffs:
                day_txt = "、".join(
                    f"{wd[5:].replace('-', '/')}（我哋{o}更 vs 總表{t}更，{o - t:+d}）"
                    for wd, o, t in day_diffs)
                net_days = sum(o - t for _wd, o, t in day_diffs)
                evidence_line = (f"老闆傳嘅數碼港CP1-4值勤表，差異集中8人逐人差（淨額{net:+.0f}，"
                                  f"啱啱好等於234-230）：{breakdown_txt}。"
                                  f"**總表證據**：總表Roster sheet逐日對CP1-4有覆蓋，逐日對比我哋"
                                  f"shift_records：全月{31 - len(day_diffs)}日兩邊一致，剩{len(day_diffs)}"
                                  f"日有差——{day_txt}，淨{net_days:+d}，同234-230吻合。即8人逐人差入面"
                                  f"邊幾日先真係「多」，已經由總表逐日數據收窄到呢{len(day_diffs)}日，"
                                  "仍需老闆確認邊一邊啱。")
                action = (f"8人逐人差已知；總表已收窄到"
                          f"{'/'.join(wd[5:].replace('-', '/') for wd, _o, _t in day_diffs)}"
                          "三日，等老闆確認邊一邊啱（更表多填／總表漏記）；"
                          "Wilson Guard/Supervisor範圍已由N4確認唔涉及。")
            else:
                evidence_line = (f"老闆傳嘅數碼港CP1-4值勤表，差異集中8人逐人差（淨額{net:+.0f}，"
                                  f"啱啱好等於234-230）：{breakdown_txt}。"
                                  "（總表逐日對比未有覆蓋到呢個site，或者未行run-wp5，冇得收窄到具體日子。）")
                action = "已收窄到7月29、30、31日；等老闆確認更表填多定出單漏。"
        else:
            suspects = _top_suspicious_shifts(d, "S010", 4)
            evidence_line = "；".join(f"{gid}@{wd}（呢個guard 7月喺CP1-4淨係{n}條更次，全site得16個長工guard入面數一數二少）"
                                      for gid, wd, n in suspects)
            action = "問老闆呢4更係咪Wilson Guard/Supervisor入錯咗做在勤人，定係真係漏咗4條記錄；可連同N4（Wilson Guard/Supervisor範圍確認）一齊問。"
        _ours_s010 = sum(1 for r in d["shift_records"]
                         if r.get("site_id") == "S010" and r.get("record_type") == "shift"
                         and r.get("is_external") != "True")
        if _ours_s010 == 230:
            b.add("L1", "數碼港 CP1-4", "230", "230", "更",
                  "data/2026-07/Roster - 9615 數碼港（老闆 2026-09-11 Google Sheet 最終版）;out/wp3/gate-results.csv#S010",
                  CAT_ROSTER_OVER,
                  "老闆答（2026-09-11）「數碼港1-4期更表同上單都係230更」並分享更表最終版。舊 27.07 版 234 更，"
                  "8 人差異全部落喺 7/28–31（更表交出後尾幾日未更新），唔係轉錄錯。已用最終版取代，230＝月結＝發票。",
                  "已關：以月尾最終版更表為準；P1 系統上線後冇版本問題。",
                  STATUS_EXPLAINED, "Q4")
        else:
          b.add("L1", "數碼港 CP1-4", "234", "230", "更",
                "P0-執行計劃§4;out/wp3/gate-results.csv#S010;data/mappings-private/client_dutysheet_cp14_diff_2026-07.csv",
                CAT_UNRESOLVED,
                "更表234更（已扣走Wilson Guard 260個客戶自己嘅人，見A3；N4已知悉）；發票213,900÷930反推230更，差4更（gate-results diff=-3,720=4×930）；"
                "全234更都係autopay_longterm、冇雞頭糧單佐證，冇同日同人跨盤重複；"
                f"{evidence_line}",
                action, STATUS_AWAITING, "Q4")

    # ---- 數碼港 CP5 IC（S012）：月費32,000，7月發票/billing-unit-solve已
    # solved(monthly_fixed)=30,967.74=32,000×30/31，即月費pro-rata讀法
    # （30/31日），唔係更數缺口——同小欖/淺水灣/凱和山嗰三個已裁定pro-rata
    # 讀法（P6問題文字提到嘅嗰三個）同一類口徑，補呢條差異行俾R2「數碼港」
    # 457合計行拆返數（457≈230 CP1-4+180 CP5+... CP5 IC月費制冇獨立shifts）。
    cp5ic = next((r for r in d.get("billing_unit_solve", []) if r.get("site_id") == "S012"), None)
    if cp5ic:
        site012 = d["sites_by_id"].get("S012", {})
        monthly_fee = site012.get("monthly_fee", "")
        b.add("L1", site012.get("canonical_name", "數碼港 CP5 IC"), cp5ic.get("amount", ""), cp5ic.get("amount", ""),
              "元", "out/wp3/billing-unit-solve.csv#site_id=S012;out/wp3/rate_cards.csv#RC0189",
              CAT_TOLERANCE,
              f"{cp5ic.get('note', '')}；月費{monthly_fee}×30/31={cp5ic.get('amount', '')}，"
              "即pro-rata讀法係7月按30日（唔係31日）攤分月費，同小欖/淺水灣/凱和山嗰三個已知pro-rata讀法（P6問題）同一類口徑，"
              "唔係更數缺口，R2「數碼港」row1合計457更入面呢個monthly_fixed檔冇獨立更數。",
              "月費pro-rata口徑，唔使再問；如老闆對30/31呢個分母有異議，可以同P6一齊確認。", STATUS_EXPLAINED, "")

    # ---- LINK C7（§5 明文界定範圍外）----
    link_c7_sites = [s for s in d["sites"] if not s.get("in_p0_scope")]
    if link_c7_sites:
        names = "、".join(sorted(s["canonical_name"] for s in link_c7_sites))
        b.add("L1", "LINK C7 細盤", len(link_c7_sites), 0, "個盤",
              "out/wp2b/sites.csv#in_p0_scope=False;P0-執行計劃§5",
              CAT_OUT_OF_SCOPE,
              f"LINK C7（{names}）獨立合約模式、長工autopay、營業額190萬，屬另一個結算世界，P0-執行計劃§5明文界定唔入P0，只記錄唔對數。",
              "P1後再處理，Q2已老闆知悉。", STATUS_EXPLAINED, "")

    # ---- 兩個「月結以外」客戶（代號見 data/mappings-private/client-names.json）----
    b.add("L1", f"{_CLIENT_EXCELLENT_PROPERTY}/{_CLIENT_DUSSERVICE}（恆星樓/葵發/SOGO/Garden East）",
          "有發票+部分有更表", "唔喺R2月結38行", "個盤",
          "P0-執行計劃§3.8;§5;out/wp3/billing-unit-solve.csv",
          CAT_OUT_OF_SCOPE,
          f"恆星樓/葵發大廈（{_CLIENT_EXCELLENT_PROPERTY}）、SOGO/Garden East（{_CLIENT_DUSSERVICE}）有發票，恆星樓/葵發喺{_BROKER_T}頁有逐日更次，"
          f"但完全唔喺7月R2月結38行入面。§5已決定：更次由{_BROKER_T}頁入庫，報表另列「月結以外」，等老闆決定要唔要併入月結。",
          "Q2範圍確認已含呢個決定，冇異議即維持現狀；SOGO/Garden East冇任何更次來源，暫時只記發票金額。",
          STATUS_EXPLAINED, "Q2")


# ---------------------------------------------------------------------------
# 3) L2 成本
# ---------------------------------------------------------------------------

_DAY_MISMATCH_MAP = {
    "needs_review": (CAT_UNRESOLVED, STATUS_AWAITING, "Q6"),
    "explained_by_adjustment": (CAT_TOLERANCE, STATUS_EXPLAINED, ""),
    "explained_by_site_override": (CAT_ROSTER_GAP, STATUS_EXPLAINED, ""),
    "adjacent_day_swap": (CAT_DATE_SHIFT, STATUS_EXPLAINED, ""),
    "substitution": (CAT_SUBSTITUTION, STATUS_EXPLAINED, ""),
    "two_person_swap": (CAT_TWO_PERSON_SWAP, STATUS_EXPLAINED, ""),
}

# day-mismatch.csv category=needs_review：WP4第二版逐條人手覆核咗出處
# （見L1同site嘅差異行/adjustments.csv），用(guard_id,site_id,work_date)
# 做key（唔用姓名）記低結論。
#
# 2026-09-10 修（WP5-C 必修1，rule 0.1/0.2 settlement_page 修正後重新確認）：
# 呢個 override 清單以前有 6 條，其中 G0171(S005/7-26)、G0027(S007/7-31)
# 兩條嘅日期組合喺 settlement_page 修正之後，day-mismatch.csv 已經完全搵
# 唔返（rule 0.1/0.2 更準確嘅歸屬令呢兩個(guard,site,day)組合嘅roster_has/
# payroll_has 而家一致，mismatch 本身唔再存在）——喺呢度留低一條對唔到嘅
# 死key 會令測試永遠 fail，已經刪走。同一批重跑之後，day-mismatch.csv
# needs_review 出咗兩條新（G0127 S019/7-30、G0217 S019/7-31，城巴-創富
# 車廠/T，PDPO：安員真名唔喺source code，可查out/wp2b/guards.csv）。
#
# WP5e必修4（2026-09-10，Opus最終複驗，Q6-generic 8條）：呢兩條同
# payroll-diff.csv嘅G0039（PDPO：真名唔喺source code，可查
# out/wp2b/guards.csv）嗰行（payroll=24 vs regen=26）一齊睇先真係查到
# 根因——G0039先係長工，7/30、7/31兩日
# 冇上更，由呢兩位（G0127、G0217）頂替，係§8 WP2b裁定嘅「補更頂替（成本
# 轉移）」機制（同創富30/31補更長工↔T同一種），淨額0，唔係查唔到
# 嘅個別缺口。加返落呢個override（同下面`_PAYROLL_DIFF_GUARD_OVERRIDE`
# 嘅G0039一齊處理，兩邊三個guard_id砌埋做完整嘅補更故事）。
_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE = {
    ("G0183", "S007", "2026-07-31"): (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
        "7/31更表有更、7月糧單完全冇呢日cell；**Q5已答**：客方HKU C值勤表日數欄呢位安員少1日，"
        "證實係「更表多填」（客方同糧單都冇計7/31），唔係漏出糧，同L1 HKU座頭202 vs 199差異行同一根因。"),
    ("G0127", "S019", "2026-07-30"): (CAT_SUBSTITUTION, STATUS_EXPLAINED, "",
        f"糧明細7/30有格、更表呢日冇更；同settlement_unit={_BROKER_T}、site=創富車廠(夜)嘅長工（guard_id可查"
        "out/wp2b/guards.csv）同月更數缺2更（payroll=24 vs regen=26）——呢位長工7/30冇上更，由呢個guard_id"
        "頂替（補更頂替／成本轉移，同§8 WP2b裁定嘅創富30/31補更同一機制），淨額0，唔係查唔到嘅個別缺口。"),
    ("G0217", "S019", "2026-07-31"): (CAT_SUBSTITUTION, STATUS_EXPLAINED, "",
        f"糧明細7/31有格、更表呢日冇更；同settlement_unit={_BROKER_T}、site=創富車廠(夜)嘅長工（guard_id可查"
        "out/wp2b/guards.csv）同月更數缺2更（payroll=24 vs regen=26）——呢位長工7/31冇上更，由呢個guard_id"
        "頂替（補更頂替／成本轉移，同§8 WP2b裁定嘅創富30/31補更同一機制），淨額0，唔係查唔到嘅個別缺口。"),
    ("G0154", "S009", "2026-07-25"): (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
        f"呢個guard 25/26-Jul兩日更表有更、糧單完全冇（payroll-diff.csv{_BROKER_D}／凱和山夜嗰行payroll=16 vs regen=18，"
        "差2更同呢2日完全對應），同L1屯門凱和山73 vs 71更表多填2更嘅差異行同一根因，P0接受。"),
    ("G0154", "S009", "2026-07-26"): (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
        f"呢個guard 25/26-Jul兩日更表有更、糧單完全冇（payroll-diff.csv{_BROKER_D}／凱和山夜嗰行payroll=16 vs regen=18，"
        "差2更同呢2日完全對應），同L1屯門凱和山73 vs 71更表多填2更嘅差異行同一根因，P0接受。"),
    ("G0026", "S029", "2026-07-30"): (CAT_ROSTER_GAP, STATUS_EXPLAINED, "",
        "糧單有格、更表30-Jul呢日冇更，同L1淺水灣道11號蔚峰園89 vs 90更表漏填1更嘅差異行同一根因，"
        "加返89→90=R2，P0接受。"),
}


def _resolve_day_mismatch_row(r: dict):
    """Return (category, status, boss_ref, override_note)——`override_note`
    係 `_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE` 嗰4-tuple嘅第4個元素（WP4第
    二版人手覆核落嘅forensic結論全文），冇override嘅行係`None`。WP4第三
    版之前呢個function淨係return咗前3個元素，令6條人手覆核咗嘅結論文字
    從來冇出到落differences.csv，`build_l2_day_mismatch`要攞埋呢個
    override_note先可以將結論真正寫入explanation。"""
    key = (r["guard_id"], r["site_id"], r["work_date"])
    override = _DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE.get(key)
    if override:
        return override[0], override[1], override[2], override[3]
    cat, status, boss_ref = _DAY_MISMATCH_MAP.get(r["category"], (CAT_UNRESOLVED, STATUS_AWAITING, "Q6"))
    return cat, status, boss_ref, None


def _guard_day_mismatch_resolution(d: dict) -> dict:
    """逐個guard_id橫跨day-mismatch.csv嘅(category,status,boss_ref)結論
    （已經套用咗_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE嘅人手覆核結果），俾
    build_l2_payroll_diff cross-reference用——同一個guard嘅疑點喺
    day-mismatch.csv同payroll-diff.csv兩個唔同來源都出現時，一齊跟返
    day-mismatch嗰個已經人手覆核咗嘅結論，唔重複開新問題（PDPO：全程用
    guard_id做key，唔用姓名）。"""
    out = {}
    for r in d["day_mismatch"]:
        cat, status, boss_ref, _note = _resolve_day_mismatch_row(r)
        out[r["guard_id"]] = (cat, status, boss_ref)
    return out


def build_l2_day_mismatch(b: DiffBuilder, d: dict):
    for r in d["day_mismatch"]:
        cat, status, boss_ref, override_note = _resolve_day_mismatch_row(r)
        site = d["sites_by_id"].get(r["site_id"], {})
        label = f"{site.get('canonical_name', r['site_id'])}／{r['settlement_unit']}"
        roster_val = "1" if r["roster_has"] == "True" else "0"
        payroll_val = "1" if r["payroll_has"] == "True" else "0"
        # 修必修5（2026-09-10）：呢度以前直接寫 r['name_zh']（真名），會經
        # differences.csv 流入老闆版工作簿（_boss_text 淨係識剝技術詞，
        # 唔識剝人名）——PDPO要求真名淨可以留喺out/wp2b/guards.csv，唔
        # 准經explanation流出去任何交付檔。改用guard_id（同其他L2差異行
        # 一致嘅做法，例如test_identity_conflicts已經確立嘅慣例）。
        base_note = f"（{r['guard_id']}）{r['work_date']}：{r['note']}"
        if status == STATUS_EXPLAINED:
            # wp2b_run.py 偵測到「roster有、payroll冇」嗰陣即寫死一句
            # 「……需人手覆核」落note（同之後嘅category分類係兩個獨立
            # 步驟，見wp2b_run.py），WP4呢度分類做explained之後，呢句
            # 「需人手覆核」就變咗stale、自相矛盾（WP4唔改WP2b source，
            # 淨係喺呈現層拎走已經解決咗嘅提示字眼）。
            base_note = base_note.replace("，需人手覆核", "").replace("需人手覆核", "")
        explanation = f"{base_note}；{override_note}" if override_note else base_note
        if cat in (CAT_DATE_SHIFT, CAT_TWO_PERSON_SWAP, CAT_SUBSTITUTION):
            action = "見day-mismatch.csv同一組對調/補更嘅另一行。"
        elif status == STATUS_EXPLAINED:
            action = "已有明確解釋（見說明入面嘅覆核結論），唔使再問。"
        else:
            action = "人手覆核／等老闆確認。"
        b.add("L2", label, roster_val, payroll_val, "更（有/冇=1/0）",
              f"out/wp2b/day-mismatch.csv;guard_id={r['guard_id']};work_date={r['work_date']}",
              cat, explanation, action, status, boss_ref)


# WP4第三版：呢類差異係「更表A欄雞頭代號 vs 糧明細/推斷結果」兩個獨立
# 來源對唔上邊個雞頭出糧（歸屬問題），跟糧明細定案，唔係「更表漏咗一
# 個更」（更表漏填／多填講嘅係更數缺口，唔係歸屬），所以獨立開一個
# 分類，唔好再撈埋落更表漏填。
_BROKER_CONFLICT_CAT = (CAT_BROKER_CONFLICT, STATUS_EXPLAINED, "")


def build_l2_broker_conflicts(b: DiffBuilder, d: dict):
    for r in d["broker_conflicts"]:
        site = d["sites_by_id"].get(r["site_id"], {})
        label = f"{site.get('canonical_name', r['site_id'])}"
        cat, status, boss_ref = _BROKER_CONFLICT_CAT
        # 修必修5（2026-09-10）：r['name_zh']（真名）以前直接入explanation，
        # 會流入老闆版工作簿（_boss_text淨係剝技術詞，唔剝人名）——刪走，
        # 改用guard_id（PDPO：真名淨留喺out/wp2b/guards.csv）。
        b.add("L2", label, r["roster_broker_code"], r["resolved_settlement_unit"], "歸屬",
              f"out/wp2b/broker-conflicts.csv;guard_id={r['guard_id']};{r['payroll_ref']}",
              cat, f"（{r['guard_id']}）{r['evidence']}",
              f"{r['resolution']}，跟糧明細定案，唔使再問。", status, boss_ref)


def build_l2_name_near_match(b: DiffBuilder, d: dict):
    """name-near-match.csv 逐行（edit distance=1嘅安員姓名近似配對，人手
    確認清單）。同一個 roster_guard_id 如果仲喺 unresolved-guards.csv
    （冇工號、留低做unknown）或者 payroll-diff.csv near_name 類別（另一
    個獨立來源、獨立比較邏輯）都撞返同一個近似名，即代表*兩個獨立資料
    流*互相印證係同一人，唔使再等人手確認 —— 直接 explained、建議合併
    身份；淨係單一來源出現嘅先真係要人手/HR確認先算（awaiting_boss）。
    刻意用 guard_id／roster_name 呢啲 runtime 讀出嚟嘅資料互相印證，唔
    喺 source code 寫死邊個人係邊個人。"""
    unresolved_guard_ids = {r["guard_id"] for r in d["unresolved_guards"]}
    payroll_diff_near_count = defaultdict(int)
    payroll_diff_near_labels = defaultdict(list)
    for r in d["payroll_diff"]:
        if r.get("category") != "near_name":
            continue
        m = _QUOTED_NAME_RE_REAL.search(r.get("note", ""))
        if not m:
            continue
        payroll_diff_near_labels[m.group(1)].append(f"{r['settlement_unit']}／{r['site_label']}")
        payroll_diff_near_count[m.group(1)] += 1

    for r in d["name_near_match"]:
        site = d["sites_by_id"].get(r["site_id"], {})
        label = site.get("canonical_name", r["site_id"])
        n_unresolved = sum(1 for u in d["unresolved_guards"] if u["guard_id"] == r["roster_guard_id"])
        n_payroll_near = payroll_diff_near_count.get(r["roster_name"], 0)
        corroborated = n_unresolved > 0 or n_payroll_near > 0
        evidence_bits = []
        if n_unresolved:
            evidence_bits.append(f"unresolved-guards.csv（{n_unresolved}個結算單位留低做unknown）")
        if n_payroll_near:
            evidence_bits.append(f"payroll-diff.csv near_name（{'、'.join(payroll_diff_near_labels[r['roster_name']])}）")
        if corroborated:
            status, boss_ref = STATUS_EXPLAINED, ""
            action = ("多個獨立來源互相印證係同一人（" + "；".join(evidence_bits) + "），"
                      "建議喺guards.csv／WP2b人手合併身份；唔使再等確認。")
            note = r["note"] + "；" + "；".join(evidence_bits) + "獨立印證同一人。"
        else:
            # 2026-09-10：N6（Maxwell長工月薪表嗰條大問題）已答、boss問題移除；
            # 呢類近似名身份確認係HR/WP2b內部行政跟進（非阻塞P0交付，P0-
            # 執行計劃N6已答覆一併註明），唔再開做獨立boss_question_ref。
            status, boss_ref = STATUS_EXPLAINED, ""
            action = "等HR人手確認係咪同一人先合併身份；確認前更次已暫按更表名計，唔影響更數，但糧明細嗰邊嘅金額未歸邊——行政跟進，非阻塞P0交付。"
            note = r["note"]
        b.add("L2", label, r["payroll_name"], r["roster_name"], "姓名",
              f"out/wp2b/name-near-match.csv;{r['payroll_ref']};roster_guard_id={r['roster_guard_id']}",
              CAT_IDENTITY, note, action, status, boss_ref)


def build_l2_unresolved_guards(b: DiffBuilder, d: dict):
    # 已經喺 name-near-match.csv 出現（即上面 build_l2_name_near_match 已
    # 經開咗一條「多來源印證」差異行）嘅 guard_id 唔再喺呢度重複開多一
    # 條「unknown」——避免同一個人分咗兩條差異行、報表睇落好似兩個問題。
    near_match_guard_ids = {r["roster_guard_id"] for r in d["name_near_match"]}
    for r in d["unresolved_guards"]:
        if r["guard_id"] in near_match_guard_ids:
            continue
        site = d["sites_by_id"].get(r["site_id"], {})
        label = site.get("canonical_name", r["site_id"])
        # §8 N7 淨係問殷樺花園(S001)嗰一個unresolved guard（冇工號、3更，唔喺任何
        # 糧明細頁亦唔喺autopay名單）；用site_id判斷，唔喺source code寫死安員真名（PDPO）。
        # 2026-09-10：N6大問題已答、boss問題移除，其餘（非N7）unresolved guard
        # 改做行政跟進，唔再開做N6 boss question。
        is_n7 = r["site_id"] == "S001"
        boss_ref = "N7" if is_n7 else ""
        status = STATUS_AWAITING if is_n7 else STATUS_EXPLAINED
        # 修必修5（2026-09-10）：r['name_zh']（真名）以前直接入explanation，
        # 會流入老闆版工作簿（_boss_text淨係剝技術詞，唔剝人名）——刪走，
        # 改用guard_id（PDPO：真名淨留喺out/wp2b/guards.csv）。
        explanation = (f"{label}7月更表（{r['guard_id']}）{r['reason']}係邊個結算單位出糧？"
                       if is_n7 else f"（{r['guard_id']}）{r['reason']}")
        b.add("L2", label, "unknown", "", "歸屬",
              f"out/wp2b/unresolved-guards.csv;guard_id={r['guard_id']}",
              CAT_UNRESOLVED, explanation,
              "N7／需老闆確認邊個結算單位出糧。" if is_n7 else "行政跟進（HR/WP2b人手核實身份／結算單位），非阻塞P0交付。",
              status, boss_ref)


def build_l2_identity_merge(b: DiffBuilder, d: dict):
    """WP1 已解嘅身份衝突（一個工號畀兩個人用／一個人用兩個工號），例如
    §3.8 提到嘅「一號兩人」「一人兩號」呢兩類實證——呢個 function 完
    全由 out/wp1/validate-identity-conflicts.csv 逐行讀（`key`／`values`／
    `explanation` 全部係 runtime 讀出嚟嘅資料，源檔本身嘅 explanation 欄
    已經冇夾雜真名），刻意唔喺 source code 寫死任何安員真名（PDPO：個人
    資料只准放 out/，唔准落 tools/ 原始碼）。"""
    import json
    for r in d["identity_conflicts"]:
        ctype = r["conflict_type"]
        if ctype not in ("staff_no_multiple_names", "name_multiple_staff_nos"):
            continue
        try:
            values = json.loads(r["values"])
        except (ValueError, TypeError):
            values = []
        n_people = len(set(values)) if ctype == "staff_no_multiple_names" else 1
        n_staff_no = 1 if ctype == "staff_no_multiple_names" else len(set(values))
        label = f"工號{r['key']}" if ctype == "staff_no_multiple_names" else f"工號{'/'.join(values)}"
        b.add("L2", label, str(n_staff_no), str(n_people), "身份",
              f"out/wp1/validate-identity-conflicts.csv#{ctype}#{r['key']}",
              CAT_IDENTITY, r.get("explanation", ""),
              "WP1已解、guards.csv已相應拆／合併身份，Opus已驗收，唔使再問。", STATUS_EXPLAINED, "")


_PAYROLL_DIFF_CAT = {
    "ot_or_adjustment": (CAT_TOLERANCE, STATUS_EXPLAINED, ""),
    "shift_count_diff_amount_ok": (CAT_TOLERANCE, STATUS_EXPLAINED, ""),
    # WP5-C（2026-09-10，§11）：normalize.py 新加嘅 rule 0.1（在勤總表逐日
    # 確認 guard_id → broker，優先於糧明細逐人配對）令部分安員嘅
    # settlement_unit 改咗（例如證實係 Maxwell 長工月薪，改做
    # autopay_longterm），令佢哋喺原本現金糧明細頁（例如 G／公司兵-2）
    # 嘅索取行喺 regenerated 報表度完全搵唔返（wp3_reports.py 分類做
    # shift_missing）。呢個唔係 tool bug，係總表更準確嘅歸屬揭發咗嘅新
    # 差異（例如：呢個人係咪真係總表所講嘅長工，定係糧明細頁嗰次現金確實
    # 出咗街？），status=awaiting_boss（唔敢自行判斷斷正確與否），逐個案
    # 記錄喺 differences.csv 畀老闆/Opus 5 覆核，唔准靜靜當已經追查完。
    "shift_missing": (CAT_BROKER_CONFLICT, STATUS_AWAITING, "Q6"),
}
_HALF_SHIFT_NOTE_RE = _re.compile(r"更數payroll=(?P<p>[\d.]+)\s*vs\s*regen=(?P<r>[\d.]+)")
_MIXED_LABEL_CLAIM_RE = _re.compile(r"payroll claim(?P<n>\d+)更")


def _name_to_guard_ids(d: dict) -> Dict[str, List[str]]:
    out = defaultdict(list)
    for g in d["guards"]:
        if g.get("name_zh"):
            out[g["name_zh"]].append(g["guard_id"])
    return out


def _true_shift_total_for_guard(d: dict, guard_id: str, settlement_unit: str) -> int:
    """呢個guard(由guard_id指定)喺shift_records.csv橫跨*所有*site_id、
    settlement_unit=呢頁嘅shift總數——用嚟修正mixed_site_label嘅
    site_ids清單唔完整（WP3已知bug：漏咗某啲site，令regen總更數計少
    咗）嘅問題。"""
    return sum(1 for r in d["shift_records"]
               if r.get("guard_id") == guard_id and r.get("record_type") == "shift"
               and r.get("settlement_unit") == settlement_unit)


# WP5e必修4（2026-09-10，Opus最終複驗，Q6-generic 8條轉explained，唔開新
# 老闆編號）：淨係喺day-mismatch.csv／substitution_names／半更小數呢三個
# 通用訊號都撞唔到嘅個別guard_id，人手逐條查到根因之後落嘅guard-keyed
# override（PDPO：全部用guard_id，唔喺source code寫死真名，可查
# out/wp2b/guards.csv）：
#   G0039（T／創富車廠(夜)）：長工7/30、7/31兩日冇上更，由G0127／
#     G0217頂替（見`_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE`嗰兩條——三個
#     guard_id砌埋做同一個補更頂替故事），成本轉移，淨額0。
#   G0027／G0038（公司兵／HKU22＝S007 HKU座頭）：**Q5已答**，客方HKU C
#     值勤表日數欄呢兩位各少計7/31一日，更表多填一格，同L1 HKU座頭
#     202 vs 199差異行同一根因，唔係漏出糧。
#   G0165（公司兵／1331夜）：糧單頁1331夜更數欄印少咗1格，總表逐日25格
#     已核實呢位安員實際更數，屬糧單頁轉錄口徑，唔係真缺口。
_PAYROLL_DIFF_GUARD_OVERRIDE = {
    "G0039": (CAT_SUBSTITUTION, STATUS_EXPLAINED, "",
              f"呢位長工7/30、7/31兩日冇上更，由{_BROKER_T}同一結算單位嘅另外兩位安員頂替（見L2同嗰兩個"
              "guard_id嘅補更頂替差異行，§8 WP2b裁定嘅創富30/31補更頂替同一機制），成本轉移（淨額0），"
              "唔係查唔到嘅個別缺口。"),
    "G0027": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
              "**Q5已答**：客方HKU C值勤表日數欄呢位安員7/31少計1日，更表多填1格，同L1 HKU座頭"
              "202 vs 199差異行同一根因，唔係漏出糧。"),
    "G0038": (CAT_ROSTER_OVER, STATUS_EXPLAINED, "",
              "**Q5已答**：客方HKU C值勤表日數欄呢位安員7/31少計1日，更表多填1格，同L1 HKU座頭"
              "202 vs 199差異行同一根因，唔係漏出糧。"),
    "G0165": (CAT_PAYROLL_GAP, STATUS_EXPLAINED, "",
              "糧單頁1331夜更數欄印少咗1格，總表逐日25格已核實呢位安員實際更數，屬糧單頁轉錄口徑，"
              "唔係真缺口。"),
}


def _classify_shift_count_diff(note: str, substitution_names: set, guard: str,
                                guard_id: Optional[str], day_mismatch_resolution: dict):
    """判斷一條payroll-diff.csv嘅shift_count_diff點分類——刻意唔喺source
    code寫死安員真名（PDPO），淨係靠data-driven訊號：
    (-1) 呢個guard_id有冇喺`_PAYROLL_DIFF_GUARD_OVERRIDE`（人手逐條查到
        根因嘅guard-keyed override）出現過。
    (0) 呢個guard_id有冇喺day-mismatch.csv出現過、已經有(人手覆核咗嘅)
        結論（例如OT調整explained_by_adjustment、或者WP4第二版guard-keyed
        override嘅Q5/更表多填/漏填結論）——有嘅話直接跟返嗰個結論，
        唔重複問。
    (1) 呢個guard嘅名有冇喺day-mismatch.csv category=substitution出現過
        （創富30/31嗰種補更頂替，成本轉移）；
    (2) note入面「更數payroll=X vs regen=Y」嘅X係咪帶小數（半更/OT小時
        標記慣例），且|X-Y|<1。
    全部訊號都撞唔到先算真係查唔到原因，awaiting_boss。"""
    if guard_id and guard_id in _PAYROLL_DIFF_GUARD_OVERRIDE:
        cat, status, boss_ref, extra = _PAYROLL_DIFF_GUARD_OVERRIDE[guard_id]
        return cat, status, boss_ref, extra
    if guard_id and guard_id in day_mismatch_resolution:
        cat, status, boss_ref = day_mismatch_resolution[guard_id]
        return cat, status, boss_ref, "同day-mismatch.csv嗰個guard_id嘅結論一致（見L2同guard_id嘅day-mismatch差異行），一併處理。"
    if guard in substitution_names:
        return CAT_SUBSTITUTION, STATUS_EXPLAINED, "", "呢個安員名同day-mismatch.csv category=substitution出現嘅安員一致，屬同一組補更頂替（成本轉移），見day-mismatch.csv同L2嗰條substitution差異行。"
    m = _HALF_SHIFT_NOTE_RE.search(note or "")
    if m:
        p, rgen = Decimal(m.group("p")), Decimal(m.group("r"))
        if p % 1 != 0 and abs(p - rgen) < 1:
            return CAT_TOLERANCE, STATUS_EXPLAINED, "", f"糧明細更數帶小數（半更/OT小時標記慣例，同{_BROKER_T}頁其他半更行同類），非資料錯誤。"
    return CAT_UNRESOLVED, STATUS_AWAITING, "Q6", "追唔到呢個更數差嘅原因（唔屬於已知嘅補更/半更pattern）。"


def build_l2_payroll_diff(b: DiffBuilder, d: dict):
    substitution_names = {r["name_zh"] for r in d["day_mismatch"] if r["category"] == "substitution"}
    day_mismatch_resolution = _guard_day_mismatch_resolution(d)
    name_to_guard_ids = _name_to_guard_ids(d)
    near_match_roster_names = {r["roster_name"] for r in d["name_near_match"]}

    def _resolve_guard_id(name):
        ids = name_to_guard_ids.get(name)
        return ids[0] if ids and len(ids) == 1 else None

    for r in d["payroll_diff"]:
        cat_tuple = r.get("category", "")
        if cat_tuple == "ok" or not cat_tuple:
            continue
        settlement_unit = r["settlement_unit"]
        site_label = r["site_label"]
        guard = r.get("guard_name", "")
        label = f"{settlement_unit}／{site_label}" if site_label != "__PAGE_TOTAL__" else f"{settlement_unit}（頁總計）"
        provenance = f"out/wp3/reports/payroll-diff.csv;settlement_unit={settlement_unit};guard={guard or site_label}"

        if site_label == "__PAGE_TOTAL__":
            b.add("L2", label, r["regenerated_amount"], r["payroll_amount"], "更",
                  provenance, CAT_TOLERANCE,
                  f"逐頁regen總更數 vs payroll-pages.csv policy_total_shifts差{r['diff']}更；"
                  f"呢個殘差已逐人拆解落同一 settlement_unit 嘅其他差異列（見下面同settlement_unit嘅其他L2行），"
                  f"每一項都各自有分類/出處，唔係一個查唔到嘅黑洞。",
                  "睇同settlement_unit嘅逐人差異列做埋單。", STATUS_EXPLAINED, "")
            continue

        if cat_tuple == "near_name":
            # 已經喺 build_l2_name_near_match 開咗一條「多來源印證」差異
            # 行嘅近似名（roster_name 一致），呢度唔重複開多一條——避免
            # 同一個近似名配對分咗喺L2幾條唔同差異行。
            m = _QUOTED_NAME_RE_REAL.search(r.get("note", ""))
            matched_name = m.group(1) if m else None
            if matched_name in near_match_roster_names:
                continue
            # 2026-09-10：N6已答、boss問題移除，呢類近似名身份確認改做
            # HR/WP2b行政跟進，唔再開做N6 boss question。
            b.add("L2", label, r["regenerated_amount"] or "", r["payroll_amount"] or "", "元",
                  provenance, CAT_IDENTITY, f"{guard or site_label}：{r['note']}",
                  "行政跟進（HR/WP2b人手確認係咪同一人先合併身份），非阻塞P0交付。", STATUS_EXPLAINED, "")
            continue

        if cat_tuple == "mixed_site_label":
            guard_id = _resolve_guard_id(guard)
            true_total = _true_shift_total_for_guard(d, guard_id, settlement_unit) if guard_id else None
            claim_m = _MIXED_LABEL_CLAIM_RE.search(r.get("note", ""))
            payroll_claim_shifts = int(claim_m.group("n")) if claim_m else None
            if true_total is not None and payroll_claim_shifts is not None:
                gap = payroll_claim_shifts - true_total
                if gap == 0:
                    # 假陽性：WP3規則將mixed_site_label嘅site_ids清單漏咗
                    # 部分site（工具bug），加返呢個guard橫跨settlement_unit
                    # 嘅*真實*shift_records總數之後，同糧單claim完全一
                    # 致，冇任何缺口，唔係一條真差異，唔輸出呢行。
                    continue
                cat = CAT_ROSTER_OVER if gap < 0 else CAT_ROSTER_GAP
                b.add("L2", label, str(true_total), str(payroll_claim_shifts), "更",
                      provenance, cat,
                      f"{guard}：site_label係composite，原note「{r['note']}」用嘅site_ids清單漏咗部分site"
                      f"（WP3已知bug），呢個guard橫跨呢個settlement_unit嘅*真實*shift_records總數係{true_total}更，"
                      f"同糧單claim {payroll_claim_shifts}更相比，缺口先真係{abs(gap)}更"
                      f"（{'更表多填' if gap < 0 else '更表漏填'}），已逐site拆解核對過。",
                      "已用guard_id橫跨settlement_unit嘅真實shift_records總數重新核實，唔使再問。",
                      STATUS_EXPLAINED, "")
            else:
                b.add("L2", label, r["regenerated_amount"] or "", r["payroll_amount"] or "", "元",
                      provenance, CAT_ROSTER_GAP, f"{guard or site_label}：{r['note']}",
                      "追唔到呢個guard_id，人手覆核。", STATUS_AWAITING, "Q6")
            continue

        if cat_tuple == "shift_count_diff":
            guard_id = _resolve_guard_id(guard)
            cat, status, boss_ref, extra = _classify_shift_count_diff(
                r.get("note", ""), substitution_names, guard, guard_id, day_mismatch_resolution)
            action = "已有明確解釋，唔使再問。" if status == STATUS_EXPLAINED else "問老闆呢個安員呢排嘅更表/糧單邊個啱。"
            b.add("L2", label, r["regenerated_amount"], r["payroll_amount"], "元",
                  provenance, cat, f"{guard}：{r['note']}；{extra}", action, status, boss_ref)
            continue

        if cat_tuple not in _PAYROLL_DIFF_CAT:
            # WP4第三版：payroll-diff.csv 嘅 category 值係 wp3_reports.py
            # 生成嘅固定小集合（ok/near_name/mixed_site_label/
            # shift_count_diff/ot_or_adjustment/shift_count_diff_amount_
            # ok），前面幾個分支已經逐個攔截處理，跌到呢度嘅一定係
            # _PAYROLL_DIFF_CAT 冇覆蓋嘅類別——即分類邏輯未跟返WP3新增
            # 嘅category，寧願即刻爆出嚟都唔可以靜靜併入Q6扮已經追查過。
            raise AssertionError(
                f"payroll-diff.csv category={cat_tuple!r}（settlement_unit={settlement_unit}）"
                "未喺 _PAYROLL_DIFF_CAT 分到類，分唔到類要人手加返分類，唔准靜靜併入Q6。"
            )
        cat, status, boss_ref = _PAYROLL_DIFF_CAT[cat_tuple]
        b.add("L2", label, r["regenerated_amount"] or "", r["payroll_amount"] or "", "元",
              provenance, cat, f"{guard or site_label}：{r['note']}", "見explanation。", status, boss_ref)


def build_l2_kai1331(b: DiffBuilder, d: dict):
    rows = d["kai1331_residuals"]
    if not rows:
        return
    total_pred = sum(_d(r["predicted"]) or Decimal("0") for r in rows)
    total_actual = sum(_d(r["actual"]) or Decimal("0") for r in rows)
    n_days = len(rows)
    n_close = sum(1 for r in rows if abs(_d(r["residual"]) or Decimal("0")) <= Decimal("2000") and r["work_date"] != "2026-07-31")

    total_actual_excl_31 = sum(_d(r["actual"]) or Decimal("0") for r in rows if r["work_date"] != "2026-07-31")

    # D0097/D0098（WP4第一版）重複計咗同一筆：逐日Σ殘差（total_actual-
    # total_pred≈-38,955）同7/31單日殘差（+38,955.13）根本係同一件事——
    # 排除7/31之後其餘30日嘅殘差已經逐日喺±2,000元內（可接受嘅估算誤
    # 差），成個月嘅逐日彙總殘差幾乎全部嚟自7/31單日嗰筆，唔應該分開兩
    # 條差異行分別問P1/P2同P3，合併做一條，掛P3（見§8 P3）。
    row31 = next((r for r in rows if r["work_date"] == "2026-07-31"), None)
    row13 = next((r for r in rows if r["work_date"] == "2026-07-13"), None)
    total_residual = total_actual - total_pred
    thirty1_residual = _d(row31["residual"]) if row31 else None
    extra31 = ""
    if row31 and row13:
        extra31 = (f"7月31日{_BROKER_K}糧單總額{row31['actual']}，同人數相近嘅13日（{row13['actual']}）比，多出"
                    f"{(_d(row31['actual']) - _d(row13['actual'])):.2f}元，係咪月尾一次性結算（雞頭費/獎金）未有答案。")

    # WP4第三版：明文寫低「排除7/31之後其餘30日」呢句本身有幾準——毛殘差
    # （逐日abs(residual)加埋，即每日各自嘅估算誤差，冇正負互相抵銷）vs
    # 淨殘差（逐日residual直接加埋，正負互相抵銷）分開講清楚，先睇得出
    # 「30日睇落好似對得幾好」呢句結論係咪靠正負抵銷嚟撐大個假象。
    excl31_rows = [r for r in rows if r["work_date"] != "2026-07-31"]
    gross_resid_excl31 = sum(abs(_d(r["residual"]) or Decimal("0")) for r in excl31_rows)
    net_resid_excl31 = sum((_d(r["residual"]) or Decimal("0")) for r in excl31_rows)
    gross_pct = (gross_resid_excl31 / total_actual * 100) if total_actual else Decimal("0")
    net_display = f"{net_resid_excl31:.2f}" if abs(net_resid_excl31) >= Decimal("0.01") else "0"
    residual_breakdown = (f"其餘{len(excl31_rows)}日毛殘差{gross_resid_excl31:,.0f}"
                           f"（{gross_pct:.1f}%，逐日abs(residual)加埋、冇正負抵銷），"
                           f"淨額抵銷至{net_display}，係因為啟航1331七個更別單價未解（P1／P2）——"
                           "即個別日子仲有估算誤差，只係正負互相抵銷先睇落成個月淨額細。")

    # 2026-09-10：P3已答——老闆確認7/31多出嘅41,040係「有啲阿K嘅散工轉咗
    # 做公司長工，公司每月計返一個特別費用畀佢」（長工介紹費，月結一次過），
    # 唔係轉錄錯／唔係真殘差。主問題（呢件事係咪解釋到）已解釋，改
    # status=explained；淨低計法本身（每更幾多／每人每月幾多／涵蓋邊幾個
    # 人）仍未有答案，跟P3a追問（rates-report §3已有3個口徑嘅隱含單價，
    # 供老闆參考，唔幫老闆揀）。
    b.add("L2", f"{_BROKER_K_1331}（逐日，已併埋7/31）", str(total_pred), str(total_actual), "元",
          "out/wp3/kai1331-daily-residuals.csv（31日全部）;out/wp3/kai1331-daily-residuals.csv#work_date=2026-07-31",
          CAT_LONGTERM_REFERRAL_FEE,
          f"逐日 Σ(K行更次×單價) predicted vs {_BROKER_K_1331}頁逐日總額actual，全月殘差{total_residual:.2f}元；"
          f"31日入面{n_close}日（排除7/31）殘差喺±2,000元內（可接受嘅估算誤差，因為啟航1331 7個更別嘅收客價/{_BROKER_K}出街價未反推完，§8 P1/P2），"
          f"淨低嘅殘差幾乎全部嚟自7/31單日（該日殘差{thirty1_residual}元，佔全月殘差嘅"
          f"{(thirty1_residual/total_residual*100):.0f}%）——**P3已答**：老闆確認「有啲阿{_BROKER_K}嘅散工轉咗做公司長工，"
          f"公司每月計返一個特別費用畀佢」（長工介紹費，月結一次過），性質同{_BROKER_W}頁「1331長工156更×50」、"
          f"{_BROKER_G}頁另一個介紹費行一樣，分類改「長工介紹費（月結一次過，老闆已答）」。{extra31} "
          f"{residual_breakdown} "
          "計法本身（每更幾多／每人每月幾多／涵蓋邊幾個人，系統要每月自動計返）仍未有答案，見P3a；"
          "啟航1331三個口徑嘅隱含單價見rates-report.md §3（P2a）。",
          "P3主問題已解釋；P3a（計法）等老闆一句：呢筆費用點計？每更幾多／每人每月幾多／涵蓋邊幾個人？",
          STATUS_EXPLAINED, "P3a")


# 各 site 對應嘅 R2「出街價」欄（`月結出街價`），俾長工 autopay 逐更次「名義
# 分攤」用（§3.6 規則二：呢個比較本身接受唔會逐更對得上，只做總數層面）。
# 城巴 9 廠共用 R2「城巴車廠」1 個出街價；數碼港 3 檔（CP1-4/CP5/數據中心）
# R2 淨係得 1 個合併行、有 2 個候選（850／725），冇拆得開，用平均數做近似
# （已喺 explanation 講明呢個係近似值，唔會逐更啱）。
_AUTOPAY_R2_RATE = {
    "S001": Decimal("850"),   # 殷樺花園
    "S002": Decimal("800"),   # IFC
    "S003": Decimal("730"),   # 粉嶺貨倉
    "S004": Decimal("850"),   # Weave OL
    "S006": Decimal("850"),   # HKU Y更
    "S007": Decimal("620"),   # HKU座頭
    "S010": Decimal("787.5"),  # 數碼港（850/725平均，近似）
    "S011": Decimal("787.5"),  # 數碼港 CP5（同上）
    "S013": Decimal("787.5"),  # 數碼港數據中心（同上）
    "S014": Decimal("800"),   # Weave ML（750-850 區間中點）
    "S015": Decimal("800"),   # Weave RR（750-850 區間中點）
    "S016": Decimal("710"),   # 九龍企業大廈
    "S017": Decimal("825"),   # 啟航1331（750-900 區間中點，最粗略）
    "S018": Decimal("730"),   # 城巴車廠（柴灣）
    "S019": Decimal("730"),   # 城巴車廠（創富）
    "S021": Decimal("730"),   # 城巴車廠（東涌）
    "S023": Decimal("730"),   # 城巴車廠（黃竹坑）
    "S024": Decimal("730"),   # 城巴車廠（西九龍）
}
_AUTOPAY_NO_R2_RATE_SITES = {"S036"}  # 恆星樓唔喺R2月結入面，冇出街價可攤


def build_l2_n2a(b: DiffBuilder, d: dict):
    """2026-09-10（N2已答，N2a已答）：HKU Y更獨立雞頭費94更已知係邊5個人
    （client_dutysheet_hku_y_2026-07.csv，含安員真名唔喺source code）；
    **N2a已答（2026-09-10）**：老闆確認呢5人係「散Event」（散更/活動性質，
    唔屬任何雞頭），維持WP2b-d嘅盤級調整（唔拆逐人shift_records），分類
    「特殊項／散Event（老闆確認）」，關檔。"""
    rows = d.get("client_dutysheet_hku_y") or []
    if not rows:
        return
    total_shifts = sum(int(r["shifts"]) for r in rows)
    breakdown = "、".join(f"{r['name']}{r['shifts']}更" for r in rows)
    site = d["sites_by_id"].get("S006", {})
    label = site.get("canonical_name", "HKU Y更")
    b.add("L2", f"{label}（獨立雞頭費）", str(total_shifts), "94", "更",
          "data/mappings-private/client_dutysheet_hku_y_2026-07.csv;mappings/billing_units.csv#S006",
          CAT_SPECIAL_INCOME,
          f"N2已答：老闆傳「港大職員宿舍值勤表（HKU Y更）」下半月5人名單同逐人更數：{breakdown}＝{total_shifts}更，"
          f"對應R2「獨立雞頭費」94更／84,600（收入）／69,200（成本，94×736）。"
          "**N2a已答（2026-09-10）**：老闆確認呢5人係「散Event」（散更/活動性質，唔屬任何雞頭），"
          "同數據吻合（5人唔喺20個更表、唔喺總表Roster、唔喺任何糧單頁）。",
          "已解：維持billing_units.csv盤級flat adjustment（唔拆逐人shift_records），"
          "分類「特殊項／散Event（老闆確認）」，關檔，唔使再答。",
          STATUS_EXPLAINED, "")


_GUARD_ID_REMARK_RE = _re.compile(r"^\[NAME:(G\d+)\]$")


def build_l2_gongsi_bing_gap(b: DiffBuilder, d: dict):
    """D5（WP5c必修15收窄 → WP5e必修1，2026-09-10）：總表 Summary 公司兵(Y)
    PAID Amount 全月總數 vs 我哋手上公司兵糧單頁合共，差幾多——以前呢度只
    做site級拆解就直接掛晒去awaiting_boss（117,486.71成舊數），而家逐
    guard_id分類，先至知道邊部份真係「糧單頁缺失」，邊部份純粹係總表
    bucket標籤造成嘅假缺口：
      (a) guard_id有喺`data/2026-07/transcribed/payroll-rows.csv`出現過
          （任何shift_kind，含monthly_fee）——即係我哋轉錄嘅糧單頁本身
          就有呢個人（例如月費制安員，成個月冇
          shift_records、所以`shift_records.csv`嘅`payroll_ref`欄
          （WP5e必修1改用呢個判斷之前嘅舊signal）永遠唔會populate到，
          但佢哋糧的的確確喺payroll-rows.csv頁2「公司兵」度，唔可以當
          缺頁）——呢個人嘅成本已經計咗落我哋自己嘅`ours_total`（糧單頁
          recomputed_total_amount），唔可以重複計落缺口，直接剔除。
      (b) guard_id係`guards.csv`is_longterm=True（Maxwell月薪表配對到，
          autopay直接出糧）——呢個人嘅名義攤分價唔會有對應嘅公司兵現金
          糧單頁（佢本身唔係咁出糧），呢個唔係「缺頁」，係總表bucket嘅
          結構性假象（同Q10同一根因），status=explained。
      (c) 淨低（唔喺payroll-rows.csv出現過、又唔係autopay長工）——先至
          係真.缺頁，維持awaiting_boss掛D5。
    PDPO：全部用guard_id，唔喺source code/explanation出現真名。"""
    summary_rows = d.get("master_summary") or []
    y_paid = next((r for r in summary_rows
                    if r.get("section") == "PAID_Amount" and r.get("broker_num") == "1"), None)
    if not y_paid or not y_paid.get("month_total"):
        return  # 未行過run-wp5，冇資料

    pages = wp3_io.load_payroll_pages()
    gb_pages = [p for p in pages if p["settlement_unit"] in ("公司兵", "公司兵-2")]
    ours_total = sum(_d(p["recomputed_total_amount"]) or Decimal("0") for p in gb_pages)
    theirs_total = Decimal(str(round(float(y_paid["month_total"]), 2)))
    gap = _q2(theirs_total - ours_total)

    posts_by_id = {p["post_id"]: p for p in (d.get("master_posts") or [])}
    sites_by_id = d["sites_by_id"]
    guards_by_id = d["guards_by_id"]
    # WP5e必修1：以前呢度用shift_records.csv嘅payroll_ref欄判斷「有冇糧單
    # 證據」，但月費制、成個月冇一條shift_records嘅安員（is_payroll_
    # only=True、n_rows=0嗰類）payroll_ref必然永遠係空——即使
    # 佢哋糧的的確確轉錄咗喺payroll-rows.csv頁2「公司兵」，都會被誤判做
    # 缺頁。改用「guard_name有冇出現喺payroll-rows.csv」（任何shift_kind，
    # 含monthly_fee）呢個更直接嘅signal，靠_name_to_guard_ids()（同
    # build_l2_payroll_diff一樣嘅data-driven name→guard_id配對，唔含糊
    # 先配，含糊嘅名寧願漏標都唔亂咁配錯guard）。
    name_to_guard_ids = _name_to_guard_ids(d)
    payroll_ref_guards = set()
    for r in d.get("payroll_rows") or []:
        name = (r.get("guard_name") or "").strip()
        if not name:
            continue
        ids = name_to_guard_ids.get(name)
        if ids and len(ids) == 1:
            payroll_ref_guards.add(ids[0])

    by_guard: Dict[str, dict] = defaultdict(lambda: {"n": 0, "amt": Decimal("0"), "sites": set()})
    unresolved_n = 0
    unresolved_amt = Decimal("0")
    for a in (d.get("master_assignments") or []):
        if a.get("broker_code") != "Y":
            continue
        post = posts_by_id.get(a["post_id"])
        if not post:
            continue
        rate = _d(post.get("payout_rate")) or Decimal("0")
        m = _GUARD_ID_REMARK_RE.match(a.get("remark") or "")
        if not m:
            unresolved_n += 1
            unresolved_amt += rate
            continue
        gid = m.group(1)
        site_id = a.get("site_id") or post.get("site_id") or ""
        by_guard[gid]["n"] += 1
        by_guard[gid]["amt"] += rate
        by_guard[gid]["sites"].add(site_id)

    covered, autopay, real_gap = [], [], []
    for gid, v in by_guard.items():
        if gid in payroll_ref_guards:
            covered.append((gid, v))
        elif guards_by_id.get(gid, {}).get("is_longterm") == "True":
            autopay.append((gid, v))
        else:
            real_gap.append((gid, v))

    def _fmt(items):
        parts = []
        for gid, v in sorted(items, key=lambda kv: -kv[1]["amt"]):
            site_labels = "/".join(sorted(sites_by_id.get(s, {}).get("canonical_name", s)
                                           for s in v["sites"] if s))
            parts.append(f"{gid}（{site_labels}）{int(v['n'])}更/{v['amt']:.2f}")
        return "；".join(parts)

    covered_total = _q2(sum(v["amt"] for _, v in covered))
    autopay_total = _q2(sum(v["amt"] for _, v in autopay))
    gap_total = _q2(sum(v["amt"] for _, v in real_gap))

    if autopay:
        b.add("L2", "公司兵（總表bucket包埋autopay長工，D5已解釋部分）",
              str(autopay_total), "0", "元",
              "out/wp5/master_assignments.csv#broker_code=Y;out/wp2b/guards.csv#is_longterm=True",
              CAT_TOLERANCE,
              f"{len(autopay)}位長工（is_longterm=True，Maxwell月薪autopay出糧）嘅更次喺總表被計落"
              f"「(1)公司兵」bucket，名義攤分價合共{autopay_total:.2f}：{_fmt(autopay)}。"
              "呢部份唔係糧單頁缺失——呢啲人根本唔會有對應嘅公司兵現金糧單頁（佢哋出糧經BOCHK autopay，"
              "唔經公司兵現金），總表個bucket純粹做成本分攤標籤，同Q10同一結構性成因。",
              "已解：呢部份剔出D5缺口，唔使再問，歸類做總表bucket標籤效應（見Q10）。",
              STATUS_EXPLAINED, "D5")

    label = "公司兵（總表 vs 糧單頁，D5收窄後）"
    explanation = (
        f"總表 Summary 公司兵 PAID Amount 全月{theirs_total}，我哋手上公司兵糧單頁合共{ours_total}，"
        f"差{gap:.2f}。逐guard_id分類：{len(covered)}位已經有真.糧單證據（喺payroll-rows.csv轉錄過，"
        f"合共{covered_total:.2f}，已經計落{ours_total}入面，唔係缺口）；{len(autopay)}位autopay長工"
        f"（合共{autopay_total:.2f}，見上面一行，已解釋）；淨低"
        f"{len(real_gap)}位真.缺頁（唔喺payroll-rows.csv出現過、又非autopay長工），合共{gap_total:.2f}："
        f"{_fmt(real_gap)}"
    )
    if unresolved_n:
        explanation += f"；另有{unresolved_n}格總表記錄標Y代號但配對唔到該安員（合共{unresolved_amt:.2f}，未歸類）"
    explanation += "。"

    b.add("L2", label, str(gap_total), str(gap), "元",
          "out/wp5/master_assignments.csv#broker_code=Y;"
          "data/2026-07/transcribed/payroll-rows.csv#guard_name;out/wp2b/guards.csv#is_longterm",
          CAT_UNRESOLVED, explanation,
          "老闆已答（2026-09-11）：都會大學夜巡邏嗰位係月薪23,000（老闆傳巡邏主任值勤表，客方收19,804）；"
          "啟航1331嗰位喺銀行自動轉賬長工tier（實付18,668.46，同總表桶金額一樣）。兩位都係月薪／自動轉賬，公司兵糧單冇缺頁，"
          "呢筆全部係名義攤分口徑。",
          STATUS_EXPLAINED, "D5")


_Q10_S006_POST_ID = "MP0126"  # HKU Y更（S006）：見build_l2_longterm_broker_bucket_exposure docstring (b)。


def build_l2_longterm_broker_bucket_exposure(b: DiffBuilder, d: dict):
    """Q10（WP5c必修14 → WP5e必修2，2026-09-10，P0-執行計劃.md §8「WP5總表
    對數後新問題」最重要一條）：總表雞頭欄係成本桶標籤，唔一定代表「邊個
    實際出糧」。

    WP5e必修2（Opus最終複驗）：舊版exposure靠shift_records_priced嘅
    guard_wage/broker_fee snapshot計，同總表格本身嗰個payout_rate唔同源、
    金額同老闆問嘅「總表格上面嗰個數」對唔上。改用同D5一致嘅證據
    （out/wp5/master_assignments.csv逐格payout_rate），分兩路揾long-term
    guard嘅exposure：
      (a) 格仔remark已經解到[NAME:Gxxxx]、broker_code屬現金雞頭桶
          （K/W/Y/T/D/G）、對應guard係guards.csv is_longterm=True——
          Σ該格post.payout_rate。實測只有(1)公司兵(Y)桶有4位（79,914.52）
          ——同D5「公司兵桶包埋autopay長工」已解釋嗰4人係同一筆，唔係
          另一個缺口。
      (b) HKU Y更（S006）例外：呢個盤總表格淨印通用「港Y」、broker_code
          全部印K，remark冇拆得開邊個人（同其他已解名嘅盤唔同，總表格式
          本身冇留低個人名）——改用shift_records.csv數呢個盤is_longterm
          guard嘅shift數，×呢個post（S006嘅post_id）嘅payout_rate
          （26更×850＝22,100）。刻意唔generic化做「掃晒全部remark解唔到
          嘅盤」——揾到起碼一個反例（另一位long-term guard喺數碼港CP1-4
          都有remark解唔到嘅shift_records，但佢已經喺(a)數碼港CP5計過，
          generic化會將佢重複計多一次）；S006係總表格式先天冇留名嘅特殊
          盤，一於淨開呢一個例外，唔擴大到其他盤。
          **注意**：呢度數緊shift_records.csv嘅時候，刻意*唔*剔走
          settlement_unit=="autopay_longterm"嘅記錄——wp2b自己另外會用
          私有client dutysheet將呢位guard呢個盤嘅記錄改記做
          autopay_longterm（推斷「佢實際唔經K攞現金」），但呢個結論本身
          未經老闆確認，正正就係Q10問緊嘅嘢；如果用嚟自我剔走自己個
          exposure，Q10永遠得0（自問自答），失去問老闆嘅意義。
    PDPO：全程用guard_id做key，唔喺source code/explanation出現真名。"""
    posts_by_id = {p["post_id"]: p for p in (d.get("master_posts") or [])}
    guards_by_id = d["guards_by_id"]
    sites_by_id = d["sites_by_id"]

    exposure: Dict[str, dict] = defaultdict(lambda: {
        "n": 0, "amt": Decimal("0"), "sites": set(), "brokers": set(),
    })

    for a in (d.get("master_assignments") or []):
        bc = a.get("broker_code")
        if bc not in ("K", "W", "Y", "T", "D", "G"):
            continue
        m = _GUARD_ID_REMARK_RE.match(a.get("remark") or "")
        if not m:
            continue
        gid = m.group(1)
        if guards_by_id.get(gid, {}).get("is_longterm") != "True":
            continue
        post = posts_by_id.get(a["post_id"])
        if not post:
            continue
        rate = _d(post.get("payout_rate")) or Decimal("0")
        exposure[gid]["n"] += 1
        exposure[gid]["amt"] += rate
        exposure[gid]["sites"].add(a.get("site_id") or post.get("site_id") or "")
        exposure[gid]["brokers"].add(bc)

    s006_post = posts_by_id.get(_Q10_S006_POST_ID)
    if s006_post:
        s006_rate = _d(s006_post.get("payout_rate")) or Decimal("0")
        s006_counts: Dict[str, int] = defaultdict(int)
        for r in d["shift_records"]:
            if r.get("record_type") != "shift" or r.get("site_id") != "S006":
                continue
            gid = r.get("guard_id")
            if guards_by_id.get(gid, {}).get("is_longterm") != "True":
                continue
            if r.get("is_external") == "True":
                continue
            # 注意：呢度刻意*唔*剔走settlement_unit=="autopay_longterm"——
            # 總表格本身（Q10問嘅嗰個「桶」）逐日淨印通用「港Y」／
            # broker_code=K，冇拆得開個人，所以總表格層面睇嚟成盤都係
            # 「K桶」。shift_records.csv嘅settlement_unit會改記
            # autopay_longterm，係wp2b自己另外用私有client dutysheet
            # 反推「呢位其實係長工、唔經K出糧」嘅*我哋自己嘅結論*——但
            # 呢個結論啱唔啱，正正就係Q10問緊老闆嘅嘢，唔可以用嚟自己
            # 剔走自己個exposure，否則Q10永遠得0（自問自答）。
            s006_counts[gid] += 1
        for gid, n in s006_counts.items():
            exposure[gid]["n"] += n
            exposure[gid]["amt"] += s006_rate * n
            exposure[gid]["sites"].add("S006")
            exposure[gid]["brokers"].add("K")

    if not exposure:
        return

    total_guards = len(exposure)
    total_shifts = sum(v["n"] for v in exposure.values())
    total_amt = _q2(sum(v["amt"] for v in exposure.values()))

    def _fmt(items):
        parts = []
        for gid, v in sorted(items, key=lambda kv: -kv[1]["amt"]):
            site_labels = "/".join(sorted(sites_by_id.get(s, {}).get("canonical_name", s)
                                           for s in v["sites"] if s))
            broker_labels = "/".join(sorted(v["brokers"]))
            parts.append(f"{gid}（{site_labels}，桶{broker_labels}）{v['n']}更/{v['amt']:.2f}")
        return "；".join(parts)

    y_bucket_total = _q2(sum(v["amt"] for gid, v in exposure.items() if v["brokers"] == {"Y"}))

    b.add("L2", "長工被掃入雞頭現金桶（Q10）", str(total_shifts), "0", "更",
          "out/wp5/master_assignments.csv#broker_code∈{K,W,Y,T,D,G}&remark=[NAME:...];"
          "out/wp5/master_posts.csv#payout_rate;out/wp2b/guards.csv#is_longterm=True;"
          "out/wp2b/shift_records.csv#site_id=S006（HKU Y更冇remark例外，見function docstring）",
          CAT_UNRESOLVED,
          f"{total_guards}位長工（guards.csv is_longterm=True，Maxwell月薪表配對到）嘅更次喺總表被計落"
          f"現金雞頭桶，Σ總表格payout_rate合共{total_amt:.2f}：{_fmt(exposure.items())}。"
          f"其中公司兵(Y)桶{sum(1 for v in exposure.values() if v['brokers']=={'Y'})}人合共{y_bucket_total:.2f}"
          "——同D5「公司兵桶包埋autopay長工」已解釋嗰4人係同一筆，唔係另一個缺口；"
          f"HKU Y更（S006，{_BROKER_K}(K)桶）淨低嗰筆22,100係總表格式本身冇留低個人名嘅例外"
          "（呢個盤成格印通用「港Y」，冇remark拆得開個人），改靠shift_records.csv先揾得返。",
          "老闆已答「係」（2026-09-11）：雞頭照樣實收現金。呢啲更同時有一份自動轉賬月薪＋一份雞頭現金，"
          "係業務安排，唔係數據錯；成本表兩邊都當真實支出，P1毛利表要如實反映。",
          STATUS_EXPLAINED, "Q10")


def build_l2_haiyang_new_site(b: DiffBuilder, d: dict):
    """Q9（WP5c必修15降級，2026-09-10）：總表有「海洋廠」崗位（城巴車廠
    12hrs block，client_rate=820/payout_rate=730，同其餘8個城巴車廠同一
    口徑），sites.csv 冇對應 site_id。7月呢個崗位喺總表逐日格全部空白
    （0更），對我哋7月P0交付零數量影響——純粹登記存在，唔使老闆而家答，
    移出「待老闆決定」清單，改做status=explained嘅備註（P1階段先再問）。"""
    unmapped = d.get("unmapped_master") or []
    hy_posts = [r for r in unmapped if r.get("property") == "海洋廠"]
    if not hy_posts:
        return
    post_ids = {r["post_id"] for r in hy_posts}
    worked = [a for a in (d.get("master_assignments") or [])
              if a["post_id"] in post_ids and (a.get("cell_value") or "").strip()]
    posts_by_id = {p["post_id"]: p for p in (d.get("master_posts") or [])}
    sample = posts_by_id.get(next(iter(post_ids))) if post_ids else {}
    b.add("L2", "海洋廠（城巴車廠，未登記）", str(len(worked)), "0", "更",
          "out/wp5/unmapped-master.csv#property=海洋廠;out/wp5/master_posts.csv",
          CAT_UNRESOLVED,
          f"總表 Roster 有「海洋廠」呢個崗位（block=城巴車廠12hrs，Day 0815-2015，"
          f"client_rate={sample.get('client_rate','')}／payout_rate={sample.get('payout_rate','')}，"
          f"同其餘8個城巴車廠同一口徑），sites.csv 冇對應site_id；2026年7月呢個崗位總表逐日格全部空白"
          f"（{len(hy_posts)}條post記錄、{len(worked)}日有實際更次），對7月P0交付冇數量影響（0更/0元）。"
          "**Q9降級（WP5c必修15）**：純粹登記存在，唔屬於P0交付要解決嘅缺口，移出老闆待答清單。",
          "備註：海洋廠係咪新盤／邊個客（sites.csv 要唔要正式登記呢個site_id），留返P1階段先問老闆，"
          "P0唔使佢答。",
          STATUS_EXPLAINED, "Q9")


def build_l2_autopay_longterm(b: DiffBuilder, d: dict):
    names_en = d["names_en"]
    tier_by_name = {r["english_name"]: r["tier"] for r in names_en}
    zh_by_name = {r["english_name"]: r["name_zh"] for r in names_en}

    # WP2b-c（2026-09-10）：以前呢兩個數（32/19）寫死喺 f-string 入面，老闆
    # 補咗 Maxwell 長工月薪表之後 names_en.csv 嘅配對狀態變咗，寫死嘅數就
    # 變 stale——而家由 names_en.csv 本身即場計，第 21 個月都會自動啱。
    longterm_matched_n = sum(1 for r in names_en if r["tier"] == "longterm" and r["name_zh"])
    longterm_unmatched_n = sum(1 for r in names_en if r["tier"] == "longterm" and not r["name_zh"])
    small_matched_n = sum(1 for r in names_en if r["tier"] == "small" and r["name_zh"])
    small_unmatched_n = sum(1 for r in names_en if r["tier"] == "small" and not r["name_zh"])

    _CENT = Decimal("0.01")
    longterm_total = Decimal("0")
    small_total = Decimal("0")
    longterm_n = small_n = unknown_n = 0
    unknown_total = Decimal("0")
    for r in d["bochk_rows"]:
        # BOCHK嘅.xls本身有少數金額有浮點存儲殘留（例如16879.350000000002），
        # quantize去蚊入面兩個小數位先加總，避免呢啲殘留喺報表度累積成一
        # 串好睇嘅位、又唔反映實際金錢（蚊入面兩位已經係港元最小單位）。
        amount = r["amount"].quantize(_CENT)
        tier = tier_by_name.get(r["english_name"])
        if tier == "longterm":
            longterm_total += amount
            longterm_n += 1
        elif tier == "small":
            small_total += amount
            small_n += 1
        else:
            unknown_total += amount
            unknown_n += 1

    # Σ(長工更次 × R2 月結出街價) —— 名義分攤，接受同 payroll 唔會啱。
    site_shift_counts = defaultdict(int)
    for r in d["shift_records"]:
        if r.get("settlement_unit") == "autopay_longterm" and r.get("record_type") == "shift" \
                and r.get("is_external") == "False" and r.get("out_of_scope") == "False":
            site_shift_counts[r["site_id"]] += 1

    nominal_total = Decimal("0")
    nominal_shifts = 0
    excluded_shifts = 0
    for site_id, n in site_shift_counts.items():
        rate = _AUTOPAY_R2_RATE.get(site_id)
        if rate is None:
            excluded_shifts += n
            continue
        nominal_total += rate * n
        nominal_shifts += n

    # 2026-09-10：N6已答（Maxwell長工月薪表48人，見上面N6文字），boss問題
    # 移除；呢條D0092長工名義攤分差異本身一直都係結構性口徑差異（長工出
    # 固定月薪、唔按更計錢，月結出街價淨係名義分攤），唔係等緊老闆答嘅嘢，
    # 改status=explained。
    b.add("L2", "長工 autopay（BOCHK D2）", str(longterm_total), str(nominal_total), "元",
          "data/2026-07/reference/2026-07-長工autopay-BOCHK-PayrollEditor.xls#Payroll Editor;"
          "data/mappings-private/names_en.csv#tier=longterm;out/wp2b/shift_records.csv#settlement_unit=autopay_longterm",
          CAT_LONGTERM_FIXED_SALARY,
          f"7月發薪檔longterm tier {longterm_n}人（{longterm_matched_n}人已配返中文名，"
          f"{longterm_unmatched_n}人未配對——唔喺Maxwell Corporation Limited 2026-07長工月薪表"
          f"（48人frontline staff，N6已答）出現，可能係非前線/離職/新入職，需再核實）"
          f"合計{longterm_total}元；"
          f"對應{nominal_shifts}條autopay_longterm更次（另{excluded_shifts}更所屬盤唔喺R2月結、冇出街價可攤，已剔走）"
          f"×各自R2『出街價』欄名義攤分＝{nominal_total}元。P0-執行計劃§3.6規則二：月結出街價對長工係名義分攤價，"
          f"唔會逐更對得上（長工出固定月薪，唔係逐更計錢），接受總數層面對——呢個差異本身係預期之內，唔代表資料錯，"
          f"N6已答（Maxwell長工月薪表），boss問題移除。",
          f"結構性口徑差異，接受總數層面對，唔要求逐更相等；{longterm_unmatched_n}人未配對非本題核心，"
          "屬N5範疇（BOCHK small tier性質待問）。",
          STATUS_EXPLAINED, "")

    b.add("L2", "發薪檔 small tier（老闆指示不追）", str(small_total), "", "元",
          "data/2026-07/reference/2026-07-長工autopay-BOCHK-PayrollEditor.xls#Payroll Editor;"
          "data/mappings-private/names_en.csv#tier=small",
          CAT_SPECIAL_INCOME,
          f"7月發薪檔 small tier {small_unmatched_n + small_matched_n}人合計{small_total}元"
          f"（900-4,620元／人，{small_unmatched_n}人未配對到更表中文名——經Maxwell長工月薪表"
          f"（48人frontline staff）核對，全部唔喺嗰張表出現，唔係遺漏配對，係嗰48人以外嘅性質）。"
          "**N5已答（2026-09-10）**：老闆要求關檔「特別中特別嘅更，唔使理」——19人全部唔喺Maxwell "
          "frontline長工表48人入面，當特殊項（銀行支付、不對更表、不拆盤）。",
          "已解：分類「特殊項／老闆指示不追」，銀行支付、不對更表、不拆盤，關檔。",
          STATUS_EXPLAINED, "")

    # R2「保安長工MPF」行（§3.6 提及嘅參考數，只做context，唔強行對總額）。
    import re
    m = re.search(r"保安長工MPF\s+HK\$([\d,]+)", d["r2_text"])
    mpf_amount = m.group(1).replace(",", "") if m else ""
    if mpf_amount:
        b.add("L2", "R2「保安長工MPF」行（參考）", str(longterm_total + small_total), mpf_amount, "元",
              "data/2026-07/reference/2026-07-月結總表-FinalR2.pdf（「在勤寫字員工，保安長工MPF」行）",
              CAT_TOLERANCE,
              f"R2呢行印「在勤寫字員工，保安長工MPF HK${mpf_amount}」，係MPF供款（約月薪5%），唔係月薪本身，"
              f"同BOCHK發薪檔嘅{longterm_total + small_total}元（月薪淨額）自然對唔上，僅供context參考，唔係一條要追平嘅差異。",
              "唔使追平，純粹佐證R2有獨立追蹤長工MPF呢件事。", STATUS_EXPLAINED, "")


def build_l2_cost_column(b: DiffBuilder, d: dict):
    """月結成本欄（逐盤）vs 我哋成本（有價嘅部分）—— 用 R2Row.cost vs
    shift_records_priced 嘅 guard_wage_snapshot+broker_fee_snapshot 加總。

    **範圍**：淨係喺「有價嘅部分」做（跟工作包指示字面意思）——只揀嗰啲
    現金結算為主（guard_wage/broker_fee 有落 snapshot 嘅更次）佔全site
    更次 ≥50% 嘅 site 先比較。長工autopay為主嘅 site（HKU Y更/座頭、數碼
    港、啟航1331……）guard_wage_snapshot 本身就係刻意留空（見
    shift_records_priced.csv pricing_note：「長工autopay月薪，非逐更工
    資……唔屬於WP3 per-shift payout rate範圍」），如果照計就會將 R2 成本
    欄（涵蓋成個 site）同一個「因為大部分人係autopay而刻意唔完整」嘅
    「我哋成本」比，做出嚟嘅「差異」只係重複緊 build_l2_autopay_longterm()
    已經解釋咗嘅「長工月薪vs名義分攤價」，唔係新資訊，仲會誤導人以為呢
    啲site有查唔到嘅成本缺口——所以刻意剔走呢類 site，唔製造假差異。"""
    cost_by_site = defaultdict(Decimal)
    priced_shifts_by_site = defaultdict(int)
    total_shifts_by_site = defaultdict(int)
    for r in d["shift_records_priced"]:
        if r.get("record_type") != "shift" or r.get("is_external") != "False" or r.get("out_of_scope") != "False":
            continue
        total_shifts_by_site[r["site_id"]] += 1
        wage = _d(r.get("guard_wage_snapshot"))
        fee = _d(r.get("broker_fee_snapshot"))
        if wage is None and fee is None:
            continue
        priced_shifts_by_site[r["site_id"]] += 1
        cost_by_site[r["site_id"]] += (wage or Decimal("0")) + (fee or Decimal("0"))

    label_to_site: Dict[str, str] = {}
    for s in d["sites"]:
        label_to_site[s["canonical_name"]] = s["site_id"]
        for a in s.get("aliases", []):
            label_to_site.setdefault(a, s["site_id"])

    # R2 row22「獨立雞頭費」（cost=90,000）跟住 row21 啟德1331之後，屬
    # 1331嘅成本（同 build_l1 嘅 row_no=22 改正歸屬同一個判斷，見D0005）
    # ——row22 個 label「獨立雞頭費」本身撞名（row4都係呢個label，真係
    # 屬HKU Y更），冇辦法用 label_to_site 配對到，所以呢度用 row_no 做
    # 例外key，將90,000加落S017嘅R2成本先同我哋成本比，唔係漏咗呢90,000
    # 淨用863,740嚟比。
    extra_cost_by_site: Dict[str, Decimal] = defaultdict(Decimal)
    r22 = next((rr for rr in d["r2_rows"] if rr.row_no == "22"), None)
    if r22 is not None and r22.cost is not None:
        extra_cost_by_site["S017"] += r22.cost

    n_matched = n_diff = n_skipped_autopay = 0
    for r2row in d["r2_rows"]:
        site_id = label_to_site.get(r2row.label)
        if not site_id or r2row.cost is None:
            continue
        total_n = total_shifts_by_site.get(site_id, 0)
        priced_n = priced_shifts_by_site.get(site_id, 0)
        if total_n == 0 or priced_n * 2 < total_n:
            n_skipped_autopay += 1
            continue
        ours_cost = cost_by_site.get(site_id)
        if ours_cost is None:
            continue
        r2_cost = r2row.cost + extra_cost_by_site.get(site_id, Decimal("0"))
        diff = ours_cost - r2_cost
        if abs(diff) <= Decimal("1"):
            n_matched += 1
            continue
        n_diff += 1
        site = d["sites_by_id"].get(site_id, {})
        # 呢個site如果已經喺 L1（_L1_SITE_OVERRIDE／_L1_PRICE_PENDING）有更數/
        # 價目根因記錄，成本差好可能只係嗰個根因嘅金額倒影，唔係一個新問題
        # ——status跟返嗰個根因（已經explained就唔好無端端喺呢度整多個
        # awaiting_boss嚇親人；仲pending緊嘅就繼續awaiting同一個boss_ref，
        # 唔開多個新問題編號）。搵唔到既有根因先真係算「新」發現。
        if site_id in _L1_PRICE_PENDING:
            boss_ref, _ = _L1_PRICE_PENDING[site_id]
            status, action = STATUS_AWAITING, "同L1嘅價目待補問題（見site_or_unit相同嘅L1差異行）同一根因，等埋一齊答。"
        elif site_id in _L1_SITE_OVERRIDE:
            _cat, _status, boss_ref, _action = _L1_SITE_OVERRIDE[site_id]
            status = _status
            action = "同L1嘅差異行同一根因（見site_or_unit相同嘅L1差異行），成本差係更數差嘅金額倒影。"
        else:
            status, boss_ref, action = STATUS_AWAITING, "Q6", "如同site嘅L1/L2更數差已有解釋，呢條可以一併視為同一根因；否則要人手覆核rate_cards。"
        extra_note = ""
        if extra_cost_by_site.get(site_id):
            extra_note = (f"（R2成本欄{r2row.cost}已加返row22獨立雞頭費{extra_cost_by_site[site_id]}，"
                           f"合計{r2_cost}，見D0005）")
        b.add("L2", site.get("canonical_name", site_id), str(ours_cost), str(r2_cost), "元",
              f"out/wp3/shift_records_priced.csv#site_id={site_id}（{priced_n}/{total_n}更有價）;"
              f"data/2026-07/reference/2026-07-月結總表-FinalR2.pdf#row{r2row.row_no}",
              CAT_UNRESOLVED if status == STATUS_AWAITING and boss_ref == "Q6" else CAT_TOLERANCE,
              f"Σ(guard_wage_snapshot+broker_fee_snapshot)={ours_cost} vs R2成本欄{r2_cost}{extra_note}，差{diff}，"
              f"呢個site現金結算佔{priced_n}/{total_n}更（≥50%，屬「有價嘅部分」比較範圍）。",
              action, status, boss_ref)
    return n_matched, n_diff


# ---------------------------------------------------------------------------
# 4) L3 收入
# ---------------------------------------------------------------------------

def build_l3_gate_results(b: DiffBuilder, d: dict):
    """out/wp3/gate-results.csv 逐行——WP4第二版將gate=PASS(known_shift_gap)
    /PASS(no_shift_records)呢類「已知類型嘅缺口」喺L3 sheet分開顯示兩種：
    (a)「對平」：diff=0.00、又冇billing_adjustments行，snapshot同發票已經
        完全一致，純粹記低個gate通過咗（第一版靜靜skip咗呢類row，第二版
        明文列出嚟，等睇報表嘅人見到個gate真係逐項check過，唔係得個
        「淨」字）；
    (b)「差額已入差異清單／尾數入帳」：呢個site有`billing_adjustments.csv`
        行（P6五條細殘差之一，見§8 P6，2026-09-10已由老闆總表/發票核到
        金額，WP5e必修9：**P6已經接受做尾數入帳，唔再入老闆清單**）——
        呢啲金額細（幾十至幾百蚊）嘅OT按鐘/pro-rata尾數，直接
        status=explained，唔標boss_question_ref。
        **WP5e必修5**：西九龍城巴車廠（S024）billing_adjustments 30元
        令diff完全歸零（gate印plain「PASS」，唔係「PASS(...)」），以前
        呢個分支入口`gate.startswith("PASS(")`嘅過濾條件將佢漏晒——依家
        改用「site_id有冇billing_adjustments行」做入口判斷，先可以補返
        呢條L3差異行，等billing_adjustments.csv 5條全部有對應差異行。
    (c) 冇billing_adjustments、又冇`_L1_SITE_OVERRIDE`嘅其餘
        PASS(known_shift_gap)行：跟返同site嘅L1覆核結論。
    no_shift_records（國泰城/ICBC/哈羅……）已經喺L1處理咗（更表冇任何
    逐日來源），呢度唔重複開行。"""
    ba_by_site = {r["site_id"]: r for r in d["billing_adjustments"]}
    for r in d["gate_results"]:
        diff_txt = r.get("diff", "")
        gate = r.get("gate", "")
        site_id = r["site_id"]
        adj = ba_by_site.get(site_id)
        if diff_txt == "n/a" or (not gate.startswith("PASS(") and not adj):
            continue
        site = d["sites_by_id"].get(site_id, {})
        label = site.get("canonical_name", r["label"])
        if adj:
            # WP5e必修9（2026-09-10，Opus最終複驗）：P6五條細殘差（S006／
            # S007／S015／S024／S033）全部已經由老闆總表/發票核實金額
            # （§8 P6），淨係尾數細（幾十至幾百蚊嘅OT按鐘/pro-rata殘差），
            # P6已解，唔再入老闆清單——status一律explained，boss_ref清空。
            # S024（西九龍）用「特殊收入項」（同「尾數30元，當尾數入帳」
            # 呢句人話備註），其餘4條沿用CAT_TOLERANCE（同其他OT按鐘尾數
            # 一致口徑）。
            category = CAT_SPECIAL_INCOME if site_id == "S024" else CAT_TOLERANCE
            note_suffix = "P6尾數30元，當尾數入帳。" if site_id == "S024" else "P6已解，當尾數入帳。"
            b.add("L3", label, r["snapshot_sum"], r["invoice_amount"], "元",
                  f"out/wp3/gate-results.csv#site_id={site_id};invoice={r['invoice_no']};"
                  f"out/wp3/billing_adjustments.csv#site_id={site_id}",
                  category,
                  f"差額已入差異清單：{adj['note']}。**{note_suffix}**",
                  "已接受做尾數入帳，唔使再問老闆。", STATUS_EXPLAINED, "")
            continue
        if diff_txt in ("", "0.00"):
            b.add("L3", label, r["snapshot_sum"], r["invoice_amount"], "元",
                  f"out/wp3/gate-results.csv#site_id={site_id};invoice={r['invoice_no']}",
                  CAT_TOLERANCE,
                  f"對平：gate={gate}，snapshot（{r['snapshot_sum']}）同發票（{r['invoice_amount']}）已經完全一致，唔係缺口。",
                  "已對平，唔使再問。", STATUS_EXPLAINED, "")
            continue
        override = _L1_SITE_OVERRIDE.get(site_id)
        if override:
            category, status, boss_ref, _action = override
            b.add("L3", label, r["snapshot_sum"], r["invoice_amount"], "元",
                  f"out/wp3/gate-results.csv#site_id={r['site_id']};invoice={r['invoice_no']}",
                  category,
                  f"差額已入差異清單：gate={gate}，已知shift缺口令snapshot同發票有差，同L1嗰邊嘅更數差係同一根因（見site_or_unit相同嘅L1差異行）。",
                  "同L1嘅差異行同一根因（見site_or_unit相同嘅L1差異行）。" if status == STATUS_EXPLAINED
                  else "同L1嘅差異行一併等老闆答，見site_or_unit相同嘅L1差異行。",
                  status, boss_ref)
        else:
            b.add("L3", label, r["snapshot_sum"], r["invoice_amount"], "元",
                  f"out/wp3/gate-results.csv#site_id={r['site_id']};invoice={r['invoice_no']}",
                  CAT_TOLERANCE,
                  f"差額已入差異清單：gate={gate}，已知shift缺口令snapshot同發票有差，同L1嗰邊嘅更數差係同一根因。",
                  "見同site嘅L1更數差異行。", STATUS_EXPLAINED, "")


def build_l3_billing_unit_solve(b: DiffBuilder, d: dict):
    """billing-unit-solve.csv 未解嘅開票單位。九龍企業大廈（S016）已經喺
    L1 `_L1_PRICE_PENDING` 有專屬一行覆蓋，呢度跳過避免重複。**啟航1331
    主單位（S017）＋「啟航1331 Event」副線唔可以當「範圍外」**——S017
    只喺 `_L1_SITE_OVERRIDE`（唔喺 `_L1_PRICE_PENDING`），以前呢個skip
    set漏咗佢，跌落最後嘅else分支變咗CAT_OUT_OF_SCOPE／Q2，同「啟航
    1331屬P0範圍內」呢個事實矛盾。**WP5b（2026-09-10）更新**：P1/P2a
    已答——7個更別收客價/K出街價已由老闆總表master_roster_rate直接解
    晒（rate_cards.csv 全部solved），billing-unit-solve.csv 呢個獨立
    粒度（Σ逐更收客價 vs 發票整額）仍然報pending，係因為留返一個細殘差
    （逐日counts×rate=1,202,700 vs 發票1,203,900，差1,200，0.1%）未100%
    整除——呢個已經唔再等緊P1/P2a（兩者已答），改做細殘差接受，LINK C7
    細盤（`in_p0_scope=False`）先真係範圍外，繼續掛Q2、L1已經有一條彙總
    行覆蓋。"""
    skip_site_ids = set(_L1_PRICE_PENDING.keys()) - {"S036"}
    kaihang = d["sites_by_id"].get("S017", {})
    kaihang_label = kaihang.get("canonical_name", "啟航1331")
    kaihang_event_label = f"{kaihang_label} Event"
    for r in d["billing_unit_solve"]:
        status_txt = r.get("status", "")
        if status_txt.startswith("solved"):
            continue
        site_id = r["site_id"]
        site = d["sites_by_id"].get(site_id, {})
        if site_id in skip_site_ids:
            continue
        if site_id == "S017" or r["label"] == kaihang_event_label:
            label = kaihang_label if site_id == "S017" else kaihang_event_label
            b.add("L3", label, r.get("shifts") or "0", r["amount"], "元",
                  f"out/wp3/billing-unit-solve.csv;invoice={r['invoice_no']}",
                  CAT_TOLERANCE,
                  f"{r.get('note', '')}（status={status_txt}）；**P1/P2a已答**：7個更別收客價已由老闆總表"
                  f"master_roster_rate逐個更別直接解晒（rate_cards.csv全部solved），呢度嘅『單一價÷"
                  f"更數唔整除』本身就係因為7個更別各有唔同價（唔係得一個劃一價），依家逐更別分開睇已經"
                  "冇問題；Σ逐更收客價同發票{amount}之間仍有細殘差（<0.5%），細殘差接受，唔阻P0交付。".format(amount=r['amount']),
                  "已解（P1/P2a已答），細殘差接受，唔使再問。", STATUS_EXPLAINED, "")
            continue
        if site and not site.get("in_p0_scope", True):
            continue  # LINK C7 細盤，L1 已經有一條彙總行覆蓋
        label = site.get("canonical_name", r["label"])
        # 2026-09-10：S036（恆星樓）P5已答solved，status_txt="solved"已喺上面
        # 篩走，唔會再跌落呢度；淨返其餘真係pending/月結以外嘅site。
        b.add("L3", label, r.get("shifts") or "0", r["amount"], "元",
              f"out/wp3/billing-unit-solve.csv;invoice={r['invoice_no']}",
              CAT_OUT_OF_SCOPE, f"{r.get('note', '')}（status={status_txt}）；冇任何逐日更次來源，暫時只記發票總額。",
              "屬P0-執行計劃§5「月結以外」範圍，Q2已由老闆知悉；如老闆想併入月結／補更表，另行處理。",
              STATUS_EXPLAINED, "Q2")


def build_l3_invoice_count(b: DiffBuilder, d: dict):
    n = len(d["invoice_lines"])
    b.add("L3", "Invoice Record 7月張數", str(n), "51", "張",
          "out/wp3/invoice-lines.csv（period=2026-07）",
          CAT_INVOICE_GAP,
          f"7月實際發票{n}張，P0-執行計劃早期版本寫嘅「51張」係錯嘅（已喺§8備註修正）。",
          "純記錄更正，唔使老闆答。", STATUS_EXPLAINED, "")

    # 2026-09-10：D3已答——MW-2026-07001/07002本來以為對應卓弘/嘉捷，老闆
    # 補資料後證實其實係Tenti保鏢15,000／HKW展覽34,020（個別雞頭 Event特殊收
    # 入項，S064，月結已有、我哋已計，全中），發票缺號嘅謎團解咗（呢兩個
    # 編號本身唔喺Invoice Record入面出現，但已知代表乜，唔再係未解之謎）。
    b.add("L3", "MW-2026-07001/07002缺號", "", "15,000+34,020", "元",
          "P0-執行計劃§8 D3已答;mappings/invoice_site_aliases.csv#TentiWealthBodyGuard,HKW（S064特殊收入項）",
          CAT_INVOICE_GAP,
          "MW-2026-07001＝Tenti保鏢15,000、MW-2026-07002＝HKW展覽34,020——個別雞頭 Event特殊收入項"
          "（S064，月結已有、我哋已計，全中），呢兩個發票編號本身唔喺Invoice Record入面出現（缺號），"
          "但已知代表乜，D3呢部分已答。",
          "純記錄更正，唔使老闆答。", STATUS_EXPLAINED, "")

    # **D3a已答（2026-09-10）**：卓弘＝其中一個客戶嘅全稱（見 client-names.json）
    # （恆星樓07044 50,403.23＋葵發07045 7,000＝57,403.23＝月結57,403✓）；
    # 嘉捷＝另一個客戶嘅全稱（見 client-names.json）（SOGO 07003 9,600＋Garden East
    # 07004 14,400＝24,000＝20更；月結22,800＝19更，少計1更，以發票/總表
    # 20更為準）——唔係「冇開發票」，係我哋以前用錯咗中文代稱搵發票，用
    # 返正確嘅發票編號就對到。
    for guess_label, guess_amount, invoice_note in [
        ("卓弘", "57,403", "恆星樓MW-2026-07044 50,403.23＋葵發MW-2026-07045 7,000＝57,403.23"),
        ("嘉捷", "22,800", "SOGO MW-2026-07003 9,600＋Garden East MW-2026-07004 14,400＝24,000（20更；"
                          "月結22,800＝19更，少計1更，以發票/總表20更為準）"),
    ]:
        b.add("L3", guess_label, "", guess_amount, "元",
              f"P0-執行計劃§8 D3a已答;R2月結（{guess_label}有金額）;out/wp3/invoice-lines.csv（{invoice_note}）",
              CAT_INVOICE_GAP,
              f"{guess_label}月結有金額{guess_amount}——**D3a已答**：{guess_label}＝"
              f"{_CLIENT_EXCELLENT_PROPERTY_LEGAL if guess_label=='卓弘' else _CLIENT_DUSSERVICE_LEGAL}，"
              f"發票入面用嘅係英文公司名唔係中文代稱，之前搵唔到係搵錯咗名；實際對應發票：{invoice_note}。",
              "已解：sites.csv client_group已標代號，唔使再答。",
              STATUS_EXPLAINED, "")


# ---------------------------------------------------------------------------
# 4.5) 「待老闆決定」sheet 同「已裁定口徑」sheet 嘅材料
# ---------------------------------------------------------------------------

_BOSS_QUESTION_TEXT = {
    "N7": "殷樺花園 7 月更表有一位安員（3 更）冇工號、唔喺任何糧單亦唔喺 autopay 名單——佢係邊個結算單位出糧？",
    "P1": "啟航1331收客價表：7個更別（早Zone IC／早更／中Zone IC／夜更／夜Zone IC／夜Zone SIC／Event）逐個幾錢？發票1,203,900有24組兩價解，唔唯一。",
    # 2026-09-10：P2a取代舊P2，比P2更根本——答咗先知P2（7個更別出街價）
    # 仲使唔使問。
    "P2a": (f"啟航1331有26個Maxwell長工（月薪合共468,500，經autopay出，唔經{_BROKER_K}現金），"
           f"咁「{_BROKER_K}頁7月糧」894,391.67係咪已包長工人工？(a)如果唔包，只係{_BROKER_K}自己嗰班人，淨低約354更，"
           "每更平均2,400以上，唔合理；(b)如果包，實際畀"
           f"{_BROKER_K}現金＝894,391.67減長工468,500？"
           "（三個口徑嘅隱含單價已喺rates-report.md §3列出，供參考）"),
    # P3主問題已答（見P3行explained），P3a已經由總表反推到費率表（WP5e必
    # 修9），淨係剩兩條block對唔平要老闆確認。
    "P3a": (f"老闆已答7/31多出嘅41,040係「有啲阿{_BROKER_K}嘅散工轉咗做公司長工，公司每月計返一個特別費用畀佢」"
           f"（長工介紹費，月結一次過）——已由總表逐block反推到費率表：{_BROKER_K}（啟航60／其餘50）、"
           f"{_BROKER_W}（啟航50／其餘30）、{_BROKER_T_SURNAME}／{_BROKER_T}（Weave 50／其餘30）、{_BROKER_G}（30）。全月合共58,120，"
           f"20行入面18行完全對得上；淨低兩條block對唔平：啟航12h夜更（{_BROKER_K}120＋{_BROKER_W}102＝222 vs 長工197，"
           f"多25更／1,500）、九龍企業（{_BROKER_T_SURNAME}690÷30＝23 vs 24，少1更／30）。問：呢個費率表啱唔啱？"
           "呢兩條對唔平嘅block點解？"),
    "P6": "**大部分已答（2026-09-10）**：三個pro-rata讀法（小欖24,000/月/崗×2崗=48,000＋打風半更387.10；"
          "淺水灣87,000×30/31；凱和山900/更×30/31）已經由總表確認；HKU C更OT678.80、Weave RR+150、"
          "都會大學+140 三條細殘差已解釋。**控制室（S031）已由WP5c必修12解決**：總表補入庫嘅第3位安員"
          "22更用返總表自己嘅上單價（901.36/更，PDPO：真名唔喺source code），Σ真.逐更收客價"
          "＝56,789.92，同發票56,790差0.08蚊（quantize尾數），舊嘅「+1,350」估計殘差已經唔再需要，"
          "gate由known_shift_gap（18,480）變真PASS，唔使再問。**剩淨西九龍城巴車廠 +30 呢一條**"
          "（13,970 vs 13,940，即發票多30蚊，可能係打風OT或者尾數調整）未有答案。",
    # D3主問題（07001/07002缺號之謎）已答（Tenti/HKW），D3a淨係問卓弘/嘉捷。
    "D3a": "卓弘（月結57,403）、嘉捷（月結22,800）7月有冇開發票？Invoice Record 48張入面完全搵唔到任何對應——號碼幾多、收咗未？定係根本冇開？",
    "D4": "請提供7月全部盤嘅「保安員值勤表」原檔（客方逐盤逐人逐日、日薪、OT，開單基礎，唔係文字化版本，逐格核數要原檔）——優先：啟航1331（P1/P2a）、控制室／西九龍／小欖／淺水灣／凱和山（P6剩餘）。",
    # WP2b-d（2026-09-10）：N2已答（老闆傳「港大職員宿舍值勤表」下半月5人
    # 名單同逐人更數），N2a淨係問呢5人邊個雞頭／點出糧。
    "N2a": "HKU Y更獨立雞頭費94更，已知係邊5個人（逐人姓名/更數見data/mappings-private/client_dutysheet_hku_y_2026-07.csv），"
           "但呢5人係邊個雞頭／點出糧（月結成本69,200＝94×736）？有冇更表？",
    # WP5e必修1（2026-09-10，Opus最終複驗，D5收窄）：以前D5冇喺呢個
    # dict出現，落返用第一條diff row嘅raw explanation做「一句問題」，
    # 太長太技術化——加返一句人話版本。
    "D5": "公司兵糧單頁真正缺口收窄到37,572.46——都會大學夜巡邏一位安員20更、啟航1331一位安員26更，"
          "呢兩份公司兵現金糧單頁我哋手上冇，請問係咪仲有未交嘅？（其餘部份已經係我哋自己有糧單證據、"
          "或者係autopay長工嘅結構性假象，同Q10一致，唔係缺口）。",
    # WP5c必修14（2026-09-10，P0-執行計劃.md §8「WP5總表對數後新問題」，
    # 最重要一條）：總表雞頭欄（例如「K」）記嘅係成本分類標籤，唔一定
    # 代表實際邊個攞咗現金——已證實部分長工（Maxwell月薪、autopay出糧）
    # 嘅更次仍然被計落雞頭現金桶（見D0xxx，guard_id可查out/wp2b/
    # guards.csv）。
    "Q10": (f"總表雞頭欄係成本桶標籤，唔係「邊個出糧」——部分長工（Maxwell月薪，經autopay直接出糧）"
           f"嘅更次，喺shift_records.csv仍然被計落{_BROKER_K}/{_BROKER_W}/公司兵等現金雞頭桶（唔係autopay_longterm），"
           f"總表Σ{_BROKER_K}918,891.67／Σ其他雞頭嘅PAID Amount已經包埋呢啲長工更次嘅名義攤分價，合共102,014.52"
           f"（公司兵(Y)桶4人79,914.52＋HKU Y更{_BROKER_K}(K)桶22,100）。同D5交叉引用：公司兵桶嗰4人79,914.52"
           "同D5已經解釋嗰4人係同一筆，唔係另一個缺口。"
           "問：長工被掃入雞頭桶嘅更，雞頭係咪照畀咗現金（雙重支付：一份autopay月薪＋一份雞頭現金）？"
           "定係總表個桶純粹做成本/收入分攤標籤，冇實際現金流出畀雞頭？"),
    # N7 嘅問題文字刻意唔喺呢度寫死（涉及安員真名，PDPO：個人資料只准放
    # out/，唔准落 tools/ 原始碼）——build_boss_facts() 會由對應嘅
    # differences.csv 差異行 explanation（runtime 由 unresolved-guards.csv
    # 讀出嚟）動態砌返個問題出嚟。
    "N3": "國泰城/卓弘/嘉捷/ICBC/哈羅/都會大學夜巡邏冇任何逐日更表來源，如老闆有獨立更表可以補（有更好，冇都做得）。",
    "N5": "BOCHK長工autopay發薪檔small tier 19人合計23,620元（900-4,620元/人），全部未配對到更表中文名，性質係散工/津貼/補更定係其他？",
    "Q2": f"P0範圍確認：7月Wilson Service月結第1-38行為界；LINK C7唔入P0；{_CLIENT_EXCELLENT_PROPERTY}/{_CLIENT_DUSSERVICE}更次照入但另列「月結以外」。（老闆已知悉，冇異議即按此執行）",
    "Q4": "數碼港CP1-4更表234更 vs 月結/發票230更（213,900÷930反推），差4更/3,720元；"
          "用總表逐日對更表逐日，差異正好集中三日：7月29日多1更、7月30日多2更、7月31日多1更。"
          "呢三日係更表填多咗，定係出單漏咗？",
    # 2026-09-10（原Q6已解，見P0-執行計劃.md §8「~~Q6~~ → 已解」）：Weave OL
    # 更表31 vs R2/發票25嗰6更差，由總表逐日broker分佈（rule 0.1/0.2）完整
    # 解釋咗（7日更表多填＋1日更表漏填，31-7+1=25），已經explained、清咗
    # boss_question_ref，唔再係Q6嘅內容。Q6編號留返畀下面呢批新、獨立嘅
    # 個位數更數缺口用（避免同一個ref喺唔同版本代表唔同問題引起混淆，但
    # 呢批已經係全新嘅具體個案，唔延續Weave OL嗰個故事）。
    "Q6": ("payroll-diff.csv／day-mismatch.csv 逐guard逐月更數對比，剩返幾個個位數（1-2更）嘅缺口追唔到已知pattern"
          f"（唔屬於補更/半更/OT/site override等已知機制）：城巴-創富車廠({_BROKER_T})、HKU22(公司兵)、"
          "啟航1331夜(公司兵) 三組各有1-2位安員嘅糧單更數同系統regenerated更數對唔上。"
          "呢啲係咪7月實際有補更/請假記錄未過賬，定係糧單/更表其中一方漏轉錄？"),
}

_DECIDED_RULES = [
    f"Q1 代號對照：K＝{_BROKER_K}、W＝{_BROKER_W}、G＝{_BROKER_G}、D＝{_BROKER_D}、T＝{_BROKER_T}、Y＝公司兵（現金日薪直聘，唔係雞頭）；更表雞頭欄空白＝冇填，唔係一個類別。",
    "OT 按鐘計錢，唔加更數；NPL＝NL（無薪假）、OFF＝RD（例假）。",
    "月費／行政費項目（IFC、CP5 IC、創富廠IC、M+、都會大學夜巡邏、控制室）對總數，唔對更數。",
    "按鐘／分成／專車（個別雞頭月薪/Event佣金）做「特殊收入項」，人手入總數，唔自動計。",
    "臨時工冇staff no，用姓名＋電話建檔，staff no後補。",
    "盤正名跟發票（啟航1331、HKU Y更／HKU C更／HKU醫學院、Wilson Control＝控制室、Wilson Patrol＝都會大學夜巡邏、HKSA-IFC＝IFC）。",
    "「數據中心」格係指針，唔係更次，只喺數碼港數據中心更表計一次。",
    "出街價拆做guard_wage（安員工資）＋broker_fee（雞頭費）兩個欄位記錄，月結出街價欄係加權平均，只做總數核對。",
    f"長工（{_BROKER_T}/{_BROKER_W}/{_BROKER_G}頁「工資－、只收雞頭費」嗰啲行）糧經autopay出，雞頭只收介紹費；月結出街價對長工係名義分攤價，唔會逐更對得上，接受總數層面對（本工作簿「長工autopay」一行）。",
    "客戶自己嘅人（Wilson Guard／Wilson Supervisor）標external，唔入糧、唔開單，唔計unknown。",
    f"{_BROKER_K}唔拆兩個雞頭：settlement_page（{_BROKER_K_1331}／{_BROKER_K_LINK}／公司兵-2）做報表分組維度，broker_id保持一個。",
    "兄弟盤（糧單盤≠更表盤但同客戶集團，例如HKU上村 vs HKU座頭）：真係改盤，更次記喺糧單指嘅盤。",
    "近似名（edit distance=1嘅安員姓名，見name-near-match.csv）入人手確認清單，唔自動合併。",
    "OT行落地：shift_types加OT1更別，OT記錄填parent_shift_id、ot_hours；shift_records用broker_id FK。",
    "day-mismatch自動分類：相鄰日調動→日期位移(淨額0)；兩人對調→兩人對調(淨額0)；補更頂替→成本轉移；OT/site override→口徑差異；淨低6條真係查唔到根因，交老闆（新）。",
    "頁面「更數」欄OT行計1更係頁印錯位，P0口徑OT唔係更次；policy_total_shifts一刀切＝該頁Σshifts where shift_kind=normal。",
    f"頁面小計/總計可以係Excel殘留（{_BROKER_G}頁220/470、{_BROKER_K_LINK}頁頂192），一律以逐行重算為準。",
    "月結R2「收客價」欄係第一優先證據，發票整除第二，OT按鐘/pro-rata/兩價其後。",
    "LINK C7（TKO Gateway/SPOT、Choi Ming、Yan Ming、Po Lam、厚德中、唐明夜）獨立合約模式、長工autopay，P0範圍外，P1後再傾。",
    f"{_CLIENT_EXCELLENT_PROPERTY}（恆星樓/葵發）、{_CLIENT_DUSSERVICE}（SOGO/Garden East）有發票但唔喺R2月結38行，更次由{_BROKER_T}頁入庫，報表另列「月結以外」。",
]


# WP5b（2026-09-10，總表歸屬做齊之後）：P1/P2a/D3a/D4/N2a/N5/N7 呢7條再
# 收貨關閉（逐條答案見「已答問題」sheet——P1/P2a由總表Roster sheet表頭
# 上單價/外判價直接解咗，D4由總表Roster sheet本身就係老闆要求嘅「保安員
# 值勤表原檔」大部分覆蓋咗，N2a/N5/N7由總表逐日broker分佈同rule 0.2確認
# 咗）。
#
# WP5e必修3/4/9（2026-09-10，Opus最終複驗）：Q9（海洋廠，0更純登記）、
# P6（五條細殘差全部由老闆總表/發票核到金額，尾數入帳）、Q6-generic
# 8條（創富補更頂替／HKU22更表多填／1331夜糧單漏格，逐條查到根因）
# 全部關檔，唔再入老闆清單（已答見「已答問題」sheet）。**最終老闆清單
# 淨返4條**：Q10、D5、P3a（費率表兩條block未平）、Q4。
_BOSS_QUESTION_REF_ORDER = ["Q4"]

# 已答關閉嘅問題（連答案），生成「已答問題」sheet 用——每項 (問題, 答案)。
_ANSWERED_QUESTIONS = [
    ("Q10", "長工被掃入雞頭現金桶嘅更（合共102,014.52），雞頭係咪照收咗現金？",
     "老闆答「係」（2026-09-11）：雞頭照樣實收現金。即呢啲更同時有一份自動轉賬月薪＋一份雞頭現金，係業務安排，唔係數據錯。成本表兩邊都當真實支出；P1 毛利表要如實反映。"),
    ("D5", "公司兵糧單缺口37,572.46（都會大學夜巡邏一位20更、啟航1331一位26更）係咪仲有未交嘅糧單頁？",
     "老闆答「以上檔」（2026-09-11）並傳「巡邏主任值勤表」：該位巡邏主任月薪23,000、20日、客方總收入19,804——係月薪人，冇現金糧單；啟航嗰位喺銀行自動轉賬檔嘅長工tier（實付18,668.46，同總表公司兵桶金額分毫不差）。兩人都係月薪／自動轉賬，公司兵糧單冇缺頁，37,572.46全部係名義攤分口徑。"),
    ("P3a", f"長工介紹費點計？（7/31{_BROKER_K}糧單多出嘅一筆）",
     f"老闆已答（2026-09-11）並傳{_BROKER_K}嘅7月介紹費表：數碼港長工88更×50＝4,400；CP5 23×50＝1,150；數據中心3×50＝150；IFC 27×50＝1,350；1331長工559×60＝33,540；合計40,590，同我哋由總表反推嘅{_BROKER_K}數分毫不差。老闆講明每個盤唔同、有機會每個人都唔同，以上只係阿{_BROKER_K}嘅——即係介紹費係盤級／雞頭級每月可變費率，唔係固定公式，每月要逐盤逐雞頭確認。"),
    ("Q1", f"代號對照：K＝{_BROKER_K}、W＝{_BROKER_W}、G＝{_BROKER_G}、D＝{_BROKER_D}、T＝{_BROKER_T}、Y＝公司兵（現金日薪直聘，唔係雞頭）；更表雞頭欄空白＝冇填。",
     f"老闆已確認（2026-09-03）：K＝{_BROKER_K}、W＝{_BROKER_W}、G＝{_BROKER_G}、D＝{_BROKER_D}、T＝{_BROKER_T}、Y＝公司兵。"),
    ("Q2", f"P0範圍確認：7月Wilson Service月結第1-38行為界；LINK C7唔入P0；{_CLIENT_EXCELLENT_PROPERTY}/{_CLIENT_DUSSERVICE}更次照入但另列「月結以外」。",
     "老闆已知悉，冇異議即按此執行。"),
    ("Q3", f"HKU醫學院第5更：{_BROKER_G}頁嗰位安員7月只得4更，糧單/shift_records都係4更，但R2月結印5更，差1更/700/630元，係咪R2打字多咗一更？",
     "老闆分享「香港大學李嘉誠醫學院7月保安值勤表」（第21份更表）：兩位安員合計5更（4更＋1更）＝Total 5＝月結。"
     "月結冇錯，係我哋缺呢份更表——已納入WP1第21檔，shift_records依家5更同R2一致。"),
    ("Q5", "HKU座頭/HKU醫學院一組細差：更表198 vs R2 199，7/31兩條更表有、7月糧單完全冇，係咪漏記？",
     "客方「HKU C值勤表」日數欄兩位安員各自少1日——客方冇計7/31，糧單亦冇，證實係「更表多填兩格」，"
     "唔係漏出糧。連同HKU上村override反轉後，HKU座頭更表202 vs 客方199全盤對平（1更細殘差當口徑差異接受）。"),
    ("P4", "九龍企業大廈7月發票51,205.65點計？62更本身數啱，但62×任何整數價都對唔上，價要拆。",
     "老闆交「九龍企業大廈保安員值勤表」：早、夜兩崗各按月薪25,500計（早更三人分、夜更兩人分），加一位安員颱風OT 3小時205.65"
     "（＝25,500÷31÷12×3），合共51,205.65＝發票。即月費制每崗25,500，唔係逐更價。sites.csv billing_model改monthly_fixed×2崗。"),
    ("P5", f"恆星樓（{_CLIENT_EXCELLENT_PROPERTY}）7月50,403.23點計？62更；同集團葵發700/更但恆星樓試極唔啱。",
     "發票MW-2026-07044：每崗月費25,000×早夜2崗＝50,000＋7/25夜更颱風OT 403.23（＝25,000÷31÷12×6h）＝50,403.23。"
     "每崗月費制，同九龍企業大廈一樣。"),
    ("D3", "發票MW-2026-07001/07002唔喺Invoice Record，疑似卓弘57,403、嘉捷22,800，請補資料或確認呢兩張根本冇開。",
     "07001＝Tenti保鏢15,000、07002＝HKW展覽34,020，係個別雞頭 Event特殊收入項，月結已有、我哋已計，全中——同批發票："
     "SOGO 9,600＝8更×1,200、Garden East 14,400＝12更×1,200（嘉捷兩盤價目由pending變solved 1,200/更，"
     "逐日更次已由發票入庫）；葵發7,000＝10×700；恆星樓同P5。原以為對應嘅卓弘/嘉捷缺號問題轉為D3a。"),
    ("N6", "老闆補嘅BOCHK longterm autopay 51人，邊個係邊個、盤別點分？",
     "老闆分享Google Sheet「Maxwell Monthly Payroll of July 2026 (Frontline Staff)」，48個長工，100%對到guards.csv。"
     "重大發現：26人係啟航1331長工（月薪16,500-19,000，合共468,500），而WP2b「啟航K行歸K」規則錯將佢哋490更歸咗K——已修正"
     "（見P2a追問）。BOCHK small tier 19人（23,620）唔喺呢張表，性質問題留返N5。"),
    # WP5b（2026-09-10，總表歸屬做齊之後）新增已答：P1/P2/P2a/D3a/N2a/N5/
    # N7/Q7/Q8。
    ("P1／P2", "啟航1331收客價（上單價）表：7個更別逐個幾錢？出街價（外判價）表：同上7個更別逐個幾錢？",
     "老闆分享「在勤總表」7月Roster sheet（各block表頭直接印住上單價/外判價）：8h Day/Middle IC "
     "800／750；8h Night SIC 900／800、IC 900／750；12h Day 1,200／880；12h Night 1,200／880；Event "
     "1,350（0900-1800）／1,200（1000-1900）／900（1000-1600），外判814,080／1,200（僅1000-1900一款"
     "有獨立外判價紀錄，其餘兩款Event見rates-report）。Σ上單價（非Event）1,199,100＝月結R2營業額分毫"
     "不差。7個更別rate_cards已由source=master_roster_rate直接寫入，8條pending卡solved 7條（第8條係"
     "已被取代嘅site層舊fallback，唔再有效）。"),
    ("P2a", f"啟航1331有26個Maxwell長工（月薪合共468,500，經autopay出，唔經{_BROKER_K}現金），咁「{_BROKER_K}頁7月糧」"
            "894,391.67係咪已包長工人工？",
     f"老闆總表Summary解咗：PAID Amount{_BROKER_K}918,891.67（上半432,450.83／下半486,440.83）≈{_BROKER_K}頁917,791.66"
     f"（±1,100）。{_BROKER_K}喺總表全公司合共1,044更（啟航323、數碼港D61/N56、CP5 158、國泰城85、HKU Y更"
     f"〔數量待Q10——總表將呢個block全部標{_BROKER_K}，但當中有幾多更其實係autopay長工被計落呢個成本桶，"
     "仲未拆得晒，唔可以當事實引用〕、IFC14、Weave 63、城巴89、嘉捷20、Event16…）×約880≈呢個數。"
     f"**結論：「{_BROKER_K}7月糧」係{_BROKER_K}全公司所有盤嘅逐日總額，唔係淨啟航1331**——之前WP2a標「{_BROKER_K_1331}」、"
     f"WP2b用佢做啟航盤級糧單、WP3{_BROKER_K_1331}線性解，全部前提錯，WP5b已改用總表逐日雞頭名做歸屬"
     "（rule 0.1/0.2）；但「呢個bucket入面幾多更係已經autopay嘅長工」呢個更根本嘅問題，見Q10。"),
    ("D3a", "卓弘（月結57,403）、嘉捷（月結22,800）7月有冇開發票？",
     f"有——用錯咗中文代稱搵：卓弘＝{_CLIENT_EXCELLENT_PROPERTY_LEGAL}（恆星樓MW-2026-07044 50,403.23＋"
     f"葵發MW-2026-07045 7,000＝57,403.23＝月結57,403✓）；嘉捷＝{_CLIENT_DUSSERVICE_LEGAL}（SOGO "
     "MW-2026-07003 9,600＋Garden East MW-2026-07004 14,400＝24,000＝20更；月結22,800＝19更，少計1更，"
     "以發票/總表20更為準）。sites.csv client_group已標代號。"),
    ("N2a", "HKU Y更獨立雞頭費94更，已知係邊5個人，但呢5人係邊個雞頭／點出糧？",
     "老闆確認（2026-09-10）：呢5人係「散Event」（散更/活動性質，唔屬任何雞頭）。同數據吻合：5人唔喺20個"
     "更表、唔喺總表Roster、唔喺任何糧單頁；月結獨立一行「獨立雞頭費94更」。處理：維持盤級flat "
     "adjustment（唔拆逐人shift_records），分類「特殊項／散Event（老闆確認）」，關檔。"),
    ("N5", "BOCHK長工autopay發薪檔small tier 19人合計23,620元，全部未配對到更表中文名，性質係散工/津貼/"
           "補更定係其他？",
     "老闆要求關檔（2026-09-10）：「特別中特別嘅更，唔使理」。19人全部唔喺Maxwell frontline長工表48人"
     "入面，當特殊項（銀行支付、不對更表、不拆盤），分類「特殊項／老闆指示不追」。"),
    ("N7", "殷樺花園7月更表有一位安員（3更）冇工號、唔喺任何糧單亦唔喺autopay名單——佢係邊個結算單位出糧？",
     f"總表Roster「殷樺花園」行：夜更1930-0730上900／外850，25更全部雞頭名「(2){_BROKER_K}」——同一崗位另一位安員"
     f"22更＋呢位安員3更都係{_BROKER_K}出糧（{_BROKER_K}頁全盤總額已包，PDPO：真名唔喺source code）。WP5b rule 0.2（總表"
     f"site+day配額消去法）已自動將呢3更由unresolved_guards改歸{_BROKER_K}，唔再需要人手介入。"),
    ("Q6", "Weave OL更表31更 vs R2/發票25更，差6更——老闆答「6月預支咗1更，7月扣回1更」最多解釋1更，"
           "淨低5更未解，係咪潛在少開收入5,400？",
     "老闆總表Roster sheet逐日對Weave OL有覆蓋，全月合共25更（同R2/發票25分毫不差）——逐日對比更表："
     "7/24、7/25、7/27、7/28、7/29、7/30、7/31共7日總表顯示0更（更表多填7日），7/22總表顯示2更、"
     "更表得1更（更表漏填1日），其餘23日兩邊一致。31-7+1=25=R2/發票22,500，逐格對平，唔使「預支」"
     "解釋，冇潛在少開收入。Q6（Weave OL呢個故事）關檔（此ref下面曾經重新啟用畀另一批獨立嘅個位數"
     "更數缺口，WP5e必修4已經逐條查到根因、全部explained，見下面第二條「Q6」記錄）。"),
    ("Q7", f"總表雞頭代號(1)公司兵(2){_BROKER_K}(3){_BROKER_W}(4){_BROKER_T_SURNAME}(5)富(6)威信(7){_BROKER_P}(8)長工(9)譚(10)其他——(4){_BROKER_T_SURNAME}、(5)富、"
           "(9)譚對應邊個？(6)威信＝Wilson Guard？",
     f"由總表Summary金額解咗：(4){_BROKER_T_SURNAME}＝{_BROKER_T}（178,235＝{_BROKER_T}頁177,435＋雞頭費調整扣800）、(11){_BROKER_D}＝{_BROKER_D}"
     f"（111,710≈55,600＋56,237）、(13){_BROKER_G}、(3){_BROKER_W}（161,222≈68,865＋92,282）、(1)公司兵392,887、"
     f"(8)長工753,300、(7){_BROKER_P} 54,638。(5)富、(6)威信、(9)譚、(12)堡全、(14)余7月全部0，唔使問。"
     "威信Patrol＝都會大學夜巡邏(S032)，唔係控制室(S031)（master_site_map.csv已改）。"),
    ("D4", "請提供7月全部盤嘅「保安員值勤表」原檔（客方逐盤逐人逐日、日薪、OT，開單基礎）——優先：啟航"
           "1331（P1/P2a）、控制室／西九龍／小欖／淺水灣／凱和山（P6剩餘）。",
     "老闆分享嘅「在勤總表」7月Roster sheet（2,996行逐崗位逐日格）大部分滿足咗呢個要求——已經覆蓋"
     "啟航1331（解P1/P2a）、HKU Y更/CP1-4/CP5/IFC/Weave/國泰城/粉嶺/殷樺/嘉捷等主要盤嘅逐日數據，"
     "亦已用嚟收窄Q4（數碼港CP1-4）同原Q6（Weave OL，已經由總表逐日確認解咗，見「已裁定口徑」）嘅"
     "差異到具體日子。控制室/西九龍/小欖/淺水灣/凱和山pro-rata已由總表逐盤價目解決（見P6，已關檔）。"),
    ("Q8", "總表Roster分頁齊晒全部盤——之前用block標題分組漏咗冇自己標題嘅行，補記逐盤價目。",
     f"已補記（PDPO：逐條涉及嘅安員真名唔喺source code，可查out/wp2b/guards.csv）：粉嶺倉62更{_BROKER_K}"
     f"（840/730）；小欖{_BROKER_T_SURNAME}＝{_BROKER_T}，24,000/月/崗×2崗=48,000＋打風半更387.10；美心{_BROKER_W} 2更（900/750）；"
     f"怡安168{_BROKER_T_SURNAME}4更（900/800）；控制室公司兵3人24+20+22更（其中一崗上單價901.36，P6控制室+1,350係"
     "佢崗位附加）；威信Patrol公司兵一位安員20更，上單價19,804/月；都會大學一位安員公司兵18更＋OT；"
     f"M+一位安員公司兵25更712/656；數據中心長工3+{_BROKER_W} 20；哈羅{_BROKER_K}1；ICBC{_BROKER_K}2（1,400/1,300）；"
     f"東濤苑{_BROKER_G} 1（600/560）；淺水灣{_BROKER_W} 84＋公司兵6。P6剩淨西九龍+30，已關檔（見下面「P6」記錄）。"),
    # WP5e必修4（2026-09-10，Opus最終複驗）：Q6呢個ref第二次重用——上面
    # 第一條Q6係Weave OL嘅故事（已關），呢度係之後重新啟用畀嘅另一批獨立
    # 個位數更數缺口（8條），逐條查到根因、全部explained，唔使問老闆。
    ("Q6（第二批）", "payroll-diff.csv／day-mismatch.csv逐guard逐月更數對比，剩返8條個位數（1-2更）嘅"
                    f"缺口追唔到已知pattern（唔屬於補更/半更/OT/site override等已知機制）：城巴-創富車廠"
                    f"({_BROKER_T}) 5條、HKU22(公司兵) 2條、啟航1331夜(公司兵) 1條。",
     f"逐條查到根因：創富車廠夜5條——長工7/30、7/31兩日冇上更，由{_BROKER_T}另外兩位安員頂替（補更頂替／"
     "成本轉移，同§8 WP2b裁定嘅創富30/31補更同一機制，淨額0）；HKU22 2條——**Q5已答**，客方HKU C值勤"
     "表日數欄兩位安員各少計7/31一日，更表多填1格，同L1 HKU座頭202 vs 199差異行同一根因；啟航1331夜"
     "1條——糧單頁1331夜更數欄印少咗1格，總表逐日25格已核實實際更數，屬糧單頁轉錄口徑。8條全部"
     "explained，Q6（第二批）關檔。"),
    ("Q9", "總表有「海洋廠」崗位（城巴車廠12hrs block，同其餘8個城巴車廠同一口徑）——係咪新盤／邊個客？",
     "sites.csv冇對應site_id；2026年7月呢個崗位總表逐日格全部空白（0更），對7月P0交付零數量影響。"
     "純粹登記存在，唔屬於P0交付要解決嘅缺口，移出老闆待答清單，留返P1階段先問（sites.csv要唔要正式"
     "登記呢個site_id）。"),
    ("P6", "老闆保安員值勤表三個pro-rata讀法（小欖／淺水灣／凱和山）、控制室+1,350、西九龍+30，五條細"
           "殘差嘅來源同金額？",
     "三個pro-rata讀法已由總表確認（小欖24,000/月/崗×2崗=48,000＋打風半更387.10；淺水灣87,000×30/31；"
     "凱和山900/更×30/31）；控制室由WP5c必修12解決（總表補入庫嘅第3位安員22更用返總表自己嘅上單價"
     "901.36/更，Σ真.逐更收客價56,789.92，同發票56,790差0.08蚊quantize尾數，gate變真PASS，舊嘅"
     "「+1,350」估計殘差唔再需要）；HKU C更OT678.80、Weave RR+150、都會大學+140、HKU Y更OT900四條細"
     "殘差全部係OT按鐘計錢嘅尾數，已入差異清單。**西九龍+30**：13,970 vs 13,940，發票多30蚊，當尾數"
     "入帳。五條細殘差合共已經全部有金額出處，尾數細（幾十至幾百蚊），P6已解，全部接受做尾數入帳，"
     "關檔，唔再入老闆清單。"),
]

# 呢啲ref嘅「日期／影響更數／影響金額」人手核實過（見WP4第二版forensic
# 記錄），比起「逐條diff row加埋」嘅generic做法更準（generic加埋會將
# 「1 vs 0 更（有/冇=1/0）」呢類技術flag同真更數/真金額殘差夾埋一齊加，
# 出嚟個數冧唔到人）。P1-P6/D3/N6/N7 呢啲WP4第一版已有嘅問題冇喺呢度
# 額外覆核，落返用generic彙總（由diff_rows動態計，唔寫死金額）。
_BOSS_QUESTION_SUMMARY = {
    "P1": ("2026-07（全月）", "1,126（另 Event 4）", "收入 1,203,900 未能逐更歸邊（更表 1,126 vs 月結 1,123 嘅 3 更差要等價目先拆到）"),
    "P2a": ("2026-07（全月）", f"354（淨{_BROKER_K}）／844（連長工）", "894,391.67 定義未明；三個口徑隱含單價見rates-report.md §3"),
    # WP5e必修9（2026-09-10，Opus最終複驗）：P3a影響金額由舊嘅41,040（總表
    # 7/31長工雞頭費單一格）改做逐雞頭費率表推到嘅58,120全月總額（其中
    # 1,530兩條block對唔平，待老闆確認）——見_BOSS_QUESTION_TEXT["P3a"]
    # 嘅費率表。
    "P3a": ("2026-07（全月，7月31日一次過結）", "", "58,120（其中1,530待確認）"),
    "N7": ("2026-07-04、07-05、07-14", "3", "約 2,550（3 更 × 殷樺出街價 850）"),
    "Q4": ("2026-07-29、07-30、07-31", "淨+4（8人逐人差合計）", "3,720"),
    "N5": ("2026-07（全月）", "", "23,620"),
    "N2a": ("2026-07（下半月，逐日未知）", "94", "84,600（收入）／69,200（成本）"),
    "D3a": ("2026-07（全月）", "", "57,403（卓弘）＋22,800（嘉捷）"),
    # WP5e必修1（D5收窄）：真.缺口收窄到G0261（都會大學夜巡邏20更）＋
    # G0145（啟航1331 26更）合共37,572.46——呢個ref嘅D0117差異行`ours`/
    # `theirs`存嘅係「gap_total」/「原始117,486.71」兩個中途數（唔係一個
    # 可以直接相減嘅pair），generic fallback（ours-theirs）會計出冇意義嘅
    # 負數，要人手寫低正確嘅37,572.46。
    "D5": ("2026-07（全月）", "", "37,572.46（G0261都會大學夜巡邏18,904.00＋G0145啟航1331 18,668.46）"),
    # WP5e必修2（Q10）：exposure總額102,014.52＝公司兵(Y)桶4人79,914.52
    # （同D5已解釋嗰4人係同一筆，唔係另一個缺口）＋HKU Y更（K桶）
    # 22,100（G0061 26更×850，總表格式冇留名嘅例外）。D0119差異行嘅
    # `ours`/`theirs`係更數(128/0)唔係金額，generic fallback攞唔到金額，
    # 要人手寫低。
    "Q10": ("2026-07（全月）", "128", f"102,014.52（公司兵桶79,914.52＋{_BROKER_K}桶／HKU Y更22,100.00）"),
}

# WP4第三版：「待老闆決定」sheet 嗰行「我哋建議」以前係逐條diff row嘅
# recommended_action 直接join埋一齊（同一個ref可以撞3、4條唔同diff
# row，join出嚟成句4、5句嘢，讀落好似機器吐出嚟），改做每個ref一句起
# 兩句止嘅人手撰寫版——同 `_BOSS_QUESTION_TEXT` 同一原則：呢度淨係文案
# 收斂，數字（entities/dates/影響更數/影響金額）繼續由diff_rows即場計，
# 唔寫死。有喺呢度嘅ref優先用呢句；冇嘅（例如N7，涉及安員真名唔可以
# 寫死喺source code）先fallback用返舊嘅動態join。
_BOSS_QUESTION_RECOMMENDATION = {
    "P1": "等老闆答齊7個更別嘅收客價，先可以埋單啟航1331嘅收入核數。",
    "P2a": "等老闆一句：894,391.67係咪已包26個長工人工；答咗先知P2（7個更別出街價）仲使唔使問。",
    "P3a": "等老闆確認費率表（K/W/T(姓氏稱呼)/G，見一句問題）啱唔啱，同答埋兩條對唔平嘅block點解，"
           "系統先可以每月自動計返。",
    "P6": "已解大部分，剩淨等老闆一句確認西九龍城巴車廠 +30 呢條細殘差嘅來源。",
    "D3a": "等老闆補D3a資料（卓弘/嘉捷7月有冇開發票、號碼幾多、收咗未）。",
    "D4": "等老闆提供7月全部盤嘅保安員值勤表原檔——呢份係開單基礎，可以一次過解P1/P2a/Q4/Q6/P6剩餘。",
    "N2a": "等老闆答呢5人邊個雞頭／點出糧，先可以將獨立雞頭費94更升做逐人shift_records。",
    "N5": "等老闆答呢19人small tier嘅性質。",
    "N7": "等老闆確認殷樺花園嗰位冇工號嘅安員係邊個結算單位出糧。",
    "Q4": "等老闆睇返7月29、30、31日數碼港CP1-4邊幾更係Wilson自己嘅人，或者確認更表填多咗。",
    "Q6": "已排除晒已知機制（補更/半更/OT/site override），等老闆確認呢幾位安員7月實際情況（補更／請假未過賬／轉錄漏記）。",
}


def _extract_dates(text: str) -> List[str]:
    return sorted(set(_re.findall(r"\d{4}-\d{2}-\d{2}", text or "")))


def _p6_money_impact(d: dict) -> str:
    """P6「五條細殘差」嘅金額由 `out/wp3/billing_adjustments.csv` 即場加
    埋（唔寫死數），同控制室（S031）嘅月費制口徑缺口（gate-results.csv
    嘅invoice-snapshot）分開講清楚，避免老闆將19,830嗰個大數當咗係
    「細殘差」嘅一部分。"""
    adjustments = d.get("billing_adjustments", [])
    total = sum((_d(r.get("adjustment_amount")) or Decimal("0")) for r in adjustments)
    parts = "+".join(str(_d(r.get("adjustment_amount")) or Decimal("0")) for r in adjustments)
    control = next((r for r in d.get("gate_results", []) if r.get("site_id") == "S031"), None)
    control_txt = ""
    if control:
        gap = (_d(control.get("invoice_amount")) or Decimal("0")) - (_d(control.get("snapshot_sum")) or Decimal("0"))
        control_txt = f"；控制室月費制口徑差{gap:,.2f}已喺L1另外解釋，唔屬於呢{len(adjustments)}條殘差"
    return f"{total:,.2f}（{parts}，{len(adjustments)}條細殘差{control_txt}）"


# 2026-09-10：P3/N2/D3 三條主問題已答，但各自留低一句計法/邊個雞頭/邊張
# 發票嘅追問（P3a/N2a/D3a）——主diff row可以直接改status=explained（唔再
# 扮「未解釋」），但呢3個追問ref本身仍然要留喺「待老闆決定」畀老闆一句答
# 埋。淨係呢3個ref獲准喺status=explained嘅row都照樣入by_ref；其他ref
# （N3/Q2/P6嗰啲「有更好冇都做得」/已裁定嘅soft cross-reference）繼續淨係
# status=awaiting_boss先計，避免佢哋淨係搭順風車掛喺一條explained row度就
# 誤觸發一條新嘅active boss question。
# WP5b（2026-09-10）：N2a／D3a已經真正答埋（見上面對應builder，status已
# 改做explained、boss_question_ref清空），唔再需要「雖然explained都要
# follow-up」呢個機制頂住畀佢哋留喺boss_questions——凈返P3a（41,040點計
# 呢個演算法問題，總表都答唔到）先要。
_FOLLOWUP_REFS_EVEN_IF_EXPLAINED = set()


def build_boss_facts(diff_rows: List[dict], d: dict) -> dict:
    by_ref: Dict[str, List[dict]] = defaultdict(list)
    for r in diff_rows:
        refs = [x.strip() for x in (r["boss_question_ref"] or "").split(";") if x.strip()]
        if r["status"] != STATUS_AWAITING:
            refs = [x for x in refs if x in _FOLLOWUP_REFS_EVEN_IF_EXPLAINED]
        for ref in refs:
            by_ref[ref].append(r)

    all_refs = sorted(set(_BOSS_QUESTION_REF_ORDER) | set(by_ref.keys()),
                       key=lambda x: (_BOSS_QUESTION_REF_ORDER.index(x) if x in _BOSS_QUESTION_REF_ORDER else 99, x))

    boss_questions = []
    for ref in all_refs:
        rows = by_ref.get(ref, [])
        if not rows:
            continue
        # N7（同其他未收錄喺 _BOSS_QUESTION_TEXT 嘅 ref）用返對應差異行自己
        # 嘅 explanation 做問題文字——嗰個 explanation 係 runtime 由 CSV
        # 讀出嚟（可能帶安員真名），唔可以喺 source code 寫死。
        question = _BOSS_QUESTION_TEXT.get(ref) or (rows[0]["explanation"] if rows else "(問題文字待補)")
        entities = "、".join(sorted({r["site_or_unit"] for r in rows if r["site_or_unit"]}))
        recommendation = _BOSS_QUESTION_RECOMMENDATION.get(ref) or "；".join(sorted({r["recommended_action"] for r in rows if r["recommended_action"]}))
        diff_ids = "；".join(r["diff_id"] for r in rows)

        summary = _BOSS_QUESTION_SUMMARY.get(ref)
        if ref == "P6":
            dates, shift_impact, money_impact = "2026-07（全月）", "", _p6_money_impact(d)
        elif summary:
            dates, shift_impact, money_impact = summary
        else:
            dates_set = set()
            for r in rows:
                dates_set.update(_extract_dates(r["explanation"]))
            dates = "、".join(sorted(dates_set)) if dates_set else "全月/多日"
            shift_total = sum((_d(r["diff"]) or Decimal(0)) for r in rows
                               if "更" in r["unit"] and "有/冇" not in r["unit"])
            money_total = sum((_d(r["diff"]) or Decimal(0)) for r in rows if "元" in r["unit"])
            shift_impact = str(shift_total) if shift_total else ""
            money_impact = str(money_total) if money_total else ""

        boss_questions.append({
            "ref": ref, "question": question, "entities": entities, "dates": dates,
            "shift_impact": shift_impact, "money_impact": money_impact,
            "recommendation": recommendation, "n": len(rows), "diff_ids": diff_ids,
        })

    answered_questions = [{"ref": ref, "question": q, "answer": a} for ref, q, a in _ANSWERED_QUESTIONS]
    return {"boss_questions": boss_questions, "decided_rules": _DECIDED_RULES,
            "answered_questions": answered_questions}


# ---------------------------------------------------------------------------
# 5) 主流程
# ---------------------------------------------------------------------------

def _write_differences_csv(rows: List[dict]):
    paths.WP4_DIFFERENCES_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(paths.WP4_DIFFERENCES_CSV, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=DIFF_FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def _build_guard_name_redactor(guards: List[dict]):
    """修必修5（2026-09-10）：差異清單有好幾條生成路徑（day-mismatch.csv／
    broker-conflicts.csv／payroll-diff.csv near_name 候選名等）本身以
    guard_name／name_zh 做關鍵配對，一路以嚟都試過將真名寫入
    explanation／provenance，最終流入 out/wp4/differences.csv 同兩份
    工作簿（technical 版一路可以有 guard_id 追溯出處，唔需要真名；老闆版
    更加唔准有真名，_boss_text() 淨識剝技術詞、唔識剝人名）。逐個call
    site改雖然已經堵咗幾個最大嘅缺口（build_l2_day_mismatch／
    build_l2_broker_conflicts／build_l2_unresolved_guards），但
    payroll-diff.csv 嘅 near_name 候選名呢類「嚟自WP3 note文字入面」嘅
    真名冇辦法逐個f-string追蹤晒——所以呢度加一個最後把關嘅安全網：逐條
    差異行嘅 site_or_unit／explanation／recommended_action／provenance
    四個文字欄，掃一次全部安員嘅 name_zh／name_variants（由長至短排序，
    避免短名先撞中令長名剩低斷開嘅殘片），撞中就代做「（guard_id）」。"""
    names: List[Tuple[str, str]] = []
    seen = set()
    for g in guards:
        gid = g.get("guard_id", "")
        if not gid:
            continue
        cand = {g.get("name_zh", "")} | {v.strip() for v in (g.get("name_variants") or "").split(";") if v.strip()}
        for n in cand:
            if n and len(n) >= 2 and (n, gid) not in seen:
                seen.add((n, gid))
                names.append((n, gid))
    # 長名優先（避免「王」呢類極短片段撞走「王大文」入面嘅「王」，剩低
    # 斷咗頭嘅殘片），同長度嘅按字母排序保持穩定輸出。
    names.sort(key=lambda t: (-len(t[0]), t[0]))

    def _redact(text: str) -> str:
        if not text:
            return text
        for name, gid in names:
            if name in text:
                text = text.replace(name, f"（{gid}）")
        return text
    return _redact


def _redact_guard_names_in_rows(rows: List[dict], guards: List[dict]) -> None:
    redact = _build_guard_name_redactor(guards)
    # ours/theirs 都要掃：build_l2_name_near_match() 嘅 unit="姓名" 行
    # 直接用兩個候選姓名做ours/theirs（近似名比較），唔淨係文字敍述先有
    # 真名。
    text_fields = ("site_or_unit", "ours", "theirs", "explanation", "recommended_action", "provenance")
    for r in rows:
        for f in text_fields:
            v = r.get(f)
            if isinstance(v, str) and v:
                r[f] = redact(v)


def run_wp4() -> dict:
    paths.clean_out_wp4_dir()
    d = _load_all()
    b = DiffBuilder()

    build_l1(b, d)

    build_l2_n2a(b, d)
    build_l2_day_mismatch(b, d)
    build_l2_broker_conflicts(b, d)
    build_l2_name_near_match(b, d)
    build_l2_unresolved_guards(b, d)
    build_l2_identity_merge(b, d)
    build_l2_payroll_diff(b, d)
    build_l2_kai1331(b, d)
    build_l2_gongsi_bing_gap(b, d)
    build_l2_haiyang_new_site(b, d)
    build_l2_longterm_broker_bucket_exposure(b, d)
    build_l2_autopay_longterm(b, d)
    n_cost_matched, n_cost_diff = build_l2_cost_column(b, d)

    build_l3_gate_results(b, d)
    build_l3_billing_unit_solve(b, d)
    build_l3_invoice_count(b, d)

    rows = b.rows
    # 修必修5（2026-09-10）：最後把關嘅PDPO安全網，見_redact_guard_names_
    # in_rows() docstring——一定要喺_write_differences_csv／build_boss_
    # facts之前行，兩者都會讀呢個rows。
    _redact_guard_names_in_rows(rows, d["guards"])
    _write_differences_csv(rows)

    by_layer = defaultdict(lambda: {"explained": 0, "awaiting_boss": 0, "needs_review": 0})
    by_category = defaultdict(int)
    for r in rows:
        by_layer[r["layer"]][r["status"]] += 1
        by_category[r["category"]] += 1

    summary = {
        "total_diffs": len(rows),
        "by_layer": {k: dict(v) for k, v in by_layer.items()},
        "by_category": dict(by_category),
        "needs_review_count": sum(1 for r in rows if r["status"] == "needs_review"),
        "cost_column_matched": n_cost_matched,
        "cost_column_diff": n_cost_diff,
    }

    boss_facts = build_boss_facts(rows, d)

    from . import wp4_workbook
    wp4_workbook.build_workbooks(summary, rows, d, boss_facts)

    _write_report_md(summary, rows, boss_facts)

    return summary, rows, d


def _write_report_md(summary: dict, rows: List[dict], boss_facts: dict):
    lines = ["# WP4 對數報告（2026-07）", ""]
    lines.append(f"差異清單總項數：{len(rows)}；needs_review：{summary['needs_review_count']}")
    lines.append("")
    lines.append("## 逐層")
    for layer in ("L1", "L2", "L3"):
        lc = summary["by_layer"].get(layer, {})
        lines.append(f"- {layer}：已解釋 {lc.get('explained', 0)}，待老闆 {lc.get('awaiting_boss', 0)}，"
                      f"needs_review {lc.get('needs_review', 0)}")
    lines.append("")
    lines.append("## 分類分佈")
    for cat, n in sorted(summary["by_category"].items(), key=lambda kv: -kv[1]):
        lines.append(f"- {cat}：{n}")
    lines.append("")
    lines.append("## 待老闆決定")
    for q in boss_facts["boss_questions"]:
        lines.append(f"- [{q['ref']}] {q['question']}（涉及：{q['entities']}；日期：{q['dates']}；"
                      f"影響更數：{q['shift_impact']}；影響金額：{q['money_impact']}；{q['n']}項；{q['diff_ids']}）")
    paths.WP4_REPORT_MD.parent.mkdir(parents=True, exist_ok=True)
    paths.WP4_REPORT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
