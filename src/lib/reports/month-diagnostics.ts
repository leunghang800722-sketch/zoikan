// WP-MONTH-DIAG（老闆 2026-09-27 緊急）：正式站 8 月「重新對數全月」跑完
//之後，數字同 dev 端到端唔同（介紹費 9,030 而非 60,520；148 更未定價
// 集中喺啟航1331／城巴-柴灣；營業額 3,236,816 而非 3,304,416），老闆睇
// 唔到正式站 DB，操作員只可以用瀏覽器開 JSON——呢個 module 係
// `GET /api/diagnostics/month` 嘅純讀 DB loader，逐盤／逐雞頭／B07／
// 介紹費／未定價／上載／卡 一次過摘要。
//
// 鐵則：**冇任何人名／工號／電話**——全程用盤名／雞頭代號／數目／金額
// （同 scripts/gate/aug-e2e-check.ts 頂註解一致嘅紀律）。回應經
// `ok()`（camelToSnakeDeep）轉 snake_case，呢度全部用 camelCase 起。
//
// 每個 broker code（K/W/T/G/D/Y/B07…）刻意用**陣列**（`{ code, ... }`）
// 表達，唔用「code 做 object key」——`camelToSnakeDeep()`
// （src/lib/api/serialize.ts snakeKey()）會將單一大寫字母 key 錯誤轉做
// `_k`／`_b07` 呢類，用陣列先唔會撞正呢個轉換陷阱。
import { prisma } from "@/lib/db";
import { n, round2, monthRange } from "./money";
import { buildMonthlyClose } from "./monthly-close";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { OT_HOURLY_PRICING_FROM } from "@/lib/pricing/resolve-rate";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

// 老闆總表口徑（8 月）——正式站冇 `data/` 目錄，唔可以讀
// `data/2026-09/aug-payroll-trial/out/broker_settlement.json`，呢兩個
// 數字（金額＋雞頭代號本身唔係 PII）硬編碼做對照欄，見任務書。
export const EXPECTED_AUG_BY_UNIT: Record<string, number> = {
  K: 1_023_730,
  W: 173_370,
  T: 211_160,
  G: 56_220,
  D: 100_130,
  Y: 226_433,
};
export const EXPECTED_AUG_REFERRAL_FEE_TOTAL = 60_520;
const EXPECTED_BASELINE_MONTH = "2026-08";

const LONGTERM_BROKER_CODES = ["K", "W", "T", "G", "D", "Y"] as const;

function monthLabel(month: Date): string {
  return month.toISOString().slice(0, 7);
}

