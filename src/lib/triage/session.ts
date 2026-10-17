// WP-AI-OPS §28.4：分診 session 建立／列出／權限／轉交。
// 擁有人＝上載者（owner_user_id）。老闆睇全部、可轉交；其他人（會計／主管）只睇／答自己嗰批——
// API 層強制（呢度），唔係淨係前端收埋。
import { getSystemUserId } from "@/lib/system-user";
import { cache } from "react";
import type { TriageQuestion, TriageSession } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Forbidden, NotFound } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import { packageHasBank, unassignedBankOf, type ImportPackage } from "@/lib/guards/import/package";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { bankAccountRef, keyFingerprint, serverPersonKey, weakIdsOf } from "@/lib/guards/import/person-key";
import { draftGuardImportQuestions } from "./generators/guard-import";
import type { QuestionEvidence } from "./types";
import { allExtSig, extValueSig } from "@/lib/guards/import/ext";
import { BANK_KINDS, SUPPLEMENTARY_KINDS, WA_KINDS } from "./types";
import { hasPermission } from "@/lib/rbac/requirePermission";

export const isBoss = (s: Pick<AuthedSession, "baseRole">): boolean => s.baseRole === "老闆";

/** 可以做擁有人（接收轉交）嘅角色：同「導入分診」module 一致。 */
export const TRIAGE_OWNER_ROLES = ["老闆", "會計", "主管"] as const;

/** P8 M1：系統帳號擁有嘅 session（自動 run 揾唔到合資格上載者）——任何人（有權答嘅）都可以處理，唔限擁有人。 */
export async function canAccessOwnedBy(actor: AuthedSession, ownerUserId: string): Promise<boolean> {
  if (isBoss(actor) || ownerUserId === actor.userId) return true;
  return ownerUserId === (await getSystemUserId()) && (await hasPermission(actor, "一鍵結算", "create"));
}

/** 非老闆可見嘅 owner 範圍：自己，加（有「一鍵結算:create」時）系統帳號擁有嘅 session。 */
export async function visibleOwnerIds(actor: AuthedSession): Promise<string[]> {
  const sysId = await getSystemUserId();
  return sysId && (await hasPermission(actor, "一鍵結算", "create")) ? [actor.userId, sysId] : [actor.userId];
}

export async function getSessionFor(actor: AuthedSession, id: string): Promise<TriageSession> {
  const s = await prisma.triageSession.findUnique({ where: { id } });
  if (!s) throw NotFound("搵唔到呢批分診");
  if (!(await canAccessOwnedBy(actor, s.ownerUserId))) throw Forbidden("呢批分診唔係你上載嘅");
  return s;
}

export async function getQuestionFor(actor: AuthedSession, id: string): Promise<TriageQuestion & { session: TriageSession }> {
  const q = await prisma.triageQuestion.findUnique({ where: { id }, include: { session: true } });
  if (!q) throw NotFound("搵唔到呢條問題");
  if (!(await canAccessOwnedBy(actor, q.session.ownerUserId))) throw Forbidden("呢條問題唔係你上載嗰批");
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
  /** TR-1（additive）：其中由「OCR 重讀建議」自動答嘅題數 */
  ocr_reread_answered: number;
}

/** 「補充資料」層（field_review／ext_field_conflict／ext_field_review）：唔急，排喺要人手／衝突／銀行之後，badge 唔計。 */
export const isSupplementary = (kind: string): boolean => (SUPPLEMENTARY_KINDS as readonly string[]).includes(kind);

/** 呢個讀者答唔到（restricted）嘅題目類別：銀行題要銀行 update 權；身份確認要個人資料 view＋保安員 update。唔計入佢嘅待答數。 */
export async function restrictedKindsFor(actor: Pick<AuthedSession, "baseRole" | "userId" | "roleId">): Promise<string[]> {
  const a = actor as AuthedSession;
  const [bankU, pii, guardU, guardV, rosterC] = await Promise.all([hasPermission(a, "安員銀行資料", "update"), hasPermission(a, "安員個人資料", "view"), hasPermission(a, "安員", "update"), hasPermission(a, "安員", "view"), hasPermission(a, "更表", "create")]);
  // W2：WhatsApp 分診題要「保安員:view」（原話／姓名）＋「更表:create」（入更）先答到
  return [...(bankU ? [] : BANK_KINDS), ...(pii && guardU ? [] : ["ext_identity_check"]), ...(guardV && rosterC ? [] : WA_KINDS)];
}

