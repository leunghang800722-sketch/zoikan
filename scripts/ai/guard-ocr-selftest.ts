// WP-GUARD-OCR §29.2(7)：容器啟動時背景跑一次——用 repo 內**合成**證件圖（內容全部虛構）打一次視覺模型，
// 確認正式站 key 同 `GUARD_OCR_MODEL` 行得通。背景、唔阻啟動、≤30 秒、失敗只 warn（永遠 exit 0）。
// log 一行：[guard-ocr-selftest] ok|fail model=… ms=… prompt_tokens=… completion_tokens=… hkid_read_ok=true|false
// 冇 key → skipped。唔 log 圖、辨識內容、key。
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeepSeekVisionClient } from "../../src/lib/guards/ocr/vision-client";
import { ocrModel } from "../../src/lib/guards/ocr/config";
import { buildSystemPrompt, buildUserTextFull } from "../../src/lib/guards/ocr/prompts";
import { parseModelJson } from "../../src/lib/guards/ocr/read";
import { normalizeField } from "../../src/lib/guards/ocr/normalize";

const TIMEOUT_MS = 25_000;
const HARD_LIMIT_MS = 30_000;
// 合成證件上嘅虛構身份證號（check digit 合法）；淨係用嚟判斷「讀啱」，唔 log
const EXPECTED_HKID = "A1234563";

async function main(): Promise<void> {
  const model = ocrModel();
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log(`[guard-ocr-selftest] skipped reason=no_api_key model=${model}`);
    return;
  }
  const timer = setTimeout(() => {
    console.warn(`[guard-ocr-selftest] fail model=${model} ms=${HARD_LIMIT_MS} prompt_tokens=0 completion_tokens=0 hkid_read_ok=false reason=timeout`);
    process.exit(0);
  }, HARD_LIMIT_MS);
  timer.unref();
  const t0 = Date.now();
  try {
    const img = readFileSync(join(__dirname, "fixtures", "synthetic-id-card.jpg"));
    const client = new DeepSeekVisionClient({ timeoutMs: TIMEOUT_MS });
    const r = await client.complete({ system: buildSystemPrompt("id_card"), userText: buildUserTextFull("id_card"), images: [`data:image/jpeg;base64,${img.toString("base64")}`] });
    const parsed = parseModelJson(r.text, ["name_zh", "name_en", "hkid", "dob", "sex"]);
    const hk = parsed?.hkid ? normalizeField("hkid", parsed.hkid) : null;
    const hkidOk = !!hk && hk.valid && hk.canon === EXPECTED_HKID;
    console.log(`[guard-ocr-selftest] ${parsed ? "ok" : "fail"} model=${model} ms=${Date.now() - t0} prompt_tokens=${r.promptTokens} completion_tokens=${r.completionTokens} hkid_read_ok=${hkidOk}`);
  } catch (e) {
    // 唔 log 錯誤訊息內容：淨係類別／HTTP status
    const status = (e as { status?: number | null }).status;
    console.warn(`[guard-ocr-selftest] fail model=${model} ms=${Date.now() - t0} prompt_tokens=0 completion_tokens=0 hkid_read_ok=false reason=${e instanceof Error ? e.name : "error"}${status ? ` status=${status}` : ""}`);
  }
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
