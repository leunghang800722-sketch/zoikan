// WP-GUARD-OCR §29.2(7)／WP-OCR-CLAUDE §36：容器啟動時背景跑一次——用 repo 內**合成**證件圖（內容全部虛構）
// 兩個供應商（Claude、DeepSeek）各打一次，確認正式站 key 同型號行得通。背景、唔阻啟動、≤30 秒、失敗只 warn（永遠 exit 0）。
// log 每個供應商一行：[guard-ocr-selftest] ok|fail provider=claude|deepseek model=… ms=… prompt_tokens=… completion_tokens=… hkid_read_ok=true|false
// 冇 key → `skipped reason=no_api_key provider=…`。唔 log 圖、辨識內容、key。
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeepSeekVisionClient, type VisionClient } from "../../src/lib/guards/ocr/vision-client";
import { ClaudeVisionClient } from "../../src/lib/guards/ocr/claude-vision-client";
import { ocrClaudeModel, ocrModel } from "../../src/lib/guards/ocr/config";
import { buildSystemPrompt, buildUserTextFull } from "../../src/lib/guards/ocr/prompts";
import { parseModelJson } from "../../src/lib/guards/ocr/read";
import { selftestFailLine } from "../../src/lib/guards/ocr/selftest-log";
import { normalizeField } from "../../src/lib/guards/ocr/normalize";
import { createEngine, type CardEngineName } from "../../src/lib/whatsapp/card-engines";
import { sharpLoaded } from "../../src/lib/whatsapp/card-image";

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
    const hk = parsed?.hkid?.value ? normalizeField("hkid", parsed.hkid.value) : null;
    const hkidOk = !!hk && hk.valid && hk.canon === EXPECTED_HKID;
    console.log(`[guard-ocr-selftest] ${parsed ? "ok" : "fail"} provider=${provider} model=${model} ms=${Date.now() - t0} prompt_tokens=${r.promptTokens} completion_tokens=${r.completionTokens} hkid_read_ok=${hkidOk}`);
  } catch (e) {
    // 唔 log 錯誤訊息內容：淨係類別／HTTP status／固定 reason
    console.warn(selftestFailLine(provider, model, Date.now() - t0, e));
  }
}

/**
 * WA-8：工卡辨識引擎自檢（qwen／deepseek／haiku）。一行：`[card-ocr] <engine> configured=<bool> reachable=<bool> model=<model> ms=<n> status=ok|failed|unavailable`。
 * 只印 bool／model／status／ms——絕對唔印 key 或回應文字；失敗唔阻網站起。
 */
async function cardPing(engine: Extract<CardEngineName, "qwen" | "deepseek" | "haiku">, img: Buffer): Promise<void> {
  const configured = engine === "qwen" ? !!process.env.QWEN_API_KEY : engine === "deepseek" ? !!process.env.DEEPSEEK_API_KEY : !!process.env.CLAUDE_API_KEY;
  const e = createEngine(engine);
  if (!configured) {
    console.log(`[card-ocr] ${engine} configured=false reachable=false model=${e.model} ms=0 status=unavailable`);
    return;
  }
  const t0 = Date.now();
  try {
    const r = await e.read(img);
    console.log(`[card-ocr] ${engine} configured=true reachable=${r.ok} model=${r.ok && r.usage ? r.usage.model : e.model} ms=${Date.now() - t0} status=${r.ok ? "ok" : r.error}`);
  } catch {
    console.log(`[card-ocr] ${engine} configured=true reachable=false model=${e.model} ms=${Date.now() - t0} status=failed`);
  }
}

/**
 * WA-8.2：tesseract 自檢。兩行：
 *   [card-ocr] tesseract available=<bool> version=<--version 第一行> langs=<chi_tra,eng 有冇>
 *   [card-ocr] tesseract read ok=<bool> ms=<n>（用合成卡圖跑一次；唔印讀到嘅文字）
 * spawn 失敗（ENOENT）→ available=false；唔阻網站起。
 */
async function tesseractPing(img: Buffer): Promise<void> {
  const bin = process.env.TESSERACT_BIN?.trim() || "tesseract";
  const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (v.error || v.status !== 0) {
    console.log("[card-ocr] tesseract available=false version=- langs=-");
    return;
  }
  const version = ((v.stdout || v.stderr || "").split("\n")[0] ?? "").trim().slice(0, 60) || "unknown";
  const l = spawnSync(bin, ["--list-langs"], { encoding: "utf8", timeout: 5000 });
  const have = new Set(`${l.stdout ?? ""}\n${l.stderr ?? ""}`.split("\n").map((x) => x.trim()));
  const langs = ["chi_tra", "eng"].filter((x) => have.has(x));
  console.log(`[card-ocr] tesseract available=true version=${version} langs=${langs.join(",") || "none"}`);
  const t0 = Date.now();
  try {
    const r = await createEngine("tesseract").read(img);
    console.log(`[card-ocr] tesseract read ok=${r.ok} ms=${Date.now() - t0}`);
  } catch {
    console.log(`[card-ocr] tesseract read ok=false ms=${Date.now() - t0}`);
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
  console.log(`[card-ocr] sharp loaded=${await sharpLoaded()}`);
  await Promise.all([runOne("claude", img), runOne("deepseek", img), cardPing("qwen", img), cardPing("deepseek", img), cardPing("haiku", img), tesseractPing(img)]);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
