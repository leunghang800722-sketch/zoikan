// WP-OCR-CLAUDE §36：按 GUARD_OCR_PROVIDER 砌讀 A／讀 B（同 Claude 失敗時嘅 A 後備）用邊個 client。
import { effectiveOcrProvider } from "./config";
import { ClaudeVisionClient } from "./claude-vision-client";
import { DeepSeekVisionClient, OcrUnavailableError, getOcrOverrideClient, type VisionClient } from "./vision-client";

export interface ReadClients {
  a: VisionClient;
  b: VisionClient;
  /** 讀 A 嘅 client 出錯／refusal 時用嚟再讀一次 */
  fallbackA?: VisionClient;
}

export function getReadClients(): ReadClients {
  const override = getOcrOverrideClient();
  if (override) return { a: override, b: override };
  const mode = effectiveOcrProvider();
  if (!mode) throw new OcrUnavailableError(null, "no_api_key");
  if (mode === "deepseek") {
    const d = new DeepSeekVisionClient();
    return { a: d, b: d };
  }
  if (mode === "claude") {
    const c = new ClaudeVisionClient();
    return { a: c, b: c };
  }
  return { a: new ClaudeVisionClient(), b: new DeepSeekVisionClient(), fallbackA: new DeepSeekVisionClient() };
}
