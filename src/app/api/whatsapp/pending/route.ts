// W3：GET /api/whatsapp/pending?group=&take=——來源 WhatsApp、仍待批核（pending_approval）嘅排更記錄清單。
// 權限：「WhatsApp 報更」view；原話／姓名要「保安員」view；can_approve＝有「審批」update（前端先顯示批核／退回掣，
// 實際批核仍走現有 /api/shift-records/[id]/approve｜reject，權限、鎖月、計價補算照舊）。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { waRecordInfos } from "@/lib/whatsapp/records";
import { resolveGroupJid } from "@/lib/whatsapp/stats";
import type { Prisma } from "@prisma/client";

const MAX_TAKE = 200;

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "view");
    const url = new URL(req.url);
    const takeRaw = Number(url.searchParams.get("take"));
    const take = Number.isFinite(takeRaw) && takeRaw >= 1 ? Math.min(Math.floor(takeRaw), MAX_TAKE) : MAX_TAKE;
    const jid = await resolveGroupJid(url.searchParams.get("group"));
    const where: Prisma.ShiftRecordWhereInput = { source: "whatsapp", status: "pending_approval" };
    if (jid) {
      const ids = await prisma.$queryRaw<{ id: string }[]>`
        SELECT sr.id FROM shift_records sr JOIN whatsapp_messages m ON m.message_id = sr.provenance->>'message_id'
        WHERE sr.source = 'whatsapp' AND sr.status = 'pending_approval' AND m.chat_jid = ${jid}`;
      where.id = { in: ids.map((x) => x.id) };
    }
    const [canSee, canApprove] = await Promise.all([hasPermission(actor, "安員", "view"), hasPermission(actor, "審批", "update")]);
    const [total, recs] = await Promise.all([
      prisma.shiftRecord.count({ where }),
      prisma.shiftRecord.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        select: { id: true, workDate: true, recordType: true, leaveCode: true, guardId: true, siteId: true, createdAt: true, provenance: true, shiftType: { select: { code: true } }, site: { select: { canonicalName: true } }, guard: { select: { nameZh: true } } },
      }),
    ]);
    const infos = await waRecordInfos(recs, canSee);
    const rows = recs.map((r) => {
      const i = infos.get(r.id)!;
      return brandSafeResponse({
        id: r.id,
        created_at: r.createdAt.toISOString(),
        message_ts: i.message_ts,
        group_label: i.group_label,
        sender: i.sender,
        site_name: r.site.canonicalName,
        work_date: r.workDate.toISOString().slice(0, 10),
        record_type: r.recordType,
        code: r.recordType === "leave" ? (r.leaveCode ?? "?") : r.shiftType.code,
        guard_name: canSee ? r.guard.nameZh : null,
        text: i.text,
        text_redacted: i.text_redacted,
        source_changed: i.source_changed,
        revoked: i.revoked,
      });
    });
    return ok(brandSafeResponse({ rows, total, take, can_see_text: canSee, can_approve: canApprove }));
  });
}
