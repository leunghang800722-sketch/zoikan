// WP-MULTI（老闆 2026-09-19 拍板）：PATCH 改一行緊急聯絡人（姓名／電話／
// 關係／排序／備註）；DELETE 刪一行（更正打錯用，audit 留底）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere } from "@/lib/broker-isolation";
import { toGuardEmergencyContactDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardEmergencyContactUpdateSchema } from "@/lib/api/schemas";
import { updateGuardEmergencyContact, deleteGuardEmergencyContact, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id, contactId } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(GuardEmergencyContactUpdateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      const updated = await updateGuardEmergencyContact(tx, id, contactId, {
        name: parsed.name,
        tel: parsed.tel,
        relationship: parsed.relationship,
        sortOrder: parsed.sort_order,
        note: parsed.note,
      });
      if (!updated) throw NotFound("搵唔到呢個緊急聯絡人");
      if (updated.before !== updated.after) await syncLegacyGuardContactColumns(tx, id, ["emergency"]);
      return updated;
    });

    if (result.before !== result.after) {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_emergency_contacts", rowId: contactId, action: "update", before: result.before, after: result.after, ip: getClientIp(req) });
    }
    return ok(toGuardEmergencyContactDTO(result.after));
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id, contactId } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();

    const deleted = await prisma.$transaction(async (tx) => {
      const row = await deleteGuardEmergencyContact(tx, id, contactId);
      if (!row) throw NotFound("搵唔到呢個緊急聯絡人");
      await syncLegacyGuardContactColumns(tx, id, ["emergency"]);
      return row;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guard_emergency_contacts", rowId: contactId, action: "delete", before: deleted, after: null, ip: getClientIp(req) });
    return ok(brandSafeResponse({ deleted: true }));
  });
}
