// SITE-SCHEME-1：盤剛設咗 staff_scheme 之後，即刻對該批盤嘅更次補推導工號歸屬——重用 EMP-P1 `resolveShiftStaffOutcomes`
// 「盤 scheme＋期間」規則（range／sole），**只填 staff_number_id IS NULL 而且冇側表歸屬嘅更次**。
// 未鎖月：直接寫 shift_records 三個歸屬欄（raw SQL，唔觸發 updated_at、唔掂金額欄，UPDATE 帶 NOT EXISTS 鎖月檢查）；已鎖月：寫 shift_record_staff_attributions 側表。
// 冪等（已有歸屬唔再處理）。只處理 shift／ot（同 EMP-P1 回填一致）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveShiftStaffOutcomes, type ShiftStaffItem } from "./staff-number";

const CHUNK = 2000;
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export interface SiteBackfillResult {
  scanned: number;
  /** 實際寫入（未鎖月直接寫＋已鎖月側表） */
  backfilled: number;
  written_direct: number;
  written_side_table: number;
  unresolved: number;
}

export async function backfillSiteStaffNumbers(siteIds: readonly string[]): Promise<SiteBackfillResult> {
  const res: SiteBackfillResult = { scanned: 0, backfilled: 0, written_direct: 0, written_side_table: 0, unresolved: 0 };
  if (siteIds.length === 0) return res;
  const closes = await prisma.monthClose.findMany({ select: { month: true, lockedAt: true } });
  const lockedMonths = new Set(closes.filter((c) => !!c.lockedAt).map((c) => monthKey(c.month)));
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.shiftRecord.findMany({
      // keyset 分頁（id > cursor）：寫入之後該行唔再符合條件，Prisma cursor+skip 會漏
      where: { siteId: { in: [...siteIds] }, recordType: { in: ["shift", "ot"] }, status: { not: "cancelled" }, staffNumberId: null, staffAttribution: { is: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, guardId: true, siteId: true, workDate: true, settlementBrokerId: true, provenance: true },
      orderBy: { id: "asc" },
      take: CHUNK,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const items: ShiftStaffItem[] = rows.map((r) => {
      const prov = (r.provenance ?? {}) as Record<string, unknown>;
      return { key: r.id, guardId: r.guardId, siteId: r.siteId, workDate: r.workDate, settlementBrokerId: r.settlementBrokerId, rosterRowId: typeof prov.row_id === "string" ? prov.row_id : null };
    });
    const outcomes = await resolveShiftStaffOutcomes(prisma, items);
    const groups = new Map<string, { staffNumberId: string; scheme: string; source: string; locked: boolean; ids: string[] }>();
    for (const r of rows) {
      res.scanned += 1;
      const o = outcomes.get(r.id)!;
      if (!o.card || o.method === "ambiguous" || o.method === "unresolved" || o.method === "payload") {
        res.unresolved += 1;
        continue;
      }
      const locked = lockedMonths.has(monthKey(r.workDate));
      const source = `backfill:${o.method}`;
      const k = `${locked}|${o.card.id}|${source}`;
      const g = groups.get(k) ?? { staffNumberId: o.card.id, scheme: o.card.scheme, source, locked, ids: [] };
      g.ids.push(r.id);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      if (g.locked) {
        const c = await prisma.shiftRecordStaffAttribution.createMany({ data: g.ids.map((id) => ({ shiftRecordId: id, staffNumberId: g.staffNumberId, staffScheme: g.scheme, source: g.source })), skipDuplicates: true });
        res.written_side_table += c.count;
      } else {
        const n = await prisma.$executeRaw(
          Prisma.sql`UPDATE shift_records SET staff_number_id = ${g.staffNumberId}, staff_scheme = ${g.scheme}, staff_number_source = ${g.source}
            WHERE id = ANY(${g.ids}::text[]) AND staff_number_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM month_closes mc WHERE mc.month = date_trunc('month', shift_records.work_date)::date AND mc.locked_at IS NOT NULL)`,
        );
        res.written_direct += n;
      }
    }
  }
  res.backfilled = res.written_direct + res.written_side_table;
  return res;
}
