// W5：運維指標（server-only）。近 N 日（香港日曆日，含今日）整體＋按群細分；全部係數字，唔含 PII／原文。
// 數據源：computeStats（收／過濾／解析／判定／自動寫入結果／一致率／錯誤）＋ token 合計＋ Triage 開題／已答（wa_* 題）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequest } from "@/lib/api/errors";
import { computeStats, parseRange, type WaStats } from "./stats";
import { addDays, hkDateOf } from "./dates";
import { waCardPrices } from "./card-prices";

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
  /** WA-8 工卡相：收到嘅工卡相／全自動（冇分流題）／出分流題／失敗（過期＋讀唔到）／用過仲裁嘅相／預估成本（USD；冇設單價＝null） */
  card_photos: number;
  card_ok: number;
  card_triage: number;
  card_fail: number;
  card_arbiter: number;
  card_cost_est: number | null;
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

export interface CardCounts {
  photos: number;
  ok: number;
  triage: number;
  fail: number;
  arbiter: number;
  cost: number | null;
}
const EMPTY_CARD: CardCounts = { photos: 0, ok: 0, triage: 0, fail: 0, arbiter: 0, cost: null };

/** 每個 chat_jid 嘅工卡相計數＋預估成本（只睇 parsed_json.card 嘅計數／引擎名／token；冇任何工號、姓名）。 */
async function cardByChat(start: Date, end: Date): Promise<Map<string, CardCounts>> {
  const rows = await prisma.$queryRaw<{ chat_jid: string; photos: bigint; ok: bigint; triage: bigint; fail: bigint; arbiter: bigint }[]>(Prisma.sql`
    SELECT m.chat_jid AS chat_jid,
           count(*) AS photos,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM whatsapp_intents i WHERE i.message_id = m.message_id AND i.message_revision = m.revision AND i.routed = 'triage')) AS ok,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_intents i WHERE i.message_id = m.message_id AND i.message_revision = m.revision AND i.routed = 'triage')) AS triage,
           count(*) FILTER (WHERE m.parsed_json->'card'->>'kind' IN ('expired','unreadable')) AS fail,
           count(*) FILTER (WHERE m.parsed_json->'card'->>'arbiter' IS NOT NULL) AS arbiter
    FROM whatsapp_messages m
    WHERE m.llm_provider = 'card' AND m.ts >= ${start} AND m.ts < ${end}
    GROUP BY m.chat_jid`);
  const use = await prisma.$queryRaw<{ chat_jid: string; engine: string; p: bigint; c: bigint }[]>(Prisma.sql`
    SELECT m.chat_jid AS chat_jid, u->>'engine' AS engine, COALESCE(sum((u->>'prompt')::bigint),0) AS p, COALESCE(sum((u->>'completion')::bigint),0) AS c
    FROM whatsapp_messages m, jsonb_array_elements(CASE WHEN jsonb_typeof(m.parsed_json->'card'->'usage') = 'array' THEN m.parsed_json->'card'->'usage' ELSE '[]'::jsonb END) u
    WHERE m.llm_provider = 'card' AND m.ts >= ${start} AND m.ts < ${end}
    GROUP BY m.chat_jid, u->>'engine'`);
  const prices = waCardPrices();
  const out = new Map<string, CardCounts>();
  for (const r of rows) out.set(r.chat_jid, { photos: Number(r.photos), ok: Number(r.ok), triage: Number(r.triage), fail: Number(r.fail), arbiter: Number(r.arbiter), cost: Object.keys(prices).length ? 0 : null });
  for (const u of use) {
    const cur = out.get(u.chat_jid);
    const pr = prices[u.engine];
    if (cur && pr && cur.cost !== null) cur.cost += (Number(u.p) * pr.in + Number(u.c) * pr.out) / 1e6;
  }
  for (const v of out.values()) if (v.cost !== null) v.cost = Math.round(v.cost * 10000) / 10000;
  return out;
}

function pick(s: WaStats, tokens: { in: number; out: number }, triage: { opened: number; answered: number }, card: CardCounts = EMPTY_CARD): WaMetrics {
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
    card_photos: card.photos,
    card_ok: card.ok,
    card_triage: card.triage,
    card_fail: card.fail,
    card_arbiter: card.arbiter,
    card_cost_est: card.cost,
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
  const [triage, tokenRows, cards] = await Promise.all([
    triageByChat(range.start, range.end),
    prisma.whatsappMessage.groupBy({ by: ["chatJid"], where: { ts: { gte: range.start, lt: range.end } }, _sum: { llmTokensIn: true, llmTokensOut: true }, _count: { _all: true }, orderBy: { chatJid: "asc" } }),
    cardByChat(range.start, range.end),
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
  const sumCard = (): CardCounts => {
    const t: CardCounts = { photos: 0, ok: 0, triage: 0, fail: 0, arbiter: 0, cost: null };
    for (const v of cards.values()) {
      t.photos += v.photos;
      t.ok += v.ok;
      t.triage += v.triage;
      t.fail += v.fail;
      t.arbiter += v.arbiter;
      if (v.cost !== null) t.cost = (t.cost ?? 0) + v.cost;
    }
    if (t.cost !== null) t.cost = Math.round(t.cost * 10000) / 10000;
    return t;
  };
  const totals = pick(await computeStats(range, null), sumTok(null), sumTri(null), sumCard());
  const jids = [...new Set([...tokenRows.map((r) => r.chatJid), ...triage.keys(), ...cards.keys()])].sort().slice(0, MAX_GROUPS);
  const groupRows = jids.length ? await prisma.whatsappGroup.findMany({ where: { groupJid: { in: jids } }, select: { id: true, groupJid: true, label: true } }) : [];
  const byJid = new Map(groupRows.map((g) => [g.groupJid, g]));
  const groups: WaGroupMetrics[] = [];
  for (const jid of jids) {
    const g = byJid.get(jid);
    groups.push({ group_id: g?.id ?? null, label: g?.label || "（未登記群組）", ...pick(await computeStats(range, jid), sumTok(jid), sumTri(jid), cards.get(jid)) });
  }
  groups.sort((a, b) => b.received - a.received || a.label.localeCompare(b.label));
  return { days, from, to, totals, groups };
}
