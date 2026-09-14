// P2-B：更表索引「最近開過」列表（README §03）——最多 `limit`（預設 8，
// 上限 50）個盤，按呢個月最近有更表改動（shift_records.updated_at 最大
// 值）排序；呢個月完全冇 shift_records 嘅盤唔出（Opus 驗收 M3：唔再用
// broker_site_assignments 代替瀏覽歷史——單純有雞頭指派、冇實際排過更嘅
// 盤唔算「開過」）。
//
// 雞頭隔離：用現有 scopeShiftRecordWhere()——雞頭 session 淨係見到自己有
// 份（settlement_broker_id 或 operational_broker_id = 自己）嘅記錄，
// 人數／更數淨係計自己嘅。
//
// Opus 驗收 M1（最嚴重）：雞頭 session 嘅「尚欠」之前錯誤咁攞成盤（全部
// 雞頭加埋）嘅所需人手，減自己嘅更數，變成一個荒謬嘅大數（例：啟航1331
// 雞頭A 顯示「欠 825」）。決定：**雞頭 session 唔顯示尚欠**（`shortfall:
// null`，UI pill 只出「已鎖定」/「排更中」）——尚欠本身係盤級整體口徑
// （所有雞頭合埋嘅所需人手 vs 全部 confirmed 更次），雞頭見到呢個數字冇
// 意義之餘，仲會俾佢反推出盤總所需人手（其他雞頭嘅資訊），所以結構性
// 唔傳呢個欄俾雞頭 session，唔止「唔顯示」。
//
// Opus 驗收 M2：老闆／內部角色嘅尚欠口徑，同首頁尚欠總覽
// `buildShortfall()`（src/lib/reports/shortfall.ts）逐日嘅公式完全一致
// （`computeSiteDayShortfall()`，該檔案 additive export）——required 用
// daily_requirements override，冇就跌返 shift_type.headcount_required，
// 淨計 billing_group="per_shift" 嘅更別；逐日淨額（`Math.max(0, 當日
// required-confirmed)`）加總埋成個月，先至係呢度顯示嘅「本月尚欠」。
import { prisma } from "@/lib/db";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { scopeShiftRecordWhere, isBrokerRole } from "@/lib/broker-isolation";
import { monthRange, monthStart } from "./money";
import { computeSiteDayShortfall, type ShiftTypeForShortfall } from "./shortfall";

export type RosterOverviewSiteRow = {
  siteId: string;
  siteName: string;
  guardCount: number;
  shiftCount: number;
  locked: boolean;
  /** null＝雞頭 session（M1：結構性唔傳呢個盤級口徑俾雞頭）；否則係
   * 老闆／內部角色嘅「本月尚欠」（逐日淨額加總，見檔頭 M2 註解）。 */
  shortfall: number | null;
};

export type RosterOverviewResult = {
  month: string;
  sites: RosterOverviewSiteRow[];
};

export const ROSTER_OVERVIEW_DEFAULT_LIMIT = 8;
export const ROSTER_OVERVIEW_MAX_LIMIT = 50;

