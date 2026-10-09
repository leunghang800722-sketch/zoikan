// WP-PRICE §3：「未定价」逐組統計——`GET /api/shift-records/unpriced` 同
// 更表編輯器／糧明細／本月應收／毛利即時表／月結工作台嘅頁頂 Notice
// 共用同一份邏輯，唔准逐處各執一詞。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { scopeShiftRecordWhere } from "@/lib/broker-isolation";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { isUnpricedShift, isClientUnpricedShift, type BrokerKindLike } from "./resolve-rate";
import type { Prisma } from "@prisma/client";
import { isMixedBillingMonth, isExplicitPerShiftType, loadMixedBillingInfo, type MixedBillingSiteInfo } from "@/lib/reports/mixed-billing";

// S3：未定价分兩類——payout_unpriced（出街价未定，舊有口徑，加咗
// wage=0&&fee=null）／client_unpriced（收客价未定，淨係逐更盤先算，見
// isClientUnpricedShift()）。`category` 令前端 Notice 可以分開講兩件事，
// `count`/`groups`（向下相容，冇 filter 就係兩類合計）保留舊形狀。
// P0（Opus 驗收重現）：`no_settlement`——`settlement_broker_id` 直情
// NULL 嘅記錄（唔止「未定价」，係喺 `buildPayrollTotals()` 逐 broker 查
// 嗰陣**完全唔會出現**喺任何一個 broker 嘅明細，糧單見唔到呢批更）。
// 同 `payout_unpriced`/`client_unpriced` 獨立計（唔互相排斥——冇結算
// 單位嘅記錄通常都會同時係 payout_unpriced，但呢個分類專門畀用戶睇到
// 「呢批更連邊個雞頭都未定，仲未計『有雞頭但未定价』果種」）。
//
// WP-MIXED-BILLING（老闆 2026-09-24 答：OT 冇統一公式，個個盤個個人都
// 唔同，系統唔准自動套公式計 OT 价）：`ot_unpriced`——OT 記錄（record_
// type=ot）完全冇任何 client/guard/fee snapshot（冇 OT 更種嘅 rate card
// 都冇人手輸入）——同 `payout_unpriced`/`client_unpriced` 嗰套「拆開睇
// 出街/收客邊個未定」唔同口徑，OT 淨係一個粗口徑「呢條 OT 記錄完全未
// 定价」，前端報表頂部顯示數目（見 gross-margin.ts）。**只對 2026-08
// 起嘅月份計**（`buildUnpricedSummary()` 淨係喺 month>=8 月先將 OT 記錄
// 攞埋落嚟——7 月 OT 記錄嘅 snapshot 一直由 seed 直接寫入，唔經呢個新
// 分類，7 月 gate 唔變）。
export type UnpricedCategory = "payout_unpriced" | "client_unpriced" | "no_settlement" | "ot_unpriced";

export type UnpricedGroup = {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  category: UnpricedCategory;
  count: number;
};

export type UnpricedSummary = {
  count: number;
  groups: UnpricedGroup[];
  /** S3：分類合計——payout（出街价未定）／client（收客价未定，淨係逐更盤）。 */
  payoutCount: number;
  clientCount: number;
  /** P0：冇結算單位（settlement_broker_id NULL）嘅記錄數——呢批更喺
   * 糧明細會完全消失，唔止未定价咁簡單，前端要獨立高亮。 */
  noSettlementCount: number;
  /** WP-MIXED-BILLING：完全未定价嘅 OT 記錄數（見上面 `ot_unpriced` 註解，
   * 只計 2026-08 起嘅月份）。 */
  otUnpricedCount: number;
};

/** 必修 2（Opus 第二輪驗收）：`computeUnpricedSummary()` 抽出嚟做純函數——
 * `buildUnpricedSummary()`（真正 DB 讀）同 `POST /api/shift-records/
 * reprice`（見 src/app/api/shift-records/reprice/route.ts）兩邊都要用
 * *同一份* 「未定价」判斷邏輯（`isUnpricedShift`／`isClientUnpricedShift`），
 * 唔可以各執一詞——reprice 嘅 dry-run 冇寫 DB，攞唔到「寫入之後」嘅
 * snapshot，所以淨係 `buildUnpricedSummary()` 做唔到（一定要打 DB）；
 * 抽呢個純函數出嚟等 reprice 用「模擬寫入之後」嘅記錄（after 值）一樣
 * 過返呢度計，保證口徑（邊條算未定价）永遠同 `buildUnpricedSummary()`
 * 一致，唔會有兩套邏輯飄開。 */
