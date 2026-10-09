// WP-ONE-CLICK-AUTO（§31.3 D）：結算雞頭自動歸屬。
//
// 對全月對數套用之後仍然冇結算雞頭（settlement_broker_id=null，`no_settlement`）嘅更，按次序推斷：
//   (1) 更表雞頭欄——reconcile 已經做咗（呢度冇值先到呢度）；
//   (2) Postorder 同崗位同日嘅雞頭（Roster 分頁逐日「雞頭名」，值唯一先用）；
//   (3) 長工崗位／合約（B07）——安員係長工類（或 external 類、而且只得一個 external 雞頭）；
//   (4) 安員預設雞頭；
//   (5) 該安員（或者同一更表姓名）近 3 個月喺同盤嘅結算雞頭，多數決而且唯一；
//   (6) 全部冇 → 分診題 `month_close_settlement`，預填最可能候選（同盤本月最常見嘅雞頭，唯一先預填）。
// 客戶自己人（external）：解析時 rank／姓名命中 external 別名已歸 external（service.ts），永遠分開計。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { findInternalLongtermBrokerId } from "@/lib/pricing/longterm-settlement";
import { shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";
import type { AutoCollector, ChangeWriter } from "./context";
import { matchBrokerLabel, rowsForSite, type BrokerLite } from "./postorder-evidence";
import { normalizeSiteKey } from "./site-match";
import type { McCandidate } from "./types";

export const SETTLEMENT_QUESTION_MAX = 40;

interface NullRec {
  id: string;
  workDate: Date;
  siteId: string;
  shiftTypeId: string;
  guardId: string;
  operationalBrokerId: string | null;
}

function pickUniqueMajority(counts: Map<string, number>): string | null {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]![0];
  return sorted[0]![1] > sorted[1]![1] ? sorted[0]![0] : null;
}

/** 寫一批結算歸屬（journal＋audit，一個 transaction 內逐項），回傳寫咗幾多更。 */
export async function setSettlementBatch(writer: ChangeWriter, ids: string[], brokerId: string, reason: string): Promise<number> {
  if (ids.length === 0) return 0;
  const recs = await prisma.shiftRecord.findMany({ where: { id: { in: ids }, settlementBrokerId: null, status: { not: "cancelled" } }, select: { id: true, settlementBrokerId: true, operationalBrokerId: true } });
  if (recs.length === 0) return 0;
  for (let i = 0; i < recs.length; i += 300) {
    const batch = recs.slice(i, i + 300);
    await prisma.$transaction(batch.map((r) => prisma.shiftRecord.update({ where: { id: r.id }, data: { settlementBrokerId: brokerId, operationalBrokerId: r.operationalBrokerId ?? brokerId } })));
    await writer.journal({
      kind: "settlement_set",
      refTable: "shift_records",
      summary: `補結算雞頭 ${batch.length} 更（${reason}）`,
      detail: { brokerId, reason, rows: batch.map((r) => ({ id: r.id, beforeSettlement: r.settlementBrokerId, beforeOperational: r.operationalBrokerId, afterOperational: r.operationalBrokerId ?? brokerId })) },
    });
  }
  await writer.audit({ tableName: "shift_records", rowId: `auto_settlement:${recs[0]!.id}`, action: "update", after: { count: recs.length, broker_id: brokerId, reason } });
  return recs.length;
}

export interface AutoSettlementResult {
  scanned: number;
  assigned: number;
  unresolved: number;
}

