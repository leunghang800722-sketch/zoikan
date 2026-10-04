// WP-AI-OPS §28.4：答題流程——預覽影響 → 確認 → 經現有導入路徑（applyOnePerson／applyPerson）寫入。
//  - 唔存在「直接 update」：全部寫入都係 `applyOnePerson`（同批量導入同一套唯一性／只寫 confirmed／已決定欄／audit）。
//  - 預覽＝實際寫入：預覽回一個 preview_hash（題目 id＋答案＋寫入指紋）；確認時喺同一個 transaction 內重算
//    指紋，唔一致（資料中途變咗）就 rollback + 409，要重新預覽。
//  - 已答嘅題目唔可以重複套用（同一 transaction 內 updateMany status in (open,skipped) 計 count）。
//  - audit：每個答案一條 triage_answer（邊個答、邊條題、揀咗乜選項、結果計數；冇 PII）＋有寫入就一條 guard_import_apply summary。
import { createHash } from "node:crypto";
import type { TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { applyOnePerson, type ApplyOptions } from "@/lib/guards/import/apply";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { resolveAnswer, type ResolvedWrite } from "./resolve";
import { refreshSessionStatus } from "./session";
import { buildImpact, type ImpactView, type ViewerCaps } from "./view";
import { answerSchema, type QuestionEvidence, type QuestionKind, type QuestionOption, type TriageAnswer } from "./types";

type QRow = TriageQuestion;

function canon(a: TriageAnswer): string {
  const o = a as unknown as Record<string, unknown>;
  const fields = a.fields ? Object.fromEntries(Object.keys(a.fields).sort().map((k) => [k, (a.fields as Record<string, unknown>)[k]])) : undefined;
  return JSON.stringify({ ...Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])), ...(fields ? { fields } : {}) });
}
const hashOf = (qid: string, a: TriageAnswer, fingerprint: string): string => createHash("sha256").update(`${qid}|${canon(a)}|${fingerprint}`).digest("hex");

function load(q: QRow) {
  return { kind: q.kind as QuestionKind, evidence: q.evidenceJson as unknown as QuestionEvidence, options: q.optionsJson as unknown as QuestionOption[] };
}

function assertAnswerable(q: QRow): void {
  if (q.status === "answered") throw Conflict("呢條問題已經答過，唔可以重複套用");
}

function optsFor(r: ResolvedWrite, actor: AuthedSession, ip: string | null): ApplyOptions {
  return { actorUserId: actor.userId, ip, decisions: r.decisions, forced: r.forced, autoKeepPendingName: r.autoKeepPendingName };
}

export interface PreviewOutput {
  preview_hash: string;
  writes: boolean;
  impact: ImpactView;
}

export async function previewAnswer(actor: AuthedSession, q: QRow, rawAnswer: unknown, caps: ViewerCaps, ip: string | null): Promise<PreviewOutput> {
  assertAnswerable(q);
  const answer = parseAnswer(rawAnswer);
  const resolved = resolveAnswer(load(q), answer);
  if (resolved.mode === "skip") {
    return { preview_hash: hashOf(q.id, answer, "skip"), writes: false, impact: { can_confirm: true, summary: ["跳過：唔寫任何資料，呢條留返人手處理"], changes: [], field_outcomes: [], notes: [] } };
  }
  const out = await applyOnePerson(resolved.pkg, optsFor(resolved, actor, ip), { kind: "dry" });
  const impact = buildImpact(out.result, out.changes, caps);
  return { preview_hash: hashOf(q.id, answer, out.fingerprint), writes: impact.can_confirm, impact };
}

export function parseAnswer(raw: unknown): TriageAnswer {
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

export async function submitAnswer(actor: AuthedSession, q: QRow, rawAnswer: unknown, previewHash: string | undefined, caps: ViewerCaps, ip: string | null): Promise<AnswerOutput> {
  assertAnswerable(q);
  const answer = parseAnswer(rawAnswer);
  const resolved = resolveAnswer(load(q), answer);
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
  await applyOnePerson(resolved.pkg, optsFor(resolved, actor, ip), {
    kind: "commit",
    verify: (fp) => hashOf(q.id, answer, fp) === previewHash,
    beforeCommit: async (tx, outcome) => {
      impact = buildImpact(outcome.result, outcome.changes, caps);
      const n = await tx.triageQuestion.updateMany({
        where: { id: q.id, status: { in: ["open", "skipped"] } },
        data: {
          status: "answered",
          answerJson: JSON.parse(JSON.stringify(answer)),
          answeredBy: actor.userId,
          answeredAt: now,
          impactJson: JSON.parse(JSON.stringify(impact)),
          // 寫入結果：淨係結果碼／計數（冇 PII）
          applyResultJson: JSON.parse(JSON.stringify({ outcome: outcome.result.outcome, fields: outcome.result.fields, reasons: outcome.result.reasons, staff_numbers_added: outcome.result.staff_numbers_added, phones_added: outcome.result.phones_added, addresses_added: outcome.result.addresses_added })),
        },
      });
      if (n.count !== 1) throw Conflict("呢條問題已經答過，唔可以重複套用");
      const r = outcome.result;
      await writeAuditTx(tx, {
        actorUserId: actor.userId,
        tableName: "triage_questions",
        rowId: q.id,
        action: "triage_answer",
        after: { session_id: q.sessionId, kind: q.kind, option: answer.option, writes: true, outcome: r.outcome, manual_confirmed: true },
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
          field_conflicts: Object.values(r.fields).filter((v) => v === "conflict").length,
          review_decisions: 1,
          via: "triage",
          question_id: q.id,
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
