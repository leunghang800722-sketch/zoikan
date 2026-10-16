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
  const [received, filtered, parsed, errors, pending, byRouted, cmpRows] = await Promise.all([
    prisma.whatsappMessage.count({ where: msgWhere }),
    prisma.whatsappMessage.count({ where: { ...msgWhere, ignoreReason: { in: FILTER_REASONS } } }),
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
  };
}
