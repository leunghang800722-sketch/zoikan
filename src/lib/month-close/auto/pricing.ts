// WP-ONE-CLICK-AUTO（§31.3 C）：自動定價——`stepAutoPricing` 喺 reconcile_apply 之後、
// compute 之前。對每組未定價（盤×更種×雞頭）按次序搵價：
//   1 同盤同更種同雞頭上月（最近 3 個月內完結）嘅卡 → auto（沿用）
//   2 Postorder（本月上載）同盤同崗位同雞頭外判價／上單價，值唯一 → auto
//   3 同盤同更種、其他「同類」雞頭（broker↔broker、internal_cash↔internal_cash）嘅卡，全部一樣 → auto；唔一樣 → propose
//   4 同雞頭同盤其他更種、鐘數相同 → propose
//   5 盤通用客價（`*|*`）＋該雞頭喺同客戶群嘅常見外判價 → propose
//   6 冇 → 分診題（冇預填）
// `auto` 即建卡（effective_from＝本月 1 號，source＝auto:one-click:<runId>，evidence 寫來源）
// 並只對呢組未定價記錄補價（targeted reprice，唔郁已有價）。卡金額一定等於來源值
// （上月卡／Postorder／同類卡），絕不平均、絕不估。OT 更種淨係配掛住同一個 OT 更種嘅卡（§20 規矩）。
// 注意（有意為之）：分診建嘅卡（source＝`triage:*`）維持主線行為——客價喺 resolver 內可以跨雞頭 fallback；
// 只有 `auto:one-click:*` 卡先限制雞頭。呢個係刻意設計，唔好改。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthRange, n, round2 } from "@/lib/reports/money";
import { resolveShiftPricingFromCards, LONGTERM_REFERRAL_AUTOCOMPUTE_FROM, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { loadUnpricedLookups, unpricedCategoriesOf, type UnpricedCategory } from "@/lib/pricing/unpriced";
import { numOrNull, sameRepriceValue } from "@/lib/pricing/reprice";
import { shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";
import { isMixedBillingMonth } from "@/lib/reports/mixed-billing";
import type { AutoCollector, ChangeWriter } from "./context";
import { classifyPriceRow, rowsForSite, type BrokerLite, type PostorderPriceRow } from "./postorder-evidence";
import type { McCandidate, McQuestionDraft, PriceValues, PricingGroupRef } from "./types";

export interface PriceNeed {
  client: boolean;
  payout: boolean;
}

export interface PriceSource {
  step: 1 | 2 | 3 | 4 | 5;
  level: "auto" | "propose";
  values: PriceValues;
  evidence: string;
  /** 來源本身係通用卡（brokerId null）→ 建出嚟嘅卡先可以係通用卡；否則一定帶該雞頭 brokerId。 */
  generic?: boolean;
}

const EMPTY_VALUES: PriceValues = { clientRate: null, guardWage: null, brokerFee: null, payoutRate: null };

interface CardRow {
  id: string;
  siteId: string;
  shiftTypeId: string | null;
  brokerId: string | null;
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
  payoutRate: number | null;
  billingModel: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string | null;
}

function toCard(c: { id: string; siteId: string; shiftTypeId: string | null; brokerId: string | null; clientRate: unknown; guardWage: unknown; brokerFee: unknown; payoutRate: unknown; billingModel: string | null; effectiveFrom: Date; effectiveTo: Date | null; source: string | null }): CardRow {
  return { id: c.id, siteId: c.siteId, shiftTypeId: c.shiftTypeId, brokerId: c.brokerId, clientRate: numOrNull(c.clientRate), guardWage: numOrNull(c.guardWage), brokerFee: numOrNull(c.brokerFee), payoutRate: numOrNull(c.payoutRate), billingModel: c.billingModel, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, source: c.source };
}

const perShiftEligible = (c: CardRow): boolean => c.billingModel === null || c.billingModel === "per_shift";
/** 一鍵結算自己建嘅卡唔算獨立證據（唔好用 auto 卡再推 auto 卡，避免一個歷史價喺雞頭之間連鎖傳開）。 */
const isAutoCard = (c: CardRow): boolean => (c.source ?? "").startsWith("auto:one-click:");

/** 淨係保留需要嘅成分（唔畀「只補出街價」嘅卡帶埋客價去蓋住現有客價卡）。 */
export function restrictValues(v: PriceValues, need: PriceNeed): PriceValues {
  return {
    clientRate: need.client ? v.clientRate : null,
    guardWage: need.payout ? v.guardWage : null,
    brokerFee: need.payout ? v.brokerFee : null,
    payoutRate: need.payout ? v.payoutRate : null,
  };
}

export function coversNeed(v: PriceValues, need: PriceNeed): boolean {
  if (need.client && (v.clientRate === null || v.clientRate <= 0)) return false;
  if (need.payout && v.guardWage === null && v.brokerFee === null && v.payoutRate === null) return false;
  if (need.payout && (v.guardWage ?? 0) <= 0 && (v.brokerFee ?? 0) <= 0 && (v.payoutRate ?? 0) <= 0) return false;
  return true;
}

const tupleKey = (v: PriceValues): string => JSON.stringify([v.clientRate, v.guardWage, v.brokerFee, v.payoutRate].map((x) => (x === null ? null : round2(x))));

function cardValues(c: CardRow): PriceValues {
  return { clientRate: c.clientRate, guardWage: c.guardWage, brokerFee: c.brokerFee, payoutRate: c.payoutRate };
}

export function describeValues(v: PriceValues): string {
  const bits: string[] = [];
  if (v.clientRate !== null) bits.push(`客價 ${round2(v.clientRate)}`);
  if (v.guardWage !== null) bits.push(`工資 ${round2(v.guardWage)}`);
  if (v.brokerFee !== null) bits.push(`雞頭費 ${round2(v.brokerFee)}`);
  if (v.payoutRate !== null && v.guardWage === null && v.brokerFee === null) bits.push(`出街價 ${round2(v.payoutRate)}`);
  return bits.join("／") || "（空）";
}

const fmtDate = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

interface SiteInfo {
  id: string;
  canonicalName: string;
  aliases: string[];
  clientName: string;
}
interface ShiftTypeInfo {
  id: string;
  siteId: string;
  code: string;
  startTime: Date | null;
  endTime: Date | null;
  hours: number | null;
  billingGroup: string;
}

export interface PricingEnv {
  start: Date;
  end: Date;
  threeMonthsAgo: Date;
  brokers: BrokerLite[];
  postorderRows: Array<{ siteKey: string; row: PostorderPriceRow }>;
  hasPostorder: boolean;
  postorderFile: string | null;
  cardsBySite: Map<string, CardRow[]>;
  sites: Map<string, SiteInfo>;
  shiftTypesBySite: Map<string, ShiftTypeInfo[]>;
}

async function cardsForSite(env: PricingEnv, siteId: string): Promise<CardRow[]> {
  let cards = env.cardsBySite.get(siteId);
  if (!cards) {
    const rows = await prisma.rateCard.findMany({ where: { siteId, voidedAt: null, guardId: null } });
    cards = rows.map(toCard);
    env.cardsBySite.set(siteId, cards);
  }
  return cards;
}

async function shiftTypesForSite(env: PricingEnv, siteId: string): Promise<ShiftTypeInfo[]> {
  let sts = env.shiftTypesBySite.get(siteId);
  if (!sts) {
    const rows = await prisma.shiftType.findMany({ where: { siteId, voidedAt: null } });
    sts = rows.map((r) => ({ id: r.id, siteId: r.siteId, code: r.code, startTime: r.startTime, endTime: r.endTime, hours: r.hours !== null ? n(r.hours) : null, billingGroup: r.billingGroup }));
    env.shiftTypesBySite.set(siteId, sts);
  }
  return sts;
}

/** 照 §31.3 C 次序 1–5 搵價。回傳 auto（可直接建卡）、propose 候選、或者 none。 */
export async function findPriceSource(
  _ctx: AutoCollector,
  env: PricingEnv,
  group: PricingGroupRef,
  need: PriceNeed,
): Promise<{ auto: PriceSource | null; proposals: Array<PriceSource & { label: string }> }> {
  const site = env.sites.get(group.siteId);
  const sts = await shiftTypesForSite(env, group.siteId);
  const st = sts.find((s) => s.id === group.shiftTypeId);
  const cards = (await cardsForSite(env, group.siteId)).filter(perShiftEligible);
  const proposals: Array<PriceSource & { label: string }> = [];
  const broker = group.brokerId ? (env.brokers.find((b) => b.id === group.brokerId) ?? null) : null;
  if (!site || !st) return { auto: null, proposals };

  // 1. 同盤同更種同雞頭上月（最近 3 個月內完結）嘅卡。
  //    - 出街價：淨係同雞頭嘅卡；
  //    - 淨缺客價：同雞頭嘅卡優先；用其他雞頭／通用卡要全部一致先 auto（唔一致 → propose）；
  //    - 來源唔准係 auto:one-click:* 嘅卡（未經人確認），最多 propose。
  {
    const win = cards.filter((c) => c.shiftTypeId === st.id && c.effectiveTo !== null && c.effectiveTo < env.start && c.effectiveTo >= env.threeMonthsAgo && c.effectiveFrom < env.start);
    const byRecent = (a: CardRow, b: CardRow) => b.effectiveTo!.getTime() - a.effectiveTo!.getTime() || b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    const search = (pool: CardRow[]): { card: CardRow; generic: boolean } | { conflict: PriceValues[] } | null => {
      const sorted = [...pool].sort(byRecent);
      const covering = (list: CardRow[]) => list.map((c) => ({ c, v: restrictValues(cardValues(c), need) })).filter((x) => coversNeed(x.v, need));
      if (need.payout) {
        const own = covering(sorted.filter((c) => c.brokerId === group.brokerId));
        return own[0] ? { card: own[0].c, generic: own[0].c.brokerId === null } : null;
      }
      const own = group.brokerId ? covering(sorted.filter((c) => c.brokerId === group.brokerId)) : [];
      if (own[0]) return { card: own[0].c, generic: false };
      const others = covering(sorted);
      const keys = new Map(others.map((x) => [tupleKey(x.v), x.v]));
      if (keys.size === 1) return { card: others[0]!.c, generic: others.every((x) => x.c.brokerId === null) };
      if (keys.size > 1) return { conflict: [...keys.values()] };
      return null;
    };
    const human = search(win.filter((c) => !isAutoCard(c)));
    if (human && "card" in human) {
      const c = human.card;
      const v = restrictValues(cardValues(c), need);
      return { auto: { step: 1, level: "auto", values: v, generic: human.generic, evidence: `沿用同盤同更種${need.payout && broker ? `同雞頭 ${broker.code}` : ""}上期卡（${fmtDate(c.effectiveFrom)}～${fmtDate(c.effectiveTo)}，卡 ${c.id.slice(0, 8)}）` }, proposals };
    }
    if (human && "conflict" in human) {
      for (const v of human.conflict.slice(0, 3)) proposals.push({ step: 1, level: "propose", values: v, label: "上期卡（各雞頭唔一致）", evidence: "同盤同更種上期卡因雞頭而異，淨缺客價，唔肯定用邊個" });
    } else {
      const auto = search(win.filter((c) => isAutoCard(c)));
      if (auto && "card" in auto) proposals.push({ step: 1, level: "propose", values: restrictValues(cardValues(auto.card), need), generic: auto.generic, label: "上月自動定價卡（未經人確認）", evidence: `上期卡 ${auto.card.id.slice(0, 8)} 係一鍵結算自動建嘅，未經人確認，唔自動沿用` });
    }
  }

  // 2. Postorder 同盤同崗位同雞頭外判價／上單價（唯一值）
  if (env.hasPostorder && !group.ot) {
    const slot = shiftTypeTimeSlot(st.startTime, st.endTime);
    const siteRows = env.postorderRows.filter((r) => r.siteKey === group.siteId);
    const slotRows = slot ? siteRows.filter((r) => r.row.timeSlot === slot && !r.row.hourly).map((r) => r.row) : [];
    if (slotRows.length > 0) {
      const classified = slotRows.map((row) => ({ row, ...classifyPriceRow(row, env.brokers) }));
      const valuesOf = (rows: typeof classified): PriceValues[] =>
        rows.map((r) => ({ clientRate: need.client ? r.row.clientPrice : null, guardWage: null, brokerFee: null, payoutRate: need.payout ? r.row.payoutPrice : null }));
      const uniqueCover = (vs: PriceValues[]): PriceValues | null => {
        const keys = new Set(vs.map(tupleKey));
        return keys.size === 1 && coversNeed(vs[0]!, need) ? vs[0]! : null;
      };
      if (need.payout && broker) {
        const rows = classified.filter((r) => r.kind === "broker" && r.broker?.id === broker.id);
        const v = rows.length ? uniqueCover(valuesOf(rows)) : null;
        if (v) return { auto: { step: 2, level: "auto", values: v, evidence: `Postorder「${env.postorderFile ?? ""}」同盤同崗位同雞頭 ${broker.code} 嘅${need.client ? "上單價／" : ""}外判價（第 ${rows.map((r) => r.row.rowIndex).slice(0, 3).join("、")} 行）` }, proposals };
        const generic = classified.filter((r) => r.kind === "generic");
        const gv = generic.length && rows.length === 0 ? uniqueCover(valuesOf(generic)) : null;
        if (gv) {
          // 泛用行只准 kind=broker 嘅外判雞頭 auto；公司兵（internal_cash）一律唔用泛用行；
          // 同崗位有逐人／逐雞頭行時只 propose。
          const anyBrokerRows = classified.some((r) => r.kind === "broker" || r.kind === "person") || broker.kind !== "broker";
          const evidenceRows = `第 ${generic.map((r) => r.row.rowIndex).slice(0, 3).join("、")} 行`;
          // 同盤同崗位 Postorder 完全冇按雞頭分價（冇任何雞頭專屬行），泛用價值唯一 → 呢個崗位嘅價就係佢，auto；
          // 有其他雞頭嘅專屬行（價可能因雞頭而異）而呢個雞頭冇 → 只係 propose。
          if (!anyBrokerRows) return { auto: { step: 2, level: "auto", values: gv, evidence: `Postorder「${env.postorderFile ?? ""}」同盤同崗位${need.client ? "上單價／" : ""}外判價（冇按雞頭分價，值唯一；${evidenceRows}）` }, proposals };
          proposals.push({ step: 2, level: "propose", values: gv, label: "Postorder 泛用崗位價（未指明雞頭）", evidence: `Postorder 同盤同崗位冇指明雞頭嘅價（${evidenceRows}），但有其他雞頭專屬價` });
        }
      } else if (need.client && !need.payout) {
        const rows = classified.filter((r) => r.kind !== "person");
        const v = rows.length ? uniqueCover(valuesOf(rows)) : null;
        if (v) return { auto: { step: 2, level: "auto", values: v, evidence: `Postorder「${env.postorderFile ?? ""}」同盤同崗位上單價（第 ${rows.map((r) => r.row.rowIndex).slice(0, 3).join("、")} 行）` }, proposals };
      }
    }
  }

  if (group.ot) return { auto: null, proposals };

  // 3. 同盤同更種、其他同類雞頭嘅卡
  if (need.payout && broker && (broker.kind === "broker" || broker.kind === "internal_cash")) {
    const sameClass = new Set(env.brokers.filter((b) => b.kind === broker.kind && b.id !== broker.id).map((b) => b.id));
    const active = cards.filter((c) => !isAutoCard(c) && c.shiftTypeId === st.id && c.brokerId !== null && sameClass.has(c.brokerId) && c.effectiveFrom <= env.end && (c.effectiveTo === null || c.effectiveTo >= env.start));
    const withVals = active.map((c) => ({ c, v: restrictValues(cardValues(c), need) })).filter((x) => coversNeed(x.v, need));
    const distinct = new Map<string, { v: PriceValues; brokers: string[] }>();
    for (const x of withVals) {
      const k = tupleKey(x.v);
      const e = distinct.get(k) ?? { v: x.v, brokers: [] };
      e.brokers.push(env.brokers.find((b) => b.id === x.c.brokerId)?.code ?? "?");
      distinct.set(k, e);
    }
    if (distinct.size === 1) {
      const e = [...distinct.values()][0]!;
      return { auto: { step: 3, level: "auto", values: e.v, evidence: `同盤同更種其他同類雞頭（${[...new Set(e.brokers)].join("／")}）嘅卡全部一樣` }, proposals };
    }
    if (distinct.size > 1) {
      for (const e of [...distinct.values()].sort((a, b) => b.brokers.length - a.brokers.length).slice(0, 3)) {
        proposals.push({ step: 3, level: "propose", values: e.v, label: `同類雞頭 ${[...new Set(e.brokers)].join("／")} 嘅價`, evidence: `同盤同更種其他同類雞頭嘅卡唔一致，呢個係 ${[...new Set(e.brokers)].join("／")} 嘅價` });
      }
    }
  }

  // 4. 同雞頭同盤其他更種、鐘數相同
  if (st.hours !== null) {
    const sameHours = (await shiftTypesForSite(env, group.siteId)).filter((o) => o.id !== st.id && o.hours !== null && o.hours === st.hours && o.billingGroup === st.billingGroup);
    const ids = new Set(sameHours.map((o) => o.id));
    const cs = cards.filter((c) => !isAutoCard(c) && c.shiftTypeId !== null && ids.has(c.shiftTypeId) && (need.payout ? c.brokerId === group.brokerId : true) && c.effectiveFrom <= env.end && (c.effectiveTo === null || c.effectiveTo >= env.threeMonthsAgo));
    const seen = new Set<string>();
    for (const c of cs) {
      const v = restrictValues(cardValues(c), need);
      if (!coversNeed(v, need)) continue;
      const k = tupleKey(v);
      if (seen.has(k)) continue;
      seen.add(k);
      const o = sameHours.find((x) => x.id === c.shiftTypeId);
      proposals.push({ step: 4, level: "propose", values: v, label: `同盤更種 ${o?.code ?? "?"}（同樣 ${st.hours} 鐘）嘅價`, evidence: `同盤同雞頭其他更種「${o?.code ?? "?"}」（鐘數相同）嘅卡` });
    }
  }

  // 5. 盤通用客價＋同客戶群常見外判價
  if (need.payout && broker && site.clientName) {
    const sameClient = await prisma.site.findMany({ where: { clientName: site.clientName, id: { not: site.id } }, select: { id: true } });
    if (sameClient.length > 0) {
      const rows = await prisma.rateCard.findMany({
        where: { siteId: { in: sameClient.map((s) => s.id) }, brokerId: broker.id, voidedAt: null, guardId: null, shiftTypeId: { not: null }, effectiveFrom: { lte: env.end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: env.start } }] },
      });
      const freq = new Map<string, { v: PriceValues; n: number }>();
      for (const r of rows.map(toCard).filter((c) => perShiftEligible(c) && !isAutoCard(c))) {
        const v = restrictValues({ ...cardValues(r), clientRate: null }, { client: false, payout: true });
        if (!coversNeed(v, { client: false, payout: true })) continue;
        const k = tupleKey(v);
        const e = freq.get(k) ?? { v, n: 0 };
        e.n++;
        freq.set(k, e);
      }
      const top = [...freq.values()].sort((a, b) => b.n - a.n)[0];
      if (top) {
        const generic = need.client ? cards.find((c) => c.shiftTypeId === null && c.brokerId === null && c.clientRate !== null && c.effectiveFrom <= env.end && (c.effectiveTo === null || c.effectiveTo >= env.start)) : null;
        const v = { ...top.v, clientRate: need.client ? (generic?.clientRate ?? null) : null };
        if (coversNeed(v, need)) proposals.push({ step: 5, level: "propose", values: v, label: `${broker.code} 喺同客戶其他盤嘅常見外判價`, evidence: `同客戶群其他盤 ${broker.code} 嘅常見外判價（${top.n} 張卡）${need.client ? "＋盤通用客價" : ""}` });
      }
    }
  }
  return { auto: null, proposals };
}

