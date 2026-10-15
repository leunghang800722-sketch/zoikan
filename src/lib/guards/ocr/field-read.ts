// WP-OCR-4：模型單欄讀數結構（additive）。新格式 `{ value, confidence, reason?, alternatives? }`，
// 舊格式（純字串／數字／null）照樣接受＝`{ value }`。純 zod＋型別，零 server 依賴。
import { z } from "zod";

export const READ_CONFIDENCE = ["high", "medium", "low"] as const;
export type ReadConfidence = (typeof READ_CONFIDENCE)[number];
export const READ_REASONS = ["blurry", "crossed_out", "ambiguous_char", "cut_off"] as const;
type ReadReason = (typeof READ_REASONS)[number];
/** alternatives 上限（模型要求最多 2 個；多出嚟嘅丟棄）。 */
const MAX_ALTERNATIVES = 2;

export interface FieldRead {
  value: string | null;
  confidence?: ReadConfidence;
  reason?: ReadReason;
  /** 同一欄嘅其他可能讀法（每個都係完整欄值），≤2 */
  alternatives?: string[];
}

const text = z.union([z.string().max(400), z.number().transform((n) => String(n))]);
const scalar = z.union([text, z.null()]);

// 物件格式：value 必須出現（冇 value 當格式錯）；confidence／reason／alternatives 寬鬆——認唔得就當冇寫，唔令整個解析失敗。
const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
// alternatives 逐項處理：單項超長／型別錯只丟該項，唔令整個陣列消失
const altItem = text.nullable().catch(null);
const objectRead = z.object({
  value: scalar,
  confidence: z.preprocess(lower, z.enum(READ_CONFIDENCE)).optional().catch(undefined),
  reason: z.preprocess(lower, z.enum(READ_REASONS)).nullish().catch(undefined),
  alternatives: z.array(altItem).optional().catch(undefined),
});

export const fieldReadSchema = z.union([
  scalar.transform((v): FieldRead => ({ value: v })),
  objectRead.transform((o): FieldRead => {
    const alts = [...new Set((o.alternatives ?? []).flatMap((a) => (typeof a === "string" && a.trim() ? [a.trim()] : [])))].slice(0, MAX_ALTERNATIVES);
    return { value: o.value, ...(o.confidence ? { confidence: o.confidence } : {}), ...(o.reason ? { reason: o.reason } : {}), ...(alts.length ? { alternatives: alts } : {}) };
  }),
]);
