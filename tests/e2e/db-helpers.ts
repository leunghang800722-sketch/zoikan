// P1-WP3 Playwright e2e：DB 查詢／setup helper——直接用 Prisma 對住起緊
// 個 dev server 用嘅同一個資料庫（`.env` 嘅 `DATABASE_URL`，即
// `npm run db:seed` 落嗰個庫），淨係用嚟喺測試開始前搵返啲 id／擺返啲
// 前置狀態（例如 brokers.requires_approval），唔係應用程式本身嘅一部分
// ——呢個唔違反「UI 只可以經 API」嘅硬規則（嗰條規則管嘅係
// `src/app/(app)/**` 呢啲真正嘅前端代碼，唔係測試自己嘅 setup script，
// 同 tests/lib/db.ts 俾 Vitest 用嘅角色一致）。
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const TEST_TEL = {
  老闆: "90000001",
  主管: "90000002",
  會計: "90000003",
  雞頭A: "90000004",
  雞頭B: "90000005",
  安員: "90000006",
} as const;

export const TEST_PASSWORD: Record<keyof typeof TEST_TEL, string> = {
  老闆: "Passw0rd1",
  主管: "Passw0rd2",
  會計: "Passw0rd3",
  雞頭A: "Broker0004",
  雞頭B: "Broker0005",
  安員: "Guard00006",
};

export async function findSiteIdByName(nameContains: string): Promise<string> {
  const site = await prisma.site.findFirst({ where: { canonicalName: { contains: nameContains } } });
  if (!site) throw new Error(`e2e setup: 搵唔到 site canonicalName contains "${nameContains}"`);
  return site.id;
}

export async function findBrokerIdByCode(code: string): Promise<string> {
  const broker = await prisma.broker.findFirstOrThrow({ where: { code } });
  return broker.id;
}

/** 場景 (b) 用：令 brokerA（代號 K）填更要入審批隊列。 */
export async function setBrokerRequiresApproval(brokerId: string, value: boolean): Promise<void> {
  await prisma.broker.update({ where: { id: brokerId }, data: { requiresApproval: value } });
}

/** 場景 (c) 用：搵一個 brokerA 喺 2026-08 冇份（`broker_site_assignments`
 * 冇呢行）嘅盤，做「打他人盤 URL」嘅 negative test。 */
export async function findSiteNotAssignedToBroker(brokerId: string, month: Date): Promise<string> {
  const assigned = await prisma.brokerSiteAssignment.findMany({ where: { brokerId, month }, select: { siteId: true } });
  const assignedIds = new Set(assigned.map((a) => a.siteId));
  const candidate = await prisma.site.findFirst({ where: { id: { notIn: [...assignedIds] }, status: "active" } });
  if (!candidate) throw new Error("e2e setup: 搵唔到一個 brokerA 冇份嘅 site");
  return candidate.id;
}

/** 場景 (b) 用：清走呢個 broker 幫呢個 site 喺呢個月已經填低嘅
 * shift_records（等每次跑 e2e 都由乾淨狀態開始，唔會累積舊測試數據）。 */
export async function clearBrokerShiftRecords(brokerId: string, siteId: string, month: Date): Promise<void> {
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  await prisma.shiftRecord.deleteMany({
    where: { siteId, workDate: { gte: month, lte: monthEnd }, OR: [{ settlementBrokerId: brokerId }, { operationalBrokerId: brokerId }] },
  });
}

/** WP-AI2 `ai.spec.ts` 用：清走呢個電話（TEST_TEL）用戶嘅 AI 助手對話
 * 記錄（`ai_conversations`，一個 user 一行）——令「開側欄見歡迎語」呢類
 * 斷言唔會因為上一次跑剩低嘅對話記錄而唔穩定（重跑 e2e 都由乾淨狀態
 * 開始）。 */
export async function clearAiConversationForTel(tel: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { tel } });
  if (!user) return;
  await prisma.aiConversation.deleteMany({ where: { userId: user.id } });
}
