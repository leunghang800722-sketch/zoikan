// WP-LTSHIFT（老闆 2026-09-26 §3）：長工介紹費自動計。
//
// 背景（`data/2026-09/aug-e2e-check/報告-2026-09-26.md` B4）：總表 8 月
// 有 60,520 嘅「長工雞頭費」（邊個雞頭介紹邊個長工入職，介紹雞頭可以
// 收返介紹費），但系統 `special_items(kind=referral_fee)` 8 月 0 條——
// 呢個 module 由「邊個長工由邊個雞頭介紹」（`guards.referral_broker_id`）
// ＋「呢個長工喺自己崗位盤做咗幾多 B07 更」（`shift_records`，
// settlement_broker.kind=internal_longterm）＋「呢個雞頭呢個盤（或者
// 預設）嘅費率」（`referral_fee_rates`）計出嚟。
//
// 公式（§3）：每月每雞頭 = Σ（該雞頭介紹嘅長工，喺其崗位盤嘅 B07 更數
// × referral_fee_rates(broker, site 或預設)），**卓弘客戶盤豁免**
// （`sites.client_group = '卓弘'`，規則 12a）。
//
// 分兩層（同呢個 repo「fetch / resolve」一貫手法一致）：
//   1. `computeReferralFees()`：純函數，喺記憶體逐 (guard, site) 計。
//   2. `computeReferralFeesForMonth()`：DB loader，包好上面嘅純函數。
//   3. `recomputeReferralFees()`：套用——upsert `special_items
//      (kind=referral_fee)`。**7 月唔重算**（7 月已經人手入咗，見
//      gross-margin.ts 頂註解），呢個函數拒絕 month < 2026-08。
import { prisma } from "@/lib/db";
import { monthStart as toMonthStart } from "@/lib/month-lock";
import { n, round2 } from "./money";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { parsePostorderWorkbookBuffer, type PostorderReferralRow } from "@/lib/guard-fix/postorder";
import { matchBroker, matchSite, type BrokerCandidate, type SiteCandidate } from "@/lib/roster-upload/match";

/** 卓弘客戶盤豁免介紹費（規則 12a）。 */
export const REFERRAL_FEE_EXEMPT_CLIENT_GROUP = "卓弘";

/** 驗收（Opus 5.5，2026-09-26）：規則 12a 原文「8 月結算跟月結表全數支付
 * （唔扣）」、「規則由 9 月起生效」——之前 8 月都豁免咗，少計 T 1,380
 * （同總表 60,520 對唔上）。豁免由呢個月份起先生效。 */
export const REFERRAL_FEE_EXEMPT_FROM_MONTH = "2026-09-01";

/** 呢個 recompute 唔可以碰嘅月份——7 月總表已經人手入咗 referral_fee
 * special_items（`scripts/seed/lib/py/extract_referral_fees.py`），唔可以
 * 用自動公式覆蓋（鐵則：7 月四個 gate 數字不變）。 */
export const REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH = "2026-08-01";

export interface ReferralFeeGuardInput {
  guardId: string;
  referralBrokerId: string;
}

export interface ReferralFeeShiftCountInput {
  guardId: string;
  siteId: string;
  count: number;
}

export interface ReferralFeeRateInput {
  brokerId: string;
  /** null = 該雞頭全盤預設費率。 */
  siteId: string | null;
  feePerShift: number;
}

export interface ReferralFeeSiteInput {
  siteId: string;
  clientGroup: string | null;
}

export interface ReferralFeeLineItem {
  brokerId: string;
  guardId: string;
  siteId: string;
  shifts: number;
  feePerShift: number;
  amount: number;
}

export interface ReferralFeeWarning {
  guardId: string;
  brokerId: string;
  siteId: string;
  shifts: number;
  reason: string;
}

export interface ComputeReferralFeesResult {
  lineItems: ReferralFeeLineItem[];
  /** 逐雞頭合計（月結頁／報表顯示用）。 */
  totalsByBroker: Map<string, number>;
  totalAmount: number;
  /** 有 B07 更但計唔到費率（冇該雞頭該盤／預設費率）嘅組合——唔會靜靜
   * 當 0，攞出嚟俾會計覆核（保守：唔屈估一個費率）。 */
  warnings: ReferralFeeWarning[];
  /** 卓弘豁免咗幾多格（唔入 lineItems，淨係計數俾覆核睇）。 */
  exemptShiftCount: number;
}

/**
 * 純函數：逐 (guard, site) B07 更數 × 費率，卓弘豁免，冇費率嘅組合入
 * warnings（唔屈估）。
 */
