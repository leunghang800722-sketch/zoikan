// P2.5「現場反映」開會模式——`feedback_sessions` 讀寫。同
// `src/lib/ai-conversation.ts` 一樣擺喺 `src/lib/ai/` 樹之外（頂層）——
// 管嘅係訪談對話本身呢類應用狀態，需要正常 Prisma 讀寫，唔屬於「AI
// 查詢業務數據必須唯讀」嗰條邊界（`tests/ai-structural-guard.test.ts`
// 淨係掃 `src/lib/ai/**`／`src/app/api/ai/**`，呢個目錄唔喺範圍內）。
import { prisma } from "../db";
import type { FeedbackSession } from "@prisma/client";

export interface StoredFeedbackMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string; // ISO
}

export interface FeedbackPageContext {
  path?: string;
  site_id?: string;
  month?: string;
  broker?: string;
}

// P2.5：session 上限 40 輪（一個 turn = 一問一答）——chat route 撞到就
// 拒絕再問（前端引導撳「整理並送出」或者「取消開會」）。
export const MAX_FEEDBACK_TURNS = 40;

function isStoredMessageArray(value: unknown): value is StoredFeedbackMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) => m && typeof m === "object" && (m as { role?: unknown }).role !== undefined && typeof (m as { content?: unknown }).content === "string",
    )
  );
}

export function messagesOf(session: Pick<FeedbackSession, "messages">): StoredFeedbackMessage[] {
  return isStoredMessageArray(session.messages) ? session.messages : [];
}

export function turnCountOf(session: Pick<FeedbackSession, "messages">): number {
  return Math.floor(messagesOf(session).length / 2);
}

/** 一個用戶同時最多一個 draft——搵返現有 draft 就直接續用（可以更新
 * page_context 做「用戶而家喺邊頁開會」嘅最新提示），冇就開一個新嘅。
 * application 層保證（唔係 DB unique constraint，見 schema.prisma 註解）。 */
export async function getOrCreateDraftSession(userId: string, pageContext?: FeedbackPageContext): Promise<FeedbackSession> {
  const existing = await prisma.feedbackSession.findFirst({
    where: { userId, status: "draft" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    if (pageContext) {
      return prisma.feedbackSession.update({
        where: { id: existing.id },
        data: { pageContext: JSON.parse(JSON.stringify(pageContext)) },
      });
    }
    return existing;
  }
  return prisma.feedbackSession.create({
    data: {
      userId,
      status: "draft",
      messages: [],
      pageContext: pageContext ? JSON.parse(JSON.stringify(pageContext)) : undefined,
    },
  });
}

export async function getSessionForUser(sessionId: string, userId: string): Promise<FeedbackSession | null> {
  return prisma.feedbackSession.findFirst({ where: { id: sessionId, userId } });
}

export async function appendFeedbackTurn(sessionId: string, userMessage: string, assistantMessage: string): Promise<FeedbackSession> {
  const existing = await prisma.feedbackSession.findUniqueOrThrow({ where: { id: sessionId } });
  const now = new Date().toISOString();
  const updated: StoredFeedbackMessage[] = [
    ...messagesOf(existing),
    { role: "user", content: userMessage, createdAt: now },
    { role: "assistant", content: assistantMessage, createdAt: now },
  ];
  const jsonSafe = JSON.parse(JSON.stringify(updated));
  return prisma.feedbackSession.update({ where: { id: sessionId }, data: { messages: jsonSafe } });
}

export async function markSessionStatus(sessionId: string, status: "submitted" | "abandoned"): Promise<FeedbackSession> {
  return prisma.feedbackSession.update({ where: { id: sessionId }, data: { status } });
}

/** 每人每日 submitted report 上限（3 份）——`submit` route 用嚟計今日
 * （UTC 曆日，同 AI 助手每日上限口徑一致，見 docs/ai-assistant.md）已經
 * 送出咗幾多份。 */
export async function countSubmittedReportsToday(userId: string): Promise<number> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return prisma.feedbackReport.count({ where: { userId, createdAt: { gte: dayStart, lt: dayEnd } } });
}
