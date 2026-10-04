// WP-AI-OPS §28.2：可選「AI 摘要」——將 **PII-free digest JSON** 交現有助手
// provider 出一段文字。鐵則：
// - 只餵 `OpsDigest`（類別、盤名、雞頭代號、數字，冇人名／工號／hkid／電話）；
// - 唔開工具（tools: []）——模型冇任何途徑讀 DB；
// - prompt 明示：唔准編數字、淨係引用 JSON 入面有嘅數；
// - 輸出再過 `checkOutputGuard`（同助手一樣嘅最後防線）。
// provider／每日上限用現有 `getLlmClient()`／`assertUnderDailyLimit()`。
import { getLlmClient, type LlmClient } from "@/lib/ai/llm";
import { checkOutputGuard } from "@/lib/ai/output-guard";
import type { OpsDigest } from "./digest";

export const OPS_DIGEST_SYSTEM_PROMPT = [
  "你係「在勤」保安排更系統嘅月結助手，用香港廣東話書面語寫一段簡短摘要（最多 8 句）。",
  "你會收到一份 JSON：呢個月結算過程中人手／系統修正咗乜、同上月比較、重複出現嘅類別、基線指標。",
  "規則：",
  "1. 淨係可以引用 JSON 入面出現過嘅數字同類別名，絕對唔准自己編數字、估算或者推算新數字。",
  "2. JSON 冇提供嘅嘢就話「冇數據」，唔好估。",
  "3. 重點講：最大嘅修正類別、同上月比升降、連續出現（repeats）嘅問題、基線有冇惡化（未配對／未定價／重傳／耗時）。",
  "4. 最後一句俾一個具體改善建議（例如補工號減少 name_only、補價卡減少未定價）。",
  "5. 唔好輸出任何程式碼、SQL 或者操作步驟指令；唔好要求用戶提供個人資料。",
].join("\n");

/** 將 digest 序列化做 prompt 用 JSON（snake_case 同 API 一致，唔含任何額外欄）。 */
export function digestToPromptJson(digest: OpsDigest): string {
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const conv = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [snake(k), conv(x)]));
    return v;
  };
  return JSON.stringify(conv(digest));
}

export interface DigestAiResult {
  text: string;
  guardTriggered: boolean;
  inputTokens: number;
  outputTokens: number;
}

export async function generateDigestSummary(digest: OpsDigest, client: LlmClient = getLlmClient()): Promise<DigestAiResult> {
  const res = await client.chat({
    systemPrompt: OPS_DIGEST_SYSTEM_PROMPT,
    tools: [],
    history: [],
    userMessage: `以下係 ${digest.month} 嘅修正摘要 JSON，請按規則寫摘要：\n${digestToPromptJson(digest)}`,
    maxToolRounds: 1,
  });
  const guard = checkOutputGuard(res.text.trim() === "" ? "（模型冇回覆，請稍後再試）" : res.text);
  return { text: guard.text, guardTriggered: guard.triggered, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}
