// W0：webhook 事件落庫（server-only）。只做「驗簽之後嘅落庫」，唔做任何解析／過濾打分（W1 先做）。
// 冪等：message＝INSERT … ON CONFLICT (message_id) DO NOTHING（Prisma createMany skipDuplicates）；
//   edited／revoked 喺同一 transaction 內 FOR UPDATE 鎖行，重覆投遞（同文字／已撤回）＝no-op。
// 私隱：非群組（私訊）只記「有一條私訊」——chat／sender jid 以 hash 取代、text 置空、唔解析電話。
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { telLookupVariants } from "@/lib/guards/identity";
import { WA_FUTURE_MS, WA_STALE_MS } from "./config";
import { isGroupJid, telFromJid, type NormalizedWaEvent } from "./schema";
import { fetchMedia, storeMediaEvidence } from "./media";

export type IngestOutcome =
  | "inserted"
  | "inserted_ignored"
  | "duplicate"
  | "edited"
  | "edit_tombstone"
  | "edit_noop"
  | "revoked"
  | "revoked_tombstone"
  | "revoke_noop"
  | "chat_mismatch";

export type IgnoreReason = "not_group" | "from_me" | "no_timestamp" | "stale" | "future_ts";

/** ts 為 null＝payload 冇 timestamp → 當 stale 處理（ignored:no_timestamp），唔用 now。 */
export function ignoreReasonFor(ev: Pick<NormalizedWaEvent, "chatJid" | "fromMe">, ts: Date | null, now: Date): IgnoreReason | null {
  if (!isGroupJid(ev.chatJid)) return "not_group";
  if (ev.fromMe) return "from_me";
  if (!ts) return "no_timestamp";
  if (ts.getTime() < now.getTime() - WA_STALE_MS) return "stale";
  if (ts.getTime() > now.getTime() + WA_FUTURE_MS) return "future_ts";
  return null;
}

/** 編輯／撤回事件嘅時間窗（同訊息一樣 72h／未來 10 分鐘；冇 timestamp＝唔接受）。 */
function eventTsOk(ts: Date | null, now: Date): ts is Date {
  return !!ts && ts.getTime() >= now.getTime() - WA_STALE_MS && ts.getTime() <= now.getTime() + WA_FUTURE_MS;
}

/** 私訊識別碼：sha256 → 24 個純字母（無數字，保證唔會出現似電話嘅數字串）。 */
function hashJid(jid: string): string {
  const d = createHash("sha256").update(jid, "utf8").digest();
  let out = "";
  for (let i = 0; i < 24; i++) out += String.fromCharCode(97 + (d[i]! % 26));
  return `private:${out}`;
}

/** 發訊人電話 → 唯一對應嘅保安員 id（GuardPhone／Guard.tel）；零個或多個 → null（唔估）。 */
async function resolveSenderGuardId(telNorm: string | null): Promise<string | null> {
  if (!telNorm) return null;
  const variants = telLookupVariants(telNorm);
  if (variants.length === 0) return null;
  try {
    const [phones, guards] = await Promise.all([
      prisma.guardPhone.findMany({ where: { tel: { in: variants } }, select: { guardId: true } }),
      prisma.guard.findMany({ where: { tel: { in: variants } }, select: { id: true } }),
    ]);
    const ids = new Set<string>([...phones.map((p) => p.guardId), ...guards.map((g) => g.id)]);
    return ids.size === 1 ? [...ids][0]! : null;
  } catch {
    return null;
  }
}

/**
 * WA-8：工卡相——群組開咗 card_photo_mode 先處理圖片（關住＝唔拉、唔存任何圖）。喺 webhook request 內即時拉（WAHA 下載檔只留 180 秒），
 * 成功 → 加密暫存 + media_state='stored'；拉唔到（冇 url／media.error／過期／404…）→ 'expired'。失敗唔阻落庫。
 */
