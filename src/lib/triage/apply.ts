// WP-AI-OPS §28.4：答題流程——預覽影響 → 確認 → 經現有導入路徑（applyOnePerson／applyPerson）寫入。
//  - 唔存在「直接 update」：全部寫入都係 `applyOnePerson`（同批量導入同一套唯一性／只寫 confirmed／已決定欄／audit）。
//  - 預覽＝實際寫入：預覽回一個 preview_hash（題目 id＋答案＋寫入指紋）；確認時喺同一個 transaction 內重算
//    指紋，唔一致（資料中途變咗）就 rollback + 409，要重新預覽。
//  - 已答嘅題目唔可以重複套用（同一 transaction 內 updateMany status in (open,skipped) 計 count）。
//  - audit：每個答案一條 triage_answer（邊個答、邊條題、揀咗乜選項、結果計數；冇 PII）＋有寫入就一條 guard_import_apply summary。
import { createHmac } from "node:crypto";
import type { Prisma, TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { ApiError, BadRequest, Conflict, Forbidden } from "@/lib/api/errors";
import { canonicalHkid } from "@/lib/guards/identity";
import { fieldValue } from "@/lib/guards/import/package";
import { normZh } from "@/lib/guards/import/text";
import { applyOnePerson, extOutcomeOf, summarizeExt, type ApplyOptions } from "@/lib/guards/import/apply";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { resolveAnswer, type ResolvedWrite } from "./resolve";
import { refreshSessionStatus } from "./session";
import { buildImpact, toImpactSource, type ImpactView, type ViewerCaps } from "./view";
import { sameEnglishTokens } from "./generators/guard-import";
import { TRIAGE_LOCK, kindClass } from "./session";
import { identityFollowUps } from "./generators/guard-import";
import { BANK_KINDS, answerSchema, type QuestionEvidence, type QuestionKind, type QuestionOption, type TriageAnswer } from "./types";

type QRow = TriageQuestion;

function canon(a: TriageAnswer): string {
  const o = a as unknown as Record<string, unknown>;
  const fields = a.fields ? Object.fromEntries(Object.keys(a.fields).sort().map((k) => [k, (a.fields as Record<string, unknown>)[k]])) : undefined;
  return JSON.stringify({ ...Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])), ...(fields ? { fields } : {}) });
}
function hmacKey(): string {
  const k = process.env.SESSION_SECRET;
  if (!k || k.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return k;
}
// HMAC（server secret）：冇 secret 就算知道寫入指紋格式都唔可以離線算出 hash 去分辨預覽結果（oracle）
const hashOf = (qid: string, a: TriageAnswer, fingerprint: string): string => createHmac("sha256", hmacKey()).update(`${qid}|${canon(a)}|${fingerprint}`).digest("hex");

/** audit 摘要唔放 ext_conflicts（衝突數會洩露「同現值唔同」，而 audit 讀者可能冇對應 view） */
const omitConflicts = <T extends { ext_conflicts?: number }>(s: T): Omit<T, "ext_conflicts"> => {
  const { ext_conflicts: _c, ...rest } = s;
  void _c;
  return rest;
};

function load(q: QRow) {
  return { kind: q.kind as QuestionKind, evidence: q.evidenceJson as unknown as QuestionEvidence, options: q.optionsJson as unknown as QuestionOption[] };
}

function assertAnswerable(q: QRow): void {
  if (q.status === "answered") throw Conflict("呢條問題已經答過，唔可以重複套用");
  if (q.status === "superseded") throw Conflict("已有較新資料，請答新題");
}

/**
 * 作答時（預覽＋commit tx 內，同一把 TRIAGE_LOCK）：呢條題必須屬於「最近一次包含呢個強身份（人 key 或目標 guard）嘅同類包」
 * （v2 類＝任何包；ext 類＝v3 包；bank 類＝有銀行段嘅包），而且冇較新嘅包入面有人同呢條題嘅人弱身份重疊（身份證／工號 HMAC）
 * 而強身份唔同（有／冇身份證交替、工號集合變）→ 409，寧可擋，唔好寫舊值。
 * 訊息唔洩露佢冇權睇嘅嘢。triage_person_applies 一律用系統查詢，唔受呼叫者權限影響。
 */
async function assertNoNewer(db: Prisma.TransactionClient | typeof prisma, q: QRow, actor?: Pick<AuthedSession, "userId" | "baseRole">): Promise<void> {
  if (!q.personKey && !q.targetGuardId) return; // 舊資料（冇記錄）
  const mine = await db.triageSession.findUnique({ where: { id: q.sessionId }, select: { sourceRef: true } });
  if (!mine) return;
  const cls = kindClass(q.kind);
  const classWhere = cls === "ext" ? { isV3: true } : cls === "bank" ? { hasBank: true } : {};
  const latest = await db.triagePersonApply.findFirst({
    where: { OR: [...(q.personKey ? [{ personKey: q.personKey }] : []), ...(q.targetGuardId ? [{ guardId: q.targetGuardId }] : [])], ...classWhere },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
  });
  if (latest && latest.sourceRef !== mine.sourceRef) {
    const newer = await db.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "guard_import", sourceRef: latest.sourceRef } }, select: { ownerUserId: true } });
    if (newer && actor && newer.ownerUserId !== actor.userId && actor.baseRole !== "老闆") throw Conflict("已有較新嘅導入取代咗呢題，請搵上載較新檔案嘅同事或者老闆跟進");
    throw Conflict(newer ? "已有較新嘅導入取代咗呢題，請答較新嗰批嘅題" : "已有較新嘅導入取代咗呢題（新資料已經唔需要處理）");
  }
  // 弱身份重疊（較新嘅包、強身份唔同）
  const own = q.personKey ? await db.triagePersonApply.findUnique({ where: { personKey_sourceRef: { personKey: q.personKey, sourceRef: mine.sourceRef } } }) : null;
  if (own && own.weakIds.length > 0) {
    const hit = await db.$queryRaw<{ id: number }[]>`
      SELECT id FROM triage_person_applies
      WHERE applied_at > (${own.appliedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC') AND source_ref <> ${mine.sourceRef} AND weak_ids && ${own.weakIds}::text[]
        AND person_key <> ${q.personKey} AND (guard_id IS NULL OR guard_id IS DISTINCT FROM ${q.targetGuardId}::text)
      LIMIT 1`;
    if (hit.length > 0) throw Conflict("呢位保安員有較新嘅導入資料，請重新上載最新檔案再答");
  }
}

