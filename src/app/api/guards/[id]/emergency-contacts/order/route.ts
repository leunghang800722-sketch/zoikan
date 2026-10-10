// WP-MULTI（Opus 覆核必修 6）：`PUT /api/guards/:id/emergency-contacts/
// order`——一次過重寫成個 guard 全部緊急聯絡人嘅 `sort_order`。之前排序
// 淨係靠前端 `onMoveContact()` 分兩次 PATCH 相鄰兩行互換 `sort_order`
// （`src/app/(app)/guards/GuardsClient.tsx`）——兩次獨立 PATCH 中間有
// 短暫窗口冇原子性，而且拖到多過兩行要換位（例如排到最前/最後）要
// 一大串互換先做到。呢個端點一個 transaction 內按傳入嘅 `ids` 陣列順序
// 逐一寫 `sort_order`（0-based）＋同步 legacy 代表行（sort_order 最細
// 嗰個），前端 `onMoveContact()` 改用呢個端點（見 GuardsClient.tsx）。
import { assertScopedGuard } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toGuardEmergencyContactDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardEmergencyContactOrderSchema } from "@/lib/api/schemas";
import { reorderGuardEmergencyContacts, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { writeAudit } from "@/lib/audit";


export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id } = await params;
    await assertScopedGuard(session, id);

    const body = await readJson(req);
    const parsed = parseBody(GuardEmergencyContactOrderSchema, body);

    const before = await prisma.guardEmergencyContact.findMany({ where: { guardId: id }, orderBy: { sortOrder: "asc" } });

    const rows = await prisma.$transaction(async (tx) => {
      const updated = await reorderGuardEmergencyContacts(tx, id, parsed.ids);
      await syncLegacyGuardContactColumns(tx, id, ["emergency"]);
      return updated;
    });

    // 逐行 audit（同其他子資源 PATCH 一致，`before`/`after` 用嚟對比
    // 邊行真係 `sort_order` 改咗——`before` 喺 transaction 外面攞，
    // 純粹俾 audit 用，唔影響 transaction 本身嘅原子性）。
    const beforeById = new Map(before.map((r) => [r.id, r]));
    for (const after of rows) {
      const prevRow = beforeById.get(after.id);
      if (prevRow && prevRow.sortOrder !== after.sortOrder) {
        await writeAudit({
          actorUserId: session.userId,
          tableName: "guard_emergency_contacts",
          rowId: after.id,
          action: "update",
          before: prevRow,
          after,
          ip: getClientIp(req),
        });
      }
    }

    return ok(rows.map(toGuardEmergencyContactDTO));
  });
}
