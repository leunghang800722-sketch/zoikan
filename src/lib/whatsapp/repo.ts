// W1：ResolveRepo 嘅 Prisma 實作（server-only；每條訊息起一個，內建小 cache）。
import { prisma } from "@/lib/db";
import { isMonthLocked } from "@/lib/month-lock";
import { isoToDbDate, monthStartOf } from "./dates";
import type { ExistingRecord, ResolveRepo, ShiftTypeLite } from "./resolve";

/** @param excludeIds 將會喺同一 tx 被取消嘅舊 revision 待批記錄（resolve 時當佢哋唔存在，唔當「已存在」／額滿）。 */
export function createPrismaResolveRepo(excludeIds: readonly string[] = []): ResolveRepo {
  const ex = excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : {};
  const typeCache = new Map<string, ShiftTypeLite[]>();
  const existingCache = new Map<string, ExistingRecord[]>();
  const lockCache = new Map<string, boolean>();
  return {
    async shiftTypes(siteId) {
      const hit = typeCache.get(siteId);
      if (hit) return hit;
      const rows = await prisma.shiftType.findMany({ where: { siteId, voidedAt: null }, select: { id: true, siteId: true, code: true, label: true, startTime: true }, orderBy: [{ code: "asc" }, { id: "asc" }] });
      const out = rows.map((r) => ({ id: r.id, siteId: r.siteId, code: r.code, label: r.label, startHour: r.startTime ? r.startTime.getUTCHours() : null, startMinute: r.startTime ? r.startTime.getUTCMinutes() : null }));
      typeCache.set(siteId, out);
      return out;
    },
    async recentGuardIdsAtSite(siteId, sinceIso) {
      const rows = await prisma.shiftRecord.groupBy({ by: ["guardId"], where: { siteId, workDate: { gte: isoToDbDate(sinceIso) }, status: { not: "cancelled" }, recordType: "shift" } });
      return new Set(rows.map((r) => r.guardId));
    },
    async recentGuardIdsOfBroker(brokerId, sinceIso) {
      const rows = await prisma.shiftRecord.groupBy({ by: ["guardId"], where: { settlementBrokerId: brokerId, workDate: { gte: isoToDbDate(sinceIso) }, status: { not: "cancelled" }, recordType: "shift" } });
      return new Set(rows.map((r) => r.guardId));
    },
    async existing(guardId, dateIso) {
      const key = `${guardId}|${dateIso}`;
      const hit = existingCache.get(key);
      if (hit) return hit;
      const rows = await prisma.shiftRecord.findMany({ where: { guardId, workDate: isoToDbDate(dateIso), status: { not: "cancelled" }, ...ex }, select: { id: true, siteId: true, shiftTypeId: true, recordType: true, leaveCode: true, status: true } });
      const out: ExistingRecord[] = rows.map((r) => ({ id: r.id, siteId: r.siteId, shiftTypeId: r.shiftTypeId, recordType: r.recordType, leaveCode: r.leaveCode, status: r.status }));
      existingCache.set(key, out);
      return out;
    },
    async headcount(siteId, shiftTypeId, dateIso) {
      const date = isoToDbDate(dateIso);
      const [dr, st, current] = await Promise.all([
        prisma.dailyRequirement.findUnique({ where: { siteId_shiftTypeId_workDate: { siteId, shiftTypeId, workDate: date } }, select: { headcountRequired: true, voidedAt: true } }),
        prisma.shiftType.findUnique({ where: { id: shiftTypeId }, select: { headcountRequired: true } }),
        prisma.shiftRecord.count({ where: { siteId, shiftTypeId, workDate: date, recordType: "shift", status: { not: "cancelled" }, ...ex } }),
      ]);
      const required = dr && !dr.voidedAt ? dr.headcountRequired : (st?.headcountRequired ?? null);
      return { required, current };
    },
    async quota(guardId, siteId, shiftTypeId, dateIso) {
      const g = await prisma.guard.findUnique({ where: { id: guardId }, select: { defaultBrokerId: true } });
      if (!g?.defaultBrokerId) return null;
      const month = monthStartOf(dateIso);
      const q = await prisma.quota.findUnique({ where: { month_siteId_shiftTypeId_brokerId: { month, siteId, shiftTypeId, brokerId: g.defaultBrokerId } }, select: { targetShifts: true, voidedAt: true } });
      if (!q || q.voidedAt) return null;
      const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
      const actual = await prisma.shiftRecord.count({ where: { siteId, shiftTypeId, settlementBrokerId: g.defaultBrokerId, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: month, lt: next }, ...ex } });
      return { target: q.targetShifts, actual };
    },
    async monthLocked(dateIso) {
      const k = dateIso.slice(0, 7);
      const hit = lockCache.get(k);
      if (hit !== undefined) return hit;
      const v = await isMonthLocked(isoToDbDate(dateIso));
      lockCache.set(k, v);
      return v;
    },
  };
}