export async function buildRosterOverview(session: AuthedSession, month: Date, opts?: { limit?: number }): Promise<RosterOverviewResult> {
  const { start, end } = monthRange(month);
  const limit = Math.max(1, Math.min(opts?.limit ?? ROSTER_OVERVIEW_DEFAULT_LIMIT, ROSTER_OVERVIEW_MAX_LIMIT));

  // 1. 候選盤——呢個月有 shift_records（record_type=shift，排除
  // cancelled，同 broker-dashboard.ts／`/api/shift-records` 預設口徑
  // 一致）嘅盤，已按雞頭 scope；用 updated_at 最大值排「最近有更表改
  // 動」，淨取前 `limit` 個（M3）。
  const recentSiteRows = await prisma.shiftRecord.groupBy({
    by: ["siteId"],
    where: scopeShiftRecordWhere(session, { workDate: { gte: start, lte: end }, recordType: "shift", status: { not: "cancelled" } }),
    _max: { updatedAt: true },
  });
  recentSiteRows.sort((a, b) => (b._max.updatedAt?.getTime() ?? 0) - (a._max.updatedAt?.getTime() ?? 0));
  const siteIds = recentSiteRows.slice(0, limit).map((r) => r.siteId);
  if (siteIds.length === 0) return { month: month.toISOString().slice(0, 7), sites: [] };

  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } } });
  const siteById = new Map(sites.map((s) => [s.id, s]));

  // 2. 人數／更數——同一次 query 拎晒（已按雞頭 scope，雞頭見唔到其他
  // broker 嘅 guard/更次），排除 cancelled（M2 應修）。
  const records = await prisma.shiftRecord.findMany({
    where: scopeShiftRecordWhere(session, { siteId: { in: siteIds }, workDate: { gte: start, lte: end }, recordType: "shift", status: { not: "cancelled" } }),
    select: { siteId: true, guardId: true },
  });
  const guardSetBySite = new Map<string, Set<string>>();
  const shiftCountBySite = new Map<string, number>();
  for (const r of records) {
    shiftCountBySite.set(r.siteId, (shiftCountBySite.get(r.siteId) ?? 0) + 1);
    const set = guardSetBySite.get(r.siteId) ?? new Set<string>();
    set.add(r.guardId);
    guardSetBySite.set(r.siteId, set);
  }

  // 3. 鎖定狀態——月結一個月一行，唔分盤。
  const monthClose = await prisma.monthClose.findUnique({ where: { month: monthStart(month) }, select: { lockedAt: true } });
  const locked = !!monthClose?.lockedAt;

  // 4. 尚欠——M1：雞頭 session 結構性唔計（見檔頭註解），淨係內部角色
  // 先行呢一段。
  const shortfallBySite = new Map<string, number>();
  if (!isBrokerRole(session)) {
    const shiftTypes = await prisma.shiftType.findMany({ where: { siteId: { in: siteIds }, voidedAt: null } });
    const shiftTypesBySite = new Map<string, ShiftTypeForShortfall[]>();
    for (const st of shiftTypes) {
      const list = shiftTypesBySite.get(st.siteId) ?? [];
      list.push({ id: st.id, billingGroup: st.billingGroup, headcountRequired: st.headcountRequired });
      shiftTypesBySite.set(st.siteId, list);
    }

    const dailyReqs = await prisma.dailyRequirement.findMany({
      where: { siteId: { in: siteIds }, workDate: { gte: start, lte: end }, voidedAt: null },
    });
    const reqBySiteShiftTypeDay = new Map<string, number>(); // `${siteId}|${shiftTypeId}|${dateISO}` -> override
    for (const dr of dailyReqs) {
      reqBySiteShiftTypeDay.set(`${dr.siteId}|${dr.shiftTypeId}|${dr.workDate.toISOString()}`, dr.headcountRequired);
    }

    // confirmed——唔經 scopeShiftRecordWhere（M2：老闆／內部角色嘅尚欠係
    // 盤級整體口徑，同 buildShortfall() 一樣唔限單一雞頭），逐（盤，日）
    // 分組，同 buildShortfall() 嘅 confirmedToday 查詢一致（recordType=
    // shift, status confirmed/completed, isExternal=false，唔限
    // billingGroup）。
    const confirmed = await prisma.shiftRecord.groupBy({
      by: ["siteId", "workDate"],
      where: { siteId: { in: siteIds }, workDate: { gte: start, lte: end }, recordType: "shift", status: { in: ["confirmed", "completed"] }, isExternal: false },
      _count: { _all: true },
    });
    const confirmedBySiteDay = new Map<string, number>(); // `${siteId}|${dateISO}` -> count
    for (const c of confirmed) confirmedBySiteDay.set(`${c.siteId}|${c.workDate.toISOString()}`, c._count._all);

    for (const siteId of siteIds) {
      const siteShiftTypes = shiftTypesBySite.get(siteId) ?? [];
      let monthShortfall = 0;
      for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
        const dateISO = d.toISOString();
        const reqOverrideByShiftType = new Map<string, number>();
        for (const st of siteShiftTypes) {
          const v = reqBySiteShiftTypeDay.get(`${siteId}|${st.id}|${dateISO}`);
          if (v !== undefined) reqOverrideByShiftType.set(st.id, v);
        }
        const confirmedThatDay = confirmedBySiteDay.get(`${siteId}|${dateISO}`) ?? 0;
        const { shortfall } = computeSiteDayShortfall({ shiftTypes: siteShiftTypes, reqOverrideByShiftType, confirmed: confirmedThatDay });
        if (shortfall > 0) monthShortfall += shortfall; // 逐日淨額加總，唔俾人手夠曬嘅日子倒扣走其他日嘅尚欠
      }
      shortfallBySite.set(siteId, monthShortfall);
    }
  }

  return {
    month: month.toISOString().slice(0, 7),
    sites: siteIds
      .map((id) => siteById.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({
        siteId: s.id,
        siteName: s.canonicalName,
        guardCount: guardSetBySite.get(s.id)?.size ?? 0,
        shiftCount: shiftCountBySite.get(s.id) ?? 0,
        locked,
        shortfall: isBrokerRole(session) ? null : (shortfallBySite.get(s.id) ?? 0),
      })),
  };
}
