// WP-AI-OPS §28.4：分診 session 建立／列出／權限／轉交。
// 擁有人＝上載者（owner_user_id）。老闆睇全部、可轉交；其他人（會計／主管）只睇／答自己嗰批——
// API 層強制（呢度），唔係淨係前端收埋。
import type { TriageQuestion, TriageSession } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Forbidden, NotFound } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import { unassignedBankOf, type ImportPackage } from "@/lib/guards/import/package";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { bankAccountRef, keyFingerprint, serverPersonKey } from "@/lib/guards/import/person-key";
import { draftGuardImportQuestions } from "./generators/guard-import";
import type { QuestionEvidence } from "./types";
import { extValueSig } from "@/lib/guards/import/ext";
import { BANK_KINDS, SUPPLEMENTARY_KINDS } from "./types";
import { hasPermission } from "@/lib/rbac/requirePermission";

export const isBoss = (s: Pick<AuthedSession, "baseRole">): boolean => s.baseRole === "老闆";

/** 可以做擁有人（接收轉交）嘅角色：同「導入分診」module 一致。 */
export const TRIAGE_OWNER_ROLES = ["老闆", "會計", "主管"] as const;

export async function getSessionFor(actor: AuthedSession, id: string): Promise<TriageSession> {
  const s = await prisma.triageSession.findUnique({ where: { id } });
  if (!s) throw NotFound("搵唔到呢批分診");
  if (!isBoss(actor) && s.ownerUserId !== actor.userId) throw Forbidden("呢批分診唔係你上載嘅");
  return s;
}

export async function getQuestionFor(actor: AuthedSession, id: string): Promise<TriageQuestion & { session: TriageSession }> {
  const q = await prisma.triageQuestion.findUnique({ where: { id }, include: { session: true } });
  if (!q) throw NotFound("搵唔到呢條問題");
  if (!isBoss(actor) && q.session.ownerUserId !== actor.userId) throw Forbidden("呢條問題唔係你上載嗰批");
  return q;
}

export interface SessionSummary {
  id: string;
  source_type: string;
  owner_user_id: string;
  owner_name: string | null;
  status: string;
  created_at: Date;
  completed_at: Date | null;
  /** 所有題都已被較新嘅導入取代（顯示「已被較新嘅導入取代」，唔係「已處理晒」） */
  superseded_all?: boolean;
  counts: { open: number; answered: number; skipped: number; superseded: number; total: number; important_open: number; supplementary_open: number; restricted_open: number };
}

/** 「補充資料」層（field_review／ext_field_conflict／ext_field_review）：唔急，排喺要人手／衝突／銀行之後，badge 唔計。 */
export const isSupplementary = (kind: string): boolean => (SUPPLEMENTARY_KINDS as readonly string[]).includes(kind);

/** 呢個讀者答唔到（restricted）嘅題目類別：銀行題要銀行 update 權；身份確認要個人資料 view＋安員 update。唔計入佢嘅待答數。 */
export async function restrictedKindsFor(actor: Pick<AuthedSession, "baseRole" | "userId" | "roleId">): Promise<string[]> {
  const a = actor as AuthedSession;
  const [bankU, pii, guardU] = await Promise.all([hasPermission(a, "安員銀行資料", "update"), hasPermission(a, "安員個人資料", "view"), hasPermission(a, "安員", "update")]);
  return [...(bankU ? [] : BANK_KINDS), ...(pii && guardU ? [] : ["ext_identity_check"])];
}

export async function listSessionsFor(actor: AuthedSession, opts: { mine: boolean }): Promise<SessionSummary[]> {
  const where = isBoss(actor) && !opts.mine ? {} : { ownerUserId: actor.userId };
  const sessions = await prisma.triageSession.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { owner: { select: { name: true } } } });
  if (sessions.length === 0) return [];
  const restricted = new Set(await restrictedKindsFor(actor));
  const grouped = await prisma.triageQuestion.groupBy({ by: ["sessionId", "status", "kind"], where: { sessionId: { in: sessions.map((s) => s.id) } }, _count: { _all: true } });
  return sessions.map((s) => {
    const counts = { open: 0, answered: 0, skipped: 0, superseded: 0, total: 0, important_open: 0, supplementary_open: 0, restricted_open: 0 };
    for (const g of grouped) {
      if (g.sessionId !== s.id) continue;
      if (g.status === "superseded") {
        counts.superseded += g._count._all; // 已被較新嘅導入取代：唔計入 total
        continue;
      }
      if (g.status === "open" || g.status === "answered" || g.status === "skipped") counts[g.status] += g._count._all;
      if (g.status === "open" && !restricted.has(g.kind)) counts[isSupplementary(g.kind) ? "supplementary_open" : "important_open"] += g._count._all;
      if (g.status === "open" && restricted.has(g.kind)) counts.restricted_open += g._count._all; // 要有權限嘅同事處理（唔計入佢嘅待答數／badge）
      counts.total += g._count._all;
    }
    return { id: s.id, source_type: s.sourceType, owner_user_id: s.ownerUserId, owner_name: s.owner.name, status: s.status, created_at: s.createdAt, completed_at: s.completedAt, counts, superseded_all: counts.superseded > 0 && counts.total === 0 };
  });
}

