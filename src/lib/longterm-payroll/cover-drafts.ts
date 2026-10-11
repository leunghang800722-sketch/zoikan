// P10.3：頂位津貼草稿。按價目表（`cover_shift_rates`，該盤該職級當日生效價）＋更表頂位更，每位長工每月出一條 other_allowance 草稿
// （金額＝逐更價之和；證據列日期／盤 id／職級／單價）。草稿未確認唔計糧（aggregate 只讀 confirmed）；會計確認先計。
// 冇價嘅 (盤,職級) 唔生成，回報 `unpriced` 俾 job 通知。同月已有已確認嘅頂位津貼（note 含「頂位」或來源 cover:rates）→ 唔出草稿（防重複）。
// 鎖月唔生成。更表變→更新未確認、未人手編輯嘅草稿；會計刪走嘅（作廢者唔係系統）同一組證據唔再出。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { isMonthLocked } from "@/lib/month-lock";
import { monthRange, round2 } from "@/lib/reports/money";
import { getSystemUserId } from "@/lib/system-user";
import { loadActiveRates, lookupRate } from "./cover-rates";
import { loadCoverShifts } from "./cover-shifts";
import { isCoverNote } from "./cover-infer";
import type { Prisma } from "@prisma/client";

export const COVER_DRAFT_SOURCE = "cover:rates";

interface Line {
  date: string;
  site_id: string;
  grade: string;
  rate_id: string;
  amount: number;
}
interface CoverEvidence {
  lines: Line[];
  shifts: number;
  edited?: boolean;
}

export interface CoverDraftResult {
  month: string;
  locked: boolean;
  created: number;
  updated: number;
  voided: number;
  rejected_skipped: number;
  skipped_confirmed: number;
  unpriced: { site_id: string; grade: string; shifts: number }[];
  pending: number;
}

function evidenceOf(v: Prisma.JsonValue | null): CoverEvidence | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return { lines: Array.isArray(o.lines) ? (o.lines as Line[]) : [], shifts: typeof o.shifts === "number" ? o.shifts : 0, edited: o.edited === true };
}
const keyOfLines = (lines: Line[]): string => lines.map((l) => `${l.date}|${l.site_id}|${l.grade}|${l.amount}`).sort().join(";");

export async function generateCoverDrafts(month: Date, actorUserId: string): Promise<CoverDraftResult> {
  const { start } = monthRange(month);
  const m = start.toISOString().slice(0, 7);
  const res: CoverDraftResult = { month: m, locked: false, created: 0, updated: 0, voided: 0, rejected_skipped: 0, skipped_confirmed: 0, unpriced: [], pending: 0 };
  if (await isMonthLocked(start)) return { ...res, locked: true };

  const [load, rates] = await Promise.all([loadCoverShifts([start]), loadActiveRates()]);
  const linesByGuard = new Map<string, Line[]>();
  const unpricedMap = new Map<string, { site_id: string; grade: string; shifts: number }>();
  for (const s of load.shifts) {
    const parent = load.sites.get(s.siteId)?.parentSiteId ?? null;
    const r = lookupRate(rates, s.siteId, parent, s.grade, s.date);
    if (!r) {
      const k = `${s.siteId}|${s.grade}`;
      const e = unpricedMap.get(k) ?? { site_id: s.siteId, grade: s.grade, shifts: 0 };
      e.shifts++;
      unpricedMap.set(k, e);
      continue;
    }
    linesByGuard.set(s.guardId, [...(linesByGuard.get(s.guardId) ?? []), { date: s.date, site_id: s.siteId, grade: s.grade, rate_id: r.id, amount: r.amount }]);
  }
  res.unpriced = [...unpricedMap.values()].sort((a, b) => a.site_id.localeCompare(b.site_id) || a.grade.localeCompare(b.grade));

  const existing = await prisma.longtermPayrollInput.findMany({ where: { month: start, kind: "other_allowance" } });
  const byGuard = new Map<string, typeof existing>();
  for (const e of existing) byGuard.set(e.guardId, [...(byGuard.get(e.guardId) ?? []), e]);
  const sysId = await getSystemUserId();
  const guardIds = new Set([...linesByGuard.keys(), ...existing.filter((e) => e.draftSource === COVER_DRAFT_SOURCE).map((e) => e.guardId)]);

  for (const guardId of guardIds) {
    const rows = byGuard.get(guardId) ?? [];
    const live = rows.filter((r) => !r.voidedAt);
    const confirmedCover = live.filter((r) => r.status === "confirmed" && (r.draftSource === COVER_DRAFT_SOURCE || isCoverNote(r.note)));
    const drafts = live.filter((r) => r.status === "draft" && r.draftSource === COVER_DRAFT_SOURCE);
    const lines = (linesByGuard.get(guardId) ?? []).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const wantKey = keyOfLines(lines);
    let wanted = lines.length > 0 && confirmedCover.length === 0;
    if (lines.length > 0 && confirmedCover.length > 0) res.skipped_confirmed++;
    if (wanted && rows.some((r) => r.voidedAt && r.status === "draft" && r.draftSource === COVER_DRAFT_SOURCE && r.voidedBy !== sysId && keyOfLines(evidenceOf(r.draftEvidence)?.lines ?? []) === wantKey)) {
      res.rejected_skipped++;
      wanted = false;
    }
    const editable = drafts.filter((d) => !evidenceOf(d.draftEvidence)?.edited);
    const hasEdited = drafts.some((d) => evidenceOf(d.draftEvidence)?.edited);
    if (wanted && hasEdited) wanted = false; // 會計已人手改過嘅草稿，唔覆蓋亦唔另開
    const amount = round2(lines.reduce((a, l) => a + l.amount, 0));
    const evidence: CoverEvidence = { lines, shifts: lines.length };

    if (wanted) {
      const [keep, ...extra] = editable;
      if (keep) {
        const sameEv = keyOfLines(evidenceOf(keep.draftEvidence)?.lines ?? []) === wantKey;
        if (!sameEv || Number(keep.amount) !== amount) {
          const after = await prisma.longtermPayrollInput.update({ where: { id: keep.id }, data: { amount, draftEvidence: evidence as unknown as Prisma.InputJsonValue, note: noteFor(lines.length) } });
          await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: keep.id, action: "update", before: keep, after, ip: null });
          res.updated++;
        }
      } else {
        const created = await prisma.longtermPayrollInput.create({
          data: { month: start, guardId, kind: "other_allowance", amount, note: noteFor(lines.length), status: "draft", draftSource: COVER_DRAFT_SOURCE, draftEvidence: evidence as unknown as Prisma.InputJsonValue, createdBy: actorUserId },
        });
        await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: created.id, action: "create", after: created, ip: null });
        res.created++;
      }
      for (const e of extra) await voidDraft(e, actorUserId, res);
    } else {
      for (const e of editable) await voidDraft(e, actorUserId, res);
    }
  }
  res.pending = await prisma.longtermPayrollInput.count({ where: { month: start, status: "draft", voidedAt: null } });
  return res;
}

const noteFor = (n: number): string => `頂位津貼（草稿）——按價目表自動計 ${n} 更，待確認`;

async function voidDraft(e: Prisma.LongtermPayrollInputGetPayload<object>, actorUserId: string, res: CoverDraftResult): Promise<void> {
  const after = await prisma.longtermPayrollInput.update({ where: { id: e.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
  await writeAudit({ actorUserId, tableName: "longterm_payroll_inputs", rowId: e.id, action: "void", before: e, after, ip: null });
  res.voided++;
}
