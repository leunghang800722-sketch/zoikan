// W1：單條訊息處理流水線（server-only）：過濾 → LLM 解析 → 程式碼配對 → 寫 whatsapp_intents。
// 只記錄「建議」（routed 判定），唔寫 shift_records、唔開 Triage 題。
// 一律喺最後一個 transaction 落結果；中途失敗 → parse_attempts+1，3 次後 status=error（原因碼，唔含原文）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { LlmUnavailableError, type LlmClient } from "@/lib/ai/llm";
import type { SiteNameCandidate } from "@/lib/month-close/auto/site-match";
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { scoreMessage } from "./filter";
import { parseMessage, type ParsedIntent } from "./parse";
import { resolveIntents, type ResolvedIntent } from "./resolve";
import { createPrismaResolveRepo } from "./repo";
import { isoToDbDate } from "./dates";
import { shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";
import { createWaQuestionsTx, notifyWaTriage, supersedeWaQuestions, type WaTriageResult } from "./triage";
import { TRIAGE_LOCK } from "@/lib/triage/session";

const WA_MAX_ATTEMPTS = 3;
const QUOTE_WINDOW_MS = 24 * 3600 * 1000;

export interface RunContext {
  sites: SiteNameCandidate[];
  index: GuardMatchIndex;
  /** 測試／特殊用途注入；冇就用 waLlmChain()。 */
  llm?: LlmClient[];
}

export type ProcessOutcome = "skipped" | "ignored" | "routed" | "retry" | "error" | "stale";

export interface ProcessStats {
  intents: number;
  autoWrite: number;
  triage: number;
  ignoredIntents: number;
  llmIn: number;
  llmOut: number;
}

function emptyStats(): ProcessStats {
  return { intents: 0, autoWrite: 0, triage: 0, ignoredIntents: 0, llmIn: 0, llmOut: 0 };
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export async function loadRunContext(): Promise<Omit<RunContext, "llm">> {
  const { loadGuardMatchIndex } = await import("@/lib/roster-upload/guard-index");
  const [sites, index] = await Promise.all([
    prisma.site.findMany({ where: { status: { in: ["active", "paused"] } }, select: { id: true, canonicalName: true, aliases: true } }),
    loadGuardMatchIndex(prisma),
  ]);
  return { sites: sites.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases })), index };
}

function rowFor(messageId: string, revision: number, idx: number, r: ResolvedIntent): Prisma.WhatsappIntentCreateManyInput {
  return {
    messageId,
    messageRevision: revision,
    idx,
    kind: r.kind,
    workDate: r.workDate ? isoToDbDate(r.workDate) : null,
    siteId: r.siteId,
    guardId: r.guardId,
    shiftTypeId: r.shiftTypeId,
    leaveCode: r.leaveCode,
    hours: r.hours,
    confidence: Number.isFinite(r.confidence) ? Math.round(r.confidence * 1000) / 1000 : null,
    resolution: toJson(r.resolution),
    routed: r.routed,
  };
}

export async function failAttempt(id: string, revision: number, code: string): Promise<ProcessOutcome> {
  const cur = await prisma.whatsappMessage.findUnique({ where: { id }, select: { parseAttempts: true, revision: true, status: true } });
  if (!cur || cur.revision !== revision || cur.status !== "received") return "stale";
  const attempts = cur.parseAttempts + 1;
  const giveUp = attempts >= WA_MAX_ATTEMPTS;
  await prisma.whatsappMessage.updateMany({
    where: { id, revision, status: "received" },
    data: giveUp ? { parseAttempts: attempts, status: "error", error: code } : { parseAttempts: attempts, error: code },
  });
  return giveUp ? "error" : "retry";
}

