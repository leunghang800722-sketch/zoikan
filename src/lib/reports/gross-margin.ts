// P1-WP4 §3c：毛利即時表——每盤 × 更別，本月至今更數／營業額／成本／
// 毛利／毛利率。
//
// 設計決定（呢個檔案落嘅，規劃 session 覆核；2026-09-12 Opus 驗收後
// M1/M2/A2/A3 修正版）：
// 1. 盤級嘅「營業額」**直接沿用** `buildMonthlyClose()`（src/lib/reports/
//    monthly-close.ts，WP1 已經同 P0 老闆版月結 0-diff）——唔重新由
//    `site.monthly_fee × prorata_basis` 從頭計月費盤營業額，理由見
//    monthly-close.ts 同一段註解。「成本」就*唔*沿用 monthly-close.ts
//    嘅 `base.cost`（嗰個冇計 rescue_rate 覆寫）——改用呢個檔案自己逐條
//    shift_records 重新加總（`perShiftBySiteType`，有 rescue 覆寫），
//    保證每個盤嘅 cost 同「展開更別」畀你睇嘅逐行金額加埋完全一致
//    （Opus 驗收 M1：「totals 要等於逐項組成之和」，見 gate:reports (g)）。
// 2. 毛利表列**所有喺呢個月有 shift_records 嘅盤**（Opus 驗收 A2 裁定），
//    唔止 `buildMonthlyClose()` 嗰 40 個「有 P0 對數基準」嘅盤——多出嚟
//    嘅盤（例如舊 P0 分類跌咗出 mainRows/outsideRows 之外，但實際上個
//    月有安員出更）revenue 顯示 0（冇 P0 基準可以計佢哋嘅真實收客
//    revenue，已知限制），cost 照樣逐項加總顯示，等長工月薪分攤總額
//    可以真係等於 Σ monthly_salary（唔會因為個人跨咗去一個「唔存在」
//    嘅盤度做更而漏咗嗰份分攤）。
// 3. referral_fee（長工雞頭費，2026-09-12 修正）：呢個金額*唔係*
//    Σshift_records×rate 由 DB 逐更計出嚟嘅——真正權威來源係老闆喺
//    「在勤總表」（master roster）親手打嘅費用行金額（見 P0 code
//    `master_roster.validate_referral_fee_rates()`）。seed 時經
//    `scripts/seed/lib/py/extract_referral_fees.py` 攞呢批已驗證金額，
//    起做 special_items（kind=referral_fee）。**M2 修正**：呢批
//    referral_fee 特殊項之前會被第 3 步嘅「其他 special_items」query
//    重複揀中（個 filter 淨係剔走 standalone_broker_fee，冇剔走
//    referral_fee）令同一筆錢計咗兩次——而家第 3 步明確淨係揀「除咗
//    referral_fee 同 standalone_broker_fee 以外」嘅 kind，referral 純粹
//    喺呢度（第 5 步）處理一次。配對唔到 site（城巴車廠/Weave/港大職員
//    宿舍呢類跨盤 block）*或者*嗰個 site 本身完全冇喺呢個月出現（例如
//    冇任何 shift_records）嘅金額，計入 `referralFeeUnattributed`
//    （加落全公司總成本，但唔顯示喺任何一個盤嘅個別行）。
import type { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2, monthRange as sharedMonthRange, monthLabel } from "./money";
import { buildMonthlyClose, DEFAULT_REPORT_MONTH } from "./monthly-close";
import { buildLongtermSalaryAllocation } from "./longterm-salary";

export const DEFAULT_MARGIN_THRESHOLD_PCT = 8;

export type GrossMarginShiftTypeRow = {
  shiftTypeId: string | null;
  code: string;
  label: string | null;
  kind: "per_shift" | "ot" | "monthly_fee" | "special";
  shifts: number;
  otHours: number | null;
  revenue: number;
  cost: number;
  profit: number;
  note: string | null;
};

/** Opus 驗收 M1：逐盤逐項組成——令驗收可以直接逐盤對 SQL，唔使靠信
 * `site.revenue`/`site.cost` 呢兩個聚合數字。`revenue.base` = 呢個盤喺
 * `buildMonthlyClose()` 嗰個 P0 口徑嘅營業額（月費盤已經包埋喺度，唔係
 * 額外一項）；冇喺 mainRows 出現嘅「額外盤」（見頂註解 2）呢欄固定 0。 */
export interface GrossMarginComponents {
  revenue: { base: number; ot: number; special: number };
  cost: { perShift: number; ot: number; special: number; referral: number; longtermAlloc: number };
}

