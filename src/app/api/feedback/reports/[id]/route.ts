// P2.5「現場反映」開會模式——`GET /api/feedback/reports/[id]`（老闆，或
// 作者本人睇自己送出嗰份）／`PATCH /api/feedback/reports/[id]`（老闆改
// status＋備註）。
import { prisma } from "@/lib/db";
import { requireFeedbackAccess, assertBoss } from "@/lib/feedback/guard";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { toFeedbackReportDTO } from "@/lib/api/dto";
import { NotFound } from "@/lib/api/errors";
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
    // Opus 驗收應修③——非作者非老闆一律 404（唔准用 403／404 分辨
    // 「呢個 id 存唔存在」——如果 row 存在但唔係呢個人嘅、又冇老闆
    // 權，都照樣掉 NotFound，同「呢個 id 根本唔存在」睇落一模一樣，
    // 防止逐個 id 掃就可以摸到幾多份意見/邊啲 id 真係存在）。
    if (!row || (session.baseRole !== "老闆" && row.userId !== session.userId)) {
      throw NotFound();
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
