// 請假格要揀一個 shift_type（shift_records 唯一鍵含更種）：用該保安員喺該盤最近用過嘅更種，冇就該盤第一個（按代號）更種。
// W2 Triage 答題同 W3 自動寫入共用（server-only）。
import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/db";

type Db = Prisma.TransactionClient | typeof prisma;

export async function leaveRowShiftType(db: Db, siteId: string, guardId: string): Promise<string | null> {
  const last = await db.shiftRecord.findFirst({ where: { guardId, siteId, status: { not: "cancelled" }, recordType: "shift", shiftType: { voidedAt: null, code: { not: "PR" } } }, orderBy: { workDate: "desc" }, select: { shiftTypeId: true } });
  if (last) return last.shiftTypeId;
  const first = await db.shiftType.findFirst({ where: { siteId, voidedAt: null, code: { not: "PR" } }, orderBy: [{ code: "asc" }, { id: "asc" }], select: { id: true } });
  return first?.id ?? null;
}
