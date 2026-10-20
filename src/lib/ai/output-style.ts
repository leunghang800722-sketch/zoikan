// WP-AI3 老闆 feedback（正式站助手）：答法要用業務用語，唔准喺最終
// 回覆出現內部識別符——snake_case 欄位名（`broker_fee`／`guard_wage`／
// `estimated_payout`）、工具名（`gross_margin`／`broker_stats`／…）、
// 內部雞頭代號（`B07`／`B10`）。呢個係*表達方式*嘅guard（唔係
// `output-guard.ts` 嗰種安全防線——嗰個管 DML/DDL/指示性文字，兩個
// guard 獨立、順序係先行安全嗰個先行呢個，兩個都唔會削弱對方）：
//
// 1. 偵測（`detectStyleIssue()`）：snake_case token／已知 14 個工具
//    名／`B\d{2}` 代號，命中一種就當觸發。
// 2. 觸發就用**同一個** provider 行多一次 request，冇帶任何工具，叫
//    模型將段文字改寫做純業務用語（`requestStyleRewrite()`）。
// 3. 改寫完再檢查一次，仲有就直接 `stripIdentifiers()`剝走識別符
//    （保底，唔會畀任何識別符漏出去，即使 provider 嗰次改寫都改壞）。
// 4. 觸發就寫一條 `audit_log(action="ai_style_rewrite")`。
//
// 例外：如果成段文字本身已經係一個可以 `JSON.parse()` 嘅 JSON（唔係
// 自然語言句子）——呢個淨係會喺測試/debug 情景出現（真 LLM 一定係答
// 自然語言，唔會齋回一嚿 JSON），唔屬於呢個 guard 想改嘅嘢，跳過。
import { writeAudit } from "../audit";
import type { LlmClient } from "./llm";

// 同 `src/lib/ai/tools/index.ts` `buildAiTools()` 逐個工具名一致——
// 呢個清單淨係俾呢個 guard 掃「回覆有冇提到工具名」用，唔係工具本身
// 嘅 registry。
const TOOL_NAMES = [
  "describe_system",
  "list_sites",
  "site_overview",
  "roster",
  "broker_stats",
  "rate_cards",
  "explain_rate_card",
  "guard_lookup",
  "longterm_leavers",
  "shift_history",
  "gross_margin",
  "monthly_close",
  "shortfall",
  "recent_audit",
  "sql_select",
] as const;

const SNAKE_CASE_PATTERN = /\b[a-z]+_[a-z_]+\b/;
// 老闆原文 `B0\d`（B07/B09 呢類單位數）——呢度放寬做兩位數字
// （`B\d{2}`），連 B10/B11 呢類代號都一齊擋（superset，唔會漏擋
// 老闆原本要求嗰批）。
const BROKER_CODE_PATTERN = /\bB\d{2}\b/i;
const TOOL_NAME_PATTERN = new RegExp(`\\b(${TOOL_NAMES.join("|")})\\b`, "i");

export type StyleIssue = "snake_case_identifier" | "internal_broker_code" | "tool_name_leak";

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** 淨係偵測，唔改文字——export 俾單元測試直接斷言邊種輸入會唔會觸發。 */
export function detectStyleIssue(text: string): StyleIssue | null {
  if (looksLikeJson(text)) return null; // 見檔案頂註解「例外」
  if (SNAKE_CASE_PATTERN.test(text)) return "snake_case_identifier";
  if (BROKER_CODE_PATTERN.test(text)) return "internal_broker_code";
  if (TOOL_NAME_PATTERN.test(text)) return "tool_name_leak";
  return null;
}

/** 保底：直接剪走識別符（換做空白），執手尾清多餘空格/標點——寧願個
 * 句子讀落去唔係咁順，都好過漏一個內部識別符出去。 */
export function stripIdentifiers(text: string): string {
  let out = text;
  out = out.replace(new RegExp(SNAKE_CASE_PATTERN, "g"), "");
  out = out.replace(new RegExp(BROKER_CODE_PATTERN, "g"), "");
  out = out.replace(new RegExp(TOOL_NAME_PATTERN, "g"), "");
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\s+([。！？，、；：])/g, "$1");
  out = out.replace(/（\s*）/g, "");
  return out.trim();
}

const REWRITE_SYSTEM_PROMPT =
  "你係文字編輯，唔係在勤系統嘅助手。用戶會俾你一段廣東話文字，入面可能混咗程式員先睇得明嘅英文欄位名／snake_case 識別符／工具名／內部代號（例如 B07）。將呢段文字改寫做普通人睇得明嘅純業務用語（例如「雞頭費」「保安員工資」「出街價」），保留原本嘅意思同全部數字，唔准加/減任何資訊，唔准加解釋，直接畀改寫後嘅版本，唔好加任何前言。";

/** 用同一個 provider（冇帶工具）叫佢重寫——`maxToolRounds:1` 保證淨係
 * 一輪、唔會撞返個 tool loop。 */
async function requestStyleRewrite(llmClient: LlmClient, text: string): Promise<string | null> {
  try {
    const result = await llmClient.chat({
      systemPrompt: REWRITE_SYSTEM_PROMPT,
      tools: [],
      history: [],
      userMessage: text,
      maxToolRounds: 1,
    });
    return result.text || null;
  } catch {
    // 改寫呢個 provider call 本身失敗（例如網絡）——唔拋錯累到成個
    // response，跌落去俾呼叫方用 `stripIdentifiers()` 做保底。
    return null;
  }
}

export interface StyleGuardResult {
  triggered: boolean;
  reason?: StyleIssue;
  rewritten: boolean; // true=改寫成功清乾淨；false=跌落用咗 stripIdentifiers() 保底
  text: string;
}

export async function applyOutputStyleGuard(params: {
  text: string;
  llmClient: LlmClient;
  actorUserId: string;
  ip: string | null;
}): Promise<StyleGuardResult> {
  const issue = detectStyleIssue(params.text);
  if (!issue) return { triggered: false, rewritten: false, text: params.text };

  const rewritten = await requestStyleRewrite(params.llmClient, params.text);
  const candidate = rewritten ?? params.text;
  const stillBad = detectStyleIssue(candidate) !== null;
  const finalText = stillBad ? stripIdentifiers(candidate) : candidate;

  await writeAudit({
    actorUserId: params.actorUserId,
    tableName: "ai_chat",
    rowId: params.actorUserId,
    action: "ai_style_rewrite",
    after: { reason: issue, rewrite_attempted: rewritten !== null, fell_back_to_strip: stillBad },
    ip: params.ip,
  });

  return { triggered: true, reason: issue, rewritten: !stillBad, text: finalText };
}
