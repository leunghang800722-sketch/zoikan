// W1：單條訊息處理流水線（server-only）：過濾 → LLM 解析 → 程式碼配對 → 寫 whatsapp_intents。
// 只記錄「建議」（routed 判定），唔寫 shift_records、唔開 Triage 題。
// 一律喺最後一個 transaction 落結果；中途失敗 → parse_attempts+1，3 次後 status=error（原因碼，唔含原文）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { LlmUnavailableError, type LlmClient } from "@/lib/ai/llm";
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { scoreMessage } from "./filter";
import { parseMessage, type ParsedIntent } from "./parse";
import { resolveIntents, type ResolvedIntent, type WaSite } from "./resolve";
import { createPrismaResolveRepo } from "./repo";
import { hkDateOf, isoToDbDate } from "./dates";
import { shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";
import { createWaQuestionsTx, notifyWaTriage, supersedeWaQuestions, type WaTriageResult } from "./triage";
import { TRIAGE_LOCK } from "@/lib/triage/session";
import { ensureSystemUser } from "@/lib/system-user";
import { journalAutoCardUsesSafe, type AutoCardUse } from "@/lib/pricing/auto-card-journal";
import { autoWriteIntentsTx } from "./autowrite";
import { readCardPhoto, cardStrategyFromEnv } from "./card-ocr";
import type { CardEngine, CardEngineName } from "./card-engines";
import { resolveCardPhoto, type CardInput } from "./card-resolve";
import { deleteMediaEvidence, loadMediaEvidence } from "./media";
import { detectRosterList, detectRosterPlan } from "./roster-list";
import { prismaRosterDeps, resolveRosterList } from "./roster-resolve";
import { nameViewOf, textHasKnownName } from "./name-index";
import { classifyText, normalizeReportText } from "./report-kinds";
import { applyCheckout, leaveNoticeIntents, substitutionIntents } from "./kind-resolve";
import { normNameVariant } from "@/lib/names/variants";
import { crossCheckWithRoster } from "./roster-crosscheck";
import { applySourceChangeTx, staleEditedPendingIds } from "./source-change";

const WA_MAX_ATTEMPTS = 3;
const QUOTE_WINDOW_MS = 24 * 3600 * 1000;

export interface RunContext {
  sites: WaSite[];
  index: GuardMatchIndex;
  /** 測試／特殊用途注入；冇就用 waLlmChain()。 */
  llm?: LlmClient[];
  /** WA-8：測試注入工卡辨識引擎（冇＝createEngine 真引擎） */
  cardEngines?: Partial<Record<CardEngineName, CardEngine>>;
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
    prisma.site.findMany({ where: { status: { in: ["active", "paused"] } }, select: { id: true, canonicalName: true, aliases: true, clientName: true, clientGroup: true, defaultSettlementBrokerId: true } }),
    loadGuardMatchIndex(prisma),
  ]);
  return { sites: sites.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases, client: s.clientGroup ?? s.clientName, brokerId: s.defaultSettlementBrokerId })), index };
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
  if (!giveUp) {
    await prisma.whatsappMessage.updateMany({ where: { id, revision, status: "received" }, data: { parseAttempts: attempts, error: code } });
    return "retry";
  }
  // S1：編輯後新 revision 3 次都處理失敗 → 舊 revision 嘅 pending 記錄保留，開一條 wa_unparsed 題（人手決定）
  const u = await prisma.whatsappMessage.updateMany({ where: { id, revision, status: "received" }, data: { parseAttempts: attempts, status: "error", error: code } });
  if (u.count === 0 || revision <= 1) return "error";
  let tri: WaTriageResult | null = null;
  // 開題係 best-effort（失敗唔影響 status=error 已落）
  const done = await prisma.$transaction(async (tx) => {
    const msg = await tx.whatsappMessage.findUniqueOrThrow({ where: { id } });
    const group = await tx.whatsappGroup.findUnique({ where: { groupJid: msg.chatJid } });
    if (!group) return false;
    const old = await tx.shiftRecord.findMany({ where: { source: "whatsapp", status: "pending_approval", provenance: { path: ["message_id"], equals: msg.messageId } }, select: { provenance: true } });
    if (!old.some((r) => typeof (r.provenance as { revision?: unknown } | null)?.revision === "number" && (r.provenance as { revision: number }).revision < revision)) return false;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
    await tx.whatsappIntent.deleteMany({ where: { messageId: msg.messageId, messageRevision: revision } });
    const row = await tx.whatsappIntent.create({
      data: {
        messageId: msg.messageId,
        messageRevision: revision,
        idx: 0,
        kind: "unclear",
        confidence: 0,
        resolution: { type: "unclear", reasons: ["unclear", "source_edited_failed"], notes: ["source_edited_process_failed"], basis: {}, candidates: {}, group_id: group.id, group_auto_write: group.autoWrite },
        routed: "triage",
      },
    });
    tri = await createWaQuestionsTx(tx, {
      msg: { messageId: msg.messageId, revision, ts: msg.ts, chatJid: msg.chatJid, text: msg.text, senderGuardId: msg.senderGuardId, senderTelNorm: msg.senderTelNorm },
      group: { id: group.id, label: group.label, kind: group.kind, siteId: group.siteId },
      rows: [{ id: row.id, idx: 0, kind: "unclear", workDate: null, siteId: null, guardId: null, shiftTypeId: null, leaveCode: null, confidence: 0, resolution: row.resolution, routed: "triage" }],
      srcs: [undefined],
    });
    return true;
  }).catch(() => false);
  const made = tri as WaTriageResult | null;
  if (done && made && made.created > 0 && made.sessionId && made.ownerUserId) await notifyWaTriage(made.ownerUserId, made.sessionId, made.created, new Date());
  return "error";
}

