// WP-AI-OPS §28.4：分診 session 建立／列出／權限／轉交。
// 擁有人＝上載者（owner_user_id）。老闆睇全部、可轉交；其他人（會計／主管）只睇／答自己嗰批——
// API 層強制（呢度），唔係淨係前端收埋。
import type { TriageQuestion, TriageSession } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Forbidden, NotFound } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import type { ImportPackage } from "@/lib/guards/import/package";
import { createHash } from "node:crypto";
import { draftGuardImportQuestions } from "./generators/guard-import";
import type { QuestionEvidence } from "./types";
import { extValueSig } from "@/lib/guards/import/ext";
import { SUPPLEMENTARY_KINDS } from "./types";
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
  counts: { open: number; answered: number; skipped: number; total: number; important_open: number; supplementary_open: number };
}

/** 「補充資料」層（field_review／ext_field_conflict／ext_field_review）：唔急，排喺要人手／衝突／銀行之後，badge 唔計。 */
export const isSupplementary = (kind: string): boolean => (SUPPLEMENTARY_KINDS as readonly string[]).includes(kind);

export async function listSessionsFor(actor: AuthedSession, opts: { mine: boolean }): Promise<SessionSummary[]> {
  const where = isBoss(actor) && !opts.mine ? {} : { ownerUserId: actor.userId };
  const sessions = await prisma.triageSession.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { owner: { select: { name: true } } } });
  if (sessions.length === 0) return [];
  const grouped = await prisma.triageQuestion.groupBy({ by: ["sessionId", "status", "kind"], where: { sessionId: { in: sessions.map((s) => s.id) } }, _count: { _all: true } });
  return sessions.map((s) => {
    const counts = { open: 0, answered: 0, skipped: 0, total: 0, important_open: 0, supplementary_open: 0 };
    for (const g of grouped) {
      if (g.sessionId !== s.id) continue;
      if (g.status === "open" || g.status === "answered" || g.status === "skipped") counts[g.status] += g._count._all;
      if (g.status === "open") counts[isSupplementary(g.kind) ? "supplementary_open" : "important_open"] += g._count._all;
      counts.total += g._count._all;
    }
    return { id: s.id, source_type: s.sourceType, owner_user_id: s.ownerUserId, owner_name: s.owner.name, status: s.status, created_at: s.createdAt, completed_at: s.completedAt, counts };
  });
}

/** 「待答問題」數（badge 用，淨計重要嗰層，唔計補充資料）：老闆＝全部；其他＝自己嗰批。 */
export async function countOpenFor(actor: Pick<AuthedSession, "baseRole" | "userId">): Promise<number> {
  return prisma.triageQuestion.count({ where: { status: "open", kind: { notIn: [...SUPPLEMENTARY_KINDS] }, session: isBoss(actor) ? {} : { ownerUserId: actor.userId } } });
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

/**
 * 導入 apply（自動項）完成後開 session＋出題。冪等：同一個 package_hash 淨係得一個 session；
 * 已經有嘅 group_key（無論 open／answered／skipped）唔再出。冇題目就唔開。
 * 呢度**唔會**寫任何安員資料（淨係讀＋寫 triage 表）。
 */
export async function createGuardImportTriage(input: { pkg: ImportPackage; packageHash: string; actor: AuthedSession; ip: string | null; personKeys?: readonly string[] }): Promise<CreateTriageResult | OwnedByOtherResult | null> {
  const only = input.personKeys ? new Set(input.personKeys) : null;
  const [viewPii, viewBank] = await Promise.all([hasPermission(input.actor, "安員個人資料", "view"), hasPermission(input.actor, "安員銀行資料", "view")]);
  const { evals, guards } = await evaluateImportPackage(input.pkg, viewPii);
  const allDrafts = draftGuardImportQuestions(input.pkg, only ? evals.filter((e) => only.has(e.person.key)) : evals, { viewPii, viewBank, guards });
  // M4：跨 session 去重（同 source_type、同一個人、同 kind、證據核心相同，其他 session 已有就唔再出——open／answered／skipped 都計）
  const otherSessions = await prisma.triageQuestion.findMany({
    where: { groupKey: { in: allDrafts.map((d) => d.groupKey) }, session: { sourceType: "guard_import", sourceRef: { not: input.packageHash } } },
    select: { groupKey: true, kind: true, evidenceJson: true },
  });
  const seenElsewhere = new Set(otherSessions.map((q) => `${q.groupKey}|${evidenceCore(q.kind, q.evidenceJson as unknown as QuestionEvidence)}`));
  const drafts = allDrafts.filter((d) => !seenElsewhere.has(`${d.groupKey}|${evidenceCore(d.kind, d.evidence)}`));
  const existing = await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "guard_import", sourceRef: input.packageHash } } });
  if (!existing && drafts.length === 0) return null;
  // 已經有 session 但屬於另一個人：唔動，亦唔俾上載者睇（只可以由老闆轉交）
  const session =
    existing ??
    (await prisma.triageSession.create({
      data: { sourceType: "guard_import", sourceRef: input.packageHash, ownerUserId: input.actor.userId, createdBy: input.actor.userId, statsJson: {} },
    }));
  const have = new Set((await prisma.triageQuestion.findMany({ where: { sessionId: session.id }, select: { groupKey: true } })).map((q) => q.groupKey));
  const fresh = drafts.filter((d) => !have.has(d.groupKey));
  if (fresh.length > 0) {
    await prisma.triageQuestion.createMany({
      skipDuplicates: true,
      data: fresh.map((d) => ({
        sessionId: session.id,
        kind: d.kind,
        groupKey: d.groupKey,
        sort: d.sort,
        title: d.title,
        evidenceJson: JSON.parse(JSON.stringify(d.evidence)),
        optionsJson: JSON.parse(JSON.stringify(d.options)),
      })),
    });
  }
  const byKind: Record<string, number> = {};
  for (const g of await prisma.triageQuestion.groupBy({ by: ["kind"], where: { sessionId: session.id }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  await prisma.triageSession.update({ where: { id: session.id }, data: { statsJson: { total, by_kind: byKind } } });
  if (!existing || fresh.length > 0) {
    await writeAudit({
      actorUserId: input.actor.userId,
      tableName: "triage_sessions",
      rowId: session.id,
      action: "triage_session_create",
      after: { source_type: "guard_import", owner_user_id: session.ownerUserId, new_questions: fresh.length, total_questions: total, by_kind: byKind },
      ip: input.ip,
    });
  }
  const status = await refreshSessionStatus(session.id);
  const open = await prisma.triageQuestion.count({ where: { sessionId: session.id, status: "open" } });
  void status;
  // 屬於別人嘅 session：唔回 session 內容，淨係話俾上載者知
  if (session.ownerUserId !== input.actor.userId) return { owned_by_other: true, new_questions: fresh.length };
  const supplementary = await prisma.triageQuestion.count({ where: { sessionId: session.id, status: "open", kind: { in: [...SUPPLEMENTARY_KINDS] } } });
  return { session_id: session.id, open_questions: open, new_questions: fresh.length, total_questions: total, important_open: open - supplementary, supplementary_open: supplementary };
}