export function computeReferralFees(input: {
  guards: ReferralFeeGuardInput[];
  shiftCounts: ReferralFeeShiftCountInput[];
  rates: ReferralFeeRateInput[];
  sites: ReferralFeeSiteInput[];
  /** 卓弘豁免係咪生效（呢個月 >= REFERRAL_FEE_EXEMPT_FROM_MONTH）；唔傳＝生效
   * （向下相容純函數測試）。 */
  exemptionActive?: boolean;
}): ComputeReferralFeesResult {
  const exemptionActive = input.exemptionActive ?? true;
  const referralBrokerByGuard = new Map(input.guards.map((g) => [g.guardId, g.referralBrokerId]));
  const clientGroupBySite = new Map(input.sites.map((s) => [s.siteId, s.clientGroup]));
  const rateByKey = new Map<string, number>(); // `${brokerId}|${siteId ?? ''}`
  for (const r of input.rates) rateByKey.set(`${r.brokerId}|${r.siteId ?? ""}`, r.feePerShift);

  const lineItems: ReferralFeeLineItem[] = [];
  const warnings: ReferralFeeWarning[] = [];
  let exemptShiftCount = 0;

  for (const sc of input.shiftCounts) {
    const brokerId = referralBrokerByGuard.get(sc.guardId);
    if (!brokerId) continue; // 呢個長工冇記錄邊個雞頭介紹——唔計
    if (exemptionActive && clientGroupBySite.get(sc.siteId) === REFERRAL_FEE_EXEMPT_CLIENT_GROUP) {
      exemptShiftCount += sc.count;
      continue; // 規則 12a：卓弘客戶盤豁免
    }
    const feePerShift = rateByKey.get(`${brokerId}|${sc.siteId}`) ?? rateByKey.get(`${brokerId}|`) ?? null;
    if (feePerShift === null) {
      warnings.push({ guardId: sc.guardId, brokerId, siteId: sc.siteId, shifts: sc.count, reason: "呢個雞頭喺呢個盤（或者全盤預設）冇設介紹費率，未計入" });
      continue;
    }
    lineItems.push({ brokerId, guardId: sc.guardId, siteId: sc.siteId, shifts: sc.count, feePerShift, amount: round2(sc.count * feePerShift) });
  }

  const totalsByBroker = new Map<string, number>();
  for (const li of lineItems) totalsByBroker.set(li.brokerId, round2((totalsByBroker.get(li.brokerId) ?? 0) + li.amount));
  const totalAmount = round2([...totalsByBroker.values()].reduce((a, b) => a + b, 0));

  return { lineItems, totalsByBroker, totalAmount, warnings, exemptShiftCount };
}

