// P2.5「現場反映」開會模式——`GET /api/feedback/reports?status=`：老闆
// 睇全部意見清單（淨係老闆，`requireFeedbackAccess()`＋`assertBoss()`）。
import { prisma } from "@/lib/db";
import { requireFeedbackAccess, assertBoss } from "@/lib/feedback/guard";
import { ok, withApiError } from "@/lib/api/http";
import { paginationParams } from "@/lib/api/query";
import { toFeedbackReportDTO, mapListDTO } from "@/lib/api/dto";
import { BadRequest } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

const VALID_STATUSES = ["new", "read", "forwarded", "declined"] as const;

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    assertBoss(session);

    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const status = url.searchParams.get("status");
    if (status !== null && !(VALID_STATUSES as readonly string[]).includes(status)) {
      throw BadRequest(`status 要係 ${VALID_STATUSES.join("/")} 其中一個`);
    }
    const where: Prisma.FeedbackReportWhereInput = status ? { status } : {};

    const [rows, total] = await Promise.all([
      prisma.feedbackReport.findMany({ where, skip, take, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }),
      prisma.feedbackReport.count({ where }),
    ]);

    return ok(mapListDTO({ rows, total, skip, take }, toFeedbackReportDTO));
  });
}
