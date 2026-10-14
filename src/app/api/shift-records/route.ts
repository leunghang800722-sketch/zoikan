import { MANUAL_SOURCE } from "@/lib/longterm-payroll/attendance-priority";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import {
  scopeShiftRecordWhere,
  scrubForBrokerSession,
  isBrokerRole,
  requireOwnBrokerId,
  assertGuardOwnedByBroker,
  assertSiteAssignedToBroker,
  assertSettlementBrokerIdsValid,
} from "@/lib/broker-isolation";
import { toBrokerShiftRecordDTO, mapListForBroker } from "@/lib/broker-dto";
import { toShiftRecordFullDTO, toShiftRecordListDTO, toShiftRecordGridDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError , okGzip } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftRecordCreateSchema, BrokerShiftRecordCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict, NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";
// WP-PRICE：單條建立都要計價（同 batch/route.ts 一樣，之前完全冇寫
// snapshot 三個欄）——見 src/lib/pricing/resolve-rate.ts 頂註解。
import { journalAutoCardUsesSafe, toNum } from "@/lib/pricing/auto-card-journal";
import { resolveShiftPricing, type ShiftPricingRecordType } from "@/lib/pricing/resolve-rate";
// P0（Opus 驗收重現）：settlement_broker_id 冇填就喺糧明細完全消失——
// 單筆新建都要行同一條 fallback 鏈，見 settlement-broker-fallback.ts。
import { resolveSettlementBrokerFallback } from "@/lib/pricing/settlement-broker-fallback";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const siteId = url.searchParams.get("site_id");
    const guardId = url.searchParams.get("guard_id");
    const workDateFrom = url.searchParams.get("work_date_from");
    const workDateTo = url.searchParams.get("work_date_to");
    const includeVoided = url.searchParams.get("include_voided") === "1";
    const includeProvenance = url.searchParams.get("include_provenance") === "1";
    const gridView = url.searchParams.get("view") === "grid";
    // P1-WP3：審批隊列——`GET /api/shift-records?status=pending_approval`。
    // 明確傳咗 status 就用嗰個值（覆蓋 includeVoided 嘅預設 not:cancelled）。
    const statusParam = url.searchParams.get("status");

    let where: Prisma.ShiftRecordWhereInput = {
      ...(siteId ? { siteId } : {}),
      ...(guardId ? { guardId } : {}),
      ...(statusParam ? { status: statusParam as Prisma.EnumShiftRecordStatusFilter["equals"] } : includeVoided ? {} : { status: { not: "cancelled" } }),
      ...(workDateFrom || workDateTo
        ? { workDate: { ...(workDateFrom ? { gte: new Date(workDateFrom) } : {}), ...(workDateTo ? { lte: new Date(workDateTo) } : {}) } }
        : {}),
    };
    where = scopeShiftRecordWhere(session, where);

    const [rows, total] = await Promise.all([
      prisma.shiftRecord.findMany({ where, skip, take, orderBy: [{ workDate: "desc" }, { id: "asc" }] }),
      prisma.shiftRecord.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return okGzip(req, scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerShiftRecordDTO)));
    }
    // M1：內部角色都經白名單 DTO（唔准 raw row 出街），再經 field-group gate
    // （主管出廠冇「收客價:view」就剝 client_rate_snapshot）。
    const dto = mapListDTO({ rows, total, skip, take }, gridView ? toShiftRecordGridDTO : includeProvenance ? toShiftRecordFullDTO : toShiftRecordListDTO);
    return okGzip(req, await applyFieldGroupGateToList(session, "shift_records", dto));
  });
}

async function assertShiftTypeBelongsToSite(shiftTypeId: string, siteId: string): Promise<{ code: string; billingGroup: string }> {
  // S2：shift_type.site_id 一定要同傳入嘅 site_id 一致，否則 400（防止
  // 夾錯／夾撞另一個盤嘅更別）。順便攞返 code／billing_group——WP-PRICE
  // resolver 要知道係咪 code="PR"（糧明細生成 reconciliation
  // placeholder），見 src/lib/pricing/resolve-rate.ts
  // `ResolveShiftPricingInput.shiftTypeCode`／`shiftTypeBillingGroup`。
  const st = await prisma.shiftType.findUnique({ where: { id: shiftTypeId }, select: { siteId: true, code: true, billingGroup: true } });
  if (!st) throw BadRequest("shift_type_id 唔存在");
  if (st.siteId !== siteId) throw BadRequest("shift_type_id 唔屬於呢個 site_id");
  // 必修 1(a)（Opus 第二輪驗收）：code="PR" 對數佔位更別——呢個 route
  // 永遠都係「新建」（POST 冇 upsert-on-existing 分支），所以淨係要
  // 400，唔使好似 batch/route.ts 咁分「新建 vs 更新既有」。
  if (st.code === "PR") throw BadRequest(`更別「${st.code}」係糧明細生成嘅對數佔位更別，唔可以排更`);
  return { code: st.code, billingGroup: st.billingGroup };
}