export type GrossMarginSiteRow = {
  siteId: string;
  siteName: string;
  billingModel: string;
  isMonthlyFee: boolean;
  inP0MonthlyClose: boolean; // false = 「額外盤」，見頂註解 2
  shiftTypes: GrossMarginShiftTypeRow[];
  components: GrossMarginComponents;
  referralFee: number;
  longtermSalaryAllocated: number;
  missingSalaryGuardRefs: string[]; // guard.staffNo ?? guard.id（PDPO：唔用真名）
  shifts: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number | null;
  belowThreshold: boolean;
  note: string | null;
};

export type GrossMarginResult = {
  month: string;
  thresholdPct: number;
  sites: GrossMarginSiteRow[];
  totals: { shifts: number; revenue: number; cost: number; profit: number; marginPct: number | null };
  /** 長工雞頭費入面配對唔到單一 site（或者配對到嘅 site 冇顯示喺
   * `sites` 度）嘅部分——已經計入 totals.cost，但冇顯示喺任何一個盤嘅
   * 個別行，呢度攞出嚟做透明度用。 */
  referralFeeUnattributed: number;
  /** Opus 驗收 N1：非 referral_fee 嘅 special_items 成本入面，配對唔到
   * site（或者配對到嘅 site 冇顯示喺 `sites` 度）嘅部分——已經計入
   * totals.cost，但冇顯示喺任何一個盤嘅個別行。 */
  specialCostUnattributed: number;
  /** Opus 驗收 A2：Σ本月有出更嘅 longterm_autopay 安員月薪（唔理其他
   * gate 條件）——同 `Σsite.longtermSalaryAllocated` 應該相等（容差
   * 0.05，見 gate:reports (g)）。 */
  longtermSalaryTotalAllocatable: number;
};

function recordCost(r: { guardWageSnapshot: Prisma.Decimal | null; brokerFeeSnapshot: Prisma.Decimal | null; rescueRate: Prisma.Decimal | null }): number {
  if (r.rescueRate !== null) return n(r.rescueRate);
  return n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot);
}

