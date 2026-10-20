// EMP-P3：只讀對拍——逐個長工列出 人卡 hire_date／leave_date vs MG 卡鏈 valid_from／valid_to，分類：
//   （另外三類獨立清單；P3.2 加 resigned_without_valid_to＝former＋resigned 但冇 valid_to 嘅卡（guardId＋cardId），
//    各列 guardId＋前後日期：start_after_effective＝選中鏈起點遲過生效日 10/1；mirror_would_change＝鏈頭／current 規則下鏡像會改人卡 hire／leave 嘅人）
//   consistent（一致）｜card_no_dates（卡冇日期，讀日期時 fallback 人卡）｜mismatch（唔一致，會用卡）｜rehire_suspected（疑似再入職：人卡離職日早過卡鏈起點）｜no_mg_card（冇 MG 卡）
//   npx tsx scripts/db/longterm-card-dates-diff.ts --out data/longterm-card-dates-diff.json   # --out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）
// 只讀（唔寫 DB）；console 只印分類計數；JSON 只有 guardId 同日期（YYYY-MM-DD），唔含姓名／工號。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { prisma } from "../../src/lib/db";
import { loadStaffSchemes } from "../../src/lib/guards/staff-schemes";
import { LONGTERM_CARD_DATES_EFFECTIVE_FROM, resolveLongtermPeriod } from "../../src/lib/longterm-payroll/employment-period";
import { planEmploymentMirror } from "../../src/lib/guards/staff-numbers";

export type CardDatesClass = "consistent" | "card_no_dates" | "mismatch" | "rehire_suspected" | "no_mg_card";
export interface CardDatesRow {
  guard_id: string;
  guard_hire: string | null;
  guard_leave: string | null;
  card_start: string | null;
  card_end: string | null;
  klass: CardDatesClass;
  chain_card_ids: string[];
}
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export interface StartAfterEffectiveRow {
  guard_id: string;
  card_start: string;
  effective_from: string;
}
/** EMP-P3.2：舊資料 resigned（或 former＋resigned）但冇 valid_to——卡鏈判唔到再入職／離職日，要人手補 valid_to */
export interface ResignedWithoutValidToRow {
  guard_id: string;
  card_id: string;
}
export interface MirrorWouldChangeRow {
  guard_id: string;
  hire_before: string | null;
  hire_after: string | null;
  leave_before: string | null;
  leave_after: string | null;
  hints: string[];
}

