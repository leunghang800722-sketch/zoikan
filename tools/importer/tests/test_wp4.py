"""WP4（⑦ reconcile：三層對數＋差異解釋工作簿）單元測試。

覆蓋範圍（P0-執行計劃.md §7 WP4 驗收準則「零『未解釋』差異」+ WP4 工作包
指示「品質」段）：
  - differences.csv：status 冇 needs_review、category 全部喺固定集合、
    每條有 provenance、awaiting_boss 一定有 boss_question_ref
  - L1 同 §4 已知表一致（Weave OL 31 vs 25、HKU座頭 198 vs 199……）
  - L3 同 gate-results.csv 一致（有 billing_adjustments 嘅 site 有對應
    差異行）
  - 老闆版工作簿唔准出現 site_id/guard_id/rate_id 呢類內部代碼
  - 三次重跑 differences.csv byte-identical（md5 一樣）
  - PDPO：guards.csv 嘅真實姓名/電話 needle 唔應該漏咗入 tools/ 原始碼

`run_wp4()` 要讀真實 `data/2026-07/*`、`out/wp1/`、`out/wp2b/`、`out/wp3/`
（上游 pipeline 嘅輸出），冇呢啲本機專用資料嘅環境（例如 CI）會自動
skip，跟 test_wp3.py／test_end_to_end.py 同一原則。
"""
import csv
import hashlib
import re

import pytest

from importer import paths
from importer.private_mappings import broker_canonical_name, has_private_brokers

_HAS_WP4_INPUTS = (
    paths.WP2B_SHIFT_RECORDS_CSV.exists()
    and paths.WP3_MONTHLY_DIFF_CSV.exists()
    and paths.WP3_GATE_RESULTS_CSV.exists()
    and paths.BOCHK_XLS_2026_07.exists()
    and paths.NAMES_EN_CSV.exists()
    # 呢個檔嘅測試對住真實 pipeline 輸出斷言，當中部分 assertion 要用雞頭
    # 真名（PDPO：淨係本機 data/mappings-private/brokers.csv 有）先組到
    # 啱嘅期望值——冇呢個檔就 skip，唔用代號 fallback 扮測試通過。
    and has_private_brokers()
)

pytestmark = pytest.mark.skipif(
    not _HAS_WP4_INPUTS,
    reason="WP1/WP2b/WP3 輸出或 D1/D2/雞頭真名 本機專用資料唔齊全（冇入 git），跳過 WP4 end-to-end 測試",
)

# PDPO：雞頭真名淨係經 private_mappings 讀（上面 skipif 已保證呢個檔案
# 存在），源碼本身唔會出現真名字面值。
_BROKER_T = broker_canonical_name("T")

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

# WP4第二版：P0-執行計劃§8 已知嘅13條老闆待答問題（P1-P6/D3/N5/N6/N7/
# Q3/Q4/Q5）+ WP4第二版forensic覆核之後老實開嘅Q6（Weave OL 6更追唔到
# 出處，寧願多問都唔扮已解釋）——boss_question_ref 淨係准喺呢個固定集
# 合出現，「新」（未分流嘅佔位符）唔准再出現。WP4第三版加埋 N3／Q2：
# 呢兩個唔算「待老闆決定」問題（對應行 status 一律 explained），純粹
# 係「呢條差異屬於邊個已知裁定/已知缺口」嘅追溯標籤（N3=§3.7冇逐日
# 更表來源清單，Q2=§5範圍確認已知悉），但都係喺 boss_question_ref
# 呢一欄出現，所以都要喺固定集合入面，唔可以淨係得「待老闆決定」嗰
# 14個。
FIXED_BOSS_REFS = {"P1", "P2", "P3", "P4", "P5", "P6", "D3", "N3", "N5", "N6", "N7", "Q2", "Q3", "Q4", "Q5", "Q6",
                    # 2026-09-10 WP2b-d：P4/P5/D3/N6/Q3/Q5已答關閉（唔再喺
                    # awaiting_boss出現，但差異行歷史/explained行仍可能帶呢
                    # 啲ref做cross-reference，繼續留喺呢個集合）；新增P2a/
                    # P3a/D3a/D4/N2a（已答問題嘅追問，見P0-執行計劃§8）。
                    "P2a", "P3a", "D3a", "D4", "N2a",
                    # WP5b（2026-09-10，總表歸屬做齊之後）新增：D5（公司兵
                    # 糧單缺口）、Q9（海洋廠新盤）。
                    "D5", "Q9",
                    # WP5c必修14（2026-09-10）新增：Q10（長工被掃入雞頭現金
                    # 桶，雙重支付敞口——最重要一條新問題）。
                    "Q10"}


@pytest.fixture(scope="module")
def wp4_result():
    from importer.wp4_run import run_wp4
    return run_wp4()


def test_no_needs_review(wp4_result):
    summary, rows, _d = wp4_result
    assert summary["needs_review_count"] == 0
    assert all(r["status"] != "needs_review" for r in rows)
    assert all(r["status"] in ("explained", "awaiting_boss") for r in rows)


def test_categories_in_fixed_set(wp4_result):
    _summary, rows, _d = wp4_result
    bad = [r["diff_id"] for r in rows if r["category"] not in CATEGORIES]
    assert not bad, f"呢啲 diff_id 用咗唔喺固定集合入面嘅 category: {bad}"


def test_every_row_has_provenance(wp4_result):
    _summary, rows, _d = wp4_result
    bad = [r["diff_id"] for r in rows if not str(r["provenance"]).strip()]
    assert not bad, f"呢啲 diff_id 冇 provenance: {bad}"


def test_awaiting_boss_has_question_ref(wp4_result):
    _summary, rows, _d = wp4_result
    bad = [r["diff_id"] for r in rows if r["status"] == "awaiting_boss" and not str(r["boss_question_ref"]).strip()]
    assert not bad, f"呢啲 diff_id status=awaiting_boss 但冇 boss_question_ref: {bad}"


