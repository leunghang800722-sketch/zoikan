import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO, mapListForBroker } from "@/lib/broker-dto";
import { toGuardFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError , okGzip } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { maskHkidForList } from "@/lib/api/guard-pii";
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
//
// M1（Opus 驗收修復）：舊版 regex `^\d{4}-\d{2}$` 會接受「2026-13」
// 「2026-00」呢類結構啱但月份唔存在嘅字串——之後 `new Date("2026-13-01T…")`
// 拎到 Invalid Date，落到 Prisma `groupBy()` 嘅 `workDate` range query
// 就 500。收緊做 `^\d{4}-(0[1-9]|1[0-2])$`（MM 一定要 01-12），並且
// 「傳咗但格式唔啱」同其他 route（referral-fee-rates／quotas／
// broker-site-assignments 嗰堆）一致，一律 400 BadRequest，唔再靜靜哋
// 當冇傳處理。
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// WP-PII：`?expiring_within_days=90`——篩牌照（sia_permit_expiry）或平安卡
// （safety_card_expiry）90 日內（含已過期）到期嘅保安員，俾列表頁「牌照
// 90 日內到期」FilterChip 用。非負整數，格式唔啱一律 400（同上面
// MONTH_RE 一致嘅口徑）。
const NON_NEGATIVE_INT_RE = /^\d+$/;

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

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    const withMonthShiftsParam = url.searchParams.get("with_month_shifts");
    if (withMonthShiftsParam && !MONTH_RE.test(withMonthShiftsParam)) {
      throw BadRequest("with_month_shifts 格式唔啱（要 YYYY-MM，MM 係 01-12）");
    }
    const expiringWithinDaysParam = url.searchParams.get("expiring_within_days");
    if (expiringWithinDaysParam !== null && !NON_NEGATIVE_INT_RE.test(expiringWithinDaysParam)) {
      throw BadRequest("expiring_within_days 格式唔啱（要非負整數）");
    }
    let where: Prisma.GuardWhereInput = includeInactive ? {} : { status: "active" };
    if (expiringWithinDaysParam !== null) {
      const cutoff = new Date(Date.now() + Number(expiringWithinDaysParam) * 86_400_000);
      where = { ...where, OR: [{ siaPermitExpiry: { lte: cutoff } }, { safetyCardExpiry: { lte: cutoff } }] };
    }
    where = scopeGuardWhere(session, where);
    const [rows, total] = await Promise.all([
      prisma.guard.findMany({ where, skip, take, orderBy: { createdAt: "asc" } }),
      prisma.guard.count({ where }),
    ]);
    // S4（Opus 驗收修復）：monthShiftCount 而家喺 DTO／field-group gate
    // **之前**就 merge 落 raw `rows`（`GUARD_FIELDS`／`GUARD_BROKER_FIELDS`
    // 白名單已經加咗 `monthShiftCount`，見 src/lib/api/dto/index.ts、
    // src/lib/broker-dto.ts）——行返 `pickWhitelist()` 正常嘅白名單路
    // 徑，唔再靠「喺 gate 之後先手動加返」嗰種繞過白名單機制嘅寫法（嗰
    // 種寫法一旦第二個欄都想咁做，個白名單就形同虛設）。`rows` 冇呢個
    // key 嘅時候（冇傳 `with_month_shifts`）`pickWhitelist()` 嘅
    // `hasOwnProperty` 檢查會自然跳過，同以前「乜都唔加」行為一致。
    const monthShiftCounts = withMonthShiftsParam
      ? await loadMonthShiftCounts(rows.map((r) => r.id), withMonthShiftsParam)
      : null;
    const rowsWithCount = monthShiftCounts
      ? rows.map((r) => ({ ...r, monthShiftCount: monthShiftCounts[r.id] ?? 0 }))
      : rows;
    if (isBrokerRole(session)) {
      const list = scrubForBrokerSession(
        session,
        mapListForBroker({ rows: rowsWithCount, total, skip, take }, toBrokerGuardDTO),
      );
      return okGzip(req, list);
    }
    const dto = mapListDTO({ rows: rowsWithCount, total, skip, take }, toGuardFullDTO);
    const gated = await applyFieldGroupGateToList(session, "guards", dto);
    // WP-PII：列表身份證一律遮罩（老闆/會計有「安員個人資料:view」都係
    // 遮）——詳情/編輯（GET /api/guards/[id]、PATCH 之後 response）先畀
    // 睇全號，見 src/app/api/guards/[id]/route.ts。
    const masked = brandSafeResponse({ ...gated, rows: maskHkidForList(gated.rows) });
    return okGzip(req, masked);
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
