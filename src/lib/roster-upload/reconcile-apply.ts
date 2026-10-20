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
import { assertMonthNotLocked, assertMonthNotLockedTx, monthStart as toMonthStart } from "@/lib/month-lock";
import { writeAuditMany } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { resolveShiftPricing, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { journalAutoCardUses } from "@/lib/pricing/auto-card-journal";
import { reconcileUpload, type ReconcileCategory, type ReconcileItem } from "./reconcile";
import { ROSTER_UPLOAD_META_SELECT } from "@/lib/roster-upload/meta-select";
import { resolveShiftStaffNumbers, shouldWriteStaffNumber, staffNumberData, type ResolvedStaff } from "@/lib/shift-records/staff-number";

type ReconcileDecisionAction = "apply_roster" | "keep_system" | "exception";

export interface ReconcileActionInput {
  key: string;
  action: ReconcileDecisionAction;
  reason?: string;
}

interface ReconcileActionResult {
  key: string;
  category: ReconcileCategory | "unknown";
  action: ReconcileDecisionAction;
  ok: boolean;
  error?: string;
  shiftRecordIds?: string[];
}

type Tx = PrismaClient | Prisma.TransactionClient;

type Pricing = { clientRate: number | null; guardWage: number | null; brokerFee: number | null; sources?: { clientCardId?: string; payoutCardId?: string } };

/** 驗收修正（Opus 5.5，2026-09-24）＋G4b：audit 喺 transaction 入面收集（SAVEPOINT 失敗嘅項唔收），
 * tx 最後一步用 `writeAuditMany(…, tx)` 一條 createMany 同資料一齊 commit／rollback，冇孤兒 audit。 */
type PendingAudit = { tableName: string; rowId: string; action: "create" | "update" | "void"; before?: unknown; after: unknown };

/** OT 記錉要掛靠返呢個保安員呢日嘅正更記錉（`parent_shift_id`）——搵唔到
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

function rosterRecordType(roster: NonNullable<ReconcileItem["roster"]>): "shift" | "ot" | "leave" {
  return roster.codeKind === "leave" ? "leave" : roster.codeKind === "ot" ? "ot" : "shift";
}

/** 驗收修正：snapshot 喺 transaction **之前**計好（`resolveShiftPricing`
 * 經外層 prisma 讀 rate_cards，放喺 interactive transaction 入面逐項打
 * 會令一個真實月份幾百格嘅套用撞 Prisma 預設 5 秒 transaction timeout）。
 * 規則同 batch/route.ts 一致：LINK（guards_paid_by_client）盤唔寫
 * snapshot；leave 冇 snapshot（OT 見下面 WP-MIXED-BILLING 註解）；`is_external` 跟現存記錉。 */
async function computeRosterPricing(ctx: WriteContext, roster: NonNullable<ReconcileItem["roster"]>, isExternal: boolean): Promise<Pricing> {
  const siteUnpriced = ctx.siteGuardsPaidByClient.get(roster.siteId) ?? false;
  const recordType = rosterRecordType(roster);
  // WP-MIXED-BILLING（Opus 5.5 驗收）：OT 都行 resolver——resolver 對 OT
  // 淨係配「掛住呢個 OT 更種」嘅卡（老闆：OT 逐盤逐人人手設卡，例：HKU座頭
  // 1Hr OT 84.85／73），冇卡就 null＝未定價 OT。之前呢度 OT 一律 null，
  // 令上載嘅 OT 永遠用唔到 OT 卡。leave 照舊冇 snapshot。
  if (siteUnpriced || recordType === "leave") return { clientRate: null, guardWage: null, brokerFee: null };
  const st = ctx.shiftTypeById.get(roster.shiftTypeId);
  const brokerKind = roster.settlementBrokerId ? (ctx.brokerKindById.get(roster.settlementBrokerId) ?? null) : null;
  const resolved = await resolveShiftPricing({
    siteId: roster.siteId,
    shiftTypeId: roster.shiftTypeId,
    shiftTypeCode: st?.code ?? "",
    shiftTypeBillingGroup: st?.billingGroup ?? "per_shift",
    settlementBrokerId: roster.settlementBrokerId,
    brokerKind,
    guardId: roster.guardId,
    workDate: new Date(`${roster.workDate}T00:00:00.000Z`),
    isExternal,
    recordType: recordType === "ot" ? "ot" : "shift",
    // WP-BOSS5 §25.1：OT 卡＝每小時價，resolver 要有呢更嘅 OT 時數先識
    // 乘（`roster.hours`同 `data.otHours` 寫入 shift_record 嗰個值一致，
    // 淨係 recordType==="ot" 先有意義）。
    otHours: recordType === "ot" ? (roster.hours ?? null) : null,
  });
  return { clientRate: resolved.clientRate, guardWage: resolved.guardWage, brokerFee: resolved.brokerFee, sources: resolved.source };
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
  pricing: Pricing,
  actorUserId: string,
  audits: PendingAudit[],
  staff: ResolvedStaff | null,
): Promise<string> {
  const workDateObj = new Date(`${roster.workDate}T00:00:00.000Z`);
  const recordType = rosterRecordType(roster);
  const isLeave = recordType === "leave";

  let parentShiftId: string | null = null;
  if (recordType === "ot") {
    parentShiftId = await findParentShiftId(tx, { guardId: roster.guardId, workDate: workDateObj, siteId: roster.siteId });
  }

  const provenance = { upload_id: ctx.uploadId, row_id: roster.rowId, version: ctx.uploadVersion };
  const existing = await tx.shiftRecord.findUnique({
    where: { guardId_workDate_shiftTypeId: { guardId: roster.guardId, workDate: workDateObj, shiftTypeId: roster.shiftTypeId } },
  });

  const data = {
    siteId: roster.siteId,
    settlementBrokerId: roster.settlementBrokerId,
    // WP-LTSHIFT（§2）：長工做自己崗位嘅更，settlement=B07（人工月薪
    // 覆蓋）但 operational 保留更表雞頭碼（總表成本桶）——`roster.
    // operationalBrokerId` 冇值（唔係長工格，或者舊上載未 reparse）就
    // 跌返 settlementBrokerId，同舊行為一致。
    operationalBrokerId: roster.operationalBrokerId ?? roster.settlementBrokerId,
    recordType,
    leaveCode: isLeave ? (roster.leaveCode as never) : null,
    otHours: recordType === "ot" ? (roster.hours ?? null) : null,
    parentShiftId: recordType === "ot" ? parentShiftId : null,
    status: "confirmed" as const,
    source: "roster_upload",
    provenance: provenance as unknown as Prisma.InputJsonValue,
    clientRateSnapshot: pricing.clientRate,
    guardWageSnapshot: pricing.guardWage,
    brokerFeeSnapshot: pricing.brokerFee,
  };

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number((v as { toString(): string }).toString()));
  const afterTuple: [number | null, number | null, number | null] = [pricing.clientRate, pricing.guardWage, pricing.brokerFee];
  if (existing) {
    // EMP-P1：工號歸屬（更表檔工號對中 → roster_file 會覆寫；其他推算只填空位）
    // EMP-P1.1：重新啟用 cancelled 記錄 → 先清三欄（同 create-or-reuse 一致），再按今次推導重寫
    const reactivating = existing.status === "cancelled";
    const updated = await tx.shiftRecord.update({
      where: { id: existing.id },
      data: { ...data, ...(reactivating ? { staffNumberId: null, staffScheme: null, staffNumberSource: null } : {}), ...staffNumberData(shouldWriteStaffNumber(reactivating ? { staffNumberId: null } : existing, staff) ? staff : null) },
    });
    audits.push({ tableName: "shift_records", rowId: updated.id, action: "update", before: existing, after: updated });
    await journalAutoCardUses([{ recordId: updated.id, before: [num(existing.clientRateSnapshot), num(existing.guardWageSnapshot), num(existing.brokerFeeSnapshot)], after: afterTuple, ...pricing.sources }], tx);
    return updated.id;
  }

  const created = await tx.shiftRecord.create({
    data: { ...data, ...staffNumberData(staff), workDate: workDateObj, shiftTypeId: roster.shiftTypeId, guardId: roster.guardId, createdBy: actorUserId },
  });
  audits.push({ tableName: "shift_records", rowId: created.id, action: "create", after: created });
  await journalAutoCardUses([{ recordId: created.id, before: [null, null, null], after: afterTuple, ...pricing.sources }], tx);
  return created.id;
}

