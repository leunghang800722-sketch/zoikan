// WP-GUARD-OCR §29.2(3)：每份文件兩次獨立讀——A＝全圖；B＝放大分格（唔俾 A 嘅結果）。
// 兩個 read 同時發出（Promise.all），各自只收圖同文件類型；之後正規化比對。
// 模型輸出當資料：zod 嚴格解析（只認白名單 key，其餘丟棄），解析失敗＝該次讀全部 unclear。
import { z } from "zod";
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "./config";
import { buildSystemPrompt, buildUserTextFull, buildUserTextTiles } from "./prompts";
import { reconcile, type FieldResult } from "./normalize";
import { OcrUnavailableError, type OcrProviderName, type VisionClient, type VisionRequest, type VisionResponse } from "./vision-client";
import type { ReadClients } from "./clients";

const fieldValue = z.union([z.string().max(400), z.number().transform((n) => String(n)), z.null()]);

function outputSchema(fields: readonly OcrFieldKey[]) {
  return z.object(Object.fromEntries(fields.map((f) => [f, fieldValue.optional()])) as Record<OcrFieldKey, z.ZodOptional<typeof fieldValue>>);
}

/** 抽出第一個 JSON object（容忍 ```json 圍欄），zod 解析。失敗 → null。 */
export function parseModelJson(text: string, fields: readonly OcrFieldKey[]): Partial<Record<OcrFieldKey, string | null>> | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
  const r = outputSchema(fields).safeParse(raw);
  if (!r.success) return null;
  return r.data as Partial<Record<OcrFieldKey, string | null>>;
}

interface ReadUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** 撞 output token 上限嘅呼叫數 */
  truncated: number;
}

type UsageByProvider = Record<OcrProviderName, { promptTokens: number; completionTokens: number; calls: number }>;

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
}

export interface DocumentImages {
  full: string;
  tiles: readonly string[];
}

const providerOf = (c: VisionClient): OcrProviderName => c.provider ?? "deepseek";

export async function readDocument(clientOrClients: VisionClient | ReadClients, type: OcrDocType, images: DocumentImages, now: Date = new Date()): Promise<DocumentReadResult> {
  const clients: ReadClients = "complete" in clientOrClients ? { a: clientOrClients, b: clientOrClients } : clientOrClients;
  const fields = OCR_DOC_FIELDS[type];
  const system = buildSystemPrompt(type);
  const reqA: VisionRequest = { system, userText: buildUserTextFull(type), images: [images.full], fields };
  const reqB: VisionRequest = { system, userText: buildUserTextTiles(type, images.tiles.length), images: images.tiles, fields };
  // 讀 A：主 client 出錯／refusal（OcrUnavailableError）且有後備 → 同一個請求交後備再讀一次；冇後備或後備都失敗就拋。
  let usedA = clients.a;
  let fallbackReason: string | null = null;
  const readA = async (): Promise<VisionResponse> => {
    let r: VisionResponse;
    try {
      r = await clients.a.complete(reqA);
    } catch (e) {
      if (!(e instanceof OcrUnavailableError) || !clients.fallbackA) throw e;
      fallbackReason = e.reason ?? (e.status !== null ? `status_${e.status}` : "unavailable");
      usedA = clients.fallbackA;
      return clients.fallbackA.complete(reqA);
    }
    // Claude 正常完結但 JSON 解析唔到、而有後備 → 交 DeepSeek 重讀一次
    if (clients.fallbackA && parseModelJson(r.text, fields) === null) {
      fallbackReason = "parse";
      usedA = clients.fallbackA;
      return clients.fallbackA.complete(reqA);
    }
    return r;
  };
  // 兩次獨立讀：同時發出；B 嘅 request 只由 (type, tiles) 構成。
  const [ra, rb] = await Promise.all([readA(), clients.b.complete(reqB)]);
  const pa = parseModelJson(ra.text, fields);
  const pb = parseModelJson(rb.text, fields);
  const out: Partial<Record<OcrFieldKey, FieldResult>> = {};
  for (const f of fields) out[f] = reconcile(f, pa?.[f] ?? null, pb?.[f] ?? null, now);
  const byProvider: UsageByProvider = { claude: { promptTokens: 0, completionTokens: 0, calls: 0 }, deepseek: { promptTokens: 0, completionTokens: 0, calls: 0 } };
  for (const [c, r] of [[usedA, ra], [clients.b, rb]] as const) {
    const u = byProvider[providerOf(c)];
    u.promptTokens += r.promptTokens;
    u.completionTokens += r.completionTokens;
    u.calls += 1;
  }
  return {
    type,
    fields: out,
    parse_ok: { a: pa !== null, b: pb !== null },
    usage: { promptTokens: ra.promptTokens + rb.promptTokens, completionTokens: ra.completionTokens + rb.completionTokens, calls: 2, truncated: (ra.truncated ? 1 : 0) + (rb.truncated ? 1 : 0) },
    provider_used: { a: providerOf(usedA), b: providerOf(clients.b) },
    model_used: { a: usedA.model, b: clients.b.model },
    fallback_reason: fallbackReason,
    usage_by_provider: byProvider,
  };
}
