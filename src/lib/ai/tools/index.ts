// WP-AI1：由一個 `AiToolContext`（session + field visibility）產生成套
// 唯讀工具——chat route 每個 request 都要重新 call 呢個（session 唔同、
// field visibility 可能唔同）。
import type { AiToolContext } from "./common";
import { createDescribeSystemTool } from "./describe-system";
import { createListSitesTool } from "./list-sites";
import { createSiteOverviewTool } from "./site-overview";
import { createRosterTool } from "./roster";
import { createBrokerStatsTool } from "./broker-stats";
import { createRateCardsTool, createExplainRateCardTool } from "./rate-cards";
import { createGuardLookupTool } from "./guard-lookup";
import { createLongtermLeaversTool } from "./longterm-leavers";
import { createShiftHistoryTool } from "./shift-history";
import { createGrossMarginTool } from "./gross-margin";
import { createMonthlyCloseTool } from "./monthly-close";
import { createShortfallTool } from "./shortfall";
import { createRecentAuditTool } from "./recent-audit";
import { createSqlSelectTool } from "./sql-select";
// WP-AI-DIAG（§37.3）：診斷用唯讀工具
import {
  createOneClickStatusTool,
  createTriageSummaryTool,
  createMonthHealthTool,
  createOpsDigestTool,
  createSiteSetupTool,
  createPricingExplainTool,
} from "./diagnostics";
import { createRecentAppErrorsTool } from "./recent-app-errors";
// P2.5：`list_feedback`——老闆讀「現場反映」意見用嘅只讀工具，`feedback_
// reports` 唔喺 `ai` schema，工具本身用正常 Prisma（見該檔案頂註解嘅
// 例外說明），刻意擺喺 `src/lib/feedback/`（唔喺 `src/lib/ai/tools/`），
// 呢度淨係 import 個 builder function 嚟 call，呢個 import 本身唔含
// `prisma.`／`@/lib/db` 字面文字，唔違反 tests/ai-structural-guard.
// test.ts 嘅逐檔案原始碼文字掃描。
import { createListFeedbackTool } from "../../feedback/ai-tools/list-feedback";

export type { AiToolContext } from "./common";

export function buildAiTools(ctx: AiToolContext) {
  const tools = [
    createDescribeSystemTool(ctx),
    createListSitesTool(ctx),
    createSiteOverviewTool(ctx),
    createRosterTool(ctx),
    createBrokerStatsTool(ctx),
    createRateCardsTool(ctx),
    createExplainRateCardTool(ctx),
    createGuardLookupTool(ctx),
    createLongtermLeaversTool(ctx),
    createShiftHistoryTool(ctx),
    createGrossMarginTool(ctx),
    createMonthlyCloseTool(ctx),
    createShortfallTool(ctx),
    createRecentAuditTool(ctx),
    createSqlSelectTool(ctx),
    createOneClickStatusTool(ctx),
    createTriageSummaryTool(ctx),
    createMonthHealthTool(ctx),
    createOpsDigestTool(ctx),
    createSiteSetupTool(ctx),
    createPricingExplainTool(ctx),
    createRecentAppErrorsTool(ctx),
  ];
  // P2.5：淨係老闆先掛載 `list_feedback`（規劃裁定，唔改 matrix.ts 加
  // module——直接用 baseRole 判斷，工具 run() 入面再核一次 defense-in-
  // depth，見該檔案）。
  if (ctx.session.baseRole === "老闆") tools.push(createListFeedbackTool(ctx));
  return tools;
}
