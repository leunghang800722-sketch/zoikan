// WP-AI-DIAG（§37.3）：診斷用唯讀工具——一鍵結算狀態／分診摘要／月結體檢／每月修正摘要／盤設定／定價解釋。
//
// 全部 `betaZodTool`、全部先 `requireModuleOrDenied()` 對應畫面 module（助手權限＝畫面權限）。回傳只有
// 數字＋id＋盤名／更種代號／雞頭顯示名，**冇保安員姓名／工號／電話**（投影喺 `src/lib/reports/ai-diagnostics.ts`
// 自己寫，唔直接回傳帶候選人資料嘅 view 物件）。工具本身冇任何寫入能力；「建議動作」靠回覆尾嘅 actions block，
// 由用戶喺畫面撳掣經現有 API 執行（見 src/lib/ai/actions.ts）。
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { scrubRowsForResource } from "../field-scrub";
import { hasPermission } from "../../rbac/requirePermission";
import {
  readOneClickStatus,
  readTriageSummary,
  readMonthHealth,
  readOpsDigest,
  readSiteSetup,
  readPricingExplain,
  monthFromYm,
} from "../../reports/ai-diagnostics";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

function currentHkMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

// 要「一鍵結算:view」（同 GET /api/month-close/one-click 一致）。
export function createOneClickStatusTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "one_click_status",
    description:
      "診斷「一鍵結算」：某個月最新一次執行嘅 10 步狀態、每步數字、要人手處理（needs_human）同警告原文，以及自動處理摘要（含「冇 Postorder 都計到嘅比例」）。用嚟答「呢個月一鍵結算點解卡住／邊步有問題／仲有幾多題未答」。要「一鍵結算:view」。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "一鍵結算");
      if (denied) return deniedResult(denied);
      return toolResultJson(await readOneClickStatus(monthFromYm(month), ctx.fieldVisibility));
    },
  });
}

// 要「導入分診:view」（同 /api/triage/sessions 一致）；非老闆只見自己嗰批。
export function createTriageSummaryTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "triage_summary",
    description:
      "某個月嘅待答問題（分診題）摘要：按類別／把握程度／狀態計數，加逐題 id、類別、狀態、盤、更種、雞頭顯示名同一句原因。唔包含任何保安員資料（保安員配對題只講格數）。用嚟答「呢個月仲有咩題未答／邊類題最多」。要「導入分診:view」。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "導入分診");
      if (denied) return deniedResult(denied);
      return toolResultJson(await readTriageSummary(monthFromYm(month), ctx.session));
    },
  });
}

// 要「月結總表:view」（同 /api/reports/month-health 一致）。
export function createMonthHealthTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "month_health",
    description:
      "鎖月前體檢：某個月嘅資料問題清單（未定價、冇結算單位、配對唔到、重疊更、盤收入／成本異常波動、缺資料…），每項帶代號、嚴重度、數量同說明。保安員層面明細一律唔出，只出數量；未定價／冇結算單位／OT 未定價另帶「盤×更種×雞頭」明細。要「月結總表:view」。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "月結總表");
      if (denied) return deniedResult(denied);
      return toolResultJson(await readMonthHealth(monthFromYm(month), ctx.session));
    },
  });
}

// 要「月結總表:view」（同 /api/reports/ops-digest 一致；唔經 ai-summary 子路由）。
export function createOpsDigestTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "ops_digest",
    description:
      "每月修正摘要：呢個月結算要人手／系統修正咗乜（保安員修復、對數決定、配對規則、價卡、更次修正、批量導入、特殊項、鎖月）加基線指標同連續出現嘅重複類別。冇人名／工號。要「月結總表:view」。",
    inputSchema: z.object({ month: monthParam }).strict(),
    run: async ({ month }) => {
      const denied = await requireModuleOrDenied(ctx, "月結總表");
      if (denied) return deniedResult(denied);
      return toolResultJson(await readOpsDigest(monthFromYm(month), ctx.session));
    },
  });
}

// 要「盤:view」；上載狀態另外要「更表上載:view」，冇就只回 withheld；價卡有冇客價／出街價跟收客價／出街價查閱權。
export function createSiteSetupTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "site_setup",
    description:
      "睇一個盤嘅設定是否齊全：更種、本月生效價目卡（只講有冇客價／出街價，唔講金額）、預設結算雞頭、本月更表上載狀態（份數＋狀態）、未配對／模糊配對格數。用嚟答「呢個盤點解計唔到數／未定價／冇雞頭」。要「盤:view」。",
    inputSchema: z
      .object({
        site: z.string().min(1).describe("盤名稱（或一部分）"),
        month: monthParam.optional().describe("月份 YYYY-MM，預設今個月"),
      })
      .strict(),
    run: async ({ site, month }) => {
      const denied = await requireModuleOrDenied(ctx, "盤");
      if (denied) return deniedResult(denied);
      const canViewUploads = await hasPermission(ctx.session, "更表上載", "view");
      return toolResultJson(await readSiteSetup(site, monthFromYm(month ?? currentHkMonth()), { vis: ctx.fieldVisibility, canViewUploads }));
    },
  });
}

// 新工具（唔擴充 explain_rate_card）：explain_rate_card 只解釋「一張已知 id 嘅價卡」，
// 呢個回答嘅係「某盤某更種（某雞頭）某月點解未定價／用咗邊張卡」，輸入唔同，所以另開。要「出街價:view」。
export function createPricingExplainTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "pricing_explain",
    description:
      "解釋某盤＋更種（＋雞頭）喺某月嘅定價狀況：有幾多更、幾多更未定價（出街價／收客價／冇結算單位）、有邊啲生效價目卡、價卡係咪一鍵結算自動建（用咗自動定價次序幾）、有冇 Postorder 來源，以及一句句「點解未定價」。與 explain_rate_card（已知價卡 id 解釋計法）互補。金額跟收客價／出街價查閱權。要「出街價:view」。",
    inputSchema: z
      .object({
        site: z.string().min(1).describe("盤名稱（或一部分）"),
        shift_type: z.string().min(1).describe("更種代號，例如 N／C／A"),
        broker: z.string().optional().describe("雞頭代號或顯示名（可選）"),
        month: monthParam,
      })
      .strict(),
    run: async ({ site, shift_type, broker, month }) => {
      const denied = await requireModuleOrDenied(ctx, "出街價");
      if (denied) return deniedResult(denied);
      const result = await readPricingExplain({ site, shiftType: shift_type, broker, month: monthFromYm(month) }, { session: ctx.session, vis: ctx.fieldVisibility });
      if ("rate_cards" in result && Array.isArray(result.rate_cards)) {
        // 價目卡金額按收客價／出街價查閱權歸零（同 rate_cards 工具一致）
        return toolResultJson({ ...result, rate_cards: scrubRowsForResource(result.rate_cards as Record<string, unknown>[], "rate_cards", ctx.fieldVisibility) });
      }
      return toolResultJson(result);
    },
  });
}