export async function listSessionsFor(actor: AuthedSession, opts: { mine: boolean }): Promise<SessionSummary[]> {
  const where = isBoss(actor) && !opts.mine ? {} : { ownerUserId: { in: await visibleOwnerIds(actor) } };
  const sessions = await prisma.triageSession.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, include: { owner: { select: { name: true } } } });
  if (sessions.length === 0) return [];
  const restricted = new Set(await restrictedKindsFor(actor));
  const grouped = await prisma.triageQuestion.groupBy({ by: ["sessionId", "status", "kind"], where: { sessionId: { in: sessions.map((s) => s.id) } }, _count: { _all: true } });
  const rereadBy = new Map(
    (await prisma.triageQuestion.groupBy({ by: ["sessionId"], where: { sessionId: { in: sessions.map((s) => s.id) }, status: "answered", answerJson: { path: ["source"], equals: "ocr_reread" } }, _count: { _all: true } })).map((g) => [g.sessionId, g._count._all]),
  );
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
    return { id: s.id, source_type: s.sourceType, owner_user_id: s.ownerUserId, owner_name: s.owner.name, status: s.status, created_at: s.createdAt, completed_at: s.completedAt, counts, ocr_reread_answered: rereadBy.get(s.id) ?? 0, superseded_all: counts.superseded > 0 && counts.total === 0 };
  });
}