async function cancelSystemRecord(tx: Tx, systemId: string, audits: PendingAudit[]): Promise<string> {
  const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: systemId } });
  const after = await tx.shiftRecord.update({ where: { id: systemId }, data: { status: "cancelled" } });
  audits.push({ tableName: "shift_records", rowId: systemId, action: "void", before, after: { ...after, void_reason: "roster_reconcile:apply_roster" } });
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
      shiftTypeIds.add(item.system.shiftTypeId);
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

type Plan = { input: ReconcileActionInput; item: ReconcileItem; pricing: Pricing | null; staff?: ResolvedStaff | null };

export async function applyReconcileDecisions(params: ApplyReconcileParams): Promise<ApplyReconcileResult> {
  const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: params.uploadId }, select: ROSTER_UPLOAD_META_SELECT });
  if (upload.status !== "parsed" && upload.status !== "confirmed") {
    throw BadRequest(`呢個上載狀態係「${upload.status}」，唔可以對數（要 parsed 或 confirmed）`);
  }
  // 驗收修正：未指定盤嘅上載（site_id=null）唔准套用任何決定（連
  // keep_system/exception 都唔得——否則全部 unresolved 項標完「保留」
  // 就會將一個冇盤嘅上載轉 confirmed）。
  if (!upload.siteId) throw BadRequest("呢個上載未指定盤，請先喺更表上載列表頁指定盤，先可以對數");

  const month = toMonthStart(upload.month);
  await assertMonthNotLocked({ workDate: month, actorUserId: params.actorUserId, tableName: "roster_uploads", rowId: params.uploadId, ip: params.ip });

  const { items, inferredLongtermPosts } = await reconcileUpload(params.uploadId);
  const itemsByKey = new Map(items.map((i) => [i.key, i]));

  const ctx = await loadWriteContext(params.uploadId, upload.version, items, params.ip);

  const results: ReconcileActionResult[] = [];
  const shiftPlans: Plan[] = [];
  const otPlans: Plan[] = [];
  const decisionPlans: Plan[] = [];

  for (const input of params.actions) {
    const item = itemsByKey.get(input.key);
    if (!item) {
      results.push({ key: input.key, category: "unknown", action: input.action, ok: false, error: "搵唔到呢個對數項（可能已經處理咗，請重新整理）" });
      continue;
    }
    if (input.action === "apply_roster") {
      if (item.category === "unresolved") {
        results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: "呢行未配對齊（保安員/更別/子盤），唔可以以更表為準寫入，先去 Phase A 頁面／指定盤／別名解決" });
        continue;
      }
      if (item.category === "match") {
        results.push({ key: input.key, category: item.category, action: input.action, ok: true, shiftRecordIds: item.system ? [item.system.id] : [] });
        continue;
      }
      if (item.roster?.codeKind === "ot") otPlans.push({ input, item, pricing: null });
      else shiftPlans.push({ input, item, pricing: null });
      continue;
    }
    if (input.action === "exception" && !(input.reason && input.reason.trim())) {
      results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: "例外決定必須填原因" });
      continue;
    }
    decisionPlans.push({ input, item, pricing: null });
  }

  // ---- transaction 之前計好 snapshot --------------------------------
  const settlementDiffIds = [...shiftPlans, ...otPlans].filter((p) => p.item.category === "settlement_diff").map((p) => p.item.system!.id);
  const settlementDiffRecords = settlementDiffIds.length
    ? await prisma.shiftRecord.findMany({ where: { id: { in: settlementDiffIds } }, select: { id: true, isExternal: true, recordType: true } })
    : [];
  const settlementDiffById = new Map(settlementDiffRecords.map((r) => [r.id, r]));
  for (const plan of [...shiftPlans, ...otPlans]) {
    const { item } = plan;
    if (!item.roster) continue; // system_only：淨係 cancel，唔使計價
    if (item.category === "settlement_diff") {
      const rec = settlementDiffById.get(item.system!.id);
      const siteUnpriced = ctx.siteGuardsPaidByClient.get(item.roster.siteId) ?? false;
      const isPR = ctx.shiftTypeById.get(item.system!.shiftTypeId)?.code === "PR";
      // 同 batch/route.ts 一致：LINK 盤／「PR」對數佔位記錉／非正更——保留
      // 現有 snapshot 唔郁（pricing=null 代表唔寫 snapshot 欄）。
      if (!rec || siteUnpriced || isPR || rec.recordType !== "shift") continue;
      plan.pricing = await computeRosterPricing(ctx, item.roster, rec.isExternal);
      continue;
    }
    const existing = await prisma.shiftRecord.findUnique({
      where: { guardId_workDate_shiftTypeId: { guardId: item.roster.guardId, workDate: new Date(`${item.roster.workDate}T00:00:00.000Z`), shiftTypeId: item.roster.shiftTypeId } },
      select: { isExternal: true },
    });
    plan.pricing = await computeRosterPricing(ctx, item.roster, existing?.isExternal ?? false);
  }

  const pendingAudits: PendingAudit[] = [];
  // 驗收修正（Opus 5.5）：Postgres 一個 statement 出錯（例如 P2002）之後
  // 成個 transaction 會變 aborted（之後所有 statement 都 25P02），淨係
  // JS try/catch 攔住個 error 冇用——之前實測：第二項撞 P2002，第三項
  // 跟住 25P02，最後 COMMIT 變 ROLLBACK，但回應仲話第一項 ok:true、audit
  // 仲寫咗一條孤兒 create。而家逐項包 SAVEPOINT：失敗就 ROLLBACK TO
  // SAVEPOINT，淨係嗰項唔生效，其他項照 commit（同 docs/api.md「逐項
  // P2002 衝突只令該項 fail、其他照做」一致）。
  async function runItem<T>(tx: Prisma.TransactionClient, fn: (audits: PendingAudit[]) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
    const local: PendingAudit[] = [];
    await tx.$executeRawUnsafe("SAVEPOINT rc_item");
    try {
      const value = await fn(local);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT rc_item");
      pendingAudits.push(...local);
      return { ok: true, value };
    } catch (err: unknown) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rc_item");
      return { ok: false, err };
    }
  }

  // WP-LTSHIFT（§2）：本次對數推算出嚟嘅長工崗位盤（guardId ->
  // {siteId, ratio}）——淨係呢個 guard 實際有格喺呢次 apply_roster 成功
  // 寫入先至 materialize（唔係「呢張上載出現過就一定建」，避免例如全部
  // 決定其實揀咗 keep_system 都幫佢建咗個崗位）。
  const appliedLongtermGuardIds = new Set<string>();

  await prisma.$transaction(
    async (tx) => {
      // P6.1f（H6）：長 tx（可達 120 秒）開頭 FOR SHARE 再查一次鎖月。
      await assertMonthNotLockedTx(tx, { workDate: month, actorUserId: params.actorUserId, tableName: "roster_uploads", rowId: params.uploadId, ip: params.ip });
      // EMP-P1：批量推導每格用邊張工號卡（更表檔工號 → B07 長工 MG → 盤 scheme），同一 tx、一次 prefetch。
      const staffByKey = await resolveShiftStaffNumbers(
        tx,
        [...shiftPlans, ...otPlans].flatMap((p) => {
          const r = p.item.roster;
          return r ? [{ key: p.input.key, guardId: r.guardId, siteId: r.siteId, workDate: new Date(`${r.workDate}T00:00:00.000Z`), rosterRowId: r.rowId, settlementBrokerId: r.settlementBrokerId }] : [];
        }),
      );
      for (const p of [...shiftPlans, ...otPlans]) p.staff = staffByKey.get(p.input.key) ?? null;
      // 正更/leave/system_only(cancel)/settlement_diff 先寫，OT 後寫（等
      // parent_shift_id 搵得到啱先寫低嘅正更）。
      for (const plan of [...shiftPlans, ...otPlans]) {
        const r = await runItem(tx, (audits) => applyOneRosterAction(tx, ctx, plan, params.actorUserId, audits));
        if (r.ok) {
          results.push({ key: plan.input.key, category: plan.item.category, action: "apply_roster", ok: true, shiftRecordIds: r.value });
          const guardId = plan.item.roster?.guardId;
          if (guardId && inferredLongtermPosts.has(guardId)) appliedLongtermGuardIds.add(guardId);
        } else results.push({ key: plan.input.key, category: plan.item.category, action: "apply_roster", ok: false, error: p2002Message(r.err) });
      }
      // WP-LTSHIFT（§2）：materialize 推算崗位——upsert 前先查有冇已經
      // 生效嘅崗位（可能上一輪 apply 或者人手已經加咗），有就唔重複建
      // （冪等，第二次跑同一批 apply 0 新增）。
      for (const guardId of appliedLongtermGuardIds) {
        const inferredPost = inferredLongtermPosts.get(guardId);
        if (!inferredPost) continue;
        await runItem(tx, async (audits) => {
          const existingActive = await tx.guardLongtermPost.findFirst({
            where: { guardId, siteId: inferredPost.siteId, voidedAt: null },
            select: { id: true },
          });
          if (existingActive) return;
          const created = await tx.guardLongtermPost.create({
            data: {
              guardId,
              siteId: inferredPost.siteId,
              effectiveFrom: month,
              effectiveTo: null,
              source: "inferred",
              note: `由 ${month.toISOString().slice(0, 7)} 更表上載對數推算（占比 ${(inferredPost.ratio * 100).toFixed(0)}%），見 WP-LTSHIFT`,
              createdBy: params.actorUserId,
            },
          });
          audits.push({ tableName: "guard_longterm_posts", rowId: created.id, action: "create", after: created });
        });
      }
      for (const { input, item } of decisionPlans) {
        const r = await runItem(tx, async (audits) => {
          const prior = await tx.rosterReconcileDecision.findUnique({ where: { uploadId_reconcileKey: { uploadId: params.uploadId, reconcileKey: input.key } } });
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
          audits.push({ tableName: "roster_reconcile_decisions", rowId: decision.id, action: prior ? "update" : "create", before: prior ?? undefined, after: decision });
          return decision;
        });
        if (r.ok) results.push({ key: input.key, category: item.category, action: input.action, ok: true });
        else results.push({ key: input.key, category: item.category, action: input.action, ok: false, error: r.err instanceof Error ? r.err.message : "寫入失敗" });
      }
      // G4b：audit 同寫入同一 tx（最後一步，一條 createMany；SAVEPOINT 失敗嘅項冇 audit，唔會孤兒）。
      await writeAuditMany(pendingAudits.map((a) => ({ actorUserId: params.actorUserId, tableName: a.tableName, rowId: a.rowId, action: a.action, before: a.before, after: a.after, ip: ctx.ip })), tx);
    },
    // 一個真實月份可以有幾百至千幾格——預設 5 秒唔夠。
    { timeout: 120_000, maxWait: 10_000 },
  );

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

