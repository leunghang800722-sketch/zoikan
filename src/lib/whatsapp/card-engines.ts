// WA-8 B：工卡辨識引擎抽象（老闆：Claude 太貴，唔准做主力）。五個實作同一介面，輸出 0..n 張卡（一張相可能有幾張工卡）：
//   tesseract（本機、零成本）｜deepseek（deepseek-flash）｜haiku（Claude Haiku 5.5）｜qwen（阿里 Model Studio，預設 qwen-vl-ocr）｜claude（Opus，只做仲裁）
// 圖統一壓到長邊 ≤1000 再送模型（token 同成本直接相關）。圖片內容唔入 log／audit；key 只由 env 讀，唔寫檔案／log。
// 冇 key／冇 binary → 引擎 unavailable（呼叫方跳過並註明）。
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { ClaudeVisionClient } from "@/lib/guards/ocr/claude-vision-client";
import { DeepSeekVisionClient, OcrUnavailableError, openAiClientOptions, type VisionClient } from "@/lib/guards/ocr/vision-client";
import { modelImageDataUrl, ocrPreprocessed } from "./card-image";
import { extractNameCandidates, extractStaffNos, parseCardText, type CardRead } from "./card-parse";

export const CARD_ENGINE_NAMES = ["tesseract", "deepseek", "haiku", "qwen", "claude"] as const;
export type CardEngineName = (typeof CARD_ENGINE_NAMES)[number];

export interface EngineUsage {
  engine: CardEngineName;
  model: string;
  promptTokens: number;
  completionTokens: number;
}
export type EngineOutcome =
  | { ok: true; is_card: boolean; cards: CardRead[]; usage: EngineUsage | null }
  | { ok: false; error: "unavailable" | "failed"; usage: EngineUsage | null };

export interface CardEngine {
  readonly name: CardEngineName;
  readonly model: string;
  /** 一張相 → 0..n 張卡。永不拋錯（失敗回 ok:false）。 */
  read(bytes: Buffer): Promise<EngineOutcome>;
}

const DEFAULT_QWEN_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_QWEN_MODEL = "qwen-vl-ocr";
const DEFAULT_HAIKU_MODEL = "claude-haiku-5-5";
const CALL_TIMEOUT_MS = 45_000;
export const qwenModel = (): string => process.env.QWEN_VL_MODEL?.trim() || DEFAULT_QWEN_MODEL;
export const haikuModel = (): string => process.env.WA_CARD_HAIKU_MODEL?.trim() || DEFAULT_HAIKU_MODEL;

// ---------------------------------------------------------------------------
// prompt（LLM 引擎共用）——只要求 JSON；工號為主，姓名輔助；唔准估
// ---------------------------------------------------------------------------
const CARD_SYSTEM = `你係保安公司工卡辨識器。輸入係一張 WhatsApp 相片，可能係：保安員工卡（有工號、姓名、相）、打卡機／簽到表螢幕、自拍、其他。
只輸出 JSON：{"is_card": boolean, "cards": [{"staff_no": string|null, "name_zh": string|null, "name_en": string|null, "confidence": "high"|"medium"|"low"}]}。
規則：
- 相入面冇工卡（打卡機螢幕、自拍、風景、文件）→ is_card=false、cards=[]。
- 一張相有幾張工卡 → cards 逐張列出。
- staff_no 係工卡上印嘅工號，格式只有 U+5 位數字、MP+4 位、MG+4 位、MW+4 位（例：U12345、MP1234）。睇唔清就 null，唔好估、唔好用相以外嘅資訊。
- name_zh／name_en 只抄卡上見到嘅字，睇唔清就 null。
- 反光、太暗、太糊、被手指遮住 → confidence 填 low。`;
const CARD_USER = "請讀出相入面所有工卡嘅工號同姓名，只回 JSON。";

/** Claude structured output schema（不支援 minItems／maxItems）。 */
export const CARD_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    is_card: { type: "boolean" },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          staff_no: { anyOf: [{ type: "string" }, { type: "null" }] },
          name_zh: { anyOf: [{ type: "string" }, { type: "null" }] },
          name_en: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["staff_no", "name_zh", "name_en", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_card", "cards"],
  additionalProperties: false,
};

function fromText(text: string, usage: EngineUsage): EngineOutcome {
  const p = parseCardText(text);
  return { ok: true, is_card: p.is_card, cards: p.cards, usage };
}

