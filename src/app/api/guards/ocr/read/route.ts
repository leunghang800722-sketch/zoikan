// WP-GUARD-OCR §29：`POST /api/guards/ocr/read`——瀏覽器上載縮好嘅證件圖（data URL）→ DeepSeek 視覺辨識 →
// 逐欄 confirmed／review／missing。
// 鐵則：圖片同辨識出嚟嘅欄位值只喺記憶體處理——唔寫磁碟／DB／log／audit／error message（console.* 都唔帶值）。
// audit `guard_ocr_read` 淨係記文件類型、欄位狀態計數、模型、tokens、耗時。
import { z } from "zod";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ApiError, BadRequest, NotFound } from "@/lib/api/errors";
import { getClientIp, handleApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { assertOcrReadQuota, withUserQuotaLock } from "@/lib/guards/import/limits";
import { OCR_DOC_TYPES, OCR_MAX_BODY_CHARS, OCR_MAX_DOCS, OCR_MAX_IMAGE_CHARS, OCR_MAX_TILES, isGuardOcrConfigured } from "@/lib/guards/ocr/config";
import { OcrUnavailableError, getVisionClient } from "@/lib/guards/ocr/vision-client";
import { readDocument, type DocumentReadResult } from "@/lib/guards/ocr/read";

export const dynamic = "force-dynamic";

const OCR_UNAVAILABLE_MSG = "證件辨識暫時用唔到，請改為全部自己輸入，或者遲啲再試";

const dataUrl = z
  .string()
  .max(OCR_MAX_IMAGE_CHARS)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);

const bodySchema = z
  .object({
    documents: z
      .array(z.object({ type: z.enum(OCR_DOC_TYPES), full: dataUrl, tiles: z.array(dataUrl).min(1).max(OCR_MAX_TILES) }).strict())
      .min(1)
      .max(OCR_MAX_DOCS),
  })
  .strict();

function zodPath(e: z.ZodError): string {
  const i = e.issues[0];
  return i ? i.path.join(".") : "body";
}

/** 串流讀請求體：累計超過上限即中止（唔靠 content-length，亦唔會先讀晒先查）。 */
async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "payload_too_large", "圖片太大，請縮細啲再上載");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    if (e instanceof ApiError) return handleApiError(e);
    // 非預期錯誤：只 log 錯誤類別（唔 log message／stack——可能帶請求內容），回通用 500
    console.error(`[guard-ocr] unexpected error name=${e instanceof Error ? e.name : typeof e}`);
    return NextResponse.json({ error: "internal_error", message: "系統錯誤" }, { status: 500 });
  }
}

async function handle(req: Request): Promise<NextResponse> {
  const session = await requirePermission(req, "安員批量導入", "create");
  if (!isGuardOcrConfigured()) throw NotFound("未啟用證件辨識");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > OCR_MAX_BODY_CHARS + 1_000) throw new ApiError(413, "payload_too_large", "圖片太大，請縮細啲再上載");
  const text = await readBodyLimited(req, OCR_MAX_BODY_CHARS);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw BadRequest("請求格式唔啱");
  }
  const parsed = bodySchema.safeParse(raw);
  // 錯誤訊息淨帶欄位路徑，唔帶值
  if (!parsed.success) throw BadRequest(`請求格式唔啱（${zodPath(parsed.error)}）`);
  const docs = parsed.data.documents;
  if (new Set(docs.map((d) => d.type)).size !== docs.length) throw BadRequest("每種文件只可以傳一份");

  // 配額檢查 → 呼叫模型 → 寫 audit（計數）整段按用戶上鎖：並發請求逐個過 check，繞唔過每日上限
  return withUserQuotaLock(session, "ocr", async () => {
    await assertOcrReadQuota(session);
    const client = getVisionClient();
    const t0 = Date.now();
    const imagesCount = docs.reduce((n, d) => n + 1 + d.tiles.length, 0);
    let results: DocumentReadResult[];
    try {
      results = await Promise.all(docs.map((d) => readDocument(client, d.type, { full: d.full, tiles: d.tiles })));
    } catch (e) {
      const ms = Date.now() - t0;
      if (e instanceof OcrUnavailableError) {
        console.error(`[guard-ocr] provider unavailable status=${e.status ?? "n/a"}`);
        await writeAudit({ actorUserId: session.userId, tableName: "guard_ocr", rowId: session.userId, action: "guard_ocr_read", after: { ok: false, error: "provider_unavailable", provider_status: e.status, model: client.model, documents: docs.map((d) => d.type), images: imagesCount, ms }, ip: getClientIp(req) });
        return NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 });
      }
      throw e;
    }
    const ms = Date.now() - t0;
    const usage = results.reduce((a, r) => ({ prompt_tokens: a.prompt_tokens + r.usage.promptTokens, completion_tokens: a.completion_tokens + r.usage.completionTokens, calls: a.calls + r.usage.calls, truncated_calls: a.truncated_calls + r.usage.truncated }), { prompt_tokens: 0, completion_tokens: 0, calls: 0, truncated_calls: 0 });
    const summary = results.map((r) => {
      const counts = { confirmed: 0, review: 0, missing: 0 };
      for (const f of Object.values(r.fields)) if (f) counts[f.status] += 1;
      return { type: r.type, ...counts, parse_failed: (r.parse_ok.a ? 0 : 1) + (r.parse_ok.b ? 0 : 1) };
    });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "guard_ocr",
      rowId: session.userId,
      action: "guard_ocr_read",
      // truncated_calls：撞 output token 上限嘅呼叫數（只記數量，冇內容）
      after: { ok: true, model: client.model, documents: summary, images: imagesCount, ms, ...usage },
      ip: getClientIp(req),
    });
    return NextResponse.json({
      model: client.model,
      ms,
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, calls: usage.calls },
      documents: results.map((r) => ({ type: r.type, fields: r.fields, parse_ok: r.parse_ok })),
    });
  });
}
