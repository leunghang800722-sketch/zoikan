"""WP3 輸入層：讀 out/wp2b/* 六份規範化 CSV、WP2a 糧明細 CSV、發票 PDF、
月結 PDF（跨月證據）。淨係做讀取／解析，唔做業務邏輯（邏輯喺 wp3_rates.py／
wp3_pricing.py／wp3_reports.py）。

發票／月結 PDF 用 `pdftotext -layout` 喺 runtime 讀（同 WP2a 轉錄口徑一致），
唔喺 code 度寫死金額——改動 PDF 或者換月份，rerun 就會反映。
"""
import csv
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

from . import paths
from .mappings_io import _split_aliases  # 用嚟拆 invoice_site_aliases.csv 唔使
from .private_mappings import client_name


def _read_csv(path: Path) -> List[dict]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


# ---------------------------------------------------------------------------
# out/wp2b/*.csv（六份規範化 CSV，WP3 嘅輸入基礎）
# ---------------------------------------------------------------------------

def load_wp2b_sites() -> List[dict]:
    rows = _read_csv(paths.WP2B_SITES_CSV)
    for r in rows:
        r["aliases"] = _split_aliases(r.get("aliases", ""))
        r["in_p0_scope"] = (r.get("in_p0_scope") or "True").strip().lower() == "true"
    return rows


def load_wp2b_brokers() -> List[dict]:
    rows = _read_csv(paths.WP2B_BROKERS_CSV)
    for r in rows:
        r["aliases"] = _split_aliases(r.get("aliases", ""))
    return rows


def load_wp2b_shift_types() -> List[dict]:
    return _read_csv(paths.WP2B_SHIFT_TYPES_CSV)


def load_wp2b_guards() -> List[dict]:
    return _read_csv(paths.WP2B_GUARDS_CSV)


def load_wp2b_shift_records() -> List[dict]:
    return _read_csv(paths.WP2B_SHIFT_RECORDS_CSV)


def load_wp5_master_posts() -> List[dict]:
    """WP5g：`out/wp5/master_posts.csv`（老闆總表逐崗位，一行一個 post_id，
    帶埋 client_rate/payout_rate 兩個總表表頭讀出嚟嘅金額）。畀
    `wp3_rates.build_master_roster_payout_rate_cards` 做出街價最後
    fallback用。檔案唔存在（未行過 run-wp5）就回傳 []，caller 自然跌落
    冇呢層 fallback 嘅舊行為。"""
    if not paths.WP5_MASTER_POSTS_CSV.exists():
        return []
    return _read_csv(paths.WP5_MASTER_POSTS_CSV)


def load_wp5_master_assignments() -> List[dict]:
    """WP5g：`out/wp5/master_assignments.csv`（逐崗位逐日格，帶埋當日
    broker_code），畀 `build_master_roster_payout_rate_cards` 逐崗位揀
    「當造」broker 用。檔案唔存在就回傳 []。"""
    if not paths.WP5_MASTER_ASSIGNMENTS_CSV.exists():
        return []
    return _read_csv(paths.WP5_MASTER_ASSIGNMENTS_CSV)


def load_wp2b_master_roster_only_rates() -> List[dict]:
    """WP5c必修12：`out/wp2b/master-roster-only-rates.csv`（總表逐崗位嘅
    client_rate/payout_rate，畀「月結有、更表冇」site生成solved rate_card
    用）。呢個檔冇存在（未行過新版run-wp2b，或者老闆總表未提供）就回傳
    []，caller自然跌落舊行為（呢啲site繼續係known_shift_gap）。"""
    if not paths.WP2B_MASTER_ROSTER_ONLY_RATES_CSV.exists():
        return []
    return _read_csv(paths.WP2B_MASTER_ROSTER_ONLY_RATES_CSV)


# ---------------------------------------------------------------------------
# WP2a 糧明細（data/2026-07/transcribed/*.csv）
# ---------------------------------------------------------------------------

def load_payroll_rows() -> List[dict]:
    return _read_csv(paths.PAYROLL_ROWS_CSV)


def load_payroll_pages() -> List[dict]:
    return _read_csv(paths.PAYROLL_PAGES_CSV)


def load_adjustments() -> List[dict]:
    return _read_csv(paths.ADJUSTMENTS_CSV)


# ---------------------------------------------------------------------------
# invoice_site_aliases.csv（WP3 自己嘅對照表，唔碰 mappings/sites.csv）
# ---------------------------------------------------------------------------

def load_invoice_site_aliases() -> Dict[str, str]:
    """Return {invoice_label: site_id}."""
    return {r["invoice_label"].strip(): r["site_id"].strip()
            for r in _read_csv(paths.INVOICE_SITE_ALIASES_CSV)}


def load_billing_units() -> Dict[str, dict]:
    """Return {site_id: {"extra_shifts_from_monthly": Decimal, "note": str}}。

    P0-執行計劃§3.6/§8 N2：有啲盤（目前已知只有 HKU Y更 S006）月結 R2 有
    逐日更表冇嘅「額外」更次（獨立雞頭費 94 更），呢啲更次冇任何逐日來源
    但同一開票單位嘅收客價一樣，計 Σclient_rate 嘅分母（更數）時要計埋，
    唔係就會靠 shift_records 淨計170更，同發票/R2嘅170+94=264對唔上。"""
    out: Dict[str, dict] = {}
    if not paths.BILLING_UNITS_CSV.exists():
        return out
    for r in _read_csv(paths.BILLING_UNITS_CSV):
        site_id = r["site_id"].strip()
        extra = r.get("extra_shifts_from_monthly") or ""
        out[site_id] = {
            "extra_shifts_from_monthly": int(extra) if extra else 0,
            "note": r.get("note", ""),
        }
    return out