// ---------------------------------------------------------------------------
// 建卡＋補價（auto 同分診一撳確認共用）
// ---------------------------------------------------------------------------
export type Db = Prisma.TransactionClient | typeof prisma;

export interface ApplyPriceResult {
  cardId: string;
  recordsPriced: number;
  /** 其中覆蓋咗「系統之前自動填嘅值」嘅更數（journal 有記錄；永遠唔覆蓋人手快照）。 */
  overwrittenAuto: number;
  /** 呢組本月仲有幾多更因為已經有價（人手或其他來源）而冇補。 */
  skippedHasPrice: number;
  reusedCard: boolean;
}

async function auditVia(writer: ChangeWriter, db: Db, input: Parameters<ChangeWriter["audit"]>[0]): Promise<void> {
  if (db !== prisma && writer.auditTx) await writer.auditTx(db as Prisma.TransactionClient, input);
  else await writer.audit(input);
}

// P3-5.3：呢段「攞有效卡 → RateCardLite」同 `src/lib/pricing/resolve-rate.ts` 嘅 `fetchEffectiveRateCards()`（尾段 rows.map）刻意重複、
// 唔合併——兩邊都屬定價核心，一邊改欄位／條件要人手同步另一邊（改前後都跑 `npm run gate:pricing`＋`gate:locked-months`）。
async function fetchCardsVia(db: Db, siteId: string, start: Date, end: Date) {
  const rows = await db.rateCard.findMany({ where: { siteId, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] } });
  return rows.map((r) => ({
    id: r.id,
    shiftTypeId: r.shiftTypeId,
    brokerId: r.brokerId,
    guardId: r.guardId,
    clientRate: r.clientRate !== null ? n(r.clientRate) : null,
    guardWage: r.guardWage !== null ? n(r.guardWage) : null,
    brokerFee: r.brokerFee !== null ? n(r.brokerFee) : null,
    payoutRate: r.payoutRate !== null ? n(r.payoutRate) : null,
    billingModel: r.billingModel,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    source: r.source,
  }));
}

