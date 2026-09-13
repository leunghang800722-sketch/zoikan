import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson, brokerDisplayName, feeSplitStatus, FEE_SPLIT_NOTE, LONGTERM_PAYOUT_NOTE } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定）。
export function createSiteOverviewTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "site_overview",
    description:
      "睇一個盤喺某個月嘅概況：更別清單、每日所需人手、已排更數、逐雞頭人數分佈（broker_breakdown 帶 broker_display_name，答用戶一律用呢個顯示名，唔准用 broker_code；公司長工桶嘅出街價欄一律 null＋payout_note，唔准答出街價 0）。仲帶 latest_month_with_data（呢個盤最近有記錄嘅月份）——查嗰個月冇數就可以用嚟自動退一步答（唔使再問用戶）。用嚟答「呢個盤而家咩情況」「呢個盤幾多個雞頭嘅人」呢類問題。要「更表:view」。",
    inputSchema: z
      .object({
        site: z.string().describe("盤名稱（canonical_name 或 alias 嘅一部分，用 ILIKE 模糊搵）"),
        month: monthParam.describe("月份 YYYY-MM"),
      })
      .strict(),
    run: async ({ site, month }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const siteRows = (
        await aiQuery(
          `SELECT id, canonical_name, client_name, billing_model, status FROM ai.sites
           WHERE canonical_name ILIKE $1 OR $1 = ANY(aliases) LIMIT 5`,
          [`%${site}%`],
        )
      ).rows;
      if (siteRows.length === 0) {
        return toolResultJson({ error: "not_found", message: `搵唔到名稱包含「${site}」嘅盤` });
      }
      const siteRow = siteRows[0];

      const [shiftTypes, dailyReq, brokerCounts] = await Promise.all([
        aiQuery(`SELECT id, code, label, headcount_required, billing_group FROM ai.shift_types WHERE site_id = $1 AND voided_at IS NULL ORDER BY code`, [siteRow.id]),
        aiQuery(
          `SELECT shift_type_id, COUNT(*) AS days, SUM(headcount_required) AS total_headcount
           FROM ai.daily_requirements
           WHERE site_id = $1 AND work_date >= $2::date AND work_date < ($2::date + INTERVAL '1 month') AND voided_at IS NULL
           GROUP BY shift_type_id`,
          [siteRow.id, monthStart],
        ),
        aiQuery(
          `SELECT COALESCE(sr.operational_broker_id, sr.settlement_broker_id) AS broker_id, b.name AS broker_name, b.code AS broker_code, b.kind AS broker_kind,
                  COUNT(*) AS shift_count, COUNT(DISTINCT sr.guard_id) AS guard_count,
                  SUM(COALESCE(sr.guard_wage_snapshot, 0)) AS guard_wage_snapshot, SUM(COALESCE(sr.broker_fee_snapshot, 0)) AS broker_fee_snapshot
           FROM ai.shift_records sr
           LEFT JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
           WHERE sr.site_id = $1 AND sr.work_date >= $2::date AND sr.work_date < ($2::date + INTERVAL '1 month')
             AND sr.record_type = 'shift'
           GROUP BY 1, 2, 3, 4
           ORDER BY shift_count DESC`,
          [siteRow.id, monthStart],
        ),
      ]);

      // 系統計嘅總計——`shift_count` 逐雞頭相加就係呢個盤總更數（唔會
      // 重複，一個更次淨係屬於一個雞頭），`guard_count` 就唔可以逐行
      // 相加（同一個安員可能喺呢個盤下跨雞頭做過），所以另外用
      // `COUNT(DISTINCT guard_id)` 查一次去重總數。
      const totalShiftCount = brokerCounts.rows.reduce((sum, r) => sum + Number((r as { shift_count: unknown }).shift_count), 0);
      const { rows: guardTotalRows } = await aiQuery(
        `SELECT COUNT(DISTINCT sr.guard_id) AS guard_count
         FROM ai.shift_records sr
         WHERE sr.site_id = $1 AND sr.work_date >= $2::date AND sr.work_date < ($2::date + INTERVAL '1 month')
           AND sr.record_type = 'shift'`,
        [siteRow.id, monthStart],
      );
      const totalGuardCount = Number((guardTotalRows[0] as { guard_count?: unknown } | undefined)?.guard_count ?? 0);

      // 老闆 feedback（正式站助手）：逐雞頭加 `broker_display_name`
      // （業務用語／真名，唔准答用戶嗰陣照抄 `broker_code`）同
      // `fee_split`（部分盤啲卡源頭冇拆開保安員工資/雞頭費，見
      // `common.ts` 頂註解）——`fee_split` 要用返 scrub 之前嘅
      // `guard_wage_snapshot`/`broker_fee_snapshot` 先計得啱，`scrub
      // RowsForResource()` 跟住會用返 `SETTLEMENT_FIELDS.shift_records`
      // 嗰個現成 blocklist 剝走呢兩粒錢銀欄（`fee_split`/
      // `fee_split_note`/`broker_display_name` 唔喺 blocklist 度，唔會
      // 被剝走）。
      // 老闆 feedback：公司長工（internal_longterm）桶唔係逐更出街價，
      // guard_wage_snapshot/broker_fee_snapshot 對呢桶通常淨係 0（月薪
      // 唔係逐更 snapshot）——唔可以當「未拆」一齊回，否則模型會答
      // 「出街價 0」。逐桶獨立判斷：internal_longterm 就將呢兩粒錢銀欄
      // 回 null＋payout_note，唔再計 fee_split。
      const brokerBreakdownWithDisplay = brokerCounts.rows.map((r) => {
        const isInternalLongterm = r.broker_kind === "internal_longterm";
        const feeSplit = feeSplitStatus({ guardWage: r.guard_wage_snapshot, brokerFee: r.broker_fee_snapshot, payoutRate: null });
        return {
          ...r,
          guard_wage_snapshot: isInternalLongterm ? null : r.guard_wage_snapshot,
          broker_fee_snapshot: isInternalLongterm ? null : r.broker_fee_snapshot,
          broker_display_name: brokerDisplayName({ name: r.broker_name, code: r.broker_code, kind: r.broker_kind }),
          fee_split: isInternalLongterm ? null : feeSplit,
          fee_split_note: !isInternalLongterm && feeSplit === "combined" ? FEE_SPLIT_NOTE : null,
          payout_note: isInternalLongterm ? LONGTERM_PAYOUT_NOTE : null,
        };
      });

      // 老闆 feedback：空月份自動退一步——呢個盤最近一個有 shift_records
      // 嘅月份，等模型喺 `month` 冇數據嗰陣可以自己退一步答（system
      // prompt 已經加咗對應規則），唔使再問多一輪。
      const { rows: latestMonthRows } = await aiQuery(
        `SELECT to_char(MAX(work_date), 'YYYY-MM') AS latest_month FROM ai.shift_records WHERE site_id = $1`,
        [siteRow.id],
      );
      const latestMonthWithData = (latestMonthRows[0] as { latest_month?: string | null } | undefined)?.latest_month ?? null;

      return toolResultJson({
        site: siteRow,
        month,
        shift_types: shiftTypes.rows,
        daily_requirements_summary: dailyReq.rows,
        broker_breakdown: scrubRowsForResource(brokerBreakdownWithDisplay, "shift_records", ctx.fieldVisibility),
        latest_month_with_data: latestMonthWithData,
        totals: { shift_count: totalShiftCount, guard_count: totalGuardCount },
        totals_note: "totals 已由系統計（guard_count 已去重），唔好自己加總。",
      });
    },
  });
}
