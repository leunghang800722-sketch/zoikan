// WP-MULTI（老闆 2026-09-19 拍板）：PATCH 改一行地址（地址本文／備註／
// 設做 primary）；DELETE 刪一行（更正打錯用，audit 留底）。
import { assertScopedGuard } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toGuardAddressDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardAddressUpdateSchema } from "@/lib/api/schemas";
import { setPrimaryGuardAddress, deleteGuardAddress, syncLegacyGuardContactColumns, lockGuardRowForContactWrite } from "@/lib/guards/contacts";
import { writeAudit } from "@/lib/audit";
import { NotFound, BadRequest } from "@/lib/api/errors";
import type { GuardAddress } from "@prisma/client";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id, addressId } = await params;
    await assertScopedGuard(session, id);

    const body = await readJson(req);
    const parsed = parseBody(GuardAddressUpdateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      // 鎖序一律「guard 行先、子表行後」（同 create／delete／setPrimary 一致，避免 deadlock 40P01）。
      await lockGuardRowForContactWrite(tx, id);
      const row = await tx.guardAddress.findFirst({ where: { id: addressId, guardId: id } });
      if (!row) throw NotFound("搵唔到呢個地址");

      const data: Record<string, unknown> = {};
      if (parsed.address !== undefined) data.address = parsed.address.trim();
      if (parsed.note !== undefined) data.note = parsed.note;

      let before: GuardAddress = row;
      let after: GuardAddress = row;
      let demoted: { before: GuardAddress; after: GuardAddress } | null = null;

      if (Object.keys(data).length > 0) {
        after = await tx.guardAddress.update({ where: { id: row.id }, data });
        before = row;
      }

      if (parsed.is_primary === true) {
        const primaryResult = await setPrimaryGuardAddress(tx, id, row.id);
        if (primaryResult) {
          after = primaryResult.after;
          demoted = primaryResult.demoted;
        }
      } else if (parsed.is_primary === false && row.isPrimary) {
        // 同 phones 一致——唔可以直接將主要地址設做非主要，要由另一個
        // 地址嚟接手（見 phones/[phoneId]/route.ts 同一段理由）。
        throw BadRequest("唔可以直接將主要地址設做非主要——請將另一個地址設做主要（會自動降級呢個）");
      }

      if (Object.keys(data).length > 0 || demoted) {
        await syncLegacyGuardContactColumns(tx, id, ["address"]);
      }
      return { before, after, demoted };
    });

    if (result.before !== result.after) {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_addresses", rowId: addressId, action: "update", before: result.before, after: result.after, ip: getClientIp(req) });
    }
    if (result.demoted) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_addresses",
        rowId: result.demoted.after.id,
        action: "update",
        before: result.demoted.before,
        after: result.demoted.after,
        ip: getClientIp(req),
      });
    }
    return ok(toGuardAddressDTO(result.after));
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員個人資料", "update");
    const { id, addressId } = await params;
    await assertScopedGuard(session, id);

    const result = await prisma.$transaction(async (tx) => {
      const deleted = await deleteGuardAddress(tx, id, addressId);
      if (!deleted) throw NotFound("搵唔到呢個地址");
      await syncLegacyGuardContactColumns(tx, id, ["address"]);
      return deleted;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guard_addresses", rowId: addressId, action: "delete", before: result.deleted, after: null, ip: getClientIp(req) });
    if (result.promoted) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_addresses",
        rowId: result.promoted.after.id,
        action: "update",
        before: result.promoted.before,
        after: result.promoted.after,
        ip: getClientIp(req),
      });
    }
    return ok(brandSafeResponse({ deleted: true, promoted: result.promoted ? toGuardAddressDTO(result.promoted.after) : null }));
  });
}