/** 「待答問題」數（badge 用，淨計重要嗰層，唔計補充資料）：老闆＝全部；其他＝自己嗰批。 */
// P3-1.2：`cache()`——layout 同首頁 TriageHomeNotice 同一個 render 內共用（按 actor 物件識別）。
export const countOpenFor = cache(async function countOpenFor(actor: Pick<AuthedSession, "baseRole" | "userId" | "roleId">): Promise<number> {
  const restricted = await restrictedKindsFor(actor);
  const owners = isBoss(actor) ? null : await visibleOwnerIds(actor as AuthedSession);
  return prisma.triageQuestion.count({ where: { status: "open", kind: { notIn: [...SUPPLEMENTARY_KINDS, ...restricted] }, session: owners ? { ownerUserId: { in: owners } } : {} } });
});

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
function evidenceCore(kind: string, ev: QuestionEvidence): string {
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

/** 題類：v2＝身份欄類；ext＝新欄類（只由 v3 包決定）；bank＝銀行類（只由有銀行段嘅包決定）。 */
const EXT_ONLY_KINDS: readonly string[] = ["ext_identity_check", "ext_field_conflict", "ext_field_review"];
const BANK_STRUCT_KINDS: readonly string[] = ["bank_review", "bank_identity_unknown"];
const V3_ONLY_KINDS: readonly string[] = [...EXT_ONLY_KINDS, ...BANK_STRUCT_KINDS];
export type KindClass = "v2" | "ext" | "bank";
export const kindClass = (kind: string): KindClass => (EXT_ONLY_KINDS.includes(kind) ? "ext" : BANK_STRUCT_KINDS.includes(kind) ? "bank" : "v2");
/** 全域 advisory lock：所有改 triage 題目嘅動作（自動 apply 出題、作答 commit）序列化，解決並發交錯。 */
export const TRIAGE_LOCK = "guard_import_triage";

/** 完整簽名＝證據核心＋人嘅全部 ext 值（答案用成個 person 寫入）。 */
function fullSignature(kind: string, ev: QuestionEvidence): string {
  return createHash("sha1").update(evidenceCore(kind, ev)).update(JSON.stringify(allExtSig(ev.person))).digest("hex");
}

/**
 * 簡化規則（Opus 第五輪；取代搬移／重開）：每次**自動 apply** 一個 guard_import 包，喺一個 transaction＋全域 advisory lock 入面：
 *  A. 對包內每個人記「強身份」（serverPersonKey＋解析到嘅目標 guard，所有 link 情況都有）同「弱身份」（身份證 HMAC＋每個工號 HMAC），
 *     連同包 hash／是否 v3／有冇銀行段，寫入 triage_person_applies（系統查詢，唔受任何用戶權限影響）；
 *  B. 作廢：所有 session（包括自己呢個）入面強身份同包內某人相同嘅 **open** 題——v2 類一律；ext_* 類只喺今次係 v3 包；
 *     bank_*（包括 bank_identity_unknown，按戶口 ref）只喺今次包有銀行段；
 *  C. 由今次評估結果全新建立 open 題（新 row，證據嚟自今次包）；唔搬移、唔重開舊 row；
 *  D. 唔再問：同一條未 superseded 嘅 answered／skipped 題（任何 session）「強身份相同＋kind 相同＋完整簽名相同」；
 *  E. 作答時（預覽＋commit，同一把 lock）見 apply.ts assertNoNewer；
 *  G. SESSION_SECRET 指紋唔同嘅舊 session open 題一律作廢（包括自己 session）。
 * 冇題目就唔開 session（但記錄同作廢照做）。呢度**唔會**寫任何保安員資料（淨係讀＋寫 triage 表）。
 */
export async function createGuardImportTriage(input: { pkg: ImportPackage; packageHash: string; actor: AuthedSession; ip: string | null; personKeys?: readonly string[]; results?: readonly { key: string; ext?: { key: string; outcome: string }[] }[]; /** false＝只記錄＋作廢，唔開新題（上載者冇「導入分診:view」） */ openQuestions?: boolean }): Promise<CreateTriageResult | OwnedByOtherResult | null> {
  const only = input.personKeys ? new Set(input.personKeys) : null;
  const now = new Date();
  const fp = keyFingerprint();
  const [viewPii, viewBank] = await Promise.all([hasPermission(input.actor, "安員個人資料", "view"), hasPermission(input.actor, "安員銀行資料", "view")]);
  const isV3 = input.pkg.version === 3;
  const hasBank = packageHasBank(input.pkg);

  const out = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
      const { evals: allEvals, guards } = await evaluateImportPackage(input.pkg, viewPii);
      const evals = only ? allEvals.filter((e) => only.has(e.person.key)) : allEvals;
      const written = new Map<string, Set<string>>();
      for (const r of input.results ?? []) {
        const ks = (r.ext ?? []).filter((x) => x.outcome === "written").map((x) => x.key);
        if (ks.length) written.set(r.key, new Set([...(written.get(r.key) ?? []), ...ks]));
      }
      const drafts = input.openQuestions === false ? [] : draftGuardImportQuestions(input.pkg, evals, { viewPii, viewBank, guards, written });
      const touched = new Set<string>();
      const supersede = async (where: Prisma.TriageQuestionWhereInput): Promise<void> => {
        const affected = await tx.triageQuestion.findMany({ where: { ...where, status: "open" }, select: { sessionId: true }, distinct: ["sessionId"] });
        if (affected.length === 0) return;
        await tx.triageQuestion.updateMany({ where: { ...where, status: "open" }, data: { status: "superseded" } });
        for (const a of affected) touched.add(a.sessionId);
      };

      // G. SESSION_SECRET 輪換：key 指紋唔同（或未記）嘅 session（包括自己呢個），open 題一律作廢
      await supersede({ session: { sourceType: "guard_import", OR: [{ keyFp: null }, { keyFp: { not: fp } }] } });

      // A. 強／弱身份記錄
      const people = new Map<string, { guardId: string | null; weak: Set<string> }>();
      for (const e of evals) {
        const k = serverPersonKey(e.person);
        const cur = people.get(k) ?? { guardId: null, weak: new Set<string>() };
        if (!cur.guardId && e.action === "link") cur.guardId = e.guardId;
        for (const w of weakIdsOf(e.person)) cur.weak.add(w);
        people.set(k, cur);
      }
      for (const u of unassignedBankOf(input.pkg)) people.set(bankAccountRef(u.bankCode, u.accountNo), { guardId: null, weak: new Set() });
      for (const [k, v] of people) {
        const weak = [...v.weak];
        await tx.$executeRaw`
          INSERT INTO triage_person_applies (person_key, guard_id, source_ref, is_v3, has_bank, weak_ids, applied_at)
          VALUES (${k}, ${v.guardId}, ${input.packageHash}, ${isV3}, ${hasBank}, ${weak}::text[], (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
          ON CONFLICT (person_key, source_ref) DO UPDATE SET guard_id = EXCLUDED.guard_id, is_v3 = EXCLUDED.is_v3, has_bank = EXCLUDED.has_bank, weak_ids = EXCLUDED.weak_ids, applied_at = EXCLUDED.applied_at`;
      }

      // B. 作廢（強身份相同；按題類）
      const keys = [...people.keys()];
      const guardIds = [...new Set([...people.values()].map((v) => v.guardId).filter((g): g is string => !!g))];
      const strong: Prisma.TriageQuestionWhereInput = { OR: [{ personKey: { in: keys } }, ...(guardIds.length ? [{ targetGuardId: { in: guardIds } }] : [])] };
      await supersede({ kind: { notIn: [...V3_ONLY_KINDS] }, ...strong });
      if (isV3) await supersede({ kind: { in: [...EXT_ONLY_KINDS] }, ...strong });
      if (hasBank) await supersede({ kind: { in: [...BANK_STRUCT_KINDS] }, ...strong });

      // D. 唔再問：未 superseded 嘅 answered／skipped 題（任何 session），強身份＋kind＋完整簽名相同
      const prior = await tx.triageQuestion.findMany({
        where: { status: { in: ["answered", "skipped"] }, personKey: { in: drafts.map((d) => d.personKey) } },
        select: { personKey: true, targetGuardId: true, kind: true, evidenceJson: true },
      });
      const seen = new Set(prior.map((q) => `${q.personKey}|${q.targetGuardId ?? ""}|${q.kind}|${fullSignature(q.kind, q.evidenceJson as unknown as QuestionEvidence)}`));
      const fresh = drafts.filter((d) => !seen.has(`${d.personKey}|${d.targetGuardId ?? ""}|${d.kind}|${fullSignature(d.kind, d.evidence)}`));

      // C. 全新 open 題（新 row）
      const existing = await tx.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "guard_import", sourceRef: input.packageHash } } });
      let session = existing;
      if (!session && fresh.length > 0) {
        session = await tx.triageSession.create({
          data: { sourceType: "guard_import", sourceRef: input.packageHash, ownerUserId: input.actor.userId, createdBy: input.actor.userId, statsJson: {}, keyFp: fp, lastAppliedAt: now },
        });
      } else if (session) {
        await tx.triageSession.update({ where: { id: session.id }, data: { keyFp: fp, lastAppliedAt: now } });
      }
      if (session && fresh.length > 0) {
        await tx.triageQuestion.createMany({
          data: fresh.map((d) => ({
            sessionId: session!.id,
            kind: d.kind,
            groupKey: d.groupKey,
            sort: d.sort,
            title: d.title,
            personKey: d.personKey,
            targetGuardId: d.targetGuardId,
            evidenceJson: JSON.parse(JSON.stringify(d.evidence)),
            optionsJson: JSON.parse(JSON.stringify(d.options)),
          })),
        });
      }
      if (session) touched.add(session.id);
      for (const id of touched) {
        const open = await tx.triageQuestion.count({ where: { sessionId: id, status: "open" } });
        const status = open === 0 ? "done" : "open";
        await tx.triageSession.updateMany({ where: { id, status: { not: status } }, data: { status, completedAt: status === "done" ? new Date() : null } });
      }
      if (!session) return null;
      const byKind: Record<string, number> = {};
      for (const g of await tx.triageQuestion.groupBy({ by: ["kind"], where: { sessionId: session.id, status: { not: "superseded" } }, _count: { _all: true } })) byKind[g.kind] = g._count._all;
      const total = Object.values(byKind).reduce((a, b) => a + b, 0);
      await tx.triageSession.update({ where: { id: session.id }, data: { statsJson: { total, by_kind: byKind } } });
      const open = await tx.triageQuestion.count({ where: { sessionId: session.id, status: "open" } });
      const supplementary = await tx.triageQuestion.count({ where: { sessionId: session.id, status: "open", kind: { in: [...SUPPLEMENTARY_KINDS] } } });
      return { session, isNew: !existing, fresh: fresh.length, byKind, total, open, supplementary };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  if (!out) return null;
  if (out.isNew || out.fresh > 0) {
    await writeAudit({
      actorUserId: input.actor.userId,
      tableName: "triage_sessions",
      rowId: out.session.id,
      action: "triage_session_create",
      after: { source_type: "guard_import", owner_user_id: out.session.ownerUserId, new_questions: out.fresh, total_questions: out.total, by_kind: out.byKind },
      ip: input.ip,
    });
  }
  // 屬於別人嘅 session：唔回 session 內容，淨係話俾上載者知
  if (out.session.ownerUserId !== input.actor.userId) return { owned_by_other: true, new_questions: out.fresh };
  return { session_id: out.session.id, open_questions: out.open, new_questions: out.fresh, total_questions: out.total, important_open: out.open - out.supplementary, supplementary_open: out.supplementary };
}