/** 「待答問題」數（badge 用，淨計重要嗰層，唔計補充資料）：老闆＝全部；其他＝自己嗰批。 */
export async function countOpenFor(actor: Pick<AuthedSession, "baseRole" | "userId" | "roleId">): Promise<number> {
  const restricted = await restrictedKindsFor(actor);
  return prisma.triageQuestion.count({ where: { status: "open", kind: { notIn: [...SUPPLEMENTARY_KINDS, ...restricted] }, session: isBoss(actor) ? {} : { ownerUserId: actor.userId } } });
}

/** 所有未答都答晒（冇 open）就收尾；有新 open 就重開。 */
export async function refreshSessionStatus(sessionId: string): Promise<"open" | "done"> {
  const open = await prisma.triageQuestion.count({ where: { sessionId, status: "open" } });
  const status = open === 0 ? "done" : "open";
  await prisma.triageSession.updateMany({ where: { id: sessionId, status: { not: status } }, data: { status, completedAt: status === "done" ? new Date() : null } });
  return status;
}

export async function reassignSession(actor: AuthedSession, sessionId: string, newOwnerId: string, ip: string | null): Promise<TriageSession> {
  if (!isBoss(actor)) throw Forbidden("淨係老闆可以轉交");
  const s = await prisma.triageSession.findUnique({ where: { id: sessionId } });
  if (!s) throw NotFound("搵唔到呢批分診");
  const target = await prisma.user.findUnique({ where: { id: newOwnerId }, include: { role: { select: { baseRole: true } } } });
  if (!target || target.status !== "active" || !(TRIAGE_OWNER_ROLES as readonly string[]).includes(target.role.baseRole)) {
    throw BadRequest("轉交對象要係啟用中嘅老闆／會計／主管");
  }
  const updated = await prisma.triageSession.update({ where: { id: s.id }, data: { ownerUserId: target.id } });
  await writeAudit({ actorUserId: actor.userId, tableName: "triage_sessions", rowId: s.id, action: "triage_reassign", before: { owner_user_id: s.ownerUserId }, after: { owner_user_id: target.id }, ip });
  return updated;
}

/**
 * 跨 session 去重用嘅「證據核心」：同一個人（穩定 person key＝group_key 基底）、同一 kind，v2 身份欄／候選／要覆核嘅欄名／銀行戶口相同即同一條題。
 * 唔包 reasons、v3 新欄值（v2 包升 v3 包時，已答／已跳過嘅 v2 類題唔應該重出）；ext 類題以 ext_review 嘅 key 計，多咗新欄先算新題。
 */