/** DB loader：攞呢個月計介紹費要嘅四份資料，交返純函數。 */
export async function computeReferralFeesForMonth(month: Date): Promise<ComputeReferralFeesResult> {
  const monthStartDate = toMonthStart(month);
  const monthEnd = new Date(Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0));

  const referredGuards = await prisma.guard.findMany({ where: { referralBrokerId: { not: null } }, select: { id: true, referralBrokerId: true } });
  const guardIds = referredGuards.map((g) => g.id);

  const shiftCountsRaw = guardIds.length
    ? await prisma.shiftRecord.groupBy({
        by: ["guardId", "siteId"],
        where: {
          guardId: { in: guardIds },
          workDate: { gte: monthStartDate, lte: monthEnd },
          status: { not: "cancelled" },
          // 驗收（Opus 5.5）：淨係計正更——之前冇篩 record_type，將長工
          // 自己崗位嘅假期格（AL/SL/OFF，都掛 B07）同 OT 都當咗「更」，
          // 8 月多計 12 條組合、約 11,000（總表「長工雞頭費」公式係
          // `費率×Total Shift`，Total Shift 只數返工格）。
          recordType: "shift",
          settlementBroker: { kind: "internal_longterm" },
        },
        _count: { _all: true },
      })
    : [];

  const siteIds = [...new Set(shiftCountsRaw.map((s) => s.siteId))];
  const brokerIds = [...new Set(referredGuards.map((g) => g.referralBrokerId).filter((v): v is string => v !== null))];

  const [sites, ratesUpToMonth] = await Promise.all([
    siteIds.length ? prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, clientGroup: true } }) : Promise.resolve([]),
    // WP-LTSHIFT §19：費率表「逐月可變」（schema 註解），但唔係逐個月都
    // 一定有人再入一次——冇呢個月嘅行就跌返用嗰個 (broker,site) 之前
    // 最近一個月嘅費率（effective-dated 查法，唔係一定要逐月人手重
    // 覆制一份先計到數）。淨係查 <= 目標月份、揀每個 (broker,site) 組合
    // 入面 month 最大嗰一行。
    brokerIds.length
      ? prisma.referralFeeRate.findMany({
          where: { brokerId: { in: brokerIds }, month: { lte: monthStartDate }, voidedAt: null },
          select: { brokerId: true, siteId: true, feePerShift: true, month: true },
          orderBy: { month: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const latestRateByKey = new Map<string, { brokerId: string; siteId: string | null; feePerShift: number }>();
  for (const r of ratesUpToMonth) {
    // orderBy month asc——同一個 key 後面嘅行（月份較新）覆蓋前面，
    // map 行完之後每個 key 剩低嗰個就係 <= 目標月份入面最新一個月嘅費率。
    latestRateByKey.set(`${r.brokerId}|${r.siteId ?? ""}`, { brokerId: r.brokerId, siteId: r.siteId, feePerShift: n(r.feePerShift) });
  }
  const rates = [...latestRateByKey.values()];

  return computeReferralFees({
    guards: referredGuards.map((g) => ({ guardId: g.id, referralBrokerId: g.referralBrokerId as string })),
    shiftCounts: shiftCountsRaw.map((s) => ({ guardId: s.guardId, siteId: s.siteId, count: s._count._all })),
    rates,
    sites: sites.map((s) => ({ siteId: s.id, clientGroup: s.clientGroup })),
    exemptionActive: monthStartDate >= new Date(REFERRAL_FEE_EXEMPT_FROM_MONTH),
  });
}

export interface PostorderReferralRateSync {
  /** 呢次新寫（或者改咗費率）嘅 (broker, site) 組合數。 */
  upserted: number;
  /** 對唔到雞頭／盤、或者同一 (broker, site) 喺總表出現兩個唔同費率（唔估）。 */
  skipped: string[];
}

/** 純函數：Postorder「長工雞頭費」行 → 逐 (brokerId, siteId) 費率。對唔到
 * 雞頭／盤就跳過；同一組合兩個唔同費率就成個組合唔用（唔准估）。 */
export function referralRatesFromPostorderRows(
  rows: readonly PostorderReferralRow[],
  brokers: readonly BrokerCandidate[],
  sites: readonly SiteCandidate[],
): { rates: Map<string, { brokerId: string; siteId: string; feePerShift: number }>; skipped: string[] } {
  const rates = new Map<string, { brokerId: string; siteId: string; feePerShift: number }>();
  const conflicted = new Set<string>();
  const skipped: string[] = [];
  for (const row of rows) {
    if (row.rate === null) {
      skipped.push(`row ${row.rowIndex}：公式讀唔到費率`);
      continue;
    }
    const brokerId = matchBroker(row.brokerLabelRaw, brokers);
    if (!brokerId) {
      skipped.push(`row ${row.rowIndex}：雞頭稱呼對唔到`);
      continue;
    }
    const siteIds = new Set<string>();
    for (const label of row.siteLabelsRaw) {
      const id = matchSite(label, sites);
      if (id) siteIds.add(id);
    }
    if (siteIds.size === 0) for (const label of row.siteLabelsFallbackRaw) {
      const id = matchSite(label, sites);
      if (id) siteIds.add(id);
    }
    if (siteIds.size === 0) {
      skipped.push(`row ${row.rowIndex}：盤名對唔到`);
      continue;
    }
    for (const siteId of siteIds) {
      const key = `${brokerId}|${siteId}`;
      if (conflicted.has(key)) continue;
      const cur = rates.get(key);
      if (cur && cur.feePerShift !== row.rate) {
        rates.delete(key);
        conflicted.add(key);
        skipped.push(`row ${row.rowIndex}：同一雞頭同一盤喺總表有兩個唔同費率，唔用`);
        continue;
      }
      rates.set(key, { brokerId, siteId, feePerShift: row.rate });
    }
  }
  return { rates, skipped };
}

/**
 * 驗收（Opus 5.5，2026-09-26）：本月有 Postorder 上載就以總表「長工雞頭
 * 費」公式嘅費率為準，寫入 `referral_fee_rates`（month＝本月，逐 broker×
 * site，audit）——之前淨係用 7 月 seed 嘅雞頭預設費率，例如 K 粉嶺安樂村
 * 貨倉總表係 60／更，系統用咗 K 預設 50。冇 Postorder 就乜都唔做（跟返
 * 現有費率表）。冪等：費率一樣就唔寫。
 */
export async function syncReferralRatesFromPostorder(month: Date, actorUserId: string, ip: string | null): Promise<PostorderReferralRateSync> {
  const monthStartDate = toMonthStart(month);
  const po = await prisma.postorderUpload.findFirst({ where: { month: monthStartDate, status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { fileBytes: true } });
  if (!po) return { upserted: 0, skipped: [] };
  let parsed: Awaited<ReturnType<typeof parsePostorderWorkbookBuffer>>;
  try {
    parsed = await parsePostorderWorkbookBuffer(Buffer.from(po.fileBytes));
  } catch {
    // 保守：Postorder 讀唔到就唔郁費率表（跟返現有費率），唔擋重算。
    return { upserted: 0, skipped: ["Postorder 檔案解析失敗，費率跟返現有費率表"] };
  }
  const [brokersRaw, sitesRaw] = await Promise.all([
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } }),
  ]);
  const { rates, skipped } = referralRatesFromPostorderRows(parsed.referralRows, brokersRaw, sitesRaw);
  let upserted = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of rates.values()) {
      const existing = await tx.referralFeeRate.findFirst({ where: { brokerId: r.brokerId, siteId: r.siteId, month: monthStartDate } });
      if (existing && existing.voidedAt === null && n(existing.feePerShift) === r.feePerShift) continue;
      const row = existing
        ? await tx.referralFeeRate.update({ where: { id: existing.id }, data: { feePerShift: r.feePerShift, voidedAt: null, voidedBy: null } })
        : await tx.referralFeeRate.create({ data: { brokerId: r.brokerId, siteId: r.siteId, month: monthStartDate, feePerShift: r.feePerShift, createdBy: `postorder-referral-sync:${actorUserId}` } });
      await writeAuditTx(tx, { actorUserId, tableName: "referral_fee_rates", rowId: row.id, action: existing ? "update" : "create", before: existing ?? undefined, after: row, ip });
      upserted += 1;
    }
  });
  return { upserted, skipped };
}