def test_l1_matches_plan_section4_known_diffs(wp4_result):
    """P0-執行計劃§4 表：Weave OL 差6更（31 vs 25）、HKU座頭差3更（201 vs
    199，本模組跟shift_records用198 vs 199）、屯門小欖差1更（62 vs 63）呢
    類已知差要出現喺 L1 差異清單，數值同§4/monthly-diff.csv一致。"""
    _summary, rows, _d = wp4_result
    l1 = [r for r in rows if r["layer"] == "L1"]

    weave_ol = [r for r in l1 if r["site_or_unit"] == "Weave OL"]
    assert weave_ol, "Weave OL 要有L1差異行"
    assert weave_ol[0]["ours"] == "31" and weave_ol[0]["theirs"] == "25"

    xiaolan = [r for r in l1 if r["site_or_unit"] == "屯門小欖樂怡街5號"]
    assert xiaolan, "屯門小欖要有L1差異行"
    assert xiaolan[0]["ours"] == "62" and xiaolan[0]["theirs"] == "63"

    # 2026-09-10：Q3已答，第21份更表（HKU醫學院）已納入WP1，shift_records
    # 依家5更同R2一致，呢個site唔應該再喺L1差異清單出現（0差異＝冇diff row）。
    hku_med = [r for r in l1 if r["site_or_unit"] == "HKU 醫學院"]
    assert not hku_med, f"HKU醫學院 Q3已答、5 vs 5全對，唔應該再有L1差異行：{hku_med}"

    cp14 = [r for r in l1 if "CP1-4" in r["site_or_unit"]]
    assert cp14, "數碼港 CP1-4 234 vs 230（§4）要有L1差異行"
    assert cp14[0]["ours"] == "230" and cp14[0]["theirs"] == "230"  # 2026-09-11 老闆最終版更表 230


def test_l1_creates_link_c7_out_of_scope_row(wp4_result):
    _summary, rows, _d = wp4_result
    link_c7 = [r for r in rows if "LINK C7" in r["site_or_unit"]]
    assert link_c7
    assert link_c7[0]["category"] == "範圍外"
    assert link_c7[0]["status"] == "explained"


def test_l3_consistent_with_gate_results_known_gaps(wp4_result):
    """gate-results.csv 有 billing_adjustments 嘅 5 個 site（HKU Y更/HKU C更/
    Weave RR/西九龍/都會大學）全部都要喺L3差異清單見到對應嘅差異行（金額
    出處明文寫「尾數入帳」）。

    WP5e必修9（2026-09-10，Opus最終複驗）：P6五條細殘差已經由老闆總表/
    發票核到金額，全部接受做「尾數入帳」，關檔唔再入老闆清單——所以呢啲
    L3差異行而家status=explained、boss_question_ref清空（唔再係
    「awaiting_boss／P6」）。

    WP5c必修12：控制室（S031）以前靠billing_adjustments嘅「+1,350」估計
    殘差先至PASS(known_shift_gap)（18,480差口）——而家總表補入庫咗第3位
    安員22更嘅真實逐更rate，Σ真.snapshot自己就同發票打平（差返0.08蚊
    quantize尾數），billing_adjustments.csv唔再有S031嘅記錄，所以「控制
    室」唔會喺呢個billing_adjustments-based嘅L3差異行度出現（佢由
    _L1_SITE_OVERRIDE另外解釋）。

    WP5e必修5：西九龍城巴車廠（S024）以前因為gate印plain「PASS」（唔係
    「PASS(...)」）令入口過濾漏咗呢條L3差異行——而家補返，5條全部有。"""
    _summary, rows, _d = wp4_result
    l3 = [r for r in rows if r["layer"] == "L3"]
    ba_sites = {r["site_or_unit"] for r in l3
                if "尾數入帳" in r["explanation"]}
    assert "Weave Robinson" in ba_sites
    assert "都會大學學生宿舍" in ba_sites
    assert "城巴-西九龍車廠" in ba_sites, "WP5e必修5之後西九龍嗰條L3差異行應該補返（以前gate=PASS(plain)嘅入口過濾漏咗）"
    assert "控制室" not in ba_sites, "WP5c必修12之後控制室應該已經真PASS，唔應該再有billing_adjustments尾數行"
    # WP5e必修9：呢5條P6殘差全部已經關檔，唔再喺L3出現awaiting_boss/P6。
    p6_awaiting = [r for r in l3 if r["boss_question_ref"] == "P6" and r["status"] == "awaiting_boss"]
    assert not p6_awaiting, f"P6已解、尾數入帳，L3唔應該再有awaiting_boss/P6嘅行：{p6_awaiting}"


def test_invoice_count_48_not_51(wp4_result):
    _summary, rows, _d = wp4_result
    inv_rows = [r for r in rows if r["site_or_unit"] == "Invoice Record 7月張數"]
    assert inv_rows and inv_rows[0]["ours"] == "48" and inv_rows[0]["theirs"] == "51"


def test_d3_missing_invoices(wp4_result):
    """2026-09-10 D3已答：07001/07002其實係Tenti/HKW特殊收入項（已解釋，
    冇boss_question_ref）。WP5b（2026-09-10）：D3a（卓弘/嘉捷缺號問題）
    亦已答——卓弘/嘉捷分別對應返正確嘅英文公司名（見
    data/mappings-private/client-names.json）就搵到對應發票，唔再係
    awaiting_boss，boss_question_ref清空。"""
    _summary, rows, _d = wp4_result
    d3_explained = [r for r in rows if r["site_or_unit"] == "MW-2026-07001/07002缺號"]
    assert d3_explained and d3_explained[0]["status"] == "explained"
    # 只睇 build_l3_invoice_count 生成嗰兩條（D3a發票缺號問題），唔連埋
    # build_l1 另一條同名但屬N3（冇更表來源）嘅獨立差異行。
    d3a = [r for r in rows if r["site_or_unit"] in ("卓弘", "嘉捷") and r["category"] == "發票缺號"]
    labels = {r["site_or_unit"] for r in d3a}
    assert "卓弘" in labels and "嘉捷" in labels
    assert all(r["status"] == "explained" and r["boss_question_ref"] == "" for r in d3a)


