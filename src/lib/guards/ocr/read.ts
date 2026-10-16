// WP-GUARD-OCR §29.2(3)：每份文件兩次獨立讀——A＝全圖；B＝放大分格（唔俾 A 嘅結果）。
// 兩個 read 同時發出（Promise.all），各自只收圖同文件類型；之後正規化比對。
// 模型輸出當資料：zod 嚴格解析（只認白名單 key，其餘丟棄），解析失敗＝該次讀全部 unclear。
import { z } from "zod";
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "./config";
import { buildArbiterSystemPrompt, buildArbiterUserText, buildArbiterUserTextCrops, buildSystemPrompt, buildUserTextFieldCrops, buildUserTextFull, buildUserTextTiles, buildUserTextWithContext } from "./prompts";
import { sanitizeRefs, type Refs } from "./refs";
import { hasCropFields, ocrBoxFields, sanitizeFieldBoxes, type FieldBoxes } from "./field-crops";
import { isUnclear, normalizeField, type FieldResult } from "./normalize";
import { reconcile, type ExtraCandidate } from "./reconcile";
import { lookupAlsCandidate } from "./als-client";
import { fieldReadSchema, type FieldRead } from "./field-read";
import { OcrUnavailableError, type OcrProviderName, type VisionClient, type VisionRequest, type VisionResponse } from "./vision-client";
import type { ReadClients } from "./clients";

function outputSchema(fields: readonly OcrFieldKey[]) {
  return z.object(Object.fromEntries(fields.map((f) => [f, fieldReadSchema.optional()])) as Record<OcrFieldKey, z.ZodOptional<typeof fieldReadSchema>>);
}

export type ModelReads = Partial<Record<OcrFieldKey, FieldRead>>;

/** 抽出第一個 JSON object（容忍 ```json 圍欄），zod 解析。每欄接受舊純字串或新 `{value,confidence,reason,alternatives}`。失敗 → null。 */
export function parseModelJson(text: string, fields: readonly OcrFieldKey[]): ModelReads | null {
  const raw = extractJson(text);
  if (raw === null) return null;
  const r = outputSchema(fields).safeParse(raw);
  if (!r.success) return null;
  return r.data as ModelReads;
}

interface ReadUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** 撞 output token 上限嘅呼叫數 */
  truncated: number;
}

type UsageByProvider = Record<OcrProviderName, { promptTokens: number; completionTokens: number; calls: number }>;

type ImagesBKind = "tiles" | "field_crops";

export interface DocumentReadResult {
  type: OcrDocType;
  fields: Partial<Record<OcrFieldKey, FieldResult>>;
  /** 兩次讀各自嘅 JSON 有冇解析成功（唔含值） */
  parse_ok: { a: boolean; b: boolean };
  usage: ReadUsage;
  /** WP-OCR-CLAUDE §36：兩次讀實際用咗邊個供應商（Claude 失敗退回 DeepSeek 時 a＝deepseek） */
  provider_used: { a: OcrProviderName; b: OcrProviderName };
  model_used: { a: string; b: string };
  /** 讀 A 由 Claude 退回 DeepSeek 嘅原因類別（冇退回＝null；只係固定字串） */
  fallback_reason: string | null;
  usage_by_provider: UsageByProvider;
  /** WP-OCR-4：第三讀仲裁（每份文件最多 1 次）——called＝有冇呼叫；fields＝送去仲裁嘅分歧欄數（淨計數） */
  arbiter: { called: boolean; fields: number };
  /** WP-OCR-3（additive）：讀 B 用咗邊種放大圖（tiles＝2×2 格／後備；field_crops＝欄位級裁圖） */
  images_b_kind: ImagesBKind;
  /** WP-OCR-3（additive）：讀 B 有冇用讀 A 回報嘅 box 裁圖（＝images_b_kind 係 field_crops） */
  field_boxes_used: boolean;
  /** WP-OCR-2（additive，淨計數）：ALS 有冇真係查過／有冇出候選／查失敗 */
  als: { called: boolean; candidate: boolean; failed: boolean };
}

export interface DocumentImages {
  full: string;
  tiles: readonly string[];
}

