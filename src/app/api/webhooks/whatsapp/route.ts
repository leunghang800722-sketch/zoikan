// W0：WAHA webhook 接收（系統第一條無 session 嘅公開路由，獨立保護，見 docs/plans/whatsapp-roster-plan.md §3）。
//   WA_ENABLED!=="1" → 503 固定字串；raw body ≤64 KB；HMAC-sha512（X-Webhook-Hmac，對 raw bytes）
//   ＋自訂 header X-Zoikan-Hook 雙重驗證，唔過 → 401（唔落庫、唔 log body）；schema 錯 → 400（唔記 body）。
//   通過後只做落庫（冪等），<50ms 回 200 {ok:true}；解析由 W1 job 做。
// 唔經 session／RBAC；middleware 對 /api/* 只做 CSRF（非瀏覽器 server-to-server 冇 Sec-Fetch-Site／Origin → 放行）。
import { NextResponse } from "next/server";
import { WA_HMAC_ALGO_HEADER, WA_HMAC_HEADER, WA_HOOK_HEADER, WA_MAX_BODY_BYTES, waEnabled, waHeaderSecret, waHmacKey } from "@/lib/whatsapp/config";
import { verifyWebhook } from "@/lib/whatsapp/verify";
import { EVENT_KIND, WebhookEnvelopeSchema, normalizeEvent } from "@/lib/whatsapp/schema";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import { safeErrorSummary } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const J = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** 讀 body，最多 max bytes；超過即停（回 null），避免被大 body 塞爆記憶體。 */
async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  const cl = Number(req.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request) {
  if (!waEnabled()) return J({ error: "whatsapp_disabled" }, 503);

  let raw: Buffer | null;
  try {
    raw = await readLimited(req, WA_MAX_BODY_BYTES);
  } catch {
    return J({ error: "bad_request" }, 400);
  }
  if (raw === null) return J({ error: "payload_too_large" }, 413);

  const verdict = verifyWebhook({
    rawBody: raw,
    hmacHeader: req.headers.get(WA_HMAC_HEADER),
    algoHeader: req.headers.get(WA_HMAC_ALGO_HEADER),
    hookHeader: req.headers.get(WA_HOOK_HEADER),
    hmacKey: waHmacKey(),
    headerSecret: waHeaderSecret(),
  });
  if (!verdict.ok) {
    // 只記原因碼，絕不記 body／header 值。
    if (verdict.reason === "no_key" || verdict.reason === "no_secret") console.error(`[whatsapp] webhook 未設定 ${verdict.reason}，一律拒絕`);
    return J({ error: "unauthorized" }, 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return J({ error: "bad_request" }, 400);
  }
  const parsed = WebhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) return J({ error: "bad_request" }, 400);

  const kind = EVENT_KIND[parsed.data.event];
  if (!kind) return J({ ok: true }, 200); // 未訂閱嘅事件類型：唔處理，照回 200
  const ev = normalizeEvent(kind, parsed.data);
  if (!ev) return J({ error: "bad_request" }, 400);

  try {
    const outcome = await ingestEvent(ev);
    // 編輯／撤回事件嘅 chat 同原行唔一致：no-op，只記計數字樣（唔記 body／id）
    if (outcome === "chat_mismatch") console.warn("[whatsapp] chat_mismatch：編輯／撤回事件嘅群同原訊息唔一致，已忽略");
  } catch (e) {
    console.error("[whatsapp] webhook 落庫失敗", safeErrorSummary(e));
    return J({ error: "internal_error" }, 500); // WAHA 會重試；冪等吸收
  }
  return J({ ok: true }, 200);
}
