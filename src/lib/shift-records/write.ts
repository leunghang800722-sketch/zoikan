// W2：共用排更 write service（由 POST /api/shift-records/batch 抽出；batch 行為 byte-for-byte 不變）。
// 兩個入口共用同一套 plan 型別、計價、寫入（clear／update／createManyAndReturn／重用已取消行）、journal、audit：
//   1. batch route：自己做權限／雞頭隔離／逐格驗證 → 起 PlannedOp[] → `computePlanPricing` → tx 內 `applyShiftPlansTx`；
//   2. `writeShiftCells(tx, …)`：WhatsApp（W2 Triage 答題、W3 自動寫入）用——無雞頭 session，等同「內部角色」分支
//      （settlement／operational broker 走同一條 fallback 鏈），狀態由 `statusPolicy` 決定（confirmed｜pending_approval），
//      `source`／`provenance`（additive json）寫入記錄。tx 內先 `assertMonthNotLockedTx`，audit 一條 createMany。
// 計價核心（resolve-rate.ts）未改；呢度只係調用。
import { prisma } from "@/lib/db";
import { assertMonthNotLockedTx } from "@/lib/month-lock";
import { writeAuditMany } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { LeaveCode, type Prisma, type ShiftRecordStatus } from "@prisma/client";
import { toNum, type AutoCardUse } from "@/lib/pricing/auto-card-journal";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, isUnpricedShift, type ResolvedShiftPricing } from "@/lib/pricing/resolve-rate";
import { n } from "@/lib/reports/money";
import { MANUAL_SOURCE } from "@/lib/longterm-payroll/attendance-priority";
import { createSettlementBrokerFallbackResolver } from "@/lib/pricing/settlement-broker-fallback";

export const LEAVE_CODES = new Set<string>(Object.values(LeaveCode));

export type Cell = {
  guard_id: string;
  shift_type_id: string;
  work_date: Date;
  code?: string | null;
  settlement_broker_id?: string;
  operational_broker_id?: string;
};

export type PlannedOp =
  | { kind: "noop"; cell: Cell }
  | { kind: "clear"; cell: Cell; existingId: string }
  | {
      kind: "upsert";
      cell: Cell;
      existingId: string | null;
      recordType: "shift" | "leave";
      leaveCode: string | null;
      settlementBrokerId: string | null;
      operationalBrokerId: string | null;
      status: ShiftRecordStatus;
      existingIsExternal: boolean; // WP-PRICE：計價 external 判斷要用——現存記錄保留佢原本嘅 is_external，新記錄預設 false
      pricing: ResolvedShiftPricing | null; // WP-PRICE：喺 plans 起晒之後先一次過計（見下面「計價」段），呢度淨係佔位
      // B1-5（WP-ATTRIB）：settlement_broker_id 冇喺 payload／現存記錄
      // 度攞到，靠 resolveSettlementBrokerFallback() 推算——response 要
      // additive 標返俾前端，等 RosterEditor 儲存後 toast「推算」。
      settlementInferred: boolean;
      // P18.1：人手編輯標記——新建，或現存記錄嘅 record_type／leave_code 被改，先寫 source="manual"
      // （aggregate 按來源優先次序，人手 > roster_upload > master_roster > payroll_only）；
      // 只改結算單位／狀態嘅唔蓋 source（唔改變來源優先結果）。undefined＝唔動 source。
      manualSource: boolean;
    };

type UpsertPlan = Extract<PlannedOp, { kind: "upsert" }>;

// P3-5.3：逐格路徑同批量路徑共用嘅 data 組裝（兩邊以前各寫一份，欄位一字不差）。
// WP-PRICE：snapshot 跟返 plan.pricing（喺 plans 起晒之後一次過計好，見「計價」段）——
// 新記錄一律填 snapshot；更新時 settlement_broker 或者 record_type（shift↔leave）有變都會反映喺 plan.pricing。
/** W2：額外寫入嘅來源標記（batch 不傳＝行為不變）。 */
export interface WriteExtra {
  source: string;
  provenance?: Prisma.InputJsonValue;
}

