"""WP3 orchestration：⑤ rates + ⑥ report 一齊行，輸出 out/wp3/*。

CLI: `python -m importer run-wp3`
"""
import csv
import json
import random
from collections import Counter, defaultdict
from decimal import Decimal
from typing import Dict, List

from . import mappings_io, paths, wp3_io, wp3_pricing, wp3_rates, wp3_reports
from .normalize import BrokerIndex, SiteIndex, load_payroll_cells, normalize_name
from .private_mappings import broker_canonical_name

# PDPO：雞頭真名（K/W/G/P）淨係喺呢度經 private_mappings 讀一次（冇 private
# 檔就 fallback 用代號本身，見 private_mappings.py）。
_BROKER_K = broker_canonical_name("K")
_BROKER_W = broker_canonical_name("W")
_BROKER_G = broker_canonical_name("G")
_BROKER_P = broker_canonical_name("P")  # B08，個別雞頭（settlement_type=salary）
_BROKER_K_1331 = f"{_BROKER_K}-1331"


def _write_csv(path, rows, fieldnames):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


RATE_CARD_FIELDS = [
    "rate_id", "site_id", "shift_type_id", "broker_id", "guard_id",
    "client_rate", "guard_wage", "broker_fee", "payout_rate",
    "billing_model", "effective_from", "effective_to",
    "source", "evidence", "confidence", "status", "note", "evidence_chain",
]

BILLING_ADJUSTMENT_FIELDS = [
    "site_id", "label", "adjustment_amount", "period", "status", "note",
]

PRICED_FIELDS = None  # 動態：shift_records.csv 原有欄 + 新欄


def _build_guards_by_name(guards: List[dict]) -> Dict[str, List[dict]]:
    idx = defaultdict(list)
    for g in guards:
        idx[normalize_name(g["name_zh"])].append(g)
    return idx


