// WP-AI-DIAG（§37.4／2.5）：助手「建議動作卡」→ 現有 API request 嘅對照（純函數，無 React、無副作用）。
//
// 硬規則：撳卡之後發出嘅 request 必須同「人手操作嗰個頁面」一字不差（URL、method、body）：
// - one_click_run            ← src/app/(app)/month-close/page.tsx `startOneClick()`：POST /api/month-close/one-click { month }
// - backfill_from_postorder  ← src/app/(app)/month-close/BackfillButton.tsx：POST /api/rate-cards/backfill-from-postorder { month }
// - site_set_default_broker  ← src/app/(app)/sites/page.tsx `adoptSuggestion()`：PATCH /api/sites/:id { default_settlement_broker_id }
// - roster_reparse           ← src/app/(app)/roster-uploads/page.tsx `doReparse()`：POST /api/roster-uploads/:id/reparse（冇 body）
// - triage_accept_batch      ← src/components/BatchAcceptButton.tsx：POST /api/triage/questions/batch-accept { question_ids }
// - triage_answer            ← src/components/MonthCloseTriageDialog.tsx：POST …/preview { answer } → POST …/answer { answer, preview_hash }
// tests/ai-action-requests.test.ts 逐個斷言 request 相等，並掃上面 call site 原始碼確認形狀仍然一致。
import { apiPatch, apiPost, type ApiResult } from "./api-client";
import type { ActionCard } from "../ai/actions";

export interface ActionRequestSpec {
  method: "POST" | "PATCH";
  url: string;
  /** undefined＝冇 body（同人手 `apiPost(url)` 一致） */
  body?: unknown;
}

type Of<T extends ActionCard["type"]> = Extract<ActionCard, { type: T }>;

/** 非 triage 寫入卡 → 單一 request。open_page／triage_answer 回 null。 */
export function requestForAction(card: ActionCard): ActionRequestSpec | null {
  switch (card.type) {
    case "one_click_run":
      return { method: "POST", url: "/api/month-close/one-click", body: { month: (card as Of<"one_click_run">).params.month } };
    case "backfill_from_postorder":
      return { method: "POST", url: "/api/rate-cards/backfill-from-postorder", body: { month: (card as Of<"backfill_from_postorder">).params.month } };
    case "site_set_default_broker": {
      const p = (card as Of<"site_set_default_broker">).params;
      return { method: "PATCH", url: `/api/sites/${p.site_id}`, body: { default_settlement_broker_id: p.broker_id } };
    }
    case "roster_reparse":
      return { method: "POST", url: `/api/roster-uploads/${(card as Of<"roster_reparse">).params.upload_id}/reparse` };
    case "triage_accept_batch":
      return { method: "POST", url: "/api/triage/questions/batch-accept", body: { question_ids: (card as Of<"triage_accept_batch">).params.question_ids } };
    default:
      return null;
  }
}

/** triage 答案物件（同 MonthCloseTriageDialog 嘅 answer 形狀：`{ option, candidate_id? }`）。 */
export function triageAnswerOf(card: Of<"triage_answer">): { option: string; candidate_id?: string } {
  const p = card.params;
  return { option: p.option, ...(p.candidate_id ? { candidate_id: p.candidate_id } : {}) };
}

export function triagePreviewRequest(card: Of<"triage_answer">): ActionRequestSpec {
  return { method: "POST", url: `/api/triage/questions/${card.params.question_id}/preview`, body: { answer: triageAnswerOf(card) } };
}

export function triageAnswerRequest(card: Of<"triage_answer">, previewHash: string): ActionRequestSpec {
  return { method: "POST", url: `/api/triage/questions/${card.params.question_id}/answer`, body: { answer: triageAnswerOf(card), preview_hash: previewHash } };
}

/** 用現有 client（apiPost／apiPatch）真正發出。 */
export function runSpec<T = unknown>(spec: ActionRequestSpec): Promise<ApiResult<T>> {
  return spec.method === "PATCH" ? apiPatch<T>(spec.url, spec.body) : apiPost<T>(spec.url, spec.body);
}

/** 「會做乜」一句（卡上顯示）。 */
export function describeAction(card: ActionCard): string {
  switch (card.type) {
    case "open_page":
      return "打開相關頁面（唔會改任何資料）";
    case "one_click_run":
      return `為 ${(card as Of<"one_click_run">).params.month} 執行一鍵結算（同喺月結頁撳「一鍵結算」一樣）`;
    case "backfill_from_postorder":
      return `為 ${(card as Of<"backfill_from_postorder">).params.month} 由 Postorder 補齊價目卡建議（只出待答問題，逐題確認先生效）`;
    case "site_set_default_broker":
      return "將呢個盤嘅預設結算雞頭設為建議嘅雞頭（同喺盤管理頁撳「採用」一樣）";
    case "roster_reparse":
      return "重新解析呢份更表上載（同喺更表上載頁撳「重新解析」一樣）";
    case "triage_accept_batch":
      return `批量接受 ${(card as Of<"triage_accept_batch">).params.question_ids.length} 題嘅系統建議答案（逐題預覽後確認寫入，跟單題答一樣；冇建議嘅題會自動跳過）`;
    case "triage_answer":
      return "回答呢條待答問題（先睇影響預覽，確認後先送出）";
  }
}
