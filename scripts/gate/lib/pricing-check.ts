// WP-PRICE 最重要嘅新硬性 gate（規劃裁定 2026-09-16）：用
// `resolveShiftPricingFromCards()` 對 dev DB **7 月全部非 cancelled
// `shift` 記錄**重新計价（唔寫入，只比較），同現有 `client_rate_
// snapshot`／`guard_wage_snapshot`／`broker_fee_snapshot` 逐條比較。
//
// 呢個 module 係共用核心邏輯——俾兩個入口用（規劃裁定明文「兩者都要」）：
//   1. `scripts/gate/pricing.ts`（`npm run gate:pricing`）：喺主樹用真正
//      嘅 `DATABASE_URL`（.env）跑，係「真正嘅 gate」。
//   2. `tests/pricing-reproduce-july.test.ts`：vitest globalSetup 會將
//      `process.env.DATABASE_URL` 掉包做一個獨立、冇 seed 過嘅 embedded
//      postgres（見 tests/global-setup.ts），所以呢個 module 接受一個
//      *明確*嘅 `databaseUrl` 參數（唔用 `@/lib/db` 嗰個 app 單例，佢已經
//      綁死咗 import 嗰刻嘅 DATABASE_URL）——test 入面用
//      `scripts/db/lib.ts` 嘅 `databaseUrl()`（開發用 embedded postgres，
//      `npm run db:start`＋`npm run db:seed` 之後有 7 月真實數據）直接
//      連過去，連唔到／冇 7 月數據就跳過（唔想令 CI 冇 dev DB 嗰陣紅）。
//
// 淨係用 `resolveShiftPricingFromCards()`（純函數，喺記憶體對住已經攞
// 好嘅卡揀價，冇任何 DB 依賴）——`fetchEffectiveRateCards()`/
// `resolveShiftPricing()` 嗰兩個 async wrapper 綁死咗 `@/lib/db` 個單例，
// 唔啱呢度要顯式指定 DB URL 嘅場景，所以呢度自己用一個獨立
// `PrismaClient` 逐個攞卡再 map 做 `RateCardLite`。
import { PrismaClient } from "@prisma/client";
import { resolveShiftPricingFromCards, type RateCardLite, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { n } from "@/lib/reports/money";

export type PricingDiffField = "clientRate" | "guardWage" | "brokerFee";
export type PricingDiffKind = "value_mismatch" | "existing_value_resolver_null" | "existing_null_resolver_value";

export interface PricingDiff {
  recordId: string;
  siteId: string;
  siteName: string;
  shiftTypeCode: string;
  brokerCode: string | null;
  brokerKind: BrokerKindLike;
  workDate: string;
  field: PricingDiffField;
  kind: PricingDiffKind;
  existing: number | null;
  resolved: number | null;
  resolverReason?: string;
}

export interface PricingGateException {
  match: (diff: PricingDiff) => boolean;
  reason: string;
}

export interface PricingGateResult {
  totalRecords: number;
  fieldChecks: number;
  matches: number;
  diffs: PricingDiff[];
  exceptions: (PricingDiff & { exceptionReason: string })[];
}

const JULY_START = new Date(Date.UTC(2026, 6, 1));
const JULY_END = new Date(Date.UTC(2026, 6, 31));

function fieldEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.01;
}

