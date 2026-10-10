import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定）。
export function createShiftHistoryTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "shift_history",
    description: "查一個保安員喺某個月嘅更次記錄（邊日邊個盤邊個更別、有冇請假）。要「更表:view」。",
    inputSchema: z
      .object({
        guard_name: z.string().describe("保安員姓名關鍵字"),
        month: monthParam,
      })
      .strict(),
    run: async ({ guard_name, month }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const guardRows = (await aiQuery(`SELECT id, name_zh FROM ai.guards WHERE name_zh ILIKE $1 LIMIT 5`, [`%${guard_name}%`])).rows;
      if (guardRows.length === 0) {
        return toolResultJson({ error: "not_found", message: `搵唔到姓名包含「${guard_name}」嘅保安員` });
      }
      const guardRow = guardRows[0];

      const { rows } = await aiQuery(
        `SELECT sr.work_date, s.canonical_name AS site_name, st.code AS shift_type_code, sr.record_type, sr.leave_code, sr.status
         FROM ai.shift_records sr
         JOIN ai.sites s ON s.id = sr.site_id
         JOIN ai.shift_types st ON st.id = sr.shift_type_id
         WHERE sr.guard_id = $1 AND sr.work_date >= $2::date AND sr.work_date < ($2::date + INTERVAL '1 month')
         ORDER BY sr.work_date`,
        [guardRow.id, monthStart],
      );

      const scrubbed = scrubRowsForResource(rows, "shift_records", ctx.fieldVisibility);
      return toolResultJson({ guard: guardRow.name_zh, month, count: scrubbed.length, records: scrubbed });
    },
  });
}