def run_wp3() -> dict:
    paths.clean_out_wp3_dir()

    sites = wp3_io.load_wp2b_sites()
    brokers = wp3_io.load_wp2b_brokers()
    shift_types = wp3_io.load_wp2b_shift_types()
    guards = wp3_io.load_wp2b_guards()
    shift_records = wp3_io.load_wp2b_shift_records()
    payroll_rows = wp3_io.load_payroll_rows()
    longterm_staff = mappings_io.load_longterm_staff()
    invoice_lines_all = wp3_io.parse_invoice_pdf()
    invoice_lines = [l for l in invoice_lines_all if l["period"] == "2026-07"]
    invoice_lines_may_jun = [l for l in invoice_lines_all if l["period"] in ("2026-05", "2026-06")]
    invoice_aliases = wp3_io.load_invoice_site_aliases()
    billing_units = wp3_io.load_billing_units()

    site_index = SiteIndex(sites)
    broker_index = BrokerIndex(brokers)
    sites_by_id = {s["site_id"]: s for s in sites}
    guards_by_name = _build_guards_by_name(guards)
    known_rates = wp3_rates.known_rates_from_payroll(payroll_rows)

    # WP2b sites.csv 冇幫都會大學夜巡邏（S032＝發票"Wilson Patrol"）標
    # billing_model（預設落咗per_shift），但P0-執行計劃§3.7/3.7a同3.7節列明
    # 呢個係月費/行政費制（19,804/月，冇逐更收費）。WP3淨係喺自己本地嘅
    # sites_by_id複本做呢個修正，唔改out/wp2b/sites.csv（WP2b已驗收檔案）。
    if "S032" in sites_by_id:
        sites_by_id["S032"] = dict(sites_by_id["S032"], billing_model="monthly_fixed")

    # WP3v2 條件1第4點：屯門小欖(S027)、淺水灣11號(S029) 喺 mappings/sites.csv
    # 標緊per_shift，但R2/發票證據顯示佢哋其實係「月費，唔隨更數變，7月按
    # 30/31日比例pro-rata」（小欖 50,000×30/31=48,387.10、淺水灣
    # 87,000×30/31=84,193.55，兩個都同R2/發票金額啱），唔係per_shift。
    # 跟返S032同一個做法：淨係喺WP3自己嘅sites_by_id複本改，唔碰
    # mappings/sites.csv／out/wp2b/sites.csv（WP2b已驗收）。凱和山(S009)
    # 就唔喺呢度改——佢嘅revenue會隨實際更數變（900×30/31×count），真係
    # per_shift，只不過個rate本身要pro-rata，喺wp3_rates.build_client_rate_cards
    # 嘅(d)步驟處理。
    for _sid in ("S027", "S029"):
        if _sid in sites_by_id:
            sites_by_id[_sid] = dict(sites_by_id[_sid], billing_model="monthly_fixed")

    rcb = wp3_rates.RateCardBuilder()

    # A. 出街價（現金結算單位，payroll-rows.csv 逐行）
    payout_meta = wp3_rates.build_payout_rate_cards(
        payroll_rows, site_index, broker_index, guards_by_name, rcb)

    # A2（WP5b，2026-09-10）：老闆總表已確認嘅啟航1331 K 7個更別上單價
    # ／外判價——第一優先證據，喺線性解之前。回傳嘅 covered 集合傳落
    # solve_kai1331，剔走呢啲 shift_type，唔好再解一次。
    master_roster_rate_covered = wp3_rates.build_master_roster_rate_cards(
        shift_types, site_id="S017", broker_id="B01", rcb=rcb)

    # A2b（WP5c必修12，2026-09-10）：「月結有、更表冇」site（國泰城/M+/
    # CP5 IC/控制室/威信Patrol/ICBC/哈羅）由總表逐崗位補入庫嘅
    # shift_records，逐崗位自己嘅上單價/外判價直接生成solved rate_card（唔
    # 靠反推）。
    master_roster_only_rate_rows = wp3_io.load_wp2b_master_roster_only_rates()
    wp3_rates.build_master_roster_only_rate_cards(
        master_roster_only_rate_rows, broker_index=broker_index, rcb=rcb)

    # A4（WP5g，2026-09-11）：出街價最後 fallback——master_posts.csv 逐崗位
    # 表頭外判價（P0-執行計劃§8 Q10 已答）。一定要喺 A/A2/A2b 全部加完
    # rcb.rows 之後先 call（「現有卡優先，唔覆蓋」靠查返 rcb.rows 現狀）。
    master_posts_rows = wp3_io.load_wp5_master_posts()
    master_assignments_rows = wp3_io.load_wp5_master_assignments()
    master_roster_payout_meta = wp3_rates.build_master_roster_payout_rate_cards(
        master_posts_rows, master_assignments_rows, shift_types,
        broker_index=broker_index, rcb=rcb)

    # B. 啟航1331 K 段：線性解（剩低未覆蓋嘅 shift_type，2026-09-10 現狀：
    # 7 個 block 全部由 A2 覆蓋，呢步實際上冇嘢好解，但逐日 residual 報表
    # 照計——傳埋已知 payout_rate 落去，等 P3a 嘅 7/31 殘差證據唔會斷)
    master_roster_known_payout = {
        st["shift_type_id"]: wp3_rates.MASTER_ROSTER_KAI1331_RATES[
            (st["rank"], st["time_slot"])][1]
        for st in shift_types
        if st["site_id"] == "S017" and (st["rank"], st["time_slot"]) in wp3_rates.MASTER_ROSTER_KAI1331_RATES
    }
    kai1331_meta = wp3_rates.solve_kai1331(
        shift_records, shift_types, payroll_rows, site_id="S017", rcb=rcb,
        longterm_staff=longterm_staff, skip_shift_type_ids=master_roster_rate_covered,
        known_payout_rates=master_roster_known_payout)

    # B'. 特殊收入項（個別雞頭月薪/Event佣金、啟航1331 Event）：billing_model=special，
    # 只記總額，唔做 per_shift。
    special_rows = [r for r in payroll_rows if r["settlement_unit"] == _BROKER_P]
    for r in special_rows:
        rcb.add(site_id="S064", broker_id="B08", billing_model="special",
                guard_wage=wp3_rates.D(r["amount"]),
                source="payroll-rows.csv",
                evidence=f"{r['source_file']}#p{r['page']}#row{r['row_no']}({r['site_label']},{r['guard_name']},{r['amount']})",
                confidence="high", status="solved",
                note=f"{r['remark']}（特殊收入項，個別雞頭月薪/Event佣金，非per_shift）")
    # WP5b（2026-09-10）修正：以前呢度將 shift_type_id 寫死做字串常量
    # "ST0026"——當時真係 Event Guard，但 shift_type_id 由 code_counter
    # sorted() 動態編號，data 一變（例如 rule 0.2 生效後 unpriced 記錄結構
    # 唔變，但呢個 site 本身收錄嘅 rank/time_slot 組合有機會隨輸入檔更新而
    # 變）就會漂移——而家 ST0026 其實係「早更保安員」（12h Day），寫死個
    # "ST0026" 會撞正 master_roster_rate 嘅 RC0142（早更保安員 client_
    # rate=1200），令 _pick_card 喺 site_st 層見到兩個「solved」candidate
    # 變 ambiguous，S017 成組普通更次（ST0026/ST0027等）client_rate 全部搵
    # 唔到。改為由 shift_types 動態搵 rank=="Event Guard" 嘅真實 ID，唔再
    # 寫死，先永遠啱返個真實 Event Guard 更別。
    _event_guard_st_id = next(
        (st["shift_type_id"] for st in shift_types
         if st["site_id"] == "S017" and st["rank"] == "Event Guard"), "")
    for line in invoice_lines:
        if line["label"] == "啟航1331 Event":
            # shift_type_id 一定要填「Event Guard」自己嘅 ID：唔可以留空，
            # 唔係 pricing.py 揾呢個site普通1331更次（其餘6個shift_type）嘅
            # client_rate嗰陣，會經「site」呢層fallback錯誤襲用咗Event嘅
            # 11,700（真實出現過嘅bug，由sample-audit.csv揭發：SR003802/
            # SR002370等普通更次錯配咗rate_id=Event嗰張卡）。
            if not _event_guard_st_id:
                raise RuntimeError(
                    "run-wp3 fail fast：S017 shift_types 搵唔到 rank=='Event Guard'，"
                    "冇辦法鎖定 Event Guard 特殊收入項張卡嘅 shift_type_id（唔可以留空/"
                    "寫死，會令普通1331更次錯配client_rate）——check shift_types.csv")
            rcb.add(site_id="S017", shift_type_id=_event_guard_st_id, billing_model="special",
                    client_rate=wp3_rates.D(line["amount"]), source="invoice",
                    evidence=f"Invoice-Record#{line['invoice_no']}(啟航1331 Event, Jul-26, HK${line['amount']})",
                    confidence="high", status="solved",
                    note=f"Event Guard特殊收入項，更表只見4個Event Guard（P0-執行計劃§4），唔按更數拆；"
                         f"shift_type_id鎖定{_event_guard_st_id}(Event Guard，動態搵rank，唔再寫死)，"
                         "唔影響其餘1331普通更次；WP5c必修6：呢11,700獨立核實=6×1,350"
                         "（0900-1800）+4×900（1000-1600），pdftotext核對Invoice-Record"
                         "MW-2026-07006金額一致，同主發票MW-2026-07005嘅4個1000-1900"
                         "Event Guard cell（$1,200/更）係唔同嘅一批Event，唔可以夾埋。")

    # C. 收客價：證據優先次序 (a)R2月結 -> (b)發票整除 -> (c)OT按鐘 ->
    # (d)pro-rata -> (e)兩價（P0-執行計劃 WP3v2 條件1第2點）
    shift_type_billing_group = {st["shift_type_id"]: st.get("billing_group", "per_shift")
                                 for st in shift_types}
    shift_counts = wp3_rates._shift_counts_by_site_and_type(
        shift_records, shift_type_billing_group, billing_units)
    r2_by_site = wp3_rates.r2_rows_by_site_id(
        paths.SETTLEMENT_PDF_2026_07, site_index, invoice_aliases)
    billing_adjustments: List[dict] = []
    # WP5c必修6：MW-2026-07005（啟航1331主單位）唔交俾呢個generic
    # per-invoice-line loop處理——嗰個loop嘅「發票÷混埋total_shifts整除」
    # 「兩價分解」兩個方法對呢張發票永遠解唔到（7個更別各有唔同rate，唔係
    # 一個劃一rate），會生成一張永遠pending嘅RC0155。改用
    # wp3_rates.solve_kai1331_main_gate()（下面）用真口徑（Σ已解6個更別
    # snapshot + Event Guard cell殘差 + 已知count缺口）驗證。
    kai1331_main_invoice_line = next(
        (l for l in invoice_lines if l["invoice_no"] == "MW-2026-07005"), None)
    invoice_lines_for_generic = [
        l for l in invoice_lines if l["invoice_no"] != "MW-2026-07005"]
    client_solve_log = wp3_rates.build_client_rate_cards(
        invoice_lines_for_generic, site_index, invoice_aliases, shift_counts, sites_by_id, rcb,
        cross_month_lines=invoice_lines_may_jun, known_rates=known_rates,
        r2_by_site=r2_by_site, billing_adjustments=billing_adjustments)

    # WP5c必修12：威信控制室（S031）以前冚唪唥安員都用單一840估計，同R2/
    # 發票56,790有1,350殘差要靠billing_adjustments解釋（見上面(b2)/(c)嗰
    # 段代碼）。而家第3位安員（901.36/更，master_roster_only_rate卡，PDPO：
    # 真名喺out/wp2b/guards.csv用guard_id查）嘅22更已經逐更stamp咗真實
    # rate，呢個1,350殘差已經俾真實snapshot自己解釋咗（44×840+22×901.36≈
    # 56,789.92，同發票差返0.08蚊嘅quantize尾數），generic loop果條
    # billing_adjustments如果留低就會雙重計算（令diff變負數）——喺呢度
    # 剔走佢，唔係喺build_client_rate_cards（唔想為單一site改generic
    # 邏輯，風險太高）。
    billing_adjustments[:] = [a for a in billing_adjustments if a["site_id"] != "S031"]

    rate_cards = rcb.rows

    # ⑤ 尾段：apply rate_cards -> shift_records_priced / unpriced（第一次跑，
    # 俾 Gate 攞 client_rate_snapshot 加總）
    priced_rows, unpriced_rows = wp3_pricing.price_shift_records(
        shift_records, rate_cards, broker_index, sites_by_id, shift_type_billing_group)

    # Gate（P0-執行計劃 WP3v2 條件1第3點）：Σclient_rate_snapshot（+billing_
    # adjustments）同發票唔啱嘅 solved 收客價，退返pending。呢個會就地改
    # rate_cards 嘅status，所以要用返新嘅rate_cards重跑一次pricing，先至
    # 令priced_rows/unpriced_rows/三份報表反映返downgrade咗嘅結果。
    gate_rows, downgraded_sites = wp3_rates.apply_client_rate_gate(
        rate_cards, priced_rows, client_solve_log, billing_adjustments,
        billing_units=billing_units)
    if downgraded_sites:
        priced_rows, unpriced_rows = wp3_pricing.price_shift_records(
            shift_records, rate_cards, broker_index, sites_by_id, shift_type_billing_group)
        for c in client_solve_log:
            if c["site_id"] in downgraded_sites and c["status"].startswith("solved"):
                c["status"] = "pending(gate_failed)"
                c["note"] = (c["note"] + "; " if c["note"] else "") + "Gate唔過，退pending，見gate-results.csv"

    # WP5c必修6：啟航1331主單位（MW-2026-07005）用真口徑補返gate/solve_log
    # 一行——要喺呢度（priced_rows已經反映咗最終rate_cards，包括可能嘅
    # downgrade重跑）先計，先攞到準確嘅client_rate_snapshot。
    kai1331_solve_row, kai1331_gate_row = wp3_rates.solve_kai1331_main_gate(
        priced_rows, shift_types, r2_by_site, kai1331_main_invoice_line, site_id="S017")
    if kai1331_solve_row:
        client_solve_log.append(kai1331_solve_row)
    if kai1331_gate_row:
        gate_rows.append(kai1331_gate_row)

    _write_csv(paths.WP3_RATE_CARDS_CSV, rate_cards, RATE_CARD_FIELDS)
    _write_csv(paths.WP3_BILLING_ADJUSTMENTS_CSV, billing_adjustments, BILLING_ADJUSTMENT_FIELDS)
    _write_csv(paths.WP3_GATE_RESULTS_CSV, gate_rows,
               ["site_id", "label", "invoice_no", "invoice_amount", "snapshot_sum",
                "billing_adjustments", "diff", "gate"])

    priced_fields = list(shift_records[0].keys()) + [
        "client_rate_snapshot", "guard_wage_snapshot", "broker_fee_snapshot",
        "client_rate_id", "payout_rate_id", "pricing_note",
    ]
    _write_csv(paths.WP3_SHIFT_RECORDS_PRICED_CSV, priced_rows, priced_fields)
    _write_csv(paths.WP3_UNPRICED_CSV, unpriced_rows,
               ["shift_id", "guard_id", "site_id", "shift_type_id",
                "settlement_unit", "work_date", "reason"])

    # 逐日殘差（K-1331）
    _write_csv(paths.WP3_KAI1331_RESIDUALS_CSV, kai1331_meta["residuals"],
               ["work_date", "predicted", "actual", "residual"])

    # 發票逐行解析結果 + 逐開票單位解值 log
    _write_csv(paths.WP3_INVOICE_LINES_CSV, invoice_lines,
               ["invoice_no", "vendor", "label", "remark", "period", "amount"])
    _write_csv(paths.WP3_BILLING_UNIT_SOLVE_CSV, client_solve_log,
               ["invoice_no", "label", "site_id", "amount", "shifts", "client_rate", "status", "note"])

    # ⑥ 三份報表
    guards_by_id = {g["guard_id"]: g for g in guards}
    roundtrip_diff = wp3_reports.build_roster_reports(paths.OUT_WP3_REPORTS_DIR)
    _write_csv(paths.WP3_ROUNDTRIP_DIFF_CSV, roundtrip_diff,
               ["file", "row", "staff_no", "name", "work_date", "category", "note"])

    payroll_pages = wp3_io.load_payroll_pages()
    payroll_cells = load_payroll_cells()
    payroll_diff = wp3_reports.build_payroll_report(
        paths.OUT_WP3_REPORTS_DIR, priced_rows, sites_by_id, guards_by_id, payroll_rows,
        payroll_pages=payroll_pages, raw_shift_records=shift_records, payroll_cells=payroll_cells)
    _write_csv(paths.WP3_PAYROLL_DIFF_CSV, payroll_diff,
               ["settlement_unit", "site_label", "guard_name", "payroll_amount",
                "regenerated_amount", "diff", "note", "category"])

    monthly_diff, settle_rows = wp3_reports.build_monthly_report(
        paths.OUT_WP3_REPORTS_DIR, priced_rows, sites_by_id, invoice_aliases, rate_cards,
        shift_type_billing_group=shift_type_billing_group, billing_units=billing_units,
        unpriced_rows=unpriced_rows, client_solve_log=client_solve_log,
        payroll_cells=payroll_cells)
    _write_csv(paths.WP3_MONTHLY_DIFF_CSV, monthly_diff,
               ["row_no", "label", "site_id", "r2_shifts", "regen_shifts",
                "r2_revenue", "regen_revenue", "note", "category", "reason"])

    # 抽樣覆核：隨機 30 條 priced shift_records + 5 個開票單位
    sample_rows = _sample_audit(priced_rows, rate_cards, payroll_rows, invoice_lines,
                                 client_solve_log, sites_by_id, shift_counts, seed=20260904)
    _write_csv(paths.WP3_SAMPLE_AUDIT_CSV, sample_rows,
               ["kind", "key", "expected", "actual", "match", "evidence"])

    summary = {
        "rate_cards": len(rate_cards),
        "solved": sum(1 for r in rate_cards if r["status"] == "solved"),
        "pending": sum(1 for r in rate_cards if r["status"] == "pending"),
        "priced": len(priced_rows),
        "unpriced": len(unpriced_rows),
        "kai1331_max_resid": round(kai1331_meta["max_abs_resid_excl_outlier"], 1),
        "invoice_lines_jul": len(invoice_lines),
        "roundtrip_diff": len(roundtrip_diff),
        "payroll_diff": len(payroll_diff),
        "monthly_diff": len(monthly_diff),
        "master_roster_payout": master_roster_payout_meta,
    }

    _write_rates_report(sites_by_id, rate_cards, kai1331_meta, client_solve_log,
                         payout_meta, unpriced_rows, summary, sample_rows,
                         roundtrip_diff, payroll_diff, monthly_diff, gate_rows,
                         master_roster_payout_meta=master_roster_payout_meta)

    return summary


