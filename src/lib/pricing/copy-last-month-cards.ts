// WP-PHASE3（§20.4 Phase 3 item 3）：「複製上月卡到本月」——價目卡頁
// 一鍵按鈕，代替 8 月教訓入面「新月份要人手逐張補卡」嘅重複工作。
//
// 唔可以直接重用 `src/lib/month-close/one-click.ts` 嘅
// `（已移除嘅 findCarryoverCard）()`：嗰個函數淨係搵「盤級通用」（`broker_id`／
// `guard_id` 皆 null）嘅卡，一鍵結算 step0 用嚟做「揾唔到就 needs_human」
// 嘅保守單張沿用；呢度任務書明文要求覆蓋 (盤, 更種, 雞頭／通用) 呢個更
// 闊嘅組合（包括雞頭專屬價），批量複製一整個月，兩個係唔同用途嘅函數
// （唔係重寫，係新增）。
//
// 排除規則（任務書原文）：special／guard 級／LINK 盤／已有本月卡。
//   - special：`billingModel` 唔係 null／`per_shift`（月費/行政費/特殊卡
//     唔係「逐更卡」，唔喺呢個功能範圍——同 `（已移除嘅 findCarryoverCard）()` 一致
//     嘅 `OR:[{billingModel:null},{billingModel:"per_shift"}]`）。
//   - guard 級：`guardId` 唔係 null（人專屬價，通常係長工日均價，逐人
//     手動維護，唔應該批量複製）。
//   - LINK 盤：`site.guardsPaidByClient=true`（客戶直接出糧，唔逐更計
//     價，本身唔需要逐更卡，同 `stepPrecheck()` 一致排除）。
//   - 已有本月卡：同一 (site, shiftType, broker) 組合本月已經有生效卡
//     （`effectiveFrom<=本月最後一日 && (effectiveTo=null || effectiveTo>=
//     本月第一日)`）就跳過——保證冪等（連撳兩次，第二次候選一定 0）。
//
// 「上月生效嘅逐更卡」——同 `（已移除嘅 findCarryoverCard）()` 一致嘅嚴謹口徑：
// `effectiveTo` 逐字等如「上月最後一日」（唔係「效期跨住上月」呢種寬鬆
// 判斷）——呢個係現有 8 月資料一路嘅慣例（月結會俾每張卡明確補
// `effective_to`，見 `build-aug-plan.ts` closeJuly 呢類 entry），窄啲嘅
// 判斷唔會誤複製本來已經跨月有效、唔需要複製嘅卡。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import type { RateCard } from "@prisma/client";

export type CopyLastMonthCandidate = {
  siteId: string;
  siteName: string;
  shiftTypeId: string;
  shiftTypeCode: string;
  brokerId: string | null;
  brokerLabel: string;
  clientRate: string | null;
  guardWage: string | null;
  sourceCardId: string;
  sourceEffectiveFrom: string;
};

function monthStart(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}
function monthEnd(month: string): Date {
  const start = monthStart(month);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
}
function prevMonthEnd(month: string): Date {
  const start = monthStart(month);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
}

function money(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return (v as { toString(): string }).toString();
}