export async function buildGrossMargin(month: Date = DEFAULT_REPORT_MONTH, opts?: { thresholdPct?: number }): Promise<GrossMarginResult> {
  const thresholdPct = opts?.thresholdPct ?? DEFAULT_MARGIN_THRESHOLD_PCT;
  const { start: MONTH_START, end: MONTH_END } = sharedMonthRange(month);

  const { mainRows } = await buildMonthlyClose(month);
  const p0SiteIds = new Set(mainRows.map((r) => r.siteId));
  const baseBySite = new Map(mainRows.map((r) => [r.siteId, r]));

  // Opus 驗收 A2：擴大盤範圍——所有呢個月有 shift_records（唔理
  // record_type）嘅 site，唔止 P0 對數基準嘅 40 個。
  const activeSiteIdRows = await prisma.shiftRecord.findMany({
    where: { workDate: { gte: MONTH_START, lte: MONTH_END } },
    select: { siteId: true },
    distinct: ["siteId"],
  });
  // WP-AI3 第二輪 live 驗收（老闆）：月費盤（billing_model=
  // monthly_fixed，設咗 monthly_fee）就算呢個月完全冇 shift_records都要
  // 喺報表度出現——等用戶睇到「呢個盤呢個月冇更次記錄」，唔會靜靜雞喺
  // 報表度消失、亦都唔會令人以為淨係冇查到（見下面 fallback gate 同
  // `monthlyFeeNoActivitySiteIds`）。
  const monthlyFixedSiteIdRows = await prisma.site.findMany({
    where: { billingModel: "monthly_fixed", monthlyFee: { not: null } },
    select: { id: true },
  });
  const siteIdSet = new Set<string>([...p0SiteIds, ...activeSiteIdRows.map((r) => r.siteId), ...monthlyFixedSiteIdRows.map((r) => r.id)]);
  const siteIds = [...siteIdSet];
  if (siteIds.length === 0) {
    return {
      month: monthLabel(month),
      thresholdPct,
      sites: [],
      totals: { shifts: 0, revenue: 0, cost: 0, profit: 0, marginPct: null },
      referralFeeUnattributed: 0,
      specialCostUnattributed: 0,
      longtermSalaryTotalAllocatable: 0,
    };
  }

  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } } });
  const siteById = new Map(sites.map((s) => [s.id, s]));

  const shiftTypes = await prisma.shiftType.findMany({ where: { siteId: { in: siteIds } } });
  const shiftTypeById = new Map(shiftTypes.map((st) => [st.id, st]));

  // 同 src/lib/reports/monthly-close.ts 一致嘅 bug fix：張卡嘅生效區間
  // 要覆蓋緊 `month`（唔係淨係揀「最新一張」，否則 8 月會用返 7 月張
  // 舊卡）——呢度淨係用嚟判斷 `isMonthlyFee` display flag 同「月費」
  // 展示行金額，唔影響 revenue（revenue 嗰邊已經由 buildMonthlyClose()
  // 用返同一條邏輯算好）。
  const flatCards = await prisma.rateCard.findMany({
    where: {
      siteId: { in: siteIds },
      shiftTypeId: null,
      brokerId: null,
      guardId: null,
      billingModel: { in: ["monthly_fixed", "admin_fee", "special"] },
      effectiveFrom: { lte: MONTH_END },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: MONTH_START } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  const flatCardBySite = new Map<string, number>();
  for (const c of flatCards) if (!flatCardBySite.has(c.siteId)) flatCardBySite.set(c.siteId, n(c.clientRate));
  // WP-AI3 第二輪 live 驗收 bug fix（老闆）：同 monthly-close.ts 一致——
  // 呢條 query 之前冇篩 effective_from/effective_to，會將呢類「更別級
  // special 卡」（例如啟航1331 Event Guard $11,700，見上面 §頂註解）
  // 加落任何月份，包括完全唔相干嘅月份（同「月費 fallback」果條係同一
  // 種「空月份假收入」問題）。
  const shiftTypeSpecialCards = await prisma.rateCard.findMany({
    where: {
      siteId: { in: siteIds },
      shiftTypeId: { not: null },
      brokerId: null,
      guardId: null,
      billingModel: "special",
      effectiveFrom: { lte: MONTH_END },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: MONTH_START } }],
    },
  });
  for (const c of shiftTypeSpecialCards) {
    flatCardBySite.set(c.siteId, round2((flatCardBySite.get(c.siteId) ?? 0) + n(c.clientRate)));
  }
  // 冇覆蓋 `month` 嘅 card（例如未嚟月份）嘅 monthly_fixed 盤——用
  // monthly_fee×monthly_posts×prorata 公式 fallback（同 monthly-close.ts
  // 「已知限制」註解一致：分子預設足月，冇逐月 SL 輸入機制）。
  //
  // WP-AI3 第二輪 live 驗收 bug fix（老闆）：同 monthly-close.ts 一致——
  // 之前呢度齋憑 site 設定就計出一舊假營業額，冇檢查呢個盤呢個月係咪
  // 真係有營運，對完全冇活動嘅月份（例如 2025-07）會令成本 0、毛利率
  // 顯示 100%。而家要求「呢個盤呢個月至少有 1 條 shift_record 或者 1
  // 條 daily_requirement」先至套用；冇嘅話 `flatCardBySite` 唔設呢個
  // site（`isMonthlyFee=false`，冇「月費」展示行），revenue 維持 0，
  // 落面 `monthlyFeeNoActivitySiteIds` 記低嚟俾個 site row 加返
  // 「該月冇更次記錄」嘅 note，等用戶睇到係「查過確認冇活動」，唔係
  // 「漏咗冇查」。
  // WP-PRICE（老闆 2026-09-16 拍板）bug fix：rate_cards 伸長做無限期
  // （見 prisma/migrations/20260916000000_extend_rate_cards_open_ended）
  // 之後，上面 `flatCards`/`shiftTypeSpecialCards` 對任何未來月份都會
  // 直接命中（唔再淨係 7 月）——一個月費盤如果嗰個月真係完全冇任何
  // shift_record/daily_requirement，唔可以淨係憑住張卡直接命中就當有
  // 營業額（同呢個 fallback 本身嘅「空月份」gate 要同一個原則），所以
  // 呢度淨係「先查有冇活動」，冇活動就強制剝走 `flatCardBySite` 嘅
  // entry（就算上面已經有卡直接命中都要剝）；有活動先睇要唔要行 pro-rata
  // fallback。
  // M2（Opus 驗收，2026-09-16）：之前呢條閘淨係喺
  // `site.billingModel === "monthly_fixed"` 先查——令 admin_fee／special
  // 嘅盤級 flat 卡（同上面加咗入 `flatCardBySite` 嘅更別級 special 卡）
  // 完全冇被「零活動」閘擋住。而家逐個「有 flatCardBySite entry」（嚟自
  // flatCards／shiftTypeSpecialCards，唔理 billing_model 係邊種）*或者*
  // 可能行 monthly_fixed pro-rata fallback 嘅 site，都查呢個月係咪真係
  // 有活動（非 cancelled 記錄）。
  const monthlyFeeNoActivitySiteIds = new Set<string>();
  const nonPerShiftCandidateSiteIds = new Set<string>([
    ...flatCardBySite.keys(),
    ...sites.filter((s) => s.billingModel === "monthly_fixed" && s.monthlyFee).map((s) => s.id),
  ]);
  for (const siteId of nonPerShiftCandidateSiteIds) {
    const site = siteById.get(siteId);
    if (!site) continue;
    const hasAnyRecordThisMonth =
      (await prisma.shiftRecord.count({ where: { siteId, workDate: { gte: MONTH_START, lte: MONTH_END }, status: { not: "cancelled" } } })) > 0 ||
      (await prisma.dailyRequirement.count({ where: { siteId, workDate: { gte: MONTH_START, lte: MONTH_END }, voidedAt: null } })) > 0;
    if (!hasAnyRecordThisMonth) {
      flatCardBySite.delete(siteId);
      monthlyFeeNoActivitySiteIds.add(siteId);
      continue;
    }
    if (flatCardBySite.has(siteId)) continue; // 已經有卡直接命中（或者更別 special 卡已加），唔使 fallback 公式
    if (site.billingModel !== "monthly_fixed" || !site.monthlyFee) continue; // pro-rata 公式 fallback 淨係 monthly_fixed 先有
    const posts = site.monthlyPosts ?? 1;
    const fullFee = n(site.monthlyFee) * posts;
    const basis = site.prorataBasis ?? "div_31";
    const denom = basis === "div_month_days" ? new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate() : 31;
    const numer = denom; // 已知限制：冇逐月 SL 輸入機制，預設足月（見 monthly-close.ts 同一段註解）
    flatCardBySite.set(siteId, round2((fullFee * numer) / denom));
  }

  // 1. per_shift 正更——逐條記錄（要 rescue_rate 覆寫，唔可以淨係
  //    aggregate；M1 修正：呢個先係「成本」嘅權威來源，唔再用
  //    buildMonthlyClose() 嗰個冇計 rescue 嘅 base.cost）。
  const perShiftRecords = await prisma.shiftRecord.findMany({
    where: {
      siteId: { in: siteIds },
      recordType: "shift",
      isExternal: false,
      shiftType: { billingGroup: "per_shift" },
      workDate: { gte: MONTH_START, lte: MONTH_END },
    },
    select: { siteId: true, shiftTypeId: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true, rescueRate: true },
  });
  type Bucket = { shifts: number; revenue: number; cost: number };
  const perShiftBySiteType = new Map<string, Bucket>();
  for (const r of perShiftRecords) {
    const key = `${r.siteId}|${r.shiftTypeId}`;
    const b = perShiftBySiteType.get(key) ?? { shifts: 0, revenue: 0, cost: 0 };
    b.shifts += 1;
    b.revenue = round2(b.revenue + n(r.clientRateSnapshot));
    b.cost = round2(b.cost + recordCost(r));
    perShiftBySiteType.set(key, b);
  }

  // 2. OT——按鐘（ot_hours × 時薪；時薪 = 正更 client_rate_snapshot/guard 成本 ÷
  //    正更更別 hours，用返正更本身已經 priced 嘅 snapshot，唔另外再查
  //    rate_cards——同 P0-執行計劃.md §8 B1 嘅人手驗算方法一致：
  //    「HKU C更 …8 小時 ×(700÷8.25)」，700/8.25 正正係嗰個更別嘅
  //    client_rate/hours）。搵唔到 parent 或者 parent 冇 hours 就 fallback
  //    用呢個 OT 更別自己嘅 rate_card（site+shiftType+broker）。
  const otRecords = await prisma.shiftRecord.findMany({
    where: { siteId: { in: siteIds }, recordType: "ot", workDate: { gte: MONTH_START, lte: MONTH_END } },
    include: { parentShift: { include: { shiftType: true } } },
  });
  const otRateCardCache = new Map<string, { clientHourly: number; guardHourly: number } | null>();
  async function otHourlyRatesFallback(siteId: string, shiftTypeId: string, brokerId: string | null): Promise<{ clientHourly: number; guardHourly: number } | null> {
    const cacheKey = `${siteId}|${shiftTypeId}|${brokerId ?? ""}`;
    if (otRateCardCache.has(cacheKey)) return otRateCardCache.get(cacheKey)!;
    const card =
      (brokerId &&
        (await prisma.rateCard.findFirst({ where: { siteId, shiftTypeId, brokerId, voidedAt: null }, orderBy: { effectiveFrom: "desc" } }))) ??
      (await prisma.rateCard.findFirst({ where: { siteId, shiftTypeId, brokerId: null, voidedAt: null }, orderBy: { effectiveFrom: "desc" } }));
    const st = shiftTypeById.get(shiftTypeId);
    const hours = st?.hours ? n(st.hours) : null;
    const result = card && hours && hours > 0 ? { clientHourly: n(card.clientRate) / hours, guardHourly: (n(card.guardWage) + n(card.brokerFee)) / hours } : null;
    otRateCardCache.set(cacheKey, result);
    return result;
  }
  const otBySiteType = new Map<string, Bucket & { otHours: number; unresolved: number }>();
  for (const r of otRecords) {
    const key = `${r.siteId}|${r.shiftTypeId}`;
    const b = otBySiteType.get(key) ?? { shifts: 0, revenue: 0, cost: 0, otHours: 0, unresolved: 0 };
    const otH = n(r.otHours);
    b.shifts += 1;
    b.otHours = round2(b.otHours + otH);

    let rates: { clientHourly: number; guardHourly: number } | null = null;
    const parent = r.parentShift;
    const parentHours = parent?.shiftType?.hours ? n(parent.shiftType.hours) : null;
    if (parent && parentHours && parentHours > 0) {
      rates = { clientHourly: n(parent.clientRateSnapshot) / parentHours, guardHourly: (n(parent.guardWageSnapshot) + n(parent.brokerFeeSnapshot)) / parentHours };
    } else {
      rates = await otHourlyRatesFallback(r.siteId, r.shiftTypeId, r.settlementBrokerId);
    }
    if (rates) {
      b.revenue = round2(b.revenue + rates.clientHourly * otH);
      b.cost = round2(b.cost + rates.guardHourly * otH);
    } else {
      b.unresolved += 1;
    }
    otBySiteType.set(key, b);
  }

  // 3. special_items——*淨係*「其他」kind（casual_event/shuttle/per_hour/
  //    supplemental/cross_month_adjustment/other）。standalone_broker_fee
  //    已經摺入 buildMonthlyClose() 嘅 site.revenue（唔可以再計一次）；
  //    referral_fee 喺第 5 步獨立處理一次（M2 修正：之前呢度冇剔走
  //    referral_fee，令佢同第 5 步計咗兩次）。
  //
  //    額外發現（喺驗證 N1 對稱性 g5 嗰陣揪到，唔係 Opus 呢輪明文要求，
  //    但係一個真實嘅 double-count）：`kind=supplemental`（補單，例如
  //    龍譽/惠康貨倉）嘅每一筆，seed 時（scripts/seed/index.ts
  //    seedSpecialItems()＋wp3/rate_cards.csv）都由**同一張發票**攞
  //    出嚟，*同時*起咗一張 `billing_model=special` 嘅 flat rate_card
  //    （已經摺入 base.revenue，buildMonthlyClose()／gate(a) 已經用呢
  //    張卡嘅金額同 P0 對過數）*同埋*一條 special_item（先前呢度會再加
  //    一次嗰筆 revenue）——即係同一張 $800/$780 發票計咗兩次。修法：
  //    supplemental 嘅 revenue 唔計入 `extraSpecialRevenue`（跟
  //    standalone_broker_fee 同一做法：display-only），cost 一律冇呢個
  //    問題（照舊由下面第 3c 步嘅 cost-only pass 處理）。
  const OTHER_SPECIAL_KINDS = ["casual_event", "shuttle", "per_hour", "supplemental", "cross_month_adjustment", "other"] as const;
  const REVENUE_DOUBLE_COUNTED_KINDS = new Set(["supplemental"]);
  const specialItems = await prisma.specialItem.findMany({
    where: { siteId: { in: siteIds }, month: MONTH_START, kind: { in: [...OTHER_SPECIAL_KINDS] } },
  });
  const specialBySite = new Map<string, GrossMarginShiftTypeRow[]>();
  for (const it of specialItems) {
    if (!it.siteId) continue;
    const list = specialBySite.get(it.siteId) ?? [];
    const alreadyInBase = REVENUE_DOUBLE_COUNTED_KINDS.has(it.kind);
    list.push({
      shiftTypeId: null,
      code: `special:${it.kind}`,
      label: it.description ?? it.kind,
      kind: "special",
      shifts: it.shifts ?? 0,
      otHours: null,
      revenue: alreadyInBase ? 0 : round2(n(it.revenue)),
      cost: round2(n(it.cost)),
      profit: round2((alreadyInBase ? 0 : n(it.revenue)) - n(it.cost)),
      note: alreadyInBase ? `${it.description ?? ""}（金額已經由同一張發票起嘅 flat rate_card 摺入盤總營業額，呢度唔再加一次）`.trim() : it.description,
    });
    specialBySite.set(it.siteId, list);
  }
  // 3b. standalone_broker_fee（獨立雞頭費，例：HKU Y更「獨立雞頭費」
  //    94更）——buildMonthlyClose() 已經摺咗入 base.revenue/base.shifts
  //    （對齊 P0 輸出），呢度純粹加一行*展示*用（唔計入 extraSpecialRevenue，
  //    唔會 double count），等「展開更別」睇到盤總數同更別breakdown 之和
  //    對得返。
  const standaloneBrokerFeeItems = await prisma.specialItem.findMany({
    where: { siteId: { in: siteIds }, month: MONTH_START, kind: "standalone_broker_fee" },
  });
  const standaloneDisplayBySite = new Map<string, GrossMarginShiftTypeRow[]>();
  for (const it of standaloneBrokerFeeItems) {
    if (!it.siteId) continue;
    const list = standaloneDisplayBySite.get(it.siteId) ?? [];
    list.push({
      shiftTypeId: null,
      code: "special:standalone_broker_fee",
      label: it.description ?? "獨立雞頭費",
      kind: "special",
      shifts: it.shifts ?? 0,
      otHours: null,
      revenue: round2(n(it.revenue)),
      cost: 0,
      profit: round2(n(it.revenue)),
      note: (it.description ? it.description + "；" : "") + "已計入盤總營業額（buildMonthlyClose 口徑），呢行純粹展示",
    });
    standaloneDisplayBySite.set(it.siteId, list);
  }

  // 3c（Opus 驗收 N1 裁定 2026-09-12）：非 referral_fee 嘅 special_items
  // 成本——之前淨係第 3 步嗰 6 種「其他」kind 有計成本，standalone_
  // broker_fee（69,200）／individual_broker_event（27,988）／
  // cross_month_adjustment（已經計咗，喺第 3 步入面）／other（已經計咗）
  // 入面，standalone_broker_fee 同 individual_broker_event 兩種嘅成本
  // 完全冇入 `components.cost`（前者刻意淨係做展示行 cost=0，後者個
  // site 完全冇喺 `siteIds` 出現，成筆嘢連 unattributed 都冇歸）。而家
  // 獨立一個 cost-only pass，掃**全部**非 referral_fee 嘅 special_items
  // （唔理邊個 kind，唔理 site 之前有冇被第 3/3b 步揀中），逐 site 加落
  // `specialCostBySite`；配對唔到 site，或者個 site 冇喺 `siteIds`
  // 出現（例如 HKW 個別雞頭 Event 客戶盤完全冇 shift_records），歸
  // `specialCostUnattributed`——**唔加返任何 revenue**（N1 明文「收入
  // 唔准再加一次」，revenue 嘅口徑保持同之前一樣：standalone_broker_fee
  // 摺入 base、6 種「其他」kind 喺第 3 步計、individual_broker_event
  // 本身冇 revenue 路徑，維持原狀）。
  const allNonReferralItems = await prisma.specialItem.findMany({
    where: { month: MONTH_START, kind: { not: "referral_fee" }, voidedAt: null },
  });
  const specialCostBySite = new Map<string, number>();
  let specialCostUnattributed = 0;
  for (const it of allNonReferralItems) {
    const cost = n(it.cost);
    if (cost === 0) continue;
    if (it.siteId && siteIdSet.has(it.siteId)) {
      specialCostBySite.set(it.siteId, round2((specialCostBySite.get(it.siteId) ?? 0) + cost));
    } else {
      specialCostUnattributed = round2(specialCostUnattributed + cost);
    }
  }

  // 4. 長工月薪分攤（按該人該月各盤更數比例）——用共用 helper，同
  //    monthly-close.ts 一致（Opus 驗收 A3）。
  const salaryAllocation = await buildLongtermSalaryAllocation(month);
  const salaryAllocBySite = salaryAllocation.bySite;
  const missingSalaryBySite = new Map<string, Set<string>>();
  for (const m of salaryAllocation.missingSalary) {
    for (const siteId of m.siteIds) {
      const set = missingSalaryBySite.get(siteId) ?? new Set<string>();
      set.add(m.guardRef);
      missingSalaryBySite.set(siteId, set);
    }
  }

  // 5. referral_fee（長工雞頭費）——見頂註解。逐 site 金額；配對唔到
  //    site，或者配對到嘅 site 冇喺呢個月出現（唔喺 `siteIds` 入面）嘅
  //    金額計入 unattributed（M2 修正：之前完全冇 siteIds 檢查，令冇
  //    活動嘅 site 嘅 referral 金額憑空消失）。
  const referralItems = await prisma.specialItem.findMany({
    where: { kind: "referral_fee", month: MONTH_START },
  });
  const referralFeeBySite = new Map<string, number>();
  let referralFeeUnattributed = 0;
  for (const it of referralItems) {
    const amt = n(it.cost);
    if (it.siteId && siteIdSet.has(it.siteId)) {
      referralFeeBySite.set(it.siteId, round2((referralFeeBySite.get(it.siteId) ?? 0) + amt));
    } else {
      referralFeeUnattributed = round2(referralFeeUnattributed + amt);
    }
  }

  // ---- 砌返每個盤嘅 row ----
  const siteRows: GrossMarginSiteRow[] = [];
  for (const siteId of siteIds) {
    const site = siteById.get(siteId);
    if (!site) continue;
    const base = baseBySite.get(siteId); // undefined = 「額外盤」（見頂註解 2）
    const isMonthlyFee = flatCardBySite.has(siteId);
    const shiftTypesOut: GrossMarginShiftTypeRow[] = [];

    if (isMonthlyFee) {
      shiftTypesOut.push({
        shiftTypeId: null,
        code: "monthly_fee",
        label: "月費",
        kind: "monthly_fee",
        shifts: site.monthlyPosts ?? 0,
        otHours: null,
        revenue: flatCardBySite.get(siteId) ?? 0,
        cost: 0,
        profit: flatCardBySite.get(siteId) ?? 0,
        note: "更數越多毛利越低（月費固定，成本隨更數上升）",
      });
    }
    let perShiftCost = 0;
    let perShiftShifts = 0;
    for (const [key, b] of perShiftBySiteType) {
      const [sId, stId] = key.split("|");
      if (sId !== siteId) continue;
      const st = shiftTypeById.get(stId);
      perShiftCost = round2(perShiftCost + b.cost);
      perShiftShifts += b.shifts;
      shiftTypesOut.push({
        shiftTypeId: stId,
        code: st?.code ?? stId,
        label: st?.label ?? null,
        kind: "per_shift",
        shifts: b.shifts,
        otHours: null,
        revenue: b.revenue,
        cost: b.cost,
        profit: round2(b.revenue - b.cost),
        note: null,
      });
    }
    let otRevenue = 0;
    let otCost = 0;
    for (const [key, b] of otBySiteType) {
      const [sId, stId] = key.split("|");
      if (sId !== siteId) continue;
      const st = shiftTypeById.get(stId);
      otRevenue = round2(otRevenue + b.revenue);
      otCost = round2(otCost + b.cost);
      shiftTypesOut.push({
        shiftTypeId: stId,
        code: st?.code ?? stId,
        label: st?.label ?? null,
        kind: "ot",
        shifts: b.shifts,
        otHours: b.otHours,
        revenue: b.revenue,
        cost: b.cost,
        profit: round2(b.revenue - b.cost),
        note: b.unresolved > 0 ? `${b.unresolved} 條 OT 記錄搵唔到時薪來源，未計價` : null,
      });
    }
    for (const row of specialBySite.get(siteId) ?? []) shiftTypesOut.push(row);
    for (const row of standaloneDisplayBySite.get(siteId) ?? []) shiftTypesOut.push(row);

    const referralFee = referralFeeBySite.get(siteId) ?? 0;
    const longtermSalaryAllocated = salaryAllocBySite.get(siteId) ?? 0;
    const missingSalaryGuardRefs = [...(missingSalaryBySite.get(siteId) ?? [])];

    const extraSpecialRevenue = round2((specialBySite.get(siteId) ?? []).reduce((a, r) => a + r.revenue, 0));
    // N1 修正：cost 唔再淨係計嗰 6 種「其他」kind（extraSpecialCost）——
    // 改用 `specialCostBySite`（第 3c 步，涵蓋*全部*非 referral_fee kind
    // 嘅成本，包括之前完全冇計嘅 standalone_broker_fee／
    // individual_broker_event）。
    const specialCost = specialCostBySite.get(siteId) ?? 0;

    // M1 修正：revenue 嘅「base」仍然用 buildMonthlyClose() 嘅 P0 口徑
    // （包埋月費/摺入嘅 standalone_broker_fee，冇 mainRows 就係 0）；
    // cost 全部由呢個檔案自己逐項加總（per_shift 用 perShiftCost，唔係
    // base.cost）。
    const revenueBase = base?.revenue ?? 0;
    const components: GrossMarginComponents = {
      revenue: { base: revenueBase, ot: otRevenue, special: extraSpecialRevenue },
      cost: { perShift: perShiftCost, ot: otCost, special: specialCost, referral: referralFee, longtermAlloc: longtermSalaryAllocated },
    };
    const revenue = round2(components.revenue.base + components.revenue.ot + components.revenue.special);
    const cost = round2(components.cost.perShift + components.cost.ot + components.cost.special + components.cost.referral + components.cost.longtermAlloc);
    const profit = round2(revenue - cost);
    const marginPct = revenue > 0 ? round2((profit / revenue) * 100) : null;

    siteRows.push({
      siteId,
      siteName: site.canonicalName,
      billingModel: site.billingModel,
      isMonthlyFee,
      inP0MonthlyClose: base !== undefined,
      shiftTypes: shiftTypesOut.sort((a, b) => a.code.localeCompare(b.code)),
      components,
      referralFee,
      longtermSalaryAllocated,
      missingSalaryGuardRefs,
      shifts: base?.shifts ?? perShiftShifts,
      revenue,
      cost,
      profit,
      marginPct,
      belowThreshold: marginPct !== null && marginPct < thresholdPct,
      // P2-B 應修④（Opus 驗收）：呢欄係俾用戶（老闆/會計）睇嘅業務文案，
      // 唔准出現檔名／內部註解編號——「額外盤 · 冇 P0 月結對數基準」／
      // 「月費盤 · 更數越多毛利越低」（後者由 UI 層俾，見
      // src/app/(app)/reports/gross-margin/page.tsx，呢度淨係喺冇更貼切
      // 嘅備註時 fallback 做「額外盤」嗰句）。
      note: monthlyFeeNoActivitySiteIds.has(siteId)
        ? "該月冇更次記錄（月費 pro-rata fallback 已經停用，唔會顯示假營業額）"
        : (base?.note ?? (base === undefined ? "額外盤 · 冇 P0 月結對數基準" : null)),
    });
  }

  const totalRevenue = round2(siteRows.reduce((a, r) => a + r.revenue, 0));
  // referralFeeUnattributed：跨多個 site 嘅 block（城巴車廠／Weave／港大
  // 職員宿舍）或者配對到但呢個月完全冇活動嘅 site，計入全公司成本
  // 總額，但唔顯示喺任何一個盤嘅個別行——見上面 §5 註解。
  // specialCostUnattributed（N1）：同一原理，非 referral_fee special_items
  // 配對唔到／個 site 冇喺 siteIds 出現嘅成本（例如 HKW 個別雞頭 Event
  // 客戶盤 27,988，個 site 完全冇 shift_records）。
  const totalCost = round2(siteRows.reduce((a, r) => a + r.cost, 0) + referralFeeUnattributed + specialCostUnattributed);
  const totalProfit = round2(totalRevenue - totalCost);
  const totals = {
    shifts: siteRows.reduce((a, r) => a + r.shifts, 0),
    revenue: totalRevenue,
    cost: totalCost,
    profit: totalProfit,
    marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : null,
  };

  return {
    month: monthLabel(month),
    thresholdPct,
    sites: siteRows.sort((a, b) => a.siteName.localeCompare(b.siteName)),
    totals,
    referralFeeUnattributed,
    specialCostUnattributed,
    longtermSalaryTotalAllocatable: salaryAllocation.totalAllocatable,
  };
}

