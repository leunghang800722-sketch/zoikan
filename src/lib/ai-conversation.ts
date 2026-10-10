// WP-AI1：AI 助手對話記錄嘅讀寫——`ai_conversations` 表，一般讀寫用途
// （唔係「AI 查詢業務數據」），所以用返正常嘅 `@/lib/db`（Prisma 寫入
// 客戶端），同 `src/lib/audit.ts`／`src/lib/month-lock.ts` 一樣擺喺
// `src/lib/` 頂層（唔喺 `src/lib/ai/` 之下）——`tests/ai-structural-guard
// .test.ts` 掃嘅係 `src/lib/ai/**`／`src/app/api/ai/**` 呢兩個 tree，
// 呢個檔案刻意擺喺 tree 之外，因為佢管嘅係「助手自己嘅對話 history」
// 呢類應用狀態，唔屬於「AI 查詢業務數據必須唯讀」嗰條邊界（好似
// audit_log 一樣係正常寫入路徑）。
import { prisma } from "./db";
import { sanitizeActionCards, type ActionCard } from "./ai/actions";

export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string; // ISO
  /** WP-AI-DIAG（additive）：assistant turn 嘅建議動作卡（已驗證）；舊記錄冇呢個欄照讀。 */
  actions?: ActionCard[];
}

const MAX_TURNS = 30; // 一個 turn = 一問一答，最多保留 30 turn = 60 條 message

function isStoredChatMessageArray(value: unknown): value is StoredChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) => m && typeof m === "object" && (m as { role?: unknown }).role !== undefined && typeof (m as { content?: unknown }).content === "string",
    )
  );
}

export async function getConversation(userId: string): Promise<StoredChatMessage[]> {
  const row = await prisma.aiConversation.findUnique({ where: { userId } });
  if (!row) return [];
  if (!isStoredChatMessageArray(row.messages)) return [];
  // 讀出嚟再驗一次 actions（白名單／strict）——history 被人手改過都唔會畀非法卡去到畫面
  return row.messages.map((m) => {
    if (m.actions === undefined) return m;
    const actions = sanitizeActionCards(m.actions);
    const { actions: _drop, ...rest } = m;
    void _drop;
    return actions.length ? { ...rest, actions } : rest;
  });
}

/** 加一個問答 turn，超過 30 turn 就淨係保留最尾 30 個。 */
export async function appendConversationTurn(
  userId: string,
  userMessage: string,
  assistantMessage: string,
  actions?: ActionCard[],
): Promise<void> {
  const existing = await getConversation(userId);
  const now = new Date().toISOString();
  const updated: StoredChatMessage[] = [
    ...existing,
    { role: "user", content: userMessage, createdAt: now },
    { role: "assistant", content: assistantMessage, createdAt: now, ...(actions && actions.length ? { actions } : {}) },
  ];
  const capped = updated.slice(-MAX_TURNS * 2);
  // JSON.stringify→parse：抹走 TS 介面型別資訊，變返純 JSON-safe plain
  // value，先啱 Prisma 嘅 `InputJsonValue`（同 src/lib/audit.ts 嘅
  // `toJson()` 一致手法）。
  const jsonSafe = JSON.parse(JSON.stringify(capped));

  await prisma.aiConversation.upsert({
    where: { userId },
    create: { userId, messages: jsonSafe },
    update: { messages: jsonSafe },
  });
}

export async function clearConversation(userId: string): Promise<void> {
  await prisma.aiConversation.deleteMany({ where: { userId } });
}
