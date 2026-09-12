import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

// 要「盤:view」（規劃裁定）。
export function createListSitesTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "list_sites",
    description: "列出全部盤（site）嘅基本資料——名稱、客戶名、收費模式、狀態。當用戶問「有咩盤」「邊啲盤仲 active」呢類問題時用。要「盤:view」。",
    inputSchema: z
      .object({
        include_inactive: z.boolean().optional().describe("連已結束/暫停嘅盤都列（預設 false，只列 active）"),
      })
      .strict(),
    run: async ({ include_inactive }) => {
      const denied = await requireModuleOrDenied(ctx, "盤");
      if (denied) return deniedResult(denied);

      const where = include_inactive ? "" : "WHERE status = 'active'";
      const { rows } = await aiQuery(
        `SELECT id, canonical_name, client_name, client_group, billing_model, monthly_fee, monthly_posts, status, in_scope, outside_monthly_close
         FROM ai.sites ${where} ORDER BY canonical_name LIMIT 500`,
      );
      const scrubbed = scrubRowsForResource(rows, "sites", ctx.fieldVisibility);
      return toolResultJson({ count: scrubbed.length, sites: scrubbed });
    },
  });
}
