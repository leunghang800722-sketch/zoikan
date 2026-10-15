// WP-OCR-CLAUDE §36：按 GUARD_OCR_PROVIDER 砌讀 A／讀 B（同 Claude 失敗時嘅 A 後備）用邊個 client。
import { effectiveOcrProvider, ocrAlsEnabled, ocrArbiterEnabled } from "./config";
import { fetchAls, getAlsOverride, type AlsLookup } from "./als-client";
import { ClaudeVisionClient } from "./claude-vision-client";
import { DeepSeekVisionClient, OcrUnavailableError, getOcrOverrideClient, type VisionClient } from "./vision-client";

export interface ReadClients {
  a: VisionClient;
  b: VisionClient;
  /** 讀 A 嘅 client 出錯／refusal 時用嚟再讀一次 */
  fallbackA?: VisionClient;
  /** WP-OCR-4：第三讀仲裁用嘅 Claude client（GUARD_OCR_ARBITER 關閉或者冇 Claude 就冇） */
  arbiter?: VisionClient;
  /** WP-OCR-2：ALS 查詢（GUARD_OCR_ALS=0 就冇；測試 override 下只有注入咗 fake ALS 先有，唔會打真網絡） */
  als?: AlsLookup;
}

export function getReadClients(): ReadClients {
  const c = getReadClientsBase();
  if (!ocrAlsEnabled()) return c;
  const als = getOcrOverrideClient() ? getAlsOverride() : fetchAls;
  return als ? { ...c, als } : c;
}

function getReadClientsBase(): ReadClients {
  const override = getOcrOverrideClient();
  // 測試 override：只有 fake 自報 provider=claude 先有仲裁（其他 fake 行為同舊版一樣，兩次呼叫）
  if (override) return { a: override, b: override, ...(override.provider === "claude" && ocrArbiterEnabled() ? { arbiter: override } : {}) };
  const mode = effectiveOcrProvider();
  if (!mode) throw new OcrUnavailableError(null, "no_api_key");
  if (mode === "deepseek") {
    const d = new DeepSeekVisionClient();
    return { a: d, b: d };
  }
  if (mode === "claude") {
    const c = new ClaudeVisionClient();
    return { a: c, b: c, ...(ocrArbiterEnabled() ? { arbiter: c } : {}) };
  }
  const c = new ClaudeVisionClient();
  return { a: c, b: new DeepSeekVisionClient(), fallbackA: new DeepSeekVisionClient(), ...(ocrArbiterEnabled() ? { arbiter: c } : {}) };
}