/** 建一張卡（effective_from＝本月 1 號，到月尾），並對呢組（盤×更種×雞頭）補價（只填 null 欄）。
 * `db` 係 transaction client 時（分診一撳確認）建卡＋補價同生同死。
 * 冪等／唔重複建卡：
 *   - auto 路徑：本月同組合已有**任何** run 建嘅有效 `auto:one-click:*` 卡 → 唔再建（重用）；
 *   - 分診路徑：同來源（`triage:<題目>`）而且價錢一樣先重用，價唔同就唔重用（建新卡）。 */
export async function createCardAndPrice(
  writer: ChangeWriter,
  input: { month: Date; group: PricingGroupRef; need: PriceNeed; values: PriceValues; evidence: string; note: string; confidence: string; recordIds?: string[]; generic?: boolean; overwriteAuto?: boolean },
  db: Db = prisma,
): Promise<ApplyPriceResult> {
  const { start, end } = monthRange(input.month);
  if (start < LONGTERM_REFERRAL_AUTOCOMPUTE_FROM) throw new Error("8 月之前嘅月份唔做自動定價");
  const locked = await db.monthClose.findUnique({ where: { month: start } });
  if (locked?.lockedAt) throw new Error("本月已鎖定，唔會改價");
  const v = restrictValues(input.values, input.need);
  if (!coversNeed(v, input.need)) throw new Error("價錢唔齊（客價／出街價要有數）");
  const dec = (x: number | null) => (x === null ? null : new Prisma.Decimal(round2(x)));
  const cardBrokerId = input.generic ? null : input.group.brokerId;
  const overlap = { effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] };
  const isAutoWriter = writer.source.startsWith("auto:one-click:");
  let dup: { id: string } | null = null;
  if (isAutoWriter) {
    // N3：跨 run 重用自動卡之前，要確認舊卡「覆蓋成個月」而且「有齊 need 嘅欄」；唔夠就唔重用，
    // 亦唔再疊一張重疊嘅新卡（resolver 揀邊張會不明確）→ 拋錯，由 runAutoPricing 改入分診題。
    const cands = await db.rateCard.findMany({
      where: { siteId: input.group.siteId, shiftTypeId: input.group.shiftTypeId, brokerId: cardBrokerId, guardId: null, voidedAt: null, ...overlap, source: { startsWith: "auto:one-click:" } },
    });
    const num = (x: Prisma.Decimal | null) => (x === null ? null : Number(x.toString()));
    const covering = cands.find((c) => c.effectiveFrom <= start && (c.effectiveTo === null || c.effectiveTo >= end) && coversNeed({ clientRate: num(c.clientRate), guardWage: num(c.guardWage), brokerFee: num(c.brokerFee), payoutRate: num(c.payoutRate) }, input.need));
    if (covering) dup = covering;
    else if (cands.length > 0) throw new Error("本月已有 auto 價卡但欄位唔齊或者冇覆蓋成個月，改入分診");
  } else {
    dup = await db.rateCard.findFirst({
      where: {
        siteId: input.group.siteId,
        shiftTypeId: input.group.shiftTypeId,
        brokerId: cardBrokerId,
        guardId: null,
        voidedAt: null,
        ...overlap,
        source: writer.source,
        clientRate: dec(v.clientRate),
        guardWage: dec(v.guardWage),
        brokerFee: dec(v.brokerFee),
        payoutRate: dec(v.payoutRate),
      },
    });
  }
  if (dup) {
    const r = await repriceMonth(writer, input.month, input.group, input.need, dup.id, { overwriteAuto: input.overwriteAuto, db });
    return { cardId: dup.id, ...r, reusedCard: true };
  }
  const card = await db.rateCard.create({
    data: {
      siteId: input.group.siteId,
      shiftTypeId: input.group.shiftTypeId,
      brokerId: cardBrokerId,
      guardId: null,
      clientRate: dec(v.clientRate),
      guardWage: dec(v.guardWage),
      brokerFee: dec(v.brokerFee),
      payoutRate: dec(v.payoutRate),
      billingModel: "per_shift",
      effectiveFrom: start,
      effectiveTo: end,
      source: writer.source,
      evidence: input.evidence.slice(0, 500),
      confidence: input.confidence,
      note: input.note.slice(0, 500),
      createdBy: writer.actorUserId,
    },
  });
  await auditVia(writer, db, { tableName: "rate_cards", rowId: card.id, action: "create", after: card });
  await writer.journal({
    kind: "rate_card_created",
    refTable: "rate_cards",
    refId: card.id,
    summary: `自動建價卡（${describeValues(v)}）：${input.evidence}`,
    detail: { cardId: card.id, siteId: input.group.siteId, shiftTypeId: input.group.shiftTypeId, month: start.toISOString().slice(0, 10) },
  });
  const r = await repriceMonth(writer, input.month, input.group, input.need, card.id, { overwriteAuto: input.overwriteAuto, db });
  return { cardId: card.id, ...r, reusedCard: false };
}

