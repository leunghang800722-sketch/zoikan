// AI-PII-2：`longterm_leavers(month)`——某月離職嘅長工（回答「9 月邊個離職」）。
// 兩部分：(1) 人卡離職日喺該月內嘅保安員（`ai.guards.leave_date`＋MG 工號卡，要「保安員:view」）；
// (2) 該月長工糧 is_leaver 行（`ai.longterm_payroll_lines`，年假補償 al_payment，要「長工糧:view」，冇權就唔回呢部分）。
// 只回姓名、工號、離職日、年假補償；唔回身份證／出生日期／住址／銀行／電話。
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export function createLongtermLeaversTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "longterm_leavers",
    description:
      "列出某個月離職嘅保安員／長工：姓名、工號（含 MG 工號卡）、離職日；有「長工糧:view」另列該月長工糧離職結算行（年假補償金額）。用嚟答「9 月邊個離職」「某月有邊啲長工走咗」。要「保安員:view」。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "安員");
      if (denied) return deniedResult(denied);
      const from = `${month}-01`;

      const left = await aiQuery(
        `SELECT g.id AS guard_id, g.name_zh, g.name_en, g.staff_no, g.staff_no_mw, g.employment_type, g.hire_date, g.leave_date,
                (SELECT string_agg(n.number || '(' || n.scheme || ',' || n.status || ')', ' ' ORDER BY n.scheme, n.valid_from NULLS FIRST)
                   FROM ai.guard_staff_numbers n WHERE n.guard_id = g.id) AS staff_number_cards
         FROM ai.guards g
         WHERE g.leave_date >= $1::date AND g.leave_date < ($1::date + interval '1 month')
         ORDER BY g.leave_date, g.name_zh
         LIMIT 200`,
        [from],
      );

      let payroll: unknown = null;
      let payrollNote: string | null = null;
      const ltDenied = await requireModuleOrDenied(ctx, "長工糧");
      if (ltDenied) {
        payrollNote = ltDenied.message;
      } else {
        const r = await aiQuery(
          `SELECT l.guard_id, g.name_zh, g.staff_no_mw, g.leave_date, l.work_days, l.days_in_month, l.al_payment, l.gross, l.al_daily_rate_basis
           FROM ai.longterm_payroll_lines l
           JOIN ai.guards g ON g.id = l.guard_id
           JOIN ai.longterm_payroll_runs r ON r.id = l.run_id
           WHERE l.month = $1::date AND l.is_leaver
           ORDER BY g.leave_date NULLS LAST, g.name_zh
           LIMIT 200`,
          [from],
        );
        payroll = r.rows;
      }
      return toolResultJson({
        month,
        left_in_month: { count: left.rows.length, guards: left.rows },
        payroll_leavers: payroll,
        ...(payrollNote ? { payroll_leavers_note: payrollNote } : {}),
      });
    },
  });
}
