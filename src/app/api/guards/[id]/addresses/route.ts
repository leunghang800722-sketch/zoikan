// WP-MULTI（老闆 2026-09-19 拍板，規劃師延伸同一原則）：地址獨立子表——
// GET（primary 先）／POST（新增一行；第一行自動變 primary，之後跟
// `is_primary`，原 primary 自動降級）。跟「保安員個人資料」module（同
// `guards.address` 舊欄一致層級，雞頭出廠 `uniformRow(D)`，唔需要額外
// 硬擋）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere } from "@/lib/broker-isolation";
import { toGuardAddressDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardAddressCreateSchema } from "@/lib/api/schemas";
import { createGuardAddress, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where, select: { id: true } });
    if (!guard) throw NotFound();
    const rows = await prisma.guardAddress.findMany({ where: { guardId: id }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] });
    return ok(rows.map(toGuardAddressDTO));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();
    const body = await readJson(req);
    const parsed = parseBody(GuardAddressCreateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      const created = await createGuardAddress(tx, {
        guardId: id,
        address: parsed.address,
        isPrimary: parsed.is_primary,
        note: parsed.note ?? null,
        source: "manual",
        createdBy: session.userId,
      });
      await syncLegacyGuardContactColumns(tx, id, ["address"]);
      return created;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guard_addresses", rowId: result.created.id, action: "create", after: result.created, ip: getClientIp(req) });
    if (result.demotedPrimary) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_addresses",
        rowId: result.demotedPrimary.after.id,
        action: "update",
        before: result.demotedPrimary.before,
        after: result.demotedPrimary.after,
        ip: getClientIp(req),
      });
    }

    return ok(
      brandSafeResponse({
        ...toGuardAddressDTO(result.created),
        demotedPrimary: result.demotedPrimary ? toGuardAddressDTO(result.demotedPrimary.after) : null,
      }),
      201,
    );
  });
}
