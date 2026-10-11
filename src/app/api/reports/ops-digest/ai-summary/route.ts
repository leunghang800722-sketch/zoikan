// WP-AI-OPS §28.2：`POST /api/reports/ops-digest/ai-summary` body `{ month }`
// （`月結總表:view`）——將 PII-free digest JSON 交現有 AI provider 出一段文字。
// AI 未設定（冇 key）→ 404 `ai_not_configured`（前端本身已隱藏掣）。
// 每日上限同助手共用（寫一行 `ai_chat` audit 令額度計到）。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError, getClientIp } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ApiError } from "@/lib/api/errors";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { parseMonthParam } from "@/lib/reports/money";
import { hkMonthStart } from "@/lib/dates";
import { isAiConfigured } from "@/lib/ai/config";
import { getLlmClient, LlmUnavailableError } from "@/lib/ai/llm";
import { assertUnderDailyLimit, releaseDailySlot } from "@/lib/ai-rate-limit";
import { writeAudit } from "@/lib/audit";
import { buildOpsDigest, addMonths } from "@/lib/ops/digest";
import { generateDigestSummary } from "@/lib/ops/ai-summary";

const BodySchema = z.object({ month: z.string().max(10).optional() }).strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    if (!isAiConfigured()) throw new ApiError(404, "ai_not_configured", "AI 未設定");
    const body = parseBody(BodySchema, await readJson(req));
    const month = parseMonthParam(body.month ?? null) ?? addMonths(hkMonthStart(), -1);

    const { used, limit } = await assertUnderDailyLimit(session.userId);
    if (used >= limit) throw new ApiError(429, "rate_limited", `今日已經用咗 ${used} 次 AI，上限 ${limit} 次，聽日再嚟啦。`);

    let client;
    try {
      client = getLlmClient();
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        await releaseDailySlot(session.userId);
        throw new ApiError(503, "ai_provider_unavailable", err.message);
      }
      throw err;
    }

    const digest = await buildOpsDigest(month, session);
    let result;
    try {
      result = await generateDigestSummary(digest, client);
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        await releaseDailySlot(session.userId);
        throw new ApiError(503, "ai_provider_unavailable", err.message);
      }
      throw err;
    }
    // 令呢次計入共用每日額度（`AI_QUOTA_ACTIONS` 睇 ai_chat／ai_chat）；after 淨係 meta，冇 digest 內容。
    await writeAudit({
      actorUserId: session.userId,
      tableName: "ai_chat",
      rowId: session.userId,
      action: "ai_chat",
      after: { source: "ops_digest", month: digest.month, input_tokens: result.inputTokens, output_tokens: result.outputTokens, guard_triggered: result.guardTriggered },
      ip: getClientIp(req),
    });
    return ok(brandSafeResponse({ month: digest.month, text: result.text, guard_triggered: result.guardTriggered }));
  });
}