async function applyOneRosterAction(tx: Tx, ctx: WriteContext, plan: Plan, actorUserId: string, audits: PendingAudit[]): Promise<string[]> {
  const { item } = plan;
  const pricing = plan.pricing ?? { clientRate: null, guardWage: null, brokerFee: null };
  switch (item.category) {
    case "roster_only": {
      const id = await upsertRosterShiftRecord(tx, ctx, item.roster!, pricing, actorUserId, audits, plan.staff ?? null);
      return [id];
    }
    case "system_only": {
      const id = await cancelSystemRecord(tx, item.system!.id, audits);
      return [id];
    }
    case "guard_diff":
    case "shift_type_diff": {
      const cancelledId = await cancelSystemRecord(tx, item.system!.id, audits);
      const newId = await upsertRosterShiftRecord(tx, ctx, item.roster!, pricing, actorUserId, audits, plan.staff ?? null);
      return [cancelledId, newId];
    }
    case "settlement_diff": {
      const roster = item.roster!;
      const system = item.system!;
      const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: system.id } });
      const after = await tx.shiftRecord.update({
        where: { id: system.id },
        data: {
          settlementBrokerId: roster.settlementBrokerId,
          operationalBrokerId: roster.operationalBrokerId ?? roster.settlementBrokerId, // WP-LTSHIFT §2：長工格保留雞頭碼做成本桶
          source: "roster_upload",
          provenance: { upload_id: ctx.uploadId, row_id: roster.rowId, version: ctx.uploadVersion } as unknown as Prisma.InputJsonValue,
          ...staffNumberData(shouldWriteStaffNumber(before, plan.staff) ? plan.staff : null),
          // plan.pricing=null：LINK 盤／PR 佔位／非正更——保留現有 snapshot。
          ...(plan.pricing ? { clientRateSnapshot: plan.pricing.clientRate, guardWageSnapshot: plan.pricing.guardWage, brokerFeeSnapshot: plan.pricing.brokerFee } : {}),
        },
      });
      audits.push({ tableName: "shift_records", rowId: system.id, action: "update", before, after });
      if (plan.pricing) {
        const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number((v as { toString(): string }).toString()));
        await journalAutoCardUses([{ recordId: system.id, before: [num(before.clientRateSnapshot), num(before.guardWageSnapshot), num(before.brokerFeeSnapshot)], after: [plan.pricing.clientRate, plan.pricing.guardWage, plan.pricing.brokerFee], ...plan.pricing.sources }], tx);
      }
      return [system.id];
    }
    default:
      return [];
  }
}
