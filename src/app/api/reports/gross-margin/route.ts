// P1-執行計劃.md §4 WP4 item 1：`GET /api/reports/gross-margin?month=`
// （`毛利即時表:view`）——每盤×更別一行＋盤小計＋全公司合計。
// `?export=1`（`毛利即時表:export`）＝xlsx 匯出。
//
// field-level gate：毛利表營業額／毛利屬「收客價」分組，成本明細屬
// 「出街價」分組（P1-執行計劃.md §4 WP4 item 1 原文）——呢個 report 係
// 手砌嘅聚合物件，唔係一個直接嘅 DB resource，冇對應
// `field-groups.ts` 嘅 `FieldGroupResource`，所以呢度手動用
// `hasPermission()` 做同一條原則嘅 gate（唔可以套用 `applyFieldGroupGate`，
// 但精神一致：冇「收客價:view」剝營業額/毛利/毛利率，冇「出街價:view」
// 剝成本/長工雞頭費/長工月薪分攤）。雞頭角色本身喺 matrix.ts 對
// 「毛利即時表」module 係硬性 ✗，connectPermission() 一早就 403 咗，
// 唔會行到呢度。
import fs from "node:fs";
import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { buildGrossMargin, writeGrossMarginXlsx, type GrossMarginSiteRow, type GrossMarginShiftTypeRow } from "@/lib/reports/gross-margin";
import { DEFAULT_REPORT_MONTH } from "@/lib/reports/monthly-close";
// WP-PRICE §3：頁頂「N 更未定价，金額未計入」Notice 要用嘅 additive 欄。
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";

function scrubShiftType(row: GrossMarginShiftTypeRow, canClient: boolean, canSettlement: boolean) {
  const out: Record<string, unknown> = { ...row };
  if (!canClient) {
    delete out.revenue;
    delete out.profit;
  }
  if (!canSettlement) {
    delete out.cost;
    delete out.profit;
  }
  return out;
}

// Opus 驗收 M1：`components`——逐盤逐項組成，令驗收可以直接逐盤對 SQL。
// revenue 子欄屬「收客價」分組，cost 子欄屬「出街價」分組，同盤級
// revenue/cost 用返同一條 gate 規則。
function scrubComponents(components: GrossMarginSiteRow["components"], canClient: boolean, canSettlement: boolean) {
  const out: Record<string, unknown> = {};
  if (canClient) out.revenue = components.revenue;
  if (canSettlement) out.cost = components.cost;
  return out;
}

function scrubSite(row: GrossMarginSiteRow, canClient: boolean, canSettlement: boolean) {
  const out: Record<string, unknown> = {
    ...row,
    shiftTypes: row.shiftTypes.map((st) => scrubShiftType(st, canClient, canSettlement)),
    components: scrubComponents(row.components, canClient, canSettlement),
  };
  if (!canClient) {
    delete out.revenue;
    delete out.profit;
    delete out.marginPct;
    delete out.belowThreshold;
  }
  if (!canSettlement) {
    delete out.cost;
    delete out.profit;
    delete out.referralFee;
    delete out.longtermSalaryAllocated;
    delete out.missingSalaryGuardRefs;
  }
  return out;
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "毛利即時表", "view");
    const url = new URL(req.url);
    const month = parseMonthParam(url.searchParams.get("month")) ?? undefined;
    const thresholdRaw = url.searchParams.get("threshold_pct");
    const thresholdPct = thresholdRaw !== null && !Number.isNaN(Number(thresholdRaw)) ? Number(thresholdRaw) : undefined;
    const isExport = url.searchParams.get("export") === "1";

    if (isExport) {
      await requirePermission(req, "毛利即時表", "export");
      const tmpPath = path.join(os.tmpdir(), `gross-margin-${Date.now()}.xlsx`);
      await writeGrossMarginXlsx(tmpPath, month, { thresholdPct });
      const buf = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="gross-margin.xlsx"`,
        },
      });
    }

    const [result, canClient, canSettlement, unpriced] = await Promise.all([
      buildGrossMargin(month, { thresholdPct }),
      hasPermission(session, "收客價", "view"),
      hasPermission(session, "出街價", "view"),
      buildUnpricedSummary(session, month ?? DEFAULT_REPORT_MONTH),
    ]);
    const sites = result.sites.map((s) => scrubSite(s, canClient, canSettlement));
    const totals: Record<string, unknown> = { ...result.totals };
    if (!canClient) {
      delete totals.revenue;
      delete totals.profit;
      delete totals.marginPct;
    }
    if (!canSettlement) {
      delete totals.cost;
      delete totals.profit;
    }
    const referralFeeUnattributed = canSettlement ? result.referralFeeUnattributed : undefined;
    const specialCostUnattributed = canSettlement ? result.specialCostUnattributed : undefined;
    const longtermSalaryTotalAllocatable = canSettlement ? result.longtermSalaryTotalAllocatable : undefined;
    return ok(
      brandSafeResponse({
        month: result.month,
        threshold_pct: result.thresholdPct,
        sites,
        totals,
        referral_fee_unattributed: referralFeeUnattributed,
        special_cost_unattributed: specialCostUnattributed,
        longterm_salary_total_allocatable: longtermSalaryTotalAllocatable,
        unpriced_count: unpriced.count,
        unpriced_groups: unpriced.groups,
        // 應修 1：獨立畀前端顯示「N 格冇結算單位」警告，唔同 unpriced_count
        // 混埋（computeUnpricedSummary() 口徑已經分開計，唔重複計入）。
        no_settlement_count: unpriced.noSettlementCount,
      }),
    );
  });
}
