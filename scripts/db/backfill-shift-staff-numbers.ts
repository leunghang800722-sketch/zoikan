// EMP-P1：回填舊更次「用邊張工號卡」（shift_records.staff_number_id／staff_scheme／staff_number_source）。
//
//   npx tsx scripts/db/backfill-shift-staff-numbers.ts                 # dry-run（預設）：只印逐月逐類計數，唔寫
//   npx tsx scripts/db/backfill-shift-staff-numbers.ts --apply         # 真係寫
//   npx tsx scripts/db/backfill-shift-staff-numbers.ts --month 2026-08 # 只做某月（可重複）
//
// 規則同 API 寫入點一致（src/lib/shift-records/staff-number.ts 第 2–4 步，次序：上載證據 → 長工 B07 嘅 MG 卡 → 盤 staff_scheme＋期間）：
//   roster_file：provenance.row_id 指去嘅更表上載行，其 staff_no_raw 對中該 guard 嘅任何一張卡
//   longterm   ：結算單位係 internal_longterm（B07）→ 該 guard 嘅 MG 卡
//   range      ：盤 scheme 嘅卡，workDate 落喺（有日期）卡嘅期間內，剛好一張
//   sole       ：盤 scheme 只得一張卡而且冇日期
//   ambiguous／unresolved：唔寫（人手處理）
// 未鎖月：直接寫 shift_records 三個新欄（source 加 backfill: 前綴；唔掂 updated_at、唔掂任何金額欄）。
// 已鎖月：shift_records 一欄都唔寫，歸屬寫入 shift_record_staff_attributions 側表（一更最多一行）。
// 冪等：只處理未有歸屬嘅非作廢更次。每次執行寫一條 audit summary（唔逐條）。只係歸屬，任何金額欄唔准掂。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/db";
import { writeAudit } from "../../src/lib/audit";
import { resolveShiftStaffOutcomes, type ShiftStaffItem } from "../../src/lib/shift-records/staff-number";

export interface BackfillMonthStats {
  month: string;
  locked: boolean;
  scanned: number;
  roster_file: number;
  longterm: number;
  range: number;
  sole: number;
  unresolved: number;
  ambiguous: number;
  written: number;
}

export interface BackfillResult {
  apply: boolean;
  months: BackfillMonthStats[];
}

