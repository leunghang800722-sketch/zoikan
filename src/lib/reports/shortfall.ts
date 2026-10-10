// P1-WP4 §6.1 第 1 項／§3c：尚欠總覽——今日／本月各盤 confirmed vs
// daily_requirements，尚欠標紅；待審批數；本月毛利進度。
import { prisma } from "@/lib/db";
import { monthRange as sharedMonthRange, monthStart, monthLabel } from "./money";
import { buildGrossMargin, DEFAULT_MARGIN_THRESHOLD_PCT } from "./gross-margin";

type ShortfallSiteRow = {
  siteId: string;
  siteName: string;
  required: number;
  confirmed: number;
  shortfall: number; // required - confirmed，>0 標紅
};

export type ShortfallResult = {
  date: string;
  today: ShortfallSiteRow[];
  /** 本月（呢個 date 所屬月份）嘅待審批數——同首頁 KPI 副行「本月 X」口徑。 */
  pendingApprovalCount: number;
  /** P2 整合驗收應修③：additive 欄位——全部未審批數（唔篩月份），同
   * `/approvals` 頁／`(app)/layout.tsx` 側欄 badge 同一口徑（見嗰邊
   * 「R1 驗收修正」註解：嗰兩處刻意唔篩月份）。首頁 KPI 大數改用呢個
   * （見 `ShortfallDashboard.tsx`），避免同側欄 badge 數字對唔上。 */
  pendingApprovalTotal: number;
  monthProgress: {
    month: string;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number | null;
    thresholdPct: number;
    belowThresholdSiteCount: number;
  };
};

// P2-B M2（Opus 驗收）additive export：逐日、逐盤 per_shift 尚欠嘅公式，
// 由 `buildShortfall()`（下面，只計「今日」）抽出嚟俾 `buildRosterOverview()`
// （src/lib/reports/roster-overview.ts）逐日call、逐日加總算「本月」共用
// ——兩邊口徑要一致（同一條公式），唔可以各自維護一份會慢慢飄開嘅計法。
// 純計算、冇碰 DB，輸入（`shiftTypes`／`reqOverrideByShiftType`／
// `confirmed`）由 caller 自己按需要嘅粒度（單日 vs 成個月逐日）查好先
// 傳入。行為同呢個函數抽出之前嘅 `buildShortfall()` inline 版完全一樣，
// `buildShortfall()` 行為冇改（見下面 call site）。
export type ShiftTypeForShortfall = { id: string; billingGroup: string; headcountRequired: number | null };

/**
 * required(site, day) = Σ_{st ∈ 呢個盤 billing_group="per_shift" 嘅更別}
 *                       (daily_requirements override(site, st, day) ??
 *                        shift_type.headcount_required ?? 0)
 * confirmed(site, day) = 呢個盤呢一日 confirmed/completed 嘅 shift_records
 *                        總數（recordType=shift, isExternal=false；唔限
 *                        shiftType billingGroup——同 `buildShortfall()` 原本
 *                        inline 嘅 confirmedToday 查詢一致，status 清單本身
 *                        冇包含 cancelled，天然排除）。
 * 呢個函數本身唔 clamp——`required - confirmed` 可以係負數（人手夠曬/超額）；
 * `buildShortfall()`（今日單日）保留呢個負數（等 UI 可以分辨「岩夠」同
 * 「超額」，`today.sort()` 亦靠負數排到落尾）；`buildRosterOverview()`
 * （本月逐日加總）先喺 call site 做 `Math.max(0, …)` 淨計「淨欠」嗰啲日
 * （同呢個函數抽出之前 roster-overview.ts 原本嘅 `gap = Math.max(0, …)`
 * 邏輯一致，見該檔案）。
 */
export function computeSiteDayShortfall(params: {
  shiftTypes: ShiftTypeForShortfall[];
  reqOverrideByShiftType: Map<string, number>; // shiftTypeId -> 呢一日嘅 override
  confirmed: number;
}): { required: number; confirmed: number; shortfall: number } {
  let required = 0;
  for (const st of params.shiftTypes) {
    if (st.billingGroup !== "per_shift") continue;
    const override = params.reqOverrideByShiftType.get(st.id);
    required += override ?? st.headcountRequired ?? 0;
  }
  return { required, confirmed: params.confirmed, shortfall: required - params.confirmed };
}