/** 處理一條 status=received 嘅訊息。 */
export async function processWhatsappMessage(messageRowId: string, ctx: RunContext, stats: ProcessStats = emptyStats()): Promise<ProcessOutcome> {
  const msg = await prisma.whatsappMessage.findUnique({ where: { id: messageRowId } });
  if (!msg || msg.status !== "received" || msg.revokedAt) return "skipped";
  const rev = msg.revision;
  const group = await prisma.whatsappGroup.findUnique({ where: { groupJid: msg.chatJid } });

  const ignoreNow = async (reason: string, score: number, reasons: string[], extra: Prisma.WhatsappMessageUncheckedUpdateManyInput = {}): Promise<ProcessOutcome> => {
    return prisma.$transaction(async (tx) => {
      const u = await tx.whatsappMessage.updateMany({
        where: { id: msg.id, revision: rev, status: "received" },
        data: { status: "ignored", ignoreReason: reason, filterScore: score, filterReasons: reasons, parseAttempts: 0, error: null, ...extra },
      });
      if (u.count === 0) return "stale" as const;
      // 編輯後新 revision 被過濾／雜訊：舊 revision 嘅 intents 一樣標被取代
      await tx.whatsappIntent.updateMany({ where: { messageId: msg.messageId, messageRevision: { lt: rev }, supersededByRevision: null }, data: { supersededByRevision: rev } });
      // W2：舊 revision 嘅 open 分診題一併作廢（新 revision 被過濾／雜訊＝冇新題）
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
      await supersedeWaQuestions(tx, msg.messageId, rev);
      return "ignored" as const;
    });
  };

  const siteNames: string[] = [];
  if (group?.kind === "site" && group.siteId) {
    const s = ctx.sites.find((x) => x.id === group.siteId);
    if (s) siteNames.push(s.canonicalName, ...s.aliases);
  } else if (group) {
    for (const s of ctx.sites) siteNames.push(s.canonicalName, ...s.aliases);
  }

  let quotedText: string | null = null;
  if (msg.quotedMessageId) {
    const q = await prisma.whatsappMessage.findFirst({
      where: { messageId: msg.quotedMessageId, chatJid: msg.chatJid, revokedAt: null, redactedAt: null, ts: { gte: new Date(msg.ts.getTime() - QUOTE_WINDOW_MS), lte: msg.ts } },
      select: { text: true },
    });
    quotedText = q?.text || null;
  }

  const filtered = scoreMessage({
    text: msg.text,
    quotedText,
    groupKind: group ? group.kind : null,
    groupActive: group ? group.active : undefined,
    siteAliases: siteNames,
    senderKnown: msg.senderGuardId !== null,
    threshold: group?.filterThreshold ?? null,
  });
  if (filtered.decision === "ignore") {
    const reason = filtered.reasons.includes("group_unbound") ? "group_unbound" : filtered.reasons.includes("group_ignored") ? "group_ignored" : "filtered_out";
    return ignoreNow(reason, filtered.score, filtered.reasons);
  }
  if (!group) return ignoreNow("group_unbound", 0, ["group_unbound"]);

  // ---- 第 1 層：LLM
  const shiftTable: Array<{ code: string; label: string | null; time: string | null }> = [];
  if (group.kind === "site" && group.siteId) {
    const types = await prisma.shiftType.findMany({ where: { siteId: group.siteId, voidedAt: null }, select: { code: true, label: true, startTime: true, endTime: true }, orderBy: [{ code: "asc" }] });
    for (const t of types) {
      const slot = shiftTypeTimeSlot(t.startTime, t.endTime);
      shiftTable.push({ code: t.code, label: t.label, time: slot ? `${slot.slice(0, 2)}:${slot.slice(2, 4)}-${slot.slice(5, 7)}:${slot.slice(7, 9)}` : null });
    }
  }
  const wordMap = (group.shiftWordMap && typeof group.shiftWordMap === "object" && !Array.isArray(group.shiftWordMap) ? group.shiftWordMap : {}) as Record<string, string>;

  let parsed;
  try {
    parsed = await parseMessage({ text: msg.text, ts: msg.ts, groupKind: group.kind, shiftTable, wordMap, quotedText }, ctx.llm);
  } catch (e) {
    return failAttempt(msg.id, rev, e instanceof LlmUnavailableError ? "llm_unavailable" : "parse_failed");
  }
  stats.llmIn += parsed.usage.tokensIn;
  stats.llmOut += parsed.usage.tokensOut;
  const llmFields = { llmProvider: parsed.usage.provider, llmModel: parsed.usage.model, llmTokensIn: parsed.usage.tokensIn, llmTokensOut: parsed.usage.tokensOut };

  if (parsed.ok && parsed.output.noise && parsed.output.intents.length === 0) {
    return ignoreNow("llm_noise", filtered.score, filtered.reasons, { ...llmFields, parsedJson: toJson(parsed.output) });
  }

  // ---- 程式碼配對
  let resolved: ResolvedIntent[];
  try {
    const intents: ParsedIntent[] = parsed.ok ? parsed.output.intents : [];
    const resolveCtx = {
      ts: msg.ts,
      group: { id: group.id, kind: group.kind, siteId: group.siteId, brokerId: group.brokerId, shiftWordMap: wordMap, autoWrite: group.autoWrite },
      senderGuardId: msg.senderGuardId,
      senderTelNorm: msg.senderTelNorm,
      sites: ctx.sites,
      index: ctx.index,
      repo: createPrismaResolveRepo(),
    };
    if (!parsed.ok || intents.length === 0) {
      const reason = parsed.ok ? "llm_no_intent" : "llm_bad_output";
      resolved = [
        {
          kind: "unclear",
          workDate: null,
          siteId: null,
          guardId: null,
          shiftTypeId: null,
          leaveCode: null,
          hours: null,
          confidence: 0,
          resolution: { type: "unclear", reasons: ["unclear"], notes: [reason], basis: {}, candidates: {}, group_id: group.id, group_auto_write: group.autoWrite },
          routed: "triage",
        },
      ];
    } else {
      resolved = await resolveIntents(intents, resolveCtx);
    }
  } catch {
    return failAttempt(msg.id, rev, "resolve_failed");
  }

  // ---- 落結果（單一 transaction；訊息期間被編輯／撤回 → stale，下一輪用新 revision 重來）
  // W2：同一 tx 內即時開 Triage 題（routed=triage 嘅 intent 一題；舊 revision 嘅 open 題 superseded）。
  let tri: WaTriageResult | null = null;
  const outcome = await prisma.$transaction(async (tx) => {
    const u = await tx.whatsappMessage.updateMany({
      where: { id: msg.id, revision: rev, status: "received", revokedAt: null },
      data: {
        status: "routed",
        ignoreReason: null,
        filterScore: filtered.score,
        filterReasons: filtered.reasons,
        parsedJson: parsed.ok ? toJson(parsed.output) : toJson({ error: parsed.error }),
        parseAttempts: 0,
        error: null,
        ...llmFields,
      },
    });
    if (u.count === 0) return "stale" as const;
    await tx.whatsappIntent.updateMany({ where: { messageId: msg.messageId, messageRevision: { lt: rev }, supersededByRevision: null }, data: { supersededByRevision: rev } });
    await tx.whatsappIntent.deleteMany({ where: { messageId: msg.messageId, messageRevision: rev } });
    const created = await tx.whatsappIntent.createManyAndReturn({ data: resolved.map((r, i) => rowFor(msg.messageId, rev, i, r)) });
    const byIdx = [...created].sort((a, b) => a.idx - b.idx);
    tri = await createWaQuestionsTx(tx, {
      msg: { messageId: msg.messageId, revision: rev, ts: msg.ts, chatJid: msg.chatJid, text: msg.text, senderGuardId: msg.senderGuardId, senderTelNorm: msg.senderTelNorm },
      group: { id: group.id, label: group.label, kind: group.kind, siteId: group.siteId },
      rows: byIdx.map((r) => ({ id: r.id, idx: r.idx, kind: r.kind, workDate: r.workDate, siteId: r.siteId, guardId: r.guardId, shiftTypeId: r.shiftTypeId, leaveCode: r.leaveCode, confidence: r.confidence === null ? null : Number(r.confidence), resolution: r.resolution, routed: r.routed })),
      srcs: byIdx.map((r) => resolved[r.idx]?.src),
    });
    return "routed" as const;
  });
  const made = tri as WaTriageResult | null;
  if (outcome === "routed" && made && made.created > 0 && made.sessionId && made.ownerUserId) await notifyWaTriage(made.ownerUserId, made.sessionId, made.created, msg.ts);
  if (outcome === "routed") {
    for (const r of resolved) {
      stats.intents++;
      if (r.routed === "auto_write") stats.autoWrite++;
      else if (r.routed === "triage") stats.triage++;
      else stats.ignoredIntents++;
    }
  }
  return outcome;
}

/** 已撤回訊息嘅 intents 標 revoked_at（冪等）。 */
export async function markRevokedIntents(now: Date): Promise<number> {
  const r = await prisma.whatsappIntent.updateMany({ where: { revokedAt: null, message: { revokedAt: { not: null } } }, data: { revokedAt: now } });
  return r.count;
}
