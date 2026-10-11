// P8.2：待答題「批量接受建議」。
//  - 只處理「一鍵結算／補齊價目卡」嘅 month_close_* 題（有系統預填建議答案＝evidence.prefillCandidateId 且選項有 mc_accept）。
//    保安員導入題（guard_import）冇「系統建議答案」概念，一律 skipped（no_suggestion），要逐題人手答。
//  - 逐題行現有流程：previewMcAnswer（預覽、攞 preview_hash）→ submitMcAnswer（同單題完全同一條寫入路徑、同鎖月檢查、同 audit，
//    只係 audit after 多 batch_id）。一題失敗唔影響其餘。
//  - 任何一題屬已鎖月份 → 整個請求 403（預先檢查，唔寫任何嘢）。
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError, BadRequest, Locked } from "@/lib/api/errors";
import { isMonthLocked } from "@/lib/month-lock";
import { mcQuestionViews, previewMcAnswer, submitMcAnswer } from "@/lib/month-close/auto/triage";
import type { McEvidence } from "@/lib/month-close/auto/types";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { z } from "zod";
import { canAccessOwnedBy, listSessionsFor } from "./session";
import type { QuestionOption } from "./types";

/** 每個 request 最多幾題（逐題串行，過多會逾時）；UI 自動分批。 */
const BATCH_ACCEPT_MAX = 50;
export const batchAcceptBodySchema = z.object({ question_ids: z.array(z.string().min(1).max(64)).min(1).max(BATCH_ACCEPT_MAX) }).strict();

const MC_SOURCES = ["month_close", "postorder_backfill"] as const;
const ACCEPT_ANSWER = { option: "mc_accept" } as const;

type BatchItemStatus = "answered" | "skipped" | "error";
interface BatchItemResult {
  id: string;
  status: BatchItemStatus;
  reason: string | null;
}
export interface BatchAcceptResult {
  batch_id: string;
  results: BatchItemResult[];
  counts: { answered: number; skipped: number; error: number };
}

export interface BatchAcceptablePreviewItem {
  id: string;
  session_id: string;
  kind: string;
  kind_label: string;
  title: string;
  month: string;
  summary: string;
  suggestion: string | null;
  confidence: "propose" | "unknown";
  count: number | null;
  identity_label: string | null;
}

function hasSuggestion(q: { optionsJson: unknown; evidenceJson: unknown }): boolean {
  const opts = q.optionsJson as QuestionOption[];
  const ev = q.evidenceJson as McEvidence;
  return Array.isArray(opts) && opts.some((o) => o.id === "mc_accept") && !!ev?.prefillCandidateId;
}

