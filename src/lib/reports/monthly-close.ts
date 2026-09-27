// 月結總表（R2 口徑）——由 DB 重出，格式對齊
// tools/importer/out/wp3/reports/月結總表-regenerated.xlsx 兩個 sheet：
// 「月結對照(R2口徑)」（主表）同「月結以外」（LINK C7 / 兩個真實客戶
// （代號見 data/mappings-private/report-overrides.json）/ 個別雞頭 Event 特殊收入項）。
//
// P1-WP4：由 scripts/report/monthly-close.ts 搬入呢度（單一 source of
// truth，`npm run report:regen` 同 `GET /api/reports/monthly-close` 兩邊
// 用返同一份 code——scripts/report/monthly-close.ts 而家係 thin
// wrapper，淨係做 CLI 入口＋寫 xlsx 檔）。邏輯本身冇改，繼續同
// out/wp3/reports/月結總表-regenerated.xlsx 逐格 0-diff（見
// scripts/report/diff.ts）。
//
// 對數口徑（由 out/wp3/reports/月結總表-regenerated.xlsx 反推證實）：
//   revenue(site) = 如果有「flat 卡」（rate_cards：site 對得上、shift_type/
//                   broker/guard 三個 FK 皆空、billing_model ∈
//                   {monthly_fixed, admin_fee, special}）→ 用嗰張卡嘅
//                   client_rate（一個固定金額，唔逐更計）；
//                   否則 → Σ shift_records.client_rate_snapshot（record_type=shift）
//   cost(site)    = Σ (guard_wage_snapshot + broker_fee_snapshot)，record_type=shift
//                   ——呢個係 P0 工具本身嘅口徑，佢自己都標注「成本不完整：
//                   長工月薪未分攤」，WP1 對呢一級要同 P0 輸出逐格相等；
//                   長工月薪分攤／雞頭現金雙計 係 P1-WP1 喺呢個基礎上加嘅
//                   *額外* 欄（後面幾欄），唔影響前面幾欄嘅 0-diff。
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, round2 } from "./money";
import { buildLongtermSalaryAllocation } from "./longterm-salary";
import { isMixedBillingMonth, isExplicitPerShiftType, loadMixedBillingInfo, type MixedBillingSiteInfo } from "./mixed-billing";

export const DEFAULT_REPORT_MONTH = new Date(Date.UTC(2026, 6, 1));
function monthRange(month: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { start, end };
}

export type MonthlyCloseSiteRow = {
  siteId: string;
  canonicalName: string;
  shifts: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number | null; // null = 'n/a'（cost=0 時同 P0 輸出一致）
  note: string | null;
  // P1-WP1 額外欄（P0 輸出冇對應，唔入 0-diff 比對，見上面註解）
  longtermSalaryAllocated: number;
  brokerCashOnLongterm: number;
  fullCost: number;
  fullProfit: number;
  fullMarginPct: number | null;
};

