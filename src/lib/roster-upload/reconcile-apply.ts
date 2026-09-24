// WP-ROSTER-UPLOAD Phase B-1（§14.1／§15.3 分期）：對數決定套用——一個
// transaction 入面，逐項按 `apply_roster`/`keep_system`/`exception` 三種
// 決定寫入（或者唔寫、淨係留痕），規則見 `reconcile.ts` 頂註解＋任務書
// B1-2。
//
// `apply_roster`（以更表為準）逐分類點做：
//   roster_only    → create shift_records（更表有、系統冇）
//   system_only    → 原記錉 status='cancelled'（更表冇呢更）
//   guard_diff     → 原記錉（系統嗰個人）status='cancelled'＋喺更表嗰個人
//                     嗰個 key create/reuse
//   shift_type_diff→ 原記錉（系統嗰個更別）status='cancelled'＋喺更表嗰個
//                     更別嗰個 key create/reuse
//   settlement_diff→ 同一條記錉（key 冇變）update settlement/operational
//                     broker＋重計 snapshot
//   match          → 冇嘢做（idempotent no-op）
//   unresolved     → 唔可以 apply_roster（冧唔到 guard/shift_type）
//
// `keep_system`／`exception`：唔改 `shift_records`，喺
// `roster_reconcile_decisions` upsert 一行留痕（邊個、幾時、原因）。
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertMonthNotLocked, monthStart as toMonthStart } from "@/lib/month-lock";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { resolveShiftPricing, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { reconcileUpload, type ReconcileCategory, type ReconcileItem } from "./reconcile";

export type ReconcileDecisionAction = "apply_roster" | "keep_system" | "exception";

export interface ReconcileActionInput {
  key: string;
  action: ReconcileDecisionAction;
  reason?: string;
}

export interface ReconcileActionResult {
  key: string;
  category: ReconcileCategory | "unknown";
  action: ReconcileDecisionAction;
  ok: boolean;
  error?: string;
  shiftRecordIds?: string[];
}

type Tx = PrismaClient | Prisma.TransactionClient;

/** OT 記錉要掛靠返呢個安員呢日嘅正更記錉（`parent_shift_id`）——搵唔到
 * 就 null（唔擋，OT 冇 parent 都可以存在，見 schema `parentShiftId`
 * optional）。喺同一個 transaction 入面查，見得到呢個 transaction內
 * 之前先寫低嘅正更記錉（見 `applyReconcileDecisions()` 分兩輪寫嘅
 * 註解）。 */
async function findParentShiftId(tx: Tx, params: { guardId: string; workDate: Date; siteId: string }): Promise<string | null> {
  const parent = await tx.shiftRecord.findFirst({
    where: { guardId: params.guardId, workDate: params.workDate, siteId: params.siteId, recordType: "shift", status: { not: "cancelled" } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return parent?.id ?? null;
}

interface WriteContext {
  shiftTypeById: Map<string, { code: string; billingGroup: string }>;
  brokerKindById: Map<string, BrokerKindLike>;
  siteGuardsPaidByClient: Map<string, boolean>;
  uploadId: string;
  uploadVersion: number;
  ip: string | null;
}

/** roster_only／guard_diff／shift_type_diff 嘅「喺更表嗰個 key 度
 * create/reuse」共用邏輯——目標 key 可能已經有一條（例如之前一輪
 * apply 留低嘅 cancelled 記錉），有就 update 番（唔撞 unique
 * constraint——`@@unique([guardId, workDate, shiftTypeId])` 冇 partial
 * filter，cancelled 一樣佔住個 key，見 batch/route.ts 同一手法）。 */
async function upsertRosterShiftRecord(
  tx: Tx,
  ctx: WriteContext,
  roster: NonNullable<ReconcileItem["roster"]>,
  actorUserId: string,
): Promise<string> {
  const workDateObj = new Date(`${roster.workDate}T00:00:00.000Z`);
  const st = ctx.shiftTypeById.get(roster.shiftTypeId);
  const siteUnpriced = ctx.siteGuardsPaidByClient.get(roster.siteId) ?? false;
  const isLeave = roster.codeKind === "leave";
  const recordType = isLeave ? "leave" : roster.codeKind === "ot" ? "ot" : "shift";

  let parentShiftId: string | null = null;
  if (recordType === "ot") {
    parentShiftId = await findParentShiftId(tx, { guardId: roster.guardId, workDate: workDateObj, siteId: roster.siteId });
  }

  let pricing: { clientRate: number | null; guardWage: number | null; brokerFee: number | null } = { clientRate: null, guardWage: null, brokerFee: null };
  if (!siteUnpriced && recordType === "shift") {
    const brokerKind = roster.settlementBrokerId ? (ctx.brokerKindById.get(roster.settlementBrokerId) ?? null) : null;
    const resolved = await resolveShiftPricing({
      siteId: roster.siteId,
      shiftTypeId: roster.shiftTypeId,
      shiftTypeCode: st?.code ?? "",
      shiftTypeBillingGroup: st?.billingGroup ?? "per_shift",
      settlementBrokerId: roster.settlementBrokerId,
      brokerKind,
      guardId: roster.guardId,
      workDate: workDateObj,
      isExternal: false,
      recordType: "shift",
    });
    pricing = { clientRate: resolved.clientRate, guardWage: resolved.guardWage, brokerFee: resolved.brokerFee };
  }

  const provenance = { upload_id: ctx.uploadId, row_id: roster.rowId, version: ctx.uploadVersion };
  const existing = await tx.shiftRecord.findUnique({
    where: { guardId_workDate_shiftTypeId: { guardId: roster.guardId, workDate: workDateObj, shiftTypeId: roster.shiftTypeId } },
  });

  if (existing) {
    const updated = await tx.shiftRecord.update({
      where: { id: existing.id },
      data: {
        siteId: roster.siteId,
        settlementBrokerId: roster.settlementBrokerId,
        operationalBrokerId: roster.settlementBrokerId,
        recordType,
        leaveCode: isLeave ? (roster.leaveCode as never) : null,
        otHours: recordType === "ot" ? (roster.hours ?? null) : null,
        parentShiftId: recordType === "ot" ? parentShiftId : null,
        status: "confirmed",
        source: "roster_upload",
        provenance: provenance as unknown as Prisma.InputJsonValue,
        clientRateSnapshot: pricing.clientRate,
        guardWageSnapshot: pricing.guardWage,
        brokerFeeSnapshot: pricing.brokerFee,
      },
    });
    await writeAudit({ actorUserId, tableName: "shift_records", rowId: updated.id, action: "update", after: updated, ip: ctx.ip });
    return updated.id;
  }

  const created = await tx.shiftRecord.create({
    data: {
      workDate: workDateObj,
      siteId: roster.siteId,
      shiftTypeId: roster.shiftTypeId,
      guardId: roster.guardId,
      settlementBrokerId: roster.settlementBrokerId,
      operationalBrokerId: roster.settlementBrokerId,
      recordType,
      leaveCode: isLeave ? (roster.leaveCode as never) : null,
      otHours: recordType === "ot" ? (roster.hours ?? null) : null,
      parentShiftId: recordType === "ot" ? parentShiftId : null,
      status: "confirmed",
      source: "roster_upload",
      provenance: provenance as unknown as Prisma.InputJsonValue,
      clientRateSnapshot: pricing.clientRate,
      guardWageSnapshot: pricing.guardWage,
      brokerFeeSnapshot: pricing.brokerFee,
      createdBy: actorUserId,
    },
  });
  await writeAudit({ actorUserId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip: ctx.ip });
  return created.id;
}

async function cancelSystemRecord(tx: Tx, systemId: string, actorUserId: string, ip: string | null): Promise<string> {
  const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: systemId } });
  const after = await tx.shiftRecord.update({ where: { id: systemId }, data: { status: "cancelled" } });
  await writeAudit({ actorUserId, tableName: "shift_records", rowId: systemId, action: "void", before, after: { ...after, void_reason: "roster_reconcile:apply_roster" }, ip });
  return systemId;
}

async function loadWriteContext(uploadId: string, uploadVersion: number, items: readonly ReconcileItem[], ip: string | null): Promise<WriteContext> {
  const shiftTypeIds = new Set<string>();
  const siteIds = new Set<string>();
  const brokerIds = new Set<string>();
  for (const item of items) {
    if (item.roster) {
      shiftTypeIds.add(item.roster.shiftTypeId);
      siteIds.add(item.roster.siteId);
      if (item.roster.settlementBrokerId) brokerIds.add(item.roster.settlementBrokerId);
    }
    if (item.system) {
      if (item.system.settlementBrokerId) brokerIds.add(item.system.settlementBrokerId);
    }
  }
  const [shiftTypes, brokers, sites] = await Promise.all([
    shiftTypeIds.size ? prisma.shiftType.findMany({ where: { id: { in: [...shiftTypeIds] } }, select: { id: true, code: true, billingGroup: true } }) : Promise.resolve([]),
    brokerIds.size ? prisma.broker.findMany({ where: { id: { in: [...brokerIds] } }, select: { id: true, kind: true } }) : Promise.resolve([]),
    siteIds.size ? prisma.site.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, guardsPaidByClient: true } }) : Promise.resolve([]),
  ]);
  return {
    shiftTypeById: new Map(shiftTypes.map((s) => [s.id, { code: s.code, billingGroup: s.billingGroup }])),
    brokerKindById: new Map(brokers.map((b) => [b.id, b.kind])),
    siteGuardsPaidByClient: new Map(sites.map((s) => [s.id, s.guardsPaidByClient])),
    uploadId,
    uploadVersion,
    ip,
  };
}

