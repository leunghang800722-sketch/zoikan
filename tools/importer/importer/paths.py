"""Central path constants for the importer.

Kept in one place so tests and CLI agree on where things live, and so the
whole pipeline is rerunnable from a single command without hidden hardcoded
paths scattered around.
"""
from pathlib import Path

# tools/importer/
PROJECT_ROOT = Path(__file__).resolve().parent.parent
# zoi-kan/
REPO_ROOT = PROJECT_ROOT.parent.parent

DATA_DIR = REPO_ROOT / "data" / "2026-07"
TRANSCRIBED_DIR = DATA_DIR / "transcribed"
MAPPINGS_DIR = PROJECT_ROOT / "mappings"
# data/ 全個 gitignore（PDPO）；含真實員工中英文姓名嘅對照表放呢度，唔放
# mappings/（mappings/ 會入 git）。mappings/names_en.example.csv 有假數據
# 示範格式。
PRIVATE_MAPPINGS_DIR = REPO_ROOT / "data" / "mappings-private"
OUT_DIR = PROJECT_ROOT / "out" / "wp1"
OUT_WP2B_DIR = PROJECT_ROOT / "out" / "wp2b"

CELL_CODES_CSV = MAPPINGS_DIR / "cell_codes.csv"
STAT_ROW_LABELS_CSV = MAPPINGS_DIR / "stat_row_labels.csv"
RANK_BILLING_CSV = MAPPINGS_DIR / "rank_billing.csv"
SITES_CSV = MAPPINGS_DIR / "sites.csv"
BROKERS_CSV = MAPPINGS_DIR / "brokers.csv"
STATUS_CODES_CSV = MAPPINGS_DIR / "status_codes.csv"
PAGE_LEVEL_SETTLEMENTS_CSV = MAPPINGS_DIR / "page_level_settlements.csv"
# WP5c必修13：長工雞頭費（referral fee）人手費率表，見P0-執行計劃.md §8
# 「WP5總表對數後新問題」item 13。
REFERRAL_FEE_RATES_CSV = MAPPINGS_DIR / "referral_fee_rates.csv"
# WP2b-d（2026-09-10）：兩個「有發票但唔喺 R2月結38行、更表冇任何逐日
# 來源」嘅「月結以外」客戶（代號見 data/mappings-private/client-names.json，
# 呢兩個盤本身係 SOGO CWB／Garden East），發票逐日更次由老闆確認（見
# P0-執行計劃§8 D3/P0-執行計劃-2026-09-10 新增資料），冇涉及安員姓名
# （PDPO安全），放mappings/（入git）。
INVOICE_DAILY_SHIFTS_CSV = MAPPINGS_DIR / "invoice_daily_shifts.csv"
NAMES_EN_CSV = PRIVATE_MAPPINGS_DIR / "names_en.csv"
NAMES_EN_EXAMPLE_CSV = MAPPINGS_DIR / "names_en.example.csv"
# 雞頭（結算單位）真名對照，PDPO：唔入 git（.gitignore `data/`）。
# mappings/brokers.csv 淨係留代號（K/W/G/D/T/Y）＋唔涉真名嘅欄；真名／
# 真實別名（糧明細頁實際寫法，唔一定同代號本身一樣）放呢個檔，見
# importer/private_mappings.py loader（冇檔 fallback 用代號，log warning）。
PRIVATE_BROKERS_CSV = PRIVATE_MAPPINGS_DIR / "brokers.csv"
# B2（Opus 對抗式驗收第四輪）：兩個真實客戶公司名（連埋佢哋喺發票上嘅
# 全稱）一樣唔可以喺 git-tracked 檔硬編碼——搬去呢個 gitignored 檔，見
# private_mappings.py 嘅 client_name()。
PRIVATE_CLIENT_NAMES_JSON = PRIVATE_MAPPINGS_DIR / "client-names.json"
# WP2b-c（2026-09-10）：老闆交嘅 Maxwell Corporation Limited 2026-07 長工
# 月薪表（Google Sheet 匯出），48 人，由 `data/2026-07/reference/
# 2026-07-長工月薪表-Maxwell-Frontline-GoogleSheet.xlsx` sheet `7.2026`
# 抽取生成。PDPO：含真實員工姓名/工號，放 data/mappings-private/（gitignore），
# 唔放 mappings/。
LONGTERM_STAFF_CSV = PRIVATE_MAPPINGS_DIR / "longterm_staff_2026-07.csv"
# WP4-d（2026-09-10）：老闆傳嘅數碼港CP1-4值勤表，客方230更 vs 更表234更
# 差異集中8人逐人差（Q4），含安員真名，放data/mappings-private/（gitignore）。
CLIENT_DUTYSHEET_CP14_DIFF_CSV = PRIVATE_MAPPINGS_DIR / "client_dutysheet_cp14_diff_2026-07.csv"
# 客方「香港大學職員宿舍值勤表（HKU Y更）」下半月5人名單同逐人更數
# （N2已答），獨立雞頭費94更嘅出處，含安員真名。
CLIENT_DUTYSHEET_HKU_Y_CSV = PRIVATE_MAPPINGS_DIR / "client_dutysheet_hku_y_2026-07.csv"