export async function buildMonthlyClose(month: Date = DEFAULT_REPORT_MONTH) {
  const { start: MONTH_START, end: MONTH_END } = monthRange(month);
  const sites = await prisma.site.findMany({ orderBy: { canonicalName: "asc" } });

  const mainRows: MonthlyCloseSiteRow[] = [];
  const outsideRows: MonthlyCloseSiteRow[] = [];

  // 長工月薪分攤（Opus 驗收 A3 裁定 2026-09-12：同 gross-margin.ts 統一
  // 用「按該人該月各盤更數比例分攤」，唔再用之前「派晒俾更數最多嗰盤」
  // 嘅簡化版——呢欄本身係 P0 口徑*以外*嘅額外欄，唔影響 revenue/cost/
  // profit/marginPct 呢幾個核心、同 P0 月結總表 0-diff 嘅欄，見 gate
  // (a)／(b1)）。
  const salaryAllocation = await buildLongtermSalaryAllocation(month);
  const salaryBySite = salaryAllocation.bySite;

  // 雞頭現金雙計（硬性規則4）：長工掛雞頭桶嘅更，雞頭現金照計，毛利表要
  // 如實反映——呢個 cash 成本已經計咗喺 base cost（guard_wage+broker_fee
  // snapshot）入面，呢度淨係做個獨立小計方便老闆睇「雙重支付」有幾大
  const longtermShiftRecords = await prisma.shiftRecord.findMany({
    where: { workDate: { gte: MONTH_START, lte: MONTH_END }, recordType: "shift", status: { not: "cancelled" }, guard: { employmentType: "longterm_autopay" }, settlementBrokerId: { not: null } },
    select: { siteId: true },
  });
  const brokerCashOnLongtermBySite = new Map<string, number>();
  for (const sr of longtermShiftRecords) {
    brokerCashOnLongtermBySite.set(sr.siteId, (brokerCashOnLongtermBySite.get(sr.siteId) ?? 0) + 1);
  }

  // WP-MIXED-BILLING（Opus 5.5 驗收）：逐盤「逐更另收」更種（見 ./mixed-billing.ts）。7 月唔使查。
  const mixedInfo = isMixedBillingMonth(MONTH_START) ? await loadMixedBillingInfo(sites.map((s) => s.id), MONTH_START, MONTH_END) : new Map<string, MixedBillingSiteInfo>();

  for (const site of sites) {
    // is_external=true（客戶自己嘅人，例：數碼港 Wilson Guard/Supervisor）
    // 唔入糧唔開單，P0 regen 報表已經成行剔走——呢度要跟同一口徑，
    // 否則更數/營業額會計多（實測：數碼港 CP1-4 490 中有 260 係外判客戶自己人）。
    // billing_group=monthly_ic 嘅更別（例：數碼港 CP5 嘅 IC 崗）自己有獨立
    // 月費結構（見 README「CP5 180 拆 25」），唔計入 per-shift 更數/營業額。
    const shiftAgg = await prisma.shiftRecord.aggregate({
      where: {
        siteId: site.id,
        recordType: "shift",
        isExternal: false,
        shiftType: { billingGroup: "per_shift" },
        workDate: { gte: MONTH_START, lte: MONTH_END },
        status: { not: "cancelled" },
      },
      _count: { _all: true },
      _sum: { clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true },
    });
    let shifts = shiftAgg._count._all;
    let cost = round2(n(shiftAgg._sum.guardWageSnapshot) + n(shiftAgg._sum.brokerFeeSnapshot));

    // P1-WP4（規劃裁定 2026-09-12，bug fix）：呢條 query 之前冇篩
    // effective_from/effective_to 同 `month` 嘅關係——7 月張卡
    // effective_to=2026-07-31，`orderBy: effectiveFrom desc` 淨係揀
    // 「最新一張」，對 8 月都照樣揀返 7 月張卡（Stale：8 月會顯示錯嘅
    // 7 月金額，唔係顯示 0）。而家要求張卡嘅生效區間覆蓋緊 `month`
    // 先算數；月費盤 8 月（或任何冇card嘅月份）跌落下面嘅 pro-rata
    // 公式 fallback。
    const flatCard = await prisma.rateCard.findFirst({
      where: {
        siteId: site.id,
        shiftTypeId: null,
        brokerId: null,
        guardId: null,
        billingModel: { in: ["monthly_fixed", "admin_fee", "special"] },
        effectiveFrom: { lte: MONTH_END },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: MONTH_START } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });

    // P1-WP4 §3c（規劃裁定）：月費盤冇覆蓋 `month` 嘅 flat rate_card
    // （例如未嚟月份）就用 `sites.monthly_fee × monthly_posts ×
    // pro-rata` 公式計，唔淨係靠歷史手動張卡。**已知限制**：pro-rata
    // 嘅分子（例：CP5 IC 7 月「扣 1 日 SL」)`31-N`嗰個 N）冇對應
    // shift_records/leave 資料可以喺 DB 動態推返（P0 自己都係逐張發票
    // 人手核對先寫低嗰個 note，唔係一條可以自動重算嘅公式，見
    // tools/importer/importer/wp3_rates.py 「月費制…SL pro-rata讀法」
    // 段），所以呢個 fallback 公式預設用足月（N=0，分子=分母），有真正
    // 逐月 SL/扣數輸入機制之前只可以做到「冇資料就當足月」，唔會屈估
    // 一個唔知啱唔啱嘅扣數。
    //
    // WP-AI3 第二輪 live 驗收 bug fix（老闆）：之前呢個 fallback 齋憑
    // site 設定（monthly_fixed + monthly_fee 有值）就計出一個金額，完全
    // 冇檢查呢個盤呢個月係咪真係有營運——對一個完全冇任何 shift_
    // records/daily_requirements 嘅月份（例如業務未開始嘅 2025-07），
    // 會計出一舊假營業額，成本 0，毛利率顯示 100%。而家加一層閘：淨係
    // 「呢個盤呢個月至少有 1 條非 cancelled 嘅 shift_record 或者 1 條
    // daily_requirement」先至套用逐月 flat 卡／pro-rata 公式／更別級
    // special 卡；冇嘅話當呢個盤呢個月完全冇活動（同其他「完全冇活動」
    // 嘅盤一致，唔顯示喺 mainRows/outsideRows，見下面 `hasActivity` 判斷）。
    //
    // M2（Opus 驗收，2026-09-16）：之前呢條閘淨係喺
    // `site.billingModel==="monthly_fixed"` 先查（`monthlyFeeFallbackCandidate`），
    // 令 billing_model=admin_fee／special 嘅盤級 flat 卡（`flatCard`）
    // 同更別級 special 卡（`shiftTypeSpecialCards`，唔理 site.billingModel
    // 係乜）完全冇被呢個「零活動」閘擋住——依家一律計「呢個盤呢個月係咪
    // 有非 cancelled 記錄」，唔理 site.billingModel 係邊種，逐個 site 都查
    // （呢個 route 本身就已經逐 site 打緊幾次 DB，加呢條唔算加新瓶頸量級）。
    // WP-LTSHIFT（老闆 2026-09-26 §6）：`activity_proxy_site_id`——純月費
    // 構造盤（例：「數碼港 CP5 IC」）自己 0 條 shift_records，但同一
    // 「業務」實質活動記喺另一個盤（「數碼港 CP5」）。純憑呢個盤自己冇
    // 記錄就當「完全冇活動」隱藏咗佢，會令總表有嘅 18,580.65 喺系統
    // 度消失（同總表核對唔到）；但淨係憑「盤有 flat 卡」就當有活動又會
    // 打崩返上面 M2/WP-AI3 嗰條防「假營業額」閘嘅原意（未開業月份唔應該
    // 憑張卡就計出營業額）。所以：查埋 `activity_proxy_site_id` 嗰個盤
    // 呢個月有冇記錄，兩者其一有就當有活動——`activity_proxy_site_id`
    // 係老闆／盤管理頁顯式設定嘅 FK（唔係憑字串估），淨係 CP5 IC 呢類
    // 已知嘅「構造盤」先會有值，唔會影響其他盤嘅閘。
    const proxySiteId = site.activityProxySiteId;
    const hasAnyRecordThisMonth =
      (await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: MONTH_START, lte: MONTH_END }, status: { not: "cancelled" } } })) > 0 ||
      (await prisma.dailyRequirement.count({ where: { siteId: site.id, workDate: { gte: MONTH_START, lte: MONTH_END }, voidedAt: null } })) > 0 ||
      (proxySiteId !== null &&
        ((await prisma.shiftRecord.count({ where: { siteId: proxySiteId, workDate: { gte: MONTH_START, lte: MONTH_END }, status: { not: "cancelled" } } })) > 0 ||
          (await prisma.dailyRequirement.count({ where: { siteId: proxySiteId, workDate: { gte: MONTH_START, lte: MONTH_END }, voidedAt: null } })) > 0));

    // WP-PRICE（老闆 2026-09-16 拍板）bug fix：rate_cards 伸長做無限期
    // （見 prisma/migrations/20260916000000_extend_rate_cards_open_ended）
    // 之後，`flatCard` 對任何未來月份都會直接命中（唔再淨係 7 月）——
    // 一個非逐更盤（月費／admin_fee／special）如果嗰個月真係完全冇任何
    // shift_record/daily_requirement，唔可以淨係憑住張卡直接命中就當有
    // 營業額（同下面 monthlyFeeProrataRevenue() 嘅「空月份」gate 要同一
    // 個原則；M2：呢條閘而家覆蓋*全部* billing_model，唔止 monthly_fixed）。
    // `effectiveFlatCard` 喺呢種情況當冇卡處理，跌返落
    // monthlyFeeProrataRevenue()（一樣因為 !hasAnyRecordThisMonth 而回
    // null）→ 最尾 fallback 到 shiftAgg._sum（冇更次一樣係 0）。
    const effectiveFlatCard = flatCard !== null && !hasAnyRecordThisMonth ? null : flatCard;

    function monthlyFeeProrataRevenue(): number | null {
      if (site.billingModel !== "monthly_fixed" || !site.monthlyFee) return null;
      if (!hasAnyRecordThisMonth) return null; // 見上面 bug fix 註解
      const posts = site.monthlyPosts ?? 1;
      const fullFee = n(site.monthlyFee) * posts;
      const basis = site.prorataBasis ?? "div_31";
      const denom = basis === "div_month_days" ? new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate() : 31;
      const numer = denom; // 已知限制：冇逐月 SL 輸入，預設足月
      return round2((fullFee * numer) / denom);
    }

    // WP-MIXED-BILLING（老闆 2026-09-24 拍板 8 月開盤方案 (a)：控制室
    // 月薪崗月費 22,000 + 日薪崗逐更 840×更數）＋Opus 5.5 驗收收窄：月費盤
    // 可以同時有逐更收客卡——盤嘅收入 = flat 卡（或 pro-rata fallback）+
    // 該盤「逐更另收」per_shift 更種嘅 client_rate_snapshot 合計。「逐更
    // 另收」＝有一張 effective_from>=2026-08-01、覆蓋該月、client_rate 非
    // null 嘅逐更收客卡（判斷見 ./mixed-billing.ts）；其餘 per_shift 更種
    // 當「已包喺月費」唔加（否則 IFC／蔚峰園／創富廠IC 呢類 7 月 flat 卡
    // 無限期、8 月試算 E＝月費÷更數 嘅盤會雙重計）。`monthly_ic` 更種本身
    // 唔喺 `shiftAgg`（上面已經篩 billingGroup=per_shift）。**只對
    // 2026-08-01 起嘅月份生效**——7 月保留舊口徑（有 flat 卡就淨係計
    // flat），7 月 gate 唔變。見 P2-版面重設計計劃.md §14 規則 5、§17.9。
    const mixedBillingEnabled = isMixedBillingMonth(MONTH_START);
    const flatOrProrataRevenue = effectiveFlatCard ? round2(n(effectiveFlatCard.clientRate)) : monthlyFeeProrataRevenue();
    let revenue: number;
    if (flatOrProrataRevenue !== null) {
      revenue = flatOrProrataRevenue;
      if (mixedBillingEnabled) {
        const info = mixedInfo.get(site.id);
        if (info && (info.allShiftTypes || info.explicitShiftTypeIds.size > 0)) {
          const byType = await prisma.shiftRecord.groupBy({
            by: ["shiftTypeId"],
            where: {
              siteId: site.id,
              recordType: "shift",
              isExternal: false,
              shiftType: { billingGroup: "per_shift" },
              workDate: { gte: MONTH_START, lte: MONTH_END },
              status: { not: "cancelled" },
            },
            _sum: { clientRateSnapshot: true },
          });
          for (const g of byType) {
            if (isExplicitPerShiftType(info, g.shiftTypeId)) revenue = round2(revenue + n(g._sum.clientRateSnapshot));
          }
        }
      }
    } else {
      revenue = round2(n(shiftAgg._sum.clientRateSnapshot));
    }

    // 規劃 session item 4：更別級（shift_type 掛實但 broker/guard 皆空）嘅
    // special 卡——例：啟航1331 Event Guard（ST0027）$11,700，唔按更數拆，
    // client_rate_snapshot 喺呢個更別本身故意留 null（避免同總表 1,200/更
    // 嘅內部名義價撞埋一張卡），所以呢筆要喺度加返先至同 P0 輸出一致。
    //
    // WP-AI3 第二輪 live 驗收 bug fix（老闆）額外揪到嘅同類問題：呢條
    // query 之前冇篩 effective_from/effective_to（同 `flatCard` 嗰條
    // query 修過嘅 bug 一樣），令呢張卡嘅金額會加落**任何**月份，包括
    // 完全唔相干嘅月份（例如業務未開始嘅 2025-07）——同「月費 fallback」
    // 果條係同一種「空月份假收入」問題，淨係嗰張卡本身生效區間已經覆蓋
    // 咗 2026-07（真實 P0 數據），冇覆蓋嘅月份而家會正確咁唔計呢張卡。
    const shiftTypeSpecialCards = await prisma.rateCard.findMany({
      where: {
        siteId: site.id,
        shiftTypeId: { not: null },
        brokerId: null,
        guardId: null,
        billingModel: "special",
        effectiveFrom: { lte: MONTH_END },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: MONTH_START } }],
      },
    });
    // M2（Opus 驗收）：呢批更別級 special 卡（例：Event Guard $11,700）
    // 同上面 flatCard 一樣要受「呢個盤呢個月係咪真係有活動」嘅閘管——
    // 之前呢度冇檢查，令一個零活動月份（例如未開波嘅月份）都會計出
    // 11,700 假營業額。冇活動就當呢批卡唔存在（`effectiveShiftTypeSpecialCards`）。
    const effectiveShiftTypeSpecialCards = hasAnyRecordThisMonth ? shiftTypeSpecialCards : [];
    for (const c of effectiveShiftTypeSpecialCards) revenue = round2(revenue + n(c.clientRate));

    // WP-PRICE bug fix：呢度要用 `effectiveFlatCard`／`effectiveShiftTypeSpecialCards`
    // （唔係 `flatCard`／`shiftTypeSpecialCards`）——一張已經伸長做無限
    // 期、但呢個月完全冇活動嘅卡唔可以令個 site 被當「有活動」而顯示喺
    // mainRows/outsideRows（見上面同一段註解）。
    const hasRawActivity = shifts > 0 || effectiveFlatCard !== null || effectiveShiftTypeSpecialCards.length > 0 || monthlyFeeProrataRevenue() !== null;

    // out_of_scope（LINK C7）：shift_records 記錄咗留底，但 P0 regen 報表
    // 唔計呢啲 site 入更數/營業額/成本（全部顯示 0，「記錄但唔計數」，
    // 但個 site 仍然會顯示喺「月結以外」，淨係數值歸零）
    if (!site.inScope) {
      shifts = 0;
      revenue = 0;
      cost = 0;
    }

    // 盤級 special_items（例：HKU Y更「獨立雞頭費」94更）摺埋入嗰個 site
    // 自己嘅主行——同 P0 regen 輸出一致（monthly-diff.csv 明確話呢類係
    // 「R2副行，已摺埋入S006」，唔係獨立一行）。S064（billing_model=
    // special 嘅個別雞頭 Event 客戶）冇任何 shift_records，唔會行到呢度，
    // 佢自己嘅 Tenti/HKW 兩行喺下面 individualBrokerEventItems 段落獨立處理。
    // 只摺 standalone_broker_fee（獨立雞頭費）嘅更數/營業額——同 P0 輸出一致，
    // 佢個「成本」欄冇計呢筆（cost 本身已經標「不完整」，呢個 P1-WP1 唔強行加）。
    // supplemental（龍譽/惠康補單）同 individual_broker_event 嘅 revenue 已經由 flat rate_card
    // /獨立 outsideRows 處理，唔可以喺度再摺一次（否則會計多一倍）。
    const siteSpecialItems = await prisma.specialItem.findMany({ where: { siteId: site.id, kind: "standalone_broker_fee", month: MONTH_START, voidedAt: null } });
    for (const it of siteSpecialItems) {
      shifts += it.shifts ?? 0;
      revenue = round2(revenue + n(it.revenue));
    }

    const hasActivity = hasRawActivity || siteSpecialItems.length > 0 || !site.inScope;
    if (!hasActivity) continue; // 同 P0 輸出一致：完全冇活動嘅 site（例：卓弘/嘉捷嘅舊 placeholder）唔顯示

    const profit = round2(revenue - cost);
    const marginPct = cost > 0 && revenue > 0 ? round2((profit / revenue) * 100) : null;

    const longtermSalaryAllocated = round2(salaryBySite.get(site.id) ?? 0);
    const brokerCashOnLongterm = brokerCashOnLongtermBySite.get(site.id) ?? 0;
    const fullCost = round2(cost + longtermSalaryAllocated);
    const fullProfit = round2(revenue - fullCost);
    const fullMarginPct = fullCost > 0 && revenue > 0 ? round2((fullProfit / revenue) * 100) : null;

    const row: MonthlyCloseSiteRow = {
      siteId: site.id,
      canonicalName: site.canonicalName,
      shifts,
      revenue,
      cost,
      profit,
      marginPct,
      note: cost === 0 ? "成本不完整" : null,
      longtermSalaryAllocated,
      brokerCashOnLongterm,
      fullCost,
      fullProfit,
      fullMarginPct,
    };

    // PDPO：唔可以用 site.clientGroup 呢類自由文字真名比對（真名喺
    // gitignored 嘅 CSV 入面），改用 billingModel==="special"——喺呢個
    // 資料集入面 S064（個別雞頭 Event 客戶）係唯一一個 billing_model=
    // special_income 嘅盤，效果一致，但比對條件本身唔含真名。
    //
    // B2（Opus 對抗式驗收第四輪）：另外兩個真實客戶公司名搬去 gitignored 嘅
        // data/mappings-private/report-overrides.json，經 excludedClientNames()
    // 讀入。冇私隱檔就跌返空 array，`.includes()` 自然一律唔中（呢個
    // 分類判斷本身「跳過」，唔強行假設）——受影響嘅幾個 site 會留喺主表，
    // diffMonthlyClose() 對唔返 P0「月結以外」sheet 會自然跌落 info 分支
    // （唔係 fail，見 scripts/report/diff.ts）。
    // 2026-09-12 部署修正：唔再喺報表 runtime 讀 data/ 私密檔（正式容器冇 data/），
    // 改讀 sites.outside_monthly_close（seed 由私密檔填；盤管理頁可改）。
    const isOutside = !site.inScope || site.outsideMonthlyClose || site.billingModel === "special";
    (isOutside ? outsideRows : mainRows).push(row);
  }

  // 個別雞頭 Event 特殊收入項（special_items，revenue 有值先顯示喺
  // 「月結以外」——見 seed 段落註解，同 P0 輸出嘅兩行「Tenti」「HKW」對齊）
  const individualBrokerEventItems = await prisma.specialItem.findMany({
    where: { kind: "individual_broker_event", revenue: { not: null }, month: MONTH_START, voidedAt: null },
  });
  for (const it of individualBrokerEventItems) {
    // label 對齊 P0 regen 輸出「月結以外」sheet 嘅寫法（"Tenti"／"HKW"）
    const label = it.description?.includes("Tenti") ? "Tenti" : it.description?.includes("HKW") ? "HKW" : it.description?.split("——")[0] ?? "個別雞頭 Event";
    outsideRows.push({
      siteId: "special:" + it.id,
      canonicalName: label,
      shifts: it.shifts ?? 0,
      revenue: round2(n(it.revenue)),
      cost: round2(n(it.cost)),
      profit: round2(n(it.revenue) - n(it.cost)),
      marginPct: null,
      note: it.description,
      longtermSalaryAllocated: 0,
      brokerCashOnLongterm: 0,
      fullCost: round2(n(it.cost)),
      fullProfit: round2(n(it.revenue) - n(it.cost)),
      fullMarginPct: null,
    });
  }

  // WP-LTPAY §21 任務 4d（老闆 2026-09-26 指令）：長工 Autopay／MPF ER
  // 另列——**淨係 2026-08 起**（月份閘，7 月 gate 唔變；7 月冇經
  // `recomputeLongtermPayroll()` 出過官方 run，唔應該喺呢度冒認一個
  // 數出嚟）。刻意**唔**加落 `mainRows`/`outsideRows` 嘅 `cost`/`profit`
  // （避免影響同 P0「月結總表」逐格 0-diff 嘅核心口徑，見檔頭註解）——
  // 「另列」＝獨立一個 top-level 欄，一鍵結算報告／頁面自己揀顯示定
  // 加落總成本。讀最新一個未 void 嘅 `longterm_payroll_runs`（冇就
  // null，例如未跑過 `recomputeLongtermPayroll()`）。
  const longtermPayrollActual = await buildLongtermPayrollActualTotals(MONTH_START);

  // WP-LTPAY §21 任務 5a（老闆定案，§16.2 預算表第一層口徑）：
  // 「合併成本」＝更次成本（mainRows/outsideRows.cost，即散工更×出街價，
  // 淨係 2026-08 起先加返長工 Autopay／介紹費）＋長工 Autopay（Gross－
  // MPF 僱員，嚟自 `longtermPayrollActual`）＋介紹費（`special_items`
  // kind=referral_fee，全公司該月總額）。MPF 僱主（ER）**另列一行，
  // 唔入呢個合計**（§16.2：「長工 MPF（僱員＋僱主）唔喺第一層，全部落
  // 第二層」）。刻意**唔**改 `mainRows`/`outsideRows` 嘅 `cost`/`profit`
  // /`fullCost`（避免影響同 P0「月結總表」逐格 0-diff 嘅核心口徑，見
  // 上面 `buildLongtermPayrollActualTotals()` 同一段解釋）——呢個係
  // 額外一個 top-level 摘要，畀一鍵結算報告／月結頁面自己顯示。
  const perShiftCostTotal = round2(mainRows.reduce((a, r) => a + r.cost, 0) + outsideRows.reduce((a, r) => a + r.cost, 0));
  const referralFeeTotal = await sumReferralFeeForMonth(MONTH_START);
  const combinedCostSummary = buildCombinedCostSummaryPure(MONTH_START, perShiftCostTotal, referralFeeTotal, longtermPayrollActual);

  return { mainRows, outsideRows, longtermPayrollActual, combinedCostSummary };
}

