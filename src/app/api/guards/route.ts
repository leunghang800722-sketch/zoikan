import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO, mapListForBroker } from "@/lib/broker-dto";
import { toGuardFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError , okGzip } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { brandSafeResponse, type Dto } from "@/lib/api/serialize";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Prisma } from "@prisma/client";

// C3：雞頭睇/管自己安員用「自己安員」module（§6.2「自己安員名冊管理」），
// 內部角色（老闆/主管/會計）睇全公司安員用「安員」module——同一個
// route，依 session 嘅 base_role 動態揀 module（見
// src/lib/rbac/requirePermission.ts 嘅 ModuleSelector）。
function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

// P2-A：加「本月更數」欄（README §08）用嘅 additive、唯讀 query
// 參數——`?with_month_shifts=YYYY-MM` 先計，唔傳就同以前一樣乜都唔加。
// 計法：嗰個月 `record_type=shift` 且非 cancelled 嘅 shift_records 逐
// guard 分組計數（同 shift-records route 預設 `status: { not: "cancelled" }`
// 口徑一致）。全部經 `rows`（已經由 `scopeGuardWhere()` 做咗雞頭隔離）
// 揀出嚟嘅 guardId 先計，唔會漏隔離揭露第二個雞頭嘅安員。
const MONTH_RE = /^\d{4}-\d{2}$/;

async function loadMonthShiftCounts(guardIds: string[], month: string): Promise<Record<string, number>> {
  if (guardIds.length === 0) return {};
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const counts = await prisma.shiftRecord.groupBy({
    by: ["guardId"],
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: start, lt: end } },
    _count: { _all: true },
  });
  return Object.fromEntries(counts.map((c) => [c.guardId, c._count._all]));
}

/** 每行加返 `monthShiftCount`（camelCase——`okGzip()` 出街前會經
 * `camelToSnakeDeep()` 轉做 `month_shift_count`）。呢個唔係
 * `pickWhitelist()` 白名單入面嘅欄，要喺 DTO／field-group gate 之後先
 * 加，否則會被白名單剝走。 */
function withMonthShiftCounts(
  list: Dto<{ rows: Dto[]; total: number; skip: number; take: number }>,
  counts: Record<string, number>,
): Dto<{ rows: Dto[]; total: number; skip: number; take: number }> {
  const rows = list.rows.map((r) => brandSafeResponse({ ...r, monthShiftCount: counts[String(r.id)] ?? 0 }));
  return brandSafeResponse({ ...list, rows });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    const withMonthShiftsParam = url.searchParams.get("with_month_shifts");
    const monthShiftsMonth = withMonthShiftsParam && MONTH_RE.test(withMonthShiftsParam) ? withMonthShiftsParam : null;
    let where: Prisma.GuardWhereInput = includeInactive ? {} : { status: "active" };
    where = scopeGuardWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.guard.findMany({ where, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.guard.count({ where }),
    ]);
    const monthShiftCounts = monthShiftsMonth ? await loadMonthShiftCounts(rows.map((r) => r.id), monthShiftsMonth) : null;
    if (isBrokerRole(session)) {
      const list = scrubForBrokerSession(session, mapListForBroker({ rows, total, skip, take }, toBrokerGuardDTO));
      return okGzip(req, monthShiftCounts ? withMonthShiftCounts(list, monthShiftCounts) : list);
    }
    const dto = mapListDTO({ rows, total, skip, take }, toGuardFullDTO);
    const gated = await applyFieldGroupGateToList(session, "guards", dto);
    return okGzip(req, monthShiftCounts ? withMonthShiftCounts(gated, monthShiftCounts) : gated);
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "create");
    const body = await readJson(req);
    const parsed = parseBody(GuardCreateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.GuardUncheckedCreateInput;
    // 雞頭建安員：強制掛喺自己個 broker 底下（唔准幫其他雞頭/自己揀第二個 broker）
    if (isBrokerRole(session)) data.defaultBrokerId = session.brokerId;
    const created = await prisma.guard.create({ data: { ...data, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(created)), 201);
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(created)), 201);
  });
}
