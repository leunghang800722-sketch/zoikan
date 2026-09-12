"""解析 2026-07-月結總表-FinalR2.pdf（同 5/6 月同款「Final」報表），做收客價
證據優先次序 (a) 嘅資料來源。

對應 P0-執行計劃 WP3v2 條件1第2點：「證據優先次序 (a) 月結 R2「收客價」
欄……寫 parser，記錄係整數價定係「加權平均」定係區間」。

呢份 PDF 係 Excel 直接匯出，`pdftotext -layout` 會將「merge cell 內部斷行」
嘅內容錯位（見 README 相關章節）。呢個 parser 唔靠 `-layout` 嘅文字順序，
改用 `pdftotext -bbox-layout` 攞返逐個字嘅 x/y 座標，自己做返欄位對齊：

  1. 逐個 word 讀 (y, x0, x1, text)。
  2. 用 header 行（「工作地點/更數/收客價/出街價/營業額/成本/盈利」）自己
     嘅 x 座標做欄位邊界，唔寫死數字（PDF 版面變動都應該自動跟到）。
  3. 逐行（y 相近就同一行）分類做「有列號嘅 anchor 行」（1..38 呢種）定係
     「冇列號但有收客價/出街價文字嘅補充行」（Excel merge cell 內部第二/
     三段文字，y 通常喺上一個 anchor 行同下一個 anchor 行之間）。
  4. 補充行掛去「y 喺佢下面最近嗰個 anchor 行」（呢個 anchor 行嘅收客價
     cell 本身通常留空，補充行先係佢真正嘅內容——例如「數碼港」總行冇印
     收客價，個 930/850 印咗喺佢上面一行）。

Return 每個 site label 一條 dict，`client_rate_raw`／`wage_raw` 保留原文
（先判斷係乾淨整數、「XXX/月」月費、「行政費」、定係「700-800」呢種區間，
由呼叫方決定點用；呢個 module 唔幫手估）。
"""
import re
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from decimal import Decimal
from typing import List, Optional

_NS = {"x": "http://www.w3.org/1999/xhtml"}

_ROW_NO_RE = re.compile(r"^\d{1,2}$")
_MONEY_RE = re.compile(r"^HK\$[\d,]+(\.\d+)?$")
_RANGE_RE = re.compile(r"^(HK\$)?[\d,]+-[\d,]+$")
_MONTHLY_RE = re.compile(r"^[\d,]+/月$")
_HOURLY_RE = re.compile(r"^[\d,]+/hr$")


@dataclass
class R2Row:
    row_no: str
    label: str
    shifts: Optional[int]
    client_rate_texts: List[str] = field(default_factory=list)   # 由上至下，通常0-2個
    wage_texts: List[str] = field(default_factory=list)
    revenue: Optional[Decimal] = None
    cost: Optional[Decimal] = None
    profit: Optional[Decimal] = None

    def primary_client_rate(self) -> Optional[str]:
        """最貼近呢行自己（y 最接近／或者行自己嗰句）嘅收客價文字——通常
        係最後加入嗰個（同 anchor 行最近，見 attach 邏輯），如果冇任何補充
        行就係 anchor 行自己嗰句。"""
        return self.client_rate_texts[-1] if self.client_rate_texts else None


def _words(pdf_path) -> List[tuple]:
    out = subprocess.run(
        ["pdftotext", "-bbox-layout", str(pdf_path), "-"],
        capture_output=True, check=True,
    )
    xml_text = out.stdout.decode("utf-8", errors="replace")
    root = ET.fromstring(xml_text)
    words = []
    for page in root.findall(".//x:page", _NS):
        for w in page.findall(".//x:word", _NS):
            words.append((float(w.get("yMin")), float(w.get("xMin")), float(w.get("xMax")), w.text or ""))
    return words