const providerOf = (c: VisionClient): OcrProviderName => c.provider ?? "deepseek";

/** 抽出第一個 JSON object（容忍 ```json 圍欄）→ 未驗證嘅 unknown；失敗 null。 */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** WP-OCR-3：讀 A 回報嘅 field_boxes（未信任）→ 只保留裁圖欄位、sanity 合格嘅 box。解析唔到＝空。 */
function parseFieldBoxes(text: string, type: OcrDocType): FieldBoxes {
  const fields = ocrBoxFields(type);
  if (fields.length === 0) return {};
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return {};
  return sanitizeFieldBoxes(unflattenFieldBoxes((raw as Record<string, unknown>).field_boxes, fields), fields);
}

/** OCR-5.4：攤平格式 `<欄>_x/_y/_w/_h`（Claude schema）→ 巢狀 `{x,y,w,h}`；四個數全 0（或 w／h 為 0）＝冇法定位→null；巢狀格式原樣保留。 */
export function unflattenFieldBoxes(raw: unknown, fields: readonly OcrFieldKey[]): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const rec = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec };
  for (const f of fields) {
    if (f in rec) continue;
    const nums = ["x", "y", "w", "h"].map((c) => rec[`${f}_${c}`]);
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const [x, y, w, h] = nums as number[];
    out[f] = w! > 0 && h! > 0 ? { x, y, w, h } : null;
  }
  return out;
}

interface UsageEntry {
  provider: OcrProviderName;
  promptTokens: number;
  completionTokens: number;
  truncated: boolean;
}

/** 讀 A 嘅執行（含 Claude 失敗／解析失敗退回 DeepSeek）。 */
async function runReadA(clients: ReadClients, req: VisionRequest, fields: readonly OcrFieldKey[]): Promise<{ resp: VisionResponse; usedA: VisionClient; fallbackReason: string | null }> {
  let usedA = clients.a;
  let fallbackReason: string | null = null;
  const go = async (): Promise<VisionResponse> => {
    let r: VisionResponse;
    try {
      r = await clients.a.complete(req);
    } catch (e) {
      if (!(e instanceof OcrUnavailableError) || !clients.fallbackA) throw e;
      fallbackReason = e.reason ?? (e.status !== null ? `status_${e.status}` : "unavailable");
      usedA = clients.fallbackA;
      return clients.fallbackA.complete(req);
    }
    // Claude 正常完結但 JSON 解析唔到、而有後備 → 交 DeepSeek 重讀一次
    if (clients.fallbackA && parseModelJson(r.text, fields) === null) {
      fallbackReason = "parse";
      usedA = clients.fallbackA;
      return clients.fallbackA.complete(req);
    }
    return r;
  };
  const resp = await go();
  return { resp, usedA, fallbackReason };
}

export interface StageAResult {
  type: OcrDocType;
  /** 讀 A 原始讀數（未 reconcile）；解析失敗＝null */
  a_fields_raw: ModelReads | null;
  /** 已 sanity 檢查嘅欄位 box（讀 A 退回後備／解析失敗／該類型冇裁圖設計＝空） */
  field_boxes: FieldBoxes;
  usage: ReadUsage;
  provider: OcrProviderName;
  model: string;
  fallback_reason: string | null;
  parse_ok: boolean;
  /** WP-OCR-1：有幾多個 refs 欄位注入咗讀 A 嘅 prompt（淨計數；0＝冇注入） */
  refs_injected: number;
}

/**
 * WP-OCR-3 讀 A（兩段式第一段）：全圖 1 張；有裁圖設計嘅文件類型同時要求回報欄位 box。
 * WP-OCR-1：refs（同一申請人印刷證件已核實值）只注入讀 A，而且只對有欄位級裁圖設計嘅文件（入職表）生效。
 */
