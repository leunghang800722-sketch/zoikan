// P1-WP4 §6.3：月結工作台內置嘅五條自動對數規則。
//
// 設計決定：規則 1/2/3 喺呢個系統入面，「月結總表」／「糧明細」本身就係
// 由同一份 shift_records 直接聚合出嚟（buildMonthlyClose()／
// buildPayrollTotals()），冇一個獨立、人手輸入嘅「月結數字」可以對比
// ——即係話規則字面意義上「Σ(confirmed×client_rate) ≟ 月結營業額」喺
// 單一資料來源嘅系統入面會恆等（呢個正正係「三表同源」嘅設計目標，見
// 設計文件§4.3）。為咗令呢條規則仲有偵測力（「出現差異=有人繞過系統改
// 數」），呢度將「月結／糧明細口徑」（buildMonthlyClose／
// buildPayrollTotals，唔篩 status）同「confirmed-only 口徑」（淨計
// status ∈ {confirmed, completed} 嘅記錄）分開獨立計算兩次先比較——如果
// 有 draft/pending_approval/cancelled 嘅記錄意外算咗入月結總表（理論上
// 唔應該，buildMonthlyClose 本身冇篩 status），呢條規則就會揪到。
import { prisma } from "@/lib/db";
import { n, round2, monthRange as sharedMonthRange, monthLabel } from "./money";
import { buildMonthlyClose } from "./monthly-close";
import { buildPayrollTotals } from "./payroll";

const EPS = 0.01;

export type ReconciliationRuleStatus = "pass" | "diff" | "not_enabled";

// Opus 驗收 A5：`rule`（1-5，同 `ruleNo` 一樣，前端揀 icon/顏色用呢個
// 短欄名）同 `key`／`label`（穩定嘅英文 slug + 短中文標籤，俾前端唔使
// 淨係靠成句 `title` 嚟判斷邊條規則、顯示邊條紅）。
export const RULE_KEY_LABEL: Record<1 | 2 | 3 | 4 | 5, { key: string; label: string }> = {
  1: { key: "revenue_per_site", label: "營業額逐盤" },
  2: { key: "payroll_per_broker", label: "糧明細逐雞頭" },
  3: { key: "three_table_shifts", label: "三表更數" },
  4: { key: "cash_payout_batch", label: "現金糧批次" },
  5: { key: "yellow_warnings", label: "黃色警示清單" },
};

export interface ReconciliationRule {
  ruleNo: 1 | 2 | 3 | 4 | 5;
  rule: 1 | 2 | 3 | 4 | 5;
  key: string;
  label: string;
  title: string;
  status: ReconciliationRuleStatus;
  diffCount: number;
  details: Array<Record<string, unknown>>;
  note: string | null;
}

export interface ReconciliationResult {
  month: string;
  rules: ReconciliationRule[];
  hasDiff: boolean;
}

async function rule1RevenueBySite(month: Date): Promise<Omit<ReconciliationRule, "rule" | "key" | "label">> {
  const { start, end } = sharedMonthRange(month);
  const { mainRows } = await buildMonthlyClose(month);
  const details: Array<Record<string, unknown>> = [];
  for (const row of mainRows) {
    // flat-card／月費盤嘅 revenue 唔係逐更 client_rate_snapshot 加返嚟，
    // 呢條規則對呢類盤唔適用（monthly-close.ts 本身都係咁處理）。
    const confirmedAgg = await prisma.shiftRecord.aggregate({
      where: {
        siteId: row.siteId,
        recordType: "shift",
        isExternal: false,
        shiftType: { billingGroup: "per_shift" },
        workDate: { gte: start, lte: end },
        status: { in: ["confirmed", "completed"] },
      },
      _sum: { clientRateSnapshot: true },
    });
    const confirmedOnlyRevenue = round2(n(confirmedAgg._sum.clientRateSnapshot));
    // row.revenue 可能包含 flat card／special item 摺入嘅金額，唔可以直接
    // 同 confirmedOnlyRevenue 比較（唔係同一件事）；呢度淨係對「純逐更
    // client_rate_snapshot 加總」呢部分做 confirmed-only vs all-status 比較。
    const allStatusAgg = await prisma.shiftRecord.aggregate({
      where: {
        siteId: row.siteId,
        recordType: "shift",
        isExternal: false,
        shiftType: { billingGroup: "per_shift" },
        workDate: { gte: start, lte: end },
      },
      _sum: { clientRateSnapshot: true },
    });
    const allStatusRevenue = round2(n(allStatusAgg._sum.clientRateSnapshot));
    const diff = round2(allStatusRevenue - confirmedOnlyRevenue);
    if (Math.abs(diff) >= EPS) {
      details.push({ site_id: row.siteId, site_name: row.canonicalName, confirmed_only_revenue: confirmedOnlyRevenue, all_status_revenue: allStatusRevenue, diff });
    }
  }
  return {
    ruleNo: 1,
    title: "Σ(confirmed 更數 × client_rate_snapshot) ≟ 月結營業額（逐盤）",
    status: details.length === 0 ? "pass" : "diff",
    diffCount: details.length,
    details,
    note: details.length === 0 ? null : "有非 confirmed/completed 狀態嘅記錄計咗入營業額——可能有人繞過審批流程直接寫入 shift_records。",
  };
}

