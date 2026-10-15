// WP-OCR-3：瀏覽器端兩段式讀流程（純邏輯；post／crop 由 caller 注入，方便 vitest 測）。
//   stage a：只傳全圖 → 回每份文件嘅 field_boxes＋continuation
//   本機按 box 裁欄位級圖（planFieldCrops；冇有效 box → 後備 2×2 格）
//   stage b：continuation＋放大圖（＋全圖供仲裁）→ 最終逐欄結果（格式同舊單次流程一樣，另加 images_b_kind）
// 任何一步失敗（網絡／4xx／5xx／格式怪）→ { ok:false }，caller 退回舊單次流程。圖片同辨識值只留喺記憶體。
import type { OcrDocType, OcrFieldKey } from "./config";
import { OCR_CROP_FIELDS, planFieldCrops, sanitizeFieldBoxes, type FieldCropPlan } from "./field-crops";

type PostResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface TwoStageDoc {
  type: OcrDocType;
  full: string;
  /** 2×2 後備格（已預先裁好） */
  tiles: readonly string[];
  /** 來源圖（≤2,400px）尺寸 */
  sourceW: number;
  sourceH: number;
}

export interface TwoStageDeps {
  post<T>(body: unknown): Promise<PostResult<T>>;
  /** 按計劃由來源圖裁出 JPEG data URL（次序同 plan.crops） */
  crop(doc: TwoStageDoc, plan: Extract<FieldCropPlan, { kind: "field_crops" }>): string[];
}

interface StageARes {
  documents: { type: OcrDocType; field_boxes?: unknown; continuation: string }[];
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
}
interface StageBBase {
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
}

export type TwoStageOutcome<B> = { ok: true; data: B; kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> } | { ok: false; reason: string };

export async function readTwoStage<B extends StageBBase>(docs: readonly TwoStageDoc[], deps: TwoStageDeps): Promise<TwoStageOutcome<B>> {
  try {
    const a = await deps.post<StageARes>({ stage: "a", documents: docs.map((d) => ({ type: d.type, full: d.full })) });
    if (!a.ok) return { ok: false, reason: `stage_a_${a.status}` };
    const byType = new Map(a.data.documents.map((d) => [d.type, d]));
    const kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> = {};
    const documents = docs.map((d) => {
      const ar = byType.get(d.type);
      if (!ar || typeof ar.continuation !== "string") throw new Error("missing_continuation");
      const cropFields = OCR_CROP_FIELDS[d.type] ?? [];
      const boxes = sanitizeFieldBoxes(ar.field_boxes, cropFields);
      const plan = planFieldCrops(d.type, boxes, d.sourceW, d.sourceH);
      if (plan.kind === "field_crops") {
        const images = deps.crop(d, plan);
        if (images.length !== plan.crops.length) throw new Error("crop_failed");
        kinds[d.type] = "field_crops";
        return { type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "field_crops" as const, images, field_of: plan.crops.map((c): OcrFieldKey => c.field) } };
      }
      kinds[d.type] = "tiles";
      return { type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "tiles" as const, images: [...d.tiles], field_of: [] as OcrFieldKey[] } };
    });
    const b = await deps.post<B>({ stage: "b", documents });
    if (!b.ok) return { ok: false, reason: `stage_b_${b.status}` };
    return {
      ok: true,
      kinds,
      data: { ...b.data, ms: a.data.ms + b.data.ms, usage: { prompt_tokens: a.data.usage.prompt_tokens + b.data.usage.prompt_tokens, completion_tokens: a.data.usage.completion_tokens + b.data.usage.completion_tokens, calls: a.data.usage.calls + b.data.usage.calls } },
    };
  } catch {
    return { ok: false, reason: "exception" };
  }
}
