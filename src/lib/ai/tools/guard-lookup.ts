import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

// 要「安員:view」（規劃裁定）。
export function createGuardLookupTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "guard_lookup",
    description: "用姓名或工號搵安員基本資料（唔會回電話——呢個系統嘅 AI 助手一律唔接觸電話）。要「安員:view」。",
    inputSchema: z.object({ query: z.string().describe("姓名（中/英）或工號關鍵字") }).strict(),
    run: async ({ query }) => {
      const denied = await requireModuleOrDenied(ctx, "安員");
      if (denied) return deniedResult(denied);

      const { rows } = await aiQuery(
        `SELECT g.id, g.staff_no, g.staff_no_mw, g.name_zh, g.name_en, g.employment_type, g.monthly_salary,
                g.sia_permit_expiry, g.status, b.code AS default_broker_code, b.name AS default_broker_name
         FROM ai.guards g
         LEFT JOIN ai.brokers b ON b.id = g.default_broker_id
         WHERE g.name_zh ILIKE $1 OR g.name_en ILIKE $1 OR g.staff_no ILIKE $1 OR g.staff_no_mw ILIKE $1
         ORDER BY g.name_zh
         LIMIT 50`,
        [`%${query}%`],
      );

      const scrubbed = scrubRowsForResource(rows, "guards", ctx.fieldVisibility);
      return toolResultJson({ count: scrubbed.length, guards: scrubbed });
    },
  });
}
