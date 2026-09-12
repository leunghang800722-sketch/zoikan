"""WP5：在勤總表（Roster/Summary sheet）解析測試。

跟 test_end_to_end.py 同一原則：真實總表 xlsx 冇入 git（PDPO），喺冇呢個
檔案嘅環境自動 skip，唔會 fail CI。
"""
import csv

import pytest

from importer import paths
from importer.master_roster import (
    parse_roster_posts_and_assignments,
    parse_summary,
    resolve_broker_code,
    resolve_site_id,
    run_wp5_parse,
    _load_sheet_rows,
    ROSTER_SHEET,
    SUMMARY_SHEET,
)
from importer.private_mappings import broker_canonical_name, has_private_brokers

pytestmark = pytest.mark.skipif(
    not paths.MASTER_ROSTER_XLSX.exists() or not has_private_brokers(),
    reason="在勤總表 xlsx 或雞頭真名私有對照表（data/mappings-private/brokers.csv）"
           "唔存在（本機專用資料，冇入 git），跳過（部分 assertion 要用真名先組到期望值）",
)

# PDPO：雞頭真名淨係經 private_mappings 讀（上面 skipif 已保證呢個檔存
# 在），源碼本身唔會出現真名字面值。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_D = broker_canonical_name("D")
_BROKER_T = broker_canonical_name("T")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）


@pytest.fixture(scope="module")
def roster_rows():
    return _load_sheet_rows(paths.MASTER_ROSTER_XLSX, ROSTER_SHEET)


@pytest.fixture(scope="module")
def summary_rows():
    return _load_sheet_rows(paths.MASTER_ROSTER_XLSX, SUMMARY_SHEET)


@pytest.fixture(scope="module")
def parsed(roster_rows):
    return parse_roster_posts_and_assignments(roster_rows)


# ---------------------------------------------------------------------------
# 三層解析：block / sub_block / post
# ---------------------------------------------------------------------------

def test_qihang_sub_blocks_share_one_top_block(parsed):
    """啟航1331 底下 5 個時段小標題（8hrs D/M/N、12hrs D/N）全部要歸做
    block=啟航1331，唔可以俾第二個小標題（跟住一組 post 之後先出現）誤判做
    新 top block（呢個係 fix 咗嘅 bug：用「上一行係咪 header」判斷會走失）。"""
    posts, _ = parsed
    # 「啟航1331 Event」係獨立 top block（Event 更別價目 1350/1200/900 同
    # 正更完全唔同，故意唔同 「啟航1331」夾埋），淨係揀正更（非 Event）嘅
    # 崗位嚟驗證 sub_block 分組。
    qihang_posts = [p for p in posts if p["property"] == "啟航" and p["block"] == "啟航1331"]
    assert qihang_posts, "冇解到任何啟航1331 崗位"
    blocks = {p["block"] for p in qihang_posts}
    assert blocks == {"啟航1331"}, f"啟航1331崗位嘅 block 應該全部一致，實際: {blocks}"
    sub_blocks = {p["sub_block"] for p in qihang_posts}
    assert sub_blocks == {
        "8 hrs (D/S)", "8 hrs (M/S)", "8 hrs (N/S)",
        "12 hrs (D/S)", "12 hrs (N/S)",
    }, f"sub_block 集合唔啱: {sub_blocks}"


def test_qihang_ot_rows_inherit_top_block(parsed):
    """啟航1331 OT 行（property=OT）冇獨立 header，但一定要跟返 block=
    啟航1331（唔係跌落去 sub_block 文字本身，見 row345/347/368）。"""
    posts, _ = parsed
    ot_posts = [p for p in posts if p["property"] == "OT"]
    assert ot_posts
    for p in ot_posts:
        assert p["block"] == "啟航1331", p


def test_block_header_with_no_sub_block(parsed):
    """單層 block（例如 國泰城 12hrs (D/S)）底下嘅 post 唔應該有 sub_block。"""
    posts, _ = parsed
    cx_posts = [p for p in posts if p["property"] == "CX"]
    assert cx_posts
    for p in cx_posts:
        assert p["sub_block"] == ""


def test_no_blank_customer_label_posts(parsed):
    """純空白格仔殘留（例如 row839）唔應該生成 post。"""
    posts, _ = parsed
    blanks = [p for p in posts if not p["customer_label"] and not p["property"]]
    assert blanks == []


