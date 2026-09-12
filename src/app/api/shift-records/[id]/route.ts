import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeShiftRecordWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerShiftRecordDTO } from "@/lib/broker-dto";
import { toShiftRecordFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftRecordUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const { id } = await params;
    const where = scopeShiftRecordWhere(session, { id });
    const row = await prisma.shiftRecord.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerShiftRecordDTO(row)));
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 雞頭「更表:update」硬性 deny（C3），呢個 route 淨係內部角色行得到。
    const session = await requirePermission(req, "更表", "update");
    const { id } = await params;
    const where = scopeShiftRecordWhere(session, { id });
    const before = await prisma.shiftRecord.findFirst({ where });
    if (!before) throw NotFound();

    // 改更本身用舊 work_date 嘅月份判斷鎖定；如果 body 有帶新 work_date
    // 想搬去另一個月，兩個月份都要冚（防止靠改期避開鎖定，或者反過來
    // 寫入一個已鎖定嘅月）。
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "shift_records", rowId: id, ip: getClientIp(req) });

    const rawBody = await readJson(req);
    // S4：改用 parseBody(ShiftRecordUpdateSchema)——之前用 pickFields+
    // coerceDateFields，日期格式錯會一路衝到 Prisma 先爆 500；而家 zod
    // 喺呢度就 400。
    const parsed = parseBody(ShiftRecordUpdateSchema, rawBody);
    await assertFieldGroupWritable(session, "shift_records", parsed);

    if (parsed.shift_type_id) {
      const st = await prisma.shiftType.findUnique({ where: { id: parsed.shift_type_id }, select: { siteId: true } });
      if (!st) throw BadRequest("shift_type_id 唔存在");
      if (st.siteId !== before.siteId) throw BadRequest("shift_type_id 唔屬於呢條更次原本嘅 site");
    }

    if (parsed.work_date) {
      await assertMonthNotLocked({
        workDate: parsed.work_date,
        actorUserId: session.userId,
        tableName: "shift_records",
        rowId: id,
        ip: getClientIp(req),
      });
    }

    const data = snakeToCamelShallow(parsed) as Prisma.ShiftRecordUncheckedUpdateInput;
    const after = await prisma.shiftRecord.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(after)));
  });
}
