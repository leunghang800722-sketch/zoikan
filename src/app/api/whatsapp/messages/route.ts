// W0：GET /api/whatsapp/messages?group=&status=&take=——最近訊息清單（view 權；take 預設／上限 200）。
// 不回傳訊息原文、WAHA message_id（含發訊人電話）、完整電話；發訊人顯示：有「保安員」view 權→ 保安員姓名，否則電話尾 4 位。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, withApiError } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import type { Prisma } from "@prisma/client";
import { hkDateOf } from "@/lib/whatsapp/dates";

const STATUSES = ["received", "filtered", "parsed", "routed", "done", "ignored", "error", "revoked"] as const;
type Status = (typeof STATUSES)[number];
const MAX_TAKE = 200;

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "view");
    const url = new URL(req.url);
    const takeRaw = Number(url.searchParams.get("take"));
    const take = Number.isFinite(takeRaw) && takeRaw >= 1 ? Math.min(Math.floor(takeRaw), MAX_TAKE) : MAX_TAKE;
    const status = url.searchParams.get("status");
    if (status && !(STATUSES as readonly string[]).includes(status)) throw BadRequest("status 唔啱");
    const where: Prisma.WhatsappMessageWhereInput = {};
    if (status) where.status = status as Status;
    const group = url.searchParams.get("group");
    if (group) {
      const g = await prisma.whatsappGroup.findFirst({ where: { OR: [{ id: group }, { groupJid: group }] }, select: { groupJid: true } });
      where.chatJid = g?.groupJid ?? group;
    }
    const showNames = await hasPermission(actor, "安員", "view");
    const rows = await prisma.whatsappMessage.findMany({
      where,
      orderBy: [{ ts: "desc" }, { id: "asc" }],
      take,
      select: {
        id: true, chatJid: true, ts: true, status: true, ignoreReason: true, filterScore: true, filterReasons: true, revision: true, editedAt: true, revokedAt: true,
        redactedAt: true, mediaType: true, senderTelNorm: true, text: true, senderGuard: { select: { nameZh: true } },
      },
    });
    const jids = [...new Set(rows.map((r) => r.chatJid))];
    const groups = await prisma.whatsappGroup.findMany({ where: { groupJid: { in: jids } }, select: { id: true, groupJid: true, label: true } });
    const gBy = new Map(groups.map((g) => [g.groupJid, g]));
    // WA-7：分流行 →「去答題」：session（sourceType whatsapp、sourceRef `<group_jid>:<YYYY-MM>`，月＝訊息香港日所屬月）；冇「導入分診」view 權就唔回 id
    const refOf = (r: { chatJid: string; ts: Date }) => `${r.chatJid}:${hkDateOf(r.ts).slice(0, 7)}`;
    const routedRefs = [...new Set(rows.filter((r) => r.status === "routed").map(refOf))];
    const canTriage = routedRefs.length > 0 && (await hasPermission(actor, "導入分診", "view"));
    const sessions = canTriage ? await prisma.triageSession.findMany({ where: { sourceType: "whatsapp", sourceRef: { in: routedRefs } }, select: { id: true, sourceRef: true } }) : [];
    const sBy = new Map(sessions.map((s) => [s.sourceRef, s.id]));
    const out = rows.map((r) => {
      const tail = r.senderTelNorm ? r.senderTelNorm.slice(-4) : null;
      const sender = showNames && r.senderGuard ? r.senderGuard.nameZh : tail ? `…${tail}` : "未知";
      const g = gBy.get(r.chatJid);
      return brandSafeResponse({
        id: r.id,
        ts: r.ts.toISOString(),
        group_id: g?.id ?? null,
        group_label: g?.label || (g ? "（未命名）" : r.chatJid.startsWith("private:") ? "（私訊，不處理）" : "（未同步群組）"),
        sender,
        status: r.status,
        ignore_reason: r.ignoreReason,
        filter_reasons: Array.isArray(r.filterReasons) ? (r.filterReasons as unknown[]).filter((x): x is string => typeof x === "string") : [],
        triage_session_id: r.status === "routed" ? (sBy.get(refOf(r)) ?? null) : null,
        filter_score: r.filterScore,
        revision: r.revision,
        edited: r.editedAt !== null,
        revoked: r.revokedAt !== null,
        redacted: r.redactedAt !== null,
        media_type: r.mediaType,
        text_len: r.text.length,
      });
    });
    return ok(brandSafeResponse({ rows: out, total: out.length, take }));
  });
}
