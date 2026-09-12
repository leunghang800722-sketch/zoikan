import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubUnknownShape } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

// 要「操作紀錄:view」（規劃裁定）。
export function createRecentAuditTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "recent_audit",
    description: "查最近嘅操作紀錄（audit_log）——邊個、幾時、邊張表邊一行、做咗咩改動。要「操作紀錄:view」；before/after 入面嘅金錢欄另外跟收客價/出街價查閱權剝走。",
    inputSchema: z
      .object({
        table: z.string().optional().describe("表名篩選（例如 rate_cards/shift_records/users）"),
        row_id: z.string().optional().describe("指定行 id"),
        limit: z.number().int().min(1).max(100).optional().describe("最多幾多條，預設 20"),
      })
      .strict(),
    run: async ({ table, row_id, limit }) => {
      const denied = await requireModuleOrDenied(ctx, "操作紀錄");
      if (denied) return deniedResult(denied);

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (table) {
        params.push(table);
        conditions.push(`table_name = $${params.length}`);
      }
      if (row_id) {
        params.push(row_id);
        conditions.push(`row_id = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const cap = Math.min(Math.max(limit ?? 20, 1), 100);

      const { rows } = await aiQuery(
        `SELECT id, actor_user_id, table_name, row_id, action, before, after, ip, created_at
         FROM ai.audit_log ${where}
         ORDER BY created_at DESC
         LIMIT ${cap}`,
        params,
      );

      const scrubbed = rows.map((r) => scrubUnknownShape(r, ctx.fieldVisibility));
      return toolResultJson({ count: scrubbed.length, entries: scrubbed });
    },
  });
}