export type UnpricedRecordLike = {
  siteId: string;
  shiftTypeId: string;
  settlementBrokerId: string | null;
  status: string;
  // WP-MIXED-BILLING：加 `recordType`——`ot_unpriced` 判斷要分得出邊條
  // 係 OT 記錄。冇傳（向下相容舊 call site）當 "shift"。
  recordType?: string;
  guardWageSnapshot: unknown;
  brokerFeeSnapshot: unknown;
  clientRateSnapshot: unknown;
  isExternal: boolean;
};

/** WP-MIXED-BILLING（Opus 5.5 驗收）：盤有 flat 收入、而呢個 per_shift 更種冇「逐更另收」卡＝收入已包喺月費。 */
export function includedInSiteFlatFee(info: MixedBillingSiteInfo | undefined, shiftTypeId: string): boolean {
  if (!info || !info.hasFlatRevenue) return false;
  return !isExplicitPerShiftType(info, shiftTypeId);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const num = Number((v as { toString(): string }).toString());
  return Number.isNaN(num) ? null : num;
}
export type UnpricedLookups = {
  brokerKindById: Map<string, BrokerKindLike>;
  brokerCodeById: Map<string, string | null>;
  siteNameById: Map<string, string>;
  siteBillingModelById: Map<string, string | null>;
  shiftTypeCodeById: Map<string, string>;
  shiftTypeBillingGroupById: Map<string, string>;
  // WP-MISC（老闆 2026-09-20 拍板）：LINK（TKO Gateway 厚A/B/C）呢類
  // 「客戶直接出糧」嘅盤——true 嘅盤一律唔算未定价（payout 同 client
  // 都唔算），見 resolve-rate.ts isUnpricedShift()／isClientUnpricedShift()。
  siteGuardsPaidByClientById: Map<string, boolean>;
  /** WP-MIXED-BILLING（Opus 5.5 驗收）：8 月起「月費盤邊啲 per_shift 更種
   * 逐更另收」（`src/lib/reports/mixed-billing.ts`）。冇傳就沿用 7 月舊
   * 「盤層面豁免」（保守，唔會多報）。 */
  mixedBillingInfoBySiteId?: Map<string, MixedBillingSiteInfo>;
};

