// P2.5「現場反映」開會模式——摘要範本（fields／summary_md）嘅純函數
// helper：組 markdown、校驗長度。刻意擺喺 `src/lib/feedback/`（唔喺
// `src/lib/ai/`）——呢啲函數本身唔掂 DB／LLM，純粹資料形狀轉換，但擺
// 出嚟等 `src/app/api/feedback/**` 同 `src/lib/ai/feedback-summarize-
// prompt.ts` 都可以重用，唔使互相 import 對方個 tree。
//
// 鐵律（三層防可行性入面嘅第三層）：呢個範本**冇可行性欄**——下面
// `FeedbackFields` 個 interface 冇任何「可行性」「技術評估」呢類 key，
// 淨係固定 `footer` 一句話講明「未評估技術可行性」。
export const FEEDBACK_FOOTER = "本摘要只整理訴求，未評估技術可行性，由 Eric 核實後交技術團隊評估。";

export interface FeedbackFields {
  title: string;
  reporter: string; // 名／角色／日期／頁面——伺服器填，唔接受用戶輸入
  current_problem: string;
  desired_change: string;
  reason: string;
  related: string;
  open_questions: string;
  footer: string; // 固定，唔接受用戶輸入
}

/** 用戶（喺預覽面板）可以編輯嘅欄——`reporter`／`footer` 唔喺呢度，
 * server 永遠自己填/覆蓋，防止用戶側竄改。 */
export const EDITABLE_FIELD_KEYS = ["title", "current_problem", "desired_change", "reason", "related", "open_questions"] as const;
export type EditableFieldKey = (typeof EDITABLE_FIELD_KEYS)[number];
export type EditableFields = Record<EditableFieldKey, string>;

export function buildReporterLine(params: { name: string; roleName: string; dateStr: string; path?: string }): string {
  const parts = [params.name, params.roleName, params.dateStr];
  if (params.path) parts.push(params.path);
  return parts.join("／");
}

/** summary_md 由 fields 組成（伺服器組，唔靠模型排版）——summarize
 * 預覽同 submit 寫入都用呢個 helper，保證兩邊格式一致。刻意淨係用
 * `SimpleMarkdown`（`src/lib/ui/simple-markdown.ts`）實際支援嘅語法
 * （段落／**粗體**／列表／表格）——嗰個 parser 唔識 `#`/`##` 標題同
 * `---` 分隔線，寫呢啲落去會連 `#` 符號本身都原字顯示出嚟，唔會變靚
 * 標題。 */
export function buildSummaryMarkdown(fields: FeedbackFields): string {
  const lines: string[] = [
    `**${fields.title}**`,
    "",
    `**提出人**：${fields.reporter}`,
    "",
    "**現況／問題**",
    fields.current_problem,
    "",
    "**想點改**",
    fields.desired_change,
    "",
    "**點解（業務原因／影響）**",
    fields.reason,
    "",
    "**相關盤／雞頭／月份／角色**",
    fields.related || "（冇特別提及）",
  ];
  if (fields.open_questions && fields.open_questions.trim() !== "") {
    lines.push("", "**未確定嘅地方**", fields.open_questions);
  }
  lines.push("", fields.footer);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// submit 驗證——每欄 ≤ 2000 字、總 ≤ 12000 字、每人每日 ≤ 3 份（後者喺
// `session.ts` 嘅 `countSubmittedReportsToday()` 計，呢度淨係放常數）。
// ---------------------------------------------------------------------------
export const MAX_FIELD_LEN = 2000;
export const MAX_TOTAL_LEN = 12000;
export const MAX_REPORTS_PER_DAY = 3;

/** 得返 null＝驗證過；唔係就係俾用戶睇嘅錯誤訊息。 */
export function validateFieldLengths(fields: EditableFields): string | null {
  let total = 0;
  for (const key of EDITABLE_FIELD_KEYS) {
    const v = fields[key] ?? "";
    if (v.length > MAX_FIELD_LEN) return `「${key}」超過每欄上限 ${MAX_FIELD_LEN} 字`;
    total += v.length;
  }
  if (total > MAX_TOTAL_LEN) return `全部欄位合共超過上限 ${MAX_TOTAL_LEN} 字`;
  return null;
}

// ---------------------------------------------------------------------------
// transcript_excerpt——最後 20 輪（40 條 message）。
// ---------------------------------------------------------------------------
export function lastNTurns<T>(messages: T[], turns = 20): T[] {
  return messages.slice(-turns * 2);
}