/** 揾候選（唔寫 DB）——`GET`／POST dry_run:true 兩邊共用。 */
export async function findCopyLastMonthCandidates(month: string, siteId?: string | null): Promise<CopyLastMonthCandidate[]> {
  const start = monthStart(month);
  const end = monthEnd(month);
  const prevEnd = prevMonthEnd(month);

  const lastMonthCards = await prisma.rateCard.findMany({
    where: {
      ...(siteId ? { siteId } : {}),
      voidedAt: null,
      guardId: null,
      shiftTypeId: { not: null },
      OR: [{ billingModel: null }, { billingModel: "per_shift" }],
      effectiveTo: prevEnd,
    },
    orderBy: [{ siteId: "asc" }, { shiftTypeId: "asc" }, { brokerId: "asc" }],
  });
  if (lastMonthCards.length === 0) return [];

  const siteIds = [...new Set(lastMonthCards.map((c) => c.siteId))];
  const linkSites = await prisma.site.findMany({ where: { id: { in: siteIds }, guardsPaidByClient: true }, select: { id: true } });
  const linkSiteIds = new Set(linkSites.map((s) => s.id));
  const candidateCards = lastMonthCards.filter((c) => !linkSiteIds.has(c.siteId));
  if (candidateCards.length === 0) return [];

  // 已有本月卡嘅組合——批量查一次，排除。
  const thisMonthCards = await prisma.rateCard.findMany({
    where: {
      siteId: { in: [...new Set(candidateCards.map((c) => c.siteId))] },
      voidedAt: null,
      guardId: null,
      effectiveFrom: { lte: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
    },
    select: { siteId: true, shiftTypeId: true, brokerId: true },
  });
  const existingKey = new Set(thisMonthCards.map((c) => `${c.siteId}|${c.shiftTypeId ?? ""}|${c.brokerId ?? ""}`));
  const remaining = candidateCards.filter((c) => !existingKey.has(`${c.siteId}|${c.shiftTypeId ?? ""}|${c.brokerId ?? ""}`));
  if (remaining.length === 0) return [];

  const [sites, shiftTypes, brokers] = await Promise.all([
    prisma.site.findMany({ where: { id: { in: [...new Set(remaining.map((c) => c.siteId))] } }, select: { id: true, canonicalName: true } }),
    prisma.shiftType.findMany({ where: { id: { in: [...new Set(remaining.map((c) => c.shiftTypeId!))] } }, select: { id: true, code: true } }),
    prisma.broker.findMany({ where: { id: { in: [...new Set(remaining.map((c) => c.brokerId).filter((v): v is string => !!v))] } }, select: { id: true, code: true, name: true } }),
  ]);
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const shiftCodeById = new Map(shiftTypes.map((s) => [s.id, s.code]));
  const brokerLabelById = new Map(brokers.map((b) => [b.id, `${b.code} ${b.name}`]));

  return remaining.map((c) => ({
    siteId: c.siteId,
    siteName: siteNameById.get(c.siteId) ?? c.siteId.slice(0, 8),
    shiftTypeId: c.shiftTypeId!,
    shiftTypeCode: shiftCodeById.get(c.shiftTypeId!) ?? c.shiftTypeId!.slice(0, 8),
    brokerId: c.brokerId,
    brokerLabel: c.brokerId ? (brokerLabelById.get(c.brokerId) ?? c.brokerId.slice(0, 8)) : "通用",
    clientRate: money(c.clientRate),
    guardWage: money(c.guardWage),
    sourceCardId: c.id,
    sourceEffectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
  }));
}

/** 真正建卡——每個候選一張新卡，`effective_from`=本月 1 日，note「由上月
 * 複製」，audit。冪等：`findCopyLastMonthCandidates()` 已經排除咗「已有
 * 本月卡」，連撳兩次第二次候選一定 0，唔會重複建。 */
export async function applyCopyLastMonthCards(
  month: string,
  siteId: string | null,
  actorUserId: string,
  ip: string | null,
): Promise<{ created: RateCard[]; candidateCount: number }> {
  const candidates = await findCopyLastMonthCandidates(month, siteId);
  if (candidates.length === 0) return { created: [], candidateCount: 0 };
  const start = monthStart(month);
  const sourceCards = await prisma.rateCard.findMany({ where: { id: { in: candidates.map((c) => c.sourceCardId) } } });
  const sourceById = new Map(sourceCards.map((c) => [c.id, c]));

  const created: RateCard[] = [];
  for (const cand of candidates) {
    const src = sourceById.get(cand.sourceCardId);
    if (!src) continue;
    const row = await prisma.rateCard.create({
      data: {
        siteId: src.siteId,
        shiftTypeId: src.shiftTypeId,
        brokerId: src.brokerId,
        guardId: null,
        clientRate: src.clientRate,
        guardWage: src.guardWage,
        brokerFee: src.brokerFee,
        payoutRate: src.payoutRate,
        billingModel: src.billingModel,
        effectiveFrom: start,
        effectiveTo: null,
        source: "copy_last_month",
        note: `由上月複製（沿用 ${src.effectiveFrom.toISOString().slice(0, 10)}～${src.effectiveTo?.toISOString().slice(0, 10) ?? ""} 生效卡）`,
        createdBy: actorUserId,
      },
    });
    await writeAudit({ actorUserId, tableName: "rate_cards", rowId: row.id, action: "create", after: row, ip });
    created.push(row);
  }
  return { created, candidateCount: candidates.length };
}
