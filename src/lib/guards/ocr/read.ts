// WP-GUARD-OCR §29.2(3)：每份文件兩次獨立讀——A＝全圖；B＝放大分格（唔俾 A 嘅結果）。
// 兩個 read 同時發出（Promise.all），各自只收圖同文件類型；之後正規化比對。
// 模型輸出當資料：zod 嚴格解析（只認白名單 key，其餘丟棄），解析失敗＝該次讀全部 unclear。
import { z } from "zod";
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "./config";
import { buildSystemPrompt, buildUserTextFull, buildUserTextTiles } from "./prompts";
import { reconcile, type FieldResult } from "./normalize";
import type { VisionClient } from "./vision-client";

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

export interface ReadUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface DocumentReadResult {
  type: OcrDocType;
  fields: Partial<Record<OcrFieldKey, FieldResult>>;
  /** 兩次讀各自嘅 JSON 有冇解析成功（唔含值） */
  parse_ok: { a: boolean; b: boolean };
  usage: ReadUsage;
}

export interface DocumentImages {
  full: string;
  tiles: readonly string[];
}

export async function readDocument(client: VisionClient, type: OcrDocType, images: DocumentImages, now: Date = new Date()): Promise<DocumentReadResult> {
  const fields = OCR_DOC_FIELDS[type];
  const system = buildSystemPrompt(type);
  // 兩次獨立讀：同時發出；B 嘅 request 只由 (type, tiles) 構成。
  const [ra, rb] = await Promise.all([
    client.complete({ system, userText: buildUserTextFull(type), images: [images.full] }),
    client.complete({ system, userText: buildUserTextTiles(type, images.tiles.length), images: images.tiles }),
  ]);
  const pa = parseModelJson(ra.text, fields);
  const pb = parseModelJson(rb.text, fields);
  const out: Partial<Record<OcrFieldKey, FieldResult>> = {};
  for (const f of fields) out[f] = reconcile(f, pa?.[f] ?? null, pb?.[f] ?? null, now);
  return {
    type,
    fields: out,
    parse_ok: { a: pa !== null, b: pb !== null },
    usage: { promptTokens: ra.promptTokens + rb.promptTokens, completionTokens: ra.completionTokens + rb.completionTokens, calls: 2 },
  };
}
