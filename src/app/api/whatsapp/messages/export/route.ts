// WA-9 (0)：GET /api/whatsapp/messages/export?from=YYYY-MM-DD&to=YYYY-MM-DD&group=<id|jid?>&status=<csv?>
// **老闆專用**（assertBossOnly）：匯出過去訊息原文，用嚟做「文字名單偵測」等過濾規則嘅真值集（老闆已登入 Chrome 取，唔使逐條抄）。
// 回 JSON 陣列 {id, group_label, hk_date, ts, status, ignore_reason, filter_reasons, media_type, sender, text}；
// sender 只係保安員姓名（已配對）或電話尾 4 位，**唔回完整電話／jid**。範圍 ≤62 日（香港日，含頭尾）、上限 2,000 條（超出 header x-truncated: 1）。
// 寫一條 audit（whatsapp_messages_export，只記範圍＋計數，唔記內容）。
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/rbac/requirePermission";
import { assertBossOnly } from "@/lib/jobs/admin";
import { BadRequest } from "@/lib/api/errors";
import { getClientIp, withApiError } from "@/lib/api/http";
import { addDays, hkDateOf } from "@/lib/whatsapp/dates";

const MAX_ROWS = 2000;
const MAX_DAYS = 62;
const STATUSES = ["received", "filtered", "parsed", "routed", "done", "ignored", "error", "revoked"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayNum = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    const url = new URL(req.url);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!ISO.test(from) || !ISO.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) throw BadRequest("from／to 要係 YYYY-MM-DD");
    if (dayNum(to) < dayNum(from)) throw BadRequest("to 唔可以早過 from");
    if (dayNum(to) - dayNum(from) + 1 > MAX_DAYS) throw BadRequest(`範圍最多 ${MAX_DAYS} 日`);
    const statusCsv = url.searchParams.get("status");
    const statuses = statusCsv ? statusCsv.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (statuses.some((s) => !(STATUSES as readonly string[]).includes(s))) throw BadRequest("status 唔啱");
    const where: Prisma.WhatsappMessageWhereInput = { ts: { gte: new Date(`${from}T00:00:00+08:00`), lt: new Date(`${addDays(to, 1)}T00:00:00+08:00`) } };
    if (statuses.length > 0) where.status = { in: statuses as (typeof STATUSES)[number][] };
    const group = url.searchParams.get("group");
    if (group) {
      const g = await prisma.whatsappGroup.findFirst({ where: { OR: [{ id: group }, { groupJid: group }] }, select: { groupJid: true } });
      where.chatJid = g?.groupJid ?? group;
    }
    const rows = await prisma.whatsappMessage.findMany({
      where,
      orderBy: [{ ts: "asc" }, { id: "asc" }],
      take: MAX_ROWS + 1,
      select: { id: true, chatJid: true, ts: true, status: true, ignoreReason: true, filterReasons: true, mediaType: true, senderTelNorm: true, text: true, senderGuard: { select: { nameZh: true } } },
    });
    const truncated = rows.length > MAX_ROWS;
    const page = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const groups = await prisma.whatsappGroup.findMany({ where: { groupJid: { in: [...new Set(page.map((r) => r.chatJid))] } }, select: { groupJid: true, label: true } });
    const label = new Map(groups.map((g) => [g.groupJid, g.label || "（未命名）"]));
    const out = page.map((r) => ({
      id: r.id,
      group_label: label.get(r.chatJid) ?? "（未同步群組）",
      hk_date: hkDateOf(r.ts),
      ts: r.ts.toISOString(),
      status: r.status,
      ignore_reason: r.ignoreReason,
      filter_reasons: Array.isArray(r.filterReasons) ? (r.filterReasons as unknown[]).filter((x): x is string => typeof x === "string") : [],
      media_type: r.mediaType,
      sender: r.senderGuard?.nameZh ?? (r.senderTelNorm ? `…${r.senderTelNorm.slice(-4)}` : "未知"),
      text: r.text,
    }));
    await writeAudit({
      actorUserId: session.userId,
      tableName: "whatsapp_messages",
      rowId: "export",
      action: "whatsapp_messages_export",
      after: { from, to, group: group ? true : false, statuses: statuses.length ? statuses : null, count: out.length, truncated },
      ip: getClientIp(req),
    });
    return NextResponse.json(out, { status: 200, headers: { "cache-control": "no-store", ...(truncated ? { "x-truncated": "1" } : {}) } });
  });
}