def _cluster_lines(words: List[tuple], tol: float = 2.5) -> List[List[tuple]]:
    words = sorted(words, key=lambda t: (t[0], t[1]))
    lines: List[List[tuple]] = []
    for y, x0, x1, t in words:
        if lines and abs(y - lines[-1][0][0]) <= tol:
            lines[-1].append((y, x0, x1, t))
        else:
            lines.append([(y, x0, x1, t)])
    for ln in lines:
        ln.sort(key=lambda t: t[1])
    return lines


def _money(text: str) -> Optional[Decimal]:
    if not text:
        return None
    t = text.replace("HK$", "").replace(",", "").strip()
    try:
        return Decimal(t)
    except Exception:
        return None


def parse_r2_rows(pdf_path) -> List[R2Row]:
    words = _words(pdf_path)
    lines = _cluster_lines(words)

    # 搵 header 行嘅欄位 x 中心（唔寫死數字）
    col_x = {}
    header_y = None
    for ln in lines:
        texts = {t for _, _, _, t in ln}
        if {"工作地點", "更數", "收客價"}.issubset(texts):
            for y, x0, x1, t in ln:
                if t in ("工作地點", "更數", "收客價", "出街價", "營業額", "成本", "盈利"):
                    col_x[t] = (x0 + x1) / 2
            header_y = ln[0][0]
            break
    if not col_x:
        return []

    def nearest_col(x):
        return min(col_x.items(), key=lambda kv: abs(kv[1] - x))[0]

    anchors = []          # [(y, row_no, label, shifts, revenue, cost, profit)]
    orphans = []           # [(y, client_rate_text_or_None, wage_text_or_None)]

    for ln in lines:
        y0 = ln[0][0]
        if y0 <= header_y:
            continue  # 標題／header 行自己，唔當資料
        by_col = {}
        row_no = None
        for y, x0, x1, t in ln:
            col = nearest_col((x0 + x1) / 2)
            if col == "工作地點" and _ROW_NO_RE.match(t) and x0 < col_x.get("工作地點", 999) - 15:
                row_no = t
                continue
            by_col.setdefault(col, []).append(t)

        has_row_no = row_no is not None
        if not has_row_no:
            cr = " ".join(by_col.get("收客價", [])) or None
            wg = " ".join(by_col.get("出街價", [])) or None
            if cr or wg:
                orphans.append((y0, cr, wg))
            continue

        label = "".join(by_col.get("工作地點", []))
        shifts_txt = "".join(by_col.get("更數", []))
        shifts = int(shifts_txt) if shifts_txt.isdigit() else None
        cr_own = " ".join(by_col.get("收客價", [])) or None
        wg_own = " ".join(by_col.get("出街價", [])) or None
        revenue = _money("".join(by_col.get("營業額", [])))
        cost = _money("".join(by_col.get("成本", [])))
        profit = _money("".join(by_col.get("盈利", [])))
        anchors.append((y0, row_no, label, shifts, cr_own, wg_own, revenue, cost, profit))

    rows: List[R2Row] = []
    anchor_ys = [a[0] for a in anchors]
    for idx, (y0, row_no, label, shifts, cr_own, wg_own, revenue, cost, profit) in enumerate(anchors):
        r = R2Row(row_no=row_no, label=label, shifts=shifts, revenue=revenue, cost=cost, profit=profit)
        if cr_own:
            r.client_rate_texts.append(cr_own)
        if wg_own:
            r.wage_texts.append(wg_own)
        rows.append(r)

    # 每條孤兒補充行掛去 y 距離最近嘅 anchor（Excel merge cell 嘅內容可以
    # 印喺 anchor 行前面（見數碼港第一段930/850）或者後面（見數碼港第二段
    # 850/725、國泰城1000/890 vs 950/780）——純粹跟距離揀，唔可以假設一定
    # 掛去「下一個」anchor（呢個係之前試過嘅錯誤假設，令國泰城第二段錯配
    # 咗去皓日行）。
    for y0, cr, wg in orphans:
        if not anchor_ys:
            continue
        best_idx = min(range(len(anchor_ys)), key=lambda i: abs(anchor_ys[i] - y0))
        r = rows[best_idx]
        if cr:
            r.client_rate_texts.insert(0, cr) if anchor_ys[best_idx] > y0 else r.client_rate_texts.append(cr)
        if wg:
            r.wage_texts.insert(0, wg) if anchor_ys[best_idx] > y0 else r.wage_texts.append(wg)

    return rows