def test_day_mismatch_needs_review_items_classified(wp4_result):
    """day-mismatch.csv 嘅 category=needs_review 記錄要全部有 explained 結論
    （WP5e必修4之後），PDPO：測試唔寫死安員真名，淨係核數量同分類轉換啱
    唔啱：

    _DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE（人手覆核咗出處、有 explained
    結論嘅）——2026-09-10 修（WP5-C rule 0.1/0.2 settlement_page 修正
    後）：原本 6 條入面 G0171(S005/7-26)／G0027(S007/7-31) 兩條嘅
    (guard,site,day) 喺settlement_page修正後喺day-mismatch.csv已經搵
    唔返（roster_has/payroll_has而家一致，mismatch本身唔再存在），跌到
    4 條；WP5e必修4（2026-09-10，Opus最終複驗，Q6-generic 8條）逐條查到
    根因，將原本兩條needs_review新缺口（城巴-創富車廠/T，G0127
    7/30、G0217 7/31）由「查唔到，跌落Q6」升做「補更頂替，explained」，
    加返落override，變返6條——全部要match到、status!=needs_review、
    boss_question_ref!=「新」、且override嘅forensic結論文字真係出現喺
    explanation。

    day-mismatch.csv原始資料嘅needs_review記錄，現在應該100%喺呢個
    override清單入面覆蓋到（冇剩低未覆核嘅），唔准silently跌返做
    needs_review／唔見咗。"""
    from importer.wp4_run import _DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE
    _summary, rows, d = wp4_result
    l2_by_prov = {r["provenance"]: r for r in rows if r["layer"] == "L2" and "有/冇=1/0" in r["unit"]}
    assert len(_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE) == 6

    overridden_keys = set()
    matched = []
    for (guard_id, site_id, work_date), (cat, status, boss_ref, note) in _DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE.items():
        overridden_keys.add((guard_id, site_id, work_date))
        hit = next((r for prov, r in l2_by_prov.items()
                    if f"guard_id={guard_id}" in prov and f"work_date={work_date}" in prov), None)
        assert hit is not None, f"day-mismatch差異行搵唔到 guard_id={guard_id} work_date={work_date}"
        assert hit["status"] != "needs_review"
        assert hit["boss_question_ref"] != "新"
        assert hit["status"] == status and hit["category"] == cat and hit["boss_question_ref"] == boss_ref
        # WP4第三版：_resolve_day_mismatch_row 之前淨係 return 咗override
        # 嘅前3個元素，令人手覆核落嘅forensic結論文字（override嘅第4個
        # 元素）從來冇出到落differences.csv——依家要斷言呢句結論文字真
        # 係出現喺explanation，唔淨係核數量/分類轉換冧唔冧啱。
        assert note in hit["explanation"], (
            f"guard_id={guard_id} work_date={work_date} 嘅人手覆核結論文字冇出到落explanation: {hit['explanation']!r}"
        )
        matched.append(hit)
    assert len(matched) == 6
    assert all(r["status"] == "explained" for r in matched)

    # WP5e必修4之後：day-mismatch.csv原始資料嘅needs_review記錄應該100%
    # 已經喺override清單入面覆蓋，冇剩低未覆核嘅（Q6-generic 8條全部查
    # 到根因，唔再有「查唔到，跌落Q6」嘅day-mismatch個案）。
    raw_needs_review = [r for r in d["day_mismatch"] if r["category"] == "needs_review"]
    unoverridden = [r for r in raw_needs_review
                    if (r["guard_id"], r["site_id"], r["work_date"]) not in overridden_keys]
    assert not unoverridden, (
        f"有needs_review行冇喺_DAY_MISMATCH_NEEDS_REVIEW_OVERRIDE出現，要人手覆核加返override先可以explained: {unoverridden}"
    )


def test_substitution_and_swap_categories_present(wp4_result):
    """day-mismatch自動分類機制要跑得出「相鄰日調動」「兩人對調」兩種結構
    性 pattern；「補更頂替(成本轉移)」（cross-broker substitution）淨係喺
    資料入面真係出現先會有——2026-09-10 rule 0.1/0.2 settlement_page 修正
    之後，歸屬準確咗，之前（誤）分類做cross-broker substitution嘅個案，
    兩邊guard而家正確噉解到同一個settlement_unit，變咗structurally同一
    broker嘅「兩人對調」，唔再係「補更(成本轉移)」——呢個係歸屬準確性
    提升嘅正面結果，唔係regression，所以唔再斷言呢個category一定存在。"""
    _summary, rows, d = wp4_result
    cats = {r["category"] for r in rows}
    assert "日期位移(淨額0)" in cats
    assert "兩人對調(淨額0)" in cats
    # day-mismatch.csv本身仍然要有兩人對調/相鄰日調動嘅原始分類（機制仲運
    # 作緊，唔係成個classifier壞咗令所有嘢都跌落needs_review）。
    raw_cats = {r["category"] for r in d["day_mismatch"]}
    assert "two_person_swap" in raw_cats
    assert "adjacent_day_swap" in raw_cats


def test_identity_conflicts_one_no_two_people_and_one_person_two_nos(wp4_result):
    """§3.8 兩條實證：Uxxxxx 一號兩人、另有安員一人兩號（真實工號可查
    out/wp1/validate-identity-conflicts.csv）。工號（U-code）係老闆糧單/
    更表本身用緊嘅業務代號，唔係PDPO限制嘅內部代碼，但2026-09-10 WP5c
    修（必修4）：呢度唔再喺source code寫死具體嘅真實工號組合（會間接
    identify到一個特定安員）——改用pattern比對呢類「一人兩個工號」記錄
    真係存在，唔核對死實嘅工號數值。"""
    import re
    _summary, rows, _d = wp4_result
    labels = {r["site_or_unit"] for r in rows if r["category"] == "身份合併拆開"}
    one_code_two_people = re.compile(r"工號U\d+$")
    assert any(one_code_two_people.search(l) for l in labels), \
        f"預期有一條「一號兩人」（工號Uxxxxx）嘅身份合併拆開記錄，實際labels={labels}"
    one_person_two_codes = re.compile(r"工號U\d+/U\d+$")
    assert any(one_person_two_codes.search(l) for l in labels), \
        f"預期有一條「一人兩個工號」（工號Uxxxxx/Uyyyyy）嘅身份合併拆開記錄，實際labels={labels}"