export interface MonthDiagnostics {
  month: string;
  brokers: Array<{
    code: string | null; // null = 未歸屬結算單位（settlement_broker_id IS NULL）
    kind: string | null;
    shiftCount: number;
    payoutTotal: number; // guard_wage_snapshot + broker_fee_snapshot，non-cancelled
    clientTotal: number; // client_rate_snapshot 合計
    nullWageCount: number;
    nullClientCount: number;
  }>;
  longterm: {
    activePosts: number;
    activePostsBySource: Array<{ source: string; count: number }>;
    longtermGuards: number; // employment_type longterm_*（現時 schema 只有 longterm_autopay）
    b07ShiftCount: number;
    /** reconcile 逐格判斷嘅 settlement reason（visa_sponsor／longterm_post／…）——
     * 呢個值只喺 reconcile 記憶體運算果一刻存在，`shift_records` 本身冇欄位存低（provenance
     * json 淨係 upload_id/row_id/version），所以呢度冇資料可以摘要，一律空陣列。 */
    shiftsBySettlementReason: Array<{ reason: string; count: number }>;
    longtermGuardRowsOnBrokerCode: number; // 長工安員嘅更仍然掛 K/W/T/G/D/Y 嘅數
    referralBrokerSetCount: number;
    referralBrokerNullCount: number;
  };
  referral: {
    items: Array<{ brokerCode: string | null; count: number; amount: number }>; // special_items(kind=referral_fee) 該月
    totalAmount: number;
    rates: Array<{ brokerCode: string; siteCount: number }>; // referral_fee_rates 該月／最近生效
  };
  unpriced: {
    count: number;
    payoutCount: number;
    clientCount: number;
    noSettlementCount: number;
    otUnpricedCount: number;
    topGroups: Array<{ siteId: string; siteName: string; brokerCode: string | null; shiftTypeCode: string; count: number }>;
  };
  sites: Array<{
    siteId: string;
    siteName: string;
    shiftCount: number;
    revenue: number;
    billingModel: string | null;
    hasFlatCard: boolean;
    activityProxy: string | null;
  }>;
  uploads: {
    activeCount: number;
    confirmedCount: number;
    rowsUnmatched: number;
    rowsAmbiguous: number;
    rowsUnresolved: number;
    reconcileAllRun: { status: string; startedAt: string; finishedAt: string | null; result: unknown } | null;
    guardFixRuns: Array<{ status: string; createdAt: string; summary: unknown }>;
    postorderUpload: { fileName: string; format: "csv" | "xlsm"; summary: unknown } | null;
    staffListUpload: { rowCount: number } | null;
  };
  cards: {
    activeByBrokerCode: Array<{ code: string | null; count: number }>; // null = 通用（broker_id IS NULL）
    activeBySite: Array<{ siteId: string; siteName: string; count: number }>;
    nullClientRateCount: number;
  };
  /** WP-BOSS5 驗收項 7（新增診斷）：本月 OT 記錄逐 `ot_hours` 值嘅分組
   * 摘要——用途：正式站部署後，操作員開 `GET /api/diagnostics/month?
   * month=2026-08` 確認 8 月冇「小時≠1 而且已定价」嘅 OT 記錄（§25.1
   * 起 OT snapshot 本身已經係「呢粒記錄嘅總金額」，gross-margin.ts 唔
   * 再 ×otHours；如果 8 月有呢類記錄，代表口徑轉咗，8 月毛利會變）。
   * 冇 PII——逐 `ot_hours` 值一組，唔係逐條記錄。 */
  ot: {
    /** OT 卡＝每小時价呢個新口徑生效日（同 resolve-rate.ts
     * `OT_HOURLY_PRICING_FROM` 一致，"YYYY-MM-DD"）。 */
    otHourlyPricingFrom: string;
    byHours: Array<{
      otHours: number | null; // null = 未填 ot_hours（未定价 OT）
      count: number;
      /** 三個 snapshot（client/guard_wage/broker_fee）任一非 null 就算 priced。 */
      pricedCount: number;
    }>;
  };
  expectedDevBaseline: {
    applicable: boolean; // 淨係 2026-08 先有意義（見任務書：呢個係 8 月總表口徑硬編碼）
    byUnit: Array<{ code: string; expectedAmount: number; systemAmount: number; diff: number }>;
    referralFeeTotal: { expectedAmount: number; systemAmount: number; diff: number };
  };
}