def _sample_audit(priced_rows, rate_cards, payroll_rows, invoice_lines,
                   client_solve_log, sites_by_id, shift_counts, seed):
    rng = random.Random(seed)
    rc_by_id = {rc["rate_id"]: rc for rc in rate_cards}
    out = []

    priceable = [r for r in priced_rows if r["client_rate_id"] or r["payout_rate_id"]]
    sample = rng.sample(priceable, min(30, len(priceable)))
    for r in sample:
        expected_bits = []
        actual_bits = []
        ok = True
        if r["client_rate_id"]:
            rc = rc_by_id.get(r["client_rate_id"], {})
            expected_bits.append(f"client_rate rate_id={r['client_rate_id']} evidence={rc.get('evidence','')[:200]}")
            actual_bits.append(f"client_rate_snapshot={r['client_rate_snapshot']}")
            if rc.get("billing_model") in ("monthly_fixed", "admin_fee", "special"):
                # 呢類billing_model刻意唔逐更stamp snapshot（見wp3_pricing.py
                # 嘅設計說明——月費/特殊收入項唔可以逐更乘大），所以「啱」嘅
                # 定義係snapshot維持空白、client_rate_id指返去嗰張靜態卡。
                ok = ok and (r["client_rate_snapshot"] == "")
            else:
                ok = ok and (r["client_rate_snapshot"] == rc.get("client_rate"))
        if r["payout_rate_id"]:
            for rid in r["payout_rate_id"].split(";"):
                rc = rc_by_id.get(rid, {})
                expected_bits.append(f"payout rate_id={rid} evidence={rc.get('evidence','')[:200]}")
        actual_bits.append(f"guard_wage_snapshot={r['guard_wage_snapshot']} broker_fee_snapshot={r['broker_fee_snapshot']}")
        out.append({
            "kind": "shift_record_sample",
            "key": f"{r['shift_id']}({r['guard_id']},{r['site_id']},{r['work_date']})",
            "expected": " | ".join(expected_bits),
            "actual": " | ".join(actual_bits),
            "match": "TRUE" if ok else "REVIEW",
            "evidence": r.get("provenance_file", "") + "#" + r.get("provenance_cell", ""),
        })

    # 5 個開票單位：Σclient_rate_snapshot vs 發票金額
    solved_units = [c for c in client_solve_log if c["status"].startswith("solved") and c["shifts"]]
    unit_sample = rng.sample(solved_units, min(5, len(solved_units)))
    site_priced_sum = defaultdict(Decimal)
    for r in priced_rows:
        if r["client_rate_snapshot"]:
            site_priced_sum[r["site_id"]] += Decimal(r["client_rate_snapshot"])
    for u in unit_sample:
        expected = Decimal(u["amount"])
        actual = site_priced_sum.get(u["site_id"], Decimal("0"))
        out.append({
            "kind": "billing_unit_sample",
            "key": f"{u['invoice_no']}({u['label']},site={u['site_id']})",
            "expected": str(expected),
            "actual": str(actual),
            "match": "TRUE" if expected == actual else "REVIEW",
            "evidence": f"Invoice-Record#{u['invoice_no']}",
        })
    return out


