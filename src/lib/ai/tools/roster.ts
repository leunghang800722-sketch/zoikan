import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定：助手同畫面權限一致）。
export function createRosterTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "roster",
    description:
      "攞一個盤喺某個月嘅更表——逐個保安員逐日嘅更別代號/請假代號。用戶問「呢個人幾時返工」「呢個盤呢個月邊日邊個更」用呢個。可選 broker 篩選淨係睇某個雞頭嘅人。要「更表:view」。",
    inputSchema: z
      .object({
        site: z.string().describe("盤名稱（canonical_name 或 alias 嘅一部分）"),
        month: monthParam,
        broker_code: z.string().optional().describe("雞頭代號（例如 K/W/G/D/T），淨係睇呢個雞頭嘅人"),
      })
      .strict(),
    run: async ({ site, month, broker_code }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const siteRows = (
        await aiQuery(`SELECT id, canonical_name FROM ai.sites WHERE canonical_name ILIKE $1 OR $1 = ANY(aliases) LIMIT 5`, [`%${site}%`])
      ).rows;
      if (siteRows.length === 0) {
        return toolResultJson({ error: "not_found", message: `搵唔到名稱包含「${site}」嘅盤` });
      }
      const siteRow = siteRows[0];

      const params: unknown[] = [siteRow.id, monthStart];
      let brokerFilter = "";
      if (broker_code) {
        params.push(broker_code);
        brokerFilter = `AND b.code = $${params.length}`;
      }

      const { rows } = await aiQuery(
        `SELECT g.name_zh AS guard_name, g.staff_no, st.code AS shift_type_code, sr.work_date, sr.record_type, sr.leave_code,
                b.code AS broker_code
         FROM ai.shift_records sr
         JOIN ai.guards g ON g.id = sr.guard_id
         JOIN ai.shift_types st ON st.id = sr.shift_type_id
         LEFT JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
         WHERE sr.site_id = $1 AND sr.work_date >= $2::date AND sr.work_date < ($2::date + INTERVAL '1 month')
           ${brokerFilter}
         ORDER BY g.name_zh, sr.work_date
         LIMIT 3000`,
        params,
      );

      return toolResultJson({ site: siteRow.canonical_name, month, broker_code: broker_code ?? null, count: rows.length, records: rows });
    },
  });
}
