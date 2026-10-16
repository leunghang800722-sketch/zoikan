// W1：GET /api/whatsapp/intents?group=&from=&to=&routed=&take=——dry-run 解析結果清單（view 權）。
// 原話＋姓名只喺有「保安員」view 權時回傳（同 W0 messages API 一致）；resolution 只含原因碼／id，唔含原文。
// 每條附「實際排更」對照（✓／✗／—）。唔寫任何資料。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, withApiError } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { compareIntents } from "@/lib/whatsapp/compare";
import { parseRange, resolveGroupJid } from "@/lib/whatsapp/stats";
import type { Prisma } from "@prisma/client";

const ROUTED = ["auto_write", "triage", "ignored", "pending"] as const;
const MAX_TAKE = 200;

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "view");
    const url = new URL(req.url);
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
    const routed = url.searchParams.get("routed");
    if (routed && !(ROUTED as readonly string[]).includes(routed)) throw BadRequest("routed 唔啱");
    const takeRaw = Number(url.searchParams.get("take"));
    const take = Number.isFinite(takeRaw) && takeRaw >= 1 ? Math.min(Math.floor(takeRaw), MAX_TAKE) : MAX_TAKE;
    const jid = await resolveGroupJid(url.searchParams.get("group"));
    const where: Prisma.WhatsappIntentWhereInput = {
      message: { ts: { gte: range.start, lt: range.end }, ...(jid ? { chatJid: jid } : {}) },
      ...(routed ? { routed: routed as (typeof ROUTED)[number] } : {}),
    };
    const showNames = await hasPermission(actor, "安員", "view");
    const rows = await prisma.whatsappIntent.findMany({
      where,
      orderBy: [{ message: { ts: "desc" } }, { messageId: "asc" }, { idx: "asc" }],
      take,
      include: { message: { select: { ts: true, chatJid: true, text: true, redactedAt: true, revision: true, senderTelNorm: true, senderGuard: { select: { nameZh: true } } } } },
    });
    const jids = [...new Set(rows.map((r) => r.message.chatJid))];
    const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is string => !!x))];
    const guardIds = [...new Set(rows.map((r) => r.guardId).filter((x): x is string => !!x))];
    const shiftTypeIds = [...new Set(rows.map((r) => r.shiftTypeId).filter((x): x is string => !!x))];
    const [groups, sites, guards, types] = await Promise.all([
      prisma.whatsappGroup.findMany({ where: { groupJid: { in: jids } }, select: { id: true, groupJid: true, label: true } }),
      prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }),
      showNames ? prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, nameZh: true } }) : Promise.resolve([]),
      prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } }, select: { id: true, code: true } }),
    ]);
    const gBy = new Map(groups.map((g) => [g.groupJid, g]));
    const siteBy = new Map(sites.map((s) => [s.id, s.canonicalName]));
    const guardBy = new Map(guards.map((g) => [g.id, g.nameZh]));
    const typeBy = new Map(types.map((t) => [t.id, t.code]));
    const cmp = await compareIntents(rows.map((r) => ({ id: r.id, kind: r.kind, guardId: r.guardId, workDate: r.workDate ? r.workDate.toISOString().slice(0, 10) : null, shiftTypeId: r.shiftTypeId, leaveCode: r.leaveCode })));
    const out = rows.map((r) => {
      const m = r.message;
      const res = (r.resolution ?? {}) as { reasons?: unknown; notes?: unknown; basis?: unknown; candidates?: unknown; group_auto_write?: unknown; replaced_guard_id?: unknown };
      const g = gBy.get(m.chatJid);
      const tail = m.senderTelNorm ? m.senderTelNorm.slice(-4) : null;
      const c = cmp.get(r.id);
      return brandSafeResponse({
        id: r.id,
        message_ts: m.ts.toISOString(),
        group_id: g?.id ?? null,
        group_label: g?.label || "（未命名）",
        sender: showNames && m.senderGuard ? m.senderGuard.nameZh : tail ? `…${tail}` : "未知",
        text: showNames ? (m.redactedAt ? null : m.text) : null,
        text_redacted: m.redactedAt !== null,
        revision: r.messageRevision,
        kind: r.kind,
        work_date: r.workDate ? r.workDate.toISOString().slice(0, 10) : null,
        site_id: r.siteId,
        site_name: r.siteId ? (siteBy.get(r.siteId) ?? null) : null,
        guard_id: showNames ? r.guardId : null,
        guard_name: showNames && r.guardId ? (guardBy.get(r.guardId) ?? null) : null,
        has_guard: r.guardId !== null,
        shift_code: r.shiftTypeId ? (typeBy.get(r.shiftTypeId) ?? null) : null,
        leave_code: r.leaveCode,
        confidence: r.confidence === null ? null : Number(r.confidence),
        routed: r.routed,
        reasons: Array.isArray(res.reasons) ? res.reasons : [],
        notes: Array.isArray(res.notes) ? res.notes : [],
        candidate_counts: summarizeCandidates(res.candidates),
        group_auto_write: res.group_auto_write === true,
        superseded: r.supersededByRevision !== null,
        revoked: r.revokedAt !== null,
        source_changed: r.sourceChanged,
        compare: c?.status ?? null,
        actual: c?.actual ?? [],
      });
    });
    return ok(brandSafeResponse({ rows: out, total: out.length, take, from: range.fromIso, to: range.toIso, can_see_text: showNames }));
  });
}

function summarizeCandidates(c: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (c && typeof c === "object") {
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}