const BANK_QUESTION_DENIED_MSG = "要有保安員銀行資料權限嘅同事處理";
function assertBankAllowed(q: QRow, caps: ViewerCaps): void {
  // 身份確認會繞過自動寫入閘：要「保安員個人資料:view」＋「保安員:update」
  if (q.kind === "ext_identity_check" && !(caps.pii && caps.guardUpdate)) throw Forbidden("要有保安員個人資料查看＋保安員修改權限嘅同事處理");
  if ((BANK_KINDS as readonly string[]).includes(q.kind) && !caps.bankUpdate) throw Forbidden(BANK_QUESTION_DENIED_MSG);
}

/** 銀行答案規則（喺 resolve 同評估之前檢查，結果唔准取決於現有戶口）：冇「保安員銀行資料:view」睇唔到現有戶口 → 一律要明確揀「取代現有戶口」。 */
function assertBankAnswerRules(q: QRow, answer: TriageAnswer, caps: ViewerCaps): void {
  const writesBank = answer.option === "assign_bank" || (answer.option === "apply_ext_fields" && answer.ext_fields?.bank === "use_import");
  if (writesBank && (BANK_KINDS as readonly string[]).includes(q.kind) && !caps.bankView && !answer.replace_existing) {
    throw new ApiError(422, "unprocessable", "你冇「保安員銀行資料」睇權，睇唔到現有戶口，要明確剔「取代現有戶口」先可以寫入");
  }
}

