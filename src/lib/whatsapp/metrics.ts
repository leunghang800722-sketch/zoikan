// W5：運維指標（server-only）。近 N 日（香港日曆日，含今日）整體＋按群細分；全部係數字，唔含 PII／原文。
// 數據源：computeStats（收／過濾／解析／判定／自動寫入結果／一致率／錯誤）＋ token 合計＋ Triage 開題／已答（wa_* 題）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequest } from "@/lib/api/errors";
import { computeStats, parseRange, type WaStats } from "./stats";
import { addDays, hkDateOf } from "./dates";

const METRIC_DAYS_MAX = 90;
const MAX_GROUPS = 30;

interface WaMetrics {
  received: number;
  filtered: number;
  /** WA-7：filtered 之中純圖片（media_only） */
  filtered_media_only: number;
  parsed: number;
  /** 解析後判定「建議自動」嘅 intent 數 */
  auto_judged: number;
  /** 實際自動寫入（待批＋已批＋已拒） */
  auto_written: number;
  pending: number;
  approved: number;
  rejected: number;
  triage_opened: number;
  triage_answered: number;
  consistency_rate: number | null;
  llm_calls: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  errors: number;
}

interface WaGroupMetrics extends WaMetrics {
  group_id: string | null;
  label: string;
}

export interface WaMetricsResult {
  days: number;
  from: string;
  to: string;
  totals: WaMetrics;
  groups: WaGroupMetrics[];
}

export function parseDays(raw: string | null): number {
  if (raw === null || raw === "") return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > METRIC_DAYS_MAX) throw BadRequest(`days 要係 1–${METRIC_DAYS_MAX} 嘅整數`);
  return n;
}

function pick(s: WaStats, tokens: { in: number; out: number }, triage: { opened: number; answered: number }): WaMetrics {
  return {
    received: s.received,
    filtered: s.filtered,
    filtered_media_only: s.filtered_media_only,
    parsed: s.parsed,
    auto_judged: s.auto_write,
    auto_written: s.auto_results.written,
    pending: s.auto_results.pending,
    approved: s.auto_results.approved,
    rejected: s.auto_results.rejected,
    triage_opened: triage.opened,
    triage_answered: triage.answered,
    consistency_rate: s.consistency_rate,
    llm_calls: s.parsed,
    llm_tokens_in: tokens.in,
    llm_tokens_out: tokens.out,
    errors: s.errors,
  };
}

/** 每個 chat_jid 嘅 Triage 開題／已答（wa_* 題，經 evidence 內 message_id 連去訊息所屬群）。 */
async function triageByChat(start: Date, end: Date): Promise<Map<string, { opened: number; answered: number }>> {
  const rows = await prisma.$queryRaw<{ chat_jid: string; opened: bigint; answered: bigint }[]>(Prisma.sql`
    SELECT m.chat_jid AS chat_jid,
           count(*) FILTER (WHERE q.created_at >= ${start} AND q.created_at < ${end}) AS opened,
           count(*) FILTER (WHERE q.status = 'answered' AND q.answered_at >= ${start} AND q.answered_at < ${end}) AS answered
    FROM triage_questions q
    JOIN whatsapp_messages m ON m.message_id = q.evidence_json->'message'->>'message_id'
    WHERE q.kind LIKE 'wa\\_%'
      AND ((q.created_at >= ${start} AND q.created_at < ${end}) OR (q.answered_at >= ${start} AND q.answered_at < ${end}))
    GROUP BY m.chat_jid`);
  return new Map(rows.map((r) => [r.chat_jid, { opened: Number(r.opened), answered: Number(r.answered) }]));
}

export async function computeMetrics(days: number, now: Date = new Date()): Promise<WaMetricsResult> {
  const to = hkDateOf(now);
  const from = addDays(to, -(days - 1));
  const range = parseRange(from, to, now);
  const [triage, tokenRows] = await Promise.all([
    triageByChat(range.start, range.end),
    prisma.whatsappMessage.groupBy({ by: ["chatJid"], where: { ts: { gte: range.start, lt: range.end } }, _sum: { llmTokensIn: true, llmTokensOut: true }, _count: { _all: true }, orderBy: { chatJid: "asc" } }),
  ]);
  const sumTok = (jid: string | null) => {
    let i = 0;
    let o = 0;
    for (const r of tokenRows) if (jid === null || r.chatJid === jid) { i += r._sum.llmTokensIn ?? 0; o += r._sum.llmTokensOut ?? 0; }
    return { in: i, out: o };
  };
  const sumTri = (jid: string | null) => {
    let a = 0;
    let b = 0;
    for (const [k, v] of triage) if (jid === null || k === jid) { a += v.opened; b += v.answered; }
    return { opened: a, answered: b };
  };
  const totals = pick(await computeStats(range, null), sumTok(null), sumTri(null));
  const jids = [...new Set([...tokenRows.map((r) => r.chatJid), ...triage.keys()])].sort().slice(0, MAX_GROUPS);
  const groupRows = jids.length ? await prisma.whatsappGroup.findMany({ where: { groupJid: { in: jids } }, select: { id: true, groupJid: true, label: true } }) : [];
  const byJid = new Map(groupRows.map((g) => [g.groupJid, g]));
  const groups: WaGroupMetrics[] = [];
  for (const jid of jids) {
    const g = byJid.get(jid);
    groups.push({ group_id: g?.id ?? null, label: g?.label || "（未登記群組）", ...pick(await computeStats(range, jid), sumTok(jid), sumTri(jid)) });
  }
  groups.sort((a, b) => b.received - a.received || a.label.localeCompare(b.label));
  return { days, from, to, totals, groups };
}