async function assertParentShiftValid(
  parentShiftId: string,
  session: Awaited<ReturnType<typeof requirePermission>>,
  guardId: string,
  siteId: string,
  settlementBrokerId: string | null,
): Promise<void> {
  // S3：parent_shift_id 必須同一 guard、同一 site、同一 settlement broker；
  // 雞頭嘅 parent 必須係自己更次（唔屬於自己就當「搵唔到」404，唔用 403
  // ——唔好漏對方更次存在）。
  const parent = await prisma.shiftRecord.findUnique({ where: { id: parentShiftId } });
  if (!parent) throw NotFound("parent_shift_id 搵唔到");
  if (isBrokerRole(session)) {
    const brokerId = requireOwnBrokerId(session);
    if (parent.settlementBrokerId !== brokerId && parent.operationalBrokerId !== brokerId) {
      throw NotFound("parent_shift_id 搵唔到"); // 存在但唔屬於自己——當唔存在處理
    }
  }
  if (parent.guardId !== guardId || parent.siteId !== siteId || parent.settlementBrokerId !== settlementBrokerId) {
    throw BadRequest("parent_shift_id 要同一個 guard/site/settlement broker");
  }
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "create");
    const rawBody = await readJson(req);

    if (isBrokerRole(session)) {
      // S1：雞頭專用窄 schema，未知 key（例如價錢欄）400，唔再靜默剝。
      const parsedBroker = parseBody(BrokerShiftRecordCreateSchema, rawBody);
      const brokerId = requireOwnBrokerId(session);
      const workDate = parsedBroker.work_date;

      // C1：憑空開更＋guard嫁接防線。
      await assertGuardOwnedByBroker(parsedBroker.guard_id, brokerId);
      await assertSiteAssignedToBroker(parsedBroker.site_id, brokerId, workDate);
      const brokerShiftType = await assertShiftTypeBelongsToSite(parsedBroker.shift_type_id, parsedBroker.site_id);
      if (parsedBroker.parent_shift_id) {
        await assertParentShiftValid(parsedBroker.parent_shift_id, session, parsedBroker.guard_id, parsedBroker.site_id, brokerId);
      }

      const data = snakeToCamelShallow(parsedBroker) as Prisma.ShiftRecordUncheckedCreateInput;
      data.settlementBrokerId = brokerId;
      data.operationalBrokerId = brokerId;
      // P1-WP3 設計文件§4.1「雞頭：喺自己配額內填人」→「主管：審批隊列
      // 逐項確認（requires_approval=false 嘅雞頭自動 confirmed）」——
      // brokers.requires_approval 決定雞頭開嘅更一開波係 draft/待審
      // 定直接confirmed（呢度用 pending_approval，等主管審批隊列見到；
      // requires_approval=false 直接 confirmed，唔使入隊）。
      const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { requiresApproval: true, kind: true } });
      data.status = broker.requiresApproval ? "pending_approval" : "confirmed";

      // WP-PRICE：雞頭自己開嘅更（呢個 schema 冇任何 snapshot 欄可以自己填）
      // 一律 runtime 計價，唔准靜靜 0。
      //
      // WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類
      // 盤唔寫 snapshot——同 batch/route.ts、reprice/route.ts 一致嘅 gate。
      let brokerPricingSource: { clientCardId?: string; payoutCardId?: string } = {};
      const brokerPricingSite = await prisma.site.findUnique({ where: { id: parsedBroker.site_id }, select: { guardsPaidByClient: true } });
      if (brokerPricingSite?.guardsPaidByClient) {
        data.clientRateSnapshot = null;
        data.guardWageSnapshot = null;
        data.brokerFeeSnapshot = null;
      } else {
        const brokerPricing = await resolveShiftPricing({
          siteId: parsedBroker.site_id,
          shiftTypeId: parsedBroker.shift_type_id,
          shiftTypeCode: brokerShiftType.code,
          shiftTypeBillingGroup: brokerShiftType.billingGroup,
          settlementBrokerId: brokerId,
          brokerKind: broker.kind,
          guardId: parsedBroker.guard_id,
          workDate,
          isExternal: false,
          recordType: (data.recordType ?? "shift") as ShiftPricingRecordType,
          // WP-BOSS5 §25.1：OT 卡＝每小時價，`data.otHours` 已經由
          // `BrokerShiftRecordCreateSchema`（`ot_hours`）解析好。
          otHours: data.otHours != null ? Number(data.otHours) : null,
        });
        data.clientRateSnapshot = brokerPricing.clientRate;
        data.guardWageSnapshot = brokerPricing.guardWage;
        data.brokerFeeSnapshot = brokerPricing.brokerFee;
        brokerPricingSource = brokerPricing.source;
      }

      await assertMonthNotLocked({ workDate, actorUserId: session.userId, tableName: "shift_records", rowId: "new", ip: getClientIp(req) });

      try {
        const created = await prisma.shiftRecord.create({ data: { ...data, source: data.source ?? MANUAL_SOURCE, createdBy: session.userId } }); // P18：單條新建寫 source=manual（同 batch 一致；caller 明確帶 source 先保留）
        await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
        await journalAutoCardUsesSafe([{ recordId: created.id, before: [null, null, null], after: [toNum(created.clientRateSnapshot), toNum(created.guardWageSnapshot), toNum(created.brokerFeeSnapshot)], ...brokerPricingSource }]);
        return ok(scrubForBrokerSession(session, toBrokerShiftRecordDTO(created)), 201);
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
          throw Conflict("同一保安員、同一日、同一更別已經有記錄（硬性規則2）");
        }
        throw err;
      }
    }

    // 內部角色：完整 schema，M1/M3 field-group 寫入閘。
    const parsed = parseBody(ShiftRecordCreateSchema, rawBody);
    // 應修 4：settlement_broker_id／operational_broker_id 一定要存在
    // （唔存在→400，唔留低俾後面 create() 嘅 FK constraint 撞 500）。
    // 呢個分支冇雞頭 session（雞頭專用 BrokerShiftRecordCreateSchema
    // 完全冇呢兩個欄），所以淨係做存在性校驗（`ownBrokerId=null`）。
    await assertSettlementBrokerIdsValid([parsed.settlement_broker_id, parsed.operational_broker_id], null);
    await assertFieldGroupWritable(session, "shift_records", parsed);
    const internalShiftType = await assertShiftTypeBelongsToSite(parsed.shift_type_id, parsed.site_id);
    const data = snakeToCamelShallow(parsed) as Prisma.ShiftRecordUncheckedCreateInput;
    const workDate = parsed.work_date;

    // 應修 5：OT 子記錄（`parent_shift_id` 有值）冇帶 settlement_broker_id／
    // operational_broker_id 就跟 parent 嘅值——唔行下面通用嘅
    // guard.default_broker_id fallback 鏈（parent 本身可能經人手覆寫過，
    // OT 子記錄理應同 parent 一致，唔係重新用通用規則計，計出嚟隨時同
    // parent 唔同一個 broker）。呢步要喺 `assertParentShiftValid()` 之前
    // 做——下面驗證要用嘅係「fallback 之後」嘅值。
    if (parsed.parent_shift_id && (data.settlementBrokerId == null || data.operationalBrokerId == null)) {
      const parentForBrokerDefault = await prisma.shiftRecord.findUnique({
        where: { id: parsed.parent_shift_id },
        select: { settlementBrokerId: true, operationalBrokerId: true },
      });
      if (parentForBrokerDefault) {
        if (data.settlementBrokerId == null) data.settlementBrokerId = parentForBrokerDefault.settlementBrokerId;
        if (data.operationalBrokerId == null) data.operationalBrokerId = parentForBrokerDefault.operationalBrokerId;
      }
    }

    // P0（Opus 驗收重現）：呢個 route 之前完全冇 fallback——冇傳
    // settlement_broker_id／operational_broker_id 就直接寫 null，令
    // 呢條記錄喺 buildPayrollTotals()（逐 broker 查）完全消失。而家同
    // batch/route.ts 一致，行同一條 fallback 鏈（payload 已經喺
    // data.settlementBrokerId 度，呢度淨係補「payload 冇填、又冇跟到
    // parent」嗰個情況；冇 parent_shift_id 嘅一般新建都行呢條鏈）。
    if (data.settlementBrokerId == null || data.operationalBrokerId == null) {
      const guardForFallback = await prisma.guard.findUnique({
        where: { id: parsed.guard_id },
        select: { employmentType: true, defaultBrokerId: true },
      });
      if (guardForFallback) {
        const fallbackBrokerId = await resolveSettlementBrokerFallback({
          guardId: parsed.guard_id,
          siteId: parsed.site_id,
          employmentType: guardForFallback.employmentType,
          defaultBrokerId: guardForFallback.defaultBrokerId,
        });
        if (data.settlementBrokerId == null) data.settlementBrokerId = fallbackBrokerId;
        if (data.operationalBrokerId == null) data.operationalBrokerId = fallbackBrokerId;
      }
    }

    // 應修 5：`assertParentShiftValid()` 要用「fallback 之後」嘅
    // settlement broker（唔係 raw payload 值）——之前呢個檢查行喺 fallback
    // 之前，OT 子記錄冇帶 settlement_broker_id 就會用 `null` 同 parent
    // 個真實值比對，一定唔啱，即刻 400（就算跟返 parent 嘅邏輯本身冇
    // 問題都會撞）。
    if (parsed.parent_shift_id) {
      const settlementBrokerId = (data.settlementBrokerId as string | null | undefined) ?? null;
      await assertParentShiftValid(parsed.parent_shift_id, session, parsed.guard_id, parsed.site_id, settlementBrokerId);
    }

    // WP-PRICE：內部角色呢個 schema 本身容許手動傳 *_snapshot（保留
    // 手動覆寫能力，例如補漏單／人手核價）——淨係冇傳嗰啲先自動計價，
    // 傳咗嘅一律尊重，唔覆蓋。
    //
    // WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類
    // 盤自動計價呢一步跳過（冇傳嘅欄保持 null）——手動明確傳咗嘅值仍然
    // 尊重（老闆／會計可以人手補一次性特殊安排），唔喺呢度硬性擋。
    const internalSource: { clientCardId?: string; payoutCardId?: string } = {};
    // journal 嘅 before＝人手明確傳入嘅值（auto 卡填入之前）；undo 只會還原 auto 填咗嗰幾欄
    const manualBefore: [number | null, number | null, number | null] = [toNum(data.clientRateSnapshot), toNum(data.guardWageSnapshot), toNum(data.brokerFeeSnapshot)];
    const internalPricingSite = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { guardsPaidByClient: true } });
    if (!internalPricingSite?.guardsPaidByClient && (data.clientRateSnapshot == null || data.guardWageSnapshot == null || data.brokerFeeSnapshot == null)) {
      const settlementBrokerId = (data.settlementBrokerId as string | null | undefined) ?? null;
      const brokerForPricing = settlementBrokerId
        ? await prisma.broker.findUnique({ where: { id: settlementBrokerId }, select: { kind: true } })
        : null;
      const internalPricing = await resolveShiftPricing({
        siteId: parsed.site_id,
        shiftTypeId: parsed.shift_type_id,
        shiftTypeCode: internalShiftType.code,
        shiftTypeBillingGroup: internalShiftType.billingGroup,
        settlementBrokerId,
        brokerKind: brokerForPricing?.kind ?? null,
        guardId: parsed.guard_id,
        workDate,
        isExternal: data.isExternal ?? false,
        recordType: (data.recordType ?? "shift") as ShiftPricingRecordType,
        // WP-BOSS5 §25.1：OT 卡＝每小時價。
        otHours: data.otHours != null ? Number(data.otHours) : null,
      });
      // journal 只歸因畀 resolver 真係填咗嗰幾欄（人手明確傳嘅值唔算 auto 卡）
      if (data.clientRateSnapshot == null) { data.clientRateSnapshot = internalPricing.clientRate; internalSource.clientCardId = internalPricing.source.clientCardId; }
      if (data.guardWageSnapshot == null || data.brokerFeeSnapshot == null) internalSource.payoutCardId = internalPricing.source.payoutCardId;
      if (data.guardWageSnapshot == null) data.guardWageSnapshot = internalPricing.guardWage;
      if (data.brokerFeeSnapshot == null) data.brokerFeeSnapshot = internalPricing.brokerFee;
    }

    await assertMonthNotLocked({ workDate, actorUserId: session.userId, tableName: "shift_records", rowId: "new", ip: getClientIp(req) });

    try {
      const created = await prisma.shiftRecord.create({ data: { ...data, source: data.source ?? MANUAL_SOURCE, createdBy: session.userId } }); // P18：單條新建寫 source=manual（同 batch 一致；caller 明確帶 source 先保留）
      await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
      await journalAutoCardUsesSafe([{ recordId: created.id, before: manualBefore, after: [toNum(created.clientRateSnapshot), toNum(created.guardWageSnapshot), toNum(created.brokerFeeSnapshot)], ...internalSource }]);
      return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(created)), 201);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("同一保安員、同一日、同一更別已經有記錄（硬性規則2）");
      }
      throw err;
    }
  });
}
