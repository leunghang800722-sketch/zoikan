// WP-AI-DIAG（§37.3 / 37.6）：`recent_app_errors`——讀應用層錯誤日誌（`app_error_log`，已遮罩，冇 body／header／IP／stack）。
// 呢個檔案唔含 `prisma.`／`@/lib/db` 字面（structural guard）：reader 放 `src/lib/reports/app-errors.ts`（`listRecentAppErrors()`），
// 跟 `list_feedback` 先例。只准老闆同有「操作紀錄:view」（現有最接近嘅管理／診斷 module）嘅角色用。
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { listRecentAppErrors } from "@/lib/reports/app-errors";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

export function createRecentAppErrorsTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "recent_app_errors",
    description:
      "查最近嘅應用層錯誤（系統內部 5xx／AI 服務錯誤）：時間、route、狀態碼、錯誤類別、已遮罩訊息。用嚟答「系統頭先點解出錯／某功能有冇報錯」。唔含請求內容或個人資料。要「操作紀錄:view」。",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional().describe("最多幾多條，預設 20") }).strict(),
    run: async ({ limit }) => {
      const denied = await requireModuleOrDenied(ctx, "操作紀錄");
      if (denied) return deniedResult(denied);
      const errors = await listRecentAppErrors(limit ?? 20);
      return toolResultJson({ count: errors.length, errors });
    },
  });
}
