import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { validateSqlSelect, extractReferencedTables, modulesForTables } from "../sql-guard";
import { scrubUnknownShape } from "../field-scrub";
import type { AiToolContext } from "./common";
import { denyIfBroker, deniedResult, requireModuleOrDenied, toolResultJson } from "./common";

// 規劃裁定：`sql_select` 要跟返每張表對應嗰個畫面 module 嘅 view 權
// （`src/lib/ai/sql-guard.ts` 嘅 `TABLE_MODULE_MAP`）——由 tokenizer 由
// `FROM`/`JOIN` 抽表名判斷，逐個檢查；抽到嘅表名唔喺對照表入面（打錯
// 字/未登記嘅 view）一律拒絕，唔當「冇限制」處理。
export function createSqlSelectTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "sql_select",
    description:
      "行一句自訂 SELECT/WITH 查詢，淨係可以查 ai.* schema（例如 ai.sites/ai.guards/ai.shift_records……）。用喺其他工具答唔到嘅特殊組合查詢。單句、5秒超時、自動加 LIMIT 200。唔准 INSERT/UPDATE/DELETE/DDL/session 指令。查詢涉及嘅每張表都要對應嗰個 module 嘅 view 權（例如查 users 要「用戶管理:view」）。",
    inputSchema: z.object({ query: z.string().describe("一句 SELECT 或 WITH 開頭嘅 SQL，只可以查 ai. schema") }).strict(),
    run: async ({ query }) => {
      const denied = denyIfBroker(ctx);
      if (denied) return deniedResult(denied);

      const validated = validateSqlSelect(query);
      if (!validated.ok) {
        return toolResultJson({ error: "invalid_query", message: validated.reason });
      }

      const { tables, unknown } = extractReferencedTables(validated.sql);
      if (unknown.length > 0) {
        return toolResultJson({
          error: "unknown_table",
          message: `搵唔到資料表「${unknown.join("、")}」對應嘅權限模組，呢條查詢拒絕。`,
        });
      }
      for (const mod of modulesForTables(tables)) {
        const moduleDenied = await requireModuleOrDenied(ctx, mod);
        if (moduleDenied) return deniedResult(moduleDenied);
      }

      try {
        const result = await aiQuery(validated.sql);
        // 已知限制（見 docs/ai-assistant.md）：呢個 scrub 淨係識欄位*名*，
        // 一個用假 alias 嘅查詢（例如 `SELECT cost AS revenue FROM ...`）
        // 可以繞過——tokenizer 本身刻意簡單，唔做完整 SQL parse/column
        // provenance 分析。
        const rows = scrubUnknownShape(result.rows, ctx.fieldVisibility);
        return toolResultJson({ columns: result.fields.map((f) => f.name), row_count: rows.length, rows, executed_sql: validated.sql });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolResultJson({ error: "query_failed", message: message.slice(0, 300) });
      }
    },
  });
}