async function rule2PayrollByBroker(month: Date): Promise<Omit<ReconciliationRule, "rule" | "key" | "label">> {
  const { start, end } = sharedMonthRange(month);
  const totals = await buildPayrollTotals(month);
  const details: Array<Record<string, unknown>> = [];
  for (const t of totals) {
    const confirmedAgg = await prisma.shiftRecord.aggregate({
      where: { settlementBrokerId: t.brokerId, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, status: { in: ["confirmed", "completed"] } },
      _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
    });
    const confirmedOnlyAmount = round2(n(confirmedAgg._sum.guardWageSnapshot) + n(confirmedAgg._sum.brokerFeeSnapshot));
    const diff = round2(t.amount - confirmedOnlyAmount);
    if (Math.abs(diff) >= EPS) {
      details.push({ broker_id: t.brokerId, broker_code: t.brokerCode, payroll_amount: t.amount, confirmed_only_amount: confirmedOnlyAmount, diff });
    }
  }
  return {
    ruleNo: 2,
    title: "Σ(confirmed 更數 × payout_rate_snapshot) ≟ 雞頭糧明細總額（逐雞頭）",
    status: details.length === 0 ? "pass" : "diff",
    diffCount: details.length,
    details,
    note: details.length === 0 ? null : "有非 confirmed/completed 狀態嘅記錄計咗入糧明細。",
  };
}

async function rule3ThreeTableShiftCount(month: Date): Promise<Omit<ReconciliationRule, "rule" | "key" | "label">> {
  const { start, end } = sharedMonthRange(month);
  const { mainRows } = await buildMonthlyClose(month);
  const details: Array<Record<string, unknown>> = [];
  for (const row of mainRows) {
    // 更表口徑：呢個盤 per_shift 更別、非外判、record_type=shift 嘅記錄數
    // （同 monthly-close.ts base.shifts 用緊嘅 shiftAgg._count 完全同一條
    // query——理論上恆等，除非有人繞過 buildMonthlyClose() 之外嘅路徑）。
    // 加返 standalone_broker_fee special_items 嘅 shifts（monthly-close.ts
    // 摺入 row.shifts 嗰部分，見 buildMonthlyClose() 註解——呢啲更冇對應
    // shift_records，係盤級調整，唔算「三表唔同源」）。
    const rosterCount = await prisma.shiftRecord.count({
      where: { siteId: row.siteId, recordType: "shift", isExternal: false, shiftType: { billingGroup: "per_shift" }, workDate: { gte: start, lte: end } },
    });
    const standaloneItems = await prisma.specialItem.findMany({ where: { siteId: row.siteId, kind: "standalone_broker_fee", month: start } });
    const standaloneShifts = standaloneItems.reduce((a, it) => a + (it.shifts ?? 0), 0);
    const rosterCountWithAdjustments = rosterCount + standaloneShifts;
    // 糧明細口徑：呢個盤嘅 shift+ot 記錄數（唔篩 isExternal/billingGroup，
    // 因為出糧唔理呢盤係咪 per_shift 定 monthly_ic，外判都可能要出糧）——
    // 呢個純粹展示比較，唔納入 pass/diff 判斷（standalone_broker_fee 呢
    // 類盤級調整本身冇對應 shift_records，糧明細數字天生會細過月結，唔係
    // 「有人繞過系統」）。
    const payrollCount = await prisma.shiftRecord.count({
      where: { siteId: row.siteId, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end } },
    });
    if (rosterCountWithAdjustments !== row.shifts) {
      details.push({
        site_id: row.siteId,
        site_name: row.canonicalName,
        roster_shifts: rosterCount,
        standalone_broker_fee_shifts: standaloneShifts,
        roster_shifts_with_adjustments: rosterCountWithAdjustments,
        monthly_close_shifts: row.shifts,
        payroll_shift_and_ot_records: payrollCount,
      });
    }
  }
  return {
    ruleNo: 3,
    title: "每盤更數：更表 ≟ 糧明細 ≟ 月結",
    status: details.length === 0 ? "pass" : "diff",
    diffCount: details.length,
    details,
    note: details.length === 0 ? null : "更表（含盤級調整）同月結更數對唔上——理論上同源恆等，出現差異代表有人繞過系統改數。",
  };
}