const LTPAY_MONTHLY_CLOSE_GATE_START = new Date(Date.UTC(2026, 7, 1)); // 2026-08

export interface LongtermPayrollActualTotals {
  runId: string;
  grossTotal: number;
  autopayTotal: number;
  mpfEeTotal: number;
  mpfErTotal: number;
  guardCount: number;
  /** §14 規則 12 簽證形式長工部分（已包喺上面總數；雞頭結算扣返，合併成本要剔走）。 */
  visaPassthroughAutopayTotal: number;
  visaPassthroughGuardCount: number;
}

export async function buildLongtermPayrollActualTotals(monthStart: Date): Promise<LongtermPayrollActualTotals | null> {
  if (monthStart.getTime() < LTPAY_MONTHLY_CLOSE_GATE_START.getTime()) return null;
  const run = await prisma.longtermPayrollRun.findFirst({
    where: { month: monthStart, voidedAt: null, status: { not: "void" } },
    orderBy: { createdAt: "desc" },
  });
  if (!run || !run.totalsJson) return null;
  const totals = run.totalsJson as unknown as { grossTotal?: number; autopayTotal?: number; mpfEeTotal?: number; mpfErTotal?: number; guardCount?: number; visaPassthrough?: { autopayTotal?: number; guardCount?: number } };
  return {
    runId: run.id,
    grossTotal: n(totals.grossTotal),
    autopayTotal: n(totals.autopayTotal),
    mpfEeTotal: n(totals.mpfEeTotal),
    mpfErTotal: n(totals.mpfErTotal),
    guardCount: totals.guardCount ?? 0,
    visaPassthroughAutopayTotal: n(totals.visaPassthrough?.autopayTotal),
    visaPassthroughGuardCount: totals.visaPassthrough?.guardCount ?? 0,
  };
}

