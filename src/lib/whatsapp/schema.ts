// W0：WAHA webhook body 驗證＋正規化（純函數，冇 DB）。
//
// 假設（無法上網核對 WAHA 文檔，按已知常見格式；欄位全部 optional，缺欄用最保守處理）：
//   { event: "message"|"message.edited"|"message.revoked", session, payload: {
//       id, timestamp(秒；>1e12 當毫秒), from(群組 jid 或私訊 jid), to?, participant?(群組內發訊人),
//       fromMe, body, hasMedia, media?{mimetype}, replyTo?{id}, _data?{key?{participant}},
//       editedMessageId?(edited：原訊息 id；冇就用 id), revokedMessageId? | before?{id}(revoked：原訊息 id；冇就用 id) } }
// 型別錯（例如 fromMe 係字串）→ 400。未知 top-level 欄位忽略。
import { z } from "zod";
import { WA_MAX_TEXT_CHARS } from "./config";

const Nullish = <T extends z.ZodType>(t: T) => t.nullish();

const PayloadSchema = z.object({
  id: Nullish(z.string().min(1).max(256)),
  timestamp: Nullish(z.union([z.number(), z.string().regex(/^\d{1,16}$/)])),
  from: Nullish(z.string().max(256)),
  to: Nullish(z.string().max(256)),
  participant: Nullish(z.string().max(256)),
  fromMe: Nullish(z.boolean()),
  body: Nullish(z.string()),
  hasMedia: Nullish(z.boolean()),
  media: Nullish(z.object({ mimetype: Nullish(z.string().max(256)) })),
  replyTo: Nullish(z.object({ id: Nullish(z.string().max(256)) })),
  editedMessageId: Nullish(z.string().max(256)),
  revokedMessageId: Nullish(z.string().max(256)),
  before: Nullish(z.object({ id: Nullish(z.string().max(256)) })),
  _data: Nullish(z.record(z.string(), z.unknown())),
});

export const WebhookEnvelopeSchema = z.object({
  event: z.string().min(1).max(64),
  session: Nullish(z.string().max(128)),
  payload: PayloadSchema,
});

export type WaEventKind = "message" | "edited" | "revoked";

export interface NormalizedWaEvent {
  kind: WaEventKind;
  session: string;
  /** 目標訊息 id（edited／revoked＝原訊息 id）。 */
  messageId: string;
  chatJid: string;
  senderJid: string;
  fromMe: boolean;
  /** 事件時間；payload 冇就 null（由 ingest 用 now）。 */
  ts: Date | null;
  text: string;
  mediaType: string | null;
  quotedMessageId: string | null;
}

export const EVENT_KIND: Record<string, WaEventKind | undefined> = {
  message: "message",
  "message.edited": "edited",
  "message.revoked": "revoked",
};

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function parseTimestamp(v: number | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 媒體類型：只記 mimetype 主類（image／audio／video／application…），唔記檔名／內容。 */
function mediaTypeOf(payload: z.infer<typeof PayloadSchema>): string | null {
  const mt = payload.media?.mimetype;
  if (mt) {
    const main = mt.split(";")[0]!.split("/")[0]!.trim().toLowerCase();
    return main.slice(0, 64) || "unknown";
  }
  return payload.hasMedia ? "unknown" : null;
}

/** 已知事件 → 正規化；缺目標訊息 id 或 chat jid → null（呼叫方回 400）。 */
export function normalizeEvent(kind: WaEventKind, env: z.infer<typeof WebhookEnvelopeSchema>): NormalizedWaEvent | null {
  const p = env.payload;
  let messageId: string | null | undefined;
  if (kind === "edited") messageId = p.editedMessageId ?? p.id;
  else if (kind === "revoked") messageId = p.revokedMessageId ?? p.before?.id ?? p.id;
  else messageId = p.id;
  const chatJid = p.from ?? p.to ?? null;
  if (!messageId || !chatJid) return null;
  const participant = p.participant ?? (dig(p._data, ["key", "participant"]) as string | undefined) ?? (dig(p._data, ["participant"]) as string | undefined);
  const senderJid = typeof participant === "string" && participant ? participant : chatJid;
  const body = (p.body ?? "").slice(0, WA_MAX_TEXT_CHARS);
  return {
    kind,
    session: env.session || "default",
    messageId,
    chatJid,
    senderJid,
    fromMe: p.fromMe === true,
    ts: parseTimestamp(p.timestamp),
    text: body,
    mediaType: mediaTypeOf(p),
    quotedMessageId: p.replyTo?.id ?? null,
  };
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** 發訊人 jid → 正規化電話（香港 8 位；其他國際號保留 +）。`@lid` 等非電話 jid → null。 */
export function telFromJid(jid: string): string | null {
  const m = jid.match(/^(\d{6,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/);
  if (!m) return null;
  const digits = m[1]!;
  if (/^852\d{8}$/.test(digits)) return digits.slice(3);
  return `+${digits}`;
}
