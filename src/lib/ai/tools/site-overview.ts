import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定）。
export function createSiteOverviewTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "site_overview",
    description:
      "睇一個盤喺某個月嘅概況：更別清單、每日所需人手、已排更數、逐雞頭人數分佈。用嚟答「呢個盤而家咩情況」「呢個盤幾多個雞頭嘅人」呢類問題。要「更表:view」。",
    inputSchema: z
      .object({
        site: z.string().describe("盤名稱（canonical_name 或 alias 嘅一部分，用 ILIKE 模糊搵）"),
        month: monthParam.describe("月份 YYYY-MM"),
      })
      .strict(),
    run: async ({ site, month }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const siteRows = (
        await aiQuery(
          `SELECT id, canonical_name, client_name, billing_model, status FROM ai.sites
           WHERE canonical_name ILIKE $1 OR $1 = ANY(aliases) LIMIT 5`,
          [`%${site}%`],
        )
      ).rows;
      if (siteRows.length === 0) {
        return toolResultJson({ error: "not_found", message: `搵唔到名稱包含「${site}」嘅盤` });
      }
      const siteRow = siteRows[0];

      const [shiftTypes, dailyReq, brokerCounts] = await Promise.all([
        aiQuery(`SELECT id, code, label, headcount_required, billing_group FROM ai.shift_types WHERE site_id = $1 AND voided_at IS NULL ORDER BY code`, [siteRow.id]),
        aiQuery(
          `SELECT shift_type_id, COUNT(*) AS days, SUM(headcount_required) AS total_headcount
           FROM ai.daily_requirements
           WHERE site_id = $1 AND work_date >= $2::date AND work_date < ($2::date + INTERVAL '1 month') AND voided_at IS NULL
           GROUP BY shift_type_id`,
          [siteRow.id, monthStart],
        ),
        aiQuery(
          `SELECT COALESCE(sr.operational_broker_id, sr.settlement_broker_id) AS broker_id, b.name AS broker_name, b.code AS broker_code,
                  COUNT(*) AS shift_count, COUNT(DISTINCT sr.guard_id) AS guard_count
           FROM ai.shift_records sr
           LEFT JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
           WHERE sr.site_id = $1 AND sr.work_date >= $2::date AND sr.work_date < ($2::date + INTERVAL '1 month')
             AND sr.record_type = 'shift'
           GROUP BY 1, 2, 3
           ORDER BY shift_count DESC`,
          [siteRow.id, monthStart],
        ),
      ]);

      return toolResultJson({
        site: siteRow,
        month,
        shift_types: shiftTypes.rows,
        daily_requirements_summary: dailyReq.rows,
        broker_breakdown: scrubRowsForResource(brokerCounts.rows, "shift_records", ctx.fieldVisibility),
      });
    },
  });
}