def test_broker_fee_rows_flagged(parsed):
    """「長工雞頭費 (X)」行係雞頭介紹費彙總行，唔係真崗位，要標
    is_broker_fee_row=True 畀 site mapping 跳過（唔算 unmapped）。"""
    posts, _ = parsed
    fee_rows = [p for p in posts if p["customer_label"].startswith("長工雞頭費")]
    assert fee_rows
    assert all(p["is_broker_fee_row"] for p in fee_rows)


def test_assignment_day_range(parsed):
    _, assignments = parsed
    days = {a["day"] for a in assignments}
    assert days <= set(range(1, 32))
    assert min(days) == 1 and max(days) == 31


def test_assignment_dates_match_july_2026(parsed):
    _, assignments = parsed
    dated = [a for a in assignments if a["work_date"]]
    assert dated
    for a in dated[:50]:
        assert a["work_date"].startswith("2026-07-")


# ---------------------------------------------------------------------------
# broker code 對照（Q7 已答：(1)公司兵→Y (2)K→K (3)W→W (4)T(總表姓氏稱呼)→T
# (8)長工→LT (11)D→D (13)G→G，真名見 data/mappings-private/brokers.csv）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("broker_raw,expected_code", [
    ("(1) 公司兵", "Y"),
    (f"(2) {_BROKER_K}", "K"),
    (f"(3) {_BROKER_W}", "W"),
    (f"(4) {_BROKER_T}", "T"),
    (f"(7) {_BROKER_P}", "P"),
    ("(8) 長工", "LT"),
    ("(10) 其他", "OTHER"),
    (f"(11) {_BROKER_D}", "D"),
    (f"(13) {_BROKER_G}", "G"),
    ("客戶", "EXTERNAL"),
    ("", ""),
])
def test_resolve_broker_code(broker_raw, expected_code):
    code, _label = resolve_broker_code(broker_raw)
    assert code == expected_code


def test_known_broker_distribution_totals(parsed):
    """對返 P0-執行計劃.md §8 已知數字：總表K合共 1,044 更、長工 1,141 更
    （呢度數嘅係逐日格出現次數，即係逐更次），公司兵 496。"""
    _, assignments = parsed
    from collections import Counter
    counts = Counter()
    for a in assignments:
        code, _ = resolve_broker_code(a["broker_raw"])
        if code:
            counts[code] += 1
    assert counts["K"] == 1044
    assert counts["LT"] == 1141
    assert counts["Y"] == 496


# ---------------------------------------------------------------------------
# site map 覆蓋
# ---------------------------------------------------------------------------

def test_site_map_coverage_qihang(parsed):
    posts, _ = parsed
    qihang_posts = [p for p in posts if p["property"] == "啟航" or p["property"] == "OT"]
    unmapped = [p for p in qihang_posts if not resolve_site_id(p)[0]]
    assert unmapped == [], f"啟航1331 崗位應該全部 map 到 site_id: {unmapped}"
    for p in qihang_posts:
        site_id, _note = resolve_site_id(p)
        assert site_id == "S017"


def test_site_map_unmapped_rate_reasonable(parsed):
    """對唔到 site_id 嘅崗位應該只有已知嘅少數幾類（國泰坊/海洋廠/Bogh/
    Patrol/HQ/個別雞頭/BG），唔應該無故大量新增未解釋嘅 unmapped。"""
    posts, _ = parsed
    real_posts = [p for p in posts if not p["is_broker_fee_row"]]
    unmapped = [p for p in real_posts if not resolve_site_id(p)[0]]
    assert len(unmapped) <= 20, f"unmapped 崗位數量超出預期: {len(unmapped)}"
    unmapped_properties = {p["property"] for p in unmapped}
    assert unmapped_properties <= {
        "國泰坊", "海洋廠", "Bogh", "Patrol", "HQ", _BROKER_P, "BG",
    }, f"出現未預期嘅 unmapped property: {unmapped_properties}"


# ---------------------------------------------------------------------------
# Summary sheet
# ---------------------------------------------------------------------------

def test_summary_paid_amount_matches_known_totals(summary_rows):
    """對返 P0-執行計劃.md §8 已知 PAID Amount：K 918,891.67、公司兵
    392,886.71、W 161,222.12。"""
    rows = parse_summary(summary_rows)
    paid = {r["broker_code"]: r for r in rows if r["section"] == "PAID_Amount"}
    assert abs(paid["K"]["month_total"] - 918891.67) < 1.0
    assert abs(paid["Y"]["month_total"] - 392886.71) < 1.0
    assert abs(paid["W"]["month_total"] - 161222.12) < 1.0