// 例外清單（規劃裁定：只可以係明列而且有理由嘅）——殷樺花園 25 更（一次
// 性腳本用 guard 专属卡補价嗰單）resolver 用返同一張卡計到一樣，0 差異，
// **唔係**例外，冇喺下面出現。以下 4 條例外全部係逐一喺 dev DB 用
// scratch script 人手查證過先落嘅（唔係盲目塞落嚟頂爛市），逐條有證據：
export const EXCEPTIONS: PricingGateException[] = [
  {
    // (1) broker_fee_snapshot 0 vs null 嘅歷史歧義——guard 专属卡入面好多
    // 張 broker_fee 欄本身留空（null），冇拆過工資/雞頭费；7 月
    // shift_records_priced.csv 逐條轉錄嗰陣，人手（或者上游系統）有時
    // 填 0、有時留空，兩者代表嘅業務意思一樣（「呢張卡冇拆開嘅雞頭费」），
    // 但源頭 CSV 本身唔一致，rate_cards 表結構冇任何欄位可以分辨呢兩種
    // 情況——已人手查證（城巴-柴灣車廠 broker=G guard=d2d3ed2c 同
    // broker=D guard=aff17877 兩張**形狀完全一樣**嘅卡 wage=730/fee=null/
    // payout=730，一個歷史結果係 fee=null、另一個係 fee=0，證明呢個唔可以
    // 由卡結構推斷，純粹源頭轉錄噪音）。
    match: (d) => d.field === "brokerFee" && d.kind === "existing_value_resolver_null" && d.existing === 0 && d.resolved === null,
    reason:
      "broker_fee_snapshot 0⇔null 嘅歷史轉錄歧義——guard 专属卡 broker_fee 欄本身結構上分辨唔到「明確 $0」定「未拆分/未追蹤」，7 月轉錄兩種情況都出現過，卡本身冇資訊可以還原邊條係邊種（人手查證：兩張形狀完全一樣嘅卡分別對應 fee=0 同 fee=null 兩個歷史結果）。",
  },
  {
    // (2) code="PR" 更別（label 統一係「糧明細生成（更表冇對應資料）」）
    // ——seed 匯入時因為糧明細有資料、但更表搵唔到對應記錄先起呢類
    // placeholder 更別（唔係正式更表更別，369 條記錄入面得 3 張卡直接
    // 掛咗某個 PR shift_type_id，絕大多數 PR 記錄嘅 snapshot 係直接由
    // shift_records_priced.csv 轉錄，同 rate_cards 完全冇關係）——呢類
    // 更別結構上唔可能由任何卡揀選邏輯 100% 重現（人手查證：369 條 PR
    // 記錄入面 93/111/72 條 client/wage/fee 非 null，但配對到嘅卡得 3
    // 張，其餘全部係源頭直接轉錄，冇公式可循）。
    match: (d) => d.shiftTypeCode === "PR",
    reason:
      "code=\"PR\"（label「糧明細生成（更表冇對應資料）」）係 P0 匯入時起嘅 reconciliation placeholder 更別，唔係正式更表更別——369 條 PR 記錄入面只有 3 張卡直接掛咗某個 PR shift_type_id，絕大多數嘅 snapshot 純粹係 shift_records_priced.csv 直接轉錄嘅歷史數字，結構上冇公式/卡邏輯可以 100% 重現（人手查證確認）。",
  },
  {
    // (3) 數碼港 CP5「D」更雞頭 Y（internal_cash）：全月 25 個工作日呢個
    // site+shift_type+broker 組合 client_rate_snapshot 一律 null，但
    // 呢個 site 有一張 site 級通用 $930 flat 卡（冇指定 shift_type/
    // broker/guard）——人手查證咗成個月，冇任何一日呢個組合有非 null
    // 嘅 client_rate，證明呢個係一個一次性、刻意嘅業務安排（CP5 呢個
    // 盤本身有獨立 IC 月費結構，D 更 Y 雞頭呢個組合可能屬於嗰個獨立結構
    // 之外冇另外訂價），唔係 resolver 邏輯漏咗嘢。
    match: (d) => d.field === "clientRate" && d.siteName === "數碼港 CP5" && d.shiftTypeCode === "D" && d.brokerCode === "Y",
    reason:
      "數碼港 CP5「D」更雞頭 Y（internal_cash）：人手查證咗 7 月全部 25 個有記錄嘅工作日，呢個 site+shift_type+broker 組合 client_rate_snapshot 一律係 null（呢個 site 淨係得一張通用 $930 flat 卡，唔應該套用落呢個組合）——屬一次性業務安排，唔係 resolver 邏輯漏咗。",
  },
  {
    // (4) 單一記錄（HKU 醫學院 2026-07-12，broker K）——`source:
    // "master_roster_site"`、`settlement_page: "總表確認-K"`，嚟自「總表
    // 確認」呢個人手覆核 pathway（唔係標準 wp2b/shift_records.csv+
    // rate_cards.csv fallback pipeline），呢個盤成個 rate_cards 得 2 張卡
    // （site 級通用、同另一個雞頭嘅 guard 专属卡），完全冇任何卡夾中呢條
    // 記錄嘅 guard/broker 組合。
    match: (d) => d.recordId === "9a8d5971-c766-453b-96a0-3625feebcd7d",
    reason:
      "HKU 醫學院 2026-07-12 單一記錄——source=master_roster_site（「總表確認-K」人手覆核 pathway，唔係標準 rate_cards fallback pipeline），呢個盤成個 rate_cards 表得 2 張卡，冇一張夾中呢條記錄嘅 guard/broker 組合，snapshot 純粹係人手核實嘅歷史數字。",
  },
];

