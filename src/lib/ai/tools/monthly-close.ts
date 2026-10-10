import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { round2 } from "@/lib/reports/money";
import { withReportContext } from "@/lib/reports/context";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「月結總表:view」（規劃裁定：助手同畫面權限一致），再疊 field-
// group gate 決定 revenue/cost/profit 見唔見得到。
export function createMonthlyCloseTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "monthly_close",
    description:
      "月結總表（對客收費口徑）——逐盤某個月嘅營業額/成本/盈利/百分比（同「月結以外」分類）。**成本欄只係逐更工資，唔含長工月薪分攤／介紹費／特別項目成本，唔可以用嚟答毛利／毛利率**——用嚟答月結／已鎖定／逐盤營業額呢類問題，問毛利/毛利率請用 gross_margin。要「月結總表:view」；數字另外跟收客價/出街價查閱權歸零。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "月結總表");
      if (denied) return deniedResult(denied);

      const monthDate = new Date(`${month}-01T00:00:00.000Z`);
      const { mainRows, outsideRows } = await withReportContext(() => buildMonthlyClose(monthDate));
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

      // 系統計嘅總計——同 scripts/report/monthly-close.ts writeSheet() 個
      // Sub-Total 一致嘅口徑（**淨係 main（R2 口徑）嗰批盤**，唔包
      // outsideRows，同 xlsx 個 Sub-Total 行對齊）。加呢個嘅原因：
      // 老闆 live 驗收發現模型會自己逐行加總 40 幾行嚟答「全公司」，
      // 加埋條數計錯（冇跟 P0 口徑嘅四捨五入/篩選），要俾一個現成、
      // 已經同 P0 對過數嘅 totals 俾模型直接讀。
      const mainTotalsRaw = mainRows.reduce(
        (acc, r) => ({ shifts: acc.shifts + r.shifts, revenue: acc.revenue + r.revenue, cost: acc.cost + r.cost }),
        { shifts: 0, revenue: 0, cost: 0 },
      );
      const totalRevenue = clientRateVisible ? round2(mainTotalsRaw.revenue) : 0;
      const totalCost = settlementVisible ? round2(mainTotalsRaw.cost) : 0;
      const totalProfit = clientRateVisible && settlementVisible ? round2(totalRevenue - totalCost) : 0;
      const totalMarginPct = clientRateVisible && settlementVisible && totalCost > 0 && totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : null;

      return toolResultJson({
        month,
        main: shape(mainRows),
        outside_monthly_close: shape(outsideRows),
        totals: { shifts: mainTotalsRaw.shifts, revenue: totalRevenue, cost: totalCost, profit: totalProfit, marginPct: totalMarginPct },
        totals_note:
          "totals 已由系統計（淨係 main 嗰批盤，同 P0 對數 Sub-Total 一致，唔含「月結以外」），唔好自己逐行加總；呢個 cost 淨係逐更工資，唔含長工月薪分攤/介紹費/特別項目——問毛利/毛利率請用 gross_margin 工具。",
        note: clientRateVisible && settlementVisible ? undefined : "你嘅角色冇齊「收客價」／「出街價」查閱權，部分數字已歸零。",
      });
    },
  });
}