/** §21 任務 5a：該月全部 `special_items kind=referral_fee`（介紹費）總額
 * ——唔理有冇配對到 site（呢度要嘅係全公司總數，唔係逐盤拆分，同
 * `gross-margin.ts` 逐盤 `referralFeeBySite`／`referralFeeUnattributed`
 * 呢兩個字唔同用途但同一批資料）。 */
async function sumReferralFeeForMonth(monthStart: Date): Promise<number> {
  const items = await prisma.specialItem.findMany({ where: { kind: "referral_fee", month: monthStart, voidedAt: null } });
  return round2(items.reduce((a, it) => a + n(it.cost), 0));
}

export interface CombinedCostSummary {
  /** 更次成本（散工更×出街價；monthly-close.ts 呢個口徑本身未計介紹費／
   * 長工 autopay，gross-margin.ts caller 傳入嗰陣已經扣走）。 */
  perShiftCostTotal: number;
  /** 介紹費（長工雞頭費，`special_items kind=referral_fee`，全公司該月總額）。 */
  referralFeeTotal: number;
  /** 長工 Autopay（Gross－MPF 僱員），嚟自 `longtermPayrollActual`——
   * 2026-08 前恆 0（gate 未開）。**已剔走簽證形式長工**（§14 規則 12：
   * 雞頭結算扣返，唔係公司成本；8 月預算表 B5 口徑＝55 人唔含佢）。 */
  longtermAutopayTotal: number;
  /** 被剔走嘅簽證形式長工 Autopay（顯示用，講清楚點解同糧單總數唔同）。 */
  visaPassthroughAutopayExcluded: number;
  /** §16.2 第一層「成本」＝更次成本＋介紹費＋長工 Autopay。 */
  combinedCostTotal: number;
  /** MPF 僱主（ER）——另列，唔入 `combinedCostTotal`（§16.2：MPF 落第二層）。 */
  mpfErTotal: number;
}