// ---------------------------------------------------------------------------
// VisionClient 類引擎（deepseek／haiku／claude）
// ---------------------------------------------------------------------------
function visionEngine(name: "deepseek" | "haiku" | "claude", model: string, make: () => VisionClient): CardEngine {
  return {
    name,
    model,
    async read(bytes) {
      let client: VisionClient;
      try {
        client = make();
      } catch (e) {
        if (e instanceof OcrUnavailableError) return { ok: false, error: "unavailable", usage: null };
        return { ok: false, error: "failed", usage: null };
      }
      const img = await modelImageDataUrl(bytes, 1000);
      if (!img) return { ok: false, error: "failed", usage: null };
      try {
        const r = await client.complete({ system: CARD_SYSTEM, userText: CARD_USER, images: [img], jsonSchema: CARD_JSON_SCHEMA });
        return fromText(r.text, { engine: name, model: client.model || model, promptTokens: r.promptTokens, completionTokens: r.completionTokens });
      } catch {
        return { ok: false, error: "failed", usage: null };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// qwen（OpenAI 相容 chat completions；qwen-vl-ocr 可能回純文字 → parseCardText 容錯）
// ---------------------------------------------------------------------------
function qwenEngine(model: string, client?: Pick<OpenAI, "chat">): CardEngine {
  return {
    name: "qwen",
    model,
    async read(bytes) {
      const key = process.env.QWEN_API_KEY;
      if (!client && !key) return { ok: false, error: "unavailable", usage: null };
      const img = await modelImageDataUrl(bytes, 1000);
      if (!img) return { ok: false, error: "failed", usage: null };
      try {
        const api = client ?? new OpenAI(openAiClientOptions(key!, process.env.QWEN_BASE_URL?.trim() || DEFAULT_QWEN_BASE, CALL_TIMEOUT_MS));
        const res = await api.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 800,
          messages: [
            { role: "system", content: CARD_SYSTEM },
            { role: "user", content: [{ type: "text", text: CARD_USER }, { type: "image_url", image_url: { url: img } }] },
          ],
        });
        return fromText(res.choices[0]?.message?.content ?? "", { engine: "qwen", model, promptTokens: res.usage?.prompt_tokens ?? 0, completionTokens: res.usage?.completion_tokens ?? 0 });
      } catch {
        return { ok: false, error: "failed", usage: null };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// tesseract（child_process；唔加 npm 重型依賴）
// ---------------------------------------------------------------------------
const tesseractBin = (): string => process.env.TESSERACT_BIN?.trim() || "tesseract";
const TESS_TIMEOUT_MS = 20_000;

function runTesseract(input: Buffer, args: string[]): Promise<{ ok: true; text: string } | { ok: false; reason: "enoent" | "fail" }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { ok: true; text: string } | { ok: false; reason: "enoent" | "fail" }) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(tesseractBin(), ["stdin", "stdout", ...args], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return finish({ ok: false, reason: "enoent" });
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "fail" });
    }, TESS_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ ok: false, reason: e.code === "ENOENT" ? "enoent" : "fail" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? { ok: true, text: Buffer.concat(chunks).toString("utf8") } : { ok: false, reason: "fail" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function tesseractEngine(): CardEngine {
  return {
    name: "tesseract",
    model: "tesseract",
    async read(bytes) {
      const gray = await ocrPreprocessed(bytes, "gray");
      // 第一次：全圖（中英），搵工號＋姓名候選；chi_tra 語言包唔齊就退回 eng
      let first = await runTesseract(gray, ["-l", process.env.TESSERACT_LANGS?.trim() || "chi_tra+eng", "--psm", "11"]);
      if (!first.ok && first.reason === "fail") first = await runTesseract(gray, ["-l", "eng", "--psm", "11"]);
      if (!first.ok) return { ok: false, error: first.reason === "enoent" ? "unavailable" : "failed", usage: null };
      let nos = extractStaffNos(first.text);
      // 第二次：二值化＋字元白名單（A-Z0-9）專攻工號
      if (nos.length === 0) {
        const bin = await ocrPreprocessed(bytes, "binary");
        const second = await runTesseract(bin, ["-l", "eng", "--psm", "11", "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]);
        if (second.ok) nos = extractStaffNos(second.text);
      }
      const names = extractNameCandidates(first.text);
      if (nos.length === 0 && names.length === 0) return { ok: true, is_card: false, cards: [], usage: null };
      const cards: CardRead[] =
        nos.length === 0
          ? [{ is_card: true, staff_no: null, name_zh: names[0] ?? null, name_en: null, confidence: "low" }]
          : nos.map((no) => ({ is_card: true, staff_no: no, name_zh: nos.length === 1 ? (names[0] ?? null) : null, name_en: null, confidence: "medium" as const }));
      return { ok: true, is_card: true, cards, usage: null };
    },
  };
}

export interface EngineOverrides {
  /** 測試用：直接注入 VisionClient（deepseek／haiku／claude） */
  clients?: Partial<Record<"deepseek" | "haiku" | "claude", VisionClient>>;
  qwenClient?: Pick<OpenAI, "chat">;
  qwenModel?: string;
}

export function createEngine(name: CardEngineName, o: EngineOverrides = {}): CardEngine {
  switch (name) {
    case "tesseract":
      return tesseractEngine();
    case "deepseek":
      return visionEngine("deepseek", "deepseek", () => o.clients?.deepseek ?? new DeepSeekVisionClient());
    case "haiku":
      return visionEngine("haiku", haikuModel(), () => o.clients?.haiku ?? new ClaudeVisionClient({ model: haikuModel() }));
    case "claude":
      return visionEngine("claude", "claude-opus", () => o.clients?.claude ?? new ClaudeVisionClient());
    case "qwen":
      return qwenEngine(o.qwenModel ?? qwenModel(), o.qwenClient);
  }
}