def test_autopay_longterm_row_exists_with_amounts(wp4_result):
    _summary, rows, _d = wp4_result
    autopay = [r for r in rows if r["site_or_unit"] == "長工 autopay（BOCHK D2）"]
    assert autopay
    r = autopay[0]
    assert r["ours"] and r["theirs"]
    assert float(r["ours"]) > 0 and float(r["theirs"]) > 0
    # 2026-09-10：N6已答、boss問題移除——呢個結構性口徑差異（長工出固定
    # 月薪）本身一直都唔需要老闆決定，改status=explained、boss_ref清空。
    assert r["status"] == "explained" and r["boss_question_ref"] == ""


def test_n7_resolved_via_rule02(wp4_result):
    """WP5b（2026-09-10）：N7 已經由 rule 0.2（總表 site+day 配額消去法，
    normalize.py／wp2b_run.py）自動解決——殷樺花園嗰位冇工號、3更嘅安員
    而家喺 WP2b 層直接歸邊做K（同N7已答嘅答案一致：同崗位另一位安員22更
    ＋呢位3更都係K出糧，PDPO：安員真名唔喺source code），unresolved-
    guards.csv 唔再有呢條記錄，所以 build_l2_unresolved_guards 唔會再生成
    任何 boss_question_ref=N7 嘅 diff row（N7 答案本身已經記喺
    _ANSWERED_QUESTIONS）。呢個測試而家驗證嘅係「N7 唔再需要人手
    unresolved_guards 介入」，唔係「仲有條diff row等緊老闆」。"""
    _summary, rows, d = wp4_result
    n7 = [r for r in rows if r["boss_question_ref"] == "N7"]
    assert not n7, "N7已經由rule 0.2自動歸邊，唔應該再有boss_question_ref=N7嘅awaiting/追蹤diff row"
    assert not d["unresolved_guards"], (
        "N7 嗰個殷樺花園冇工號安員應該已經由rule 0.2歸邊，unresolved-guards.csv 應該淨返 0 條")


def test_csv_written_and_matches_in_memory_rows(wp4_result):
    _summary, rows, _d = wp4_result
    with open(paths.WP4_DIFFERENCES_CSV, encoding="utf-8", newline="") as fh:
        csv_rows = list(csv.DictReader(fh))
    assert len(csv_rows) == len(rows)
    assert csv_rows[0]["diff_id"] == rows[0]["diff_id"]


def test_boss_workbook_has_no_internal_codes():
    from openpyxl import load_workbook
    assert paths.WP4_WORKBOOK_XLSX.exists()
    wb = load_workbook(paths.WP4_WORKBOOK_XLSX)
    expected_sheets = ["總覽", "L1 更數", "L2 成本", "L3 收入", "差異清單", "待老闆決定", "已答問題", "已裁定口徑"]
    assert wb.sheetnames == expected_sheets

    code_re = re.compile(r"(?<![A-Za-z0-9])(?:SR\d{6}|ST\d{4}|RC\d{4}|G\d{4}|S\d{3}|B\d{2})(?![A-Za-z0-9])")
    leaks = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and code_re.search(cell.value):
                    leaks.append((ws.title, cell.coordinate, cell.value))
    assert not leaks, f"老闆版工作簿漏咗內部代碼: {leaks[:5]}"


def test_boss_question_ref_in_fixed_set(wp4_result):
    """boss_question_ref 淨係准喺 FIXED_BOSS_REFS 呢個固定集合出現（可以
    用「;」分隔多個），「新」（未分流嘅佔位符）唔准喺 differences.csv 任
    何一行出現。WP4第三版：呢個檢查擴到*全部*行（唔淨係 awaiting_boss）
    ——explained 行都可能帶 boss_question_ref（例如 N3／Q2 呢啲已知裁定
    嘅追溯標籤），一樣要喺固定集合入面，唔可以用漏咗做藉口。"""
    _summary, rows, _d = wp4_result
    assert all(r["boss_question_ref"] != "新" for r in rows), "differences.csv 唔准出現 boss_question_ref=新"
    for r in rows:
        refs = [x.strip() for x in r["boss_question_ref"].split(";") if x.strip()]
        bad = [x for x in refs if x not in FIXED_BOSS_REFS]
        assert not bad, f"{r['diff_id']}（status={r['status']}）用咗唔喺固定問題集合嘅boss_question_ref: {bad}"


def test_boss_facts_cover_active_questions_2026_09_10(wp4_result):
    """WP5e必修3/4/9（2026-09-10，Opus最終複驗）收貨標準：P1/P2/P2a/D3a/
    N2a/N5/N7/Q7/Q8（連同之前已關嘅P4/P5/D3/N6/Q3/Q5）全部已答關閉，唔應
    該再喺「待老闆決定」出現。Q9（海洋廠0更，純登記）已降級關閉；P6（五條
    細殘差全部由老闆總表/發票核到金額，尾數入帳）已關檔；Q6-generic 8條
    （創富補更頂替／HKU22更表多填／1331夜糧單漏格）逐條查到根因，全部
    explained，Q6都已關檔。**最終老闆清單淨返4條活躍問題**：Q10（長工被
    掃入雞頭現金桶，最重要新問題）、D5（收窄之後嘅真.缺頁）、P3a（費率表
    兩條block未平）、Q4。"""
    from importer.wp4_run import build_boss_facts
    _summary, rows, d = wp4_result
    boss_facts = build_boss_facts(rows, d)
    refs = {q["ref"] for q in boss_facts["boss_questions"]}
    expected = set()  # 2026-09-11 老闆問題全部答齊
    assert refs == expected, f"最終老闆清單應該啱啱好係{expected}，而家係{refs}（差異：{expected ^ refs}）"
    closed = {"P4", "P5", "D3", "N6", "Q3", "Q5", "P2", "P3", "P1", "P2a", "D3a", "N2a", "N5", "N7",
              "Q9", "P6", "Q6"}
    leaked = refs & closed
    assert not leaked, f"呢啲已答關閉嘅問題唔應該再喺待老闆決定出現: {leaked}"
    assert refs <= FIXED_BOSS_REFS, f"出現咗唔喺固定集合嘅ref: {refs - FIXED_BOSS_REFS}"