export function computeUnpricedSummary(records: UnpricedRecordLike[], lookups: UnpricedLookups, opts: { month?: Date | null } = {}): UnpricedSummary {
  const groups = new Map<string, UnpricedGroup>();
  let count = 0;
  let payoutCount = 0;
  let clientCount = 0;
  let noSettlementCount = 0;
  function addToGroup(r: UnpricedRecordLike, category: UnpricedCategory, brokerCode: string | null, siteName: string, shiftTypeCode: string) {
    const key = `${category}|${r.siteId}|${r.shiftTypeId}|${r.settlementBrokerId ?? "none"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, {
        site_id: r.siteId,
        site_name: siteName,
        shift_type_code: shiftTypeCode,
        broker_code: brokerCode,
        broker_display: brokerCode ?? "冇雞頭",
        category,
        count: 1,
      });
    }
  }
  let otUnpricedCount = 0;
  for (const r of records) {
    const recordType = r.recordType ?? "shift";
    const guardsPaidByClient = lookups.siteGuardsPaidByClientById.get(r.siteId) ?? false;

    // P0：冇結算單位——同 payout/client/ot 獨立計，唔理會呢兩個 flag
    // （LINK 客戶直接出糧盤本身就冇結算單位嘅概念，`guardsPaidByClient`
    // 一樣要剔走，唔誤報）。搬到迴圈頂，OT 記錄都要計（下面 `continue`
    // 之前）。
    if (!guardsPaidByClient && r.settlementBrokerId === null) {
      noSettlementCount++;
      const shiftTypeCode = lookups.shiftTypeCodeById.get(r.shiftTypeId) ?? r.shiftTypeId.slice(0, 8);
      const siteName = lookups.siteNameById.get(r.siteId) ?? r.siteId.slice(0, 8);
      addToGroup(r, "no_settlement", null, siteName, shiftTypeCode);
    }

    // WP-MIXED-BILLING：OT 記錄獨立分類——唔行落面 payout_unpriced／
    // client_unpriced 嗰套邏輯（嗰套係為 record_type=shift 設計，「出街
    // 价未定」／「收客价未定」拆開睇嘅概念對 OT 唔啱用）。OT 淨係一個
    // 粗口徑：完全冇任何 client/guard/fee snapshot（冇 OT 更種嘅 rate
    // card，都冇人手輸入）就算「未定价 OT」。`buildUnpricedSummary()`
    // 淨係喺 2026-08 起嘅月份先將 OT 記錄攞埋落嚟餵呢個函數（見嗰邊
    // `includeOt` gate），所以呢度唔使再判斷月份。
    if (recordType === "ot") {
      if (r.status !== "cancelled" && !guardsPaidByClient) {
        const feeNull = r.brokerFeeSnapshot === null || r.brokerFeeSnapshot === undefined;
        const wage = numOrNull(r.guardWageSnapshot);
        const client = numOrNull(r.clientRateSnapshot);
        const wageNullOrZero = wage === null || wage === 0;
        if (feeNull && wageNullOrZero && client === null) {
          count++;
          otUnpricedCount++;
          const shiftTypeCode = lookups.shiftTypeCodeById.get(r.shiftTypeId) ?? r.shiftTypeId.slice(0, 8);
          const siteName = lookups.siteNameById.get(r.siteId) ?? r.siteId.slice(0, 8);
          const brokerCode = r.settlementBrokerId ? (lookups.brokerCodeById.get(r.settlementBrokerId) ?? null) : null;
          addToGroup(r, "ot_unpriced", brokerCode, siteName, shiftTypeCode);
        }
      }
      continue;
    }

    const brokerKind: BrokerKindLike = r.settlementBrokerId ? (lookups.brokerKindById.get(r.settlementBrokerId) ?? null) : null;
    const shiftTypeBillingGroup = lookups.shiftTypeBillingGroupById.get(r.shiftTypeId) ?? "per_shift";
    const payoutUnpriced = isUnpricedShift(
      { recordType: "shift", status: r.status, guardWageSnapshot: r.guardWageSnapshot, brokerFeeSnapshot: r.brokerFeeSnapshot, isExternal: r.isExternal },
      brokerKind,
      { guardsPaidByClient },
    );
    const clientUnpriced = isClientUnpricedShift(
      { recordType: "shift", status: r.status, clientRateSnapshot: r.clientRateSnapshot, isExternal: r.isExternal },
      shiftTypeBillingGroup,
      // WP-MIXED-BILLING：`opts.month` 帶落去俾 isClientUnpricedShift()
      // 判斷「盤層面豁免」淨係 2026-08 之前先適用（見嗰個函數註解）。
      {
        siteBillingModel: lookups.siteBillingModelById.get(r.siteId) ?? null,
        brokerKind,
        guardsPaidByClient,
        month: opts.month ?? null,
        includedInSiteFlatFee: lookups.mixedBillingInfoBySiteId ? includedInSiteFlatFee(lookups.mixedBillingInfoBySiteId.get(r.siteId), r.shiftTypeId) : undefined,
      },
    );
    if (!payoutUnpriced && !clientUnpriced) continue;
    count++;
    const shiftTypeCode = lookups.shiftTypeCodeById.get(r.shiftTypeId) ?? r.shiftTypeId.slice(0, 8);
    const siteName = lookups.siteNameById.get(r.siteId) ?? r.siteId.slice(0, 8);
    const brokerCode = r.settlementBrokerId ? (lookups.brokerCodeById.get(r.settlementBrokerId) ?? null) : null;
    if (payoutUnpriced) {
      payoutCount++;
      addToGroup(r, "payout_unpriced", brokerCode, siteName, shiftTypeCode);
    }
    if (clientUnpriced) {
      clientCount++;
      addToGroup(r, "client_unpriced", brokerCode, siteName, shiftTypeCode);
    }
  }
  return {
    count,
    payoutCount,
    clientCount,
    noSettlementCount,
    otUnpricedCount,
    groups: [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || a.site_name.localeCompare(b.site_name) || a.shift_type_code.localeCompare(b.shift_type_code)),
  };
}

// WP-MIXED-BILLING：OT 記錄（record_type=ot）要計「未定价 OT」——但淨係
// 2026-08 起嘅月份先計（7 月 OT 記錄嘅 snapshot 一直由 seed 直接寫入，唔
// 經新嘅 ot_unpriced 分類，見 unpriced.ts 頂註解）。

export async function buildUnpricedSummary(session: AuthedSession, month: Date, siteId?: string | null, brokerId?: string | null): Promise<UnpricedSummary> {
  const { start, end } = monthRange(month);
  const includeOt = isMixedBillingMonth(month);
  let where: Prisma.ShiftRecordWhereInput = {
    recordType: includeOt ? { in: ["shift", "ot"] } : "shift",
    status: { not: "cancelled" },
    workDate: { gte: start, lte: end },
    ...(siteId ? { siteId } : {}),
    // P2-B「本月應收」`?broker=` 預覽分支用——內部角色 session 本身唔經
    // scopeShiftRecordWhere() 隔離，呢個參數等預覽某個雞頭嗰陣淨係計
    // 佢自己嘅未定价（唔係全公司）。
    ...(brokerId ? { settlementBrokerId: brokerId } : {}),
  };
  where = scopeShiftRecordWhere(session, where);

  const records = await prisma.shiftRecord.findMany({
    where,
    select: {
      id: true,
      status: true,
      recordType: true,
      guardWageSnapshot: true,
      brokerFeeSnapshot: true,
      clientRateSnapshot: true,
      settlementBrokerId: true,
      siteId: true,
      shiftTypeId: true,
      isExternal: true,
    },
  });
  if (records.length === 0) return { count: 0, groups: [], payoutCount: 0, clientCount: 0, noSettlementCount: 0, otUnpricedCount: 0 };

  const lookups = await loadUnpricedLookups(records, month);

  return computeUnpricedSummary(records, lookups, { month });
}

/** 由一批 shift_records 砌 `UnpricedLookups`（brokers／sites／shiftTypes 一次過查）——
 * `buildUnpricedSummary()` 同一鍵結算自動定價（WP-ONE-CLICK-AUTO §31.3 C）共用，口徑唔會飄開。 */
export async function loadUnpricedLookups(
  records: Array<{ settlementBrokerId: string | null; siteId: string; shiftTypeId: string }>,
  month: Date,
): Promise<UnpricedLookups> {
  const { start, end } = monthRange(month);
  const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
  const siteIds = [...new Set(records.map((r) => r.siteId))];
  const [brokers, sites, shiftTypes] = await Promise.all([
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, billingModel: true, guardsPaidByClient: true } }),
    prisma.shiftType.findMany({ where: { id: { in: [...new Set(records.map((r) => r.shiftTypeId))] } }, select: { id: true, code: true, billingGroup: true } }),
  ]);
  return {
    brokerKindById: new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike])),
    brokerCodeById: new Map(brokers.map((b) => [b.id, b.code])),
    siteNameById: new Map(sites.map((s) => [s.id, s.canonicalName])),
    siteBillingModelById: new Map(sites.map((s) => [s.id, (s.billingModel as string | null) ?? null])),
    shiftTypeCodeById: new Map(shiftTypes.map((s) => [s.id, s.code])),
    shiftTypeBillingGroupById: new Map(shiftTypes.map((s) => [s.id, s.billingGroup])),
    siteGuardsPaidByClientById: new Map(sites.map((s) => [s.id, s.guardsPaidByClient])),
    mixedBillingInfoBySiteId: isMixedBillingMonth(start) ? await loadMixedBillingInfo(siteIds, start, end) : undefined,
  };
}

/** 單條記錄屬邊啲未定价類別（同 `computeUnpricedSummary()` 同一口徑）。 */
export function unpricedCategoriesOf(r: UnpricedRecordLike, lookups: UnpricedLookups, opts: { month?: Date | null } = {}): UnpricedCategory[] {
  return computeUnpricedSummary([r], lookups, opts).groups.map((g) => g.category);
}
