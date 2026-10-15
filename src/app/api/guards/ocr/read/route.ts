// WP-GUARD-OCR §29：`POST /api/guards/ocr/read`——瀏覽器上載縮好嘅證件圖（data URL）→ Claude（讀 A）＋DeepSeek（讀 B）視覺辨識 →
// 逐欄 confirmed／review／missing。
// 鐵則：圖片同辨識出嚟嘅欄位值只喺記憶體處理——唔寫磁碟／DB／log／audit／error message（console.* 都唔帶值）。
// audit `guard_ocr_read` 淨係記文件類型、欄位狀態計數、模型、tokens、耗時。
import { z } from "zod";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ApiError, BadRequest, NotFound } from "@/lib/api/errors";
import { getClientIp, handleApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { reserveQuota } from "@/lib/guards/import/limits";
import { OCR_DOC_TYPES, OCR_FIELDS, OCR_MAX_BODY_CHARS, OCR_MAX_DOCS, OCR_MAX_FIELD_CROPS, OCR_MAX_IMAGE_CHARS, OCR_MAX_TILES, isGuardOcrConfigured, type OcrDocType, type OcrFieldKey } from "@/lib/guards/ocr/config";
import { OCR_CROP_FIELDS, OCR_EXTRA_CROP_FIELDS, hasCropFields } from "@/lib/guards/ocr/field-crops";
import { CONTINUATION_INVALID_MSG, OCR_MAX_CONTINUATION_CHARS, consumeRefsCredit, signContinuation, signRefs, verifyContinuation, verifyRefs } from "@/lib/guards/ocr/continuation";
import { confirmedRefsFromDocs, countCross, crossForOnboarding, refsCount, type CrossOutcome, type Refs } from "@/lib/guards/ocr/refs";
import { OcrUnavailableError } from "@/lib/guards/ocr/vision-client";
import { getReadClients } from "@/lib/guards/ocr/clients";
import { readDocument, readStageA, readStageB, type DocumentReadResult, type StageAResult } from "@/lib/guards/ocr/read";

export const dynamic = "force-dynamic";

const OCR_UNAVAILABLE_MSG = "證件辨識暫時用唔到，請改為全部自己輸入，或者遲啲再試";

const dataUrl = z
  .string()
  .max(OCR_MAX_IMAGE_CHARS)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/);

const docTypes = z.enum(OCR_DOC_TYPES);

// 舊單次流程（冇 stage）：不變
const bodySchema = z
  .object({
    documents: z.array(z.object({ type: docTypes, full: dataUrl, tiles: z.array(dataUrl).min(1).max(OCR_MAX_TILES) }).strict()).min(1).max(OCR_MAX_DOCS),
  })
  .strict();

// WP-OCR-3 stage a：同舊 body，tiles optional（入職表唔需要；身份證／住址證明要帶，伺服器直接讀完回 final:true）
const bodyASchema = z
  .object({
    stage: z.literal("a"),
    documents: z.array(z.object({ type: docTypes, full: dataUrl, tiles: z.array(dataUrl).max(OCR_MAX_TILES).optional() }).strict()).min(1).max(OCR_MAX_DOCS),
    // WP-OCR-1（additive）：印刷證件 stage a 回應嘅 refs_token；驗簽失敗唔報錯（照舊讀，audit 計 refs_rejected）。長度由 verifyRefs 判斷（超長＝rejected）。
    refs_token: z.string().max(200_000).optional(),
  })
  .strict();

