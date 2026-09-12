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
import { createShiftHistoryTool } from "./shift-history";
import { createGrossMarginTool } from "./gross-margin";
import { createMonthlyCloseTool } from "./monthly-close";
import { createShortfallTool } from "./shortfall";
import { createRecentAuditTool } from "./recent-audit";
import { createSqlSelectTool } from "./sql-select";

export type { AiToolContext } from "./common";

export function buildAiTools(ctx: AiToolContext) {
  return [
    createDescribeSystemTool(ctx),
    createListSitesTool(ctx),
    createSiteOverviewTool(ctx),
    createRosterTool(ctx),
    createBrokerStatsTool(ctx),
    createRateCardsTool(ctx),
    createExplainRateCardTool(ctx),
    createGuardLookupTool(ctx),
    createShiftHistoryTool(ctx),
    createGrossMarginTool(ctx),
    createMonthlyCloseTool(ctx),
    createShortfallTool(ctx),
    createRecentAuditTool(ctx),
    createSqlSelectTool(ctx),
  ];
}