/** 銀行寫入問題（回 null＝冇問題）：用導入值／assign_bank 但實際冇寫（現有唔同而冇明確取代、戶口屬另一人…）。 */
function bankProblem(answer: TriageAnswer, result: import("@/lib/guards/import/apply").PersonResult): string | null {
  const wants = answer.option === "assign_bank" || (answer.option === "apply_ext_fields" && answer.ext_fields?.bank === "use_import");
  if (!wants) return null;
  const o = extOutcomeOf(result, "bank");
  if (o === "written" || (o === "same" && answer.option === "apply_ext_fields")) return null;
  if (result.reasons.includes("bank_acct_belongs_to_other")) return "呢個戶口已屬於另一位保安員，唔可以再派俾其他人";
  return BANK_NOT_WRITTEN_NOTE;
}

/** M7：經搜尋揀咗唔夾英文名／唔係長工 autopay 嘅人 → 要額外確認。 */
async function identityMismatch(q: QRow, answer: TriageAnswer): Promise<string | null> {
  if (answer.option !== "assign_bank" || !answer.guard_id) return null;
  const u = (q.evidenceJson as unknown as QuestionEvidence).unassigned;
  const g = await prisma.guard.findUnique({ where: { id: answer.guard_id }, select: { nameEn: true, employmentType: true, longtermContracts: { select: { id: true }, take: 1 } } });
  if (!u || !g) return null;
  const longterm = g.employmentType === "longterm_autopay" || g.longtermContracts.length > 0; // 同 hireDate 閘一致
  const reasons: string[] = [];
  if (!g.nameEn || !sameEnglishTokens(u.payeeName, g.nameEn)) reasons.push("收款人英文名同呢位保安員嘅英文名唔夾（或者佢冇英文名）");
  if (!longterm) reasons.push("呢位保安員唔係長工 autopay");
  return reasons.length ? `警告：${reasons.join("；")}。要剔「我確認呢個戶口屬於呢位保安員」先可以確認` : null;
}

const BANK_GENERIC_PREVIEW_NOTE = "會嘗試寫入銀行資料；如果寫入唔到，確認時會提示";
const BANK_GENERIC_FAIL = "寫入唔到，請搵有保安員銀行資料查看權限嘅同事處理";
const BANK_NOT_WRITTEN_NOTE = "呢個答案唔會寫入戶口：目標保安員已有唔同戶口（要明確揀「取代現有戶口」，而且要有保安員銀行資料修改權限），或者戶口已經係佢嘅";

function optsFor(r: ResolvedWrite, actor: AuthedSession, ip: string | null, caps: ViewerCaps): ApplyOptions {
  // 冇「保安員個人資料:update」：可以新建／補空欄／確認包內值，唔准覆蓋現有唔同嘅 PII（applyPerson 會 403）
  return { actorUserId: actor.userId, ip, decisions: r.decisions, forced: r.forced, autoKeepPendingName: r.autoKeepPendingName, canOverwritePii: caps.piiUpdate, canEditGuard: caps.guardUpdate, canEditBank: caps.bankUpdate, fillOnlyPii: !caps.pii, via: "triage" };
}

/**
 * enter_hkid／use_package_hkid：輸入嘅身份證號如果已屬於一位「唔喺候選名單」嘅現有保安員，
 * 只有姓名同導入包完全相同先准（預覽要警告），否則 422。回 true＝要警告。
 */
async function checkHkidOwner(q: QRow, answer: TriageAnswer): Promise<boolean> {
  if (answer.option !== "enter_hkid" && answer.option !== "use_package_hkid") return false;
  const ev = q.evidenceJson as unknown as QuestionEvidence;
  const canon = canonicalHkid(answer.option === "enter_hkid" ? (answer.value ?? null) : fieldValue(ev.person.hkid));
  if (!canon) return false; // resolveAnswer 會 400
  const owner = await prisma.guard.findFirst({ where: { hkid: canon }, select: { id: true, nameZh: true } });
  if (!owner || ev.candidate_guard_ids.includes(owner.id)) return false;
  const a = normZh(owner.nameZh);
  if (a && a === normZh(fieldValue(ev.person.nameZh))) return true;
  throw new ApiError(422, "unprocessable", "身份證號已屬於另一位保安員，請留返人手核對");
}

export interface PreviewOutput {
  preview_hash: string;
  writes: boolean;
  impact: ImpactView;
}