function rule4CashPayoutBatch(): Omit<ReconciliationRule, "rule" | "key" | "label"> {
  // 糧務批次／payout_batches 係 P3 範圍（P1-執行計劃.md §6「唔做」），
  // schema 已經有 stub table 但冇任何寫入邏輯——呢條規則喺 P1 一律顯示
  // 「未啟用」，唔算 fail，亦唔算 pass。
  return {
    ruleNo: 4,
    title: "現金糧批次總額 ≟ Σ糧務項目",
    status: "not_enabled",
    diffCount: 0,
    details: [],
    note: "糧務批次（payout_batches）係 P3 範圍，P1 未實作，呢條規則未啟用。",
  };
}

async function rule5YellowWarnings(month: Date): Promise<Omit<ReconciliationRule, "rule" | "key" | "label">> {
  const { start, end } = sharedMonthRange(month);
  const details: Array<Record<string, unknown>> = [];

  // (a) 同人同日 >1 更（confirmed/completed，非 leave，唔計 OT——OT 本身
  //     掛靠正更係設計允許嘅「同日多過一條記錄」）
  const shiftRecords = await prisma.shiftRecord.findMany({
    where: { recordType: "shift", isExternal: false, workDate: { gte: start, lte: end }, status: { in: ["confirmed", "completed"] } },
    select: { guardId: true, workDate: true, siteId: true, guard: { select: { staffNo: true, siaPermitExpiry: true } } },
  });
  const byGuardDate = new Map<string, typeof shiftRecords>();
  for (const r of shiftRecords) {
    const key = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`;
    const list = byGuardDate.get(key) ?? [];
    list.push(r);
    byGuardDate.set(key, list);
  }
  for (const [key, list] of byGuardDate) {
    if (list.length > 1) {
      const [guardId, workDate] = key.split("|");
      details.push({ kind: "同人同日多過一更", guard_ref: list[0].guard.staffNo ?? guardId, work_date: workDate, shift_count: list.length });
    }
  }

  // (b) 同人單月 >26 更
  const byGuard = new Map<string, typeof shiftRecords>();
  for (const r of shiftRecords) {
    const list = byGuard.get(r.guardId) ?? [];
    list.push(r);
    byGuard.set(r.guardId, list);
  }
  for (const [guardId, list] of byGuard) {
    if (list.length > 26) {
      details.push({ kind: "單月多過 26 更", guard_ref: list[0].guard.staffNo ?? guardId, shift_count: list.length });
    }
  }

  // (c) 許可證過期仍出更
  for (const r of shiftRecords) {
    if (r.guard.siaPermitExpiry && r.guard.siaPermitExpiry.getTime() < r.workDate.getTime()) {
      details.push({
        kind: "許可證過期仍出更",
        guard_ref: r.guard.staffNo ?? r.guardId,
        work_date: r.workDate.toISOString().slice(0, 10),
        permit_expiry: r.guard.siaPermitExpiry.toISOString().slice(0, 10),
      });
    }
  }

  return {
    ruleNo: 5,
    title: "黃色警示清單：同人同日 >1 更／單月 >26 更／許可證過期仍出更",
    status: details.length === 0 ? "pass" : "diff",
    diffCount: details.length,
    details,
    note: details.length === 0 ? null : "黃色警示——唔會擋鎖定，但鎖定前要老闆/會計人手覆核。",
  };
}

export async function buildReconciliation(month: Date): Promise<ReconciliationResult> {
  const rawRules = await Promise.all([rule1RevenueBySite(month), rule2PayrollByBroker(month), rule3ThreeTableShiftCount(month), Promise.resolve(rule4CashPayoutBatch()), rule5YellowWarnings(month)]);
  // Opus 驗收 A5：逐條補返 `rule`／`key`／`label`（穩定短欄，前端月結
  // 工作台顯示「邊條紅」用，唔使淨係靠成句 `title` 文字判斷）。
  const rules: ReconciliationRule[] = rawRules.map((r) => ({ ...r, rule: r.ruleNo, key: RULE_KEY_LABEL[r.ruleNo].key, label: RULE_KEY_LABEL[r.ruleNo].label }));
  return {
    month: monthLabel(month),
    rules,
    // 規則 5（黃色警示）唔算「紅色差異」——鎖定前要 override 原因嘅係
    // 規則 1/2/3 出現嘅實質數字差異（見 P1-執行計劃.md §4「有紅色差異要
    // override 原因」）；規則 4 未啟用唔計。
    hasDiff: rules.some((r) => r.ruleNo !== 5 && r.status === "diff"),
  };
}
