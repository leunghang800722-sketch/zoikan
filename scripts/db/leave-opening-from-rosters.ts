// HIST-1：由 2026-07 之前月份嘅更表（shift_records 含 leaveCode SL／AL）計長工病假／年假結餘 opening，回填 guard_leave_balances。
//
//   npx tsx scripts/db/leave-opening-from-rosters.ts --as-of 2026-06 [--out data/leave-opening.json]          # dry-run（預設）：只計、只印計數
//   npx tsx scripts/db/leave-opening-from-rosters.ts --as-of 2026-06 --apply [--out data/leave-opening.json]  # 真係寫（先 dry-run 睇差異清單）
//   --out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）；JSON 只有 guardId＋數字＋月份，唔含姓名／工號／電話。
//
// 對象：長工（有未作廢長工合約，或者有長工體系（staff_schemes.is_longterm，出廠 MG）工號卡）。
// 計法（截至 as-of 月尾，含 as-of 月）：
//   AL：as-of 月尾或之前 leaveCode=AL 嘅不同日期數（同 aggregate.ts `alTakenCumulative` 口徑：成段服務期累積，唔分年）。
//   SL：as-of 月尾或之前 leaveCode=SL 日子，按「連續曆日」分段；逐段模擬 aggregate.ts 規則——段開始日嘅累積結餘
//       slAccruedStatute(入職日, 段開始日)（HIST-1.1 條例口徑：做滿 1 個月先儲、首 12 個月每月 2 日、之後每月 4 日、上限 120）減已用；結餘 ≥ 段日數 → 當有薪 4/5（食結餘），
//       否則當無薪（唔食結餘）。**假設**：歷史月份冇醫生紙人手確認資料，統一當「已確認醫生紙」（同 P17.1 SL_CONFIRMED_SHORT_PAID 口徑）；
//       RD／OFF 夾喺中間唔橋接（更表無該類記錄就睇唔到）。
//   入職日：未有 P3 `resolveLongtermPeriod`（EMP-P3 未合併）→ 用 guards.hire_date；冇入職日 → slAccrued=0 並標 no_hire_date。
// 寫入（--apply）：guard_leave_balances (guardId, year=as-of 年) —— alTaken／slTaken＝截至 as-of 月尾累積（aggregate 計 as-of 之後月份嘅 opening 就係讀呢兩欄），
//   alTakenOpening／slTakenOpening＝截至 as-of 前一個月月尾累積（同月重算用），slAccrued＝as-of 月尾累積病假結餘，asOfMonth＝as-of 月。
//   只喺該 guard 該 year 行 asOfMonth 為 null 或早過 as-of 先寫（冇行就建；全部歸零而冇行就唔建）；已有更新結餘（asOfMonth ≥ as-of）一律唔郁，只喺差異清單列出俾人對。
//   --recompute-same-as-of：已有行 asOfMonth 剛好＝as-of（上次腳本寫嘅）→ 覆蓋重算（例如之後補上載咗更多舊更表）。
//   --merge-into-existing（HIST-1.1）：已有較新行（asOfMonth > as-of，例如已計 7／8／9 月）→ 將 as-of 前歷史累積**加落**現有行嘅
//     alTaken／slTaken／alTakenOpening／slTakenOpening；slAccrued 按入職日重算到該行 asOfMonth 月尾；asOfMonth 不變。
//     防重複：每個 guard 合併後寫 audit（action=backfill_leave_opening_merge，rowId＝guardId，after.as_of）；再跑查 audit，已合併 → already_merged。
//     dry-run 列出每人前後值（diffs）。只影響下一次重算（10 月起）；7／8／9 月已付唔郁。SL 有薪／無薪判斷可能因結餘變而改。
//   冪等：寫完 asOfMonth＝as-of，再跑唔會再寫。每次 --apply 寫一條 audit summary（action=backfill_leave_opening，只有月份＋計數）。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/db";
import { writeAudit, writeAuditTx } from "../../src/lib/audit";
import { loadStaffSchemes } from "../../src/lib/guards/staff-schemes";
import { slAccrued, slAccruedStatute } from "../../src/lib/longterm-payroll/compute";
import { excludeUnapprovedWhatsapp } from "../../src/lib/longterm-payroll/approved-only";

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface LeaveOpeningNumbers {
  alTaken: number;
  slTaken: number;
  slAccrued: number;
  alTakenOpening: number;
  slTakenOpening: number;
  asOfMonth: string | null;
}
export type LeaveOpeningAction = "create" | "update" | "merge" | "already_merged" | "skip_existing_newer_or_equal" | "nothing_to_write" | "unchanged";
export interface LeaveOpeningRow {
  guard_id: string;
  action: LeaveOpeningAction;
  flags: string[];
  computed: LeaveOpeningNumbers;
  existing: LeaveOpeningNumbers | null;
  /** 欄位 → [現有, 計算]（只列唔同嗰啲；existing 為 null 時列晒非零欄） */
  diffs: Record<string, [number | string | null, number | string | null]>;
}
export interface LeaveOpeningResult {
  as_of: string;
  year: number;
  apply: boolean;
  counts: Record<LeaveOpeningAction, number> & { guards: number; no_hire_date: number; sl_unpaid_segments: number };
  rows: LeaveOpeningRow[];
}