export async function diffLongtermCardDates(asOfMonth: Date = new Date()): Promise<{ rows: CardDatesRow[]; counts: Record<CardDatesClass, number>; start_after_effective: StartAfterEffectiveRow[]; mirror_would_change: MirrorWouldChangeRow[]; resigned_without_valid_to: ResignedWithoutValidToRow[] }> {
  const schemes = await loadStaffSchemes();
  const codes = new Set([...schemes.values()].filter((s) => s.isLongterm).map((s) => s.code));
  // 揀鏈用「生效月同今個月之中較遲者」（生效前 helper 一律讀人卡）
  const month = asOfMonth.getTime() > LONGTERM_CARD_DATES_EFFECTIVE_FROM.getTime() ? asOfMonth : LONGTERM_CARD_DATES_EFFECTIVE_FROM;
  const contracts = await prisma.guardLongtermContract.findMany({ where: { voidedAt: null }, select: { guardId: true }, distinct: ["guardId"] });
  const cardGuards = await prisma.guardStaffNumber.findMany({ where: { scheme: { in: [...codes] } }, select: { guardId: true }, distinct: ["guardId"] });
  const ids = [...new Set([...contracts.map((c) => c.guardId), ...cardGuards.map((c) => c.guardId)])];
  const [guards, cards] = await Promise.all([
    prisma.guard.findMany({ where: { id: { in: ids } }, select: { id: true, hireDate: true, leaveDate: true } }),
    prisma.guardStaffNumber.findMany({ where: { guardId: { in: ids }, scheme: { in: [...codes] } }, select: { id: true, guardId: true, scheme: true, status: true, validFrom: true, validTo: true, endReason: true, predecessorId: true } }),
  ]);
  const byGuard = new Map<string, typeof cards>();
  for (const c of cards) (byGuard.get(c.guardId) ?? byGuard.set(c.guardId, []).get(c.guardId)!).push(c);
  const counts: Record<CardDatesClass, number> = { consistent: 0, card_no_dates: 0, mismatch: 0, rehire_suspected: 0, no_mg_card: 0 };
  const rows: CardDatesRow[] = [];
  const startAfter: StartAfterEffectiveRow[] = [];
  const mirror: MirrorWouldChangeRow[] = [];
  const noTo: ResignedWithoutValidToRow[] = [];
  for (const g of guards.sort((a, b) => a.id.localeCompare(b.id))) {
    const gc = byGuard.get(g.id) ?? [];
    const p = resolveLongtermPeriod(g, gc, month, codes);
    for (const c of gc) if (c.status === "former" && c.endReason === "resigned" && !c.validTo) noTo.push({ guard_id: g.id, card_id: c.id });
    let klass: CardDatesClass;
    if (gc.length === 0 || !p.usedCards) klass = "no_mg_card";
    else if (p.rehire) klass = "rehire_suspected";
    else if (p.warnings.length) klass = "mismatch";
    else if (p.startSource !== "card" && p.endSource !== "card") klass = "card_no_dates";
    else klass = "consistent";
    counts[klass] += 1;
    if (p.usedCards && p.startSource === "card" && p.start && p.start.getTime() > LONGTERM_CARD_DATES_EFFECTIVE_FROM.getTime()) startAfter.push({ guard_id: g.id, card_start: iso(p.start)!, effective_from: iso(LONGTERM_CARD_DATES_EFFECTIVE_FROM)! });
    if (gc.length) {
      const plan = planEmploymentMirror(g, gc);
      if (plan.hire !== undefined || plan.leave !== undefined) {
        mirror.push({
          guard_id: g.id,
          hire_before: iso(g.hireDate),
          hire_after: plan.hire !== undefined ? iso(plan.hire) : iso(g.hireDate),
          leave_before: iso(g.leaveDate),
          leave_after: plan.leave !== undefined ? iso(plan.leave) : iso(g.leaveDate),
          hints: plan.warnings.map((w) => w.split("：")[0]!),
        });
      }
    }
    rows.push({
      guard_id: g.id,
      guard_hire: iso(g.hireDate),
      guard_leave: iso(g.leaveDate),
      card_start: p.startSource === "card" ? iso(p.start) : null,
      card_end: p.endSource === "card" ? iso(p.end) : null,
      klass,
      chain_card_ids: p.chainCardIds,
    });
  }
  return { rows, counts, start_after_effective: startAfter, mirror_would_change: mirror, resigned_without_valid_to: noTo };
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : undefined;
  (async () => {
    if (!out) throw new Error("需要 --out <path>（必須喺 data/ 或 out/ 之下）");
    const abs = path.resolve(out);
    const rel = path.relative(process.cwd(), abs).split(path.sep);
    if (rel[0] !== "data" && rel[0] !== "out") throw new Error("--out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）");
    const r = await diffLongtermCardDates();
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify({ generated_at: new Date().toISOString(), counts: r.counts, start_after_effective: r.start_after_effective, mirror_would_change: r.mirror_would_change, resigned_without_valid_to: r.resigned_without_valid_to, rows: r.rows }, null, 2));
    console.log(`[longterm-card-dates-diff] 長工 ${r.rows.length} 人｜${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join("｜")}｜start_after_effective ${r.start_after_effective.length}｜mirror_would_change ${r.mirror_would_change.length}｜resigned_without_valid_to ${r.resigned_without_valid_to.length}｜已寫 --out`);
    await prisma.$disconnect();
  })().catch(async (e) => {
    console.error("[longterm-card-dates-diff] 失敗", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