// WP-OCR-3 stage b：continuation（stage a 簽發）＋放大圖。full 可選（additive）：有先做第三讀仲裁。
const bodyBSchema = z
  .object({
    stage: z.literal("b"),
    documents: z
      .array(
        z
          .object({
            type: docTypes,
            continuation: z.string().min(1).max(OCR_MAX_CONTINUATION_CHARS),
            full: dataUrl.optional(),
            images_b: z.object({ kind: z.enum(["tiles", "field_crops"]), images: z.array(dataUrl).min(1).max(OCR_MAX_FIELD_CROPS), field_of: z.array(z.union([z.enum(OCR_FIELDS), z.null()])).max(OCR_MAX_FIELD_CROPS).optional() }).strict(),
          })
          .strict(),
      )
      .min(1)
      .max(OCR_MAX_DOCS),
    // WP-OCR-1（additive）：同 stage a 一樣；有效先計交叉核對
    refs_token: z.string().max(200_000).optional(),
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
  const stage = raw && typeof raw === "object" ? (raw as { stage?: unknown }).stage : undefined;
  if (stage === undefined) return handleLegacy(req, session, raw);
  if (stage === "a") return handleStageA(req, session, raw);
  if (stage === "b") return handleStageB(req, session, raw);
  throw BadRequest("請求格式唔啱（stage）");
}

type Session = Awaited<ReturnType<typeof requirePermission>>;

const sumUsage = <T extends { usage: { promptTokens: number; completionTokens: number; calls: number; truncated: number } }>(rs: readonly T[]) =>
  rs.reduce((a, r) => ({ prompt_tokens: a.prompt_tokens + r.usage.promptTokens, completion_tokens: a.completion_tokens + r.usage.completionTokens, calls: a.calls + r.usage.calls, truncated_calls: a.truncated_calls + r.usage.truncated }), { prompt_tokens: 0, completion_tokens: 0, calls: 0, truncated_calls: 0 });

function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "";
}

/** 取得 client；用唔到 → 503 response。 */
function clientsOr503(): { client: ReturnType<typeof getReadClients> } | { res: NextResponse } {
  try {
    return { client: getReadClients() };
  } catch (e) {
    if (e instanceof OcrUnavailableError) return { res: NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 }) };
    throw e;
  }
}

async function auditUnavailable(session: Session, req: Request, e: OcrUnavailableError, model: string, docs: readonly OcrDocType[], images: number, ms: number, stage?: "a" | "b") {
  console.error(`[guard-ocr] provider unavailable status=${e.status ?? "n/a"}`);
  await writeAudit({ actorUserId: session.userId, tableName: "guard_ocr", rowId: session.userId, action: "guard_ocr_read", after: { ok: false, ...(stage ? { stage } : {}), error: "provider_unavailable", provider_status: e.status, provider_reason: e.reason, model, documents: docs, images, ms }, ip: getClientIp(req) });
}

