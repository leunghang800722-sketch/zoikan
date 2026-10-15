// WP-OCR-3：欄位級裁圖幾何（純函數，browser 同 Node 評估腳本共用——零 DOM／canvas／server 依賴）。
// 讀 A（全圖）回報每個欄位格（連印刷 label 同手寫內容）嘅 bounding box（0–1 正規化）；
// 呢度負責 sanity 檢查、外擴（按 box 高度比例）、避開鄰欄、算輸出尺寸。真正裁圖由 caller 做（browser canvas／Node ImageMagick），
// 幾何一律由本檔算，所以兩邊完全一致。冇有效 box → 後備 2×2 重疊格（image-plan.ts）。
import { OCR_MAX_FIELD_CROPS, OCR_FIELDS, type OcrDocType, type OcrFieldKey } from "./config";
import { TILE_MAX_EDGE } from "./image-plan";

/** 正規化 box：x,y＝左上角，w,h＝闊高，全部 0–1（相對全圖）。 */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type FieldBoxes = Partial<Record<OcrFieldKey, NormBox>>;
/** 像素矩形（整數）。 */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 做欄位級裁圖嘅文件類型同欄位（日後加姓名／HKID／出生日期喺度加）。其他文件類型一律用 2×2 格（設計如此，唔係後備）。 */
export const OCR_CROP_FIELDS: Partial<Record<OcrDocType, readonly OcrFieldKey[]>> = {
  onboarding_form: ["phone", "address"],
};

/**
 * WP-OCR-1：額外（optional）裁圖欄位——有有效 box 就加裁圖，冇就唔加（唔影響 all-or-nothing 後備判定）。
 * 入職表：姓名／HKID／出生日期（交叉核對用）。
 */
export const OCR_EXTRA_CROP_FIELDS: Partial<Record<OcrDocType, readonly OcrFieldKey[]>> = {
  onboarding_form: ["name_zh", "hkid", "dob"],
};

/** 讀 A 要求回報 box 嘅欄位（必須＋額外）。 */
export const ocrBoxFields = (type: OcrDocType): readonly OcrFieldKey[] => (hasCropFields(type) ? [...(OCR_CROP_FIELDS[type] ?? []), ...(OCR_EXTRA_CROP_FIELDS[type] ?? [])] : []);

/** 文件類型有冇欄位級裁圖設計（有＝讀 A 要求回報 box）。 */
export const hasCropFields = (type: OcrDocType): boolean => (OCR_CROP_FIELDS[type]?.length ?? 0) > 0;

// ---- sanity ----
const MIN_AREA = 0.003; // 0.3%
const MAX_AREA = 0.6; // 60%
const MIN_W = 0.03;
const MIN_H = 0.015;
const EPS = 1e-9;

/** 單個 box sanity：數字有限、0≤x,y、x+w≤1、y+h≤1、面積 0.3%–60%、w≥3%、h≥1.5%。唔合格→null。 */
export function sanitizeBox(raw: unknown): NormBox | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const { x, y, w, h } = r;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const b = { x: x as number, y: y as number, w: w as number, h: h as number };
  if (b.x < 0 || b.y < 0 || b.w <= 0 || b.h <= 0) return null;
  if (b.x + b.w > 1 + EPS || b.y + b.h > 1 + EPS) return null;
  const area = b.w * b.h;
  if (area < MIN_AREA - EPS || area > MAX_AREA + EPS) return null;
  if (b.w < MIN_W - EPS || b.h < MIN_H - EPS) return null;
  return b;
}

/** 讀 A 回傳嘅 field_boxes（未信任）→ 只保留指定欄位、sanity 合格嘅 box。 */
export function sanitizeFieldBoxes(raw: unknown, fields: readonly OcrFieldKey[]): FieldBoxes {
  const out: FieldBoxes = {};
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const f of fields) {
    if (!(OCR_FIELDS as readonly string[]).includes(f)) continue;
    const b = sanitizeBox(rec[f]);
    if (b) out[f] = b;
  }
  return out;
}

// ---- 外擴 ----
/** 上下外擴＝1.2×box 高度；左右外擴＝0.6×box 高度；最少各 3% 圖邊。 */
const PAD_VERTICAL_RATIO = 1.2;
const PAD_HORIZONTAL_RATIO = 0.6;
export const PAD_MIN_FRACTION = 0.03;
/** 外擴後最多可以越入鄰欄 box 嘅比例（以該鄰欄 box 高度計）。 */
const NEIGHBOUR_INTRUSION = 0.2;

export interface PadOptions {
  vertical?: number;
  horizontal?: number;
  minFraction?: number;
  intrusion?: number;
}

const toPx = (b: NormBox, W: number, H: number): PixelRect => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H });

/**
 * 外擴一個 box（像素座標，未取整前用浮點計），回傳整數像素矩形。
 * 1. 上下各 max(1.2×h, 3%×圖高)，左右各 max(0.6×h, 3%×圖寬)（h＝box 像素高度）；
 * 2. 鄰欄限制：其他欄 box 若喺上方（中心較高）且水平有重疊，上緣唔准高過「其下緣 − 20%×其高度」；下方、左、右同理
 *    （左右只比對垂直有重疊嘅 box；越入量一律以該鄰欄 box 嘅高度 20% 計）。外擴只會擴、唔會縮入原 box；
 * 3. clamp 到圖內。
 * 水平重疊用「未受限嘅外擴 x 範圍」判斷、垂直重疊用「受限後嘅 y 範圍」判斷（先縱後橫，結果確定）。
 */
