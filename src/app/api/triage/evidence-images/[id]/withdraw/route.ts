// TE-8：`POST /api/triage/evidence-images/:id/withdraw`——覆核人標記「呢張圖錯／唔相關」，軟刪（清空 bytes、DTO 唔再回；重上載同 sha 計 skipped_withdrawn）。
// 權限：「導入分診:update」＋ owner／擁有人 ＋ 可睇該欄 ＋ 仍有 open／skipped 題需要該欄（同 GET 一樣）。audit 只記圖 id／欄／來源／原因碼，唔記值。
import { z } from "zod";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { canAccessOwnedBy, restrictedKindsFor } from "@/lib/triage/session";
import { EVIDENCE_FIELDS, EVIDENCE_META_SELECT, canViewField, requiredFieldsFor, withdrawImages, type EvidenceField } from "@/lib/triage/evidence-images";
import { BadRequest, Forbidden, NotFound } from "@/lib/api/errors";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { brandSafeResponse } from "@/lib/api/serialize";

const bodySchema = z.object({ reason: z.enum(["wrong", "unrelated"]) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const body = bodySchema.safeParse(await readJson(req));
    if (!body.success) throw BadRequest("原因格式唔啱");
    const meta = await prisma.triageEvidenceImage.findUnique({ where: { id }, select: EVIDENCE_META_SELECT });
    if (!meta || meta.withdrawnAt) throw NotFound("搵唔到呢張圖");
    const session = await prisma.triageSession.findUnique({ where: { id: meta.sessionId }, select: { ownerUserId: true } });
    if (!session || !(await canAccessOwnedBy(actor, session.ownerUserId))) throw Forbidden("呢張圖唔係你上載嗰批");
    const field = meta.field as EvidenceField;
    if (!(EVIDENCE_FIELDS as readonly string[]).includes(field) || !(await canViewField(actor, field))) throw Forbidden("冇權限處理呢個欄位嘅證據圖");
    const restricted = new Set(await restrictedKindsFor(actor));
    const qs = await prisma.triageQuestion.findMany({ where: { sessionId: meta.sessionId, personKey: meta.personKey, status: { in: ["open", "skipped"] } }, select: { id: true, kind: true, evidenceJson: true } });
    const q = qs.find((x) => !restricted.has(x.kind) && requiredFieldsFor(x).includes(field));
    if (!q) throw NotFound("搵唔到呢張圖");
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const n = await withdrawImages(tx, { id }, body.data.reason, now);
      if (n > 0) await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_questions", rowId: q.id, action: "triage_evidence_withdraw", after: { session_id: meta.sessionId, image_id: id, field, doc_kind: meta.docKind, reason: body.data.reason }, ip: getClientIp(req) });
    });
    return ok(brandSafeResponse({ withdrawn: true }));
  });
}
