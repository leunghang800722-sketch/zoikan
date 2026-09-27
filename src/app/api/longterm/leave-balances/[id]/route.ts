// WP-LTPAY §21 任務 5b：`PATCH /api/longterm/leave-balances/:id`——人手
// 覆核／更正 AL／SL 結餘（audit 留低邊個幾時改過）。`asOfMonth`／
// `*TakenOpening` 呢兩組唔喺呢個 endpoint 開放改（`recomputeLongtermPayroll()`
// 冪等寫回機制專用，人手亂改會令下次重算嘅「opening」基數錯，見
// aggregate.ts §21 任務 4b(f) 大註解）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toGuardLeaveBalanceDTO } from "@/lib/longterm-payroll/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardLeaveBalanceUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { id } = await params;
    const before = await prisma.guardLeaveBalance.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(GuardLeaveBalanceUpdateSchema, body);
    const data = snakeToCamelShallow(parsed) as Prisma.GuardLeaveBalanceUncheckedUpdateInput;
    // Opus 5.5 驗收修正：人手改「已放」＝設定開波數。原本淨係改 alTaken／
    // slTaken，但同月重算讀嘅係 `*_opening`（asOfMonth＝嗰個月），人手改完
    // 一重算就被覆蓋、白改。而家同時寫 opening、清 asOfMonth，下次重算
    // 由呢個數起計。
    if (parsed.al_taken !== undefined || parsed.sl_taken !== undefined) {
      data.asOfMonth = null;
      if (parsed.al_taken !== undefined) data.alTakenOpening = parsed.al_taken;
      if (parsed.sl_taken !== undefined) data.slTakenOpening = parsed.sl_taken;
    }
    const after = await prisma.guardLeaveBalance.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_leave_balances", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(toGuardLeaveBalanceDTO(after));
  });
}