/** 對呢組（盤×更種×雞頭）補價，loop 到冇變（淨係呢一組，唔做整月通用補價）。 */
async function repriceMonth(writer: ChangeWriter, month: Date, group: PricingGroupRef, need: PriceNeed, cardId: string, opts: { overwriteAuto?: boolean; db: Db }): Promise<{ recordsPriced: number; overwrittenAuto: number; skippedHasPrice: number }> {
  let total = 0;
  let over = 0;
  let skipped = 0;
  for (let i = 0; i < 6; i++) {
    const r = await applyCardToRecords(writer, month, group, need, undefined, cardId, opts);
    total += r.changed;
    over += r.overwritten;
    skipped = r.skippedHasPrice;
    if (r.changed === 0) break;
  }
  return { recordsPriced: total, overwrittenAuto: over, skippedHasPrice: skipped };
}

/** 補價逐更改動（journal／補齊價目卡撤銷用）。 */
export interface PriceChangeRow {
  id: string;
  cardId: string;
  fields: string[];
  before: [number | null, number | null, number | null];
  after: [number | null, number | null, number | null];
}

type AutoFilledEntry = { client?: number | null; payout?: [number | null, number | null] };
/** 逐更 journal 入面「系統自動填過」嘅現值，逐欄記（N2）：recordId → { client?, payout? }，每欄取**最新一次 applied** 記錄。
 * 只計 status=applied（N1：undo 咗嘅唔算，否則 undo 後人手價會畀 overwriteAuto 覆蓋）。 */