const CHUNK = 2000;
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export async function backfillShiftStaffNumbers(
  opts: { apply: boolean; months?: readonly string[]; chunkSize?: number; /** 測試用：每批處理完之後 call（用嚟模擬跑緊期間有人鎖月） */ afterBatch?: (batchIndex: number) => Promise<void> } = { apply: false },
): Promise<BackfillResult> {
  const closes = await prisma.monthClose.findMany({ select: { month: true, lockedAt: true } });
  const lockedMonths = new Set(closes.filter((c) => !!c.lockedAt).map((c) => monthKey(c.month)));
  const filter = opts.months?.length ? new Set(opts.months) : null;
  const stats = new Map<string, BackfillMonthStats>();
  const statOf = (m: string): BackfillMonthStats => {
    let s = stats.get(m);
    if (!s) {
      s = { month: m, locked: lockedMonths.has(m), scanned: 0, roster_file: 0, longterm: 0, range: 0, sole: 0, unresolved: 0, ambiguous: 0, written: 0 };
      stats.set(m, s);
    }
    return s;
  };

  let cursor: string | undefined;
  let batchIndex = 0;
  for (;;) {
    const rows = await prisma.shiftRecord.findMany({
      // keyset 分頁（id > cursor）：寫入之後該行唔再符合條件，用 Prisma cursor+skip 會漏一條
      where: { status: { not: "cancelled" }, staffNumberId: null, staffAttribution: { is: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, guardId: true, siteId: true, workDate: true, settlementBrokerId: true, provenance: true },
      orderBy: { id: "asc" },
      take: opts.chunkSize ?? CHUNK,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const todo = rows.filter((r) => !filter || filter.has(monthKey(r.workDate)));
    const items: ShiftStaffItem[] = todo.map((r) => {
      const prov = (r.provenance ?? {}) as Record<string, unknown>;
      return { key: r.id, guardId: r.guardId, siteId: r.siteId, workDate: r.workDate, settlementBrokerId: r.settlementBrokerId, rosterRowId: typeof prov.row_id === "string" ? prov.row_id : null };
    });
    const outcomes = await resolveShiftStaffOutcomes(prisma, items);
    const writes = new Map<string, { staffNumberId: string; scheme: string; source: string; locked: boolean; ids: string[] }>();
    for (const r of todo) {
      const m = monthKey(r.workDate);
      const st = statOf(m);
      st.scanned += 1;
      const o = outcomes.get(r.id)!;
      if (!o.card || o.method === "ambiguous" || o.method === "unresolved" || o.method === "payload") {
        if (o.method === "ambiguous") st.ambiguous += 1;
        else st.unresolved += 1;
        continue;
      }
      st[o.method] += 1;
      const source = `backfill:${o.method}`;
      const k = `${st.locked}|${o.card.id}|${source}`;
      const g = writes.get(k) ?? { staffNumberId: o.card.id, scheme: o.card.scheme, source, locked: st.locked, ids: [] };
      g.ids.push(r.id);
      writes.set(k, g);
      st.written += 1;
    }
    if (opts.apply) {
      for (const g of writes.values()) {
        if (g.locked) {
          // 已鎖月：只寫側表（shift_records 本身一欄都唔寫）
          await prisma.shiftRecordStaffAttribution.createMany({ data: g.ids.map((id) => ({ shiftRecordId: id, staffNumberId: g.staffNumberId, staffScheme: g.scheme, source: g.source })), skipDuplicates: true });
        } else {
          // 用 raw SQL：只更新三個歸屬欄，唔觸發 updated_at、唔掂任何金額欄
          await prisma.$executeRaw(
            // EMP-P1.1：鎖月集合只喺開頭讀一次，跑緊期間有人鎖月都要擋——每批 UPDATE 再用 NOT EXISTS 確認該月（寫入一刻）冇鎖。
            Prisma.sql`UPDATE shift_records SET staff_number_id = ${g.staffNumberId}, staff_scheme = ${g.scheme}, staff_number_source = ${g.source}
              WHERE id = ANY(${g.ids}::text[]) AND staff_number_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM month_closes mc WHERE mc.month = date_trunc('month', shift_records.work_date)::date AND mc.locked_at IS NOT NULL)`,
          );
        }
      }
    }
    await opts.afterBatch?.(batchIndex);
    batchIndex += 1;
  }

  const months = [...stats.values()].sort((a, b) => a.month.localeCompare(b.month));
  if (opts.apply) {
    await writeAudit({
      actorUserId: null,
      tableName: "shift_records",
      rowId: `backfill_staff_numbers:${new Date().toISOString()}`,
      action: "backfill_shift_staff_numbers",
      after: { months: months.map((m) => ({ ...m })) },
    });
  }
  return { apply: opts.apply, months };
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const months: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--month" && argv[i + 1]) months.push(argv[++i]!);
  console.log(`[backfill-shift-staff-numbers] 模式：${apply ? "--apply（真係寫）" : "dry-run（淨係印計數，唔寫）"}${months.length ? `｜月份 ${months.join(",")}` : ""}`);
  backfillShiftStaffNumbers({ apply, months })
    .then((r) => {
      for (const m of r.months) {
        console.log(
          `[backfill-shift-staff-numbers] ${m.month} ${m.locked ? "已鎖月（寫側表）" : "未鎖月"}｜掃描 ${m.scanned}｜roster_file ${m.roster_file}｜longterm ${m.longterm}｜range ${m.range}｜sole ${m.sole}｜unresolved ${m.unresolved}｜ambiguous ${m.ambiguous}｜${apply ? "已寫" : "會寫"} ${m.written}`,
        );
      }
      return prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error("[backfill-shift-staff-numbers] 失敗", e instanceof Error ? e.message : e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