export interface ApplyReconcileParams {
  uploadId: string;
  actions: ReconcileActionInput[];
  actorUserId: string;
  ip: string | null;
}

export interface ApplyReconcileResult {
  results: ReconcileActionResult[];
  uploadStatus: string;
  pendingCount: number;
}

export async function applyReconcileDecisions(params: ApplyReconcileParams): Promise<ApplyReconcileResult> {
  const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: params.uploadId } });
  if (upload.status !== "parsed" && upload.status !== "confirmed") {
    throw BadRequest(`呢個上載狀態係「${upload.status}」，唔可以對數（要 parsed 或 confirmed）`);
  }

  const month = toMonthStart(upload.month);
  await assertMonthNotLocked({ workDate: month, actorUserId: params.actorUserId, tableName: "roster_uploads", rowId: params.uploadId, ip: params.ip });

  const { items } = await reconcileUpload(params.uploadId);
  const itemsByKey = new Map(items.map((i) => [i.key, i]));

  const ctx = await loadWriteContext(params.uploadId, upload.version, items, params.ip);

  const results: ReconcileActionResult[] = [];
  const shiftPlans: { input: ReconcileActionInput; item: ReconcileItem }[] = [];
  const otPlans: { input: ReconcileActionInput; item: ReconcileItem }[] = [];
  const decisionPlans: { input: ReconcileActionInput; item: ReconcileItem }[] = [];

  for (const input of params.actions) {
    const item = itemsByKey.get(input.key);
    if (!item) {
      results.push({ key: input.key, category: "unknown", action: input.action, ok: false, error: "搵唔到呢個對數項（可能已經處理咗，請重新整理）" });
      continue;
    }
    if (input.action === "apply_roster") {
      if (item.category === "unresolved") {
        results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: "呢行未配對齊（安員/更別/子盤），唔可以以更表為準寫入，先去 Phase A 頁面／指定盤／別名解決" });
        continue;
      }
      if (item.category === "match") {
        results.push({ key: input.key, category: item.category, action: input.action, ok: true, shiftRecordIds: item.system ? [item.system.id] : [] });
        continue;
      }
      if (item.roster?.codeKind === "ot") otPlans.push({ input, item });
      else shiftPlans.push({ input, item });
      continue;
    }
    if (input.action === "exception" && !(input.reason && input.reason.trim())) {
      results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: "例外決定必須填原因" });
      continue;
    }
    decisionPlans.push({ input, item });
  }

  await prisma.$transaction(async (tx) => {
    // 正更/leave/system_only(cancel)/settlement_diff 先寫，OT 後寫（等
    // parent_shift_id 搵得到啱先寫低嘅正更）。
    for (const { input, item } of shiftPlans) {
      try {
        const ids = await applyOneRosterAction(tx, ctx, item, params.actorUserId);
        results.push({ key: input.key, category: item.category, action: "apply_roster", ok: true, shiftRecordIds: ids });
      } catch (err: unknown) {
        results.push({ key: input.key, category: item.category, action: "apply_roster", ok: false, error: p2002Message(err) });
      }
    }
    for (const { input, item } of otPlans) {
      try {
        const ids = await applyOneRosterAction(tx, ctx, item, params.actorUserId);
        results.push({ key: input.key, category: item.category, action: "apply_roster", ok: true, shiftRecordIds: ids });
      } catch (err: unknown) {
        results.push({ key: input.key, category: item.category, action: "apply_roster", ok: false, error: p2002Message(err) });
      }
    }
    for (const { input, item } of decisionPlans) {
      try {
        const decision = await tx.rosterReconcileDecision.upsert({
          where: { uploadId_reconcileKey: { uploadId: params.uploadId, reconcileKey: input.key } },
          create: {
            uploadId: params.uploadId,
            reconcileKey: input.key,
            category: item.category,
            action: input.action,
            reason: input.reason?.trim() || null,
            decidedBy: params.actorUserId,
          },
          update: {
            category: item.category,
            action: input.action,
            reason: input.reason?.trim() || null,
            decidedBy: params.actorUserId,
            decidedAt: new Date(),
          },
        });
        await writeAudit({ actorUserId: params.actorUserId, tableName: "roster_reconcile_decisions", rowId: decision.id, action: "create", after: decision, ip: ctx.ip });
        results.push({ key: input.key, category: item.category, action: input.action, ok: true });
      } catch (err: unknown) {
        results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: err instanceof Error ? err.message : "寫入失敗" });
      }
    }
  });

  // 套用完之後重新分類，計返仲有幾多項未有決定——齊晒先轉 confirmed。
  const { items: itemsAfter } = await reconcileUpload(params.uploadId);
  const decisions = await prisma.rosterReconcileDecision.findMany({ where: { uploadId: params.uploadId }, select: { reconcileKey: true } });
  const decidedKeys = new Set(decisions.map((d) => d.reconcileKey));
  const pending = itemsAfter.filter((i) => i.category !== "match" && !decidedKeys.has(i.key));
  let uploadStatus = upload.status;
  if (pending.length === 0 && upload.status === "parsed") {
    await prisma.rosterUpload.update({ where: { id: params.uploadId }, data: { status: "confirmed" } });
    uploadStatus = "confirmed";
  }

  return { results, uploadStatus, pendingCount: pending.length };
}