export async function previewAnswer(actor: AuthedSession, q: QRow, rawAnswer: unknown, caps: ViewerCaps, ip: string | null): Promise<PreviewOutput> {
  assertAnswerable(q);
  await assertNoNewer(prisma, q, actor);
  assertBankAllowed(q, caps);
  const answer = parseAnswer(rawAnswer);
  assertBankAnswerRules(q, answer, caps);
  const resolved = resolveAnswer(load(q), answer);
  const warnOwner = await checkHkidOwner(q, answer);
  const mismatch = await identityMismatch(q, answer);
  if (resolved.mode === "skip") {
    return { preview_hash: hashOf(q.id, answer, "skip"), writes: false, impact: { can_confirm: true, summary: ["跳過：唔寫任何資料，呢條留返人手處理"], changes: [], field_outcomes: [], notes: [] } };
  }
  const out = await applyOnePerson(resolved.pkg, optsFor(resolved, actor, ip, caps), { kind: "dry" });
  const impact = buildImpact(out.result, out.changes, caps);
  if (warnOwner) impact.notes.unshift("呢個身份證號已屬於現有保安員（唔喺候選名單），而且姓名相同，會連去佢");
  // N3：冇「保安員銀行資料:view」→ 預覽一律同一個 generic 結果（can_confirm 唔視乎戶口是否已被用），寫唔到留到 commit 先擋
  const problem = caps.bankView ? bankProblem(answer, out.result) : null;
  if (!caps.bankView && (answer.option === "assign_bank" || (answer.option === "apply_ext_fields" && answer.ext_fields?.bank === "use_import"))) impact.notes.unshift(BANK_GENERIC_PREVIEW_NOTE);
  if (problem) {
    impact.can_confirm = false;
    impact.notes.unshift(problem);
  }
  if (mismatch) {
    impact.notes.unshift(mismatch);
    if (!answer.confirm_identity) impact.can_confirm = false;
  }
  return { preview_hash: hashOf(q.id, answer, out.fingerprint), writes: impact.can_confirm, impact };
}

function parseAnswer(raw: unknown): TriageAnswer {
  const r = answerSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`答案格式唔啱（${i ? i.path.join(".") : "unknown"}）`);
  }
  return r.data;
}

export interface AnswerOutput {
  status: "answered" | "skipped";
  impact: ImpactView | null;
  session_status: "open" | "done";
  open_remaining: number;
}