/** 可批量接受清單（唔寫任何嘢）。scope：session_id 或 month（YYYY-MM）。已鎖月份唔列。 */
export async function listBatchAcceptable(actor: AuthedSession, scope: { sessionId?: string; month?: string }): Promise<BatchAcceptablePreviewItem[]> {
  if (!(await hasPermission(actor, "一鍵結算", "create"))) return []; // 冇權答 mc 題就冇嘢可批量接受
  const caps = { pii: await hasPermission(actor, "安員個人資料", "view") };
  let sessionIds: string[];
  if (scope.sessionId) {
    const s = await prisma.triageSession.findUnique({ where: { id: scope.sessionId } });
    if (!s) throw new ApiError(404, "not_found", "搵唔到");
    if (!(await canAccessOwnedBy(actor, s.ownerUserId))) throw new ApiError(403, "forbidden", "呢批分診唔係你上載嘅");
    sessionIds = (MC_SOURCES as readonly string[]).includes(s.sourceType) ? [s.id] : [];
  } else {
    const list = await listSessionsFor(actor, { mine: false });
    sessionIds = list.filter((x) => (MC_SOURCES as readonly string[]).includes(x.source_type) && x.counts.open > 0).map((x) => x.id);
  }
  if (sessionIds.length === 0) return [];
  const rows = await prisma.triageQuestion.findMany({ where: { sessionId: { in: sessionIds }, status: "open" }, orderBy: [{ sort: "asc" }, { id: "asc" }] });
  const eligible = rows.filter((r) => hasSuggestion(r) && (!scope.month || (r.evidenceJson as unknown as McEvidence).month.slice(0, 7) === scope.month));
  const lockedCache = new Map<string, boolean>();
  const open: typeof eligible = [];
  for (const r of eligible) {
    const m = (r.evidenceJson as unknown as McEvidence).month;
    if (!lockedCache.has(m)) lockedCache.set(m, await isMonthLocked(new Date(`${m}T00:00:00.000Z`)));
    if (!lockedCache.get(m)) open.push(r);
  }
  const views = await mcQuestionViews(open, caps);
  const monthOf = new Map(open.map((r) => [r.id, (r.evidenceJson as unknown as McEvidence).month.slice(0, 7)]));
  return views.map((v) => ({
    id: v.id,
    session_id: v.session_id,
    kind: v.kind,
    kind_label: v.kind_label,
    title: v.title,
    month: monthOf.get(v.id) ?? "",
    summary: v.mc.summary,
    suggestion: v.mc.suggestion,
    confidence: v.mc.confidence,
    count: v.mc.count,
    identity_label: v.mc.identity_label,
  }));
}

function reasonOf(e: unknown): string {
  // ApiError 訊息係 lib 自己寫嘅中文句（唔含 PII）；其他錯誤唔洩露內容
  return e instanceof ApiError ? e.message.slice(0, 200) : "內部錯誤";
}

export async function runBatchAccept(actor: AuthedSession, questionIds: string[], ip: string | null): Promise<BatchAcceptResult> {
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) throw BadRequest("請揀至少一題");
  if (ids.length > BATCH_ACCEPT_MAX) throw BadRequest(`一次最多 ${BATCH_ACCEPT_MAX} 題`);
  const rows = await prisma.triageQuestion.findMany({ where: { id: { in: ids } }, include: { session: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 預先檢查：任何一題屬已鎖月份 → 整批 403，唔寫任何嘢
  for (const r of rows) {
    if (!(MC_SOURCES as readonly string[]).includes(r.session.sourceType)) continue;
    const m = (r.evidenceJson as unknown as McEvidence).month;
    if (m && (await isMonthLocked(new Date(`${m}T00:00:00.000Z`)))) throw Locked(`${m.slice(0, 7)} 已鎖定，唔可以批量接受建議`);
  }
  const batchId = randomUUID();
  const results: BatchItemResult[] = [];
  for (const id of ids) {
    const q = byId.get(id);
    if (!q) {
      results.push({ id, status: "error", reason: "搵唔到呢條問題" });
      continue;
    }
    if (!(await canAccessOwnedBy(actor, q.session.ownerUserId))) {
      results.push({ id, status: "error", reason: "呢條問題唔係你上載嗰批" });
      continue;
    }
    if (q.status !== "open") {
      results.push({ id, status: "skipped", reason: q.status === "answered" ? "already_answered" : "not_open" });
      continue;
    }
    if (!(MC_SOURCES as readonly string[]).includes(q.session.sourceType) || !hasSuggestion(q)) {
      results.push({ id, status: "skipped", reason: "no_suggestion" });
      continue;
    }
    try {
      const pv = await previewMcAnswer(actor, q, ACCEPT_ANSWER);
      if (!pv.impact.can_confirm) {
        results.push({ id, status: "skipped", reason: "cannot_confirm" });
        continue;
      }
      await submitMcAnswer(actor, q, ACCEPT_ANSWER, pv.preview_hash, ip, { batchId });
      results.push({ id, status: "answered", reason: null });
    } catch (e) {
      results.push({ id, status: "error", reason: reasonOf(e) });
    }
  }
  const counts = { answered: 0, skipped: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  return { batch_id: batchId, results, counts };
}
