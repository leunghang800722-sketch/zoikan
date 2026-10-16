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

export type IngestOutcome =
  | "inserted"
  | "inserted_ignored"
  | "duplicate"
  | "edited"
  | "edit_noop"
  | "revoked"
  | "revoke_noop"
  | "unknown_target";

export type IgnoreReason = "not_group" | "from_me" | "stale" | "future_ts";

export function ignoreReasonFor(ev: Pick<NormalizedWaEvent, "chatJid" | "fromMe">, ts: Date, now: Date): IgnoreReason | null {
  if (!isGroupJid(ev.chatJid)) return "not_group";
  if (ev.fromMe) return "from_me";
  if (ts.getTime() < now.getTime() - WA_STALE_MS) return "stale";
  if (ts.getTime() > now.getTime() + WA_FUTURE_MS) return "future_ts";
  return null;
}

function hashJid(jid: string): string {
  return `private:${createHash("sha256").update(jid, "utf8").digest("hex").slice(0, 16)}`;
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

async function ingestMessage(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  const ts = ev.ts ?? now;
  const reason = ignoreReasonFor(ev, ts, now);
  const isPrivate = reason === "not_group";
  const telNorm = isPrivate || ev.fromMe ? null : telFromJid(ev.senderJid);
  const senderGuardId = reason ? null : await resolveSenderGuardId(telNorm);
  const res = await prisma.whatsappMessage.createMany({
    data: [
      {
        id: randomUUID(),
        session: ev.session,
        chatJid: isPrivate ? hashJid(ev.chatJid) : ev.chatJid,
        messageId: ev.messageId,
        revision: 1,
        senderJid: isPrivate ? hashJid(ev.senderJid) : ev.senderJid,
        senderTelNorm: telNorm,
        senderGuardId,
        ts,
        text: isPrivate ? "" : ev.text,
        mediaType: ev.mediaType,
        quotedMessageId: isPrivate ? null : ev.quotedMessageId,
        status: reason ? "ignored" : "received",
        ignoreReason: reason,
      },
    ],
    skipDuplicates: true,
  });
  if (res.count === 0) return "duplicate";
  if (!isPrivate) {
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
}

const NO_REVISE_REASONS = new Set<string>(["not_group", "from_me", "stale", "future_ts"]);

async function lockRow(tx: Prisma.TransactionClient, messageId: string): Promise<LockedRow | null> {
  const rows = await tx.$queryRaw<LockedRow[]>(
    Prisma.sql`SELECT id, revision, text, status::text AS status, ignore_reason, revoked_at FROM whatsapp_messages WHERE message_id = ${messageId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

async function ingestEdited(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  // 編輯事件冇內容（空字串）→ 無法修訂，當 no-op（WhatsApp 唔容許編輯成空訊息）。
  if (!ev.text) return "edit_noop";
  return prisma.$transaction(async (tx) => {
    const row = await lockRow(tx, ev.messageId);
    if (!row) return "unknown_target"; // 冇收過原訊息：保守唔補建（不明群／時間）
    if (row.revoked_at) return "edit_noop";
    if (row.ignore_reason && NO_REVISE_REASONS.has(row.ignore_reason)) return "edit_noop";
    if (row.text === ev.text) return "edit_noop"; // 同一編輯事件重覆投遞
    const cur = await tx.whatsappMessage.findUniqueOrThrow({ where: { id: row.id }, select: { textHistory: true } });
    const history = Array.isArray(cur.textHistory) ? (cur.textHistory as Prisma.JsonArray) : [];
    const entry = { revision: row.revision, text: row.text, replaced_at: now.toISOString() };
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
        editedAt: now,
        redactedAt: null,
      },
    });
    // W0 只標記；W1 先做 reject／supersede 同重新解析。
    await tx.whatsappIntent.updateMany({ where: { messageId: ev.messageId }, data: { sourceChanged: true } });
    return "edited";
  });
}

async function ingestRevoked(ev: NormalizedWaEvent, now: Date): Promise<IngestOutcome> {
  return prisma.$transaction(async (tx) => {
    const row = await lockRow(tx, ev.messageId);
    if (!row) return "unknown_target";
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