def test_summary_half_month_split_sums_to_month_total(summary_rows):
    rows = parse_summary(summary_rows)
    for r in rows:
        if r["section"] != "PAID_Amount":
            continue
        if r["month_total"] is None or r["first_half"] is None or r["second_half"] is None:
            continue
        assert abs((r["first_half"] + r["second_half"]) - r["month_total"]) < 1.0, r


# ---------------------------------------------------------------------------
# PDPO：真名唔准入 tools/
# ---------------------------------------------------------------------------

def test_no_raw_guard_names_in_wp5_outputs():
    """行完 run-wp5 之後，out/wp5/*.csv 一律唔應該出現 out/wp2b/guards.csv
    嘅真實姓名（name_zh／name_variants）——全部應該已經代做 [NAME:guard_id]
    或者 [NAME:?]。"""
    guards_csv = paths.OUT_WP2B_DIR / "guards.csv"
    if not guards_csv.exists():
        pytest.skip("out/wp2b/guards.csv 未生成（未跑過 run-wp2b）")
    run_wp5_parse()
    guard_names = set()
    with open(guards_csv, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("name_zh"):
                guard_names.add(row["name_zh"])
            for v in (row.get("name_variants") or "").split(";"):
                v = v.strip()
                if v:
                    guard_names.add(v)
    for out_csv in (
        paths.WP5_MASTER_POSTS_CSV,
        paths.WP5_MASTER_ASSIGNMENTS_CSV,
        paths.WP5_UNMAPPED_MASTER_CSV,
    ):
        with open(out_csv, encoding="utf-8") as fh:
            content = fh.read()
        leaked = [n for n in guard_names if n in content]
        assert leaked == [], f"{out_csv} 出現未 redact 嘅真名: {leaked}"


def test_master_site_map_csv_has_no_names():
    """out/wp5/master_site_map.csv（2026-09-10 修必修10，由 mappings/ 搬過
    嚟，自動生成、唔入 git）一定唔可以有任何真名。"""
    from importer.master_roster import write_master_site_map_csv
    write_master_site_map_csv(paths.MASTER_SITE_MAP_CSV)
    guards_csv = paths.OUT_WP2B_DIR / "guards.csv"
    if not guards_csv.exists():
        pytest.skip("out/wp2b/guards.csv 未生成")
    guard_names = set()
    with open(guards_csv, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("name_zh"):
                guard_names.add(row["name_zh"])
    with open(paths.MASTER_SITE_MAP_CSV, encoding="utf-8") as fh:
        content = fh.read()
    leaked = [n for n in guard_names if n in content]
    assert leaked == []


# ---------------------------------------------------------------------------
# run_wp5_parse() 輸出穩定性（純結構層面：跑兩次 posts/assignments 數量一致）
# ---------------------------------------------------------------------------

def test_run_wp5_parse_deterministic_counts():
    s1 = run_wp5_parse()
    s2 = run_wp5_parse()
    assert s1["posts"] == s2["posts"]
    assert s1["assignments"] == s2["assignments"]
    assert s1["broker_dist"] == s2["broker_dist"]


# ---------------------------------------------------------------------------
# WP5c必修7：build_site_day_broker_counts() 隔走「甩更／取消」
# ---------------------------------------------------------------------------

def test_no_show_and_cancelled_cells_excluded_from_broker_counts():
    """P0-執行計劃.md §8 WP5 item 7：總表 3 格「其他」欄寫「甩更」／「取消」
    （row116 work_date=2026-07-08、row174 work_date=2026-07-14、row175
    work_date=2026-07-10），代表冇實際做過嗰更，唔應該計落
    build_site_day_broker_counts()／rule 0.2 嘅更次口徑。口徑：
    master_assignments.csv 逐日格總數 3,393 唔變（原始解析），summary 嘅
    broker_dist_total（隔走呢3格之後嘅「更次」）3,390。"""
    summary = run_wp5_parse()
    assert summary["assignments"] == 3393, "master_assignments.csv 逐日格總數唔應該變"
    assert summary["assignments_no_show_excluded"] == 3
    assert summary["broker_dist_total"] == 3390
    assert sum(summary["broker_dist"].values()) == 3390

    with open(paths.WP5_MASTER_ASSIGNMENTS_CSV, encoding="utf-8", newline="") as fh:
        assignments = list(csv.DictReader(fh))
    no_show = [
        a for a in assignments
        if (a["row_no"], a["work_date"]) in (
            ("116", "2026-07-08"), ("174", "2026-07-14"), ("175", "2026-07-10"))
    ]
    assert len(no_show) == 3, f"預期實測到嘅3格，實際: {no_show}"
    assert {a["other"] for a in no_show} == {"甩更", "取消"}

    # master_site_day_broker_counts.csv 仲要求 site_id／work_date 都非空
    # （比 broker_dist 嘅3,390再窄——有啲assignment有broker_code但冇map到
    # site_id，或者冇work_date），所以呢個表嘅總數會細過3,390；但一定要
    # 細過（或等於）冇隔走「甩更／取消」之前嘅版本，等於話呢3格一定唔喺
    # 呢個表計咗數（用返before/after對比嚟驗證，唔靠寫死絕對數）。
    with open(paths.MASTER_SITE_DAY_BROKER_CSV, encoding="utf-8", newline="") as fh:
        site_day_rows = list(csv.DictReader(fh))
    site_day_total = sum(int(r["count"]) for r in site_day_rows)
    from importer.master_roster import build_site_day_broker_counts, NO_SHOW_OTHER_VALUES
    with open(paths.WP5_MASTER_ASSIGNMENTS_CSV, encoding="utf-8", newline="") as fh:
        all_assignments = list(csv.DictReader(fh))
    unfiltered = [dict(a, other="") if a["other"] in NO_SHOW_OTHER_VALUES else a
                  for a in all_assignments]
    unfiltered_total = sum(r["count"] for r in build_site_day_broker_counts(unfiltered))
    assert unfiltered_total - site_day_total == 3, (
        "隔走「甩更／取消」之後，master_site_day_broker_counts.csv 總數應該"
        f"啱啱好少3（unfiltered={unfiltered_total}, filtered={site_day_total}）")


# ---------------------------------------------------------------------------
# WP5c必修13：長工雞頭費費率表驗證
# ---------------------------------------------------------------------------

def test_referral_fee_rates_reconcile_with_known_two_exceptions():
    """P0-執行計劃.md §8 WP5 item 13：mappings/referral_fee_rates.csv 嘅費
    率表（K 啟航60/其餘50；W 啟航50/其餘30；T(總表姓氏稱呼) Weave 50/其餘
    30；G 30）要令總表20條「長工雞頭費」行入面18條同總表自己嘅實際
    `(8)長工`格數完全對得上（match），淨係得返2條已知差異：啟航1331 12h
    夜更（implied 222 vs 實際197，多25更）、九龍企業大廈（implied 23 vs
    實際24，少1更）——呢兩條先至掛P3a問老闆。"""
    from importer.master_roster import validate_referral_fee_rates
    rows = validate_referral_fee_rates()
    assert rows, "冇validate到任何長工雞頭費行"
    assert len(rows) == 20, f"總表應該有20條長工雞頭費行：{len(rows)}"

    # 逐broker合計要同P0-執行計劃§8 item13已知嘅58,120（K40,590/W
    # 10,230/T(總表姓氏稱呼)6,520/G780）分毫不差——呢個係獨立於rate表本身嘅原始
    # 總表金額，唔靠rate反推，純粹加返總表自己印嘅amount。
    from collections import defaultdict
    from decimal import Decimal
    totals = defaultdict(lambda: Decimal("0"))
    for r in rows:
        totals[r["broker_id"]] += Decimal(r["amount"])
    assert totals["B01"] == Decimal("40590.0")  # K
    assert totals["B02"] == Decimal("10230.0")  # W
    assert totals["B05"] == Decimal("6520.0")   # T(總表姓氏稱呼)
    assert totals["B03"] == Decimal("780.0")    # G
    assert sum(totals.values()) == Decimal("58120.0")

    diff_groups = {r["group_key"] for r in rows if r["status"] == "diff"}
    assert diff_groups == {"啟航1331|12 hrs (N/S)|Night", "九龍企業大廈 25500/M||"}, (
        f"應該淨係得返呢2組已知差異，實際：{diff_groups}")

    by_group_diff = {r["group_key"]: r["group_diff"] for r in rows}
    assert by_group_diff["啟航1331|12 hrs (N/S)|Night"] == "25.0"
    assert by_group_diff["九龍企業大廈 25500/M||"] == "-1.0"


def test_referral_fee_snapshot_stamped_on_shift_records_with_known_broker():
    """WP5c必修13：shift_records.csv 嘅 referral_fee_snapshot 淨係喺已經有
    具體referral_broker（T/G，共251條，嚟自payroll頁面證據）先
    stamp；rule 0.1/0.2嘅(8)長工記錄冇逐更嘅具體雞頭證據，留空（唔可以
    喺呢個粒度砌數）。"""
    if not paths.WP2B_SHIFT_RECORDS_CSV.exists():
        pytest.skip("out/wp2b/shift_records.csv 唔存在")
    with open(paths.WP2B_SHIFT_RECORDS_CSV, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    with_snapshot = [r for r in rows if r.get("referral_fee_snapshot")]
    assert with_snapshot, "shift_records.csv 應該有referral_fee_snapshot"
    for r in with_snapshot:
        assert r["referral_broker"] in (_BROKER_T, _BROKER_G), (
            f"referral_fee_snapshot淨係應該喺referral_broker={_BROKER_T}/{_BROKER_G}先出現：{r}")
    without_referral_broker_but_has_snapshot = [
        r for r in rows if r.get("referral_fee_snapshot") and not r.get("referral_broker")
    ]
    assert not without_referral_broker_but_has_snapshot


def test_wp5_report_generated_with_verified_sections():
    """順手（P0-執行計劃.md §8「WP5總表對數後新問題」逐項尾句）：
    `out/wp5/wp5-report.md` 真係要生成，包含解析統計/口徑/site map/K逐日
    表/雞頭PAID對數。呢度淨係check報告有生成、有齊5個章節、同summary
    dict嘅數字一致（唔重複斷言逐個數值，嗰啲已經由其他test覆蓋）。"""
    summary = run_wp5_parse()
    assert paths.WP5_REPORT_MD.exists()
    content = paths.WP5_REPORT_MD.read_text(encoding="utf-8")
    for heading in ("## 1. 解析統計", "## 2. 崗位對 site_id 口徑", "## 3. Site map",
                    "## 4. 啟航1331（S017）K逐日缺口", "## 5. 長工雞頭費 PAID 對數"):
        assert heading in content, f"wp5-report.md 缺咗章節：{heading}"
    assert str(summary["posts"]) in content
    assert str(summary["assignments"]) in content


def test_run_wp5_does_not_wipe_wp2b_reconcile_dir(tmp_path, monkeypatch):
    """修必修8（2026-09-10）：out/wp5/reconcile/（rule02-overrides.csv／
    rule02-conflicts.csv）係 run-wp2b 寫嘅審核輸出，唔係 run-wp5 自己
    嘅產物——以前 clean_out_wp5_dir() 逐個檔 rglob 清晒 out/wp5/ 底下所有
    檔案，喺標準執行次序（run-wp2b → run-wp5）入面，行 run-wp5 會將啱啱
    先由 run-wp2b 寫低嘅 reconcile 檔靜靜清走。

    WP5e應修6（2026-09-10，Opus最終複驗）：舊版直接用`paths.OUT_WP5_DIR`
    （即生產 `out/wp5/`），呢個test會喺生產目錄度寫一個假嘅
    `rule02-overrides.csv` sentinel 檔，污染真實交付檔——就算最後冇留低
    垃圾（sentinel 檔案本身之後冇刪），都唔應該掂生產 out/。改用
    `tmp_path` fixture + `monkeypatch` 將 `paths.OUT_WP5_DIR` 指去一個
    隔離嘅臨時目錄，淨係測試`paths.clean_out_wp5_dir()`（真正被測試嗰個
    行為，喺paths.py定義，直接讀模組level嘅`OUT_WP5_DIR`）——唔使行成個
    `run_wp5_parse()`（佢會讀生產嘅`MASTER_ROSTER_XLSX`同寫返生產嘅
    `WP5_MASTER_POSTS_CSV`等一批喺import時已經綁死路徑嘅CSV常數，
    monkeypatch `OUT_WP5_DIR` 都唔會改到嗰啲已經綁死嘅Path，扮唔到隔
    離），一樣可以驗到同一個保證。"""
    monkeypatch.setattr(paths, "OUT_WP5_DIR", tmp_path / "wp5")
    reconcile_dir = paths.OUT_WP5_DIR / "reconcile"
    reconcile_dir.mkdir(parents=True, exist_ok=True)
    sentinel = reconcile_dir / "rule02-overrides.csv"
    sentinel.write_text("guard_id,file,row\nG0001,x.xlsx,1\n", encoding="utf-8")
    other_stale_file = paths.OUT_WP5_DIR / "master_posts.csv"
    other_stale_file.write_text("stale", encoding="utf-8")

    paths.clean_out_wp5_dir()

    assert sentinel.exists(), "run-wp5 唔准清走 out/wp5/reconcile/ 嘅檔（果啲係run-wp2b嘅輸出）"
    assert sentinel.read_text(encoding="utf-8").startswith("guard_id,file,row")
    assert not other_stale_file.exists(), "clean_out_wp5_dir() 仍然要清走run-wp5自己直接寫喺out/wp5/底下嘅舊檔"
