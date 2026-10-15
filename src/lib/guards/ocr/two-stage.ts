// WP-OCR-3：瀏覽器端兩段式讀流程（純邏輯；post／crop 由 caller 注入，方便 vitest 測）。
//   stage a：全圖（有欄位級裁圖設計嘅文件〔入職表〕）；其他文件（身份證／住址證明）連 2×2 格一齊傳，
//            伺服器直接 A＋B 讀完回最終 fields（final:true，冇 continuation）→ 唔打 stage b
//   本機按 box 裁欄位級圖（planFieldCrops；冇有效 box → 後備 2×2 格）
//   stage b：只喺入職表：continuation＋放大圖（＋全圖供仲裁）→ 最終逐欄結果
// 失敗處理：429／503（provider 繁忙／用唔到／配額）→ fatal，唔退回舊流程（避免重打 provider、配額計兩次）；
// 其他失敗（網絡、400 continuation 過期、格式怪）→ { ok:false }，caller 退回舊單次流程。
import type { OcrDocType, OcrFieldKey } from "./config";
import { OCR_CROP_FIELDS, hasCropFields, planFieldCrops, sanitizeFieldBoxes, type FieldCropPlan } from "./field-crops";

type PostResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface TwoStageDoc {
  type: OcrDocType;
  full: string;
  /** 2×2 格（已預先裁好）：非入職表必傳（stage a 直接讀完）；入職表作後備 */
  tiles: readonly string[];
  /** 來源圖（≤2,400px）尺寸；只有入職表需要（其他文件來源 canvas 已釋放，可為 0） */
  sourceW: number;
  sourceH: number;
}

export interface TwoStageDeps {
  post<T>(body: unknown): Promise<PostResult<T>>;
  /** 按計劃由來源圖裁出 JPEG data URL（次序同 plan.crops） */
  crop(doc: TwoStageDoc, plan: Extract<FieldCropPlan, { kind: "field_crops" }>): string[];
}

interface StageADoc {
  type: OcrDocType;
  final?: boolean;
  field_boxes?: unknown;
  continuation?: string;
}
interface StageARes {
  documents: StageADoc[];
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
}
interface StageBBase {
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
  documents: { type: OcrDocType }[];
}

interface StageBDoc {
  type: OcrDocType;
  continuation: string;
  full: string;
  images_b: { kind: "field_crops" | "tiles"; images: string[]; field_of: OcrFieldKey[] };
}

export type TwoStageOutcome<B> =
  | { ok: true; data: B; kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> }
  | { ok: false; reason: string; /** 429／503：唔退回舊流程，直接顯示錯誤 */ fatal?: { status: number; message: string } };

const isFatal = (status: number) => status === 429 || status === 503;

export async function readTwoStage<B extends StageBBase>(docs: readonly TwoStageDoc[], deps: TwoStageDeps): Promise<TwoStageOutcome<B>> {
  try {
    const a = await deps.post<StageARes>({ stage: "a", documents: docs.map((d) => ({ type: d.type, full: d.full, ...(hasCropFields(d.type) ? {} : { tiles: [...d.tiles] }) })) });
    if (!a.ok) return { ok: false, reason: `stage_a_${a.status}`, ...(isFatal(a.status) ? { fatal: { status: a.status, message: a.message } } : {}) };
    const byType = new Map(a.data.documents.map((d) => [d.type, d]));
    const kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> = {};
    const finals: StageADoc[] = [];
    const toB = docs.flatMap<StageBDoc>((d) => {
      const ar = byType.get(d.type);
      if (!ar) throw new Error("missing_doc");
      if (!hasCropFields(d.type)) {
        // 伺服器已讀完：必須 final:true 並帶 fields
        if (!ar.final) throw new Error("expected_final");
        finals.push(ar);
        return [];
      }
      if (typeof ar.continuation !== "string") throw new Error("missing_continuation");
      const boxes = sanitizeFieldBoxes(ar.field_boxes, OCR_CROP_FIELDS[d.type] ?? []);
      const plan = planFieldCrops(d.type, boxes, d.sourceW, d.sourceH);
      if (plan.kind === "field_crops") {
        const images = deps.crop(d, plan);
        if (images.length !== plan.crops.length) throw new Error("crop_failed");
        kinds[d.type] = "field_crops";
        return [{ type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "field_crops" as const, images, field_of: plan.crops.map((c): OcrFieldKey => c.field) } }];
      }
      kinds[d.type] = "tiles";
      return [{ type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "tiles" as const, images: [...d.tiles], field_of: [] as OcrFieldKey[] } }];
    });
    let b: PostResult<B> | null = null;
    if (toB.length > 0) {
      b = await deps.post<B>({ stage: "b", documents: toB });
      if (!b.ok) return { ok: false, reason: `stage_b_${b.status}`, ...(isFatal(b.status) ? { fatal: { status: b.status, message: b.message } } : {}) };
    }
    const bData = b && b.ok ? b.data : null;
    // 合併：按上載次序排 documents（final 文件直接用 stage a 回應）
    const bDocs = new Map((bData?.documents ?? []).map((d) => [d.type, d]));
    const documents = docs.map((d) => bDocs.get(d.type) ?? byType.get(d.type)!);
    const data = {
      ...(bData ?? { model: (a.data as unknown as { model: string }).model }),
      documents,
      ms: a.data.ms + (bData?.ms ?? 0),
      usage: {
        prompt_tokens: a.data.usage.prompt_tokens + (bData?.usage.prompt_tokens ?? 0),
        completion_tokens: a.data.usage.completion_tokens + (bData?.usage.completion_tokens ?? 0),
        calls: a.data.usage.calls + (bData?.usage.calls ?? 0),
      },
    } as unknown as B;
    return { ok: true, kinds, data };
  } catch {
    return { ok: false, reason: "exception" };
  }
}
