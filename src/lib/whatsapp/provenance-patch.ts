// WA-9：喺已存在嘅 shift 記錄 provenance 補 reported_time_on/off（相片交叉核實／收工 caption）。
// 規矩：鎖月（month_closes.locked_at）嘅記錄**唔改**（跳過並計 locked）；每條實際更新寫一條 audit（只記 key 同記錄 id，唔記姓名）。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { isMonthLockedTx } from "@/lib/month-lock";
import { ensureSystemUser } from "@/lib/system-user";
import { isoToDbDate } from "./dates";

export type RecordSelector = { recordId: string } | { messageId: string; guardId: string; day: string };

export async function patchProvenanceUnlocked(sel: RecordSelector, patch: Record<string, string>): Promise<{ updated: number; locked: number }> {
  if (Object.keys(patch).length === 0) return { updated: 0, locked: 0 };
  const actor = await ensureSystemUser();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.shiftRecord.findMany({
      where:
        "recordId" in sel
          ? { id: sel.recordId }
          : { guardId: sel.guardId, workDate: isoToDbDate(sel.day), status: { not: "cancelled" }, recordType: "shift", provenance: { path: ["message_id"], equals: sel.messageId } },
      select: { id: true, workDate: true },
    });
    let updated = 0;
    let locked = 0;
    for (const r of rows) {
      if (await isMonthLockedTx(tx, r.workDate)) {
        locked += 1;
        continue;
      }
      // 只改 provenance（唔掂 updated_at——呢個係補充資料，唔算記錄被編輯）；jsonb 合併
      const json = JSON.stringify(patch);
      await tx.$executeRaw`UPDATE shift_records SET provenance = COALESCE(provenance, '{}'::jsonb) || ${json}::jsonb WHERE id::text = ${r.id}`;
      await writeAuditTx(tx, { actorUserId: actor, tableName: "shift_records", rowId: r.id, action: "whatsapp_provenance_patch", after: { keys: Object.keys(patch) } });
      updated += 1;
    }
    return { updated, locked };
  });
}