export interface RecomputeReferralFeesResult extends ComputeReferralFeesResult {
  voidedCount: number;
  createdCount: number;
  rateSync: PostorderReferralRateSync;
}

/**
 * 套用——upsert `special_items(kind=referral_fee)`。**冪等＋唔會踩到
 * 人手輸入**：淨係作廢返自己之前 recompute 建低嗰批（`created_by` 前綴
 * `referral-fee-recompute:`），人手/7 月 seed 嗰批 `created_by` 唔係呢個
 * 前綴，唔會被呢個函數碰。7 月（或更早）月份拒絕（鐵則：7 月已人手入，
 * 唔可以用自動公式覆蓋）。
 */
export async function recomputeReferralFees(month: Date, actorUserId: string, ip: string | null): Promise<RecomputeReferralFeesResult> {
  const monthStartDate = toMonthStart(month);
  if (monthStartDate < new Date(REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH)) {
    throw BadRequest(`${REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH.slice(0, 7)} 之前嘅月份已經人手入咗長工介紹費，唔可以用自動公式重算`);
  }
  const rateSync = await syncReferralRatesFromPostorder(monthStartDate, actorUserId, ip);
  const result = await computeReferralFeesForMonth(monthStartDate);
  const createdByTag = `referral-fee-recompute:${actorUserId}`;

  const { voidedCount, createdCount } = await prisma.$transaction(async (tx) => {
    const priorAutoItems = await tx.specialItem.findMany({
      where: { month: monthStartDate, kind: "referral_fee", voidedAt: null, createdBy: { startsWith: "referral-fee-recompute:" } },
      select: { id: true },
    });
    let voided = 0;
    for (const item of priorAutoItems) {
      const before = await tx.specialItem.findUniqueOrThrow({ where: { id: item.id } });
      const after = await tx.specialItem.update({ where: { id: item.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      await writeAuditTx(tx, { actorUserId, tableName: "special_items", rowId: item.id, action: "void", before, after, ip });
      voided += 1;
    }

    let created = 0;
    for (const li of result.lineItems) {
      const row = await tx.specialItem.create({
        data: {
          month: monthStartDate,
          siteId: li.siteId,
          brokerId: li.brokerId,
          kind: "referral_fee",
          shifts: li.shifts,
          cost: li.amount,
          description: `WP-LTSHIFT 自動重算：介紹嘅長工 ${li.shifts} 個 B07 更 × $${li.feePerShift}/更`,
          createdBy: createdByTag,
        },
      });
      await writeAuditTx(tx, { actorUserId, tableName: "special_items", rowId: row.id, action: "create", after: row, ip });
      created += 1;
    }
    return { voidedCount: voided, createdCount: created };
  });

  return { ...result, voidedCount, createdCount, rateSync };
}