export async function readStageA(clientOrClients: VisionClient | ReadClients, type: OcrDocType, full: string, refs?: Refs | null): Promise<StageAResult> {
  const clients: ReadClients = "complete" in clientOrClients ? { a: clientOrClients, b: clientOrClients } : clientOrClients;
  const fields = OCR_DOC_FIELDS[type];
  const wantBoxes = hasCropFields(type);
  const useRefs = wantBoxes ? sanitizeRefs(refs) : {};
  const req = stageARequest(type, full, wantBoxes, useRefs);
  const { resp, usedA, fallbackReason } = await runReadA(clients, req, fields);
  const pa = parseModelJson(resp.text, fields);
  // 讀 A 退回 DeepSeek 或者解析失敗 → 冇 box（後備 2×2）
  const boxes = wantBoxes && pa !== null && fallbackReason === null ? parseFieldBoxes(resp.text, type) : {};
  return {
    type,
    a_fields_raw: pa,
    field_boxes: boxes,
    usage: { promptTokens: resp.promptTokens, completionTokens: resp.completionTokens, calls: 1, truncated: resp.truncated ? 1 : 0 },
    provider: providerOf(usedA),
    model: usedA.model,
    fallback_reason: fallbackReason,
    parse_ok: pa !== null,
    refs_injected: Object.keys(useRefs).filter((k) => OCR_DOC_FIELDS[type].includes(k as OcrFieldKey)).length,
  };
}

function stageARequest(type: OcrDocType, full: string, withBoxes: boolean, refs: Refs = {}): VisionRequest {
  const fields = OCR_DOC_FIELDS[type];
  return withBoxes
    ? { system: buildSystemPrompt(type, { boxes: true }), userText: buildUserTextWithContext(type, refs, { boxes: true }), images: [full], fields, boxFields: ocrBoxFields(type) }
    : { system: buildSystemPrompt(type), userText: buildUserTextFull(type), images: [full], fields };
}

export interface ImagesB {
  kind: ImagesBKind;
  images: readonly string[];
  /** field_crops：與 images 一一對應嘅欄位 */
  fieldOf?: readonly (OcrFieldKey | null)[];
  /** 全圖（仲裁用；冇＝唔做仲裁） */
  full?: string;
}

function requestB(type: OcrDocType, b: ImagesB): VisionRequest {
  const fields = OCR_DOC_FIELDS[type];
  const system = buildSystemPrompt(type);
  if (b.kind === "field_crops") {
    const fieldOf = b.fieldOf ?? [];
    if (fieldOf.length !== b.images.length) throw new Error("bad_images_b");
    const covered = [...new Set(fieldOf.filter((f): f is OcrFieldKey => f !== null))].filter((f) => fields.includes(f));
    return { system, userText: buildUserTextFieldCrops(type, fieldOf), images: b.images, fields: covered };
  }
  return { system, userText: buildUserTextTiles(type, b.images.length), images: b.images, fields };
}

interface FinishCtx {
  clients: ReadClients;
  type: OcrDocType;
  now: Date;
  pa: ModelReads | null;
  providerA: OcrProviderName;
  modelA: string;
  fallbackReason: string | null;
  rb: VisionResponse;
  imagesB: ImagesB;
  /** 計入 usage 嘅條目（legacy＝A＋B；stage B＝只有 B） */
  priorUsage: UsageEntry[];
}

