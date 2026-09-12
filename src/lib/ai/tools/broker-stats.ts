import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定：呢個工具本質係逐雞頭嘅更次統計，同
// roster/site_overview 一致）。
export function createBrokerStatsTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "broker_stats",
    description:
      "睇雞頭喺某個月嘅更次統計——幾多更、幾多安員、（有出街價權限先見到）預計出街價成本。可選 site 篩選淨係睇某個盤。要「更表:view」。",
    inputSchema: z
      .object({
        site: z.string().optional().describe("盤名稱（可選，唔填即全公司）"),
        month: monthParam,
      })
      .strict(),
    run: async ({ site, month }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const params: unknown[] = [monthStart];
      let siteFilter = "";
      if (site) {
        const siteRows = (await aiQuery(`SELECT id FROM ai.sites WHERE canonical_name ILIKE $1 OR $1 = ANY(aliases) LIMIT 1`, [`%${site}%`])).rows;
        if (siteRows.length === 0) {
          return toolResultJson({ error: "not_found", message: `搵唔到名稱包含「${site}」嘅盤` });
        }
        params.push(siteRows[0].id);
        siteFilter = `AND sr.site_id = $${params.length}`;
      }

      const { rows } = await aiQuery(
        `SELECT b.id AS broker_id, b.code AS broker_code, b.name AS broker_name, b.kind,
                COUNT(*) FILTER (WHERE sr.record_type = 'shift') AS shift_count,
                COUNT(DISTINCT sr.guard_id) AS guard_count,
                SUM(COALESCE(sr.guard_wage_snapshot, 0) + COALESCE(sr.broker_fee_snapshot, 0)) AS estimated_payout
         FROM ai.shift_records sr
         JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
         WHERE sr.work_date >= $1::date AND sr.work_date < ($1::date + INTERVAL '1 month') ${siteFilter}
         GROUP BY b.id, b.code, b.name, b.kind
         ORDER BY shift_count DESC
         LIMIT 200`,
        params,
      );

      // `estimated_payout` 係聚合出嚟嘅欄，唔係 shift_records 底層物理欄名
      // （SETTLEMENT_FIELDS 嗰個 blocklist 對唔中呢個 alias），所以呢度
      // 手動剝——唔靠通用 scrubRowsForResource（見 field-scrub.ts 頂註解
      // 「已知限制」，聚合/改名欄要逐個工具自己判斷）。
      const brokers = rows.map((r) => {
        if (ctx.fieldVisibility.settlementVisible) return r;
        const rest: Record<string, unknown> = { ...(r as Record<string, unknown>) };
        delete rest.estimated_payout;
        return rest;
      });
      return toolResultJson({ month, site: site ?? null, brokers });
    },
  });
}
