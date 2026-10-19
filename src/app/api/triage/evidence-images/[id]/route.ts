// TE-1：`GET /api/triage/evidence-images/:id`——回單張覆核證據裁圖（解密後 image/jpeg｜png）。
// 驗：image → session → owner（老闆／擁有人）→ 欄位權限（M3）→ 仍有 open／skipped 題需要該欄而且讀者答得到。
// no-store、nosniff（M9）；睇圖寫只計數 audit（S3）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { canAccessOwnedBy, restrictedKindsFor } from "@/lib/triage/session";
import { EVIDENCE_FIELDS, EVIDENCE_META_SELECT, canViewField, loadImageBytes, requiredFieldsFor, type EvidenceField } from "@/lib/triage/evidence-images";
import { Forbidden, NotFound } from "@/lib/api/errors";
import { getClientIp, withApiError } from "@/lib/api/http";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const { id } = await params;
    const meta = await prisma.triageEvidenceImage.findUnique({ where: { id }, select: EVIDENCE_META_SELECT });
    if (!meta || meta.withdrawnAt) throw NotFound("搵唔到呢張圖");
    const session = await prisma.triageSession.findUnique({ where: { id: meta.sessionId }, select: { ownerUserId: true } });
    if (!session || !(await canAccessOwnedBy(actor, session.ownerUserId))) throw Forbidden("呢張圖唔係你上載嗰批");
    const field = meta.field as EvidenceField;
    if (!(EVIDENCE_FIELDS as readonly string[]).includes(field) || !(await canViewField(actor, field))) throw Forbidden("冇權限睇呢個欄位嘅證據圖");
    const restricted = new Set(await restrictedKindsFor(actor));
    const qs = await prisma.triageQuestion.findMany({ where: { sessionId: meta.sessionId, personKey: meta.personKey, status: { in: ["open", "skipped"] } }, select: { id: true, kind: true, evidenceJson: true } });
    const q = qs.find((x) => !restricted.has(x.kind) && requiredFieldsFor(x).includes(field));
    if (!q) throw NotFound("搵唔到呢張圖"); // 已冇題需要（理論上已刪）或讀者答唔到
    const img = await loadImageBytes(id);
    if (!img) throw NotFound("搵唔到呢張圖");
    await writeAudit({ actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_evidence_view", after: { session_id: meta.sessionId, images: 1 }, ip: getClientIp(req) });
    return new NextResponse(new Uint8Array(img.bytes), {
      status: 200,
      headers: { "content-type": img.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-length": String(img.bytes.length) },
    });
  });
}
