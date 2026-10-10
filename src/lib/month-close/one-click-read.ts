// WP-AI-DIAG（§37.3）：`GET /api/month-close/one-click` 背後嘅讀取邏輯抽出嚟，route 同助手 `one_click_status` 工具共用
// （route 行為不變：同樣 where／orderBy／take 20）。純讀。
import { prisma } from "@/lib/db";

export async function findOneClickRuns(month: Date | null, take = 20) {
  return prisma.monthCloseRun.findMany({
    where: month ? { month } : undefined,
    orderBy: { startedAt: "desc" },
    take,
  });
}
