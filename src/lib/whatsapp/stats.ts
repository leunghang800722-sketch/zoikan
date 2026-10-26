// W1：dry-run 統計（server-only）：收 N、過濾 M、解析 K、auto_write 判定 A、triage T、ignored I、對照一致率。
// 只算「現行」intents（未被新 revision 取代、未撤回）。全部係數字，唔含 PII（日摘要通知亦用呢個）。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequest } from "@/lib/api/errors";
import { compareIntents } from "./compare";
import { hkDateOf, addDays } from "./dates";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COMPARE_INTENTS = 5000;
const DEFAULT_RANGE_DAYS = 14;

export interface WaRange {
  fromIso: string;
  toIso: string;
  start: Date;
  end: Date;
}

/** from／to＝香港日曆日（含頭含尾）；冇就預設最近 14 日。 */
export function parseRange(fromRaw: string | null, toRaw: string | null, now: Date = new Date()): WaRange {
  const today = hkDateOf(now);
  const toIso = toRaw || today;
  const fromIso = fromRaw || addDays(toIso, -(DEFAULT_RANGE_DAYS - 1));
  if (!YMD.test(fromIso) || !YMD.test(toIso) || Number.isNaN(Date.parse(`${fromIso}T00:00:00+08:00`)) || Number.isNaN(Date.parse(`${toIso}T00:00:00+08:00`))) throw BadRequest("日期格式要 YYYY-MM-DD");
  if (fromIso > toIso) throw BadRequest("from 唔可以遲過 to");
  return { fromIso, toIso, start: new Date(`${fromIso}T00:00:00+08:00`), end: new Date(`${addDays(toIso, 1)}T00:00:00+08:00`) };
}

export async function resolveGroupJid(group: string | null): Promise<string | null> {
  if (!group) return null;
  const g = await prisma.whatsappGroup.findFirst({ where: { OR: [{ id: group }, { groupJid: group }] }, select: { groupJid: true } });
  return g?.groupJid ?? group;
}

export interface WaStats {
  from: string;
  to: string;
  received: number;
  filtered: number;
  /** WA-7：filtered 之中純圖片／媒體（reason media_only；圖片唔解析，要打字） */
  filtered_media_only: number;
  parsed: number;
  auto_write: number;
  triage: number;
  ignored: number;
  intents: number;
  compared: number;
  consistent: number;
  inconsistent: number;
  not_scheduled: number;
  consistency_rate: number | null;
  auto_write_compared: number;
  auto_write_consistent: number;
  auto_write_consistency_rate: number | null;
  errors: number;
  pending: number;
  /** W3：routed=auto_write 嘅實際結果（已寫待批／已批／已拒／no-op／只係建議） */
  auto_results: AutoWriteBreakdown;
}

const NON_GROUP_REASONS = ["not_group", "from_me"];
const FILTER_REASONS = ["filtered_out", "group_unbound", "group_ignored"];

function rate(a: number, b: number): number | null {
  return b > 0 ? Math.round((a / b) * 1000) / 1000 : null;
}

