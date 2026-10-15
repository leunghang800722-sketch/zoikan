// WP-OCR-3：瀏覽器端兩段式讀流程（純邏輯；post／crop 由 caller 注入，方便 vitest 測）。
// WP-OCR-1 次序：① 先 stage a 印刷文件（身份證／住址證明，伺服器 final:true；回應帶 refs_token＝已核實欄位值）
//               ② 再 stage a 入職表（body 帶 refs_token → 伺服器只注入讀 A；讀 B 同仲裁盲讀）→ 裁圖 → stage b（再帶 refs_token → 伺服器計 cross）
//               ③ 合併：documents 按上載次序；stage b 回應嘅 id_cross 併入身份證各欄 cross
//   （以下係 OCR-3 原有說明）
//   stage a：全圖（有欄位級裁圖設計嘅文件〔入職表〕）；其他文件（身份證／住址證明）連 2×2 格一齊傳，
//            伺服器直接 A＋B 讀完回最終 fields（final:true，冇 continuation）→ 唔打 stage b
//   本機按 box 裁欄位級圖（planFieldCrops；冇有效 box → 後備 2×2 格）
//   stage b：只喺入職表：continuation＋放大圖（＋全圖供仲裁）→ 最終逐欄結果
// 失敗處理：429／503（provider 繁忙／用唔到／配額）→ fatal，唔退回舊流程（避免重打 provider、配額計兩次）；
// 其他失敗（網絡、400 continuation 過期、格式怪）→ { ok:false }，caller 退回舊單次流程。
import type { OcrDocType, OcrFieldKey } from "./config";
import { hasCropFields, ocrBoxFields, planFieldCrops, sanitizeFieldBoxes, type FieldCropPlan } from "./field-crops";

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
  fields?: Record<string, Record<string, unknown>>;
}
interface StageARes {
  documents: StageADoc[];
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
  /** WP-OCR-1（additive）：印刷證件已核實欄位值嘅簽名憑證；舊 server 冇 */
  refs_token?: string;
  model?: string;
}
interface StageBBase {
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
  documents: { type: OcrDocType }[];
  /** WP-OCR-1（additive）：身份證欄對入職表手寫值嘅交叉核對（欄位 → { against, result }） */
  id_cross?: Record<string, { against: string; result: string }>;
}

interface StageBDoc {
  type: OcrDocType;
  continuation: string;
  full: string;
  images_b: { kind: "field_crops" | "tiles"; images: string[]; field_of: (OcrFieldKey | null)[] };
}

export type TwoStageOutcome<B> =
  | { ok: true; data: B; kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> }
  | { ok: false; reason: string; /** 429／503：唔退回舊流程，直接顯示錯誤 */ fatal?: { status: number; message: string } };

const isFatal = (status: number) => status === 429 || status === 503;

export async function readTwoStage<B extends StageBBase>(docs: readonly TwoStageDoc[], deps: TwoStageDeps): Promise<TwoStageOutcome<B>> {
  try {
    const printedDocs = docs.filter((d) => !hasCropFields(d.type));
    const formDocs = docs.filter((d) => hasCropFields(d.type));
    const fail = (stage: "a" | "b", r: { status: number; message: string }): TwoStageOutcome<B> => ({ ok: false, reason: `stage_${stage}_${r.status}`, ...(isFatal(r.status) ? { fatal: { status: r.status, message: r.message } } : {}) });
    // ① 印刷文件先讀（伺服器讀完，final:true）；有 refs_token 就帶去 ②③
    let aPrinted: StageARes | null = null;
    if (printedDocs.length > 0) {
      const r = await deps.post<StageARes>({ stage: "a", documents: printedDocs.map((d) => ({ type: d.type, full: d.full, tiles: [...d.tiles] })) });
      if (!r.ok) return fail("a", r);
      aPrinted = r.data;
    }
    const refsToken = typeof aPrinted?.refs_token === "string" && aPrinted.refs_token ? aPrinted.refs_token : undefined;
    // ② 入職表 stage a（帶 refs_token）
    let aForm: StageARes | null = null;
    if (formDocs.length > 0) {
      const r = await deps.post<StageARes>({ stage: "a", ...(refsToken ? { refs_token: refsToken } : {}), documents: formDocs.map((d) => ({ type: d.type, full: d.full })) });
      if (!r.ok) return fail("a", r);
      aForm = r.data;
    }
    const aDocs = [...(aPrinted?.documents ?? []), ...(aForm?.documents ?? [])];
    const byType = new Map(aDocs.map((d) => [d.type, d]));
    const kinds: Partial<Record<OcrDocType, "field_crops" | "tiles">> = {};
    for (const d of printedDocs) {
      // 伺服器已讀完：必須 final:true 並帶 fields
      const ar = byType.get(d.type);
      if (!ar) throw new Error("missing_doc");
      if (!ar.final) throw new Error("expected_final");
    }
    const toB = formDocs.map<StageBDoc>((d) => {
      const ar = byType.get(d.type);
      if (!ar) throw new Error("missing_doc");
      if (typeof ar.continuation !== "string") throw new Error("missing_continuation");
      const boxes = sanitizeFieldBoxes(ar.field_boxes, ocrBoxFields(d.type));
      const plan = planFieldCrops(d.type, boxes, d.sourceW, d.sourceH);
      if (plan.kind === "field_crops") {
        const images = deps.crop(d, plan);
        if (images.length !== plan.crops.length) throw new Error("crop_failed");
        kinds[d.type] = "field_crops";
        return { type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "field_crops", images, field_of: plan.crops.map((c): OcrFieldKey => c.field) } };
      }
      kinds[d.type] = "tiles";
      return { type: d.type, continuation: ar.continuation, full: d.full, images_b: { kind: "tiles", images: [...d.tiles], field_of: [] } };
    });
    // ③ stage b（再帶 refs_token → 伺服器計 cross）
    let b: PostResult<B> | null = null;
    if (toB.length > 0) {
      b = await deps.post<B>({ stage: "b", ...(refsToken ? { refs_token: refsToken } : {}), documents: toB });
      if (!b.ok) return fail("b", b);
    }
    const bData = b && b.ok ? b.data : null;
    // 合併：按上載次序排 documents（final 文件直接用 stage a 回應；身份證各欄併入 id_cross）
    const bDocs = new Map((bData?.documents ?? []).map((d) => [d.type, d]));
    const idCross = bData?.id_cross;
    const merged = docs.map((d) => {
      const x = bDocs.get(d.type) ?? byType.get(d.type)!;
      if (d.type !== "id_card" || !idCross || !(x as StageADoc).fields) return x;
      const fields = { ...(x as StageADoc).fields! };
      for (const [k, c] of Object.entries(idCross)) if (fields[k]) fields[k] = { ...fields[k], cross: c };
      return { ...x, fields };
    });
    const sumA = (f: (a: StageARes) => number) => (aPrinted ? f(aPrinted) : 0) + (aForm ? f(aForm) : 0);
    const data = {
      ...(bData ?? { model: aPrinted?.model ?? aForm?.model }),
      documents: merged,
      ms: sumA((a) => a.ms) + (bData?.ms ?? 0),
      usage: {
        prompt_tokens: sumA((a) => a.usage.prompt_tokens) + (bData?.usage.prompt_tokens ?? 0),
        completion_tokens: sumA((a) => a.usage.completion_tokens) + (bData?.usage.completion_tokens ?? 0),
        calls: sumA((a) => a.usage.calls) + (bData?.usage.calls ?? 0),
      },
    } as unknown as B;
    return { ok: true, kinds, data };
  } catch {
    return { ok: false, reason: "exception" };
  }
}