/** 今日（或指定日期）逐盤所需人手 vs confirmed 更次——daily_requirements
 * 冇 override 就跌返用 shift_types.headcount_required（設計 §3.2 daily_
 * requirements「每日所需人手 override」，冇 override 用更別本身嘅預設）。 */
export type DayShortfallResult = Omit<ShortfallResult, "monthProgress">;

/** P3-2.2：日級部分（唔含「本月毛利進度」，唔跑毛利表）。 */
export async function buildDayShortfall(date: Date): Promise<DayShortfallResult> {
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const month = monthStart(dayStart);
  const { start: MONTH_START, end: MONTH_END } = sharedMonthRange(month);

  const sites = await prisma.site.findMany({ where: { inScope: true, status: "active" }, orderBy: { canonicalName: "asc" } });
  const shiftTypes = await prisma.shiftType.findMany({ where: { siteId: { in: sites.map((s) => s.id) }, voidedAt: null } });
  const dailyReqs = await prisma.dailyRequirement.findMany({ where: { workDate: dayStart, voidedAt: null } });
  const reqBySiteShiftType = new Map(dailyReqs.map((r) => [`${r.siteId}|${r.shiftTypeId}`, r.headcountRequired]));

  const confirmedToday = await prisma.shiftRecord.groupBy({
    by: ["siteId"],
    where: { workDate: dayStart, recordType: "shift", status: { in: ["confirmed", "completed"] }, isExternal: false },
    _count: { _all: true },
  });
  const confirmedBySite = new Map(confirmedToday.map((r) => [r.siteId, r._count._all]));

  const today: ShortfallSiteRow[] = [];
  for (const site of sites) {
    const siteShiftTypes = shiftTypes.filter((st) => st.siteId === site.id);
    const confirmed = confirmedBySite.get(site.id) ?? 0;
    const reqOverrideByShiftType = new Map(
      siteShiftTypes.filter((st) => reqBySiteShiftType.has(`${site.id}|${st.id}`)).map((st) => [st.id, reqBySiteShiftType.get(`${site.id}|${st.id}`)!]),
    );
    const { required, shortfall } = computeSiteDayShortfall({ shiftTypes: siteShiftTypes, reqOverrideByShiftType, confirmed });
    if (required === 0 && confirmed === 0) continue; // 冇任何所需人手都冇出勤嘅盤唔顯示，減噪音
    today.push({ siteId: site.id, siteName: site.canonicalName, required, confirmed, shortfall });
  }

  const pendingApprovalCount = await prisma.shiftRecord.count({
    where: { status: "pending_approval", workDate: { gte: MONTH_START, lte: MONTH_END } },
  });
  const pendingApprovalTotal = await prisma.shiftRecord.count({ where: { status: "pending_approval" } });

  return {
    date: dayStart.toISOString().slice(0, 10),
    today: today.sort((a, b) => b.shortfall - a.shortfall),
    pendingApprovalCount,
    pendingApprovalTotal,
  };
}

export type MarginProgress = ShortfallResult["monthProgress"];

/** P3-2.2：月級「本月毛利進度」——數字＝`buildGrossMargin(month).totals`（同毛利表同一把尺，
 * test 斷言相等）；每次叫都即時重計（老闆第 6 條：唔准 TTL／跨 request cache）。 */
export async function buildMarginProgress(month: Date): Promise<MarginProgress> {
  const monthFirst = monthStart(month);
  const margin = await buildGrossMargin(monthFirst);
  const belowThresholdSiteCount = margin.sites.filter((s) => s.belowThreshold).length;
  return {
    month: monthLabel(monthFirst),
    revenue: margin.totals.revenue,
    cost: margin.totals.cost,
    profit: margin.totals.profit,
    marginPct: margin.totals.marginPct,
    thresholdPct: margin.thresholdPct ?? DEFAULT_MARGIN_THRESHOLD_PCT,
    belowThresholdSiteCount,
  };
}

/** 日級＋月級（舊 `GET /api/reports/shortfall` 同 AI 工具用，行為同改動前一樣）。 */
export async function buildShortfall(date: Date): Promise<ShortfallResult> {
  const day = await buildDayShortfall(date);
  const monthProgress = await buildMarginProgress(date);
  return { ...day, monthProgress };
}