async function captureCardPhoto(ev: NormalizedWaEvent, now: Date): Promise<"stored" | "expired" | null> {
  if (ev.mediaType !== "image" && ev.mediaType !== "unknown") return null;
  const group = await prisma.whatsappGroup.findUnique({ where: { groupJid: ev.chatJid }, select: { cardPhotoMode: true, active: true, kind: true } });
  if (!group?.cardPhotoMode || !group.active || group.kind === "ignored" || group.kind === "office") return null;
  if (!ev.mediaUrl || ev.mediaError) return "expired";
  try {
    const r = await fetchMedia(ev.mediaUrl);
    if (!r.ok) return "expired";
    await storeMediaEvidence({ messageId: ev.messageId, chatJid: ev.chatJid, bytes: r.bytes, mime: r.mime, now });
    return "stored";
  } catch {
    return "expired";
  }
}

async function ingestMessage(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  const ts = ev.ts;
  const reason = ignoreReasonFor(ev, ts, now);
  const isPrivate = reason === "not_group";
  const telNorm = isPrivate || ev.fromMe ? null : telFromJid(ev.senderJid);
  const senderGuardId = reason ? null : await resolveSenderGuardId(telNorm);
  const mediaState = isPrivate || reason ? null : await captureCardPhoto(ev, now);
  const res = await prisma.whatsappMessage.createMany({
    data: [
      {
        id: randomUUID(),
        session: ev.session,
        chatJid: isPrivate ? hashJid(ev.chatJid) : ev.chatJid,
        // 私訊 message_id 含發訊人電話 → 以 hash 取代（unique 仍成立）
        messageId: isPrivate ? hashJid(ev.messageId) : ev.messageId,
        revision: 1,
        senderJid: isPrivate ? hashJid(ev.senderJid) : ev.senderJid,
        senderTelNorm: telNorm,
        senderGuardId,
        ts: ts ?? now,
        text: isPrivate ? "" : ev.text,
        mediaType: ev.mediaType,
        mediaState,
        quotedMessageId: isPrivate ? null : ev.quotedMessageId,
        status: reason ? "ignored" : "received",
        ignoreReason: reason,
      },
    ],
    skipDuplicates: true,
  });
  if (res.count === 0) {
    // 「編輯先到」tombstone 行：原訊息後到時補返欄位（唔改文字／狀態／revision）；撤回 tombstone 完全保持
    if (!isPrivate) {
      const filled = await prisma.whatsappMessage.updateMany({
        where: { messageId: ev.messageId, pendingEdit: true, chatJid: ev.chatJid },
        data: { senderJid: ev.senderJid, senderTelNorm: telNorm, senderGuardId, mediaType: ev.mediaType, quotedMessageId: ev.quotedMessageId },
      });
      if (filled.count > 0 && ts) {
        await prisma.whatsappGroup.updateMany({ where: { groupJid: ev.chatJid, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: ts } }] }, data: { lastMessageAt: ts } });
      }
    }
    return "duplicate";
  }
  if (!isPrivate && ts) {
    await prisma.whatsappGroup.updateMany({
      where: { groupJid: ev.chatJid, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: ts } }] },
      data: { lastMessageAt: ts },
    });
  }
  return reason ? "inserted_ignored" : "inserted";
}

interface LockedRow {
  id: string;
  revision: number;
  text: string;
  status: string;
  ignore_reason: string | null;
  revoked_at: Date | null;
  ts: Date;
  edited_at: Date | null;
  chat_jid: string;
}

const NO_REVISE_REASONS = new Set<string>(["not_group", "from_me", "no_timestamp", "stale", "future_ts"]);