/** 純函數（冇 DB 依賴）——`monthly-close.ts`／`gross-margin.ts` 兩邊都用
 * 呢個組裝最後嗰個摘要物件，保證兩邊口徑一致。淨係 2026-08 起有值
 * （同 `buildLongtermPayrollActualTotals()` 一致嘅月份閘，7 月 gate
 * 完全唔受影響）。 */
export function buildCombinedCostSummaryPure(
  monthStart: Date,
  perShiftCostTotal: number,
  referralFeeTotal: number,
  longtermPayrollActual: LongtermPayrollActualTotals | null,
): CombinedCostSummary | null {
  if (monthStart.getTime() < LTPAY_MONTHLY_CLOSE_GATE_START.getTime()) return null;
  const visaPassthroughAutopayExcluded = longtermPayrollActual?.visaPassthroughAutopayTotal ?? 0;
  const longtermAutopayTotal = round2((longtermPayrollActual?.autopayTotal ?? 0) - visaPassthroughAutopayExcluded);
  const mpfErTotal = longtermPayrollActual?.mpfErTotal ?? 0;
  return {
    perShiftCostTotal: round2(perShiftCostTotal),
    referralFeeTotal: round2(referralFeeTotal),
    longtermAutopayTotal,
    visaPassthroughAutopayExcluded,
    combinedCostTotal: round2(perShiftCostTotal + referralFeeTotal + longtermAutopayTotal),
    mpfErTotal,
  };
}