function upsertUpdateData(plan: UpsertPlan, extra?: WriteExtra) {
  return {
    ...(extra ? { source: extra.source, ...(extra.provenance !== undefined ? { provenance: extra.provenance } : {}) } : plan.manualSource ? { source: MANUAL_SOURCE } : {}),
    recordType: plan.recordType,
    leaveCode: plan.leaveCode as never,
    settlementBrokerId: plan.settlementBrokerId,
    operationalBrokerId: plan.operationalBrokerId,
    status: plan.status,
    clientRateSnapshot: plan.pricing?.clientRate ?? null,
    guardWageSnapshot: plan.pricing?.guardWage ?? null,
    brokerFeeSnapshot: plan.pricing?.brokerFee ?? null,
  };
}
function upsertCreateData(plan: UpsertPlan, siteId: string, createdBy: string, extra?: WriteExtra) {
  return {
    source: extra ? extra.source : MANUAL_SOURCE,
    ...(extra?.provenance !== undefined ? { provenance: extra.provenance } : {}),
    workDate: plan.cell.work_date,
    siteId,
    shiftTypeId: plan.cell.shift_type_id,
    guardId: plan.cell.guard_id,
    settlementBrokerId: plan.settlementBrokerId,
    operationalBrokerId: plan.operationalBrokerId,
    recordType: plan.recordType,
    leaveCode: plan.leaveCode as never,
    status: plan.status,
    createdBy,
    clientRateSnapshot: plan.pricing?.clientRate ?? null,
    guardWageSnapshot: plan.pricing?.guardWage ?? null,
    brokerFeeSnapshot: plan.pricing?.brokerFee ?? null,
  };
}

