// WP-POSTORDER-FREE（§34 C）：報告「冇 Postorder 都計到嘅比例」。
// 全部由現有資料統計，唔估算：
//   價錢：該月 `price_snapshots` journal（status=applied，涵蓋該月所有未還原 run）逐更取最新一條 → 對應價卡仍然生效嘅
//         `auto:one-click:*` 卡按卡 note「次序 N」分 1–5；其餘（人手／分診／補齊後嘅正式卡、已作廢嘅 auto 卡）＝existing。
//         唔靠 Postorder＝total − unpriced − byStep[2]（次序 2＝Postorder 價）。
//   雞頭：該月 shift／ot 更（排除客戶直接出糧盤）。`settlement_set` journal 逐更取最新一條按 reason 分類；
//         roster＝其餘已有結算雞頭嘅更（更表雞頭欄／對數）；unresolved＝仍冇結算雞頭。唔靠 Postorder＝total − postorder − unresolved。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { SETTLEMENT_REASON } from "./settlement";
import type { AutoSummary, PostorderDependency } from "./types";

const AUTO_PREFIX = "auto:one-click:";
const CHUNK = 5000;

export const stepOfAutoCardNote = (note: string | null): 1 | 2 | 3 | 4 | 5 | null => {
  const m = /次序\s*([1-5])/.exec(note ?? "");
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4 | 5) : null;
};

function emptyDependency(): PostorderDependency {
  return {
    pricing: { total: 0, unpriced: 0, byStep: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, existing: 0 }, withoutPostorder: 0 },
    settlement: { total: 0, byReason: { roster: 0, postorder: 0, longterm: 0, external: 0, guardDefault: 0, siteDefault: 0, history: 0, other: 0, unresolved: 0 }, withoutPostorder: 0 },
  };
}

export async function computePostorderDependency(month: Date, summary: Pick<AutoSummary, "unpricedRecords">): Promise<PostorderDependency> {
  const { start, end } = monthRange(month);
  const out = emptyDependency();

  // 該月所有 run 嘅有效 journal（時間順序，後寫覆蓋前寫＝每更取最新）
  const changes = await prisma.monthCloseAutoChange.findMany({
    where: { status: "applied", kind: { in: ["price_snapshots", "settlement_set"] }, run: { month: start } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { kind: true, detailJson: true },
  });
  const priceCardByRecord = new Map<string, string>();
  const settleReasonByRecord = new Map<string, string>();
  for (const c of changes) {
    const d = c.detailJson as { cardId?: string; reason?: string; rows?: Array<{ id: string }> };
    for (const r of d.rows ?? []) {
      if (c.kind === "price_snapshots" && d.cardId) priceCardByRecord.set(r.id, d.cardId);
      else if (c.kind === "settlement_set") settleReasonByRecord.set(r.id, d.reason ?? "");
    }
  }

  // ---- 價錢 ----
  // total：該月非 cancelled、非客戶自己人（external）嘅 shift＋OT 更（同 journal 涵蓋範圍一致）。
  const total = await prisma.shiftRecord.count({ where: { recordType: { in: ["shift", "ot"] }, status: { not: "cancelled" }, isExternal: false, NOT: { settlementBroker: { is: { kind: "external" } } }, workDate: { gte: start, lte: end } } });
  const unpriced = Math.min(summary.unpricedRecords, total);
  const priced = Math.max(0, total - unpriced);
  out.pricing.total = total;
  out.pricing.unpriced = unpriced;
  const cardIds = [...new Set(priceCardByRecord.values())].filter((x) => x !== "existing");
  const cards = cardIds.length ? await prisma.rateCard.findMany({ where: { id: { in: cardIds } }, select: { id: true, source: true, note: true, voidedAt: true } }) : [];
  const stepOfCard = new Map<string, 1 | 2 | 3 | 4 | 5>();
  for (const c of cards) if (!c.voidedAt && (c.source ?? "").startsWith(AUTO_PREFIX)) {
    const st = stepOfAutoCardNote(c.note);
    if (st) stepOfCard.set(c.id, st);
  }
  const live = await liveRecordIds([...priceCardByRecord.keys()], start, end);
  for (const [rid, cid] of priceCardByRecord) {
    if (!live.has(rid)) continue;
    const st = stepOfCard.get(cid);
    if (st) {
      out.pricing.byStep[String(st) as "1"]++;
    }
  }
  const autoPriced = (["1", "2", "3", "4", "5"] as const).reduce((a, k) => a + out.pricing.byStep[k], 0);
  out.pricing.byStep.existing = Math.max(0, priced - autoPriced);
  out.pricing.withoutPostorder = Math.max(0, priced - out.pricing.byStep["2"]);

  // ---- 結算雞頭 ----
  const unresolved = await prisma.shiftRecord.count({ where: { settlementBrokerId: null, status: { not: "cancelled" }, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, site: { guardsPaidByClient: false } } });
  const sTotal = await prisma.shiftRecord.count({ where: { status: { not: "cancelled" }, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, site: { guardsPaidByClient: false } } });
  const br = out.settlement.byReason;
  const liveSettled = await settledRecordIds([...settleReasonByRecord.keys()], start, end);
  for (const [rid, reason] of settleReasonByRecord) {
    if (!liveSettled.has(rid)) continue;
    if (reason === SETTLEMENT_REASON.postorder) br.postorder++;
    else if (reason === SETTLEMENT_REASON.longterm) br.longterm++;
    else if (reason === SETTLEMENT_REASON.external) br.external++;
    else if (reason === SETTLEMENT_REASON.guardDefault) br.guardDefault++;
    else if (reason === SETTLEMENT_REASON.siteDefault) br.siteDefault++;
    else if (reason === SETTLEMENT_REASON.history) br.history++;
    else br.other++;
  }
  br.unresolved = unresolved;
  const autoSettled = br.postorder + br.longterm + br.external + br.guardDefault + br.siteDefault + br.history + br.other;
  br.roster = Math.max(0, sTotal - unresolved - autoSettled);
  out.settlement.total = sTotal;
  out.settlement.withoutPostorder = Math.max(0, sTotal - br.postorder - unresolved);
  return out;
}

/** journal 入面嘅更 id 當中，仍然係該月非 cancelled 更次嘅。 */
async function liveRecordIds(ids: string[], start: Date, end: Date): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await prisma.shiftRecord.findMany({ where: { id: { in: ids.slice(i, i + CHUNK) }, status: { not: "cancelled" }, workDate: { gte: start, lte: end } }, select: { id: true } });
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** 同上，而且仍然有結算雞頭（之後被清走嘅唔計）。 */
async function settledRecordIds(ids: string[], start: Date, end: Date): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await prisma.shiftRecord.findMany({ where: { id: { in: ids.slice(i, i + CHUNK) }, status: { not: "cancelled" }, settlementBrokerId: { not: null }, workDate: { gte: start, lte: end } }, select: { id: true } });
    for (const r of rows) out.add(r.id);
  }
  return out;
}