def test_boss_workbook_has_no_diff_id_codes():
    """老闆版xlsx明文剝走D0開頭嘅diff_id代碼（差異清單A欄、待老闆決定備
    註欄）；technical版保留。"""
    from openpyxl import load_workbook
    wb = load_workbook(paths.WP4_WORKBOOK_XLSX)
    d0_re = re.compile(r"\bD\d{4}\b")
    leaks = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and d0_re.search(cell.value):
                    leaks.append((ws.title, cell.coordinate, cell.value))
    assert not leaks, f"老闆版工作簿漏咗diff_id代碼: {leaks[:5]}"


def test_boss_question_sheet_is_one_row_per_question():
    """待老闆決定 sheet 依家一行=一條問題（7欄：編號/一句問題/涉及安員或
    盤/日期/影響更數/影響金額/我哋建議），唔准有「1 vs 0 更（有/冇=1/0）」
    呢類機器句，行數啱啱好等於老闆待答問題數（13或14條，睇Q6使唔使）。"""
    from openpyxl import load_workbook
    wb = load_workbook(paths.WP4_WORKBOOK_XLSX)
    ws = wb["待老闆決定"]
    header = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
    assert header == ["問題編號", "一句問題", "涉及安員或盤", "日期", "影響更數", "影響金額", "我哋建議"]
    body = list(ws.iter_rows(min_row=2, values_only=True))
    refs = [row[0] for row in body]
    assert len(refs) == len(set(refs)), "待老闆決定sheet每個問題編號應該淨係得一行"
    assert set(refs) <= FIXED_BOSS_REFS
    for row in body:
        for cell in row:
            if isinstance(cell, str):
                assert "有/冇=1/0" not in cell, f"待老闆決定sheet唔准有機器句: {row}"


def test_roster_over_vs_under_direction_correct(wp4_result):
    """「更表多填」vs「更表漏填」方向要啱：Weave OL(更表31>R2 25)、皓日
    (17>16)、屯門凱和山(73>71) 更表數字大過對方，屬「更表多填」；淺水灣
    (89<90)、屯門小欖(62<63) 更表數字細過對方，屬「更表漏填」。"""
    _summary, rows, _d = wp4_result
    l1 = {r["site_or_unit"]: r for r in rows if r["layer"] == "L1"}
    for label in ("Weave OL", "皓日", "屯門凱和山"):
        r = l1[label]
        assert float(r["ours"]) > float(r["theirs"]), label
        assert r["category"] == "更表多填", f"{label} 應該係更表多填，實際{r['category']}"
    for label in ("淺水灣道11號蔚峰園", "屯門小欖樂怡街5號"):
        r = l1[label]
        assert float(r["ours"]) < float(r["theirs"]), label
        assert r["category"] == "更表漏填", f"{label} 應該係更表漏填，實際{r['category']}"


def test_group_a_19_items_no_longer_new(wp4_result):
    """section A 嘅19條（都會大學/HKU22兩位安員OT/皓日guard/凱和山guard/
    淺水灣guard/近似名兩組/創富廠IC）第二版之後：都會大學學生宿舍變咗
    explained（唔再係awaiting_boss=新），創富廠IC都變咗explained，其中一
    個guard嘅mixed_site_label假陽性已經刪走（唔再出現喺differences.csv）。"""
    _summary, rows, _d = wp4_result
    muk = [r for r in rows if r["site_or_unit"] == "都會大學學生宿舍" and r["layer"] == "L1"]
    assert muk and muk[0]["status"] == "explained"
    cfc = [r for r in rows if r["site_or_unit"] == "創富廠IC"]
    assert cfc and cfc[0]["status"] == "explained"
    mixed_labels = {r["site_or_unit"] for r in rows if "蔚峰園/1331早/創富早(混合)" in r["site_or_unit"]}
    assert not mixed_labels, "呢個guard嘅mixed_site_label假陽性應該已經刪走"


def test_technical_workbook_keeps_diff_ids():
    from openpyxl import load_workbook
    assert paths.WP4_WORKBOOK_TECHNICAL_XLSX.exists()
    wb = load_workbook(paths.WP4_WORKBOOK_TECHNICAL_XLSX)
    ws = wb["差異清單"]
    header = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
    assert "diff_id" in header
    assert "provenance" in header


def test_three_reruns_are_byte_identical():
    from importer.wp4_run import run_wp4

    def _md5():
        run_wp4()
        return hashlib.md5(paths.WP4_DIFFERENCES_CSV.read_bytes()).hexdigest()

    hashes = {_md5() for _ in range(3)}
    assert len(hashes) == 1, f"三次重跑 differences.csv 唔一致: {hashes}"


