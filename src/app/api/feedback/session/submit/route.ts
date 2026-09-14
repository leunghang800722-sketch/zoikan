// P2.5「現場反映」開會模式——`POST /api/feedback/session/submit`：用戶
// 喺預覽面板確認（可能編輯過）之後，**由伺服器 code（唔係模型工具）**
// 寫入 `feedback_reports`。`reporter`／`footer`／`summary_md` 一律伺服器
// 重新計算（唔信任 client 傳嚟嘅版本）——避免用戶側竄改「未評估可行性」
// 嗰句 footer，或者假冒 reporter 身份。
import { requireFeedbackAccess } from "@/lib/feedback/guard";
import { prisma } from "@/lib/db";
import { ApiError, NotFound, BadRequest } from "@/lib/api/errors";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { writeAudit } from "@/lib/audit";
import { z } from "zod";
import { getSessionForUser, markSessionStatus, messagesOf, countSubmittedReportsToday } from "@/lib/feedback/session";
import { toFeedbackReportDTO } from "@/lib/api/dto";
import {
  EDITABLE_FIELD_KEYS,
  FEEDBACK_FOOTER,
  MAX_REPORTS_PER_DAY,
  buildReporterLine,
  buildSummaryMarkdown,
  lastNTurns,
  validateFieldLengths,
  type EditableFields,
  type FeedbackFields,
} from "@/lib/feedback/report";
import { todayLocalStr } from "@/lib/ui/format";

const FieldsSchema = z
  .object({
    title: z.string().min(1, "標題唔可以係空").max(2000),
    current_problem: z.string().max(2000),
    desired_change: z.string().max(2000),
    reason: z.string().max(2000),
    related: z.string().max(2000),
    open_questions: z.string().max(2000),
  })
  .strict();

const SubmitRequestSchema = z.object({ session_id: z.string().min(1), fields: FieldsSchema }).strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requireFeedbackAccess(req);
    const ip = getClientIp(req);
    const body = await readJson(req);
    const parsed = parseBody(SubmitRequestSchema, body);

    const feedbackSession = await getSessionForUser(parsed.session_id, session.userId);
    if (!feedbackSession || feedbackSession.status !== "draft") throw NotFound("呢個開會 session 唔存在或者已經結束");

    const editable = parsed.fields as EditableFields;
    for (const key of EDITABLE_FIELD_KEYS) {
      if (!(key in editable)) throw BadRequest(`缺少欄位「${key}」`);
    }
    const lengthError = validateFieldLengths(editable);
    if (lengthError) throw BadRequest(lengthError);

    const submittedToday = await countSubmittedReportsToday(session.userId);
    if (submittedToday >= MAX_REPORTS_PER_DAY) {
      throw new ApiError(429, "feedback_daily_limit", `今日已經送出咗 ${submittedToday} 份意見，上限 ${MAX_REPORTS_PER_DAY} 份，聽日再嚟啦。`);
    }

    const fields: FeedbackFields = {
      ...editable,
      reporter: buildReporterLine({
        name: session.name,
        roleName: session.roleName,
        dateStr: todayLocalStr(),
        path: (feedbackSession.pageContext as { path?: string } | null)?.path,
      }),
      footer: FEEDBACK_FOOTER,
    };
    const summaryMd = buildSummaryMarkdown(fields);
    const transcriptExcerpt = lastNTurns(messagesOf(feedbackSession), 20);

    const report = await prisma.feedbackReport.create({
      data: {
        sessionId: feedbackSession.id,
        userId: session.userId,
        roleName: session.roleName,
        title: fields.title,
        summaryMd,
        fields: JSON.parse(JSON.stringify(fields)),
        transcriptExcerpt: JSON.parse(JSON.stringify(transcriptExcerpt)),
        status: "new",
      },
    });
    await markSessionStatus(feedbackSession.id, "submitted");

    await writeAudit({
      actorUserId: session.userId,
      tableName: "feedback_reports",
      rowId: report.id,
      action: "feedback_submit",
      after: { session_id: feedbackSession.id, title: fields.title, role_name: session.roleName },
      ip,
    });

    return ok(toFeedbackReportDTO(report));
  });
}