def classify_rate_text(text: Optional[str]) -> dict:
    """判斷一個收客價/出街價文字係「整數」「區間」「月費」「行政費」定係
    「按鐘」，Return {"kind":..., "value": Decimal或None, "raw": text}。"""
    if not text:
        return {"kind": "empty", "value": None, "raw": text}
    t = text.strip()
    if t == "行政費":
        return {"kind": "admin_fee", "value": None, "raw": t}
    if _MONTHLY_RE.match(t):
        return {"kind": "monthly", "value": _money(t.replace("/月", "")), "raw": t}
    if _HOURLY_RE.match(t):
        return {"kind": "hourly", "value": _money(t.replace("/hr", "")), "raw": t}
    if _RANGE_RE.match(t):
        return {"kind": "range", "value": None, "raw": t}
    v = _money(t)
    if v is not None:
        return {"kind": "clean", "value": v, "raw": t}
    return {"kind": "unknown", "value": None, "raw": t}


def r2_rows_by_label(pdf_path) -> dict:
    """Return {label: R2Row}（重複label好少見，撞咗就用最後一條）。"""
    return {r.label: r for r in parse_r2_rows(pdf_path)}


def single_clean_candidate(row: R2Row) -> Optional[Decimal]:
    """如果呢行全部收客價候選文字入面淨係得一個唯一嘅「乾淨整數」值（唔理
    位置/唔理同R2自己嘅營業額啱唔啱），就return嗰個值——用嚟俾
    `best_client_rate`（要求同R2自己個revenue啱數）搵唔到都仲有得試嘅
    弱一層證據：呢個值起碼係R2親身印低嘅，唔係憑空估，淨係未必啱呢一行
    自己嘅更數/營業額（例如R2嗰行嘅更數/營業額同我哋shift_records/發票
    覆蓋嘅範圍唔完全一樣——控制室嗰1,350「每月固定」殘差就係呢種情況：
    R2話「840」，但66更×840同R2自己印嘅56,790營業額都已經差1,350，唔會
    喺best_client_rate度過關，要留返俾呼叫方用我哋自己嘅shift_records
    更數/發票金額去驗證，仲要接受個殘差）。"""
    values = set()
    for text in row.client_rate_texts:
        info = classify_rate_text(text)
        if info["kind"] == "clean" and info["value"] is not None:
            values.add(info["value"])
    if len(values) == 1:
        return next(iter(values))
    return None


def best_client_rate(row: R2Row, tolerance: Decimal = Decimal("1")) -> Optional[dict]:
    """喺呢行全部收客價候選文字（可能一個 merge cell 有幾段，唔一定邊段
    先係「真正」嗰個）入面，揀一個令 `更數 × rate ≈ 呢行自己嘅營業額`
    （R2 嘅營業額本身印到淨係得成蚊，冇仙，容忍 ±1 蚊嘅印刷四捨五入）嘅
    candidate——唔靠位置順序估邊句先係「岩」嗰句，靠算式驗證。搵唔到就
    return None（呢行可能係月費/行政費/區間/多價冇單一rate，或者根本冇印
    收客價，要交俾其他證據方法）。"""
    if row.shifts is None or row.revenue is None:
        return None
    for text in row.client_rate_texts:
        info = classify_rate_text(text)
        if info["kind"] != "clean" or info["value"] is None:
            continue
        predicted = info["value"] * row.shifts
        if abs(predicted - row.revenue) <= tolerance:
            return {"value": info["value"], "raw": text,
                    "note": f"R2 row{row.row_no}「{row.label}」收客價={text}，"
                            f"{row.shifts}更×{info['value']}={predicted}，"
                            f"同R2自己印嘅營業額{row.revenue}相符（±{tolerance}蚊印刷誤差）"}
    return None
