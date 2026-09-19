// WP-STAFFNO（老闆 2026-09-19 拍板）：員工編號獨立表（方案 B）——
// GET（current 先、former 後）／POST（新增一個 scheme 嘅新 current 號，
// 舊 current 自動轉 former）。跟 `src/app/api/guards/[id]/route.ts`
// 一致嘅 module selector 模式（內部角色「安員」，雞頭「自己安員」），
// 但寫（POST）額外硬性擋雞頭——「雞頭 session 只可以讀自己啲人
// （scopeGuardWhere），唔可以寫」係呢個子資源嘅絕對規則，唔靠矩陣個
// cell 出廠開關（`自己安員:update` 出廠 off 但老闆理論上可以開，開咗
// 唔應該連帶解鎖呢個新子資源）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, isBrokerRole, isInternalRole } from "@/lib/broker-isolation";
import { toGuardStaffNumberDTO } from "@/lib/api/dto";
import { toGuardStaffNumberBrokerDTO } from "@/lib/broker-dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardStaffNumberCreateSchema } from "@/lib/api/schemas";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns, writeStaffNumberAudits } from "@/lib/guards/staff-numbers";
import { NotFound, Forbidden } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where, select: { id: true } });
    if (!guard) throw NotFound();
    const rows = await prisma.guardStaffNumber.findMany({ where: { guardId: id }, orderBy: { createdAt: "desc" } });
    // current 先、former 後（同一組 status 入面按新到舊）。
    const current = rows.filter((r) => r.status === "current");
    const former = rows.filter((r) => r.status === "former");
    // S6（Opus 驗收）：雞頭讀呢個 sub-resource 用窄版 DTO——`id／scheme／
    // number／status／valid_from／valid_to`，冇 note（可能有內部備註文
    // 字）／source／created_by（內部用戶 id）。內部角色（老闆/主管/會計）
    // 先見全欄。
    const mapper = isBrokerRole(session) ? toGuardStaffNumberBrokerDTO : toGuardStaffNumberDTO;
    return ok([...current, ...former].map(mapper));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以新增員工編號");
    const { id } = await params;
    const guard = await prisma.guard.findUnique({ where: { id }, select: { id: true } });
    if (!guard) throw NotFound();
    const body = await readJson(req);
    const parsed = parseBody(GuardStaffNumberCreateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      const upserted = await upsertCurrentStaffNumber(tx, {
        guardId: id,
        scheme: parsed.scheme,
        number: parsed.number,
        validFrom: parsed.valid_from ?? null,
        note: parsed.note ?? null,
        source: "manual",
        createdBy: session.userId,
        revealConflictGuardId: isInternalRole(session),
      });
      await syncLegacyStaffNoColumns(tx, id, { revealConflictGuardId: isInternalRole(session) });
      return upserted;
    });

    await writeStaffNumberAudits(session.userId, [result], getClientIp(req));

    // 「同 scheme 已有 current → 舊嗰行自動轉 former」要喺回應講明
    // （設計文件明文要求），前端 GuardsClient.tsx 靠 `converted_former`
    // 決定顯唔顯示提示。
    return ok(
      brandSafeResponse({
        ...toGuardStaffNumberDTO(result.created),
        convertedFormer: result.convertedFormer ? toGuardStaffNumberDTO(result.convertedFormer.after) : null,
      }),
      201,
    );
  });
}