# ---------------------------------------------------------------------------
# 發票 PDF（pdftotext -layout）
# ---------------------------------------------------------------------------

_MONTH_MAP = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
    "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
}

# PDPO：發票 PDF 原文自己有一行寫住真人個名做括號註解（「創富城巴車廠
# (某人名)」，用嚟同無括號嗰行「創富城巴車廠」分開兩張唔同發票/唔同
# billing_model），如果照抄成 label 會令個名流入 out/wp3/invoice-lines.csv、
# billing-unit-solve.csv 等輸出（out/ 雖然唔入 git，但 P0-執行計劃要求個人
# 資料只准放 out/ 同 data/，唔應該無端端喺呢個位帶埋一個第三方唔知情嘅真
# 名周圍走）。呢個 regex 剝走任何「(2-4個中文字)」形狀嘅括號註解，唔存
# 人名；「創富城巴車廠」呢一個特定 label 原本淨係靠個名先分得開行政費
# (IC) 嗰張同per_shift嗰張，剝走之後補返一個角色代號（IC）保持可以分辨，
# 對照表 mappings/invoice_site_aliases.csv 相應改存「創富城巴車廠 IC」。
_PAREN_NAME_RE = re.compile(r"[（(][一-龥]{2,4}[）)]")


def _strip_pdpo_name_suffix(label: str) -> str:
    m = _PAREN_NAME_RE.search(label)
    if not m:
        return label
    base = label[:m.start()].strip()
    if base == "創富城巴車廠":
        return "創富城巴車廠 IC"
    # 其他未知既案例：一律剝走括號人名，唔畀走漏；如果剝完撞到第二個
    # label 要人手覆核（見 rates-report.md 嘅 pending note）。
    return base


# B2（Opus 對抗式驗收第四輪）：三個發票 vendor 全稱都係真實客戶公司名，
# 唔可以硬編碼喺 git-tracked 檔——由 private_mappings.client_name() 讀
# gitignored 嘅 data/mappings-private/client-names.json。冇私隱檔就
# fallback 用 key 本身（例如 "wilson_service_legal"）——呢個 regex
# alternation 會變成一個真實 PDF 發票入面唔可能出現嘅字串，令
# `_INVOICE_LINE_RE` 優雅噉「冇料到」（唔會 crash，亦唔會靜默扮解析成功）。
_INVOICE_VENDOR_ALTERNATION = "|".join(
    re.escape(v)
    for v in (
        client_name("wilson_service_legal"),
        client_name("dusservice_legal"),
        client_name("excellent_property_legal"),
    )
)
_INVOICE_LINE_RE = re.compile(
    r"^\s*'?(?P<inv>MW-\d{4}-\d+[A-Za-z0-9]*)\s+"
    rf"(?P<vendor>{_INVOICE_VENDOR_ALTERNATION})\s+"
    r"(?P<rest>.+?)\s+"
    r"(?P<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?P<yy>\d{2})\s+"
    r"HK\$(?P<amount>[\d,]+\.\d{2})\s*$"
)


def _pdftotext_layout(pdf_path: Path) -> str:
    out = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, check=True,
    )
    return out.stdout.decode("utf-8", errors="replace")


def parse_invoice_pdf(pdf_path: Path = paths.INVOICE_PDF) -> List[dict]:
    """逐行 regex 解析 Invoice Record PDF（pdftotext -layout）。

    Return: [{invoice_no, vendor, label, remark, period(YYYY-MM), amount(str)}]
    `label` 係項目欄第一個 token（同 sites.csv/invoice_site_aliases.csv 對
    嗰個），`remark` 係同一行後面嘅其餘文字（通常係重複盤名或者備註）。
    """
    text = _pdftotext_layout(pdf_path)
    out = []
    for line in text.splitlines():
        m = _INVOICE_LINE_RE.match(line)
        if not m:
            continue
        rest = m.group("rest").strip()
        parts = [p.strip() for p in re.split(r"\s{2,}", rest) if p.strip()]
        label = _strip_pdpo_name_suffix(parts[0]) if parts else ""
        remark = " / ".join(_strip_pdpo_name_suffix(p) for p in parts[1:]) if len(parts) > 1 else ""
        period = f"20{m.group('yy')}-{_MONTH_MAP[m.group('mon')]}"
        out.append({
            "invoice_no": m.group("inv"),
            "vendor": m.group("vendor"),
            "label": label,
            "remark": remark,
            "period": period,
            "amount": m.group("amount").replace(",", ""),
        })
    return out


def parse_settlement_pdf_totals(pdf_path: Path) -> str:
    """月結 PDF 全文（pdftotext -layout），俾 wp3_rates 逐行 regex 搵指定盤嘅
    收客價/出街價/更數（只做總數層面跨月證據，唔逐更對）。"""
    return _pdftotext_layout(pdf_path)
