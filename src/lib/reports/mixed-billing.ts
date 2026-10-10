// WP-MIXED-BILLING（老闆 2026-09-24 拍板方案 (a)）＋Opus 5.5 驗收收窄：
// 「月費盤可以同時有逐更收客卡」——但**唔係**月費盤上所有 per_shift 更種
// 嘅逐更 snapshot 都加落收入。
//
// 驗收發現（dev DB 實測，build→apply 之後）：IFC（853.66＝35,000÷41）、
// 淺水灣道11號蔚峰園（935.48＝29,000÷31）、創富廠IC（1,050＝25,200÷24）
// 呢啲盤嘅 8 月試算 E 值本身係「月費÷更數」嘅倒算值，唔係真逐更價；佢哋
// 7 月嘅 flat 卡又係無限期（WP-PRICE migration 伸長）——如果「flat＋所有
// per_shift snapshot」咁加，8 月會雙重計收入（IFC 35,000＋35,000）。
//
// 正確語意（驗收決定）：一個有 flat 收入（盤級 flat 卡覆蓋該月，或者
// monthly_fixed pro-rata fallback）嘅盤，某個 per_shift 更種**淨係**喺
// 「有一張 effective_from>=2026-08-01、覆蓋該月、client_rate 非 null、
// billing_model 係 per_shift（或者未填）嘅逐更收客卡，掛住呢個更種（或者
// 盤級通用 shift_type=null）」嗰陣，先當「逐更另收」：
//   - 收入：flat ＋ 呢啲「逐更另收」更種嘅 client_rate_snapshot 合計；
//   - 未定價：呢啲更種冇 client snapshot 先算「收客價未定」。
// 其餘 per_shift 更種當「已包喺月費」——唔加收入、唔標未定價。7 月匯入
// 嘅卡（effective_from=2026-07-01，例：控制室 r2_report 840 盤級卡、
// `MR-` 更種嘅 master_roster_only_rate 卡）永遠唔會觸發。
//
// 呢個檔案係 monthly-close.ts／gross-margin.ts／unpriced.ts 共用嘅唯一
// 判斷來源（純函數＋一個 DB loader），唔好喺其他地方再抄一份。
import { prisma } from "@/lib/db";

/** 規則生效日——7 月（< 呢日）保留舊口徑，鐵則唔准變 7 月 gate。 */
const MIXED_BILLING_FROM = new Date(Date.UTC(2026, 7, 1));

export function isMixedBillingMonth(monthStart: Date): boolean {
  return monthStart.getTime() >= MIXED_BILLING_FROM.getTime();
}

export type MixedBillingCardLike = {
  shiftTypeId: string | null;
  clientRate: unknown;
  billingModel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  voidedAt?: Date | null;
};

function day(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 純函數：呢張卡算唔算「逐更另收」卡（對 [monthStart, monthEnd] 呢個月）。 */
export function isExplicitPerShiftClientCard(card: MixedBillingCardLike, monthStart: Date, monthEnd: Date): boolean {
  if (card.voidedAt) return false;
  if (card.clientRate === null || card.clientRate === undefined) return false;
  if (card.billingModel !== null && card.billingModel !== "per_shift") return false;
  if (day(card.effectiveFrom) < day(MIXED_BILLING_FROM)) return false; // 7 月匯入／派生卡唔觸發
  if (day(card.effectiveFrom) > day(monthEnd)) return false;
  if (card.effectiveTo !== null && day(card.effectiveTo) < day(monthStart)) return false;
  return true;
}

export type MixedBillingSiteInfo = {
  /** 呢個盤呢個月有 flat 收入（盤級 flat 卡覆蓋該月，或者 monthly_fixed＋monthly_fee pro-rata）。 */
  hasFlatRevenue: boolean;
  /** 有「逐更另收」卡嘅 per_shift 更種；`all`＝有盤級通用（shift_type=null）逐更另收卡。 */
  explicitShiftTypeIds: Set<string>;
  allShiftTypes: boolean;
};

/** 純函數：flat 收入盤上，呢個更種嘅逐更 snapshot 算唔算收入／要唔要求定價。 */
export function isExplicitPerShiftType(info: MixedBillingSiteInfo | undefined, shiftTypeId: string): boolean {
  if (!info) return false;
  return info.allShiftTypes || info.explicitShiftTypeIds.has(shiftTypeId);
}

/** 純函數：由卡（同 site 設定）砌出 `MixedBillingSiteInfo`。`flatCards` 已經係覆蓋該月嘅盤級 flat 卡。 */
export function buildMixedBillingSiteInfo(
  site: { billingModel: string | null; monthlyFee: unknown },
  hasFlatCard: boolean,
  cards: MixedBillingCardLike[],
  monthStart: Date,
  monthEnd: Date,
): MixedBillingSiteInfo {
  const hasProrata = site.billingModel === "monthly_fixed" && site.monthlyFee !== null && site.monthlyFee !== undefined && Number(site.monthlyFee) > 0;
  const explicitShiftTypeIds = new Set<string>();
  let allShiftTypes = false;
  for (const c of cards) {
    if (!isExplicitPerShiftClientCard(c, monthStart, monthEnd)) continue;
    if (c.shiftTypeId === null) allShiftTypes = true;
    else explicitShiftTypeIds.add(c.shiftTypeId);
  }
  return { hasFlatRevenue: hasFlatCard || hasProrata, explicitShiftTypeIds, allShiftTypes };
}

/** DB loader：一次過攞晒 `siteIds` 喺呢個月嘅 `MixedBillingSiteInfo`。 */
export async function loadMixedBillingInfo(siteIds: string[], monthStart: Date, monthEnd: Date): Promise<Map<string, MixedBillingSiteInfo>> {
  const out = new Map<string, MixedBillingSiteInfo>();
  if (siteIds.length === 0) return out;
  const [sites, flatCards, perShiftCards] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, billingModel: true, monthlyFee: true } }),
    prisma.rateCard.findMany({
      where: {
        siteId: { in: siteIds },
        shiftTypeId: null,
        brokerId: null,
        guardId: null,
        billingModel: { in: ["monthly_fixed", "admin_fee", "special"] },
        effectiveFrom: { lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      select: { siteId: true },
    }),
    prisma.rateCard.findMany({
      where: {
        siteId: { in: siteIds },
        voidedAt: null,
        clientRate: { not: null },
        effectiveFrom: { gte: MIXED_BILLING_FROM, lte: monthEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
      },
      select: { siteId: true, shiftTypeId: true, clientRate: true, billingModel: true, effectiveFrom: true, effectiveTo: true, voidedAt: true },
    }),
  ]);
  const flatSiteIds = new Set(flatCards.map((c) => c.siteId));
  for (const s of sites) {
    const cards = perShiftCards.filter((c) => c.siteId === s.id);
    out.set(s.id, buildMixedBillingSiteInfo(s, flatSiteIds.has(s.id), cards, monthStart, monthEnd));
  }
  return out;
}