/** 毛利即時表:export——每盤一行小計＋展開更別明細，逐盤之間留空行分隔。 */
export async function writeGrossMarginXlsx(outPath: string, month: Date = DEFAULT_REPORT_MONTH, opts?: { thresholdPct?: number }) {
  const result = await buildGrossMargin(month, opts);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`毛利即時表-${result.month}`);
  ws.addRow(["盤", "更別", "更數", "OT時數", "營業額", "成本", "毛利", "毛利率", "備註"]);
  for (const site of result.sites) {
    ws.addRow([site.siteName, "（盤小計）", site.shifts, "", site.revenue, site.cost, site.profit, site.marginPct === null ? "n/a" : `${site.marginPct}%`, site.belowThreshold ? "低於毛利率底線" : ""]);
    for (const st of site.shiftTypes) {
      ws.addRow([site.siteName, st.label ? `${st.code}（${st.label}）` : st.code, st.shifts, st.otHours ?? "", st.revenue, st.cost, st.profit, "", st.note ?? ""]);
    }
    if (site.referralFee) ws.addRow([site.siteName, "長工雞頭費", "", "", "", site.referralFee, -site.referralFee, "", ""]);
    if (site.longtermSalaryAllocated) ws.addRow([site.siteName, "長工月薪分攤", "", "", "", site.longtermSalaryAllocated, -site.longtermSalaryAllocated, "", ""]);
    if (site.missingSalaryGuardRefs.length) ws.addRow([site.siteName, "未有月薪", "", "", "", "", "", "", `${site.missingSalaryGuardRefs.length} 人未有月薪紀錄：${site.missingSalaryGuardRefs.join("、")}`]);
    ws.addRow([]);
  }
  ws.addRow(["全公司合計", "", result.totals.shifts, "", result.totals.revenue, result.totals.cost, result.totals.profit, result.totals.marginPct === null ? "n/a" : `${result.totals.marginPct}%`, `毛利率底線 ${result.thresholdPct}%`]);
  ws.addRow([]);
  ws.addRow(["長工月薪分攤 scope：呢份毛利即時表列晒全部本月有 shift_records 嘅盤（唔止月結總表 mainRows 嗰 40 個 P0 對數基準盤）——分攤總額 = Σ全部本月有出更嘅 longterm_autopay 保安員月薪。"]);
  ws.addRow([`referral 未配對 site 金額（唔會顯示喺任何一盤）：${result.referralFeeUnattributed}；非 referral special_items 未配對 site 金額：${result.specialCostUnattributed}。`]);
  await wb.xlsx.writeFile(outPath);
  return result;
}