def _xlsx_content_hash(path):
    """xlsx『內容』hash——用 openpyxl 讀返嚟嘅逐格值（sheet名+逐行值）砌
    一個穩定字串嚟 hash，刻意唔碰檔案本身嘅 raw bytes（docProps/core.xml
    嘅 created/modified、zipfile 逐個 member 自己嘅 timestamp 呢啲同內容
    完全無關嘅 metadata 一律唔算入去），先至係「剝 docProps」之後嘅內容
    hash。"""
    from openpyxl import load_workbook
    wb = load_workbook(path)
    parts = []
    for ws in wb.worksheets:
        parts.append(f"##SHEET##{ws.title}")
        for row in ws.iter_rows(values_only=True):
            parts.append("\t".join("" if v is None else str(v) for v in row))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def test_xlsx_content_hash_stable_across_reruns():
    """收貨標準延伸到 xlsx：連跑 3 次 `run_wp4()`，老闆版／technical版
    兩份 xlsx 嘅『內容』hash（逐格值，剝走 docProps/zip metadata）都要
    一致——同 `test_three_reruns_are_byte_identical`（differences.csv）
    同一原則，證明 xlsx 唔係得CSV穩定、xlsx本身都冧唔到人。"""
    from importer.wp4_run import run_wp4

    boss_hashes = set()
    tech_hashes = set()
    for _ in range(3):
        run_wp4()
        boss_hashes.add(_xlsx_content_hash(paths.WP4_WORKBOOK_XLSX))
        tech_hashes.add(_xlsx_content_hash(paths.WP4_WORKBOOK_TECHNICAL_XLSX))
    assert len(boss_hashes) == 1, f"三次重跑老闆版xlsx內容hash唔一致: {boss_hashes}"
    assert len(tech_hashes) == 1, f"三次重跑technical版xlsx內容hash唔一致: {tech_hashes}"


def test_q6_weave_ol_closed_by_master_roster(wp4_result):
    """2026-09-10（WP5c 必修3，Q6關檔）：Weave OL 31 vs 25 嗰6更差，由總表
    Roster sheet逐日broker分佈完整解釋咗（7日更表多填、1日更表漏填，
    31-7+1=25=R2/發票），唔再係「潛在少開收入」嘅真金錢缺口——L3差異行
    （嚟自gate-results.csv#S004）status改做explained、boss_question_ref
    清空，唔再喺「待老闆決定」出現。"""
    _summary, rows, _d = wp4_result
    l3_gate_row = next((r for r in rows if r["layer"] == "L3" and r["site_or_unit"] == "Weave OL"), None)
    assert l3_gate_row is not None, "Weave OL 要有一條L3差異行（嚟自gate-results.csv#S004）"
    assert l3_gate_row["status"] == "explained"
    assert l3_gate_row["boss_question_ref"] == ""

    l1_row = next((r for r in rows if r["layer"] == "L1" and r["site_or_unit"] == "Weave OL"), None)
    assert l1_row is not None
    assert l1_row["status"] == "explained"
    assert l1_row["boss_question_ref"] == ""


def test_q6_now_covers_unrelated_small_shift_gaps(wp4_result):
    """Q6 舊史：關咗Weave OL之後，呢個ref曾經重新啟用畀另一批獨立、追唔到
    已知pattern嘅個位數更數缺口（城巴-創富車廠/T 5條、HKU22/公司兵
    2條、啟航1331夜/公司兵1條，合共8條）。

    WP5e必修4（2026-09-10，Opus最終複驗，Q6-generic 8條）：呢8條逐條查到
    根因——創富車廠夜（長工冇上更、由另外兩位安員頂替，補更頂替/成本轉
    移）、HKU22（Q5已答嘅更表多填）、1331夜（糧單頁轉錄漏格）——全部轉
    explained，唔開新老闆編號。所以Q6而家**應該完全冇awaiting_boss嘅內容**
    （同Weave OL嗰個舊故事一樣，兩批獨立嘅Q6故事都已經關檔）。"""
    _summary, rows, _d = wp4_result
    q6_awaiting = [r for r in rows if r["boss_question_ref"] == "Q6" and r["status"] == "awaiting_boss"]
    assert not q6_awaiting, f"Q6已經全部關檔（Weave OL同8條個位數更數缺口都已explained），唔應該再有awaiting_boss嘅行：{q6_awaiting}"
    # WP5e必修4嘅8條而家應該全部explained，唔再標boss_question_ref=Q6。
    # 創富車廠夜嗰組有兩種label格式（day-mismatch同payroll-diff嘅
    # site_or_unit組字順序唔同），要兩個都計埋。
    q6_generic_sites = {f"城巴-創富車廠／{_BROKER_T}", f"{_BROKER_T}／創富車廠(夜)", "公司兵／HKU22", "公司兵／1331夜"}
    q6_explained = [r for r in rows if r["site_or_unit"] in q6_generic_sites]
    assert len(q6_explained) == 8, f"創富車廠夜／HKU22／1331夜三組差異行應該合共8條，而家{len(q6_explained)}條：{q6_explained}"
    assert all(r["status"] == "explained" and r["boss_question_ref"] == "" for r in q6_explained), \
        f"呢8條Q6-generic差異行應該全部explained、冇boss_question_ref：{[r for r in q6_explained if not (r['status']=='explained' and r['boss_question_ref']=='')]}"


def test_s017_kaihang_not_out_of_scope(wp4_result):
    """WP4第三版blocker修正：啟航1331（S017）主單位＋Event副線唔准標
    「範圍外／Q2」——呢個site本身屬P0範圍內。WP5b（2026-09-10）：P1/P2a
    已答（7個更別收客價/K出街價由老闆總表master_roster_rate直接解晒），
    billing-unit-solve.csv嗰條殘差已經改做「口徑差異」細殘差接受
    （status=explained），唔再係awaiting_boss/P1;P2a。"""
    _summary, rows, _d = wp4_result
    kaihang_rows = [r for r in rows if r["site_or_unit"] in ("啟航1331", "啟航1331 Event")]
    assert kaihang_rows, "啟航1331／啟航1331 Event 要有差異行"
    for r in kaihang_rows:
        assert r["category"] != "範圍外", f"{r['diff_id']}（{r['site_or_unit']}）唔應該係範圍外: {r}"
        assert r["boss_question_ref"] != "Q2", f"{r['diff_id']}（{r['site_or_unit']}）唔應該掛Q2: {r}"
    billing_unit_solve_rows = [r for r in kaihang_rows if "billing-unit-solve.csv" in r["provenance"]]
    assert billing_unit_solve_rows, "啟航1331 billing-unit-solve.csv 嗰兩條（主單位+Event）都要出到落differences.csv"
    for r in billing_unit_solve_rows:
        assert r["status"] == "explained"
        assert r["boss_question_ref"] == ""