/** 共用收尾：讀 B 解析、第三讀仲裁、reconcile、彙整用量。 */
async function finishRead(c: FinishCtx): Promise<DocumentReadResult> {
  const { clients, type, now, pa, rb, imagesB } = c;
  const fields = OCR_DOC_FIELDS[type];
  const pb = parseModelJson(rb.text, fields);
  // WP-OCR-4 第三讀仲裁：某欄兩讀唔同（正規化後）且兩讀 confidence 都唔係 high → 一次過問 Claude（每份文件最多 1 次）。
  // 仲裁出錯（OcrUnavailableError）唔影響主流程：照用兩讀結果。其他錯誤（bug）原樣拋。
  // WP-OCR-3：仲裁用全圖＋（欄位級裁圖：分歧欄對應裁圖／2×2 格）；冇全圖就唔仲裁。
  // WP-OCR-2：ALS（政府地址庫）——reconcile 之後（用預備 reconcile 揀出要查嘅地址）、仲裁之前；每份文件最多 1 次，失敗靜靜略過
  let als: { called: boolean; candidate: boolean; failed: boolean } = { called: false, candidate: false, failed: false };
  let alsExtra: ExtraCandidate | null = null;
  if (clients.als && fields.includes("address")) {
    const pre = reconcile("address", pa?.address ?? null, pb?.address ?? null, now);
    if (pre.status === "review" && pre.value) { // 只喺 review（兩讀未確認）先查；confirmed／missing 唔查
      const r = await lookupAlsCandidate(pre.value, clients.als);
      als = { called: r.called, candidate: r.status === "candidate", failed: r.status === "failed" };
      if (r.status === "candidate") alsExtra = { value: r.value, source: "als", als_score: r.score };
    }
  }
  const disputed = clients.arbiter && c.providerA === "claude" && imagesB.full ? disputedFields(fields, c.pa, pb, now) : [];
  let rArb: VisionResponse | null = null;
  let pArb: ModelReads | null = null;
  if (clients.arbiter && imagesB.full && disputed.length > 0) {
    const cands: Partial<Record<OcrFieldKey, string[]>> = {};
    for (const f of disputed) cands[f] = candidateValues(pa?.[f], pb?.[f]);
    // WP-OCR-2：ALS 建議另列（唔當兩讀候選）
    const alsSug: Partial<Record<OcrFieldKey, string>> = alsExtra && disputed.includes("address") ? { address: alsExtra.value } : {};
    let reqArb: VisionRequest;
    if (imagesB.kind === "field_crops") {
      const fieldOf = imagesB.fieldOf ?? [];
      const idx = fieldOf.flatMap((f, i) => (f && disputed.includes(f) ? [i] : []));
      const cropFields = idx.map((i) => fieldOf[i]!);
      reqArb = { system: buildArbiterSystemPrompt(type, disputed), userText: buildArbiterUserTextCrops(type, cands, cropFields, alsSug), images: [imagesB.full, ...idx.map((i) => imagesB.images[i]!)], fields: disputed };
    } else {
      reqArb = { system: buildArbiterSystemPrompt(type, disputed), userText: buildArbiterUserText(type, cands, imagesB.images.length, alsSug), images: [imagesB.full, ...imagesB.images], fields: disputed };
    }
    try {
      rArb = await clients.arbiter.complete(reqArb);
      pArb = parseModelJson(rArb.text, disputed);
    } catch (e) {
      if (!(e instanceof OcrUnavailableError)) throw e;
    }
  }

  const out: Partial<Record<OcrFieldKey, FieldResult>> = {};
  for (const f of fields) out[f] = reconcile(f, pa?.[f] ?? null, pb?.[f] ?? null, now, pArb && disputed.includes(f) ? (pArb[f] ?? null) : undefined, f === "address" && alsExtra ? [alsExtra] : undefined);
  const byProvider: UsageByProvider = { claude: { promptTokens: 0, completionTokens: 0, calls: 0 }, deepseek: { promptTokens: 0, completionTokens: 0, calls: 0 } };
  const used: UsageEntry[] = [...c.priorUsage, { provider: providerOf(clients.b), promptTokens: rb.promptTokens, completionTokens: rb.completionTokens, truncated: !!rb.truncated }];
  if (rArb && clients.arbiter) used.push({ provider: providerOf(clients.arbiter), promptTokens: rArb.promptTokens, completionTokens: rArb.completionTokens, truncated: !!rArb.truncated });
  for (const u of used) {
    const t = byProvider[u.provider];
    t.promptTokens += u.promptTokens;
    t.completionTokens += u.completionTokens;
    t.calls += 1;
  }
  return {
    type,
    fields: out,
    parse_ok: { a: pa !== null, b: pb !== null },
    usage: {
      promptTokens: used.reduce((n, u) => n + u.promptTokens, 0),
      completionTokens: used.reduce((n, u) => n + u.completionTokens, 0),
      calls: used.length,
      truncated: used.reduce((n, u) => n + (u.truncated ? 1 : 0), 0),
    },
    provider_used: { a: c.providerA, b: providerOf(clients.b) },
    model_used: { a: c.modelA, b: clients.b.model },
    fallback_reason: c.fallbackReason,
    usage_by_provider: byProvider,
    arbiter: { called: rArb !== null, fields: rArb ? disputed.length : 0 },
    images_b_kind: imagesB.kind,
    field_boxes_used: imagesB.kind === "field_crops",
    als,
  };
}