async function loadAutoFilled(db: Db, month: Date, ids: string[]): Promise<Map<string, AutoFilledEntry>> {
  const out = new Map<string, AutoFilledEntry>();
  if (ids.length === 0) return out;
  const want = new Set(ids);
  const changes = await db.monthCloseAutoChange.findMany({ where: { kind: "price_snapshots", status: "applied", run: { month } }, orderBy: { createdAt: "asc" }, select: { detailJson: true } });
  for (const c of changes) {
    const rows = ((c.detailJson as { rows?: Array<{ id: string; fields?: string[]; after: [number | null, number | null, number | null] }> }).rows ?? []);
    for (const r of rows) {
      if (!want.has(r.id)) continue;
      const fields = r.fields && r.fields.length > 0 ? r.fields : ["client", "payout"];
      const e = out.get(r.id) ?? {};
      if (fields.includes("client")) e.client = r.after[0];
      if (fields.includes("payout")) e.payout = [r.after[1], r.after[2]];
      out.set(r.id, e);
    }
  }
  return out;
}

/** 對呢組記錄補價：淨係填 null（或「工資 0＋雞頭費 null」）嘅欄；`overwriteAuto`（分診一撳確認用）先可以覆蓋
 * 「現值仍然等於 journal 記低嘅自動填入值」嗰啲欄——永遠唔覆蓋人手快照。逐更 journal（舊值／新值），undo 靠佢。 */