/** 計價（抽自 batch route，邏輯不變）：喺 plans 起晒之後、開 transaction 之前一次過計；結果寫入 plan.pricing。 */
export async function computePlanPricing(args: {
  siteId: string;
  month: Date;
  monthEnd: Date;
  plans: PlannedOp[];
  existingByKey: Map<string, Prisma.ShiftRecordGetPayload<object>>;
  shiftTypeById: Map<string, Prisma.ShiftTypeGetPayload<object>>;
}) {
  const { siteId, month, monthEnd, plans, existingByKey, shiftTypeById } = args;
  const upsertPlans = plans.filter((p): p is Extract<PlannedOp, { kind: "upsert" }> => p.kind === "upsert");
  const pricingBrokerIds = [...new Set(upsertPlans.map((p) => p.settlementBrokerId).filter((v): v is string => v !== null))];
  const pricingBrokers = pricingBrokerIds.length
    ? await prisma.broker.findMany({ where: { id: { in: pricingBrokerIds } }, select: { id: true, kind: true, code: true } })
    : [];
  const brokerKindById = new Map(pricingBrokers.map((b) => [b.id, b.kind]));
  const brokerCodeById = new Map(pricingBrokers.map((b) => [b.id, b.code]));
  const rateCards = await fetchEffectiveRateCards(siteId, month, monthEnd);
  // WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類盤
  // 嘅保安員由客戶直接出糧，公司淨係收每月服務費——唔逐更計客價／
  // 工資，唔使價目卡。下面「計價」段對呢類盤（`guardsPaidByClient`）
  // 一律行「保留現有值、唔寫新 snapshot、唔算未定價」分支，見
  // src/lib/pricing/unpriced.ts、resolve-rate.ts 頂註解。
  const pricingSite = await prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true, guardsPaidByClient: true } });
  const siteGuardsPaidByClient = pricingSite?.guardsPaidByClient ?? false;

  type UnpricedCellSummary = { key: string; site_name?: string; shift_type_code: string; broker_code: string | null; reason?: string; count: number };
  const unpricedByKey = new Map<string, UnpricedCellSummary>();
  let pricedCount = 0;
  let unpricedCount = 0;
  for (const plan of upsertPlans) {
    const key = `${plan.cell.guard_id}|${plan.cell.work_date.toISOString().slice(0, 10)}|${plan.cell.shift_type_id}`;
    const existingRecord = plan.existingId ? (existingByKey.get(key) ?? null) : null;
    const existingClient = existingRecord?.clientRateSnapshot !== null && existingRecord?.clientRateSnapshot !== undefined ? n(existingRecord.clientRateSnapshot) : null;
    const existingWage = existingRecord?.guardWageSnapshot !== null && existingRecord?.guardWageSnapshot !== undefined ? n(existingRecord.guardWageSnapshot) : null;
    const existingFee = existingRecord?.brokerFeeSnapshot !== null && existingRecord?.brokerFeeSnapshot !== undefined ? n(existingRecord.brokerFeeSnapshot) : null;
    const allSnapshotNull = existingRecord ? existingClient === null && existingWage === null && existingFee === null : false;
    const brokerChanged = existingRecord ? existingRecord.settlementBrokerId !== plan.settlementBrokerId : false;
    const recordTypeChanged = existingRecord ? existingRecord.recordType !== plan.recordType : false;
    // 應修 S4：is_external 翻轉咗但 snapshot 未追（external 記錄理應
    // snapshot 全 null，若唔係就係狀態變咗但未重計過）。
    const externalStaleInconsistent = existingRecord ? existingRecord.isExternal && !allSnapshotNull : false;
    // Opus 第三輪 S2：既有「PR」對數佔位記錄（7 月源頭轉錄）永不重計——
    // resolver 對 PR 會計錯拆分，就算月份解鎖都唔准靜靜改寫歷史數。
    const existingIsPR = !!existingRecord && shiftTypeById.get(plan.cell.shift_type_id)?.code === "PR";
    const shouldFullReprice = !existingIsPR && (!existingRecord || brokerChanged || recordTypeChanged || allSnapshotNull || externalStaleInconsistent);

    const resolverInput = {
      siteId: siteId,
      shiftTypeId: plan.cell.shift_type_id,
      shiftTypeCode: shiftTypeById.get(plan.cell.shift_type_id)?.code ?? "",
      shiftTypeBillingGroup: shiftTypeById.get(plan.cell.shift_type_id)?.billingGroup ?? "per_shift",
      settlementBrokerId: plan.settlementBrokerId,
      brokerKind: plan.settlementBrokerId ? (brokerKindById.get(plan.settlementBrokerId) ?? null) : null,
      guardId: plan.cell.guard_id,
      workDate: plan.cell.work_date,
      isExternal: plan.existingIsExternal,
      recordType: plan.recordType,
    };

    if (siteGuardsPaidByClient) {
      // WP-MISC：LINK 呢類盤——唔行 resolver、唔寫新 snapshot（新記錄
      // 三個欄一律 null，`existingClient/Wage/Fee` 對新記錄本身已經係
      // null）；已有值（例如未拍板前舊資料）保留原封不動，唔清；一律
      // 唔算未定價（payout 同 client 都唔算）。
      plan.pricing = {
        clientRate: existingClient,
        guardWage: existingWage,
        brokerFee: existingFee,
        source: {},
        unpriced: false,
        clientCardFound: false,
        payoutCardFound: false,
      };
    } else if (shouldFullReprice) {
      plan.pricing = resolveShiftPricingFromCards(rateCards, resolverInput);
    } else if (existingRecord && !existingIsPR && (existingClient === null || existingWage === null || existingFee === null)) {
      // 應修 S4：局部補漏——唔夠全部重計嘅門檻，但有部份欄位係 null，
      // resolver 計一次，淨係補嗰個 null 欄位，非 null 嘅欄位原封不動。
      const resolved = resolveShiftPricingFromCards(rateCards, resolverInput);
      const brokerKind = plan.settlementBrokerId ? (brokerKindById.get(plan.settlementBrokerId) ?? null) : null;
      // Opus 第三輪 S3：同 reprice 一致——長工／外部記錄嘅 wage/fee 永不
      // 由 resolver 補（長工月薪制、外部唔係我哋成本），只可能補收客價。
      const payoutFrozen = brokerKind === "internal_longterm" || brokerKind === "external" || plan.existingIsExternal;
      const mergedClient = existingClient !== null ? existingClient : resolved.clientRate;
      const mergedWage = existingWage !== null ? existingWage : payoutFrozen ? null : resolved.guardWage;
      const mergedFee = existingFee !== null ? existingFee : payoutFrozen ? null : resolved.brokerFee;
      plan.pricing = {
        clientRate: mergedClient,
        guardWage: mergedWage,
        brokerFee: mergedFee,
        source: resolved.source,
        unpriced: isUnpricedShift({ recordType: plan.recordType, status: "confirmed", guardWageSnapshot: mergedWage, brokerFeeSnapshot: mergedFee, isExternal: plan.existingIsExternal }, brokerKind),
        clientCardFound: resolved.clientCardFound,
        payoutCardFound: resolved.payoutCardFound,
      };
    } else {
      // S4：保留現有 snapshot 原封不動（人手改過嘅數唔可以被靜靜覆蓋）。
      const brokerKind = plan.settlementBrokerId ? (brokerKindById.get(plan.settlementBrokerId) ?? null) : null;
      plan.pricing = {
        clientRate: existingClient,
        guardWage: existingWage,
        brokerFee: existingFee,
        source: {},
        unpriced: isUnpricedShift({ recordType: plan.recordType, status: "confirmed", guardWageSnapshot: existingWage, brokerFeeSnapshot: existingFee, isExternal: plan.existingIsExternal }, brokerKind),
        // 呢個分支冇打 resolver（原封保留），呢兩個 flag 對「keep」路徑
        // 冇實質意義，統一填 false（表示「呢次冇做 resolver 查證」）。
        clientCardFound: false,
        payoutCardFound: false,
      };
    }
    if (plan.recordType !== "shift") continue; // leave 唔計入「未定價」統計
    if (plan.pricing.unpriced) {
      unpricedCount++;
      const shiftTypeCode = shiftTypeById.get(plan.cell.shift_type_id)!.code;
      const brokerCode = plan.settlementBrokerId ? (brokerCodeById.get(plan.settlementBrokerId) ?? null) : null;
      const key = `${shiftTypeCode}|${brokerCode ?? "冇雞頭"}|${plan.pricing.reason ?? ""}`;
      const existingSummary = unpricedByKey.get(key);
      if (existingSummary) existingSummary.count++;
      else unpricedByKey.set(key, { key, shift_type_code: shiftTypeCode, broker_code: brokerCode, reason: plan.pricing.reason, count: 1 });
    } else {
      pricedCount++;
    }
  }
  if (unpricedByKey.size > 0) {
    for (const summary of unpricedByKey.values()) summary.site_name = pricingSite?.canonicalName;
  }
  return { upsertPlans, pricedCount, unpricedCount, unpricedByKey };
}

