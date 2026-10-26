// WA-8：`GET /api/whatsapp/media/:id`——回工卡相（解密後 image/jpeg｜png）。
// 驗：要「導入分診:view」＋「保安員:view」＋「更表:create」（同答 WA 題一樣）→ 圖必須屬於一條 **仍然 open** 嘅 WhatsApp 分診題
// （evidence.card.media_id）→ 該題 session 擁有人／老闆。no-store、nosniff；睇圖只寫計數 audit（唔含任何值）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { canAccessOwnedBy } from "@/lib/triage/session";
import { waCaps } from "@/lib/whatsapp/triage-answer";
import { loadMediaEvidenceById } from "@/lib/whatsapp/media";
import { Forbidden, NotFound } from "@/lib/api/errors";
import { getClientIp, withApiError } from "@/lib/api/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const caps = await waCaps(actor);
    if (!caps.canSee || !caps.canWrite) throw Forbidden("要有保安員查看＋更表新增權限嘅同事先可以睇工卡相");
    const { id } = await params;
    const qs = await prisma.$queryRaw<{ id: string; session_id: string; owner: string }[]>`
      SELECT q.id, q.session_id, s.owner_user_id AS owner
      FROM triage_questions q JOIN triage_sessions s ON s.id = q.session_id
      WHERE s.source_type = 'whatsapp' AND q.status = 'open' AND q.evidence_json->'card'->>'media_id' = ${id}
      LIMIT 5`;
    let q: (typeof qs)[number] | undefined;
    for (const x of qs) if (await canAccessOwnedBy(actor, x.owner)) q = x;
    if (!q) throw NotFound("搵唔到呢張相");
    const img = await loadMediaEvidenceById(id);
    if (!img) throw NotFound("搵唔到呢張相");
    await writeAudit({ actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_evidence_view", after: { session_id: q.session_id, images: 1, source: "whatsapp_card" }, ip: getClientIp(req) });
    return new NextResponse(new Uint8Array(img.bytes), {
      status: 200,
      headers: { "content-type": img.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-length": String(img.bytes.length) },
    });
  });
}
