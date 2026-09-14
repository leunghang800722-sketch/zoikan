// P2.5「現場反映」開會模式——`GET /api/feedback/reports/[id]`（老闆，或
// 作者本人睇自己送出嗰份）／`PATCH /api/feedback/reports/[id]`（老闆改
// status＋備註）。
import { prisma } from "@/lib/db";
import { requireFeedbackAccess, assertBoss } from "@/lib/feedback/guard";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { toFeedbackReportDTO } from "@/lib/api/dto";
import { Forbidden, NotFound } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { z } from "zod";

const VALID_STATUSES = ["new", "read", "forwarded", "declined"] as const;

const PatchSchema = z
  .object({
    status: z.enum(VALID_STATUSES),
    review_note: z.string().max(2000).optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    const { id } = await params;
    const row = await prisma.feedbackReport.findUnique({ where: { id } });
    if (!row) throw NotFound();
    // 老闆全睇；主管/會計淨係睇自己送出嗰份——防止跨用戶偷睇他人意見。
    if (session.baseRole !== "老闆" && row.userId !== session.userId) {
      throw Forbidden("你冇權睇呢份意見");
    }
    return ok(toFeedbackReportDTO(row));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    assertBoss(session);
    const { id } = await params;
    const ip = getClientIp(req);
    const before = await prisma.feedbackReport.findUnique({ where: { id } });
    if (!before) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(PatchSchema, body);

    const after = await prisma.feedbackReport.update({
      where: { id },
      data: {
        status: parsed.status,
        reviewNote: parsed.review_note ?? before.reviewNote,
        reviewedBy: session.userId,
        reviewedAt: new Date(),
      },
    });

    await writeAudit({ actorUserId: session.userId, tableName: "feedback_reports", rowId: id, action: "update", before, after, ip });

    return ok(toFeedbackReportDTO(after));
  });
}
