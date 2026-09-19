// WP-MULTI（老闆 2026-09-19 拍板）：緊急聯絡人獨立子表——GET（`sort_
// order` 排序）／POST（新增一行，冇傳 `sort_order` 就自動排尾）。跟
// 「安員個人資料」module（唔用 module selector——雞頭／安員出廠都係
// `uniformRow(D)`，同「自己安員」冇關；主管跟現有規則 `row(O,…)`，見
// src/lib/rbac/matrix.ts）。呢個 module 本身已經令雞頭讀寫兩邊一致
// 403（同 GUARD_PII_FIELDS 保護 `guards.emergency_contact_*` 一致嘅
// module，唔需要額外硬擋）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere } from "@/lib/broker-isolation";
import { toGuardEmergencyContactDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardEmergencyContactCreateSchema } from "@/lib/api/schemas";
import { createGuardEmergencyContact, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where, select: { id: true } });
    if (!guard) throw NotFound();
    const rows = await prisma.guardEmergencyContact.findMany({ where: { guardId: id }, orderBy: { sortOrder: "asc" } });
    return ok(rows.map(toGuardEmergencyContactDTO));
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
    const parsed = parseBody(GuardEmergencyContactCreateSchema, body);

    const created = await prisma.$transaction(async (tx) => {
      const row = await createGuardEmergencyContact(tx, {
        guardId: id,
        name: parsed.name ?? null,
        tel: parsed.tel ?? null,
        relationship: parsed.relationship ?? null,
        sortOrder: parsed.sort_order,
        note: parsed.note ?? null,
        source: "manual",
        createdBy: session.userId,
      });
      await syncLegacyGuardContactColumns(tx, id, ["emergency"]);
      return row;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guard_emergency_contacts", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toGuardEmergencyContactDTO(created), 201);
  });
}