export async function writeMonthlyCloseXlsx(outPath: string, month: Date = DEFAULT_REPORT_MONTH) {
  const { mainRows, outsideRows } = await buildMonthlyClose(month);
  const wb = new ExcelJS.Workbook();

  const headers = [
    "工作地點",
    "site_id",
    "更數",
    "營業額",
    "成本",
    "盈利",
    "%",
    "長工月薪分攤",
    "完整成本",
    "完整盈利",
    "完整%",
    "備註",
  ];

  function writeSheet(name: string, rows: MonthlyCloseSiteRow[], withSubtotal: boolean) {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    for (const r of rows) {
      ws.addRow([
        r.canonicalName,
        r.siteId,
        r.shifts,
        r.revenue,
        r.cost,
        r.profit,
        r.marginPct === null ? "n/a" : `${r.marginPct}%`,
        r.longtermSalaryAllocated,
        r.fullCost,
        r.fullProfit,
        r.fullMarginPct === null ? "n/a" : `${r.fullMarginPct}%`,
        r.note ?? "",
      ]);
    }
    if (withSubtotal) {
      const shifts = rows.reduce((a, r) => a + r.shifts, 0);
      const revenue = round2(rows.reduce((a, r) => a + r.revenue, 0));
      const cost = round2(rows.reduce((a, r) => a + r.cost, 0));
      const profit = round2(revenue - cost);
      const fullCost = round2(rows.reduce((a, r) => a + r.fullCost, 0));
      const fullProfit = round2(revenue - fullCost);
      ws.addRow([
        "Sub-Total",
        "",
        shifts,
        revenue,
        cost,
        profit,
        cost > 0 ? `${round2((profit / revenue) * 100)}%` : "n/a",
        round2(rows.reduce((a, r) => a + r.longtermSalaryAllocated, 0)),
        fullCost,
        fullProfit,
        fullCost > 0 ? `${round2((fullProfit / revenue) * 100)}%` : "n/a",
        "",
      ]);
    }
  }

  writeSheet("月結對照(R2口徑)", mainRows, true);
  writeSheet("月結以外", outsideRows, false);

  // Opus 驗收「可延後但順手」：註明「長工月薪分攤」呢欄嘅 scope——呢個
  // sheet 淨係覆蓋 P0 對數基準嘅盤（mainRows/outsideRows，即 buildMonthlyClose()
  // 揀落嚟嘅 site），**唔係**全部有 shift_records 嘅盤（gross-margin.ts
  // 嘅「毛利即時表」先係全部盤，見嗰個檔案自己嘅 footer 註解）——兩份
  // 報表嘅「長工月薪分攤」總額可能唔一致，屬預期（呢個 sheet 嘅
  // Sub-Total 淨係呢個 sheet 本身列出嗰批盤嘅分攤和，唔等於 Σ全部
  // monthly_salary）。
  const noteWs = wb.addWorksheet("備註");
  noteWs.addRow(["長工月薪分攤 scope"]);
  noteWs.addRow(["呢份月結總表嘅「長工月薪分攤」／「完整成本」／「完整盈利」呢幾欄，scope 淨係 mainRows/月結以外（P0 對數基準嘅盤）。"]);
  noteWs.addRow(["毛利即時表（GET /api/reports/gross-margin）嘅長工月薪分攤覆蓋全部本月有 shift_records 嘅盤（唔止呢份月結表嘅盤），兩份報表嘅分攤總額可能唔一致，屬設計預期。"]);

  await wb.xlsx.writeFile(outPath);
  return { mainRows, outsideRows };
}