async function handleStageA(req: Request, session: Session, raw: unknown): Promise<NextResponse> {
  const parsed = bodyASchema.safeParse(raw);
  if (!parsed.success) throw BadRequest(`請求格式唔啱（${zodPath(parsed.error)}）`);
  const docs = parsed.data.documents;
  if (new Set(docs.map((d) => d.type)).size !== docs.length) throw BadRequest("每種文件只可以傳一份");
  // 驗收 S3：非入職表文件（冇欄位級裁圖設計）要帶 tiles，伺服器直接讀完
  if (docs.some((d) => !hasCropFields(d.type) && !(d.tiles && d.tiles.length > 0))) throw BadRequest("請求格式唔啱（documents.tiles）");
  // WP-OCR-1：refs_token 驗簽（失敗＝照舊讀，唔報錯，audit 計 refs_rejected）。有效 token 證明同一流程嘅印刷證件 stage a 已預留過配額
  // → 第二次 stage a（入職表）用 token 抵銷一次預留（單次使用 credit）；token 無效／已用過就照常預留。
  const secret = sessionSecret();
  const rv = parsed.data.refs_token !== undefined ? verifyRefs(parsed.data.refs_token, secret, session.userId) : null;
  const refsRejected = rv !== null && !rv.ok ? 1 : 0;
  const refs: Refs | null = rv && rv.ok ? rv.refs : null;
  if (!(rv && rv.ok && docs.every((d) => hasCropFields(d.type)) && consumeRefsCredit(rv.nonce))) await reserveQuota(session, "ocr");
  const got = clientsOr503();
  if ("res" in got) return got.res;
  const client = got.client;
  // WP-OCR-3 驗收 S3：兩段式只用於有欄位級裁圖設計嘅文件（入職表）。其他類型（身份證／住址證明）要帶 tiles，
  // 伺服器直接 A＋B(2×2) 並行讀完回最終 fields（final:true），唔發 continuation。
  const t0 = Date.now();
  type Item = { kind: "a"; r: StageAResult } | { kind: "final"; r: DocumentReadResult };
  let items: Item[];
  try {
    items = await Promise.all(
      docs.map(async (d): Promise<Item> =>
        hasCropFields(d.type) ? { kind: "a", r: await readStageA(client, d.type, d.full, refs) } : { kind: "final", r: await readDocument(client, d.type, { full: d.full, tiles: d.tiles! }) },
      ),
    );
  } catch (e) {
    if (e instanceof OcrUnavailableError) {
      await auditUnavailable(session, req, e, client.a.model, docs.map((d) => d.type), docs.length, Date.now() - t0, "a");
      return NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 });
    }
    throw e;
  }
  const ms = Date.now() - t0;
  const usage = sumUsage(items.map((i) => i.r));
  // WP-OCR-1：印刷證件（final）嘅 confirmed 欄位值 → refs_token（additive，客戶端帶去入職表 stage a／b）。冇 final 文件＝唔簽發。
  const finals = items.flatMap((i) => (i.kind === "final" ? [i.r] : []));
  let refsToken: string | undefined;
  // 同一請求混入入職表（舊 client 一次過傳）唔簽發：入職表讀 A 同 refs 嘅來源要分開兩次請求
  if (finals.length > 0 && !docs.some((d) => hasCropFields(d.type))) {
    try {
      refsToken = signRefs(confirmedRefsFromDocs(finals), session.userId, secret);
    } catch {
      refsToken = undefined; // 過大／secret 問題：當冇 token（入職表照舊讀）
    }
  }
  const refsInjectedDocs = items.filter((i) => i.kind === "a" && i.r.refs_injected > 0).length;
  const documents = items.map((i) => {
    if (i.kind === "final") {
      const r = i.r;
      return { type: r.type, final: true, fields: r.fields, parse_ok: r.parse_ok, provider_used: r.provider_used, model_used: r.model_used, arbiter: r.arbiter, images_b_kind: r.images_b_kind, field_boxes_used: r.field_boxes_used, als: r.als };
    }
    const r = i.r;
    return {
      type: r.type,
      // 欄位 box（0–1 正規化版面座標，唔含任何辨識值）；冇有效 box＝空物件
      field_boxes: r.field_boxes,
      continuation: signContinuation({ type: r.type, uid: session.userId, a: r.a_fields_raw, boxes: r.field_boxes, provider: r.provider, model: r.model, fb: r.fallback_reason, usage: r.usage }, secret),
      parse_ok: { a: r.parse_ok },
      provider_used: { a: r.provider },
      model_used: { a: r.model },
    };
  });
  const provA = items.map((i) => (i.kind === "a" ? i.r.provider : i.r.provider_used.a));
  const providerUsed = { a: provA.every((p) => p === "claude") ? ("claude" as const) : ("deepseek" as const) };
  await writeAudit({
    actorUserId: session.userId,
    tableName: "guard_ocr",
    rowId: session.userId,
    action: "guard_ocr_read",
    // stage a：淨記文件類型、有效 box 欄數、tokens、耗時（冇值、冇 box 座標、冇 continuation）；final 文件另記狀態計數
    after: {
      ok: true,
      stage: "a",
      model: client.a.model,
      provider_used: providerUsed,
      claude_fallbacks: items.flatMap((i) => (i.r.fallback_reason ? [i.r.fallback_reason] : [])),
      documents: items.map((i) => {
        if (i.kind === "a") return { type: i.r.type, boxes: Object.keys(i.r.field_boxes).length, parse_failed: i.r.parse_ok ? 0 : 1 };
        const counts = { confirmed: 0, review: 0, missing: 0 };
        for (const f of Object.values(i.r.fields)) if (f) counts[f.status] += 1;
        return { type: i.r.type, final: true, ...counts, parse_failed: (i.r.parse_ok.a ? 0 : 1) + (i.r.parse_ok.b ? 0 : 1) };
      }),
      images: docs.reduce((n, d) => n + 1 + (hasCropFields(d.type) ? 0 : d.tiles!.length), 0),
      ms,
      arbiter_calls: items.filter((i) => i.kind === "final" && i.r.arbiter.called).length,
      ...alsCounts(finals),
      // WP-OCR-1：淨計數（冇值）——簽發咗 refs_token 冇／幾多份入職表讀 A 注入咗 refs／帶嚟嘅 refs_token 驗簽失敗
      refs_issued: refsToken ? 1 : 0,
      refs_injected_docs: refsInjectedDocs,
      refs_rejected: refsRejected,
      ...usage,
    },
    ip: getClientIp(req),
  });
  return NextResponse.json({ stage: "a", model: client.a.model, ms, usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, calls: usage.calls }, provider_used: providerUsed, ...(refsToken ? { refs_token: refsToken } : {}), documents });
}