# WP2a inputs (data/2026-07/transcribed/, produced by a separate session)
PAYROLL_ROWS_CSV = TRANSCRIBED_DIR / "payroll-rows.csv"
PAYROLL_PAGES_CSV = TRANSCRIBED_DIR / "payroll-pages.csv"
ADJUSTMENTS_CSV = TRANSCRIBED_DIR / "adjustments.csv"


def payroll_cells_csvs():
    """All payroll-cells*.csv files under transcribed/ (union, glob — new
    per-page cell files land here from other sessions without code changes)."""
    return sorted(TRANSCRIBED_DIR.glob("payroll-cells*.csv"))


# ---- WP2b outputs (out/wp2b/) ----
WP2B_SITES_CSV = OUT_WP2B_DIR / "sites.csv"
WP2B_SHIFT_TYPES_CSV = OUT_WP2B_DIR / "shift_types.csv"
WP2B_GUARDS_CSV = OUT_WP2B_DIR / "guards.csv"
WP2B_BROKERS_CSV = OUT_WP2B_DIR / "brokers.csv"
WP2B_SHIFT_RECORDS_CSV = OUT_WP2B_DIR / "shift_records.csv"
WP2B_DAILY_REQUIREMENTS_CSV = OUT_WP2B_DIR / "daily_requirements.csv"

WP2B_IDENTITY_DECISIONS_CSV = OUT_WP2B_DIR / "identity-decisions.csv"
WP2B_BROKER_CONFLICTS_CSV = OUT_WP2B_DIR / "broker-conflicts.csv"
WP2B_UNRESOLVED_GUARDS_CSV = OUT_WP2B_DIR / "unresolved-guards.csv"
WP2B_UNMAPPED_SITES_CSV = OUT_WP2B_DIR / "unmapped-sites.csv"
WP2B_DAY_MISMATCH_CSV = OUT_WP2B_DIR / "day-mismatch.csv"
WP2B_PAYROLL_ONLY_ROWS_CSV = OUT_WP2B_DIR / "payroll-only-rows.csv"
WP2B_NAMES_EN_UNMATCHED_CSV = OUT_WP2B_DIR / "names_en-unmatched.csv"
WP2B_SITE_OVERRIDES_CSV = OUT_WP2B_DIR / "site-overrides.csv"
WP2B_NAME_NEAR_MATCH_CSV = OUT_WP2B_DIR / "name-near-match.csv"
WP2B_OT_LANDING_CSV = OUT_WP2B_DIR / "ot-landing.csv"
# WP5c必修12：master_roster_only shift_types 逐個嘅client_rate/payout_rate
# （總表逐post表頭嘅上單價/外判價欄，唔靠反推），畀wp3_rates.py生成solved
# rate_cards用。
WP2B_MASTER_ROSTER_ONLY_RATES_CSV = OUT_WP2B_DIR / "master-roster-only-rates.csv"

