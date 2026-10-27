// W2：由 whatsapp_intents（routed=triage）產生 Triage 題（計劃書 §6.3）。
//  - session：sourceType="whatsapp"，sourceRef=`<group_jid>:<YYYY-MM>`（每群每月一個；月＝訊息香港日所屬月）；
//    擁有人：群綁定盤口嘅「主管」（BrokerSiteAssignment → 該判頭名下、屬 TRIAGE_OWNER_ROLES 嘅啟用中用戶；
//    系統暫時冇「用戶↔盤」主管關係，通常揾唔到）→ 冇就老闆（最早建立、啟用中）。
//  - 每個 intent 一題；kind 按原因碼優先次序 unparsed > site > person > date > conflict；groupKey `<message_id>:<revision>:<idx>`（冪等）。
//  - 新 revision → 同一訊息舊 revision 嘅 open 題 superseded；撤回 → 全部 open 題 superseded。
//  - 同 tx 內執行（由 process.ts 呼叫），用全域 TRIAGE_LOCK 序列化。evidence 含原話（PII，只存 DB）。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureSystemUser } from "@/lib/system-user";
import { TRIAGE_OWNER_ROLES, TRIAGE_LOCK } from "@/lib/triage/session";
import { hkDateOf } from "./dates";
import type { IntentSrc } from "./resolve";
import { groupKeyOf, rosterMismatchKey, maxRoundsOf, optionsForWa, pickWaKind, sortOfTs, type WaEvidence, type WaIntentKind, type WaKind, type WaQuestionDraft } from "./triage-types";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** 訊息香港日所屬月（YYYY-MM）。 */
const hkMonthOf = (ts: Date): string => hkDateOf(ts).slice(0, 7);
const waSessionRef = (groupJid: string, ym: string): string => `${groupJid}:${ym}`;

