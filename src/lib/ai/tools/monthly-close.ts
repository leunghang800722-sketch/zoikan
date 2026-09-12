import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「月結總表:view」（規劃裁定：助手同畫面權限一致），再疊 field-
// group gate 決定 revenue/cost/profit 見唔見得到。
export function createMonthlyCloseTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "monthly_close",
    description: "睇月結總表——逐盤某個月嘅營業額/成本/盈利/百分比（同「月結以外」分類）。要「月結總表:view」；數字另外跟收客價/出街價查閱權歸零。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "月結總表");
      if (denied) return deniedResult(denied);

      const monthDate = new Date(`${month}-01T00:00:00.000Z`);
      const { mainRows, outsideRows } = await buildMonthlyClose(monthDate);
      const { clientRateVisible, settlementVisible } = ctx.fieldVisibility;

      const shape = (rows: typeof mainRows) =>
        rows.map((r) => ({
          canonicalName: r.canonicalName,
          shifts: r.shifts,
          revenue: clientRateVisible ? r.revenue : 0,
          cost: settlementVisible ? r.cost : 0,
          profit: clientRateVisible && settlementVisible ? r.profit : 0,
          marginPct: clientRateVisible && settlementVisible ? r.marginPct : null,
          note: r.note,
        }));

      return toolResultJson({
        month,
        main: shape(mainRows),
        outside_monthly_close: shape(outsideRows),
        note: clientRateVisible && settlementVisible ? undefined : "你嘅角色冇齊「收客價」／「出街價」查閱權，部分數字已歸零。",
      });
    },
  });
}
