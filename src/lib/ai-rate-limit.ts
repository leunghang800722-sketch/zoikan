// WP-AI1：每人每日問答上限（`AI_DAILY_LIMIT`，預設 100）——同
// `src/lib/ai-conversation.ts` 一樣，呢個檔案管嘅係「幾多次問答」呢類
// 應用層節流狀態（讀 audit_log 計數），唔係業務數據查詢，所以擺喺
// `src/lib/` 頂層、用返正常 `@/lib/db`，唔喺 `src/lib/ai/**` 之下。
//
// P2.5 Opus 驗收應修④：呢個每日額度**同開會反映訪談員共用**——
// `src/app/api/ai/chat/route.ts`（主助手問答）同
// `src/app/api/feedback/session/chat/route.ts`／`src/app/api/feedback/
// session/summarize/route.ts`（訪談員 chat／整理，兩個都真係叫 LLM）
// 三個 route 一齊 call `assertUnderDailyLimit()`，計埋同一個數——唔係
// 「主助手 100 次＋開會反映另外 100 次」，係總共 100 次。`session`／
// `abandon` 兩個 feedback endpoint 唔叫 LLM，唔受呢個額度影響（見
// `src/lib/feedback/session.ts` 嘅 `countSessionsOpenedToday()`——開
// session 次數另外用一個獨立嘅每日上限）。
import { prisma } from "./db";

const DEFAULT_AI_DAILY_LIMIT = 100;

/** 計入呢個共用每日額度嘅 audit_log `(table_name, action)` 組合——逐個
 * 會叫 LLM 嘅 route 每次都要（唔止 guard 觸發先）寫一行呢度列明嘅
 * audit，先至保證「叫幾多次 LLM 就計幾多次」呢個口徑成立。 */
const AI_QUOTA_ACTIONS: ReadonlyArray<{ tableName: string; action: string }> = [
  { tableName: "ai_chat", action: "ai_chat" }, // 主助手 /api/ai/chat
  { tableName: "ai_feedback_chat", action: "ai_feedback_chat" }, // 開會反映訪談 /api/feedback/session/chat
  { tableName: "ai_feedback_chat", action: "ai_feedback_summarize" }, // 開會反映整理 /api/feedback/session/summarize
];

function getAiDailyLimit(): number {
  const raw = process.env.AI_DAILY_LIMIT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AI_DAILY_LIMIT;
}

/** 今日（UTC 曆日——規劃裁定：唔額外引入時區處理依賴，同其他報表用嘅
 * UTC 月份邊界一致）已經問咗幾多條——計埋主助手＋開會反映訪談／整理
 * （`AI_QUOTA_ACTIONS`），唔另開一張表。 */
export async function countTodayAiChats(userId: string): Promise<number> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return prisma.auditLog.count({
    where: {
      actorUserId: userId,
      createdAt: { gte: dayStart },
      OR: AI_QUOTA_ACTIONS.map((a) => ({ tableName: a.tableName, action: a.action })),
    },
  });
}

/**
 * P9.2：原子檢查＋預留。每用戶一條 `pg_advisory_xact_lock(hashtext('ai-daily:'+userId))` 內：
 * base = max(ai_daily_usage 計數, 今日 audit_log AI 次數)；base < limit 先把計數 +1（預留呢一次），
 * 回傳 `used`＝預留前嘅 base（caller 照舊 `used >= limit` 就 429）。
 * 並發 N 個請求喺 base=limit-k 時只有 k 個會見到 used<limit。
 * 計數喺檢查時就 +1（唔係等 audit 寫入），所以 caller 若喺叫 LLM 之前失敗要 `releaseDailySlot()` 退還。
 */
export async function assertUnderDailyLimit(userId: string): Promise<{ used: number; limit: number }> {
  const limit = getAiDailyLimit();
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const used = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ai-daily:" + userId}))`;
      const [row, audited] = await Promise.all([
        tx.aiDailyUsage.findUnique({ where: { userId_day: { userId, day: dayStart } } }),
        tx.auditLog.count({ where: { actorUserId: userId, createdAt: { gte: dayStart }, OR: AI_QUOTA_ACTIONS.map((a) => ({ tableName: a.tableName, action: a.action })) } }),
      ]);
      const base = Math.max(row?.used ?? 0, audited);
      const next = base < limit ? base + 1 : base;
      await tx.aiDailyUsage.upsert({ where: { userId_day: { userId, day: dayStart } }, create: { userId, day: dayStart, used: next }, update: { used: next } });
      return base;
    },
    { maxWait: 15000, timeout: 15000 },
  );
  return { used, limit };
}

/** 退還一次預留（caller 喺叫 LLM 之前就失敗，例如 provider 未設定）。 */
export async function releaseDailySlot(userId: string): Promise<void> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ai-daily:" + userId}))`;
    await tx.aiDailyUsage.updateMany({ where: { userId, day: dayStart, used: { gt: 0 } }, data: { used: { decrement: 1 } } });
  });
}