export async function submitAnswer(actor: AuthedSession, q: QRow, rawAnswer: unknown, previewHash: string | undefined, caps: ViewerCaps, ip: string | null, extra?: { source: "ocr_reread" }): Promise<AnswerOutput> {
  assertAnswerable(q);
  await assertNoNewer(prisma, q, actor);
  assertBankAllowed(q, caps);
  const answer = parseAnswer(rawAnswer);
  assertBankAnswerRules(q, answer, caps);
  const resolved = resolveAnswer(load(q), answer);
  await checkHkidOwner(q, answer);
  const mismatch = await identityMismatch(q, answer);
  if (mismatch && !answer.confirm_identity) throw new ApiError(422, "unprocessable", mismatch);
  const now = new Date();

  if (resolved.mode === "skip") {
    await prisma.$transaction(async (tx) => {
      const n = await tx.triageQuestion.updateMany({
        where: { id: q.id, status: { in: ["open", "skipped"] } },
        data: { status: "skipped", answerJson: { option: "skip" }, answeredBy: actor.userId, answeredAt: now },
      });
      if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
      await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_answer", after: { session_id: q.sessionId, kind: q.kind, option: "skip", writes: false }, ip });
    });
    return await finish("skipped", null, q.sessionId);
  }

  if (!previewHash) throw BadRequest("要先預覽影響，再帶返 preview_hash 確認");
  let impact: ImpactView | null = null;
  await applyOnePerson(resolved.pkg, optsFor(resolved, actor, ip, caps), {
    kind: "commit",
    verify: (fp) => hashOf(q.id, answer, fp) === previewHash,
    beforeCommit: async (tx, outcome) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
      await assertNoNewer(tx, q, actor);
      const bp = bankProblem(answer, outcome.result);
      if (bp) throw new ApiError(422, "unprocessable", caps.bankView ? bp : BANK_GENERIC_FAIL);
      impact = buildImpact(outcome.result, outcome.changes, caps);
      const n = await tx.triageQuestion.updateMany({
        where: { id: q.id, status: { in: ["open", "skipped"] } },
        data: {
          status: "answered",
          answerJson: JSON.parse(JSON.stringify(extra ? { ...answer, source: extra.source } : answer)),
          answeredBy: actor.userId,
          answeredAt: now,
          // 存原始結構化值（白名單欄），讀取時按讀者權限遮罩；唔存答題人視角嘅已遮罩版本
          impactJson: JSON.parse(JSON.stringify(toImpactSource(outcome.result, outcome.changes))),
          // 寫入結果：淨係結果碼／計數（冇 PII）
          applyResultJson: JSON.parse(JSON.stringify({ outcome: outcome.result.outcome, fields: outcome.result.fields, reasons: outcome.result.reasons, staff_numbers_added: outcome.result.staff_numbers_added, phones_added: outcome.result.phones_added, addresses_added: outcome.result.addresses_added, ...(outcome.result.ext ? { ext: outcome.result.ext } : {}) })),
        },
      });
      if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
      // R2：身份確認（照寫入）之後，仍然 held／冇寫到／衝突嘅欄（長工入職日期、銀行、衝突）補開跟進題；鎖定同一個目標 guard
      if (q.kind === "ext_identity_check" && answer.option === "confirm_ext_identity") {
        const ev = q.evidenceJson as unknown as QuestionEvidence;
        const follow = identityFollowUps(ev.person, outcome.result.ext ?? [], ev.guard_id ?? null, q.sort);
        const openKeys = new Set((await tx.triageQuestion.findMany({ where: { sessionId: q.sessionId, status: "open", groupKey: { in: follow.map((d) => d.groupKey) } }, select: { groupKey: true } })).map((x) => x.groupKey));
        const followNew = follow.filter((d) => !openKeys.has(d.groupKey));
        if (followNew.length) {
          await tx.triageQuestion.createMany({
            data: followNew.map((d) => ({
              sessionId: q.sessionId,
              kind: d.kind,
              groupKey: d.groupKey,
              personKey: d.personKey,
              targetGuardId: d.targetGuardId,
              sort: d.sort,
              title: d.title,
              evidenceJson: JSON.parse(JSON.stringify(d.evidence)),
              optionsJson: JSON.parse(JSON.stringify(d.options)),
            })),
          });
        }
      }
      const r = outcome.result;
      await writeAuditTx(tx, {
        actorUserId: actor.userId,
        tableName: "triage_questions",
        rowId: q.id,
        action: "triage_answer",
        after: { session_id: q.sessionId, kind: q.kind, option: answer.option, writes: true, outcome: r.outcome, manual_confirmed: !extra, ...(extra ? { answered_via: extra.source } : {}) },
        ip,
      });
      // 同 guard_import_apply summary 一致形狀（月度修正摘要會計入「覆核決定」）
      await writeAuditTx(tx, {
        actorUserId: actor.userId,
        tableName: "guard_import",
        rowId: actor.userId,
        action: "guard_import_apply",
        after: {
          persons: 1,
          outcomes: { created: r.outcome === "created" ? 1 : 0, linked: r.outcome === "linked" ? 1 : 0, conflict: 0, needs_review: 0, error: 0 },
          guards_created: r.outcome === "created" ? 1 : 0,
          guards_updated: outcome.changes.filter((c) => c.table === "guards" && c.action === "update").length,
          phones_added: r.phones_added,
          addresses_added: r.addresses_added,
          staff_numbers_added: r.staff_numbers_added,
          ...omitConflicts(summarizeExt([r])),
          field_conflicts: Object.values(r.fields).filter((v) => v === "conflict").length,
          review_decisions: 1,
          via: "triage",
          question_id: q.id,
          ...(extra ? { answered_via: extra.source } : {}),
        },
        ip,
      });
    },
  });
  return await finish("answered", impact, q.sessionId);
}

async function finish(status: "answered" | "skipped", impact: ImpactView | null, sessionId: string): Promise<AnswerOutput> {
  const session_status = await refreshSessionStatus(sessionId);
  const open_remaining = await prisma.triageQuestion.count({ where: { sessionId, status: "open" } });
  return { status, impact, session_status, open_remaining };
}
