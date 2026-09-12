import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

/** 要「毛利即時表:view」（規劃裁定：助手要同畫面權限一致，冇呢個
 * module 就連問都問唔到，唔淨係「數字歸零」）。有咗呢個 module 之後，
 * 再疊返 field-group gate：冇「收客價:view」將 revenue/profit/marginPct
 * 歸零；冇「出街價:view」將 cost 相關數字歸零——report builder
 * （src/lib/reports/gross-margin.ts，內部用 `@/lib/db` 讀 Prisma，
 * 結構性 test 明文接受呢個例外）出嚟嘅係 camelCase 物件（唔係 ai.*
 * view 嗰種 snake_case row），field-scrub.ts 嗰個通用 blocklist 對唔
 * 中呢種形狀，所以呢度手動逐個歸零（唔係刪走個 key，等 LLM 睇到形狀
 * 完整、知道「呢粒係 0 唔係漏咗」）。 */
export function createGrossMarginTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "gross_margin",
    description:
      "毛利即時表——完整成本口徑（逐更工資＋雞頭費＋長工月薪分攤＋介紹費＋特別項目＋OT），逐盤本月至今營業額/成本/毛利/毛利率，同系統計好嘅總計（totals）。**凡問毛利／毛利率／成本／盈利（包括「全公司」「某個月」呢類問法）一律用呢個工具，唔准用 monthly_close 答**。要「毛利即時表:view」；數字另外跟收客價/出街價查閱權歸零。",
    inputSchema: z
      .object({
        month: monthParam,
        site: z.string().optional().describe("盤名稱關鍵字，唔填即全部盤"),
      })
      .strict(),
    run: async ({ month, site }) => {
      const denied = await requireModuleOrDenied(ctx, "毛利即時表");
      if (denied) return deniedResult(denied);

      const monthDate = new Date(`${month}-01T00:00:00.000Z`);
      const result = await buildGrossMargin(monthDate);
      const { clientRateVisible, settlementVisible } = ctx.fieldVisibility;

      let sites = result.sites;
      if (site) {
        const needle = site.toLowerCase();
        sites = sites.filter((s) => s.siteName.toLowerCase().includes(needle));
      }

      const shaped = sites.map((s) => ({
        siteName: s.siteName,
        billingModel: s.billingModel,
        shifts: s.shifts,
        revenue: clientRateVisible ? s.revenue : 0,
        cost: settlementVisible ? s.cost : 0,
        profit: clientRateVisible && settlementVisible ? s.profit : 0,
        marginPct: clientRateVisible && settlementVisible ? s.marginPct : null,
        belowThreshold: clientRateVisible && settlementVisible ? s.belowThreshold : false,
        note: s.note,
      }));

      const totals = {
        shifts: result.totals.shifts,
        revenue: clientRateVisible ? result.totals.revenue : 0,
        cost: settlementVisible ? result.totals.cost : 0,
        profit: clientRateVisible && settlementVisible ? result.totals.profit : 0,
        marginPct: clientRateVisible && settlementVisible ? result.totals.marginPct : null,
      };

      return toolResultJson({
        month: result.month,
        thresholdPct: result.thresholdPct,
        sites: shaped,
        totals,
        totals_note: "totals 已由系統計（完整成本口徑），答「全公司」「總計」呢類問題直接讀呢個 totals，唔好自己逐行加總。",
        note: clientRateVisible && settlementVisible ? undefined : "你嘅角色冇齊「收客價」／「出街價」查閱權，部分數字已歸零。",
      });
    },
  });
}