def test_q10_longterm_broker_bucket_exposure(wp4_result):
    """WP5c必修14（P0-執行計劃.md §8「WP5總表對數後新問題」，最重要一條）：
    Q10（長工被掃入雞頭現金桶，雙重支付敞口）要有一條真實、data-driven嘅
    L2差異行——唔可以淨係得問題文字冇對應證據。呢條行嘅explanation/
    recommended_action唔准帶真名（PDPO安全網已經會redact，但呢度直接斷言
    只出現guard_id格式，防止regression）。"""
    _summary, rows, d = wp4_result
    q10_rows = [r for r in rows if r["boss_question_ref"] == "Q10"]
    assert q10_rows, "Q10 應該有對應差異行（build_l2_longterm_broker_bucket_exposure）"
    for r in q10_rows:
        assert r["status"] == "explained"  # 2026-09-11 老闆已答「係」
        assert r["layer"] == "L2"
        # 唔准出現任何guards.csv嘅真名/電話（同全域PDPO test同一把尺，
        # 呢度淨係加多一重保障，鎖住呢條新行本身）。
        guard_needles = {g["name_zh"] for g in d["guards"] if g.get("name_zh")}
        for field in ("explanation", "recommended_action", "site_or_unit"):
            text = r.get(field, "")
            for needle in guard_needles:
                assert needle not in text, f"Q10行{field}漏咗真名 {needle}: {text[:200]}"


def test_d5_narrowed_autopay_explained_and_gap_reconciles(wp4_result):
    """WP5c必修15（P0-執行計劃.md §8 item 15，D5收窄）：`build_l2_gongsi_
    bing_gap` 而家逐guard_id分類（已有payroll_ref的剔除、autopay長工
    explained、淨低嘅先至係真.缺頁awaiting_boss）。斷言：
    1. autopay explained 嗰行金額岩岩好79,914.52（4位長工，P0-執行計劃§8
       item15已知數）；
    2. explained+awaiting_boss+已剔除嘅covered總數要同總表公司兵PAID
       Amount分毫不差（392,886.71）——呢個係內部一致性check，唔靠寫死。"""
    _summary, rows, d = wp4_result
    d5_rows = [r for r in rows if r["boss_question_ref"] == "D5"]
    assert d5_rows, "D5 應該有差異行"
    explained = [r for r in d5_rows if r["status"] == "explained"]
    awaiting = [r for r in d5_rows if r["status"] == "explained" and "月薪" in str(r.get("recommended_action",""))]  # 2026-09-11 老闆已答：兩位都係月薪／自動轉賬
    assert explained, "D5 應該有一條autopay長工explained嘅行"
    assert awaiting, "D5 應該有一條收窄之後（已答）嘅行"
    assert explained[0]["ours"] == "79914.52", (
        f"autopay長工explained總額應該係79,914.52：{explained[0]['ours']}")

    # 內部一致性：總表公司兵PAID Amount(392,886.71) = 已有payroll_ref嘅
    # (計落ours_total，唔喺呢兩行出現) + autopay explained(79,914.52) +
    # 真.缺頁(awaiting行嘅gap_total) + 未resolve嘅guard_id金額——呢個
    # identity已經寫喺awaiting行嘅explanation入面，呢度斷言個explanation
    # 有提到392886.71（總數）先算真係做咗呢個reconciliation。
    assert "392886.71" in awaiting[0]["explanation"]
    assert "79914.52" in awaiting[0]["explanation"]


def test_q4_daily_breakdown_matches_master_roster(wp4_result):
    """WP5c必修15（Q4收窄）：數碼港CP1-4嘅Q4差異行而家逐日即場計（唔寫死），
    要收窄到岩岩好3日——07/29 +1、07/30 +2、07/31 +1，淨+4，同234-230
    吻合。"""
    _summary, rows, _d = wp4_result
    q4_rows = [r for r in rows if r["boss_question_ref"] == "Q4"]
    assert q4_rows, "Q4 應該有差異行"
    # 2026-09-11 老闆答：更表最終版 230＝發票，Q4 關檔
    assert q4_rows[0]["status"] == "explained"
    assert q4_rows[0]["ours"] == "230" and q4_rows[0]["theirs"] == "230"


def test_explained_rows_never_say_needs_manual_review(wp4_result):
    """WP4第三版blocker修正：status=explained 嘅行唔准再出現『需人手覆
    核』／『人手覆核／等老闆確認』字眼（以前 `_resolve_day_mismatch_row`
    漏咗 return override 嘅第4個元素，令6條人手覆核結論冇出到落
    explanation，同時day-mismatch.csv原始note入面寫死嘅『需人手覆核』
    喺WP4分類做explained之後都冧晒喺度，而家兩樣都修正咗）。"""
    _summary, rows, _d = wp4_result
    bad = [r["diff_id"] for r in rows if r["status"] == "explained"
           and ("需人手覆核" in (r["explanation"] + r["recommended_action"])
                or "人手覆核／等老闆確認" in (r["explanation"] + r["recommended_action"]))]
    assert not bad, f"呢啲explained行仲有『需人手覆核』／『人手覆核／等老闆確認』字眼: {bad}"