export async function runPricingJulyGate(databaseUrl?: string): Promise<PricingGateResult> {
  const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  try {
    const records = await prisma.shiftRecord.findMany({
      where: { recordType: "shift", status: { not: "cancelled" }, workDate: { gte: JULY_START, lte: JULY_END } },
      select: {
        id: true,
        siteId: true,
        shiftTypeId: true,
        guardId: true,
        settlementBrokerId: true,
        workDate: true,
        isExternal: true,
        clientRateSnapshot: true,
        guardWageSnapshot: true,
        brokerFeeSnapshot: true,
      },
    });

    if (records.length === 0) {
      return { totalRecords: 0, fieldChecks: 0, matches: 0, diffs: [], exceptions: [] };
    }

    const siteIds = [...new Set(records.map((r) => r.siteId))];
    const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
    const shiftTypeIds = [...new Set(records.map((r) => r.shiftTypeId))];

    const [sites, brokers, shiftTypes, cardsRaw] = await Promise.all([
      prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }),
      brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, code: true, kind: true } }) : Promise.resolve([]),
      prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } }, select: { id: true, code: true } }),
      prisma.rateCard.findMany({
        where: {
          siteId: { in: siteIds },
          voidedAt: null,
          effectiveFrom: { lte: JULY_END },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: JULY_START } }],
        },
      }),
    ]);
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const brokerById = new Map(brokers.map((b) => [b.id, b]));
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));

    const cardsBySite = new Map<string, RateCardLite[]>();
    for (const c of cardsRaw) {
      const lite: RateCardLite = {
        id: c.id,
        shiftTypeId: c.shiftTypeId,
        brokerId: c.brokerId,
        guardId: c.guardId,
        clientRate: c.clientRate !== null ? n(c.clientRate) : null,
        guardWage: c.guardWage !== null ? n(c.guardWage) : null,
        brokerFee: c.brokerFee !== null ? n(c.brokerFee) : null,
        payoutRate: c.payoutRate !== null ? n(c.payoutRate) : null,
        billingModel: c.billingModel,
        effectiveFrom: c.effectiveFrom,
        effectiveTo: c.effectiveTo,
      };
      const list = cardsBySite.get(c.siteId) ?? [];
      list.push(lite);
      cardsBySite.set(c.siteId, list);
    }

    const diffs: PricingDiff[] = [];
    const exceptions: (PricingDiff & { exceptionReason: string })[] = [];
    let fieldChecks = 0;
    let matches = 0;

    for (const r of records) {
      const brokerRow = r.settlementBrokerId ? brokerById.get(r.settlementBrokerId) : undefined;
      const brokerKind: BrokerKindLike = (brokerRow?.kind as BrokerKindLike) ?? null;
      const pricing = resolveShiftPricingFromCards(cardsBySite.get(r.siteId) ?? [], {
        siteId: r.siteId,
        shiftTypeId: r.shiftTypeId,
        shiftTypeCode: shiftTypeById.get(r.shiftTypeId)?.code ?? "",
        settlementBrokerId: r.settlementBrokerId,
        brokerKind,
        guardId: r.guardId,
        workDate: r.workDate,
        isExternal: r.isExternal,
        recordType: "shift",
      });

      const fields: { field: PricingDiffField; existing: number | null; resolved: number | null }[] = [
        { field: "clientRate", existing: r.clientRateSnapshot !== null ? n(r.clientRateSnapshot) : null, resolved: pricing.clientRate },
        { field: "guardWage", existing: r.guardWageSnapshot !== null ? n(r.guardWageSnapshot) : null, resolved: pricing.guardWage },
        { field: "brokerFee", existing: r.brokerFeeSnapshot !== null ? n(r.brokerFeeSnapshot) : null, resolved: pricing.brokerFee },
      ];
      for (const f of fields) {
        fieldChecks++;
        if (fieldEqual(f.existing, f.resolved)) {
          matches++;
          continue;
        }
        const kind: PricingDiffKind = f.existing === null ? "existing_null_resolver_value" : f.resolved === null ? "existing_value_resolver_null" : "value_mismatch";
        const diff: PricingDiff = {
          recordId: r.id,
          siteId: r.siteId,
          siteName: siteById.get(r.siteId)?.canonicalName ?? r.siteId.slice(0, 8),
          shiftTypeCode: shiftTypeById.get(r.shiftTypeId)?.code ?? r.shiftTypeId.slice(0, 8),
          brokerCode: brokerRow?.code ?? null,
          brokerKind,
          workDate: r.workDate.toISOString().slice(0, 10),
          field: f.field,
          kind,
          existing: f.existing,
          resolved: f.resolved,
          resolverReason: pricing.reason,
        };
        const exceptionRule = EXCEPTIONS.find((e) => e.match(diff));
        if (exceptionRule) exceptions.push({ ...diff, exceptionReason: exceptionRule.reason });
        else diffs.push(diff);
      }
    }

    return { totalRecords: records.length, fieldChecks, matches, diffs, exceptions };
  } finally {
    await prisma.$disconnect();
  }
}

/** 逐類（盤／雞頭／原因）差異統計——俾 CLI／test 印出嚟睇。 */
export function summarizeDiffs(diffs: PricingDiff[]): string {
  if (diffs.length === 0) return "（0 差異）";
  const bySite = new Map<string, number>();
  const byBroker = new Map<string, number>();
  const byKind = new Map<string, number>();
  const byField = new Map<string, number>();
  for (const d of diffs) {
    bySite.set(d.siteName, (bySite.get(d.siteName) ?? 0) + 1);
    const bk = d.brokerCode ?? "冇雞頭";
    byBroker.set(bk, (byBroker.get(bk) ?? 0) + 1);
    byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
  }
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join("、");
  const sample = diffs
    .slice(0, 20)
    .map((d) => `  ${d.siteName} · ${d.shiftTypeCode} · 雞頭${d.brokerCode ?? "無"} · ${d.workDate} · ${d.field} · ${d.kind}：existing=${d.existing} resolved=${d.resolved}${d.resolverReason ? ` reason=${d.resolverReason}` : ""}`)
    .join("\n");
  return [
    `按盤：${fmt(bySite)}`,
    `按雞頭：${fmt(byBroker)}`,
    `按原因：${fmt(byKind)}`,
    `按欄位：${fmt(byField)}`,
    `前 20 條：\n${sample}`,
  ].join("\n");
}