/** field_crops 嘅 field_of 必須正好係該文件類型嘅裁圖欄位（每欄一張、冇重複），images 長度一致。 */
function fieldCropsValid(type: OcrDocType, imagesLen: number, fieldOf: readonly (OcrFieldKey | null)[] | undefined): boolean {
  const want = OCR_CROP_FIELDS[type];
  if (!want || !fieldOf || fieldOf.length !== imagesLen || imagesLen > OCR_MAX_FIELD_CROPS) return false;
  const got = fieldOf.filter((f): f is OcrFieldKey => f !== null);
  // WP-OCR-1：必須欄位（電話、地址）一定要有；額外欄位（姓名／HKID／出生日期）有就收；每欄最多一張
  const extra = OCR_EXTRA_CROP_FIELDS[type] ?? [];
  return got.length === fieldOf.length && new Set(got).size === got.length && want.every((f) => got.includes(f)) && got.every((f) => want.includes(f) || extra.includes(f));
}

async function handleStageB(req: Request, session: Session, raw: unknown): Promise<NextResponse> {
  const parsed = bodyBSchema.safeParse(raw);
  if (!parsed.success) throw BadRequest(`請求格式唔啱（${zodPath(parsed.error)}）`);
  const docs = parsed.data.documents;
  if (new Set(docs.map((d) => d.type)).size !== docs.length) throw BadRequest("每種文件只可以傳一份");
  // 驗簽／過期／userId／單次使用——任何失敗一律固定字串 400（唔講原因）
  const secret = sessionSecret();
  const conts = docs.map((d) => verifyContinuation(d.continuation, secret, session.userId));
  if (conts.some((c) => !c.ok) || docs.some((d, i) => (conts[i] as { ok: true; payload: { type: OcrDocType } }).payload.type !== d.type)) throw BadRequest(CONTINUATION_INVALID_MSG);
  for (const d of docs) {
    if (d.images_b.kind === "tiles" && d.images_b.images.length > OCR_MAX_TILES) throw BadRequest("請求格式唔啱（images_b.images）");
    if (d.images_b.kind === "field_crops" && !fieldCropsValid(d.type, d.images_b.images.length, d.images_b.field_of)) throw BadRequest("請求格式唔啱（images_b.field_of）");
  }
  // stage b 唔另外預留配額：continuation 證明 stage a 已預留過（stage a 同舊單次流程各計一次）
  const got = clientsOr503();
  if ("res" in got) return got.res;
  const client = got.client;
  const t0 = Date.now();
  const imagesCount = docs.reduce((n, d) => n + (d.full ? 1 : 0) + d.images_b.images.length, 0);
  let results: DocumentReadResult[];
  try {
    results = await Promise.all(
      docs.map((d, i) => {
        const payload = (conts[i] as { ok: true; payload: import("@/lib/guards/ocr/continuation").ContinuationPayload }).payload;
        return readStageB(
          client,
          d.type,
          { a_fields_raw: payload.a, provider: payload.provider, model: payload.model, fallback_reason: payload.fb },
          { kind: d.images_b.kind, images: d.images_b.images, ...(d.images_b.field_of ? { fieldOf: d.images_b.field_of } : {}), ...(d.full ? { full: d.full } : {}) },
        );
      }),
    );
  } catch (e) {
    if (e instanceof OcrUnavailableError) {
      await auditUnavailable(session, req, e, client.b.model, docs.map((d) => d.type), imagesCount, Date.now() - t0, "b");
      return NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 });
    }
    throw e;
  }
  // WP-OCR-1：有效 refs_token → 入職表欄同身份證值交叉核對（伺服器計；冇 refs 就冇 cross）
  const rv = parsed.data.refs_token !== undefined ? verifyRefs(parsed.data.refs_token, secret, session.userId) : null;
  const refsRejected = rv !== null && !rv.ok ? 1 : 0;
  let cross: CrossOutcome | null = null;
  const formRes = results.find((r) => r.type === "onboarding_form");
  if (rv && rv.ok && refsCount(rv.refs) > 0 && formRes) {
    cross = crossForOnboarding(rv.refs, formRes.fields);
    for (const [k, c] of Object.entries(cross.form)) formRes.fields[k as OcrFieldKey]!.cross = c;
  }
  return respondResults(req, session, client, results, imagesCount, Date.now() - t0, "b", { cross, refsRejected });
}