/** 判頭群 assume_today 每群每日送 LLM 上限；env WA_ASSUME_TODAY_DAILY_CAP 嚴格 ^\\d+$、1–1000，其他一律預設 30。 */
function assumeTodayCap(): number {
  const raw = process.env.WA_ASSUME_TODAY_DAILY_CAP;
  if (raw === undefined || !/^\d+$/.test(raw)) return 30;
  const n = Number(raw);
  return n >= 1 && n <= 1000 ? n : 30;
}

/** 處理一條 status=received 嘅訊息。 */
export async function processWhatsappMessage(messageRowId: string, ctx: RunContext, stats: ProcessStats = emptyStats()): Promise<ProcessOutcome> {
  const msg = await prisma.whatsappMessage.findUnique({ where: { id: messageRowId } });
  if (!msg || msg.status !== "received" || msg.revokedAt) return "skipped";
  const rev = msg.revision;
  const group = await prisma.whatsappGroup.findUnique({ where: { groupJid: msg.chatJid } });
  // W3（S1）：編輯後新 revision——舊 revision 已寫嘅 pending 記錄**同新結果同一個 tx** 先取消（唔可以先取消再解析：
  // 解析失敗會變成舊記錄冇咗、新記錄又冇）。resolve 時將呢批舊記錄當「唔存在」（唔當已存在／額滿）；已確認嘅只標示。
  const staleIds = await staleEditedPendingIds(msg.messageId, rev);
  const editActor = rev > 1 ? await ensureSystemUser() : "";

  const ignoreNow = async (reason: string, score: number, reasons: string[], extra: Prisma.WhatsappMessageUncheckedUpdateManyInput = {}): Promise<ProcessOutcome> => {
    return prisma.$transaction(async (tx) => {
      const u = await tx.whatsappMessage.updateMany({
        where: { id: msg.id, revision: rev, status: "received" },
        data: { status: "ignored", ignoreReason: reason, filterScore: score, filterReasons: reasons, parseAttempts: 0, error: null, ...extra },
      });
      if (u.count === 0) return "stale" as const;
      if (rev > 1) await applySourceChangeTx(tx, { messageId: msg.messageId, belowRevision: rev, reason: "source_message_edited", actorUserId: editActor });
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
    mediaType: msg.mediaType ?? null,
    cardPhotoMode: group?.cardPhotoMode ?? false,
    ts: msg.ts,
    nameHit: group?.kind === "broker" ? textHasKnownName(ctx.index, msg.text) : false,
  });
  if (filtered.decision === "ignore") {
    const reason = filtered.reasons.includes("group_unbound") ? "group_unbound" : filtered.reasons.includes("group_ignored") ? "group_ignored" : "filtered_out";
    return ignoreNow(reason, filtered.score, filtered.reasons);
  }
  if (!group) return ignoreNow("group_unbound", 0, ["group_unbound"]);
  // WA-9 (7)：判頭群 assume_today 會把閒聊（盤名＋「上班」）送去 LLM → 每群每日上限（env WA_ASSUME_TODAY_DAILY_CAP，預設 30），超過降級 ignore
  if (filtered.reasons.includes("assume_today")) {
    const cap = assumeTodayCap();
    const dayStart = new Date(`${hkDateOf(msg.ts)}T00:00:00+08:00`);
    const used = await prisma.whatsappMessage.count({ where: { chatJid: msg.chatJid, id: { not: msg.id }, status: { not: "received" }, OR: [{ ignoreReason: null }, { ignoreReason: { not: "assume_today_cap" } }], filterReasons: { array_contains: ["assume_today"] }, ts: { gte: dayStart, lt: new Date(dayStart.getTime() + 24 * 3600 * 1000) } } });
    if (used >= cap) return ignoreNow("assume_today_cap", filtered.score, [...filtered.reasons, "assume_today_capped"]);
  }

  // ---- WA-8：工卡相（群組開咗 card_photo_mode + 圖片訊息）：辨識 → 歸屬（唔經 LLM 解析文字）
  // WA-9：文字名單（filter 已命中 roster_list）——純 code，唔 call LLM，直接砌 N 條 shift intents
  const nameKnown = nameViewOf(ctx.index).known;
  const rosterList = filtered.reasons.includes("roster_list") && !msg.mediaType ? detectRosterList(msg.text, msg.ts, { knownNames: nameKnown }) : null;
  const rosterPlan = !rosterList && filtered.reasons.includes("roster_plan") && !msg.mediaType ? detectRosterPlan(msg.text, msg.ts, { knownNames: nameKnown }) : null;
  const TEXT_KIND_REASONS = ["name_shift_caption", "substitution_notice", "leave_notice", "attendance_summary"];
  const textKind = !rosterList && !rosterPlan && filtered.reasons.some((r) => TEXT_KIND_REASONS.includes(r)) ? classifyText(msg.text) : null;
  const cardMode = !rosterList && !rosterPlan && !textKind && group.cardPhotoMode && (msg.mediaType === "image" || msg.mediaType === "unknown");
  let resolved: ResolvedIntent[];
  let parsedJson: Prisma.InputJsonValue;
  let llmFields: Prisma.WhatsappMessageUncheckedUpdateManyInput = {};
  const wmOf = (v: unknown): Record<string, string> => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, string>;
  const mkResolveCtx = (g: NonNullable<typeof group>) => ({
    ts: msg.ts,
    group: { id: g.id, kind: g.kind, siteId: g.siteId, brokerId: g.brokerId, shiftWordMap: wmOf(g.shiftWordMap), leaveWordMap: wmOf(g.leaveWordMap), autoWrite: g.autoWrite },
    senderGuardId: msg.senderGuardId,
    senderTelNorm: msg.senderTelNorm,
    sites: ctx.sites,
    index: ctx.index,
    repo: createPrismaResolveRepo(staleIds),
  });
  if (rosterList) {
    try {
      const r = await resolveRosterList({ ctx: mkResolveCtx(group), list: rosterList, chatJid: msg.chatJid, messageId: msg.messageId, staleIds: new Set(staleIds) });
      resolved = r.resolved;
      // 只記計數／日期（唔記姓名）；指標用 llm_provider='roster'
      parsedJson = toJson({ roster: { ...r.stats, lists: 1, list_days: rosterList.days.length, confidence: rosterList.confidence } });
      llmFields = { llmProvider: "roster", llmModel: "roster-list", llmTokensIn: 0, llmTokensOut: 0 };
    } catch {
      return failAttempt(msg.id, rev, "roster_failed");
    }
  } else if (rosterPlan) {
    // 預定更表（日序名單）：唔建 shift、唔出題；只記計數（供日後 rosterOnly 對照）
    resolved = [];
    parsedJson = toJson({ roster_plan: { days: rosterPlan.days.length, names: rosterPlan.days.reduce((a, d) => a + d.names.length, 0), dates: rosterPlan.days.map((d) => d.date) } });
    llmFields = { llmProvider: "roster_plan", llmModel: "roster-plan", llmTokensIn: 0, llmTokensOut: 0 };
  } else if (textKind) {
    try {
      const rc = mkResolveCtx(group);
      llmFields = { llmProvider: "rule", llmModel: textKind.kind, llmTokensIn: 0, llmTokensOut: 0 };
      if (textKind.kind === "substitution") {
        resolved = await resolveIntents(substitutionIntents(textKind), rc);
        parsedJson = toJson({ rule: { kind: "substitution" } });
      } else if (textKind.kind === "leave_notice") {
        resolved = await resolveIntents(leaveNoticeIntents(textKind), rc);
        parsedJson = toJson({ rule: { kind: "leave_notice", days: textKind.days.length, month: textKind.month } });
      } else if (textKind.kind === "attendance_summary") {
        resolved = [];
        parsedJson = toJson({ rule: { kind: "attendance_summary", month: textKind.month, rest_days: textKind.rest_days.length, claimed: textKind.claimed } });
      } else if (textKind.kind === "name_caption") {
        const meta: Record<string, unknown> = { kind: "name_caption", action: textKind.action };
        if (textKind.action === "checkout") {
          const co = await applyCheckout({ ctx: rc, chatJid: msg.chatJid, name: textKind.name, deps: prismaRosterDeps() });
          resolved = [];
          Object.assign(meta, { matched: co.matched, updated: co.updated, note: co.note });
        } else {
          // 開工：caption 姓名係身份首要訊號；工卡相模式開住 → OCR 只做核對（姓名唔同先出題）
          const r = await resolveRosterList({
            ctx: rc,
            list: { kind: "roster_list", days: [{ date: null, date_raw: "今日", names: [{ raw: textKind.name, shift_hint: null }] }], header_lines: 0, confidence: "high" },
            chatJid: msg.chatJid,
            messageId: msg.messageId,
            staleIds: new Set(staleIds),
          });
          resolved = r.resolved;
          if (group.cardPhotoMode && (msg.mediaType === "image" || msg.mediaType === "unknown") && msg.mediaState === "stored") {
            const evd = await loadMediaEvidence(msg.messageId);
            if (evd) {
              const photo = await readCardPhoto(evd.bytes, { strategy: cardStrategyFromEnv(), today: hkDateOf(msg.ts), ...(ctx.cardEngines ? { engines: ctx.cardEngines } : {}) });
              for (const u of photo.usage) {
                stats.llmIn += u.promptTokens;
                stats.llmOut += u.completionTokens;
              }
              const read = photo.cards.flatMap((c) => (c.name_zh ? [c.name_zh] : []));
              const same = read.some((n) => normNameVariant(n) === normNameVariant(textKind.name));
              meta.ocr = { cards: photo.cards.length, named: read.length, same };
              if (read.length > 0 && !same) {
                for (const row of resolved) {
                  row.resolution.reasons = [...new Set([...row.resolution.reasons, "card_confirm"])];
                  row.routed = "triage";
                  row.src = { ...(row.src ?? { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null }), card: { media_id: evd.id, staff_no_read: null, name_zh_read: read[0] ?? null, name_en_read: null, votes: 0, index: 1, total: 1, arbiter: false, candidates: [] } };
                }
              }
            }
          }
        }
        parsedJson = toJson({ caption: meta });
      } else {
        resolved = [];
        parsedJson = toJson({ rule: { kind: textKind.kind } });
      }
    } catch {
      return failAttempt(msg.id, rev, "rule_failed");
    }
  } else if (cardMode) {
    try {
      const wm = (group.shiftWordMap && typeof group.shiftWordMap === "object" && !Array.isArray(group.shiftWordMap) ? group.shiftWordMap : {}) as Record<string, string>;
      const lw = (group.leaveWordMap && typeof group.leaveWordMap === "object" && !Array.isArray(group.leaveWordMap) ? group.leaveWordMap : {}) as Record<string, string>;
      const evd = msg.mediaState === "stored" ? await loadMediaEvidence(msg.messageId) : null;
      let input: CardInput;
      let meta: Record<string, unknown>;
      let tin = 0;
      let tout = 0;
      const strategy = cardStrategyFromEnv();
      if (!evd) {
        input = { kind: "dead", why: "expired" };
        meta = { kind: "expired" };
      } else {
        const photo = await readCardPhoto(evd.bytes, { strategy, today: hkDateOf(msg.ts), ...(ctx.cardEngines ? { engines: ctx.cardEngines } : {}) });
        input = { kind: "photo", photo };
        for (const u of photo.usage) {
          tin += u.promptTokens;
          tout += u.completionTokens;
        }
        // 只記計數／引擎名／token——絕不記工號、姓名、圖片內容
        meta = {
          kind: photo.kind,
          doc_type: photo.doc_type ?? null,
          strategy,
          cards: photo.cards.length,
          confirmed: photo.cards.filter((c) => c.status === "confirmed").length,
          review: photo.cards.filter((c) => c.status === "review").length,
          arbiter: photo.arbiter_used ? strategy : null,
          engines: photo.engines,
          usage: photo.usage.map((u) => ({ engine: u.engine, model: u.model, prompt: u.promptTokens, completion: u.completionTokens })),
        };
      }
      stats.llmIn += tin;
      stats.llmOut += tout;
      llmFields = { llmProvider: "card", llmModel: strategy, llmTokensIn: tin, llmTokensOut: tout };
      parsedJson = toJson({ card: meta });
      resolved = await resolveCardPhoto({
        ctx: {
          ts: msg.ts,
          group: { id: group.id, kind: group.kind, siteId: group.siteId, brokerId: group.brokerId, shiftWordMap: wm, leaveWordMap: lw, autoWrite: group.autoWrite },
          senderGuardId: msg.senderGuardId,
          senderTelNorm: msg.senderTelNorm,
          sites: ctx.sites,
          index: ctx.index,
          repo: createPrismaResolveRepo(staleIds),
        },
        input,
        mediaId: evd?.id ?? null,
      });
      // WA-9：同群同日有文字名單 → 相只做交叉核實（補 reported_time；差異一日一條合併題），冇名單先用相入面姓名做主要識別
      if (input.kind === "photo") {
        const x = await crossCheckWithRoster({ chatJid: msg.chatJid, day: hkDateOf(msg.ts), groupId: group.id, resolved, nameOfGuard: (g) => ctx.index.nameByGuardId.get(g) ?? null });
        if (x.hadRoster) {
          resolved = x.resolved;
          parsedJson = toJson({ card: { ...meta, roster_crosscheck: { matched: x.matched, photo_only: x.photoOnly, locked_month_skip: x.lockedSkipped } } });
        }
      }
    } catch {
      return failAttempt(msg.id, rev, "card_failed");
    }
  } else {
    // ---- 第 1 層：LLM
    const shiftTable: Array<{ code: string; label: string | null; time: string | null }> = [];
    if (group.kind === "site" && group.siteId) {
      const types = await prisma.shiftType.findMany({ where: { siteId: group.siteId, voidedAt: null }, select: { code: true, label: true, startTime: true, endTime: true }, orderBy: [{ code: "asc" }] });
      for (const t of types) {
        const slot = shiftTypeTimeSlot(t.startTime, t.endTime);
        shiftTable.push({ code: t.code, label: t.label, time: slot ? `${slot.slice(0, 2)}:${slot.slice(2, 4)}-${slot.slice(5, 7)}:${slot.slice(7, 9)}` : null });
      }
    }
    const leaveWordMap = (group.leaveWordMap && typeof group.leaveWordMap === "object" && !Array.isArray(group.leaveWordMap) ? group.leaveWordMap : {}) as Record<string, string>;
    const wordMap = (group.shiftWordMap && typeof group.shiftWordMap === "object" && !Array.isArray(group.shiftWordMap) ? group.shiftWordMap : {}) as Record<string, string>;

    let parsed;
    try {
      parsed = await parseMessage({ text: normalizeReportText(msg.text), ts: msg.ts, groupKind: group.kind, shiftTable, wordMap, quotedText }, ctx.llm);
    } catch (e) {
      return failAttempt(msg.id, rev, e instanceof LlmUnavailableError ? "llm_unavailable" : "parse_failed");
    }
    stats.llmIn += parsed.usage.tokensIn;
    stats.llmOut += parsed.usage.tokensOut;
    llmFields = { llmProvider: parsed.usage.provider, llmModel: parsed.usage.model, llmTokensIn: parsed.usage.tokensIn, llmTokensOut: parsed.usage.tokensOut };
    parsedJson = parsed.ok ? toJson(parsed.output) : toJson({ error: parsed.error });

    if (parsed.ok && parsed.output.noise && parsed.output.intents.length === 0) {
      return ignoreNow("llm_noise", filtered.score, filtered.reasons, { ...llmFields, parsedJson: toJson(parsed.output) });
    }
    // ---- 程式碼配對
    try {
      let intents: ParsedIntent[] = parsed.ok ? parsed.output.intents : [];
      // WA-9 (7)：判頭群「冇日期＝今日」——缺日期嘅 intent 補「今日」（凌晨沿用 resolveDates 降級）
      if (filtered.reasons.includes("assume_today")) intents = intents.map((i) => (i.date ? i : { ...i, date: { raw: "今日", kind: "relative" as const } }));
      const resolveCtx = {
        ts: msg.ts,
        group: { id: group.id, kind: group.kind, siteId: group.siteId, brokerId: group.brokerId, shiftWordMap: wordMap, leaveWordMap, autoWrite: group.autoWrite },
        senderGuardId: msg.senderGuardId,
        senderTelNorm: msg.senderTelNorm,
        sites: ctx.sites,
        index: ctx.index,
        repo: createPrismaResolveRepo(staleIds),
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

  }

  // ---- 落結果（單一 transaction；訊息期間被編輯／撤回 → stale，下一輪用新 revision 重來）
  // W2：同一 tx 內即時開 Triage 題（routed=triage 嘅 intent 一題；舊 revision 嘅 open 題 superseded）。
  let tri: WaTriageResult | null = null;
  // W3：群組開咗自動寫入 + 有 routed=auto_write 嘅 intent 先需要寫入身份（系統排程帳號）
  const needsActor = rev > 1 || group.autoWrite && resolved.some((r) => r.routed === "auto_write");
  const actorUserId = needsActor ? (editActor || (await ensureSystemUser())) : "";
  const autoCardUses: AutoCardUse[] = [];
  const outcome = await prisma.$transaction(async (tx) => {
    const u = await tx.whatsappMessage.updateMany({
      where: { id: msg.id, revision: rev, status: "received", revokedAt: null },
      data: {
        status: "routed",
        ignoreReason: null,
        filterScore: filtered.score,
        filterReasons: filtered.reasons,
        parsedJson,
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
    // S1：先喺同一 tx 取消舊 revision 嘅 pending 記錄，再（重）寫新結果
    if (rev > 1) await applySourceChangeTx(tx, { messageId: msg.messageId, belowRevision: rev, reason: "source_message_edited", actorUserId });
    // W3：自動寫入（同 tx；用 TRIAGE_LOCK 序列化每日上限／去重計數同 Triage 答題寫入）
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
    const aw = await autoWriteIntentsTx(tx, {
      msg: { messageId: msg.messageId, revision: rev, chatJid: msg.chatJid, senderJid: msg.senderJid, senderGuardId: msg.senderGuardId, ts: msg.ts },
      group: { id: group.id, autoWrite: group.autoWrite, autoConfirm: group.autoConfirm, autoWriteDailyCap: group.autoWriteDailyCap },
      rows: byIdx,
      actorUserId,
    });
    autoCardUses.push(...aw.autoCardUses);
    const finalRows = byIdx.map((r) => {
      const p = aw.patches.get(r.idx);
      return p ? { ...r, routed: p.routed, resolution: p.resolution as Prisma.JsonValue, resultRef: p.resultRef } : r;
    });
    for (const r of finalRows) {
      const p = aw.patches.get(r.idx);
      if (p) {
        resolved[r.idx]!.routed = p.routed;
        await tx.whatsappIntent.update({ where: { id: r.id }, data: { routed: p.routed, resolution: toJson(p.resolution), resultRef: p.resultRef } });
      }
    }
    tri = await createWaQuestionsTx(tx, {
      msg: { messageId: msg.messageId, revision: rev, ts: msg.ts, chatJid: msg.chatJid, text: msg.text, senderGuardId: msg.senderGuardId, senderTelNorm: msg.senderTelNorm },
      group: { id: group.id, label: group.label, kind: group.kind, siteId: group.siteId },
      rows: finalRows.map((r) => ({ id: r.id, idx: r.idx, kind: r.kind, workDate: r.workDate, siteId: r.siteId, guardId: r.guardId, shiftTypeId: r.shiftTypeId, leaveCode: r.leaveCode, confidence: r.confidence === null ? null : Number(r.confidence), resolution: r.resolution, routed: r.routed })),
      srcs: finalRows.map((r) => resolved[r.idx]?.src),
    });
    return "routed" as const;
  });
  if (outcome === "routed" && autoCardUses.length > 0) await journalAutoCardUsesSafe(autoCardUses);
  // WA-8：工卡相——冇任何分流題（全部自動寫入／已存在）就即時刪加密暫存圖；有題先留畀人睇（答完／TTL 先刪）
  if (outcome === "routed" && cardMode && !resolved.some((r) => r.routed === "triage")) await deleteMediaEvidence([msg.messageId]).catch(() => 0);
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