def _write_rates_report(sites_by_id, rate_cards, kai1331_meta, client_solve_log,
                         payout_meta, unpriced_rows, summary, sample_rows,
                         roundtrip_diff=None, payroll_diff=None, monthly_diff=None,
                         gate_rows=None, master_roster_payout_meta=None):
    roundtrip_diff = roundtrip_diff or []
    payroll_diff = payroll_diff or []
    monthly_diff = monthly_diff or []
    lines = []
    lines.append("# WP3 ⑤ rates + ⑥ report 報告\n")
    lines.append("由 `python -m importer run-wp3` 自動生成，數字由 `out/wp3/*.csv` 直接計，"
                  "唔係手打。對應 P0-執行計劃.md §7 WP3 驗收準則。\n")

    lines.append("## 1. rate_cards 總覽\n")
    lines.append(f"- 總數：{summary['rate_cards']}")
    lines.append(f"- solved：{summary['solved']}")
    lines.append(f"- pending：{summary['pending']}\n")

    lines.append("## 1a. Gate（Σclient_rate_snapshot vs 發票，條件1第3點）\n")
    gate_rows = gate_rows or []
    lines.append("任何 solved 收客價都要通過呢個 Gate（`wp3_rates.apply_client_rate_gate`）"
                  "先至留得低——Σclient_rate_snapshot（+billing_adjustments.csv 已知殘差、"
                  "+KNOWN_SHIFT_COUNT_DIFFS 已知更數差容忍度）同發票差 >0.05 就自動退返"
                  "pending（見 `gate-results.csv`）。\n")
    lines.append("| site_id | 項目 | 發票 | Σsnapshot | adjustments | 差額 | Gate |")
    lines.append("|---|---|---|---|---|---|---|")
    for g in sorted(gate_rows, key=lambda x: x["site_id"]):
        lines.append(f"| {g['site_id']} | {g['label']} | {g['invoice_amount']} | "
                      f"{g['snapshot_sum']} | {g['billing_adjustments']} | {g['diff']} | {g['gate']} |")
    n_fail = sum(1 for g in gate_rows if g["gate"] == "FAIL")
    lines.append(f"\n共 {len(gate_rows)} 個可比開票單位，{n_fail} 條 FAIL（理應為 0，Gate FAIL 嘅"
                  "rate_card已經自動降返pending，唔會喺rate_cards.csv/billing-unit-solve.csv度"
                  "仲顯示solved）。\n")

    lines.append("## 2. 收客價（client_rate）逐開票單位\n")
    lines.append("| 發票 | 項目 | site_id | 金額 | 更數 | 解出價 | 狀態 |")
    lines.append("|---|---|---|---|---|---|---|")
    for c in sorted(client_solve_log, key=lambda x: x["invoice_no"]):
        lines.append(f"| {c['invoice_no']} | {c['label']} | {c['site_id']} | {c['amount']} | "
                      f"{c['shifts']} | {c['client_rate']} | {c['status']} |")
    lines.append("")

    pending_client = [c for c in client_solve_log if c["status"] == "pending" or c["status"].startswith("pending")]
    lines.append(f"### 2a. pending 清單（{len(pending_client)} 條）\n")
    for c in pending_client:
        lines.append(f"- **{c['invoice_no']} {c['label']}**（site={c['site_id']}, 金額={c['amount']}, "
                      f"更數={c['shifts']}）：{c['note']}")
    lines.append("")

    lines.append("## 3. 啟航1331（K 段）出街價線性解\n")
    lines.append(f"- design matrix rank = {kai1331_meta['rank_full']} / {kai1331_meta['n_types']} 個更別"
                  "（rank 細過欄數 = 有幾個更別逐日人數完全相等，結構性冇法個別拆解）")
    lines.append(f"- 非離群日（排除 7/31）最大殘差：{round(kai1331_meta['max_abs_resid_excl_outlier'],1)} 蚊")
    lines.append(f"- 離群日：{kai1331_meta['outlier_days']}（7/31 總額 68,080，"
                  "係其他日子嘅約2.4倍，但當日更數同其他日子同一水平；"
                  "已喺 payroll-pages.csv 由 WP2a 逐格核對過『完全對數』，"
                  "所以呢個唔係轉錄錯，係源頭資料本身嘅離群值，交老闆/WP4核實原因）")
    solved_kai = [r for r in rate_cards if r["source"] == "kai1331_linear_solve" and r["status"] == "solved"]
    pending_kai = [r for r in rate_cards if r["source"] == "kai1331_linear_solve" and r["status"] == "pending"]
    lines.append(f"- 解到 {len(solved_kai)} 個更別，pending {len(pending_kai)} 組：\n")
    for r in solved_kai:
        lines.append(f"  - {r['shift_type_id']}：payout_rate={r['payout_rate']}（{r['note']}）")
    for r in pending_kai:
        lines.append(f"  - {r['shift_type_id']}（pending）：{r['note']}")
    lines.append("")
    lines.append("逐日殘差見 `out/wp3/kai1331-daily-residuals.csv`。\n")
    ir = kai1331_meta.get("implied_rates") or {}
    lines.append(
        f"**{_BROKER_K_1331} 出街價：維持 pending（P0-執行計劃 WP3v2 條件1 第6點，Opus 5 覆核結論）**\n\n"
        "- 同一更數向量對到 5 個唔同金額，極差 7,490；任何線性模型嘅殘差下界都係 3,745。\n"
        "- 試過嘅 6 個變體（唔同離群日排除方式/唔同shift_type合併方式）全部解出負價，"
        "數學上唔work（負出街價冇意義）。\n"
        f"- 7/31 68,080 比同一更數向量嘅 7/13 多 41,040——**P3已答**：老闆確認係「有啲阿{_BROKER_K}嘅散工轉咗做"
        f"公司長工，公司每月計返一個特別費用畀佢」（長工介紹費，月結一次過），性質同{_BROKER_W}頁"
        f"「1331長工156更×50」、{_BROKER_G}頁另一個介紹費行一樣；金額點計仍待老闆一句（P3a）。\n"
        f"- **P2a（2026-09-10新增，即場由數據計，唔寫死）**：啟航1331有26個Maxwell長工"
        f"（月薪合共{ir.get('longterm_salary_total', 0):,.2f}，經autopay出，唔經{_BROKER_K}現金），"
        f"令「{_BROKER_K}出街價」有三個唔同讀法——"
        f"淨{_BROKER_K}（{ir.get('net_kai_shifts')}更）：Σ(排除7/31){ir.get('total_actual_excl_31')} ÷ "
        f"{ir.get('net_kai_shifts')} ≈ {ir.get('rate_net_kai')}/更（唔合理，遠超R2 800-1200區間）；"
        f"全部K（連長工，{ir.get('all_k_shifts')}更）：≈ {ir.get('rate_all_k')}/更；"
        f"扣長工月薪：(Σ(排除7/31) − 長工月薪) ÷ 淨{_BROKER_K}更數 ≈ {ir.get('rate_minus_longterm')}/更"
        "（後兩個讀法落喺R2「800–1200」區間，較合理）。三個讀法都唔足以獨立解開7個更別各自嘅價，"
        "要等老闆答P2a（894,391.67係咪已包長工人工）或者第二個人數分布唔同嘅月份先可以拆開。\n"
    )

    lines.append("## 4. 抽樣覆核\n")
    n_review = sum(1 for s in sample_rows if s["match"] == "REVIEW")
    lines.append(f"- 抽樣 {len(sample_rows)} 條（30 shift_record + 5 billing_unit 目標，"
                  f"實際 priceable 母體/開票單位不足時會少過此數），{n_review} 條 REVIEW，"
                  f"詳見 `out/wp3/sample-audit.csv`\n")

    lines.append("## 5. unpriced 摘要\n")
    reason_counter = Counter()
    for u in unpriced_rows:
        reason_counter[u["reason"]] += 1
    lines.append(f"- 總數：{len(unpriced_rows)}")
    for reason, n in reason_counter.most_common():
        lines.append(f"  - {n} 條：{reason}")
    lines.append("")

    lines.append("## 6. 出街價反推（Section A）留意事項\n")
    lines.append(f"- 混合行（跨盤，冇單一site_label）略過自動rate_card：{len(payout_meta['skipped_mixed'])} 行"
                  "（G0180／G0171，見 P0-執行計劃§3.8；PDPO：只記guard_id，具體人可查"
                  "out/wp2b/guards.csv；呢兩位嘅逐日site已經由WP2b cells層面配好，"
                  "唔影響shift_records_priced，只係冇由呢個彙總行直接生成rate_card）")
    lines.append(f"- site_label 解唔到嘅行：{len(payout_meta['unresolved_site'])}")
    lines.append("")

    lines.append("## 6a. 出街價最後 fallback（A4 master_roster_payout，WP5g）\n")
    mrp = master_roster_payout_meta or {}
    lines.append("糧明細（Section A）／master_roster_rate（A2）／"
                  "master_roster_only_rate（A2b）都搵唔到 guard_wage/broker_fee"
                  "先至用總表逐崗位表頭外判價（P0-執行計劃§8 Q10 已答），「現有"
                  "卡優先，唔覆蓋」——見 `wp3_rates.build_master_roster_payout_"
                  "rate_cards`。\n")
    lines.append(f"- 總表長工卡（guard 專屬，guard_wage_source="
                  f"monthly_salary_daily_avg）：{mrp.get('guard_cards', 0)} 張")
    lines.append(f"- 總表崗位卡（冇 guard token，畀輪換安員共用）："
                  f"{mrp.get('post_cards', 0)} 張")
    lines.append(f"- 同一 group 內 payout_rate 唔一致，唔生成卡（留底俾人手覆核）："
                  f"{mrp.get('skipped_conflict', 0)} 組")
    lines.append(f"- 已經有現有卡（糧明細/A2/A2b）覆蓋，唔再重複生成："
                  f"{mrp.get('skipped_existing', 0)} 組")
    lines.append(f"- 崗位嘅 time 喺 out/wp2b/shift_types.csv 搵唔到對應 shift_type"
                  f"（例如 OT/打風呢類非常規崗位）：{mrp.get('skipped_unmatched_time', 0)} 個 post")
    lines.append(f"- 崗位成個月冇任何 assignment 日或者 broker_code 解唔到："
                  f"{mrp.get('skipped_no_broker', 0)} 個 post")
    lines.append(f"- 崗位冇填 payout_rate：{mrp.get('skipped_no_payout', 0)} 個 post\n")

    lines.append("## 7. ⑥ 三份報表 diff 統計\n")
    rt_cat = Counter(d["category"] for d in roundtrip_diff)
    lines.append(f"### 7a. 更表 round-trip（`reports/roundtrip-diff.csv`，共 {len(roundtrip_diff)} 條）\n")
    for cat, n in rt_cat.most_common():
        lines.append(f"  - {n} 條：{cat}")
    lines.append("  （WP1 out/wp1/records.jsonl 3,638 格 同 out/wp2b/shift_records.csv "
                  "3,638 條roster-sourced記錄已證實完全一一對應bijection，kind分佈0 mismatch；"
                  "所以呢度嘅diff應該淨係剩返「刻意剔走」嘅類別，唔應該有unexplained/needs_review。）\n")

    pd_reason = Counter(d["note"] or "金額有差" for d in payroll_diff)
    lines.append(f"### 7b. 雞頭糧明細（`reports/payroll-diff.csv`，共 {len(payroll_diff)} 條）\n")
    for reason, n in pd_reason.most_common(10):
        lines.append(f"  - {n} 條：{reason}")
    lines.append("")

    md_reason = Counter(d["note"] for d in monthly_diff)
    lines.append(f"### 7c. 月結總表（`reports/monthly-diff.csv`，共 {len(monthly_diff)} 條，只列差異唔解釋）\n")
    for reason, n in md_reason.most_common(10):
        lines.append(f"  - {n} 條：{reason}")
    lines.append("")

    with open(paths.WP3_RATES_REPORT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