async function handleLegacy(req: Request, session: Session, raw: unknown): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(raw);
  // 錯誤訊息淨帶欄位路徑，唔帶值
  if (!parsed.success) throw BadRequest(`請求格式唔啱（${zodPath(parsed.error)}）`);
  const docs = parsed.data.documents;
  if (new Set(docs.map((d) => d.type)).size !== docs.length) throw BadRequest("每種文件只可以傳一份");

  // 預留配額（短 transaction，鎖外先呼叫模型）。失敗／超時唔退還次數。
  await reserveQuota(session, "ocr");
  {
    let client: ReturnType<typeof getReadClients>;
    try {
      client = getReadClients();
    } catch (e) {
      if (e instanceof OcrUnavailableError) return NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 });
      throw e;
    }
    const t0 = Date.now();
    const imagesCount = docs.reduce((n, d) => n + 1 + d.tiles.length, 0);
    let results: DocumentReadResult[];
    try {
      results = await Promise.all(docs.map((d) => readDocument(client, d.type, { full: d.full, tiles: d.tiles })));
    } catch (e) {
      const ms = Date.now() - t0;
      if (e instanceof OcrUnavailableError) {
        console.error(`[guard-ocr] provider unavailable status=${e.status ?? "n/a"}`);
        await writeAudit({ actorUserId: session.userId, tableName: "guard_ocr", rowId: session.userId, action: "guard_ocr_read", after: { ok: false, error: "provider_unavailable", provider_status: e.status, provider_reason: e.reason, model: client.a.model, documents: docs.map((d) => d.type), images: imagesCount, ms }, ip: getClientIp(req) });
        return NextResponse.json({ error: "ocr_unavailable", message: OCR_UNAVAILABLE_MSG }, { status: 503 });
      }
      throw e;
    }
    return respondResults(req, session, client, results, imagesCount, Date.now() - t0);
  }
}

/** WP-OCR-2 audit 只加計數（冇查詢字串、冇地址）：查過 ALS 嘅文件數／出咗候選嘅文件數／查失敗數。 */
function alsCounts(results: readonly Pick<DocumentReadResult, "als">[]) {
  return {
    als_called_docs: results.filter((r) => r.als.called).length,
    als_candidate_docs: results.filter((r) => r.als.candidate).length,
    als_failed: results.filter((r) => r.als.failed).length,
  };
}

/** WP-OCR-3 audit 只加計數：用欄位級裁圖嘅文件數／本應欄位級但退回 2×2 格嘅文件數。 */
function stageBCounts(results: readonly DocumentReadResult[]) {
  return {
    field_crops_docs: results.filter((r) => r.images_b_kind === "field_crops").length,
    fallback_tiles_docs: results.filter((r) => r.images_b_kind === "tiles" && OCR_CROP_FIELDS[r.type]).length,
  };
}

