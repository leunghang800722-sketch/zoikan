// WP-AI1：每人每日問答上限（`AI_DAILY_LIMIT`，預設 100）——同
// `src/lib/ai-conversation.ts` 一樣，呢個檔案管嘅係「幾多次問答」呢類
// 應用層節流狀態（讀 audit_log 計數），唔係業務數據查詢，所以擺喺
// `src/lib/` 頂層、用返正常 `@/lib/db`，唔喺 `src/lib/ai/**` 之下。
import { prisma } from "./db";

export const DEFAULT_AI_DAILY_LIMIT = 100;

export function getAiDailyLimit(): number {
  const raw = process.env.AI_DAILY_LIMIT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AI_DAILY_LIMIT;
}

/** 今日（UTC 曆日——規劃裁定：唔額外引入時區處理依賴，同其他報表用嘅
 * UTC 月份邊界一致）已經問咗幾多條。用 `audit_log`（table_name="ai_chat"，
 * action="ai_chat"）計數，唔另開一張表。 */
export async function countTodayAiChats(userId: string): Promise<number> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return prisma.auditLog.count({
    where: {
      actorUserId: userId,
      tableName: "ai_chat",
      action: "ai_chat",
      createdAt: { gte: dayStart },
    },
  });
}

export async function assertUnderDailyLimit(userId: string): Promise<{ used: number; limit: number }> {
  const limit = getAiDailyLimit();
  const used = await countTodayAiChats(userId);
  return { used, limit };
}