export async function runAutoSettlement(ctx: AutoCollector, month: Date): Promise<AutoSettlementResult> {
  const { start, end } = monthRange(month);
  const out: AutoSettlementResult = { scanned: 0, assigned: 0, unresolved: 0 };
  const recs: NullRec[] = await prisma.shiftRecord.findMany({
    where: { settlementBrokerId: null, status: { not: "cancelled" }, recordType: { in: ["shift", "ot"] }, workDate: { gte: start, lte: end }, site: { guardsPaidByClient: false } },
    select: { id: true, workDate: true, siteId: true, shiftTypeId: true, guardId: true, operationalBrokerId: true },
  });
  out.scanned = recs.length;
  if (recs.length === 0) return out;

  const brokers: BrokerLite[] = await ctx.brokers();
  const guards = await prisma.guard.findMany({ where: { id: { in: [...new Set(recs.map((r) => r.guardId))] } }, select: { id: true, employmentType: true, defaultBrokerId: true } });
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const longtermBrokerId = await findInternalLongtermBrokerId(prisma);
  const externalBrokers = brokers.filter((b) => b.kind === "external");
  const ev = await ctx.postorder();
  const sites = await prisma.site.findMany({ where: { id: { in: [...new Set(recs.map((r) => r.siteId))] } }, select: { id: true, canonicalName: true, aliases: true } });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const shiftTypes = await prisma.shiftType.findMany({ where: { id: { in: [...new Set(recs.map((r) => r.shiftTypeId))] } }, select: { id: true, startTime: true, endTime: true } });
  const slotByStId = new Map(shiftTypes.map((s) => [s.id, shiftTypeTimeSlot(s.startTime, s.endTime)]));

  // (2) 預先算：site → [{propKey, slot→shiftLabel}]
  const poBySite = new Map<string, Array<{ propKey: string; slotLabels: Map<string, string> }>>();
  if (ev && ev.dayBrokers.size > 0) {
    for (const s of sites) {
      const rows = rowsForSite(ev.priceRows, [s.canonicalName, ...s.aliases]);
      const byProp = new Map<string, Map<string, string>>();
      for (const r of rows) {
        if (!r.propertyShort || !r.timeSlot || !r.shiftLabel) continue;
        const k = normalizeSiteKey(r.propertyShort);
        const m = byProp.get(k) ?? new Map<string, string>();
        m.set(r.timeSlot, r.shiftLabel);
        byProp.set(k, m);
      }
      poBySite.set(s.id, [...byProp.entries()].map(([propKey, slotLabels]) => ({ propKey, slotLabels })));
    }
  }
  const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1));

  // 本月更表名（同一安員同盤嘅 nameRaw／staffNoRaw），歷史行 lookup 用。
  const thisMonthRows = await prisma.rosterUploadRow.findMany({
    where: { guardId: { in: guards.map((g) => g.id) }, codeKind: { in: ["shift", "ot"] }, upload: { month: start, status: { notIn: ["superseded", "voided"] } } },
    select: { guardId: true, resolvedSiteId: true, nameRaw: true, staffNoRaw: true },
  });
  const idsByGuardSite = new Map<string, { names: Set<string>; staffNos: Set<string> }>();
  for (const r of thisMonthRows) {
    if (!r.guardId || !r.resolvedSiteId) continue;
    const k = `${r.guardId}|${r.resolvedSiteId}`;
    const e = idsByGuardSite.get(k) ?? { names: new Set<string>(), staffNos: new Set<string>() };
    if (r.nameRaw?.trim()) e.names.add(r.nameRaw.trim());
    if (r.staffNoRaw?.trim()) e.staffNos.add(r.staffNoRaw.trim());
    idsByGuardSite.set(k, e);
  }

  const historyCache = new Map<string, Promise<string | null>>();
  const historyBroker = (guardId: string, siteId: string): Promise<string | null> => {
    const key = `${guardId}|${siteId}`;
    let p = historyCache.get(key);
    if (!p) {
      p = (async () => {
        const counts = new Map<string, number>();
        const own = await prisma.shiftRecord.groupBy({ by: ["settlementBrokerId"], where: { guardId, siteId, status: { not: "cancelled" }, settlementBrokerId: { not: null }, workDate: { gte: prevStart, lt: start } }, _count: { _all: true } });
        for (const g of own) if (g.settlementBrokerId) counts.set(g.settlementBrokerId, (counts.get(g.settlementBrokerId) ?? 0) + g._count._all);
        const ids = idsByGuardSite.get(key);
        if (counts.size === 0 && ids && (ids.names.size > 0 || ids.staffNos.size > 0)) {
          const rows = await prisma.rosterUploadRow.groupBy({
            by: ["settlementBrokerId"],
            where: {
              resolvedSiteId: siteId,
              settlementBrokerId: { not: null },
              codeKind: { in: ["shift", "ot"] },
              upload: { month: { gte: prevStart, lt: start }, status: { notIn: ["superseded", "voided"] } },
              OR: [...(ids.names.size ? [{ nameRaw: { in: [...ids.names] } }] : []), ...(ids.staffNos.size ? [{ staffNoRaw: { in: [...ids.staffNos] } }] : [])],
            },
            _count: { _all: true },
          });
          for (const g of rows) if (g.settlementBrokerId) counts.set(g.settlementBrokerId, (counts.get(g.settlementBrokerId) ?? 0) + g._count._all);
        }
        return pickUniqueMajority(counts);
      })();
      historyCache.set(key, p);
    }
    return p;
  };

  const assign = new Map<string, { ids: string[]; reason: string }>(); // `${brokerId}|${reason}` → ids
  const unresolved = new Map<string, NullRec[]>(); // `${siteId}|${guardId}`
  const add = (brokerId: string, reason: string, id: string) => {
    const k = `${brokerId}|${reason}`;
    const e = assign.get(k) ?? { ids: [], reason };
    e.ids.push(id);
    assign.set(k, e);
  };
  const brokerIdSet = new Set(brokers.map((b) => b.id));

  for (const r of recs) {
    const guard = guardById.get(r.guardId);
    // (2) Postorder 同崗位同日雞頭
    let found: { id: string; reason: string } | null = null;
    const po = poBySite.get(r.siteId);
    if (po && ev) {
      const slot = slotByStId.get(r.shiftTypeId) ?? null;
      const labels = new Set<string>();
      for (const p of po) {
        const shiftLabel = slot ? p.slotLabels.get(slot) : undefined;
        if (!shiftLabel) continue;
        const set = ev.dayBrokers.get(`${p.propKey}|${shiftLabel}|${r.workDate.toISOString().slice(0, 10)}`);
        if (set) for (const l of set) if (!l.includes("長工")) labels.add(l);
      }
      const matched = [...labels].map((l) => matchBrokerLabel(l, brokers));
      if (labels.size >= 1 && matched.every((m) => m) && new Set(matched.map((m) => m!.id)).size === 1) found = { id: matched[0]!.id, reason: "Postorder 同崗位同日嘅雞頭" };
    }
    // (3) 長工／external
    if (!found && guard) {
      if (guard.employmentType.startsWith("longterm_") && longtermBrokerId) found = { id: longtermBrokerId, reason: "長工（結算單位 B07）" };
      else if (guard.employmentType === "external" && externalBrokers.length === 1) found = { id: externalBrokers[0]!.id, reason: "客戶自己人（external）" };
    }
    // (4) 安員預設雞頭
    if (!found && guard?.defaultBrokerId && brokerIdSet.has(guard.defaultBrokerId)) found = { id: guard.defaultBrokerId, reason: "安員預設雞頭" };
    // (5) 近 3 個月同盤多數決
    if (!found) {
      const h = await historyBroker(r.guardId, r.siteId);
      if (h) found = { id: h, reason: "近 3 個月同盤嘅結算雞頭（多數決）" };
    }
    if (found) add(found.id, found.reason, r.id);
    else {
      const k = `${r.siteId}|${r.guardId}`;
      unresolved.set(k, [...(unresolved.get(k) ?? []), r]);
    }
  }

  for (const [key, v] of assign) {
    const brokerId = key.slice(0, key.indexOf("|"));
    const n = await setSettlementBatch(ctx, v.ids, brokerId, v.reason);
    out.assigned += n;
    ctx.summary.recordsSettled += n;
    const code = brokers.find((b) => b.id === brokerId)?.code ?? "?";
    ctx.line("pricing", `${n} 更冇結算雞頭，自動歸 ${code}（${v.reason}）`);
  }

  // (6) 分診題：預填同盤本月最常見雞頭（唯一先預填）
  let questions = 0;
  const siteCommon = new Map<string, string | null>();
  for (const [key, list] of unresolved) {
    out.unresolved += list.length;
    if (questions >= SETTLEMENT_QUESTION_MAX) continue;
    const [siteId, guardId] = key.split("|") as [string, string];
    if (!siteCommon.has(siteId)) {
      const g = await prisma.shiftRecord.groupBy({ by: ["settlementBrokerId"], where: { siteId, status: { not: "cancelled" }, settlementBrokerId: { not: null }, workDate: { gte: start, lte: end } }, _count: { _all: true } });
      const m = new Map<string, number>();
      for (const x of g) if (x.settlementBrokerId) m.set(x.settlementBrokerId, x._count._all);
      siteCommon.set(siteId, pickUniqueMajority(m));
    }
    const prefill = siteCommon.get(siteId) ?? null;
    const siteName = siteById.get(siteId)?.canonicalName ?? "";
    const cands: McCandidate[] = prefill ? [{ id: "c0", label: `${brokers.find((b) => b.id === prefill)?.code ?? "?"}（呢個盤本月最常見嘅結算雞頭）`, refId: prefill, evidence: "同盤本月已有結算雞頭嘅多數" }] : [];
    ctx.addQuestion({
      kind: "month_close_settlement",
      groupKey: `settlement:${siteId}:${guardId}`,
      sort: 50,
      title: `盤「${siteName}」有 ${list.length} 更冇結算雞頭`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: month.toISOString().slice(0, 10),
        kind: "month_close_settlement",
        summary: `盤「${siteName}」有 ${list.length} 更冇結算雞頭（更表冇雞頭欄、Postorder／預設雞頭／近 3 個月歷史都推唔到）${prefill ? "，預填同盤最常見嘅雞頭" : ""}`,
        suggestion: prefill ? `歸 ${brokers.find((b) => b.id === prefill)?.code ?? "?"}` : null,
        confidence: prefill ? "propose" : "unknown",
        action: { type: "settlement", siteId, guardId, count: list.length },
        candidates: cands,
        prefillCandidateId: cands[0]?.id ?? null,
      },
    });
    questions++;
  }
  return out;
}