async function respondResults(req: Request, session: Session, client: ReturnType<typeof getReadClients>, results: DocumentReadResult[], imagesCount: number, ms: number, stage?: "b", extra?: { cross: CrossOutcome | null; refsRejected: number }): Promise<NextResponse> {
  const usage = results.reduce((a, r) => ({ prompt_tokens: a.prompt_tokens + r.usage.promptTokens, completion_tokens: a.completion_tokens + r.usage.completionTokens, calls: a.calls + r.usage.calls, truncated_calls: a.truncated_calls + r.usage.truncated }), { prompt_tokens: 0, completion_tokens: 0, calls: 0, truncated_calls: 0 });
  // 供應商：任何一份文件讀 A 退回咗 DeepSeek，頂層就報 deepseek（每份文件另有自己嘅 provider_used）
  const providerUsed = { a: results.every((r) => r.provider_used.a === "claude") ? ("claude" as const) : ("deepseek" as const), b: results.every((r) => r.provider_used.b === "claude") ? ("claude" as const) : ("deepseek" as const) };
  const fallbackReasons = results.flatMap((r) => (r.fallback_reason ? [r.fallback_reason] : []));
  const byProvider = {
    claude: { prompt_tokens: 0, completion_tokens: 0, calls: 0 },
    deepseek: { prompt_tokens: 0, completion_tokens: 0, calls: 0 },
  };
  for (const r of results) for (const p of ["claude", "deepseek"] as const) {
    byProvider[p].prompt_tokens += r.usage_by_provider[p].promptTokens;
    byProvider[p].completion_tokens += r.usage_by_provider[p].completionTokens;
    byProvider[p].calls += r.usage_by_provider[p].calls;
  }
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
    // arbiter_calls：第三讀仲裁呼叫數（只記數量）
    // WP-OCR-1：stage b 另記交叉核對計數（match／differs／unreadable）同 refs_rejected——淨數字
    after: { ok: true, ...(stage ? { stage, ...stageBCounts(results) } : {}), ...(extra ? { refs_rejected: extra.refsRejected, ...(extra.cross ? { cross: countCross(extra.cross) } : {}) } : {}), model: client.a.model, provider_used: providerUsed, claude_fallbacks: fallbackReasons, usage_by_provider: byProvider, documents: summary, images: imagesCount, ms, arbiter_calls: results.filter((r) => r.arbiter.called).length, ...alsCounts(results), ...usage },
    ip: getClientIp(req),
  });
  return NextResponse.json({
    model: client.a.model,
    ms,
    usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, calls: usage.calls },
    usage_by_provider: byProvider,
    // WP-OCR-CLAUDE §36（additive）：兩次讀實際用咗邊個供應商／型號（淨係標籤，冇圖片、冇欄位值）
    provider_used: providerUsed,
    // WP-OCR-1（additive）：身份證欄對入職表手寫值嘅交叉核對（只有 stage b 且帶有效 refs_token 先有）；client 併入 id_card 文件各欄嘅 cross
    ...(extra?.cross && Object.keys(extra.cross.id).length > 0 ? { id_cross: extra.cross.id } : {}),
    models_used: { a: results.every((r) => r.model_used.a === results[0]!.model_used.a) ? results[0]!.model_used.a : results.find((r) => r.provider_used.a === "deepseek")!.model_used.a, b: results[0]?.model_used.b ?? client.b.model },
    // WP-OCR-4（additive）：每欄多 candidates_ranked／arbiter；每份文件多 arbiter { called, fields }（淨計數）
    documents: results.map((r) => ({ type: r.type, fields: r.fields, parse_ok: r.parse_ok, provider_used: r.provider_used, arbiter: r.arbiter, images_b_kind: r.images_b_kind, field_boxes_used: r.field_boxes_used, als: r.als })),
  });
}