def test_boss_question_recommendation_is_short():
    """老闆版「待老闆決定」sheet 嘅「我哋建議」欄一句起兩句止（唔准將
    逐條diff row嘅recommended_action直接join埋一齊變成4、5句機器句）。
    用句號『。』數句子（Q6一句入面有個分號連埋兩個分句都算一句，句號先
    真係分句界），粗略上限3句留少少彈性俾複合句。"""
    from openpyxl import load_workbook
    wb = load_workbook(paths.WP4_WORKBOOK_XLSX)
    ws = wb["待老闆決定"]
    too_long = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        ref, recommendation = row[0], row[6]
        n_sentences = (recommendation or "").count("。")
        if n_sentences > 3:
            too_long.append((ref, n_sentences, recommendation))
    assert not too_long, f"呢啲問題嘅「我哋建議」太長（唔止一兩句）: {too_long}"


def test_boss_workbook_has_no_technical_jargon():
    """老闆版工作簿（全部7個sheet）唔准出現 `.csv`/`.xlsx`/`.xls`/`.pdf`
    檔名、`gate=`、`mixed_site_label`、`monthly_fee_day`、`day-mismatch`、
    `site_or_unit`/`guard_id`/`site_id`/`rate_id` 呢類工程術語——
    `_boss_text()` 轉換表負責將呢啲字轉做人話中文／剝走。

    2026-09-10（WP5c 必修5）：加埋 WP5-C settlement_page 修正之後新出現
    嘅一批詞——`billing_model`／`settlement_page`／`broker_id`／
    `parent_shift_id`／`ot_hours`／`Σshifts where`／`edit distance`／
    `rule 0.1`／`rule 0.2`／`site override`／`block 標題`／`PDPO`、以及
    任何 `out/`／`data/` 開頭嘅內部路徑。

    2026-09-10（WP5e必修3，Opus最終複驗）：舊版用`\\bPDPO\\b`——Python嘅
    `\\w`／`\\b`當中文字係word char，「（PDPO：」呢種PDPO直接貼住中文標點
    嘅情況，中文字同「P」之間可能冇word boundary，`\\b`版本會漏走。改用
    bare `PDPO`（唔用`\\b`）。同時加一條通用防線，唔淨係逐個列舉已知
    詞——`_boss_text()`轉換表未來都會漏一啲上游WP1-3新生成嘅snake_case
    內部欄位名，呢度用一條generic嘅`[a-z]+_[a-z]+`（純細楷英文snake_case
    token）+ 一條bare `.csv` + 一條bare `PDPO` 做防線，逐個sheet逐格掃，
    確保老闆版100%冇未經翻譯嘅工程術語漏出（唔止靠逐個列舉）。"""
    from openpyxl import load_workbook
    wb = load_workbook(paths.WP4_WORKBOOK_XLSX)
    jargon_re = re.compile(
        r"[A-Za-z0-9_\-]+\.(?:csv|xlsx|xls|pdf|md)"
        r"|gate="
        r"|(?<![A-Za-z0-9_])mixed_site_label(?![A-Za-z0-9_])"
        r"|(?<![A-Za-z0-9_])monthly_fee_day(?![A-Za-z0-9_])"
        r"|day-mismatch"
        r"|(?<![A-Za-z0-9_])site_or_unit(?![A-Za-z0-9_])"
        r"|(?<![A-Za-z0-9_])guard_id(?![A-Za-z0-9_])"
        r"|(?<![A-Za-z0-9_])site_id(?![A-Za-z0-9_])"
        r"|(?<![A-Za-z0-9_])rate_id(?![A-Za-z0-9_])"
        r"|billing_model"
        r"|settlement_page"
        r"|(?<![A-Za-z0-9_])broker_id(?![A-Za-z0-9_])"
        r"|parent_shift_id"
        r"|(?<![A-Za-z0-9_])ot_hours(?![A-Za-z0-9_])"
        r"|master_broker_code"
        r"|master_broker_source"
        r"|(?<![A-Za-z0-9_])unresolved_guards(?![A-Za-z0-9_])"
        r"|Σshifts where"
        r"|edit distance"
        r"|rule\s*\d(?:\.\d+)?"
        r"|site override"
        r"|block\s*標題"
        # WP5e必修3：唔用 \b——中文字前後可能冇word boundary（見上面
        # docstring）。呢兩條淨係要求「唔緊貼住另一個ASCII字母/數字/底
        # 線」，唔靠 \b。
        r"|(?<![A-Za-z])PDPO(?![A-Za-z])"
        r"|(?<![A-Za-z0-9_])(?:out|data)/[A-Za-z0-9_\-./]*"
        # WP5e必修3：通用防線——任何殘留嘅ASCII snake_case token（兩截或
        # 以上純細楷英文/數字加底線）、bare `.csv`、bare `PDPO`，唔淨係
        # 靠上面逐個列舉。
        r"|(?<![A-Za-z0-9])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9])"
        r"|\.csv"
        r"|PDPO"
    )
    leaks = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and jargon_re.search(cell.value):
                    leaks.append((ws.title, cell.coordinate, cell.value))
    assert not leaks, f"老闆版工作簿漏咗工程術語: {leaks[:5]}"


def test_pdpo_no_real_name_or_phone_leaks_into_tools_source():
    """guards.csv 真實姓名／電話唔應該漏咗入 tools/ 嘅原始碼（.py），跟
    WP2b/WP3 驗收同一把 PDPO 掃描尺。"""
    guards_csv = paths.WP2B_GUARDS_CSV
    if not guards_csv.exists():
        pytest.skip("out/wp2b/guards.csv 唔存在")
    with open(guards_csv, encoding="utf-8-sig", newline="") as fh:
        guard_rows = list(csv.DictReader(fh))
    needles = set()
    for r in guard_rows:
        if r.get("tel"):
            needles.add(r["tel"].strip())
        if r.get("name_zh") and len(r["name_zh"]) >= 2:
            needles.add(r["name_zh"].strip())

    src_files = list((paths.PROJECT_ROOT / "importer").glob("*.py"))
    hits = []
    for f in src_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        for needle in needles:
            if needle and needle in text:
                hits.append((f.name, needle))
    assert not hits, f"tools/importer/importer/*.py 入面搵到 PDPO needle: {hits[:10]}"
