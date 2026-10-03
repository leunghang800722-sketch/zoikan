// WP-MULTI（老闆 2026-09-19 拍板）：PATCH 改一行電話（號碼／label／
// 備註／設做 primary）；DELETE 刪一行（俾用戶自己更正打錯用，audit 留
// 底——「離職嘅人所有資料完整保留」，冇任何自動流程會觸發呢個 DELETE，
// 見 src/lib/guards/contacts.ts 頂註解）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toGuardPhoneDTO } from "@/lib/api/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardPhoneUpdateSchema } from "@/lib/api/schemas";
import { setPrimaryGuardPhone, deleteGuardPhone, syncLegacyGuardContactColumns, normalizeTel, isValidTel, lockGuardRowForContactWrite } from "@/lib/guards/contacts";
import { assertTelAvailable, rethrowIdentityConflict } from "@/lib/guards/identity";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden, Conflict, BadRequest } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { GuardPhone } from "@prisma/client";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; phoneId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以改電話");
    const { id, phoneId } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(GuardPhoneUpdateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      // 鎖序一律「guard 行先、子表行後」（同 create／delete／setPrimary 一致，避免 deadlock）。
      await lockGuardRowForContactWrite(tx, id);
      const row = await tx.guardPhone.findFirst({ where: { id: phoneId, guardId: id } });
      if (!row) throw NotFound("搵唔到呢個電話");

      const data: Record<string, unknown> = {};
      if (parsed.tel !== undefined && parsed.tel.trim() !== row.tel && normalizeTel(parsed.tel) !== normalizeTel(row.tel)) {
        const tel = normalizeTel(parsed.tel);
        if (!isValidTel(tel)) throw BadRequest("電話格式唔啱（正規化後要係 7-15 位數字，可以 + 開頭）");
        {
          const dup = await tx.guardPhone.findUnique({ where: { guardId_tel: { guardId: id, tel } } });
          if (dup) throw Conflict("呢個電話已經記錄咗（同一個保安員唔可以重複記錄同一個電話）");
          await assertTelAvailable(tx, tel, id); // WP-STAFF-IMPORT B1：全表唯一
          data.tel = tel;
        }
      }
      if (parsed.label !== undefined) data.label = parsed.label;
      if (parsed.note !== undefined) data.note = parsed.note;

      let before: GuardPhone = row;
      let after: GuardPhone = row;
      let demoted: { before: GuardPhone; after: GuardPhone } | null = null;

      if (Object.keys(data).length > 0) {
        after = await tx.guardPhone.update({ where: { id: row.id }, data });
        before = row;
      }

      if (parsed.is_primary === true) {
        const primaryResult = await setPrimaryGuardPhone(tx, id, row.id);
        if (primaryResult) {
          after = primaryResult.after;
          demoted = primaryResult.demoted;
        }
      } else if (parsed.is_primary === false && row.isPrimary) {
        // 唔可以直接將 primary 設做 false——「主要」一定要由另一行嚟
        // 接手（PATCH 嗰行 `is_primary:true`），冇呢個動作就冧走成個
        // guard 嘅 primary，`syncLegacyGuardContactColumns()` 會將
        // `guards.tel` 錯誤咁同步做 null（呢個人明明仲有電話記錄）。
        throw BadRequest("唔可以直接將主要電話設做非主要——請將另一個電話設做主要（會自動降級呢個）");
      }

      if (Object.keys(data).length > 0 || demoted) {
        await syncLegacyGuardContactColumns(tx, id, ["tel"]);
      }
      return { before, after, demoted };
    }).catch(rethrowIdentityConflict);

    if (result.before !== result.after) {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_phones", rowId: phoneId, action: "update", before: result.before, after: result.after, ip: getClientIp(req) });
    }
    if (result.demoted) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_phones",
        rowId: result.demoted.after.id,
        action: "update",
        before: result.demoted.before,
        after: result.demoted.after,
        ip: getClientIp(req),
      });
    }
    return ok(toGuardPhoneDTO(result.after));
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; phoneId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以刪電話");
    const { id, phoneId } = await params;
    const guardWhere = scopeGuardWhere(session, { id });
    const guard = await prisma.guard.findFirst({ where: guardWhere, select: { id: true } });
    if (!guard) throw NotFound();

    const result = await prisma.$transaction(async (tx) => {
      const deleted = await deleteGuardPhone(tx, id, phoneId);
      if (!deleted) throw NotFound("搵唔到呢個電話");
      await syncLegacyGuardContactColumns(tx, id, ["tel"]);
      return deleted;
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guard_phones", rowId: phoneId, action: "delete", before: result.deleted, after: null, ip: getClientIp(req) });
    if (result.promoted) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_phones",
        rowId: result.promoted.after.id,
        action: "update",
        before: result.promoted.before,
        after: result.promoted.after,
        ip: getClientIp(req),
      });
    }
    return ok(brandSafeResponse({ deleted: true, promoted: result.promoted ? toGuardPhoneDTO(result.promoted.after) : null }));
  });
}
