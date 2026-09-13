import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import {
  scopeShiftRecordWhere,
  scrubForBrokerSession,
  isBrokerRole,
  requireOwnBrokerId,
  assertGuardOwnedByBroker,
  assertSiteAssignedToBroker,
} from "@/lib/broker-isolation";
import { toBrokerShiftRecordDTO, mapListForBroker } from "@/lib/broker-dto";
import { toShiftRecordFullDTO, toShiftRecordListDTO, toShiftRecordGridDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftRecordCreateSchema, BrokerShiftRecordCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict, NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

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
      prisma.shiftRecord.findMany({ where, skip, take, orderBy: { workDate: "desc" } }),
      prisma.shiftRecord.count({ where }),
    ]);
    if (isBrokerRole(session)) {
      return ok(scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerShiftRecordDTO)));
    }
    // M1：內部角色都經白名單 DTO（唔准 raw row 出街），再經 field-group gate
    // （主管出廠冇「收客價:view」就剝 client_rate_snapshot）。
    const dto = mapListDTO({ rows, total, skip, take }, gridView ? toShiftRecordGridDTO : includeProvenance ? toShiftRecordFullDTO : toShiftRecordListDTO);
    return ok(await applyFieldGroupGateToList(session, "shift_records", dto));
  });
}

async function assertShiftTypeBelongsToSite(shiftTypeId: string, siteId: string): Promise<void> {
  // S2：shift_type.site_id 一定要同傳入嘅 site_id 一致，否則 400（防止
  // 夾錯／夾撞另一個盤嘅更別）。
  const st = await prisma.shiftType.findUnique({ where: { id: shiftTypeId }, select: { siteId: true } });
  if (!st) throw BadRequest("shift_type_id 唔存在");
  if (st.siteId !== siteId) throw BadRequest("shift_type_id 唔屬於呢個 site_id");
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
      await assertShiftTypeBelongsToSite(parsedBroker.shift_type_id, parsedBroker.site_id);
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
      const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { requiresApproval: true } });
      data.status = broker.requiresApproval ? "pending_approval" : "confirmed";

      await assertMonthNotLocked({ workDate, actorUserId: session.userId, tableName: "shift_records", rowId: "new", ip: getClientIp(req) });

      try {
        const created = await prisma.shiftRecord.create({ data: { ...data, createdBy: session.userId } });
        await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
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
    await assertFieldGroupWritable(session, "shift_records", parsed);
    await assertShiftTypeBelongsToSite(parsed.shift_type_id, parsed.site_id);
    if (parsed.parent_shift_id) {
      const settlementBrokerId = parsed.settlement_broker_id ?? null;
      await assertParentShiftValid(parsed.parent_shift_id, session, parsed.guard_id, parsed.site_id, settlementBrokerId);
    }
    const data = snakeToCamelShallow(parsed) as Prisma.ShiftRecordUncheckedCreateInput;
    const workDate = parsed.work_date;

    await assertMonthNotLocked({ workDate, actorUserId: session.userId, tableName: "shift_records", rowId: "new", ip: getClientIp(req) });

    try {
      const created = await prisma.shiftRecord.create({ data: { ...data, createdBy: session.userId } });
      await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
      return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(created)), 201);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("同一保安員、同一日、同一更別已經有記錄（硬性規則2）");
      }
      throw err;
    }
  });
}