function p2002Message(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
    return "撞到唯一約束（同一保安員、同一日、同一更別已經有記錄）";
  }
  return err instanceof Error ? err.message : "寫入失敗";
}

async function applyOneRosterAction(tx: Tx, ctx: WriteContext, item: ReconcileItem, actorUserId: string): Promise<string[]> {
  switch (item.category) {
    case "roster_only": {
      const id = await upsertRosterShiftRecord(tx, ctx, item.roster!, actorUserId);
      return [id];
    }
    case "system_only": {
      const id = await cancelSystemRecord(tx, item.system!.id, actorUserId, ctx.ip);
      return [id];
    }
    case "guard_diff":
    case "shift_type_diff": {
      const cancelledId = await cancelSystemRecord(tx, item.system!.id, actorUserId, ctx.ip);
      const newId = await upsertRosterShiftRecord(tx, ctx, item.roster!, actorUserId);
      return [cancelledId, newId];
    }
    case "settlement_diff": {
      const roster = item.roster!;
      const system = item.system!;
      const st = ctx.shiftTypeById.get(roster.shiftTypeId);
      const siteUnpriced = ctx.siteGuardsPaidByClient.get(roster.siteId) ?? false;
      let pricing: { clientRate: number | null; guardWage: number | null; brokerFee: number | null } = { clientRate: null, guardWage: null, brokerFee: null };
      if (!siteUnpriced && system.recordType === "shift") {
        const brokerKind = roster.settlementBrokerId ? (ctx.brokerKindById.get(roster.settlementBrokerId) ?? null) : null;
        const workDateObj = new Date(`${roster.workDate}T00:00:00.000Z`);
        const resolved = await resolveShiftPricing({
          siteId: roster.siteId,
          shiftTypeId: roster.shiftTypeId,
          shiftTypeCode: st?.code ?? "",
          shiftTypeBillingGroup: st?.billingGroup ?? "per_shift",
          settlementBrokerId: roster.settlementBrokerId,
          brokerKind,
          guardId: roster.guardId,
          workDate: workDateObj,
          isExternal: false,
          recordType: "shift",
        });
        pricing = { clientRate: resolved.clientRate, guardWage: resolved.guardWage, brokerFee: resolved.brokerFee };
      }
      const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: system.id } });
      const after = await tx.shiftRecord.update({
        where: { id: system.id },
        data: {
          settlementBrokerId: roster.settlementBrokerId,
          operationalBrokerId: roster.settlementBrokerId,
          source: "roster_upload",
          provenance: { upload_id: ctx.uploadId, row_id: roster.rowId, version: ctx.uploadVersion } as unknown as Prisma.InputJsonValue,
          ...(system.recordType === "shift"
            ? { clientRateSnapshot: pricing.clientRate, guardWageSnapshot: pricing.guardWage, brokerFeeSnapshot: pricing.brokerFee }
            : {}),
        },
      });
      await writeAudit({ actorUserId, tableName: "shift_records", rowId: system.id, action: "update", before, after, ip: ctx.ip });
      return [system.id];
    }
    default:
      return [];
  }
}
