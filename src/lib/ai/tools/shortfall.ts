import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildShortfall } from "@/lib/reports/shortfall";
import { withReportContext } from "@/lib/reports/context";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式要係 YYYY-MM-DD");

// 要「尚欠總覽:view」（規劃裁定），再疊 field-group gate 決定
// monthProgress 入面嘅金錢數字。
export function createShortfallTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "shortfall",
    description: "睇尚欠總覽——指定日期逐盤所需人手 vs 已確認更次（邊個盤唔夠人），連埋待審批數同本月毛利進度。要「尚欠總覽:view」；金錢數字另外跟收客價/出街價查閱權歸零。",
    inputSchema: z.object({ date: dateParam }).strict(),
    run: async ({ date }) => {
      const denied = await requireModuleOrDenied(ctx, "尚欠總覽");
      if (denied) return deniedResult(denied);

      const dateObj = new Date(`${date}T00:00:00.000Z`);
      const result = await withReportContext(() => buildShortfall(dateObj));
      const { clientRateVisible, settlementVisible } = ctx.fieldVisibility;
      const moneyVisible = clientRateVisible && settlementVisible;

      return toolResultJson({
        date: result.date,
        today: result.today,
        pendingApprovalCount: result.pendingApprovalCount,
        monthProgress: {
          month: result.monthProgress.month,
          revenue: clientRateVisible ? result.monthProgress.revenue : 0,
          cost: settlementVisible ? result.monthProgress.cost : 0,
          profit: moneyVisible ? result.monthProgress.profit : 0,
          marginPct: moneyVisible ? result.monthProgress.marginPct : null,
          thresholdPct: result.monthProgress.thresholdPct,
          belowThresholdSiteCount: result.monthProgress.belowThresholdSiteCount,
        },
        note: moneyVisible ? undefined : "你嘅角色冇齊「收客價」／「出街價」查閱權，部分數字已歸零。",
      });
    },
  });
}