export async function buildMonthDiagnostics(_session: AuthedSession, month: Date): Promise<MonthDiagnostics> {
  const { start, end } = monthRange(month);

  const [allBrokers, allSites] = await Promise.all([
    prisma.broker.findMany({ select: { id: true, code: true, kind: true } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true, billingModel: true, activityProxySiteId: true } }),
  ]);
  const brokerById = new Map(allBrokers.map((b) => [b.id, b]));
  const siteById = new Map(allSites.map((s) => [s.id, s]));

  // ---------------------------------------------------------------------
  // brokers：逐雞頭更數／應付（非 cancelled，shift+ot）
  // ---------------------------------------------------------------------
  const brokerAgg = await prisma.shiftRecord.groupBy({
    by: ["settlementBrokerId"],
    where: { recordType: { in: ["shift", "ot"] }, status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    _count: { _all: true, guardWageSnapshot: true, clientRateSnapshot: true },
    _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true, clientRateSnapshot: true },
  });
  const brokers = brokerAgg
    .map((g) => {
      const broker = g.settlementBrokerId ? brokerById.get(g.settlementBrokerId) : undefined;
      return {
        code: broker?.code ?? null,
        kind: broker?.kind ?? null,
        shiftCount: g._count._all,
        payoutTotal: round2(n(g._sum.guardWageSnapshot) + n(g._sum.brokerFeeSnapshot)),
        clientTotal: round2(n(g._sum.clientRateSnapshot)),
        nullWageCount: g._count._all - g._count.guardWageSnapshot,
        nullClientCount: g._count._all - g._count.clientRateSnapshot,
      };
    })
    .sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~"));

  // ---------------------------------------------------------------------
  // longterm
  // ---------------------------------------------------------------------
  const longtermPostWhere = { voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] };
  const [activePosts, postsBySource, longtermGuards, referralSet, referralNull, ltRowsOnBrokerCode] = await Promise.all([
    prisma.guardLongtermPost.count({ where: longtermPostWhere }),
    prisma.guardLongtermPost.groupBy({ by: ["source"], where: longtermPostWhere, _count: true }),
    prisma.guard.count({ where: { employmentType: "longterm_autopay" } }),
    prisma.guard.count({ where: { employmentType: "longterm_autopay", referralBrokerId: { not: null } } }),
    prisma.guard.count({ where: { employmentType: "longterm_autopay", referralBrokerId: null } }),
    prisma.shiftRecord.count({
      where: {
        workDate: { gte: start, lte: end },
        status: { not: "cancelled" },
        recordType: { in: ["shift", "ot"] },
        guard: { employmentType: "longterm_autopay" },
        settlementBroker: { code: { in: [...LONGTERM_BROKER_CODES] } },
      },
    }),
  ]);
  const b07Entry = brokers.find((b) => b.kind === "internal_longterm");

  const longterm: MonthDiagnostics["longterm"] = {
    activePosts,
    activePostsBySource: postsBySource.map((s) => ({ source: s.source, count: s._count })),
    longtermGuards,
    b07ShiftCount: b07Entry?.shiftCount ?? 0,
    shiftsBySettlementReason: [],
    longtermGuardRowsOnBrokerCode: ltRowsOnBrokerCode,
    referralBrokerSetCount: referralSet,
    referralBrokerNullCount: referralNull,
  };

  // ---------------------------------------------------------------------
  // referral：special_items(kind=referral_fee) 該月 + referral_fee_rates
  // 該月／最近生效 by broker
  // ---------------------------------------------------------------------
  const referralItemsAgg = await prisma.specialItem.groupBy({
    by: ["brokerId"],
    where: { month: start, kind: "referral_fee", voidedAt: null },
    _count: { _all: true },
    _sum: { cost: true },
  });
  const referralItems = referralItemsAgg.map((g) => ({
    brokerCode: g.brokerId ? (brokerById.get(g.brokerId)?.code ?? null) : null,
    count: g._count._all,
    amount: round2(n(g._sum.cost)),
  }));
  const referralTotalAmount = round2(referralItems.reduce((a, i) => a + i.amount, 0));

  // 跟 src/lib/reports/referral-fee.ts computeReferralFeesForMonth() 同一
  // 手法：逐 (broker,site) 揀 <= 目標月份入面最新一個月嘅費率。
  const ratesUpToMonth = await prisma.referralFeeRate.findMany({
    where: { month: { lte: start }, voidedAt: null },
    select: { brokerId: true, siteId: true, month: true },
    orderBy: { month: "asc" },
  });
  const latestRateKeyByBrokerSite = new Map<string, { brokerId: string; siteId: string | null }>();
  for (const r of ratesUpToMonth) latestRateKeyByBrokerSite.set(`${r.brokerId}|${r.siteId ?? ""}`, { brokerId: r.brokerId, siteId: r.siteId });
  const siteCountByBroker = new Map<string, number>();
  for (const { brokerId } of latestRateKeyByBrokerSite.values()) siteCountByBroker.set(brokerId, (siteCountByBroker.get(brokerId) ?? 0) + 1);
  const referralRates = [...siteCountByBroker.entries()]
    .map(([brokerId, siteCount]) => ({ brokerCode: brokerById.get(brokerId)?.code ?? "(未知)", siteCount }))
    .sort((a, b) => a.brokerCode.localeCompare(b.brokerCode));

  // ---------------------------------------------------------------------
  // unpriced：跟更表編輯器／糧明細共用嘅 computeUnpricedSummary() 口徑
  // ---------------------------------------------------------------------
  const unpricedSummary = await buildUnpricedSummary(_session, month);
  const topGroupMap = new Map<string, { siteId: string; siteName: string; brokerCode: string | null; shiftTypeCode: string; count: number }>();
  for (const g of unpricedSummary.groups) {
    const key = `${g.site_id}|${g.broker_code ?? ""}|${g.shift_type_code}`;
    const existing = topGroupMap.get(key);
    if (existing) existing.count += g.count;
    else topGroupMap.set(key, { siteId: g.site_id, siteName: g.site_name, brokerCode: g.broker_code, shiftTypeCode: g.shift_type_code, count: g.count });
  }
  const topGroups = [...topGroupMap.values()].sort((a, b) => b.count - a.count).slice(0, 20);

  // ---------------------------------------------------------------------
  // sites：同月結總表口徑（buildMonthlyClose）逐盤更數／收入
  // ---------------------------------------------------------------------
  const { mainRows, outsideRows } = await buildMonthlyClose(month);
  const closeRows = [...mainRows, ...outsideRows].filter((r) => !r.siteId.startsWith("special:"));
  const flatCards = closeRows.length
    ? await prisma.rateCard.findMany({
        where: {
          siteId: { in: closeRows.map((r) => r.siteId) },
          shiftTypeId: null,
          brokerId: null,
          guardId: null,
          billingModel: { in: ["monthly_fixed", "admin_fee", "special"] },
          effectiveFrom: { lte: end },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
          voidedAt: null,
        },
        select: { siteId: true },
      })
    : [];
  const flatCardSiteIds = new Set(flatCards.map((c) => c.siteId));
  const sites = closeRows.map((r) => {
    const site = siteById.get(r.siteId);
    const proxy = site?.activityProxySiteId ? (siteById.get(site.activityProxySiteId)?.canonicalName ?? site.activityProxySiteId) : null;
    return {
      siteId: r.siteId,
      siteName: r.canonicalName,
      shiftCount: r.shifts,
      revenue: r.revenue,
      billingModel: site?.billingModel ?? null,
      hasFlatCard: flatCardSiteIds.has(r.siteId),
      activityProxy: proxy,
    };
  });

  // ---------------------------------------------------------------------
  // uploads
  // ---------------------------------------------------------------------
  const activeUploads = await prisma.rosterUpload.findMany({ where: { month: start, voidedAt: null }, select: { id: true, status: true } });
  const activeUploadIds = activeUploads.map((u) => u.id);
  const confirmedCount = activeUploads.filter((u) => u.status === "confirmed").length;

  const [rowMatchAgg, unresolvedCount, reconcileAllRun, guardFixRuns, postorderUpload, staffListUpload] = await Promise.all([
    activeUploadIds.length
      ? prisma.rosterUploadRow.groupBy({ by: ["guardMatch"], where: { uploadId: { in: activeUploadIds } }, _count: true })
      : Promise.resolve([] as Array<{ guardMatch: string; _count: number }>),
    activeUploadIds.length
      ? prisma.rosterReconcileDecision.count({ where: { uploadId: { in: activeUploadIds }, category: "unresolved" } })
      : Promise.resolve(0),
    prisma.reconcileAllRun.findFirst({ where: { month: start }, orderBy: { startedAt: "desc" } }),
    prisma.guardFixRun.findMany({ where: { month: start }, orderBy: { createdAt: "desc" }, take: 3, select: { status: true, createdAt: true, summaryJson: true } }),
    prisma.postorderUpload.findFirst({
      where: { month: start, status: "parsed" },
      orderBy: { uploadedAt: "desc" },
      select: { fileName: true, parseSummary: true, rosterCsvBytes: true, postorderCsvBytes: true },
    }),
    prisma.staffListUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { rowCount: true } }),
  ]);
  const rowsUnmatched = rowMatchAgg.find((g) => g.guardMatch === "unmatched")?._count ?? 0;
  const rowsAmbiguous = rowMatchAgg.find((g) => g.guardMatch === "ambiguous")?._count ?? 0;

  const uploads: MonthDiagnostics["uploads"] = {
    activeCount: activeUploads.length,
    confirmedCount,
    rowsUnmatched,
    rowsAmbiguous,
    rowsUnresolved: unresolvedCount,
    reconcileAllRun: reconcileAllRun
      ? { status: reconcileAllRun.status, startedAt: reconcileAllRun.startedAt.toISOString(), finishedAt: reconcileAllRun.finishedAt?.toISOString() ?? null, result: reconcileAllRun.resultJson }
      : null,
    guardFixRuns: guardFixRuns.map((r) => ({ status: r.status, createdAt: r.createdAt.toISOString(), summary: r.summaryJson })),
    postorderUpload: postorderUpload
      ? { fileName: postorderUpload.fileName, format: postorderUpload.rosterCsvBytes || postorderUpload.postorderCsvBytes ? "csv" : "xlsm", summary: postorderUpload.parseSummary }
      : null,
    staffListUpload: staffListUpload ? { rowCount: staffListUpload.rowCount } : null,
  };

  // ---------------------------------------------------------------------
  // cards：該月生效卡數
  // ---------------------------------------------------------------------
  const cardWhere = { effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }], voidedAt: null };
  const [cardsByBroker, cardsBySite, nullClientRateCount] = await Promise.all([
    prisma.rateCard.groupBy({ by: ["brokerId"], where: cardWhere, _count: true }),
    prisma.rateCard.groupBy({ by: ["siteId"], where: cardWhere, _count: true }),
    prisma.rateCard.count({ where: { ...cardWhere, clientRate: null } }),
  ]);
  const cards: MonthDiagnostics["cards"] = {
    activeByBrokerCode: cardsByBroker
      .map((g) => ({ code: g.brokerId ? (brokerById.get(g.brokerId)?.code ?? null) : null, count: g._count }))
      .sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~")),
    activeBySite: cardsBySite
      .map((g) => ({ siteId: g.siteId, siteName: siteById.get(g.siteId)?.canonicalName ?? g.siteId, count: g._count }))
      .sort((a, b) => b.count - a.count),
    nullClientRateCount,
  };

  // ---------------------------------------------------------------------
  // ot（WP-BOSS5 驗收項 7）：逐 ot_hours 值分組摘要——寧願逐記錄喺記憶體
  // 分（唔用 Prisma groupBy on Decimal 欄，避免逐個唔同 Decimal 精度都
  // 分開一組），一個月嘅 OT 記錄量細，冇效能顧慮。
  // ---------------------------------------------------------------------
  const otRecords = await prisma.shiftRecord.findMany({
    where: { recordType: "ot", status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    select: { otHours: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true },
  });
  const otByHoursMap = new Map<string, { otHours: number | null; count: number; pricedCount: number }>();
  for (const r of otRecords) {
    const hours = r.otHours === null ? null : n(r.otHours);
    const key = hours === null ? "null" : String(hours);
    const priced = r.clientRateSnapshot !== null || r.guardWageSnapshot !== null || r.brokerFeeSnapshot !== null;
    const entry = otByHoursMap.get(key) ?? { otHours: hours, count: 0, pricedCount: 0 };
    entry.count += 1;
    if (priced) entry.pricedCount += 1;
    otByHoursMap.set(key, entry);
  }
  const ot: MonthDiagnostics["ot"] = {
    otHourlyPricingFrom: OT_HOURLY_PRICING_FROM.toISOString().slice(0, 10),
    byHours: [...otByHoursMap.values()].sort((a, b) => (a.otHours ?? -1) - (b.otHours ?? -1)),
  };

  // ---------------------------------------------------------------------
  // expected_dev_baseline：8 月總表口徑硬編碼對照（見任務書——正式站冇
  // data/ 目錄，唔可以讀 aug-payroll-trial JSON）。淨係 2026-08 有意義。
  // ---------------------------------------------------------------------
  const applicable = monthLabel(month) === EXPECTED_BASELINE_MONTH;
  const systemByCode = new Map(brokers.map((b) => [b.code, b.payoutTotal]));
  const expectedDevBaseline: MonthDiagnostics["expectedDevBaseline"] = {
    applicable,
    byUnit: Object.entries(EXPECTED_AUG_BY_UNIT).map(([code, expectedAmount]) => {
      const systemAmount = systemByCode.get(code) ?? 0;
      return { code, expectedAmount, systemAmount, diff: round2(systemAmount - expectedAmount) };
    }),
    referralFeeTotal: {
      expectedAmount: EXPECTED_AUG_REFERRAL_FEE_TOTAL,
      systemAmount: referralTotalAmount,
      diff: round2(referralTotalAmount - EXPECTED_AUG_REFERRAL_FEE_TOTAL),
    },
  };

  return {
    month: monthLabel(month),
    brokers,
    longterm,
    referral: { items: referralItems, totalAmount: referralTotalAmount, rates: referralRates },
    unpriced: {
      count: unpricedSummary.count,
      payoutCount: unpricedSummary.payoutCount,
      clientCount: unpricedSummary.clientCount,
      noSettlementCount: unpricedSummary.noSettlementCount,
      otUnpricedCount: unpricedSummary.otUnpricedCount,
      topGroups,
    },
    sites,
    uploads,
    cards,
    ot,
    expectedDevBaseline,
  };
}