/**
 * WP-OCR-3 讀 B（兩段式第二段）：收讀 A 結果（stage A）＋放大圖（2×2 格或欄位級裁圖）→ 讀 B＋reconcile＋仲裁。
 * 回傳嘅 usage／usage_by_provider 只計讀 B＋仲裁（讀 A 用量喺 stage A 已報）。
 */
export async function readStageB(clientOrClients: VisionClient | ReadClients, type: OcrDocType, stageA: Pick<StageAResult, "a_fields_raw" | "provider" | "model" | "fallback_reason">, imagesB: ImagesB, now: Date = new Date()): Promise<DocumentReadResult> {
  const clients: ReadClients = "complete" in clientOrClients ? { a: clientOrClients, b: clientOrClients } : clientOrClients;
  const rb = await clients.b.complete(requestB(type, imagesB));
  return finishRead({ clients, type, now, pa: stageA.a_fields_raw, providerA: stageA.provider, modelA: stageA.model, fallbackReason: stageA.fallback_reason, rb, imagesB, priorUsage: [] });
}

/** 舊單次流程：讀 A（全圖）同讀 B（2×2 格）同時發出，行為同 OCR-4 一樣。 */
export async function readDocument(clientOrClients: VisionClient | ReadClients, type: OcrDocType, images: DocumentImages, now: Date = new Date()): Promise<DocumentReadResult> {
  const clients: ReadClients = "complete" in clientOrClients ? { a: clientOrClients, b: clientOrClients } : clientOrClients;
  const fields = OCR_DOC_FIELDS[type];
  const imagesB: ImagesB = { kind: "tiles", images: images.tiles, full: images.full };
  const reqA = stageARequest(type, images.full, false);
  // 兩次獨立讀：同時發出；B 嘅 request 只由 (type, tiles) 構成。
  const [ra, rb] = await Promise.all([runReadA(clients, reqA, fields), clients.b.complete(requestB(type, imagesB))]);
  const pa = parseModelJson(ra.resp.text, fields);
  return finishRead({
    clients,
    type,
    now,
    pa,
    providerA: providerOf(ra.usedA),
    modelA: ra.usedA.model,
    fallbackReason: ra.fallbackReason,
    rb,
    imagesB,
    priorUsage: [{ provider: providerOf(ra.usedA), promptTokens: ra.resp.promptTokens, completionTokens: ra.resp.completionTokens, truncated: !!ra.resp.truncated }],
  });
}

/**
 * 兩讀都有值、正規化後唔同，**除非兩讀 confidence 都係 high** 嘅欄位（OCR-4.4：讀 A 多數自報 high，
 * 舊條件「兩讀都唔係 high」令分歧欄留喺 review）。地址欄用 strict 比較：只差形近／簡繁字都當分歧。
 */
function disputedFields(fields: readonly OcrFieldKey[], pa: ModelReads | null, pb: ModelReads | null, now: Date): OcrFieldKey[] {
  return fields.filter((f) => {
    const x = pa?.[f];
    const y = pb?.[f];
    if (!x || !y || isUnclear(x.value) || isUnclear(y.value)) return false;
    if (x.confidence === "high" && y.confidence === "high") return false;
    const nx = normalizeField(f, x.value!, now);
    const ny = normalizeField(f, y.value!, now);
    return f === "address" ? (nx.strict ?? nx.canon) !== (ny.strict ?? ny.canon) : nx.canon !== ny.canon;
  });
}

/** 仲裁 prompt 嘅候選值：讀 A、讀 B 主值＋各自 alternatives（去重，≤4）。 */
function candidateValues(x: FieldRead | undefined, y: FieldRead | undefined): string[] {
  const all = [x?.value, y?.value, ...(x?.alternatives ?? []), ...(y?.alternatives ?? [])].filter((v): v is string => typeof v === "string" && !isUnclear(v));
  return [...new Set(all.map((v) => v.trim()))].slice(0, 4);
}
