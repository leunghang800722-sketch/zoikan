// WP-GUARD-OCR §29.2(7)／WP-OCR-CLAUDE §36：容器啟動時背景跑一次——用 repo 內**合成**證件圖（內容全部虛構）
// 兩個供應商（Claude、DeepSeek）各打一次，確認正式站 key 同型號行得通。背景、唔阻啟動、≤30 秒、失敗只 warn（永遠 exit 0）。
// log 每個供應商一行：[guard-ocr-selftest] ok|fail provider=claude|deepseek model=… ms=… prompt_tokens=… completion_tokens=… hkid_read_ok=true|false
// 冇 key → `skipped reason=no_api_key provider=…`。唔 log 圖、辨識內容、key。
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeepSeekVisionClient, type VisionClient } from "../../src/lib/guards/ocr/vision-client";
import { ClaudeVisionClient } from "../../src/lib/guards/ocr/claude-vision-client";
import { ocrClaudeModel, ocrModel } from "../../src/lib/guards/ocr/config";
import { buildSystemPrompt, buildUserTextFull } from "../../src/lib/guards/ocr/prompts";
import { parseModelJson } from "../../src/lib/guards/ocr/read";
import { normalizeField } from "../../src/lib/guards/ocr/normalize";

const TIMEOUT_MS = 25_000;
const HARD_LIMIT_MS = 30_000;
// 合成證件上嘅虛構身份證號（check digit 合法）；淨係用嚟判斷「讀啱」，唔 log
const EXPECTED_HKID = "A1234563";
const FIELDS = ["name_zh", "name_en", "hkid", "dob", "sex"] as const;

async function runOne(provider: "claude" | "deepseek", img: Buffer): Promise<void> {
  const model = provider === "claude" ? ocrClaudeModel() : ocrModel();
  const key = provider === "claude" ? process.env.CLAUDE_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (!key) {
    console.log(`[guard-ocr-selftest] skipped reason=no_api_key provider=${provider} model=${model}`);
    return;
  }
  const t0 = Date.now();
  try {
    const client: VisionClient = provider === "claude" ? new ClaudeVisionClient({ timeoutMs: TIMEOUT_MS }) : new DeepSeekVisionClient({ timeoutMs: TIMEOUT_MS });
    const r = await client.complete({ system: buildSystemPrompt("id_card"), userText: buildUserTextFull("id_card"), images: [`data:image/jpeg;base64,${img.toString("base64")}`], fields: FIELDS });
    const parsed = parseModelJson(r.text, FIELDS);
    const hk = parsed?.hkid ? normalizeField("hkid", parsed.hkid) : null;
    const hkidOk = !!hk && hk.valid && hk.canon === EXPECTED_HKID;
    console.log(`[guard-ocr-selftest] ${parsed ? "ok" : "fail"} provider=${provider} model=${model} ms=${Date.now() - t0} prompt_tokens=${r.promptTokens} completion_tokens=${r.completionTokens} hkid_read_ok=${hkidOk}`);
  } catch (e) {
    // 唔 log 錯誤訊息內容：淨係類別／HTTP status／固定 reason
    const x = e as { status?: number | null; reason?: string | null; errorType?: string | null };
    console.warn(`[guard-ocr-selftest] fail provider=${provider} model=${model} ms=${Date.now() - t0} prompt_tokens=0 completion_tokens=0 hkid_read_ok=false reason=${x.reason ?? (e instanceof Error ? e.name : "error")}${x.status ? ` status=${x.status}` : ""}${x.errorType ? ` error_type=${x.errorType}` : ""}`);
  }
}

async function main(): Promise<void> {
  const timer = setTimeout(() => {
    console.warn(`[guard-ocr-selftest] fail reason=timeout ms=${HARD_LIMIT_MS}`);
    process.exit(0);
  }, HARD_LIMIT_MS);
  timer.unref();
  const img = readFileSync(join(__dirname, "fixtures", "synthetic-id-card.jpg"));
  // 兩個供應商並行（各自 ≤25 秒），任何一個 fail 都唔影響另一個、唔擋啟動
  await Promise.all([runOne("claude", img), runOne("deepseek", img)]);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