WP2B_CONSERVATION_REPORT_MD = OUT_WP2B_DIR / "conservation-report.md"
WP2B_REPORT_MD = OUT_WP2B_DIR / "wp2b-report.md"


def ensure_out_wp2b_dir() -> None:
    OUT_WP2B_DIR.mkdir(parents=True, exist_ok=True)


def clean_out_wp2b_dir() -> None:
    """一併做項目 5（2026-09-04 放行條件，fail fast）：run-wp2b 開始嗰陣先
    清空 out/wp2b/ 舊檔，再由頭生成。目的係如果後面 validate 到 site 解唔到
    （唔應該發生嘅硬性不變式）中途爆，out/wp2b/ 會停留喺「乾淨」狀態（冇任何
    輸出，或者上次成功嘅輸出），唔會出現「新 CSV＋舊報告」呢種半新舊混埋、
    容易誤導人以為成功咗嘅狀態。"""
    if OUT_WP2B_DIR.exists():
        for child in OUT_WP2B_DIR.iterdir():
            if child.is_file():
                child.unlink()
    OUT_WP2B_DIR.mkdir(parents=True, exist_ok=True)

# Output files (all under OUT_DIR)
HIDDEN_SHEETS_CSV = OUT_DIR / "hidden-sheets.csv"
UNPARSED_CSV = OUT_DIR / "unparsed.csv"
REVIEW_ROWS_CSV = OUT_DIR / "review-rows.csv"
RECORDS_JSONL = OUT_DIR / "records.jsonl"
ROWS_CSV = OUT_DIR / "rows.csv"
SHEET_STATS_CSV = OUT_DIR / "sheet-stats.csv"
SUMMARY_CSV = OUT_DIR / "summary.csv"

VALIDATE_REPORT_MD = OUT_DIR / "validate-report.md"
VAL_ROW_TOTAL_MISMATCH_CSV = OUT_DIR / "validate-row-total-mismatch.csv"
VAL_DAY_TOTAL_MISMATCH_CSV = OUT_DIR / "validate-day-total-mismatch.csv"
VAL_SAME_DAY_MULTI_SHIFT_CSV = OUT_DIR / "validate-same-day-multi-shift.csv"
VAL_MISSING_STAFF_NO_CSV = OUT_DIR / "validate-missing-staff-no.csv"
VAL_IDENTITY_CONFLICT_CSV = OUT_DIR / "validate-identity-conflicts.csv"
VAL_DUPLICATE_ROWS_CSV = OUT_DIR / "validate-duplicate-rows-in-file.csv"


def ensure_out_dir() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)


# ---- WP3 (⑤ rates + ⑥ report) ----
OUT_WP3_DIR = PROJECT_ROOT / "out" / "wp3"
OUT_WP3_REPORTS_DIR = OUT_WP3_DIR / "reports"

INVOICE_PDF = REPO_ROOT / "data" / "reference-global" / "Invoice-Record-updated-19.08.2026.pdf"
SETTLEMENT_PDF_2026_07 = REPO_ROOT / "data" / "2026-07" / "reference" / "2026-07-月結總表-FinalR2.pdf"
SETTLEMENT_PDF_2026_06 = REPO_ROOT / "data" / "2026-06" / "reference" / "2026-06-月結總表-Final.pdf"
SETTLEMENT_PDF_2026_05 = REPO_ROOT / "data" / "2026-05" / "reference" / "2026-05-月結總表-Final.pdf"

INVOICE_SITE_ALIASES_CSV = MAPPINGS_DIR / "invoice_site_aliases.csv"
BILLING_UNITS_CSV = MAPPINGS_DIR / "billing_units.csv"