export async function computeStats(range: WaRange, groupJid: string | null): Promise<WaStats> {
  const msgWhere: Prisma.WhatsappMessageWhereInput = {
    ts: { gte: range.start, lt: range.end },
    OR: [{ ignoreReason: null }, { ignoreReason: { notIn: NON_GROUP_REASONS } }],
    ...(groupJid ? { chatJid: groupJid } : {}),
  };
  const intentWhere: Prisma.WhatsappIntentWhereInput = {
    supersededByRevision: null,
    revokedAt: null,
    message: { ts: { gte: range.start, lt: range.end }, ...(groupJid ? { chatJid: groupJid } : {}) },
  };
  const [received, filtered, filteredMediaOnly, parsed, errors, pending, byRouted, cmpRows] = await Promise.all([
    prisma.whatsappMessage.count({ where: msgWhere }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, ignoreReason: { in: FILTER_REASONS } } }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, ignoreReason: { in: FILTER_REASONS }, filterReasons: { array_contains: "media_only" } } }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, llmProvider: { not: null } } }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, status: "error" } }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, status: "received" } }),
    prisma.whatsappIntent.groupBy({ by: ["routed"], where: intentWhere, _count: { _all: true } }),
    prisma.whatsappIntent.findMany({
      where: { ...intentWhere, kind: { in: ["shift", "leave"] }, guardId: { not: null }, workDate: { not: null } },
      select: { id: true, kind: true, guardId: true, workDate: true, shiftTypeId: true, leaveCode: true, routed: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: MAX_COMPARE_INTENTS,
    }),
  ]);
  const count = (r: string) => byRouted.find((x) => x.routed === r)?._count._all ?? 0;
  const cmp = await compareIntents(cmpRows.map((r) => ({ id: r.id, kind: r.kind, guardId: r.guardId, workDate: r.workDate ? r.workDate.toISOString().slice(0, 10) : null, shiftTypeId: r.shiftTypeId, leaveCode: r.leaveCode })));
  let consistent = 0;
  let inconsistent = 0;
  let none = 0;
  let awCompared = 0;
  let awConsistent = 0;
  for (const r of cmpRows) {
    const c = cmp.get(r.id);
    if (!c?.status) continue;
    if (c.status === "match") consistent++;
    else if (c.status === "mismatch") inconsistent++;
    else none++;
    if (r.routed === "auto_write" && c.status !== "none") {
      awCompared++;
      if (c.status === "match") awConsistent++;
    }
  }
  const compared = consistent + inconsistent;
  return {
    from: range.fromIso,
    to: range.toIso,
    received,
    filtered,
    filtered_media_only: filteredMediaOnly,
    parsed,
    auto_write: count("auto_write"),
    triage: count("triage"),
    ignored: count("ignored"),
    intents: byRouted.reduce((s, x) => s + x._count._all, 0),
    compared,
    consistent,
    inconsistent,
    not_scheduled: none,
    consistency_rate: rate(consistent, compared),
    auto_write_compared: awCompared,
    auto_write_consistent: awConsistent,
    auto_write_consistency_rate: rate(awConsistent, awCompared),
    errors,
    pending,
    auto_results: await computeAutoWriteBreakdown(range, groupJid),
  };
}

// ---------------------------------------------------------------- W3：自動寫入實際結果
export type AutoWriteOutcome = "pending" | "approved" | "rejected" | "no_op" | "suggested";

/** 純函數：一條 routed=auto_write 嘅 intent → 實際結果。written＋記錄狀態：pending_approval＝待批；draft／cancelled／冇記錄＝已拒；其餘＝已批。 */
export function autoWriteOutcomeOf(resolution: unknown, recordStatus: string | null | undefined): AutoWriteOutcome {
  const aw = resolution && typeof resolution === "object" ? (resolution as { auto_write?: { result?: unknown } }).auto_write : undefined;
  const result = aw && typeof aw === "object" ? aw.result : undefined;
  if (result === "no_op") return "no_op";
  if (result !== "written") return "suggested";
  if (recordStatus === "pending_approval") return "pending";
  if (!recordStatus || recordStatus === "draft" || recordStatus === "cancelled") return "rejected";
  return "approved";
}

interface AutoWriteBreakdown {
  /** 自動寫入咗（待批＋已批＋已拒） */
  written: number;
  pending: number;
  approved: number;
  rejected: number;
  no_op: number;
  /** 群組未開自動寫入（dry-run）：只係建議 */
  suggested: number;
}

/** 範圍內所有 routed=auto_write 嘅 intent（包括之後被新 revision 取代／撤回嘅——寫過就算）嘅實際結果。 */
async function computeAutoWriteBreakdown(range: WaRange, groupJid: string | null): Promise<AutoWriteBreakdown> {
  const rows = await prisma.whatsappIntent.findMany({
    where: { routed: "auto_write", message: { ts: { gte: range.start, lt: range.end }, ...(groupJid ? { chatJid: groupJid } : {}) } },
    select: { resolution: true, resultRef: true },
    take: MAX_COMPARE_INTENTS,
  });
  const recIds = [...new Set(rows.map((r) => r.resultRef).filter((x): x is string => !!x))];
  const recs = recIds.length ? await prisma.shiftRecord.findMany({ where: { id: { in: recIds } }, select: { id: true, status: true } }) : [];
  const st = new Map(recs.map((r) => [r.id, r.status as string]));
  const out: AutoWriteBreakdown = { written: 0, pending: 0, approved: 0, rejected: 0, no_op: 0, suggested: 0 };
  for (const r of rows) {
    const o = autoWriteOutcomeOf(r.resolution, r.resultRef ? st.get(r.resultRef) : null);
    out[o]++;
    if (o === "pending" || o === "approved" || o === "rejected") out.written++;
  }
  return out;
}
