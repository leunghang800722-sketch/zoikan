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

/** 改體系後重推導會清走嘅「自動推導」歸屬來源（手動／payload／roster_file／longterm 唔郁）。 */
const AUTO_SOURCES = ["site_scheme", "backfill:range", "backfill:sole"] as const;

export interface ReinferResult extends SiteBackfillResult {
  /** 未鎖月被清走歸屬嘅更次數 */
  cleared: number;
  /** 已鎖月、歸屬來源係自動推導但**冇郁**嘅更次數（shift_records 本身 + 側表）——要人手處理 */
  locked_kept: number;
}

/**
 * SITE-SCHEME-1.1：盤改咗 staff_scheme → 對該盤 `staff_number_source IN (site_scheme, backfill:range, backfill:sole)` 且**未鎖月**嘅更次
 * 清走歸屬（三欄 NULL，raw SQL，唔掂金額、唔觸發 updated_at）再按新體系重推；已鎖月（shift_records 同側表）唔郁，回 `locked_kept` 俾 caller 出提示。
 */
export async function reinferSiteStaffNumbers(siteId: string): Promise<ReinferResult> {
  const cleared = await prisma.$executeRaw(
    Prisma.sql`UPDATE shift_records SET staff_number_id = NULL, staff_scheme = NULL, staff_number_source = NULL
      WHERE site_id = ${siteId} AND staff_number_source IN (${Prisma.join([...AUTO_SOURCES])})
        AND NOT EXISTS (SELECT 1 FROM month_closes mc WHERE mc.month = date_trunc('month', shift_records.work_date)::date AND mc.locked_at IS NOT NULL)`,
  );
  const lk = await prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
    SELECT (
      (SELECT COUNT(*) FROM shift_records sr WHERE sr.site_id = ${siteId} AND sr.staff_number_source IN (${Prisma.join([...AUTO_SOURCES])})
         AND EXISTS (SELECT 1 FROM month_closes mc WHERE mc.month = date_trunc('month', sr.work_date)::date AND mc.locked_at IS NOT NULL))
      +
      (SELECT COUNT(*) FROM shift_record_staff_attributions a JOIN shift_records sr ON sr.id = a.shift_record_id
        WHERE sr.site_id = ${siteId} AND a.source IN ('backfill:range', 'backfill:sole'))
    ) AS n`);
  const bf = await backfillSiteStaffNumbers([siteId]);
  return { ...bf, cleared, locked_kept: Number(lk[0]?.n ?? 0) };
}