/** 群綁定盤嘅負責人：揾唔到主管就老闆（最早建立、啟用中）；全部揾唔到先用系統帳號。 */
export async function pickWaOwner(db: Db, siteId: string | null): Promise<string> {
  if (siteId) {
    const assigned = await db.brokerSiteAssignment.findMany({ where: { siteId }, select: { brokerId: true }, distinct: ["brokerId"] });
    if (assigned.length > 0) {
      const u = await db.user.findFirst({
        where: { status: "active", brokerId: { in: assigned.map((a) => a.brokerId) }, role: { baseRole: { in: [...TRIAGE_OWNER_ROLES] } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (u) return u.id;
    }
  }
  const boss = await db.user.findFirst({ where: { status: "active", role: { baseRole: "老闆" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  if (boss) return boss.id;
  return ensureSystemUser();
}

export interface WaMessageCtx {
  messageId: string;
  revision: number;
  ts: Date;
  chatJid: string;
  text: string;
  senderGuardId: string | null;
  senderTelNorm: string | null;
}
export interface WaGroupCtx {
  id: string;
  label: string;
  kind: string;
  siteId: string | null;
}
export interface WaIntentRow {
  id: string;
  idx: number;
  kind: WaIntentKind;
  workDate: Date | null;
  siteId: string | null;
  guardId: string | null;
  shiftTypeId: string | null;
  leaveCode: string | null;
  confidence: number | null;
  resolution: unknown;
}

const EMPTY_SRC: IntentSrc = { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null };

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 純函數：一個 triage intent → 第 1 輪題目草稿。 */
function draftFromIntent(msg: WaMessageCtx, group: WaGroupCtx, row: WaIntentRow, src: IntentSrc | undefined): WaQuestionDraft {
  const res = (row.resolution ?? {}) as { reasons?: unknown; notes?: unknown; candidates?: Record<string, unknown> };
  const reasons = strArr(res.reasons);
  const cands = res.candidates ?? {};
  const workDate = row.workDate ? row.workDate.toISOString().slice(0, 10) : null;
  const tail = msg.senderTelNorm ? msg.senderTelNorm.slice(-4) : null;
  const ev: WaEvidence = {
    v: 1,
    wa: true,
    round: 1,
    message: { message_id: msg.messageId, revision: msg.revision, idx: row.idx, intent_id: row.id },
    group: { id: group.id, label: group.label, kind: group.kind },
    sent_at: msg.ts.toISOString(),
    sender: { guard_id: msg.senderGuardId, tel_tail4: tail },
    text: msg.text,
    intent: { kind: row.kind, work_date: workDate, site_id: row.siteId, guard_id: row.guardId, shift_type_id: row.shiftTypeId, leave_code: row.leaveCode, confidence: row.confidence },
    src: src ?? EMPTY_SRC,
    ...(src?.card ? { card: src.card } : {}),
    ...(src?.mismatch ? { mismatch: src.mismatch } : {}),
    ...(src?.dedupe_key ? { dedupe_key: src.dedupe_key } : {}),
    reasons,
    notes: strArr(res.notes),
    candidates: { guard_ids: strArr(cands.guard_ids), site_ids: strArr(cands.site_ids), dates: strArr(cands.dates), shift_type_ids: strArr(cands.shift_type_ids), existing_record_ids: strArr((res as { existing_record_ids?: unknown }).existing_record_ids) },
    human: {},
    ...(row.kind === "cover"
      ? {
          cover: {
            replaced_guard_id: typeof (res as { replaced_guard_id?: unknown }).replaced_guard_id === "string" ? ((res as { replaced_guard_id: string }).replaced_guard_id) : null,
            replaced_candidate_ids: strArr((res as { replaced_candidate_ids?: unknown }).replaced_candidate_ids),
            replaced_record_ids: strArr((res as { replaced_record_ids?: unknown }).replaced_record_ids),
          },
        }
      : {}),
    month: `${(workDate ?? hkDateOf(msg.ts)).slice(0, 7)}-01`,
  };
  return buildDraft(ev, group, msg.ts);
}

/** 由 evidence（已含 reasons／round）砌題目：kind 按優先次序；round>WA_MAX_ROUNDS 一律 wa_unparsed。 */
export function buildDraft(ev: WaEvidence, group: Pick<WaGroupCtx, "label">, ts: Date): WaQuestionDraft {
  const over = ev.round > maxRoundsOf(ev.intent.kind);
  const kind: WaKind = over ? "wa_unparsed" : pickWaKind(ev.reasons, ev.intent.kind);
  const hk = new Date(ts.getTime() + 8 * 3600 * 1000).toISOString();
  const title = `${group.label || "WhatsApp 群組"}｜${hk.slice(5, 10)} ${hk.slice(11, 16)}`;
  return {
    kind,
    groupKey: kind === "wa_roster_mismatch" && ev.mismatch ? rosterMismatchKey(ev.group.id, ev.mismatch.day) : ev.dedupe_key && ev.round === 1 ? ev.dedupe_key : groupKeyOf(ev.message.message_id, ev.message.revision, ev.message.idx, ev.round),
    sort: sortOfTs(ts), // 同一訊息嘅跟進輪次維持原次序
    title,
    evidence: ev,
    options: over ? optionsForWa("wa_unparsed", { ...ev, reasons: ev.reasons.filter((r) => r !== "low_confidence") }) : optionsForWa(kind, ev),
  };
}

interface WaSessionLite {
  id: string;
  ownerUserId: string;
}

/** 攞（或建）呢個群呢個月嘅 session；呼叫者應已持有 TRIAGE_LOCK。 */
async function getOrCreateWaSession(tx: Tx, args: { groupJid: string; ym: string; siteId: string | null; createdBy?: string }): Promise<{ session: WaSessionLite; created: boolean }> {
  const sourceRef = waSessionRef(args.groupJid, args.ym);
  const existing = await tx.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "whatsapp", sourceRef } }, select: { id: true, ownerUserId: true } });
  if (existing) return { session: existing, created: false };
  const owner = await pickWaOwner(tx, args.siteId);
  const created = await tx.triageSession.create({ data: { sourceType: "whatsapp", sourceRef, ownerUserId: owner, createdBy: args.createdBy ?? owner, statsJson: {} }, select: { id: true, ownerUserId: true } });
  return { session: created, created: true };
}

/** 刷新 session 狀態＋統計（有新 open 題就重開）。 */
export async function refreshWaSession(tx: Tx, sessionId: string): Promise<void> {
  const byKind: Record<string, number> = {};
  for (const g of await tx.triageQuestion.groupBy({ by: ["kind"], where: { sessionId, status: { not: "superseded" } }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const open = await tx.triageQuestion.count({ where: { sessionId, status: "open" } });
  const status = open === 0 ? "done" : "open";
  await tx.triageSession.update({ where: { id: sessionId }, data: { statsJson: { total, by_kind: byKind }, lastAppliedAt: new Date(), status, completedAt: status === "done" ? new Date() : null } });
}

export interface InsertedQuestion {
  id: string;
  groupKey: string;
  kind: string;
  intentId: string;
}

/** 冪等插入題目（同 session 已有同 groupKey → 唔再建）。 */
export async function insertWaQuestions(tx: Tx, sessionId: string, drafts: readonly WaQuestionDraft[]): Promise<{ created: InsertedQuestion[]; existing: Map<string, string> }> {
  const keys = drafts.map((d) => d.groupKey);
  const prior = keys.length ? await tx.triageQuestion.findMany({ where: { sessionId, groupKey: { in: keys } }, select: { id: true, groupKey: true, status: true } }) : [];
  // 名單「配唔到」題（rn:）撤回後 superseded → 重發同一個名要可以再開（唔計 superseded）
  const existing = new Map(prior.filter((p) => !(p.status === "superseded" && p.groupKey.startsWith("rn:"))).map((p) => [p.groupKey, p.id]));
  const fresh = drafts.filter((d) => !existing.has(d.groupKey));
  const created: InsertedQuestion[] = [];
  if (fresh.length > 0) {
    const rows = await tx.triageQuestion.createManyAndReturn({
      data: fresh.map((d) => ({
        sessionId,
        kind: d.kind,
        groupKey: d.groupKey,
        sort: d.sort,
        title: d.title,
        evidenceJson: JSON.parse(JSON.stringify(d.evidence)) as Prisma.InputJsonValue,
        optionsJson: JSON.parse(JSON.stringify(d.options)) as Prisma.InputJsonValue,
      })),
      select: { id: true, groupKey: true, kind: true },
    });
    const byKey = new Map(fresh.map((d) => [d.groupKey, d]));
    for (const r of rows) created.push({ id: r.id, groupKey: r.groupKey, kind: r.kind, intentId: byKey.get(r.groupKey)!.evidence.message.intent_id });
  }
  return { created, existing };
}

/** 同一訊息舊 revision（< belowRevision）嘅 open 題 → superseded。回受影響 session id。 */
export async function supersedeWaQuestions(tx: Tx, messageId: string, belowRevision: number): Promise<string[]> {
  const rows = await tx.$queryRaw<{ session_id: string }[]>`
    UPDATE triage_questions q SET status = 'superseded', updated_at = now()
    FROM triage_sessions s
    WHERE s.id = q.session_id AND s.source_type = 'whatsapp' AND q.status = 'open'
      AND q.evidence_json->'message'->>'message_id' = ${messageId}
      AND q.evidence_json->>'dedupe_key' IS NULL
      AND (q.evidence_json->'message'->>'revision')::int < ${belowRevision}::int
    RETURNING q.session_id`;
  const ids = [...new Set(rows.map((r) => r.session_id))];
  for (const id of ids) await refreshWaSession(tx, id);
  return ids;
}

export interface WaTriageResult {
  sessionId: string | null;
  ownerUserId: string | null;
  created: number;
  newSession: boolean;
}

/**
 * process.ts 落完 intents 後（同一 tx）即時呼叫：每個 routed=triage 嘅 intent 一題；result_ref=題目 id。
 * 新 revision：先 supersede 舊 revision 嘅 open 題。冇 triage intent 就只做 supersede。
 */
export async function createWaQuestionsTx(tx: Tx, args: { msg: WaMessageCtx; group: WaGroupCtx; rows: Array<WaIntentRow & { routed: string }>; srcs: ReadonlyArray<IntentSrc | undefined> }): Promise<WaTriageResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
  await supersedeWaQuestions(tx, args.msg.messageId, args.msg.revision);
  const triageRows = args.rows.filter((r) => r.routed === "triage");
  if (triageRows.length === 0) return { sessionId: null, ownerUserId: null, created: 0, newSession: false };
  const ym = hkMonthOf(args.msg.ts);
  const { session, created: newSession } = await getOrCreateWaSession(tx, { groupJid: args.msg.chatJid, ym, siteId: args.group.siteId ?? triageRows.find((r) => r.siteId)?.siteId ?? null });
  const allDrafts = triageRows.map((r) => draftFromIntent(args.msg, args.group, r, args.srcs[args.rows.indexOf(r)]));
  // WA-9：名單／相片差異題一日一條，之後新差異按「輪」處理（見 settleMismatchTx）；其餘題照舊冪等插入
  const drafts = allDrafts.filter((d) => !(d.kind === "wa_roster_mismatch" && d.evidence.mismatch));
  const { created, existing } = await insertWaQuestions(tx, session.id, drafts);
  for (const c of created) await tx.whatsappIntent.update({ where: { id: c.intentId }, data: { resultRef: c.id } });
  // 已存在嘅題（重送／重跑）：result_ref 補返
  for (const d of drafts) {
    const qid = existing.get(d.groupKey);
    if (qid) await tx.whatsappIntent.update({ where: { id: d.evidence.message.intent_id }, data: { resultRef: qid } });
  }
  let madeMismatch = 0;
  for (const d of allDrafts.filter((x) => x.kind === "wa_roster_mismatch" && x.evidence.mismatch)) {
    const r = await settleMismatchTx(tx, session.id, d);
    if (r.id) await tx.whatsappIntent.update({ where: { id: d.evidence.message.intent_id }, data: { resultRef: r.id } });
    if (r.created) madeMismatch += 1;
  }
  await refreshWaSession(tx, session.id);
  return { sessionId: session.id, ownerUserId: session.ownerUserId, created: created.length + madeMismatch, newSession };
}

/**
 * WA-9：同群同日嘅名單／相片差異題（base groupKey `rm:<群>:<日>`；後續輪次 `…:r2`、`…:r3`）。
 *  - 有 open 嘅題 → 將新差異併入（聯集），唔另開；
 *  - 冇 open 但之前輪次已答／跳過／superseded：只有「之前所有輪次都冇出現過」嘅新差異先另開下一輪（groupKey 加 :r<n>）；
 *  - 同一差異重跑 → 冪等（之前輪次已出現過就唔再開）。
 */
async function settleMismatchTx(tx: Tx, sessionId: string, draft: WaQuestionDraft): Promise<{ id: string | null; created: boolean }> {
  const m = draft.evidence.mismatch!;
  const base = draft.groupKey;
  const rows = await tx.triageQuestion.findMany({ where: { sessionId, OR: [{ groupKey: base }, { groupKey: { startsWith: `${base}:r` } }] }, select: { id: true, status: true, evidenceJson: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const seenPhoto = new Set<string>(rows.flatMap((q) => (q.evidenceJson as unknown as WaEvidence).mismatch?.photo_only ?? []));
  const seenRoster = new Set<string>(rows.flatMap((q) => (q.evidenceJson as unknown as WaEvidence).mismatch?.roster_only ?? []));
  const newPhoto = m.photo_only.filter((n) => !seenPhoto.has(n));
  const newRoster = m.roster_only.filter((n) => !seenRoster.has(n));
  if (rows.length === 0) {
    const r = await insertWaQuestions(tx, sessionId, [draft]);
    return { id: r.created[0]?.id ?? r.existing.get(base) ?? null, created: r.created.length > 0 };
  }
  const open = [...rows].reverse().find((q) => q.status === "open");
  if (open) {
    if (newPhoto.length > 0 || newRoster.length > 0) {
      const ev = open.evidenceJson as unknown as WaEvidence;
      const cur = ev.mismatch ?? { day: m.day, roster_only: [], photo_only: [] };
      const next = { day: m.day, roster_only: [...new Set([...cur.roster_only, ...newRoster])], photo_only: [...new Set([...cur.photo_only, ...newPhoto])] };
      await tx.triageQuestion.update({ where: { id: open.id }, data: { evidenceJson: JSON.parse(JSON.stringify({ ...ev, mismatch: next })) as Prisma.InputJsonValue } });
    }
    return { id: open.id, created: false };
  }
  if (newPhoto.length === 0 && newRoster.length === 0) return { id: rows[rows.length - 1]!.id, created: false };
  const round = rows.length + 1;
  const next: WaQuestionDraft = { ...draft, groupKey: `${base}:r${round}`, evidence: { ...draft.evidence, mismatch: { day: m.day, roster_only: newRoster, photo_only: newPhoto } } };
  const r = await insertWaQuestions(tx, sessionId, [next]);
  return { id: r.created[0]?.id ?? r.existing.get(next.groupKey) ?? null, created: r.created.length > 0 };
}

/** 撤回：呢個 job tick 將「訊息已撤回」嘅 open 題 superseded（一條 SQL，冪等）。回受影響題數。 */
export async function supersedeRevokedWaQuestions(): Promise<number> {
  const pending = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM triage_questions q JOIN triage_sessions s ON s.id = q.session_id
    WHERE s.source_type = 'whatsapp' AND q.status = 'open'
      AND q.evidence_json->'message'->>'message_id' IN (SELECT message_id FROM whatsapp_messages WHERE revoked_at IS NOT NULL)`;
  if (Number(pending[0]?.n ?? 0) === 0) return 0;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
    const rows = await tx.$queryRaw<{ session_id: string }[]>`
      UPDATE triage_questions q SET status = 'superseded', updated_at = now()
      FROM triage_sessions s
      WHERE s.id = q.session_id AND s.source_type = 'whatsapp' AND q.status = 'open'
        AND q.evidence_json->'message'->>'message_id' IN (SELECT message_id FROM whatsapp_messages WHERE revoked_at IS NOT NULL)
      RETURNING q.session_id`;
    for (const id of new Set(rows.map((r) => r.session_id))) await refreshWaSession(tx, id);
    return rows.length;
  });
}

/** 通知負責人有新分流題（唔含任何個人資料／群名；同一 session 同一香港日只通知一次）。永不拋錯。 */
export async function notifyWaTriage(ownerUserId: string, sessionId: string, n: number, ts: Date): Promise<void> {
  try {
    const { createNotification } = await import("@/lib/notify/create");
    await createNotification({
      kind: "whatsapp_triage",
      title: "WhatsApp 報更有新分流題",
      body: `WhatsApp 報更有 ${n} 條新題目要你揀答案，請到「待答問題」處理。`,
      href: "/triage",
      audience: [ownerUserId],
      dedupeKey: `whatsapp_triage:${sessionId}:${hkDateOf(ts)}`,
    });
  } catch (e) {
    console.error("[whatsapp] triage notify failed:", e instanceof Error ? e.name : "error");
  }
}