export async function applyCardToRecords(
  writer: ChangeWriter,
  month: Date,
  group: PricingGroupRef,
  need: PriceNeed,
  recordIds: string[] | undefined,
  cardId: string,
  opts: { overwriteAuto?: boolean; db?: Db; collect?: PriceChangeRow[] } = {},
): Promise<{ changed: number; overwritten: number; skippedHasPrice: number }> {
  const db = opts.db ?? prisma;
  const { start, end } = monthRange(month);
  const cards = await fetchCardsVia(db, group.siteId, start, end);
  const where: Prisma.ShiftRecordWhereInput = recordIds
    ? { id: { in: recordIds } }
    : { siteId: group.siteId, shiftTypeId: group.shiftTypeId, settlementBrokerId: group.brokerId, recordType: group.ot ? "ot" : "shift", status: { not: "cancelled" }, workDate: { gte: start, lte: end } };
  const records = await db.shiftRecord.findMany({
    where: { ...where, status: { not: "cancelled" } },
    select: { id: true, workDate: true, guardId: true, isExternal: true, recordType: true, otHours: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true, settlementBrokerId: true, shiftType: { select: { code: true, billingGroup: true } } },
  });
  if (records.length === 0) return { changed: 0, overwritten: 0, skippedHasPrice: 0 };
  const brokers = await db.broker.findMany({ where: { id: { in: [...new Set(records.map((r) => r.settlementBrokerId).filter((x): x is string => !!x))] } }, select: { id: true, kind: true } });
  const kindById = new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike]));
  const autoFilled = opts.overwriteAuto ? await loadAutoFilled(db, month, records.map((r) => r.id)) : new Map<string, AutoFilledEntry>();
  const changes: Array<{ id: string; cardId: string; fields: string[]; before: [number | null, number | null, number | null]; after: [number | null, number | null, number | null] }> = [];
  let overwritten = 0;
  let skippedHasPrice = 0;
  for (const r of records) {
    const kind = r.settlementBrokerId ? (kindById.get(r.settlementBrokerId) ?? null) : null;
    const pricing = resolveShiftPricingFromCards(cards, {
      siteId: group.siteId,
      shiftTypeId: group.shiftTypeId,
      shiftTypeCode: r.shiftType.code,
      shiftTypeBillingGroup: r.shiftType.billingGroup,
      settlementBrokerId: r.settlementBrokerId,
      brokerKind: kind,
      guardId: r.guardId,
      workDate: r.workDate,
      isExternal: r.isExternal,
      recordType: r.recordType === "ot" ? "ot" : "shift",
      otHours: numOrNull(r.otHours),
    });
    const c0 = numOrNull(r.clientRateSnapshot);
    const w0 = numOrNull(r.guardWageSnapshot);
    const f0 = numOrNull(r.brokerFeeSnapshot);
    const af = autoFilled.get(r.id) ?? null;
    // 現值仍然等於系統自動填入嘅值 → 可以覆蓋；否則（人手價或其他來源）絕不覆蓋。
    const clientAuto = af?.client !== undefined && c0 !== null && sameRepriceValue(c0, af.client);
    const payoutAuto = af?.payout !== undefined && w0 !== null && sameRepriceValue(w0, af.payout[0]) && sameRepriceValue(f0, af.payout[1]);
    let c1 = c0;
    let w1 = w0;
    let f1 = f0;
    const fields: string[] = [];
    if (need.client && pricing.clientCardFound && (c0 === null || clientAuto) && !(c0 !== null && sameRepriceValue(c0, pricing.clientRate))) {
      c1 = pricing.clientRate;
      fields.push("client");
      if (c0 !== null) overwritten++;
    }
    if (need.payout && kind !== "internal_longterm" && kind !== "external" && pricing.payoutCardFound && ((f0 === null && (w0 === null || w0 === 0)) || payoutAuto) && !(w0 !== null && sameRepriceValue(w0, pricing.guardWage) && sameRepriceValue(f0, pricing.brokerFee))) {
      w1 = pricing.guardWage;
      f1 = pricing.brokerFee;
      fields.push("payout");
      if (w0 !== null && w0 !== 0) overwritten++;
    }
    // 新舊值全部一樣（例如 OT 冇 ot_hours，resolver 答 null，null→null）就唔計 changed、唔寫 journal。
    const eq = sameRepriceValue;
    const realFields = fields.filter((f) => (f === "client" ? !eq(c0, c1) : !(eq(w0, w1) && eq(f0, f1))));
    if (realFields.length > 0) changes.push({ id: r.id, cardId, fields: realFields, before: [c0, w0, f0], after: [c1, w1, f1] });
    else if ((need.client && c0 !== null) || (need.payout && w0 !== null && w0 !== 0)) skippedHasPrice++;
  }
  if (opts.collect) opts.collect.push(...changes);
  if (changes.length > 0) {
    for (let i = 0; i < changes.length; i += 300) {
      const batch = changes.slice(i, i + 300);
      if (db === prisma) await prisma.$transaction(batch.map((u) => prisma.shiftRecord.update({ where: { id: u.id }, data: { clientRateSnapshot: u.after[0], guardWageSnapshot: u.after[1], brokerFeeSnapshot: u.after[2] } })));
      else for (const u of batch) await db.shiftRecord.update({ where: { id: u.id }, data: { clientRateSnapshot: u.after[0], guardWageSnapshot: u.after[1], brokerFeeSnapshot: u.after[2] } });
    }
    for (let i = 0; i < changes.length; i += 500) {
      await writer.journal({
        kind: "price_snapshots",
        refTable: "shift_records",
        refId: cardId,
        summary: `按新價卡補 ${Math.min(500, changes.length - i)} 更價錢`,
        detail: { cardId, rows: changes.slice(i, i + 500) },
      });
    }
    await auditVia(writer, db, {
      tableName: "shift_records",
      rowId: `auto_price:${cardId}`,
      action: "reprice_month",
      after: { month: start.toISOString().slice(0, 10), site_id: group.siteId, shift_type_id: group.shiftTypeId, changed: changes.length, overwritten_auto: overwritten, card_id: cardId, mode: "auto_targeted" },
    });
  }
  return { changed: changes.length, overwritten, skippedHasPrice };
}

// ---------------------------------------------------------------------------
// stepAutoPricing 主流程
// ---------------------------------------------------------------------------
export interface Agg {
  ref: PricingGroupRef;
  need: PriceNeed;
  recordIds: string[];
}

export async function collectUnpricedGroups(month: Date): Promise<Agg[]> {
  const { start, end } = monthRange(month);
  const includeOt = isMixedBillingMonth(month);
  const records = await prisma.shiftRecord.findMany({
    where: { recordType: includeOt ? { in: ["shift", "ot"] } : "shift", status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
    select: { id: true, status: true, recordType: true, guardWageSnapshot: true, brokerFeeSnapshot: true, clientRateSnapshot: true, settlementBrokerId: true, siteId: true, shiftTypeId: true, isExternal: true },
  });
  if (records.length === 0) return [];
  const lookups = await loadUnpricedLookups(records, month);
  const groups = new Map<string, Agg>();
  for (const r of records) {
    const cats: UnpricedCategory[] = unpricedCategoriesOf(r, lookups, { month });
    const needClient = cats.includes("client_unpriced");
    const needPayout = cats.includes("payout_unpriced");
    const isOt = cats.includes("ot_unpriced");
    if (!needClient && !needPayout && !isOt) continue;
    const ot = r.recordType === "ot";
    const key = `${r.siteId}|${r.shiftTypeId}|${r.settlementBrokerId ?? ""}|${ot ? 1 : 0}`;
    const g = groups.get(key) ?? { ref: { siteId: r.siteId, shiftTypeId: r.shiftTypeId, brokerId: r.settlementBrokerId, ot }, need: { client: false, payout: false }, recordIds: [] };
    if (needClient || isOt) g.need.client = true;
    if (needPayout || isOt) g.need.payout = true;
    g.recordIds.push(r.id);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export async function buildEnv(ctx: AutoCollector, month: Date, aggs: Agg[]): Promise<PricingEnv> {
  const { start, end } = monthRange(month);
  const siteIds = [...new Set(aggs.map((a) => a.ref.siteId))];
  const [brokers, sites] = await Promise.all([ctx.brokers(), prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, aliases: true, clientName: true } })]);
  const ev = await ctx.postorder();
  const siteMap = new Map(sites.map((s) => [s.id, { id: s.id, canonicalName: s.canonicalName, aliases: s.aliases, clientName: s.clientName }]));
  const postorderRows: PricingEnv["postorderRows"] = [];
  if (ev) {
    for (const s of sites) for (const row of rowsForSite(ev.priceRows, [s.canonicalName, ...s.aliases])) postorderRows.push({ siteKey: s.id, row });
  }
  return {
    start,
    end,
    threeMonthsAgo: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1)),
    brokers,
    postorderRows,
    hasPostorder: !!ev,
    postorderFile: ev?.fileName ?? null,
    cardsBySite: new Map(),
    sites: siteMap,
    shiftTypesBySite: new Map(),
  };
}

export interface AutoPricingResult {
  groups: number;
  autoGroups: number;
  proposeGroups: number;
  unknownGroups: number;
  skippedReason: string | null;
}

