// WP-STAFFNO（老闆 2026-09-19 拍板）：PATCH 改一行員工編號——status／
// valid_from／valid_to／note；打錯用 `number` 改（唔洗刪咗重加，同
// POST 一樣行 unique／prefix 檢查）。冇硬刪（設計明文「冇硬刪」）。
// 將 former 改返 current 要檢查 partial unique（同一個 guard 同一個
// scheme 唔可以有兩行 current）。
import { guardModule, assertScopedGuard } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, isInternalRole } from "@/lib/broker-isolation";
import { toGuardStaffNumberDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardStaffNumberUpdateSchema } from "@/lib/api/schemas";
import { normalizeStaffNumber, syncLegacyStaffNoColumns, assertNoStaffNumberPeriodOverlap } from "@/lib/guards/staff-numbers";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden, Conflict, BadRequest } from "@/lib/api/errors";
import type { GuardStaffNumber } from "@prisma/client";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; numberId: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    // WP-STAFFNO：同 POST 一致——「雞頭 session 只可以讀自己啲人，唔可
    // 以寫」係硬性規則，唔靠矩陣「自己保安員:update」出廠 off 呢個可開關
    // 嘅 cell（見 src/app/api/guards/[id]/staff-numbers/route.ts 同段
    // 註解）。
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以改員工編號");
    const { id, numberId } = await params;
    await assertScopedGuard(session, id);

    const body = await readJson(req);
    const parsed = parseBody(GuardStaffNumberUpdateSchema, body);

    const { before, after } = await prisma.$transaction(async (tx) => {
      const row = await tx.guardStaffNumber.findFirst({ where: { id: numberId, guardId: id } });
      if (!row) throw NotFound("搵唔到呢個員工編號");

      const data: Record<string, unknown> = {};

      if (parsed.number !== undefined) {
        const number = normalizeStaffNumber(parsed.number);
        // 必修 5（Opus 驗收第三輪）：同
        // `upsertCurrentStaffNumber()`（src/lib/guards/staff-numbers.ts）
        // 一致嘅修復——原本 `number.startsWith(row.scheme)` 會漏走
        // "ABCDE123" 呢類開頭連續字母多過 `row.scheme` 本身長度嘅輸入
        // （"ABCDE123".startsWith("ABCD") 都係 true），改做要求 `number`
        // 開頭連續大寫字母逐字等於 `row.scheme`。
        const numberLeadingLetters = number.match(/^[A-Z]+/)?.[0] ?? "";
        if (numberLeadingLetters !== row.scheme) {
          throw BadRequest(
            `number 開頭連續字母要同 scheme 逐字相等（scheme=${row.scheme}，number 讀到嘅開頭係「${numberLeadingLetters || "（冇字母前綴）"}」）：${number}`,
          );
        }
        if (number !== row.number) {
          const conflictingRow = await tx.guardStaffNumber.findUnique({ where: { number } });
          // M2b：同 upsertCurrentStaffNumber() 一致——淨係內部角色先見到
          // guard_id（呢度雞頭其實已經俾上面 isBrokerRole() 擋咗，呢層純
          // 粹 defense-in-depth，唔靠「上面擋咗就假設呢度安全」）。
          if (conflictingRow) throw Conflict("呢個工號已經有人用緊", isInternalRole(session) ? { guard_id: conflictingRow.guardId } : undefined);
          data.number = number;
        }
      }

      if (parsed.status !== undefined && parsed.status !== row.status) {
        if (parsed.status === "current") {
          const existingCurrent = await tx.guardStaffNumber.findFirst({
            where: { guardId: id, scheme: row.scheme, status: "current", NOT: { id: row.id } },
          });
          if (existingCurrent) {
            throw Conflict(
              `呢個保安員已經有一個現用嘅 ${row.scheme} 號（${existingCurrent.number}）——要先取消嗰個，先可以將呢個改返現用`,
            );
          }
        }
        data.status = parsed.status;
        // EMP-P1：結束一張卡（→former）必須有離職／停用日＋結束原因（呢度合併現值同今次輸入先驗）；
        // 改返現用就清走 valid_to／end_reason（predecessor 保留）。
        if (parsed.status === "current") {
          data.validTo = null;
          data.endReason = null;
        }
      }
      if (parsed.valid_from !== undefined) data.validFrom = parsed.valid_from;
      if (parsed.valid_to !== undefined && parsed.status !== "current") data.validTo = parsed.valid_to;
      if (parsed.end_reason !== undefined && parsed.status !== "current") data.endReason = parsed.end_reason;
      const nextStatus = (data.status as string | undefined) ?? row.status;
      const nextFrom = (data.validFrom !== undefined ? data.validFrom : row.validFrom) as Date | null;
      const nextTo = (data.validTo !== undefined ? data.validTo : row.validTo) as Date | null;
      const nextReason = (data.endReason !== undefined ? data.endReason : row.endReason) as string | null;
      const touchesEnd = data.status !== undefined || parsed.valid_to !== undefined || parsed.end_reason !== undefined;
      if (nextStatus === "former" && touchesEnd && (!nextTo || !nextReason)) {
        throw BadRequest("結束工號卡（改做已取消）必須同時填離職／停用日（valid_to）同結束原因（end_reason）");
      }
      if (nextStatus === "current" && nextReason) data.endReason = null;
      if (nextFrom && nextTo && nextFrom.getTime() > nextTo.getTime()) throw BadRequest("valid_from（入職日）唔可以遲過 valid_to（離職／停用日）");
      if (data.validFrom !== undefined || data.validTo !== undefined) {
        await assertNoStaffNumberPeriodOverlap(tx, { guardId: id, scheme: row.scheme, validFrom: nextFrom, validTo: nextTo, ignoreIds: [row.id] });
      }
      if (parsed.note !== undefined) data.note = parsed.note;

      if (Object.keys(data).length === 0) {
        return { before: row as GuardStaffNumber, after: row as GuardStaffNumber };
      }

      const updated = await tx.guardStaffNumber.update({ where: { id: row.id }, data });
      await syncLegacyStaffNoColumns(tx, id, { revealConflictGuardId: isInternalRole(session) });
      return { before: row as GuardStaffNumber, after: updated };
    });

    if (before !== after) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_staff_numbers",
        rowId: numberId,
        action: "update",
        before,
        after,
        ip: getClientIp(req),
      });
    }
    return ok(toGuardStaffNumberDTO(after));
  });
}