WP3_RATE_CARDS_CSV = OUT_WP3_DIR / "rate_cards.csv"
WP3_SHIFT_RECORDS_PRICED_CSV = OUT_WP3_DIR / "shift_records_priced.csv"
WP3_UNPRICED_CSV = OUT_WP3_DIR / "unpriced.csv"
WP3_RATES_REPORT_MD = OUT_WP3_DIR / "rates-report.md"
WP3_KAI1331_RESIDUALS_CSV = OUT_WP3_DIR / "kai1331-daily-residuals.csv"
WP3_INVOICE_LINES_CSV = OUT_WP3_DIR / "invoice-lines.csv"
WP3_BILLING_UNIT_SOLVE_CSV = OUT_WP3_DIR / "billing-unit-solve.csv"

WP3_BILLING_ADJUSTMENTS_CSV = OUT_WP3_DIR / "billing_adjustments.csv"
WP3_GATE_RESULTS_CSV = OUT_WP3_DIR / "gate-results.csv"

WP3_ROUNDTRIP_DIFF_CSV = OUT_WP3_REPORTS_DIR / "roundtrip-diff.csv"
WP3_PAYROLL_DIFF_CSV = OUT_WP3_REPORTS_DIR / "payroll-diff.csv"
WP3_MONTHLY_DIFF_CSV = OUT_WP3_REPORTS_DIR / "monthly-diff.csv"
WP3_SAMPLE_AUDIT_CSV = OUT_WP3_DIR / "sample-audit.csv"


def ensure_out_wp3_dir() -> None:
    OUT_WP3_DIR.mkdir(parents=True, exist_ok=True)
    OUT_WP3_REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def clean_out_wp3_dir() -> None:
    """跟 wp2b 同一原則：每次 run-wp3 先清空 out/wp3/ 舊檔，避免新舊輸出混埋。"""
    if OUT_WP3_DIR.exists():
        for child in OUT_WP3_DIR.rglob("*"):
            if child.is_file():
                child.unlink()
    ensure_out_wp3_dir()


# ---- WP4 (⑦ reconcile：三層對數＋差異解釋工作簿) ----
OUT_WP4_DIR = PROJECT_ROOT / "out" / "wp4"

BOCHK_XLS_2026_07 = REPO_ROOT / "data" / "2026-07" / "reference" / "2026-07-長工autopay-BOCHK-PayrollEditor.xls"
BOCHK_XLS_PASSWORD = "VelvetSweatshop"

WP4_DIFFERENCES_CSV = OUT_WP4_DIR / "differences.csv"
WP4_REPORT_MD = OUT_WP4_DIR / "wp4-report.md"
WP4_WORKBOOK_XLSX = OUT_WP4_DIR / "P0-對數工作簿-2026-07.xlsx"
WP4_WORKBOOK_TECHNICAL_XLSX = OUT_WP4_DIR / "P0-對數工作簿-2026-07-technical.xlsx"
WP4_AUTOPAY_LONGTERM_CSV = OUT_WP4_DIR / "autopay-longterm-diff.csv"


def ensure_out_wp4_dir() -> None:
    OUT_WP4_DIR.mkdir(parents=True, exist_ok=True)


def clean_out_wp4_dir() -> None:
    """跟 wp2b/wp3 同一原則：每次 run-wp4 先清空 out/wp4/ 舊檔，避免新舊輸出混埋。"""
    if OUT_WP4_DIR.exists():
        for child in OUT_WP4_DIR.rglob("*"):
            if child.is_file():
                child.unlink()
    ensure_out_wp4_dir()