export async function runAutoPricing(ctx: AutoCollector, month: Date): Promise<AutoPricingResult> {
  const { start } = monthRange(month);
  const result: AutoPricingResult = { groups: 0, autoGroups: 0, proposeGroups: 0, unknownGroups: 0, skippedReason: null };
  if (start < LONGTERM_REFERRAL_AUTOCOMPUTE_FROM) {
    result.skippedReason = "2026-08 之前嘅月份唔做自動定價";
    return result;
  }
  // 雙重保險：鎖定月份一律唔郁（createCardAndPrice 內亦有檢查）。
  const lockedRow = await prisma.monthClose.findUnique({ where: { month: start } });
  if (lockedRow?.lockedAt) {
    result.skippedReason = "本月已鎖定，唔做自動定價";
    return result;
  }
  // rerun：呢個 run 較早（第一次執行）建嘅新盤要記得（site_new 題型靠佢，否則 rerun 題型會變）。
  if (ctx.runId) {
    for (const c of await prisma.monthCloseAutoChange.findMany({ where: { runId: ctx.runId, kind: "site_created" }, select: { refId: true } })) if (c.refId) ctx.newSiteIds.add(c.refId);
  }
  // 先用現有生效卡補價（例如上載之後先加咗卡）——唔建新卡，淨係補 null；之後先睇仲有咩未定價。
  let all = await collectUnpricedGroups(month);
  let prefilled = 0;
  for (const a of all) prefilled += (await applyCardToRecords(ctx, month, a.ref, a.need, a.recordIds, "existing")).changed;
  if (prefilled > 0) {
    ctx.summary.recordsPriced += prefilled;
    ctx.line("pricing", `${prefilled} 更按現有生效價卡補價`);
    all = await collectUnpricedGroups(month);
  }
  const aggs = all.filter((a) => a.ref.brokerId !== null || a.need.client);
  result.groups = aggs.length;
  if (aggs.length === 0) return result;
  const env = await buildEnv(ctx, month, aggs);
  const brokerLabel = (id: string | null) => env.brokers.find((b) => b.id === id)?.code ?? "（未定）";
  const stCache = new Map<string, string>();
  const stLabel = async (_siteId: string, stId: string): Promise<string> => {
    if (!stCache.size) for (const siteIdEach of new Set(aggs.map((a) => a.ref.siteId))) for (const s of await shiftTypesForSite(env, siteIdEach)) stCache.set(s.id, s.code);
    return stCache.get(stId) ?? stId.slice(0, 8);
  };

  type Pending = { agg: Agg; proposals: Awaited<ReturnType<typeof findPriceSource>>["proposals"] };
  const pending: Pending[] = [];
  // OT 更冇 ot_hours：resolver 答 null（每小時價 × 時數），建卡／降級分診都冇用 → 出專題「補 ot_hours」。
  const otNoHours = new Map<Agg, number>();
  for (const agg of aggs) {
    if (!agg.ref.ot) continue;
    const bad = await prisma.shiftRecord.count({ where: { id: { in: agg.recordIds }, OR: [{ otHours: null }, { otHours: { lte: 0 } }] } });
    if (bad > 0) otNoHours.set(agg, bad);
  }
  const otHoursQuestion = async (agg: Agg, count: number) => {
    const site = env.sites.get(agg.ref.siteId);
    const code = await stLabel(agg.ref.siteId, agg.ref.shiftTypeId);
    ctx.addQuestion({
      kind: "month_close_pricing",
      groupKey: `ot_hours:${agg.ref.siteId}:${agg.ref.shiftTypeId}:${agg.ref.brokerId ?? "none"}`,
      sort: 35,
      title: `盤「${site?.canonicalName ?? ""}」OT 更種「${code}」${agg.ref.brokerId ? `雞頭 ${brokerLabel(agg.ref.brokerId)}` : ""}：${count} 更 OT 冇時數，請補 ot_hours`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: month.toISOString().slice(0, 10),
        kind: "month_close_pricing",
        summary: `${count} 更 OT 冇 ot_hours（OT 按每小時價 × 時數計），唔會建卡；請喺更表補返時數再重新撳一鍵結算`,
        suggestion: null,
        confidence: "unknown",
        action: { type: "ot_hours", group: agg.ref, count },
        candidates: [],
        prefillCandidateId: null,
      } satisfies McQuestionDraft["evidence"],
    });
    result.unknownGroups++;
  };
  for (const agg of aggs) {
    const noHours = otNoHours.get(agg) ?? 0;
    if (noHours > 0 && noHours === agg.recordIds.length) {
      // 成組都冇時數：唔建 auto 卡、唔出定價題
      await otHoursQuestion(agg, noHours);
      continue;
    }
    if (noHours > 0) await otHoursQuestion(agg, noHours);
    const found = await findPriceSource(ctx, env, agg.ref, agg.need);
    if (found.auto) {
      try {
        const site = env.sites.get(agg.ref.siteId);
        const code = await stLabel(agg.ref.siteId, agg.ref.shiftTypeId);
        const res = await createCardAndPrice(ctx, {
          month,
          group: agg.ref,
          need: agg.need,
          values: found.auto.values,
          evidence: found.auto.evidence,
          note: `一鍵結算自動定價（次序 ${found.auto.step}）：${found.auto.evidence}`,
          confidence: "auto",
          generic: found.auto.generic,
        });
        env.cardsBySite.delete(agg.ref.siteId);
        if (res.reusedCard && res.recordsPriced === 0) throw new Error("重用舊 auto 價卡但一更都補唔到價，改入分診");
        if (!res.reusedCard) ctx.summary.cardsCreated++;
        ctx.summary.recordsPriced += res.recordsPriced;
        ctx.line("pricing", `盤「${site?.canonicalName ?? ""}」更種「${code}」${agg.ref.brokerId ? `雞頭 ${brokerLabel(agg.ref.brokerId)} ` : ""}${res.recordsPriced} 更自動定價（${describeValues(found.auto.values)}；${found.auto.evidence}）`);
        result.autoGroups++;
        continue;
      } catch (e) {
        ctx.warnings.push(`自動定價建卡失敗（${e instanceof Error ? e.message.slice(0, 120) : "unknown"}），改入分診`);
        // 降級入分診：預填原本搵到嘅來源值做 propose（唔好寫成「冇依據」）。
        if (noHours > 0) continue; // 組內有冇時數 OT：專題已出，唔降級做定價題
        found.proposals.unshift({ step: found.auto.step, level: "propose", values: found.auto.values, generic: found.auto.generic, label: "原本自動定價嘅來源值（自動套用唔成功，請確認）", evidence: found.auto.evidence });
      }
    }
    // 冇結算雞頭嘅組合：價錢要等歸屬雞頭先定得，已有 settlement 分診題，唔再重複出定價題。
    if (agg.ref.brokerId === null) continue;
    pending.push({ agg, proposals: found.proposals });
  }

  // propose／unknown → 分診題
  const bySite = new Map<string, Pending[]>();
  for (const p of pending) bySite.set(p.agg.ref.siteId, [...(bySite.get(p.agg.ref.siteId) ?? []), p]);
  for (const [siteId, list] of bySite) {
    const site = env.sites.get(siteId);
    const allUnknown = list.every((p) => p.proposals.length === 0);
    const wholeSiteNew = ctx.newSiteIds.has(siteId) && allUnknown && list.length === aggs.filter((a) => a.ref.siteId === siteId).length;
    if (wholeSiteNew) {
      const total = list.reduce((a, p) => a + p.agg.recordIds.length, 0);
      ctx.addQuestion({
        kind: "month_close_site_new",
        groupKey: `site_new:${siteId}`,
        sort: 20,
        title: `新盤「${site?.canonicalName ?? ""}」冇價可以推（${total} 更）`,
        evidence: {
          v: 1,
          mc: true,
          runId: ctx.runId ?? "",
          month: month.toISOString().slice(0, 10),
          kind: "month_close_site_new",
          summary: `新盤「${site?.canonicalName ?? ""}」已自動建好更種同更次，但價目表／歷史／Postorder 都冇依據，${total} 更未定價；輸入價錢後會建卡並補價`,
          suggestion: null,
          confidence: "unknown",
          action: { type: "site_new", siteId, groups: list.map((p) => p.agg.ref) },
          candidates: [],
          prefillCandidateId: null,
        },
      });
      result.unknownGroups += list.length;
      continue;
    }
    for (const p of list) {
      const code = await stLabel(siteId, p.agg.ref.shiftTypeId);
      const needLabel = p.agg.need.client && p.agg.need.payout ? "客價＋出街價" : p.agg.need.client ? "客價" : "出街價";
      const cands: McCandidate[] = p.proposals.slice(0, 5).map((pr, i) => ({ id: `c${i}`, label: pr.label, values: pr.values, evidence: pr.evidence }));
      // 預填：永遠唔揀「未經人確認」嘅 auto 卡候選
      const prefill = cands.find((c) => !c.label.includes("未經人確認")) ?? null;
      const unknown = cands.length === 0;
      if (unknown) result.unknownGroups++;
      else result.proposeGroups++;
      const kindLabel = p.agg.ref.ot ? "OT " : "";
      ctx.addQuestion({
        kind: "month_close_pricing",
        groupKey: `pricing:${siteId}:${p.agg.ref.shiftTypeId}:${p.agg.ref.brokerId ?? "none"}:${p.agg.ref.ot ? "ot" : "shift"}`,
        sort: unknown ? 40 : 30,
        title: `${ctx.newSiteIds.has(siteId) ? "新盤" : "盤"}「${site?.canonicalName ?? ""}」${kindLabel}更種「${code}」${p.agg.ref.brokerId ? `雞頭 ${brokerLabel(p.agg.ref.brokerId)}` : ""}：${p.agg.recordIds.length} 更未定${needLabel}`,
        evidence: {
          v: 1,
          mc: true,
          runId: ctx.runId ?? "",
          month: month.toISOString().slice(0, 10),
          kind: "month_close_pricing",
          summary: unknown ? `價目表、歷史、Postorder 都冇依據，${p.agg.recordIds.length} 更未定${needLabel}` : `搵到 ${cands.length} 個候選價但唔夠硬（${cands[0]!.evidence ?? ""}），${p.agg.recordIds.length} 更未定${needLabel}`,
          suggestion: prefill ? `${prefill.label}：${describeValues(prefill.values ?? EMPTY_VALUES)}` : null,
          confidence: unknown ? "unknown" : "propose",
          action: { type: "pricing", group: p.agg.ref, needClient: p.agg.need.client, needPayout: p.agg.need.payout, count: p.agg.recordIds.length },
          candidates: cands,
          prefillCandidateId: prefill?.id ?? null,
        } satisfies McQuestionDraft["evidence"],
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 報告：未定價更數／估算缺口（唔准將未定價當 0 成本）
// ---------------------------------------------------------------------------
export interface UnpricedGap {
  records: number;
  clientGapEstimate: number | null;
  payoutGapEstimate: number | null;
  /** 有幾多更冇任何參考價（估算缺口未計入）。 */
  noReferenceRecords: number;
}

/** 用同盤同更種（同雞頭優先）最近一張已知卡嘅價，估算未定價更嘅金額缺口——淨係做提示，唔入任何金額表。 */
export async function estimateUnpricedGap(month: Date): Promise<UnpricedGap> {
  const aggs = await collectUnpricedGroups(month);
  const out: UnpricedGap = { records: 0, clientGapEstimate: null, payoutGapEstimate: null, noReferenceRecords: 0 };
  let client = 0;
  let payout = 0;
  let anyClient = false;
  let anyPayout = false;
  for (const a of aggs) {
    out.records += a.recordIds.length;
    const cards = await prisma.rateCard.findMany({ where: { siteId: a.ref.siteId, shiftTypeId: a.ref.shiftTypeId, voidedAt: null, guardId: null }, orderBy: { effectiveFrom: "desc" } });
    const ref = cards.map(toCard).filter(perShiftEligible);
    let any = false;
    if (a.need.client) {
      const c = ref.find((x) => x.clientRate !== null && x.clientRate > 0);
      if (c?.clientRate) {
        client += c.clientRate * a.recordIds.length;
        anyClient = true;
        any = true;
      }
    }
    if (a.need.payout) {
      const sameBroker = ref.filter((x) => x.brokerId === a.ref.brokerId);
      const c = (sameBroker.length ? sameBroker : ref).find((x) => (x.guardWage ?? x.payoutRate ?? 0) > 0 || (x.brokerFee ?? 0) > 0);
      if (c) {
        payout += ((c.guardWage ?? c.payoutRate ?? 0) + (c.guardWage !== null ? (c.brokerFee ?? 0) : 0)) * a.recordIds.length;
        anyPayout = true;
        any = true;
      }
    }
    if (!any) out.noReferenceRecords += a.recordIds.length;
  }
  out.clientGapEstimate = anyClient ? round2(client) : null;
  out.payoutGapEstimate = anyPayout ? round2(payout) : null;
  return out;
}