export function parseAsOf(raw: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error("--as-of 要係 YYYY-MM");
  const [y, m] = raw.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

/** 連續曆日分段（dates 已排序、去重）。 */
export function consecutiveSegments(dates: readonly Date[]): { start: Date; days: Date[] }[] {
  const out: { start: Date; days: Date[] }[] = [];
  for (const d of dates) {
    const last = out[out.length - 1];
    if (last && d.getTime() - last.days[last.days.length - 1]!.getTime() === DAY) last.days.push(d);
    else out.push({ start: d, days: [d] });
  }
  return out;
}

/** 純函數：一個長工截至 asOf 月尾嘅結餘。slDates／alDates 係 as-of 月尾或之前嘅 leave 日子（可亂序、可重覆）。 */
export function computeGuardOpening(hireDate: Date | null, slDates: readonly Date[], alDates: readonly Date[], asOfStart: Date): { n: LeaveOpeningNumbers; unpaidSegments: number } {
  const asOfEnd = new Date(Date.UTC(asOfStart.getUTCFullYear(), asOfStart.getUTCMonth() + 1, 0));
  const uniq = (xs: readonly Date[]) => [...new Map(xs.filter((d) => d.getTime() <= asOfEnd.getTime()).map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
  const sl = uniq(slDates);
  const al = uniq(alDates);
  let used = 0;
  let usedPrev = 0;
  let unpaidSegments = 0;
  for (const seg of consecutiveSegments(sl)) {
    const accrued = hireDate ? slAccruedStatute(hireDate, seg.start) : 0; // 重建真實結餘 → 一律條例口徑（首 12 個月每月 2 日、之後每月 4 日、上限 120）
    const balance = r2(accrued - used);
    if (balance + 1e-9 >= seg.days.length) {
      used += seg.days.length;
      usedPrev += seg.days.filter((d) => d.getTime() < asOfStart.getTime()).length;
    } else unpaidSegments += 1;
  }
  return {
    unpaidSegments,
    n: {
      alTaken: al.length,
      slTaken: used,
      slAccrued: hireDate ? slAccruedStatute(hireDate, asOfEnd) : 0,
      alTakenOpening: al.filter((d) => d.getTime() < asOfStart.getTime()).length,
      slTakenOpening: usedPrev,
      asOfMonth: iso(asOfStart),
    },
  };
}

const num = (v: unknown): number => Number(String(v ?? 0));
const FIELDS = ["alTaken", "slTaken", "slAccrued", "alTakenOpening", "slTakenOpening", "asOfMonth"] as const;

export const MERGE_AUDIT_ACTION = "backfill_leave_opening_merge";

export async function leaveOpeningFromRosters(opts: { asOf: Date; apply: boolean; mergeIntoExisting?: boolean; recomputeSameAsOf?: boolean }): Promise<LeaveOpeningResult> {
  const asOfStart = opts.asOf;
  const asOfEnd = new Date(Date.UTC(asOfStart.getUTCFullYear(), asOfStart.getUTCMonth() + 1, 0));
  const year = asOfStart.getUTCFullYear();
  const schemes = await loadStaffSchemes();
  const ltCodes = [...schemes.values()].filter((s) => s.isLongterm).map((s) => s.code);
  const [contracts, cards] = await Promise.all([
    prisma.guardLongtermContract.findMany({ where: { voidedAt: null }, select: { guardId: true }, distinct: ["guardId"] }),
    ltCodes.length ? prisma.guardStaffNumber.findMany({ where: { scheme: { in: ltCodes } }, select: { guardId: true }, distinct: ["guardId"] }) : Promise.resolve([] as { guardId: string }[]),
  ]);
  const ids = [...new Set([...contracts.map((c) => c.guardId), ...cards.map((c) => c.guardId)])].sort();
  const [guards, leaves, balances] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: ids } }, select: { id: true, hireDate: true } }),
    prisma.shiftRecord.findMany({
      where: { guardId: { in: ids }, workDate: { lte: asOfEnd }, status: { not: "cancelled" }, leaveCode: { in: ["SL", "AL"] }, ...excludeUnapprovedWhatsapp() },
      select: { guardId: true, workDate: true, leaveCode: true },
    }),
    prisma.guardLeaveBalance.findMany({ where: { guardId: { in: ids }, year } }),
  ]);
  const asOfLabel = iso(asOfStart).slice(0, 7);
  // 合併模式防重複：audit 記錄咗 (guardId, as-of) 就唔再合併
  const mergedBefore = opts.mergeIntoExisting
    ? new Set((await prisma.auditLog.findMany({ where: { action: MERGE_AUDIT_ACTION, after: { path: ["as_of"], equals: asOfLabel } }, select: { rowId: true } })).map((a) => a.rowId))
    : new Set<string>();
  const hireOf = new Map(guards.map((g) => [g.id, g.hireDate]));
  const balOf = new Map(balances.map((b) => [b.guardId, b]));
  const slBy = new Map<string, Date[]>();
  const alBy = new Map<string, Date[]>();
  for (const l of leaves) {
    const m = l.leaveCode === "SL" ? slBy : alBy;
    (m.get(l.guardId) ?? m.set(l.guardId, []).get(l.guardId)!).push(l.workDate);
  }

  const counts = { create: 0, update: 0, merge: 0, already_merged: 0, skip_existing_newer_or_equal: 0, nothing_to_write: 0, unchanged: 0, guards: ids.length, no_hire_date: 0, sl_unpaid_segments: 0 };
  const rows: LeaveOpeningRow[] = [];
  for (const id of ids) {
    const hire = hireOf.get(id) ?? null;
    const { n, unpaidSegments } = computeGuardOpening(hire, slBy.get(id) ?? [], alBy.get(id) ?? [], asOfStart);
    const flags: string[] = [];
    if (!hire) {
      flags.push("no_hire_date");
      counts.no_hire_date += 1;
    }
    if (unpaidSegments) {
      flags.push(`sl_unpaid_segments:${unpaidSegments}`);
      counts.sl_unpaid_segments += unpaidSegments;
    }
    const b = balOf.get(id) ?? null;
    const existing: LeaveOpeningNumbers | null = b
      ? { alTaken: num(b.alTaken), slTaken: num(b.slTaken), slAccrued: num(b.slAccrued), alTakenOpening: num(b.alTakenOpening), slTakenOpening: num(b.slTakenOpening), asOfMonth: b.asOfMonth ? iso(b.asOfMonth) : null }
      : null;
    const allZero = n.alTaken === 0 && n.slTaken === 0 && n.slAccrued === 0;
    let action: LeaveOpeningAction;
    // 合併模式（--merge-into-existing）：已有較新行（asOfMonth > as-of）→ 將 as-of 前歷史累積加落現有行（見檔頭）
    let target: LeaveOpeningNumbers = n;
    if (!b) action = allZero ? "nothing_to_write" : "create";
    else if (b.asOfMonth && b.asOfMonth.getTime() > asOfStart.getTime() && opts.mergeIntoExisting) {
      if (mergedBefore.has(id)) action = "already_merged";
      else {
        action = "merge";
        const rowEnd = new Date(Date.UTC(b.asOfMonth.getUTCFullYear(), b.asOfMonth.getUTCMonth() + 1, 0));
        target = {
          alTaken: r2(existing!.alTaken + n.alTaken),
          slTaken: r2(existing!.slTaken + n.slTaken),
          slAccrued: hire ? slAccrued(hire, rowEnd) : existing!.slAccrued, // 按入職日重算到該行 asOfMonth 月尾（同 aggregate 寫回口徑）
          alTakenOpening: r2(existing!.alTakenOpening + n.alTakenOpening),
          slTakenOpening: r2(existing!.slTakenOpening + n.slTakenOpening),
          asOfMonth: existing!.asOfMonth,
        };
      }
    } else if (b.asOfMonth && b.asOfMonth.getTime() === asOfStart.getTime() && opts.recomputeSameAsOf) action = "update"; // --recompute-same-as-of：重跑同一 as-of 覆蓋
    else if (b.asOfMonth && b.asOfMonth.getTime() >= asOfStart.getTime()) action = "skip_existing_newer_or_equal";
    else action = "update";
    const diffs: LeaveOpeningRow["diffs"] = {};
    for (const f of FIELDS) {
      const ex = existing ? existing[f] : f === "asOfMonth" ? null : 0;
      if (ex !== target[f]) diffs[f] = [ex, target[f]];
    }
    if ((action === "update" || action === "merge") && Object.keys(diffs).length === 0) action = "unchanged";
    counts[action] += 1;
    rows.push({ guard_id: id, action, flags, computed: target, existing, diffs });
  }

  if (opts.apply) {
    const writes = rows.filter((r) => r.action === "create" || r.action === "update" || r.action === "merge");
    await prisma.$transaction(
      async (tx) => {
        for (const r of writes) {
          const data = {
            alTaken: new Prisma.Decimal(r.computed.alTaken),
            slTaken: new Prisma.Decimal(r.computed.slTaken),
            slAccrued: new Prisma.Decimal(r.computed.slAccrued),
            alTakenOpening: new Prisma.Decimal(r.computed.alTakenOpening),
            slTakenOpening: new Prisma.Decimal(r.computed.slTakenOpening),
            asOfMonth: r.action === "merge" ? new Date(`${r.computed.asOfMonth}T00:00:00.000Z`) : asOfStart,
          };
          // 寫入條件喺 where 再扣一次（tx 內防並發：asOfMonth 已被計糧推進就唔蓋）
          if (r.action === "merge") {
            // 合併：computed 已係「現有＋歷史」嘅合併後數值；tx 內再查 audit 防重複、再核對行未被改過（asOfMonth／alTaken／slTaken 同 dry-run 讀到嘅現有值一致）
            if ((await tx.auditLog.count({ where: { action: MERGE_AUDIT_ACTION, rowId: r.guard_id, after: { path: ["as_of"], equals: asOfLabel } } })) > 0) continue;
            const ex = r.existing!;
            const res = await tx.guardLeaveBalance.updateMany({
              where: { guardId: r.guard_id, year, asOfMonth: { gt: asOfStart }, alTaken: new Prisma.Decimal(ex.alTaken), slTaken: new Prisma.Decimal(ex.slTaken) },
              data: { alTaken: data.alTaken, slTaken: data.slTaken, slAccrued: data.slAccrued, alTakenOpening: data.alTakenOpening, slTakenOpening: data.slTakenOpening },
            });
            if (res.count === 1) await writeAuditTx(tx, { actorUserId: null, tableName: "guard_leave_balances", rowId: r.guard_id, action: MERGE_AUDIT_ACTION, before: ex, after: { as_of: asOfLabel, year, merged: r.computed }, ip: null });
            continue;
          }
          if (r.action === "create") {
            await tx.guardLeaveBalance.upsert({ where: { guardId_year: { guardId: r.guard_id, year } }, create: { guardId: r.guard_id, year, ...data }, update: {} });
          } else {
            await tx.guardLeaveBalance.updateMany({ where: { guardId: r.guard_id, year, OR: [{ asOfMonth: null }, { asOfMonth: { lt: asOfStart } }, ...(opts.recomputeSameAsOf ? [{ asOfMonth: asOfStart }] : [])] }, data });
          }
        }
      },
      { timeout: 120_000 },
    );
    await writeAudit({
      actorUserId: null,
      tableName: "guard_leave_balances",
      rowId: `leave_opening:${iso(asOfStart).slice(0, 7)}`,
      action: "backfill_leave_opening",
      after: { as_of: iso(asOfStart).slice(0, 7), year, ...counts },
    });
  }
  return { as_of: iso(asOfStart).slice(0, 7), year, apply: opts.apply, counts, rows };
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  (async () => {
    const asOfRaw = val("--as-of");
    if (!asOfRaw) throw new Error("需要 --as-of YYYY-MM（例如 2026-06）");
    const out = val("--out");
    let abs: string | null = null;
    if (out) {
      abs = path.resolve(out);
      const rel = path.relative(process.cwd(), abs).split(path.sep);
      if (rel[0] !== "data" && rel[0] !== "out") throw new Error("--out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）");
    }
    console.log(`[leave-opening] 模式：${apply ? "--apply（真係寫）" : "dry-run（只計，唔寫）"}｜as-of ${asOfRaw}`);
    const r = await leaveOpeningFromRosters({ asOf: parseAsOf(asOfRaw), apply, mergeIntoExisting: argv.includes("--merge-into-existing"), recomputeSameAsOf: argv.includes("--recompute-same-as-of") });
    console.log(`[leave-opening] 長工 ${r.counts.guards} 人｜${(["create", "update", "merge", "already_merged", "unchanged", "skip_existing_newer_or_equal", "nothing_to_write"] as const).map((k) => `${k} ${r.counts[k]}`).join("｜")}｜no_hire_date ${r.counts.no_hire_date}｜sl_unpaid_segments ${r.counts.sl_unpaid_segments}`);
    if (abs) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2));
      console.log("[leave-opening] 已寫 --out（只有 guardId＋數字）");
    }
    await prisma.$disconnect();
  })().catch(async (e) => {
    console.error("[leave-opening] 失敗", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
