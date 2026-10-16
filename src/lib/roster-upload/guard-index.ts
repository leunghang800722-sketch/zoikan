// 由 DB 一次過查晒起 `GuardMatchIndex`（roster-upload service 同 WhatsApp 解析共用）。
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildGuardMatchIndex, type GuardMatchIndex } from "./match";

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadGuardMatchIndex(db: Db): Promise<GuardMatchIndex> {
  const [guardsRaw, staffNumbersRaw, phonesRaw, matchOverridesRaw] = await Promise.all([
    db.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true, nameAliases: true } }),
    db.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true } }),
    db.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    db.guardMatchOverride.findMany({ where: { voidedAt: null }, select: { staffNo: true, nameRaw: true, guardId: true } }),
  ]);
  return buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw, matchOverrides: matchOverridesRaw });
}