export function padBox(box: NormBox, allBoxes: readonly NormBox[], imgW: number, imgH: number, opt: PadOptions = {}): PixelRect {
  const vr = opt.vertical ?? PAD_VERTICAL_RATIO;
  const hr = opt.horizontal ?? PAD_HORIZONTAL_RATIO;
  const minF = opt.minFraction ?? PAD_MIN_FRACTION;
  const intr = opt.intrusion ?? NEIGHBOUR_INTRUSION;
  const o = toPx(box, imgW, imgH);
  const padY = Math.max(vr * o.h, minF * imgH);
  const padX = Math.max(hr * o.h, minF * imgW);
  let top = o.y - padY;
  let bottom = o.y + o.h + padY;
  let left = o.x - padX;
  let right = o.x + o.w + padX;
  // 包括自己都冇所謂：自己嘅中心同自己相同，下面「較高／較低／較左／較右」判斷都唔成立
  const others = allBoxes.map((b) => toPx(b, imgW, imgH));
  const cy = o.y + o.h / 2;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  // 鄰欄分類（驗收 S1）：同自己垂直重疊 <20%（以較矮者高度計）＝上／下鄰欄；否則（幾乎同一行）＝左右鄰欄。
  const isRow = (p: PixelRect) => Math.min(o.y + o.h, p.y + p.h) - Math.max(o.y, p.y) >= 0.2 * Math.min(o.h, p.h);
  // 先縱
  for (const p of others) {
    if (isRow(p) || !overlap(left, right, p.x, p.x + p.w)) continue;
    const pc = p.y + p.h / 2;
    if (pc < cy) top = Math.max(top, p.y + p.h - intr * p.h);
    else if (pc > cy) bottom = Math.min(bottom, p.y + intr * p.h);
  }
  // 唔縮入原 box
  top = Math.min(top, o.y);
  bottom = Math.max(bottom, o.y + o.h);
  // 後橫（只睇同一行嘅鄰欄）
  const cx = o.x + o.w / 2;
  for (const p of others) {
    if (!isRow(p) || !overlap(top, bottom, p.y, p.y + p.h)) continue;
    const pc = p.x + p.w / 2;
    if (pc < cx) left = Math.max(left, p.x + p.w - intr * p.h);
    else if (pc > cx) right = Math.min(right, p.x + intr * p.h);
  }
  left = Math.min(left, o.x);
  right = Math.max(right, o.x + o.w);
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(imgW, Math.ceil(right));
  const y1 = Math.min(imgH, Math.ceil(bottom));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** 裁圖輸出尺寸：長邊縮到 1,000px；細過就放大，但最多 2×。 */
const MAX_UPSCALE = 2;
export function cropOutSize(w: number, h: number, maxEdge: number = TILE_MAX_EDGE): { w: number; h: number } {
  const scale = Math.min(MAX_UPSCALE, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export interface FieldCrop {
  field: OcrFieldKey;
  /** 來源圖（≤2,400px）上嘅像素矩形 */
  rect: PixelRect;
  out: { w: number; h: number };
}
export type FieldCropPlan = { kind: "field_crops"; crops: FieldCrop[] } | { kind: "tiles"; crops: [] };

/**
 * 按該文件類型嘅裁圖欄位同讀 A 回報嘅 boxes 出裁圖計劃。
 * 保守規則：該類型所有「必須」裁圖欄位（電話、地址）都要有有效 box 先用欄位級裁圖；有任何一欄冇 box（或者根本冇裁圖設計）→ tiles（後備 2×2）。
 * WP-OCR-1：額外欄位（姓名／HKID／出生日期）有有效 box 就加裁圖、冇就唔加（唔影響後備判定）。每份文件最多 OCR_MAX_FIELD_CROPS 張。
 */
export function planFieldCrops(type: OcrDocType, boxes: FieldBoxes, sourceW: number, sourceH: number): FieldCropPlan {
  const required = OCR_CROP_FIELDS[type];
  if (!required || required.length === 0) return { kind: "tiles", crops: [] };
  const extra = OCR_EXTRA_CROP_FIELDS[type] ?? [];
  if (required.length > OCR_MAX_FIELD_CROPS) return { kind: "tiles", crops: [] };
  const req = required.map((f) => [f, sanitizeBox(boxes[f])] as const);
  if (req.some(([, b]) => !b)) return { kind: "tiles", crops: [] };
  const opt = extra.flatMap((f) => {
    const b = sanitizeBox(boxes[f]);
    return b ? [[f, b] as const] : [];
  });
  const valid = [...req.map(([f, b]) => [f, b!] as const), ...opt].slice(0, OCR_MAX_FIELD_CROPS);
  const all = valid.map(([, b]) => b);
  const crops: FieldCrop[] = valid.map(([field, b]) => {
    const rect = padBox(b, all, sourceW, sourceH);
    return { field, rect, out: cropOutSize(rect.w, rect.h) };
  });
  return { kind: "field_crops", crops };
}