async function lockRow(tx: Prisma.TransactionClient, messageId: string): Promise<LockedRow | null> {
  const rows = await tx.$queryRaw<LockedRow[]>(
    Prisma.sql`SELECT id, revision, text, status::text AS status, ignore_reason, revoked_at, ts, edited_at, chat_jid FROM whatsapp_messages WHERE message_id = ${messageId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

async function ingestEdited(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  // 空內容（WhatsApp 唔容許編輯成空訊息）、私訊、自己發出、冇／過期／未來 timestamp → no-op
  if (!ev.text || !isGroupJid(ev.chatJid) || ev.fromMe || !eventTsOk(ev.ts, now)) return "edit_noop";
  const evTs = ev.ts;
  return prisma.$transaction(async (tx) => {
    const row = await lockRow(tx, ev.messageId);
    if (!row) {
      // 編輯先於原訊息到達：寫 tombstone（received、編輯後文字、revision 1、pending_edit）；原訊息後到撞 ON CONFLICT＝no-op
      const res = await tx.whatsappMessage.createMany({
        data: [{ id: randomUUID(), session: ev.session, chatJid: ev.chatJid, messageId: ev.messageId, revision: 1, senderJid: ev.senderJid, senderTelNorm: telFromJid(ev.senderJid), ts: evTs, text: ev.text, status: "received", editedAt: evTs, pendingEdit: true }],
        skipDuplicates: true,
      });
      return res.count === 1 ? "edit_tombstone" : "edit_noop";
    }
    if (row.chat_jid !== ev.chatJid) return "chat_mismatch";
    if (row.revoked_at) return "edit_noop";
    if (row.ignore_reason && NO_REVISE_REASONS.has(row.ignore_reason)) return "edit_noop";
    if (row.text === ev.text) return "edit_noop"; // 同一編輯事件重覆投遞
    // 亂序／重放：事件時間早過該行最後一次編輯（或原訊息時間）→ 舊事件
    const base = row.edited_at ?? row.ts;
    if (evTs.getTime() < base.getTime()) return "edit_noop";
    const cur = await tx.whatsappMessage.findUniqueOrThrow({ where: { id: row.id }, select: { textHistory: true } });
    const history = Array.isArray(cur.textHistory) ? (cur.textHistory as Prisma.JsonArray) : [];
    // 唔用文字去重（合法 A→B→A 要照處理）；用編輯事件 id：已處理過嘅 event_id 再嚟 → no-op
    if (history.some((h) => typeof h === "object" && h !== null && (h as { event_id?: unknown }).event_id === ev.eventId)) return "edit_noop";
    const entry = { revision: row.revision, text: row.text, replaced_at: now.toISOString(), event_id: ev.eventId };
    await tx.whatsappMessage.update({
      where: { id: row.id },
      data: {
        revision: row.revision + 1, // revision 由 server 遞增，唔信 payload
        text: ev.text,
        textHistory: [...history, entry] as Prisma.InputJsonValue,
        status: "received",
        ignoreReason: null,
        filterScore: null,
        filterReasons: [],
        parsedJson: Prisma.DbNull,
        error: null,
        editedAt: evTs,
        redactedAt: null,
        pendingEdit: false,
        parseAttempts: 0,
      },
    });
    // W0 只標記；W1 先做 reject／supersede 同重新解析。
    await tx.whatsappIntent.updateMany({ where: { messageId: ev.messageId }, data: { sourceChanged: true } });
    return "edited";
  });
}

async function ingestRevoked(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  if (!isGroupJid(ev.chatJid) || ev.fromMe || !eventTsOk(ev.ts, now)) return "revoke_noop";
  const evTs = ev.ts;
  return prisma.$transaction(async (tx) => {
    const row = await lockRow(tx, ev.messageId);
    if (!row) {
      // 撤回先於原訊息到達：tombstone（revoked、text 空）；原訊息後到撞 ON CONFLICT 保持 revoked
      const res = await tx.whatsappMessage.createMany({
        data: [{ id: randomUUID(), session: ev.session, chatJid: ev.chatJid, messageId: ev.messageId, revision: 1, senderJid: ev.senderJid, senderTelNorm: telFromJid(ev.senderJid), ts: evTs, text: "", status: "revoked", revokedAt: now }],
        skipDuplicates: true,
      });
      return res.count === 1 ? "revoked_tombstone" : "revoke_noop";
    }
    if (row.chat_jid !== ev.chatJid) return "chat_mismatch";
    if (row.revoked_at) return "revoke_noop";
    await tx.whatsappMessage.update({ where: { id: row.id }, data: { revokedAt: now, status: "revoked" } });
    await tx.whatsappIntent.updateMany({ where: { messageId: ev.messageId }, data: { sourceChanged: true } });
    return "revoked";
  });
}

export async function ingestEvent(ev: NormalizedWaEvent, now: Date = new Date()): Promise<IngestOutcome> {
  if (ev.kind === "message") return ingestMessage(ev, now);
  if (ev.kind === "edited") return ingestEdited(ev, now);
  return ingestRevoked(ev, now);
}