export type AppliedResult = { key: string; id: string; action: string; settlement_inferred?: boolean };

/** tx 內寫入（抽自 batch route，邏輯不變）：clear／update／create／audit（一條 createMany）。呼叫者負責先 assertMonthNotLockedTx。 */
export async function applyShiftPlansTx(
  tx: Prisma.TransactionClient,
  args: { plans: PlannedOp[]; siteId: string; actorUserId: string; ip: string | null; extra?: WriteExtra },
): Promise<{ results: AppliedResult[]; autoCardUses: AutoCardUse[] }> {
  const { plans, siteId, actorUserId, ip, extra } = args;
  const results: AppliedResult[] = [];
  type PendingAudit = { rowId: string; action: "create" | "update" | "void"; before?: unknown; after: unknown };
  const pendingAudits: PendingAudit[] = [];
  const autoCardUses: AutoCardUse[] = [];
  const keyOfPlan = (p: Exclude<PlannedOp, { kind: "noop" }>) => `${p.cell.guard_id}|${p.cell.work_date.toISOString().slice(0, 10)}|${p.cell.shift_type_id}`;
  const activePlans = plans.filter((p): p is Exclude<PlannedOp, { kind: "noop" }> => p.kind !== "noop");
  const hasDuplicateCells = new Set(activePlans.map(keyOfPlan)).size !== activePlans.length;
  const writeBatchAudits = (t: Prisma.TransactionClient) =>
    writeAuditMany(pendingAudits.map((a) => ({ actorUserId, tableName: "shift_records", rowId: a.rowId, action: a.action, before: a.before, after: a.after, ip })), t);
  if (hasDuplicateCells) {
    for (const plan of plans) {
      const key = `${plan.cell.guard_id}|${plan.cell.work_date.toISOString().slice(0, 10)}|${plan.cell.shift_type_id}`;
      if (plan.kind === "noop") continue;
      if (plan.kind === "clear") {
        const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: plan.existingId } });
        const after = await tx.shiftRecord.update({ where: { id: plan.existingId }, data: { status: "cancelled" } });
        pendingAudits.push({ rowId: plan.existingId, action: "void", before, after: { ...after, void_reason: "batch:clear_cell" } });
        results.push({ key, id: plan.existingId, action: "cleared" });
        continue;
      }
      // upsert
      if (plan.existingId) {
        const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: plan.existingId } });
        const after = await tx.shiftRecord.update({ where: { id: plan.existingId }, data: upsertUpdateData(plan, extra) });
        pendingAudits.push({ rowId: plan.existingId, action: "update", before, after });
        autoCardUses.push({ recordId: plan.existingId, before: [toNum(before.clientRateSnapshot), toNum(before.guardWageSnapshot), toNum(before.brokerFeeSnapshot)], after: [toNum(after.clientRateSnapshot), toNum(after.guardWageSnapshot), toNum(after.brokerFeeSnapshot)], ...(plan.pricing?.source ?? {}) });
        results.push({ key, id: plan.existingId, action: "updated", settlement_inferred: plan.settlementInferred });
      } else {
        const data: Prisma.ShiftRecordUncheckedCreateInput = upsertCreateData(plan, siteId, actorUserId, extra);
        const created = await tx.shiftRecord.create({ data });
        pendingAudits.push({ rowId: created.id, action: "create", after: created });
        autoCardUses.push({ recordId: created.id, before: [null, null, null], after: [toNum(created.clientRateSnapshot), toNum(created.guardWageSnapshot), toNum(created.brokerFeeSnapshot)], ...(plan.pricing?.source ?? {}) });
        results.push({ key, id: created.id, action: "created", settlement_inferred: plan.settlementInferred });
      }
    }
    await writeBatchAudits(tx);
    return { results, autoCardUses };
  }

  // ---- 批量路徑 ----
  // 驗收修正：before 喺 tx 內 `FOR UPDATE` 鎖住並重讀（唔用 tx 外較早讀嘅 `existing`），
  // 並發改動下 audit before 先正確。（計價判斷仍用 tx 外嘅 plan，同逐格寫法一致。）
  const lockIds = activePlans.flatMap((p) => (p.kind === "clear" ? [p.existingId] : p.existingId ? [p.existingId] : []));
  if (lockIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM shift_records WHERE id = ANY(${lockIds}::text[]) ORDER BY id FOR UPDATE`;
  }
  const beforeById = new Map((lockIds.length ? await tx.shiftRecord.findMany({ where: { id: { in: lockIds } } }) : []).map((r) => [r.id, r]));
  const clearPlans = activePlans.filter((p): p is Extract<PlannedOp, { kind: "clear" }> => p.kind === "clear");
  const updatePlans = activePlans.filter((p): p is Extract<PlannedOp, { kind: "upsert" }> & { existingId: string } => p.kind === "upsert" && p.existingId !== null);
  const createPlans = activePlans.filter((p): p is Extract<PlannedOp, { kind: "upsert" }> => p.kind === "upsert" && p.existingId === null);

  if (clearPlans.length > 0) {
    await tx.shiftRecord.updateMany({ where: { id: { in: clearPlans.map((p) => p.existingId) } }, data: { status: "cancelled" } });
  }
  // 更新：相同 data 嘅格併成一條 updateMany
  const updateGroups = new Map<string, { data: Prisma.ShiftRecordUncheckedUpdateManyInput; ids: string[] }>();
  for (const plan of updatePlans) {
    const data: Prisma.ShiftRecordUncheckedUpdateManyInput = upsertUpdateData(plan, extra);
    const gk = JSON.stringify(data);
    const g = updateGroups.get(gk) ?? { data, ids: [] };
    g.ids.push(plan.existingId);
    updateGroups.set(gk, g);
  }
  for (const g of updateGroups.values()) {
    await tx.shiftRecord.updateMany({ where: { id: { in: g.ids } }, data: g.data });
  }
  // 清格／更新之後一次過讀返 after（拎 DB 實際值，包括 updated_at）
  const touchedIds = [...clearPlans.map((p) => p.existingId), ...updatePlans.map((p) => p.existingId)];
  const afterById = new Map((touchedIds.length ? await tx.shiftRecord.findMany({ where: { id: { in: touchedIds } } }) : []).map((r) => [r.id, r]));

  const createdByKey = new Map<string, Awaited<ReturnType<typeof tx.shiftRecord.createManyAndReturn>>[number]>();
  if (createPlans.length > 0) {
    const created = await tx.shiftRecord.createManyAndReturn({
      data: createPlans.map((plan): Prisma.ShiftRecordCreateManyInput => upsertCreateData(plan, siteId, actorUserId, extra)),
    });
    for (const r of created) createdByKey.set(`${r.guardId}|${r.workDate.toISOString().slice(0, 10)}|${r.shiftTypeId}`, r);
  }

  // 按 plan 次序砌 results／audit／autoCardUses（同逐格寫法次序一致）
  for (const plan of activePlans) {
    const key = keyOfPlan(plan);
    if (plan.kind === "clear") {
      const before = beforeById.get(plan.existingId)!;
      const after = afterById.get(plan.existingId)!;
      pendingAudits.push({ rowId: plan.existingId, action: "void", before, after: { ...after, void_reason: "batch:clear_cell" } });
      results.push({ key, id: plan.existingId, action: "cleared" });
    } else if (plan.existingId) {
      const before = beforeById.get(plan.existingId)!;
      const after = afterById.get(plan.existingId)!;
      pendingAudits.push({ rowId: plan.existingId, action: "update", before, after });
      autoCardUses.push({ recordId: plan.existingId, before: [toNum(before.clientRateSnapshot), toNum(before.guardWageSnapshot), toNum(before.brokerFeeSnapshot)], after: [toNum(after.clientRateSnapshot), toNum(after.guardWageSnapshot), toNum(after.brokerFeeSnapshot)], ...(plan.pricing?.source ?? {}) });
      results.push({ key, id: plan.existingId, action: "updated", settlement_inferred: plan.settlementInferred });
    } else {
      const created = createdByKey.get(key)!;
      pendingAudits.push({ rowId: created.id, action: "create", after: created });
      autoCardUses.push({ recordId: created.id, before: [null, null, null], after: [toNum(created.clientRateSnapshot), toNum(created.guardWageSnapshot), toNum(created.brokerFeeSnapshot)], ...(plan.pricing?.source ?? {}) });
      results.push({ key, id: created.id, action: "created", settlement_inferred: plan.settlementInferred });
    }
  }
  await writeBatchAudits(tx);
  return { results, autoCardUses };
}

// Opus 對抗式驗收「警示 UUID」：`computeWarnings()` 回應之前直接內嵌
// `guardId`／`shiftTypeId`／`brokerId` 呢類內部 UUID 落警示文字——對
// 雞頭（甚至內部角色）嚟講都冇意義，仲會意外印出其他人／盤嘅內部 id。
// 而家逐個 resolve 做代號／姓名／更別代號。`ownBrokerId`（雞頭角色先有
// 值）令超配額警示淨係講自己嘅配額，唔會見到其他雞頭嘅配額狀態。
export async function computeWarnings(
  guardIds: string[],
  siteId: string,
  month: Date,
  monthEnd: Date,
  ownBrokerId: string | null,
): Promise<string[]> {
  const warnings: string[] = [];

  const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, nameZh: true, siaPermitExpiry: true } });
  const guardName = (id: string): string => guards.find((g) => g.id === id)?.nameZh ?? id.slice(0, 8);

  // 軟警示：單月 >26 更（record_type=shift，唔計 cancelled）
  const monthlyCounts = await prisma.shiftRecord.groupBy({
    by: ["guardId"],
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: month, lte: monthEnd } },
    _count: { _all: true },
  });
  for (const row of monthlyCounts) {
    if (row._count._all > 26) warnings.push(`保安員 ${guardName(row.guardId)} 本月已排 ${row._count._all} 更（>26）`);
  }

  // 軟警示：同人同日多更（跨盤/跨更別都計，record_type=shift）
  const dayRows = await prisma.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: month, lte: monthEnd } },
    select: { guardId: true, workDate: true },
  });
  const perDay = new Map<string, number>();
  for (const r of dayRows) {
    const k = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  for (const [k, n] of perDay) {
    if (n > 1) {
      const [guardId, day] = k.split("|");
      warnings.push(`保安員 ${guardName(guardId!)} ${day} 有 ${n} 條正更記錄（同人同日多更）`);
    }
  }

  // 軟警示：證件過期
  for (const g of guards) {
    if (g.siaPermitExpiry && g.siaPermitExpiry < monthEnd) {
      warnings.push(`保安員 ${g.nameZh} 嘅許可證於 ${g.siaPermitExpiry.toISOString().slice(0, 10)} 到期`);
    }
  }

  // 軟警示：超配額（quotas.target_shifts vs 實際 shift 更數，per site×shiftType×broker）
  // 雞頭角色（`ownBrokerId` 有值）只計自己嘅配額——唔會見到其他雞頭
  // 呢個盤呢個月嘅配額狀態（同 `配額` module「雞頭 GET 只見自己」嘅
  // 隔離原則一致）。
  const quotas = await prisma.quota.findMany({
    where: { siteId, month, voidedAt: null, ...(ownBrokerId ? { brokerId: ownBrokerId } : {}) },
  });
  if (quotas.length > 0) {
    const [site, shiftTypes, brokers] = await Promise.all([
      prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true } }),
      prisma.shiftType.findMany({ where: { id: { in: quotas.map((q) => q.shiftTypeId) } }, select: { id: true, code: true } }),
      prisma.broker.findMany({ where: { id: { in: quotas.map((q) => q.brokerId) } }, select: { id: true, code: true } }),
    ]);
    const siteName = site?.canonicalName ?? siteId.slice(0, 8);
    const shiftTypeCode = (id: string) => shiftTypes.find((s) => s.id === id)?.code ?? id.slice(0, 8);
    const brokerCode = (id: string) => brokers.find((b) => b.id === id)?.code ?? id.slice(0, 8);
    // P3-2.5：每個 quota 一條 count → 一條 groupBy（site＋月內，按 shiftType×settlementBroker 分組）。
    const actualRows = await prisma.shiftRecord.groupBy({
      by: ["shiftTypeId", "settlementBrokerId"],
      where: {
        siteId,
        shiftTypeId: { in: [...new Set(quotas.map((q) => q.shiftTypeId))] },
        settlementBrokerId: { in: [...new Set(quotas.map((q) => q.brokerId))] },
        recordType: "shift",
        status: { not: "cancelled" },
        workDate: { gte: month, lte: monthEnd },
      },
      _count: { _all: true },
    });
    const actualByQuotaKey = new Map(actualRows.map((r) => [`${r.shiftTypeId}|${r.settlementBrokerId}`, r._count._all]));
    for (const q of quotas) {
      const actual = actualByQuotaKey.get(`${q.shiftTypeId}|${q.brokerId}`) ?? 0;
      if (actual > q.targetShifts) {
        warnings.push(`盤 ${siteName} 更別 ${shiftTypeCode(q.shiftTypeId)} 雞頭 ${brokerCode(q.brokerId)} 超配額：已排 ${actual} / 配額 ${q.targetShifts}`);
      }
    }
  }

  return warnings;
}
// ---------------------------------------------------------------------------
// WhatsApp／其他系統入口：writeShiftCells
// ---------------------------------------------------------------------------
type StatusPolicy = "confirmed" | "pending_approval";

export interface WriteShiftCellsInput {
  siteId: string;
  /** 月份（任何該月日期都得，內部取月初）。所有 cells 必須喺該月。 */
  month: Date;
  cells: Array<{ guard_id: string; shift_type_id: string; work_date: Date; code: string | null }>;
  actor: { userId: string };
  ip?: string | null;
  /** `shift_records.source`，例如 "whatsapp"。 */
  source: string;
  /** `shift_records.provenance`（additive json）。 */
  provenance?: Prisma.InputJsonValue;
  statusPolicy: StatusPolicy;
  /** 該格已有非取消、但類型唔同（班次↔請假）嘅記錄：true＝覆寫；預設 false＝拋 409，由呼叫者先取消舊記錄。 */
  overwriteActive?: boolean;
}

export interface WriteShiftCellsResult {
  results: AppliedResult[];
  /** tx commit 之後由呼叫者交俾 `journalAutoCardUsesSafe`。 */
  autoCardUses: AutoCardUse[];
  pricing: { priced: number; unpriced: number };
  noSettlementCount: number;
}

/**
 * 經共用 plan／計價／寫入核心寫入一批格（單一 site × month）。必須喺呼叫者嘅 transaction 內執行：
 * tx 開頭 `assertMonthNotLockedTx`（FOR SHARE，防 TOCTOU；鎖月 → 423）；任何驗證失敗拋 400／409 令呼叫者 tx 一齊 rollback。
 * 已存在、完全相同（同類型＋同請假碼）嘅非取消記錄 → no-op（results 記 action="exists"）；已取消行會被重用（update）。
 * 無雞頭隔離（WhatsApp 唔係雞頭 session）：settlement／operational broker 走同 batch 內部角色一致嘅 fallback 鏈。
 */
export async function writeShiftCells(tx: Prisma.TransactionClient, input: WriteShiftCellsInput): Promise<WriteShiftCellsResult> {
  const month = new Date(Date.UTC(input.month.getUTCFullYear(), input.month.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  const ip = input.ip ?? null;
  await assertMonthNotLockedTx(tx, { workDate: month, actorUserId: input.actor.userId, tableName: "shift_records", rowId: "whatsapp", ip });

  const cells = input.cells.map((c): Cell => ({ guard_id: c.guard_id, shift_type_id: c.shift_type_id, work_date: c.work_date, code: c.code }));
  for (const c of cells) {
    if (c.work_date < month || c.work_date > monthEnd) throw BadRequest(`work_date ${c.work_date.toISOString().slice(0, 10)} 唔屬於 ${month.toISOString().slice(0, 7)}`);
  }
  const shiftTypeIds = [...new Set(cells.map((c) => c.shift_type_id))];
  const shiftTypes = await tx.shiftType.findMany({ where: { id: { in: shiftTypeIds } } });
  const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));
  for (const stId of shiftTypeIds) {
    const st = shiftTypeById.get(stId);
    if (!st) throw BadRequest(`shift_type_id ${stId} 唔存在`);
    if (st.siteId !== input.siteId) throw BadRequest(`shift_type_id ${stId} 唔屬於呢個 site_id`);
  }
  const guardIds = [...new Set(cells.map((c) => c.guard_id))];
  const guards = await tx.guard.findMany({ where: { id: { in: guardIds } } });
  const guardById = new Map(guards.map((g) => [g.id, g]));
  for (const gId of guardIds) if (!guardById.get(gId)) throw BadRequest(`guard_id ${gId} 唔存在`);

  const existing = await tx.shiftRecord.findMany({ where: { siteId: input.siteId, workDate: { gte: month, lte: monthEnd }, guardId: { in: guardIds }, shiftTypeId: { in: shiftTypeIds } } });
  const existingByKey = new Map(existing.map((r) => [`${r.guardId}|${r.workDate.toISOString().slice(0, 10)}|${r.shiftTypeId}`, r]));

  const resolveSettlementBrokerFallback = createSettlementBrokerFallbackResolver(tx);
  await resolveSettlementBrokerFallback.prefetch(guardIds.map((gId) => ({ guardId: gId, siteId: input.siteId, employmentType: guardById.get(gId)!.employmentType, defaultBrokerId: guardById.get(gId)!.defaultBrokerId })));

  const plans: PlannedOp[] = [];
  const existsResults: AppliedResult[] = [];
  for (const c of cells) {
    const st = shiftTypeById.get(c.shift_type_id)!;
    const key = `${c.guard_id}|${c.work_date.toISOString().slice(0, 10)}|${c.shift_type_id}`;
    const record = existingByKey.get(key) ?? null;
    const code = c.code && c.code.trim() !== "" ? c.code.trim() : null;
    if (code === null) {
      if (!record || record.status === "cancelled") plans.push({ kind: "noop", cell: c });
      else plans.push({ kind: "clear", cell: c, existingId: record.id });
      continue;
    }
    const isLeave = LEAVE_CODES.has(code);
    if (!isLeave && code !== st.code) throw BadRequest(`code "${code}"（${key}）同呢行嘅更別代號「${st.code}」／請假代號都對唔上`);
    if (!record && st.code === "PR") throw BadRequest(`更別「${st.code}」係糧明細生成嘅對數佔位更別（${key}），唔可以排更`);
    const recordType = isLeave ? "leave" : "shift";
    if (record && record.status !== "cancelled") {
      if (record.recordType === recordType && (record.leaveCode ?? null) === (isLeave ? code : null)) {
        plans.push({ kind: "noop", cell: c });
        existsResults.push({ key, id: record.id, action: "exists" });
        continue;
      }
      if (!input.overwriteActive) throw Conflict(`呢格（${key}）已有唔同嘅記錄，要先取消舊記錄`);
    }
    const guardRow = guardById.get(c.guard_id)!;
    const fb = () => resolveSettlementBrokerFallback({ guardId: c.guard_id, siteId: input.siteId, employmentType: guardRow.employmentType, defaultBrokerId: guardRow.defaultBrokerId });
    const settlementNeedsFallback = record?.settlementBrokerId == null;
    const settlementBrokerId = record?.settlementBrokerId ?? (await fb());
    const operationalBrokerId = record?.operationalBrokerId ?? (await fb());
    plans.push({
      kind: "upsert",
      cell: c,
      existingId: record?.id ?? null,
      recordType,
      leaveCode: isLeave ? code : null,
      settlementBrokerId,
      operationalBrokerId,
      status: input.statusPolicy,
      existingIsExternal: record?.isExternal ?? false,
      pricing: null,
      settlementInferred: settlementNeedsFallback && settlementBrokerId !== null,
      manualSource: false,
    });
  }

  const { upsertPlans, pricedCount, unpricedCount } = await computePlanPricing({ siteId: input.siteId, month, monthEnd, plans, existingByKey, shiftTypeById });
  const applied = await applyShiftPlansTx(tx, { plans, siteId: input.siteId, actorUserId: input.actor.userId, ip, extra: { source: input.source, ...(input.provenance !== undefined ? { provenance: input.provenance } : {}) } });
  return {
    results: [...existsResults, ...applied.results],
    autoCardUses: applied.autoCardUses,
    pricing: { priced: pricedCount, unpriced: unpricedCount },
    noSettlementCount: upsertPlans.filter((p) => p.recordType === "shift" && p.settlementBrokerId === null).length,
  };
}

/**
 * 取消指定記錄（衝突處理「以 WhatsApp 為準（取消舊）」用）：只作廢冇刪除；audit 同 batch 清格一致
 * （action="void"、after.void_reason）。呼叫者負責 tx 內鎖月檢查（writeShiftCells 之前先取消，同一 tx）。
 */
export async function cancelShiftRecordsTx(tx: Prisma.TransactionClient, args: { ids: string[]; actorUserId: string; ip?: string | null; reason: string }): Promise<number> {
  if (args.ids.length === 0) return 0;
  await tx.$queryRaw`SELECT id FROM shift_records WHERE id = ANY(${args.ids}::text[]) ORDER BY id FOR UPDATE`;
  const before = await tx.shiftRecord.findMany({ where: { id: { in: args.ids }, status: { not: "cancelled" } } });
  if (before.length === 0) return 0;
  await tx.shiftRecord.updateMany({ where: { id: { in: before.map((r) => r.id) } }, data: { status: "cancelled" } });
  const after = new Map((await tx.shiftRecord.findMany({ where: { id: { in: before.map((r) => r.id) } } })).map((r) => [r.id, r]));
  await writeAuditMany(before.map((b) => ({ actorUserId: args.actorUserId, tableName: "shift_records", rowId: b.id, action: "void" as const, before: b, after: { ...after.get(b.id)!, void_reason: args.reason }, ip: args.ip ?? null })), tx);
  return before.length;
}