export function evidenceCore(kind: string, ev: QuestionEvidence): string {
  const p = ev.person;
  const core = {
    kind,
    // 只取 value／status（key 次序、address.source 等唔影響「同一條題」）
    person: Object.fromEntries(
      (["hkid", "nameZh", "nameEn", "dateOfBirth", "phone", "address"] as const).map((k) => [k, [p[k].value ?? null, p[k].status]]),
    ),
    nos: p.staffNumbers.map((n) => n.number).sort(),
    cands: [...ev.candidate_guard_ids].sort(),
    review: (ev.review_fields ?? []).map((r) => r.field).sort(),
    ext: (ev.ext_review ?? []).map((r) => r.key).sort(),
    // N2：ext／bank 類題另加涉及欄位嘅值＋狀態（跳過後新包將值改正→要再問；值冇變→唔再問）。v2 類題唔計
    extVals: /^(ext_|bank_)/.test(kind) ? (ev.ext_review ?? []).map((r) => [r.key, extValueSig(ev.person, r.key)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : null,
    unassigned: ev.unassigned ? { bankCode: ev.unassigned.bankCode, accountNo: ev.unassigned.accountNo, payeeName: ev.unassigned.payeeName } : null,
    guard: ev.guard_id ?? null,
  };
  return createHash("sha1").update(JSON.stringify(core)).digest("hex");
}

export interface CreateTriageResult {
  session_id: string;
  open_questions: number;
  new_questions: number;
  total_questions: number;
  important_open: number;
  supplementary_open: number;
}

/** 同一個導入包已經有另一位同事上載過：新題入咗佢（或者老闆）嘅 session，唔回 session 內容。 */
export interface OwnedByOtherResult {
  owned_by_other: true;
  new_questions: number;
}

/** 有 ext 值／銀行資料嘅題（只由 v3 包產生）。 */
export const EXT_BANK_KINDS: readonly string[] = ["ext_identity_check", "ext_field_conflict", "ext_field_review", "bank_review"];
/** 只由 v3 包決定嘅題（包括未指派戶口）：「最近一次 v3 包」先答得。 */
export const V3_ONLY_KINDS: readonly string[] = [...EXT_BANK_KINDS, "bank_identity_unknown"];

/**
 * 單一規則（Opus 第四輪，取代逐題 supersede）：每次**自動 apply** 一個 guard_import 包，對包內每個人，出新題之前：
 *  1. 記低「呢個包包含呢個人」（triage_person_applies：人 key＋目標 guard＋包 hash＋是否 v3＋時間）；
 *  2. 其他 session 入面屬於同一個人（serverPersonKey 相同，或者鎖定嘅目標 guard 相同）嘅所有 open ext_*／bank_* 題（唔理 kind）→ superseded（淨 v3 包）；
 *     其他 session 同 group_key 嘅 open v2 類題（唔理 kind）→ superseded；未指派戶口（bankpe:）同理；
 *  3. 去重只對照未 superseded 嘅題（open／answered／skipped）＋值簽名相同；superseded 題永遠唔參與去重；
 *  4. 自己 session 入面同 group_key 已 superseded 嘅題（同一個包被較新包取代後再 apply）→ 重開；
 *  5. 答題預覽／commit 用 assertNoNewer：同一個人有較新嘅包（triage_person_applies）就 409。
 * SESSION_SECRET 輪換：session 記低 key 指紋，指紋唔同嘅舊 session open 題一律當 superseded。
 * 冇題目就唔開 session（但記錄同 supersede 照做）。呢度**唔會**寫任何安員資料（淨係讀＋寫 triage 表）。
 */
export async function createGuardImportTriage(input: { pkg: ImportPackage; packageHash: string; actor: AuthedSession; ip: string | null; personKeys?: readonly string[]; results?: readonly { key: string; ext?: { key: string; outcome: string }[] }[] }): Promise<CreateTriageResult | OwnedByOtherResult | null> {
  const only = input.personKeys ? new Set(input.personKeys) : null;
  const now = new Date();
  const fp = keyFingerprint();
  const [viewPii, viewBank] = await Promise.all([hasPermission(input.actor, "安員個人資料", "view"), hasPermission(input.actor, "安員銀行資料", "view")]);
  const { evals: allEvals, guards } = await evaluateImportPackage(input.pkg, viewPii);
  const evals = only ? allEvals.filter((e) => only.has(e.person.key)) : allEvals;
  const written = new Map<string, Set<string>>();
  for (const r of input.results ?? []) {
    const ks = (r.ext ?? []).filter((x) => x.outcome === "written").map((x) => x.key);
    if (ks.length) written.set(r.key, new Set([...(written.get(r.key) ?? []), ...ks]));
  }
  const allDrafts = draftGuardImportQuestions(input.pkg, evals, { viewPii, viewBank, guards, written });
  const isV3 = input.pkg.version === 3;
  const otherSession = { sourceType: "guard_import", sourceRef: { not: input.packageHash } };

  const supersede = async (where: Prisma.TriageQuestionWhereInput): Promise<void> => {
    const affected = await prisma.triageQuestion.findMany({ where: { ...where, status: "open" }, select: { sessionId: true }, distinct: ["sessionId"] });
    if (affected.length === 0) return;
    await prisma.triageQuestion.updateMany({ where: { ...where, status: "open" }, data: { status: "superseded" } });
    for (const a of affected) await refreshSessionStatus(a.sessionId);
  };

  // 0. SESSION_SECRET 輪換：key 指紋唔同（或未記）嘅舊 session，open 題一律 superseded
  await supersede({ session: { sourceType: "guard_import", OR: [{ keyFp: null }, { keyFp: { not: fp } }], sourceRef: { not: input.packageHash } } });

  // 1. 記低呢個包包含邊啲人
  const people = new Map<string, string | null>();
  for (const e of evals) {
    const k = serverPersonKey(e.person);
    if (!people.has(k) || (people.get(k) === null && e.guardId)) people.set(k, e.action === "link" ? e.guardId : null);
  }
  for (const u of unassignedBankOf(input.pkg)) people.set(bankAccountRef(u.bankCode, u.accountNo), null);
  if (people.size > 0) {
    const ks = [...people.keys()];
    const gs = ks.map((k) => people.get(k) ?? null);
    await prisma.$executeRaw`
      INSERT INTO triage_person_applies (person_key, guard_id, source_ref, is_v3, applied_at)
      SELECT k, g, ${input.packageHash}, ${isV3}, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      FROM unnest(${ks}::text[], ${gs}::text[]) AS t(k, g)
      ON CONFLICT (person_key, source_ref) DO UPDATE SET guard_id = EXCLUDED.guard_id, is_v3 = EXCLUDED.is_v3, applied_at = EXCLUDED.applied_at`;
  }

  // 2. 其他 session 入面同一個人嘅 open 題：證據核心／值簽名完全相同（同 group_key＋同 kind）嘅「保留」（搬入呢個包嘅 session，
  //    唔重複出題）；其餘一律 superseded。去重只對照未 superseded 嘅題（open／answered／skipped），superseded 永不參與。
  const personKeys = [...people.keys()];
  const guardIds = [...new Set([...people.values()].filter((g): g is string => !!g))];
  const coreOf = (groupKey: string, kind: string, ev: QuestionEvidence) => `${groupKey}|${evidenceCore(kind, ev)}`;
  const openOthers = await prisma.triageQuestion.findMany({
    where: { groupKey: { in: allDrafts.map((d) => d.groupKey) }, status: "open", session: otherSession },
    select: { id: true, groupKey: true, kind: true, evidenceJson: true },
  });
  const keepByCore = new Map<string, string>();
  for (const q of openOthers) {
    const k = coreOf(q.groupKey, q.kind, q.evidenceJson as unknown as QuestionEvidence);
    if (!keepByCore.has(k)) keepByCore.set(k, q.id);
  }
  const keptIds: string[] = [];
  const stillDrafts = allDrafts.filter((d) => {
    const id = keepByCore.get(coreOf(d.groupKey, d.kind, d.evidence));
    if (id) {
      keptIds.push(id);
      return false;
    }
    return true;
  });
  const notKept: Prisma.TriageQuestionWhereInput = keptIds.length ? { id: { notIn: keptIds } } : {};
  if (isV3) {
    await supersede({ ...notKept, kind: { in: [...EXT_BANK_KINDS] }, session: otherSession, OR: [{ personKey: { in: personKeys } }, ...(guardIds.length ? [{ targetGuardId: { in: guardIds } }] : [])] });
    const refs = unassignedBankOf(input.pkg).map((u) => `bankpe:${bankAccountRef(u.bankCode, u.accountNo)}`);
    if (refs.length) await supersede({ ...notKept, kind: "bank_identity_unknown", groupKey: { in: refs }, session: otherSession });
  }
  await supersede({ ...notKept, kind: { notIn: [...V3_ONLY_KINDS] }, groupKey: { in: personKeys }, session: otherSession });

  // 3. 其他 session 嘅 answered／skipped 題（未 superseded）＋值簽名相同 → 唔再問
  const others = await prisma.triageQuestion.findMany({
    where: { groupKey: { in: stillDrafts.map((d) => d.groupKey) }, status: { in: ["answered", "skipped"] }, session: otherSession },
    select: { groupKey: true, kind: true, evidenceJson: true },
  });
  const seenElsewhere = new Set(others.map((q) => coreOf(q.groupKey, q.kind, q.evidenceJson as unknown as QuestionEvidence)));
  const drafts = stillDrafts.filter((d) => !seenElsewhere.has(coreOf(d.groupKey, d.kind, d.evidence)));
  const existing = await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "guard_import", sourceRef: input.packageHash } } });
  if (!existing && drafts.length === 0 && keptIds.length === 0) return null;
  // 已經有 session 但屬於另一個人：唔動，亦唔俾上載者睇（只可以由老闆轉交）
  const session =
    existing ??
    (await prisma.triageSession.create({
      data: { sourceType: "guard_import", sourceRef: input.packageHash, ownerUserId: input.actor.userId, createdBy: input.actor.userId, statsJson: {}, keyFp: fp, lastAppliedAt: now },
    }));
  if (existing) await prisma.triageSession.update({ where: { id: session.id }, data: { keyFp: fp, lastAppliedAt: now } });
  // 保留嘅舊 open 題搬入呢個包嘅 session（令「最近一次包含呢個人嘅包」同題目所屬 session 一致；冇重複出題）
  if (keptIds.length) {
    const from = await prisma.triageQuestion.findMany({ where: { id: { in: keptIds }, sessionId: { not: session.id } }, select: { sessionId: true }, distinct: ["sessionId"] });
    // 呢個 session 已有同 group_key 嘅題（例如重新 apply 同一個包）→ 唔搬（避免撞 unique），舊題就地 superseded
    const mine = new Set((await prisma.triageQuestion.findMany({ where: { sessionId: session.id }, select: { groupKey: true } })).map((q) => q.groupKey));
    const moving = await prisma.triageQuestion.findMany({ where: { id: { in: keptIds } }, select: { id: true, groupKey: true } });
    const ok = moving.filter((q) => !mine.has(q.groupKey)).map((q) => q.id);
    const clash = moving.filter((q) => mine.has(q.groupKey)).map((q) => q.id);
    if (ok.length) await prisma.triageQuestion.updateMany({ where: { id: { in: ok } }, data: { sessionId: session.id } });
    if (clash.length) await prisma.triageQuestion.updateMany({ where: { id: { in: clash } }, data: { status: "superseded" } });
    for (const f of from) await refreshSessionStatus(f.sessionId);
  }
  const have = new Map((await prisma.triageQuestion.findMany({ where: { sessionId: session.id }, select: { id: true, groupKey: true, status: true } })).map((q) => [q.groupKey, q]));
  const toData = (d: (typeof drafts)[number]) => ({
    kind: d.kind,
    groupKey: d.groupKey,
    sort: d.sort,
    title: d.title,
    personKey: d.personKey,
    targetGuardId: d.targetGuardId,
    evidenceJson: JSON.parse(JSON.stringify(d.evidence)),
    optionsJson: JSON.parse(JSON.stringify(d.options)),
  });
  // 4. 同一個包被較新包取代後再 apply：自己 session 入面 superseded 嘅題重開
  let reopened = 0;
  for (const d of drafts) {
    const h = have.get(d.groupKey);
    if (h?.status === "superseded") {
      await prisma.triageQuestion.update({ where: { id: h.id }, data: { ...toData(d), status: "open", answerJson: Prisma.JsonNull, answeredBy: null, answeredAt: null, impactJson: Prisma.JsonNull, applyResultJson: Prisma.JsonNull } });
      reopened++;
    }
  }
  const fresh = drafts.filter((d) => !have.has(d.groupKey));
  if (fresh.length > 0) await prisma.triageQuestion.createMany({ skipDuplicates: true, data: fresh.map((d) => ({ sessionId: session.id, ...toData(d) })) });
  const byKind: Record<string, number> = {};
  for (const g of await prisma.triageQuestion.groupBy({ by: ["kind"], where: { sessionId: session.id, status: { not: "superseded" } }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  await prisma.triageSession.update({ where: { id: session.id }, data: { statsJson: { total, by_kind: byKind } } });
  if (!existing || fresh.length > 0 || reopened > 0) {
    await writeAudit({
      actorUserId: input.actor.userId,
      tableName: "triage_sessions",
      rowId: session.id,
      action: "triage_session_create",
      after: { source_type: "guard_import", owner_user_id: session.ownerUserId, new_questions: fresh.length + reopened, total_questions: total, by_kind: byKind },
      ip: input.ip,
    });
  }
  await refreshSessionStatus(session.id);
  const open = await prisma.triageQuestion.count({ where: { sessionId: session.id, status: "open" } });
  // 屬於別人嘅 session：唔回 session 內容，淨係話俾上載者知
  if (session.ownerUserId !== input.actor.userId) return { owned_by_other: true, new_questions: fresh.length + reopened };
  const supplementary = await prisma.triageQuestion.count({ where: { sessionId: session.id, status: "open", kind: { in: [...SUPPLEMENTARY_KINDS] } } });
  return { session_id: session.id, open_questions: open, new_questions: fresh.length + reopened, total_questions: total, important_open: open - supplementary, supplementary_open: supplementary };
}
