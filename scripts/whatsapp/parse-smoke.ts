// W1：WhatsApp 解析真 API smoke（規劃者跑；執行員測試一律用 fake LLM）。
//   npx tsx scripts/whatsapp/parse-smoke.ts [deepseek|claude|both]
// 用合成訊息（測試甲／乙、測試盤、假日期）各打一次真 provider，證明：json_object 輸出能通過 zod 嚴格解析、
// 輸出 token 唔撞 2,000 上限（reasoning_effort low；思考 token 計入上限——OCR-5.6 教訓）。
// key 由 .env 經 dotenv 載入（DOTENV_CONFIG_PATH 可指定其他檔），唔印；console 只印通過／失敗同 token 數。
// 改過 parse.ts 嘅 schema／prompt／上限之後必須跑一次（見 docs/ops.md）。
import "dotenv/config";
import { DeepSeekLlmClient } from "@/lib/ai/providers/deepseek";
import { AnthropicLlmClient, type LlmClient } from "@/lib/ai/llm";
import { parseMessage, WA_LLM_MAX_TOKENS } from "@/lib/whatsapp/parse";

const TS = new Date("2026-10-16T13:30:00Z"); // 香港 2026-10-16 21:30（星期五）
const TABLE = [
  { code: "A", label: "早更", time: "07:00-15:00" },
  { code: "B", label: "中更", time: "15:00-23:00" },
  { code: "N", label: "夜更", time: "19:00-07:00" },
];
const CASES: Array<{ name: string; text: string; expectNoise?: boolean; expectTypes?: string[] }> = [
  { name: "請假（自己）", text: "我聽日18號病假，返唔到，有冇人頂？", expectTypes: ["leave"] },
  { name: "報更（兩人）", text: "聽日測試盤測試甲返早，測試乙返夜", expectTypes: ["shift"] },
  { name: "替更", text: "19號測試丙換測試丁夜更", expectTypes: ["cover"] },
  { name: "純查詢", text: "邊個返聽日？", expectTypes: ["question_only"] },
  { name: "雜訊", text: "收到，多謝各位", expectNoise: true },
];

async function runProvider(name: string, client: LlmClient): Promise<boolean> {
  let allOk = true;
  for (const c of CASES) {
    try {
      const r = await parseMessage({ text: c.text, ts: TS, groupKind: "site", shiftTable: TABLE, wordMap: { 早: "A", 夜: "N" }, quotedText: null }, [client]);
      const out = r.usage.tokensOut;
      const capped = out >= WA_LLM_MAX_TOKENS;
      let ok = r.ok && !capped;
      if (r.ok) {
        if (c.expectNoise) ok = ok && r.output.noise;
        if (c.expectTypes) ok = ok && c.expectTypes.every((t) => r.output.intents.some((i) => i.type === t));
      }
      console.log(`[wa-smoke] ${name} / ${c.name}: ${ok ? "PASS" : "FAIL"} schema=${r.ok ? "ok" : r.error} tokens_in=${r.usage.tokensIn} tokens_out=${out}${capped ? " (撞上限)" : ""}`);
      if (!ok) allOk = false;
    } catch (e) {
      console.log(`[wa-smoke] ${name} / ${c.name}: FAIL error=${e instanceof Error ? e.name : "error"}`);
      allOk = false;
    }
  }
  return allOk;
}

async function main() {
  const which = process.argv[2] ?? "both";
  let ok = true;
  if (which === "deepseek" || which === "both") ok = (await runProvider("deepseek", new DeepSeekLlmClient())) && ok;
  if (which === "claude" || which === "both") ok = (await runProvider("claude", new AnthropicLlmClient({ auth: "api-key" }))) && ok;
  console.log(`[wa-smoke] ${ok ? "ALL PASS" : "有失敗"}`);
  process.exit(ok ? 0 : 1);
}
void main();
