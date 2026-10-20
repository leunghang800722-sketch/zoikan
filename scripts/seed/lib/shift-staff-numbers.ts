// EMP-P1：seed 完成後為非作廢更次推導「用邊張工號卡」（同 API 寫入點共用 src/lib/shift-records/staff-number.ts 嘅推導規則：
// 更表檔工號（seed 冇）→ 長工 B07 嘅 MG 卡 → 盤 sites.staff_scheme）。純歸屬資訊，唔掂任何金額欄。
import type { PrismaClient } from "@prisma/client";
import { resolveShiftStaffNumbers, type ResolvedStaff } from "../../../src/lib/shift-records/staff-number";

export async function seedShiftStaffNumbers(prisma: PrismaClient): Promise<{ scanned: number; assigned: number; bySource: Record<string, number> }> {
  const out = { scanned: 0, assigned: 0, bySource: {} as Record<string, number> };
  const CHUNK = 2000;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.shiftRecord.findMany({
      where: { status: { not: "cancelled" }, staffNumberId: null },
      select: { id: true, guardId: true, siteId: true, workDate: true, settlementBrokerId: true },
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    out.scanned += rows.length;
    const resolved = await resolveShiftStaffNumbers(prisma, rows.map((r) => ({ key: r.id, guardId: r.guardId, siteId: r.siteId, workDate: r.workDate, settlementBrokerId: r.settlementBrokerId })));
    const groups = new Map<string, { staff: ResolvedStaff; ids: string[] }>();
    for (const [id, st] of resolved) {
      if (!st) continue;
      const k = `${st.staffNumberId}|${st.scheme}|${st.source}`;
      const g = groups.get(k) ?? { staff: st, ids: [] };
      g.ids.push(id);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      await prisma.shiftRecord.updateMany({ where: { id: { in: g.ids } }, data: { staffNumberId: g.staff.staffNumberId, staffScheme: g.staff.scheme, staffNumberSource: g.staff.source } });
      out.assigned += g.ids.length;
      out.bySource[g.staff.source] = (out.bySource[g.staff.source] ?? 0) + g.ids.length;
    }
  }
  return out;
}