# ---- WP5（老闆 2026-09-10 交嘅「在勤總表」7 月版做權威來源，重做歸屬同三層對數）----
MASTER_ROSTER_XLSX = (
    REPO_ROOT / "data" / "2026-07" / "reference"
    / "2026-07-在勤總表-PostOrder-Roster-Summary (Drive 2026-09-10).xlsx"
)
OUT_WP5_DIR = PROJECT_ROOT / "out" / "wp5"
# WP5-C 修（2026-09-10，必修10）：呢三個檔全部係 run-wp5 自動生成（唔係人
# 手維護嘅對照表），改放 out/wp5/（同其餘 wp5 產物一致，run-wp5 每次清空
# 重寫），mappings/ 淨係留返真係人手可改嘅表。wp2b_run.py 而家已經唔靠
# 呢兩個 CSV（見 master_roster.build_rule01_rule02_inputs()，記憶體直接
# 算），呢度嘅檔案純粹畀人手審核/PDPO掃描用。
MASTER_SITE_MAP_CSV = OUT_WP5_DIR / "master_site_map.csv"
# WP5-C（§11）：逐 guard_id 由總表逐日 broker 分佈確認嘅 settlement_unit，
# 取代舊 page_level_settlements.csv 嘅單一 site+roster_code fallback。冇真名
# （guard_id only）。
MASTER_GUARD_BROKER_CSV = OUT_WP5_DIR / "master_guard_broker_confirmations.csv"
# WP5b rule 0.2（§1）：逐 (site_id, work_date) 嘅總表 broker_code 分佈（純
# 數字，冇任何姓名/guard_id），畀 normalize.py rule 0.2 做「總表有覆蓋但
# rule 0.1 冇 override 到」嘅 site 層 fallback（逐日剩餘配額消去法）。
MASTER_SITE_DAY_BROKER_CSV = OUT_WP5_DIR / "master_site_day_broker_counts.csv"

WP5_MASTER_POSTS_CSV = OUT_WP5_DIR / "master_posts.csv"
WP5_MASTER_ASSIGNMENTS_CSV = OUT_WP5_DIR / "master_assignments.csv"
WP5_MASTER_SUMMARY_CSV = OUT_WP5_DIR / "master_summary.csv"
WP5_UNMAPPED_MASTER_CSV = OUT_WP5_DIR / "unmapped-master.csv"
# WP5c必修13：長工雞頭費費率表驗證輸出（診斷/審核用）。
WP5_REFERRAL_FEE_VALIDATION_CSV = OUT_WP5_DIR / "referral-fee-validation.csv"
# WP5c（順手）：wp5-report.md，解析統計/口徑/site map/K逐日表/雞頭PAID對數。
WP5_REPORT_MD = OUT_WP5_DIR / "wp5-report.md"


def ensure_out_wp5_dir() -> None:
    OUT_WP5_DIR.mkdir(parents=True, exist_ok=True)


def clean_out_wp5_dir() -> None:
    """跟 wp2b/wp3/wp4 同一原則：每次 run-wp5 先清空 out/wp5/ 舊檔。

    修必修8（2026-09-10）：`out/wp5/reconcile/`（rule02-overrides.csv／
    rule02-conflicts.csv）其實係 `run-wp2b` 寫嘅審核輸出（見
    wp2b_run.py），唔係 `run-wp5` 自己嘅產物——但因為擺埋喺 out/wp5/ 樹
    底下，以前 `clean_out_wp5_dir()` 逐個 rglob 檔案清，喺標準執行次序
    （run-wp2b → run-wp3 → run-wp5 → run-wp4）入面，run-wp5 一行就會將
    啱啱先由 run-wp2b 寫低嘅 reconcile 檔靜靜清走，令依賴呢兩個檔嘅覆核
    工作睇唔到最新數據。而家明確跳過 `reconcile/` 呢個子目錄，只清
    run-wp5 自己直接寫喺 out/wp5/ 底下嗰啲檔（master_posts.csv 等）。"""
    if OUT_WP5_DIR.exists():
        reconcile_dir = OUT_WP5_DIR / "reconcile"
        for child in OUT_WP5_DIR.rglob("*"):
            if child.is_file() and reconcile_dir not in child.parents:
                child.unlink()
    ensure_out_wp5_dir()
