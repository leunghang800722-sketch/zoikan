// WP-ONE-CLICK-AUTO（§31.3 B）：更數異常自動解釋。
//
// 口徑：「計數更次」＝更表 shift 格，排除 external（客戶自己人，雞頭種類 external、
// rank／姓名命中 external 別名、或安員係 external 類）同 leave／ot／marker。
// 同上月「計數更次」比較，差異 >30%（或者連 external 一齊計嘅原始格數差 >30%）就拆：
//   external 格、公司兵（internal_cash）、同日同更種重複行、子盤變化、日期覆蓋（截短）、
//   雞頭組成（新增／消失嘅雞頭）、Postorder 同盤更數。
// 輸出一句解釋＋explained；剩餘解釋唔到 >15% 且 >20 更先 needs_human（任務書口徑，
// 文件 §31.3 B 寫「或者」——以任務書「且」為準，見 §31.6 同文件嘅出入）。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { externalBrokerForRow, type ExternalBrokerLite } from "@/lib/roster-upload/external-alias";
import type { AutoCollector, VarianceFinding } from "./context";
import { rowsForSite } from "./postorder-evidence";

export const VARIANCE_FLAG_PCT = 0.3;
export const VARIANCE_UNEXPLAINED_PCT = 0.15;
export const VARIANCE_UNEXPLAINED_MIN = 20;
/** 剩餘 >15% 而且 >5 更，或者剩餘 >20 更 → needs_human（主規劃決定）。 */
export const VARIANCE_UNEXPLAINED_PCT_MIN = 5;
export const COVERAGE_TRUNCATED_BELOW = 0.8;

interface RowLite {
  workDate: Date;
  rawCode: string;
  codeKind: string;
  shiftTypeId: string | null;
  resolvedSiteId: string | null;
  guardId: string | null;
  staffNoRaw: string | null;
  nameRaw: string | null;
  rankRaw: string | null;
  settlementBrokerId: string | null;
}

export interface UploadScope {
  id: string;
  siteId: string;
  siteNameRaw: string;
  parseSummary: unknown;
}

interface Classified {
  /** 計數更次（非 external 嘅 shift 格）。 */
  countable: RowLite[];
  /** 同人同日同更種重複出現嘅「多出嚟」嗰啲格（每格只歸呢個成分，唔再計入公司兵／子盤／雞頭）。 */
  dupRows: Set<RowLite>;
  external: RowLite[];
  internalCash: RowLite[];
  duplicates: number;
  dates: Set<string>;
}

export interface VarianceLookups {
  externals: ExternalBrokerLite[];
  externalBrokerIds: Set<string>;
  internalCashBrokerIds: Set<string>;
  externalGuardIds: Set<string>;
  brokerCodeById: Map<string, string>;
}

export async function loadVarianceLookups(): Promise<VarianceLookups> {
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true, name: true, kind: true, aliases: true } });
  const externals = brokers.filter((b) => b.kind === "external").map((b) => ({ id: b.id, code: b.code, name: b.name, aliases: b.aliases }));
  const extGuards = await prisma.guard.findMany({ where: { employmentType: "external" }, select: { id: true } });
  return {
    externals,
    externalBrokerIds: new Set(externals.map((b) => b.id)),
    internalCashBrokerIds: new Set(brokers.filter((b) => b.kind === "internal_cash").map((b) => b.id)),
    externalGuardIds: new Set(extGuards.map((g) => g.id)),
    brokerCodeById: new Map(brokers.map((b) => [b.id, b.code])),
  };
}

export function classifyRows(rows: readonly RowLite[], lk: VarianceLookups): Classified {
  const out: Classified = { countable: [], dupRows: new Set(), external: [], internalCash: [], duplicates: 0, dates: new Set() };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.codeKind !== "shift") continue;
    out.dates.add(r.workDate.toISOString().slice(0, 10));
    const isExt = (r.settlementBrokerId !== null && lk.externalBrokerIds.has(r.settlementBrokerId)) || (r.guardId !== null && lk.externalGuardIds.has(r.guardId)) || externalBrokerForRow(r, lk.externals) !== null;
    if (isExt) {
      out.external.push(r);
      continue;
    }
    const who = r.guardId ?? `${(r.staffNoRaw ?? "").trim()}|${(r.nameRaw ?? "").trim()}`;
    const key = `${who}|${r.workDate.toISOString().slice(0, 10)}|${r.shiftTypeId ?? r.rawCode.trim().toUpperCase()}`;
    const isDup = seen.has(key);
    if (isDup) {
      out.duplicates++;
      out.dupRows.add(r);
    }
    seen.add(key);
    out.countable.push(r);
    if (!isDup && r.settlementBrokerId !== null && lk.internalCashBrokerIds.has(r.settlementBrokerId)) out.internalCash.push(r);
  }
  return out;
}

const ROW_SELECT = {
  workDate: true,
  rawCode: true,
  codeKind: true,
  shiftTypeId: true,
  resolvedSiteId: true,
  guardId: true,
  staffNoRaw: true,
  nameRaw: true,
  rankRaw: true,
  settlementBrokerId: true,
} as const;

function countBy<T>(rows: readonly RowLite[], f: (r: RowLite) => T | null): Map<T, number> {
  const m = new Map<T, number>();
  for (const r of rows) {
    const k = f(r);
    if (k === null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function onlyIn(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [k, v] of a) if (!b.has(k)) n += v;
  return n;
}

function missingDays(dates: Set<string>, month: Date): string[] {
  const { start, end } = monthRange(month);
  const out: string[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const k = d.toISOString().slice(0, 10);
    if (!dates.has(k)) out.push(k);
  }
  return out;
}

export interface VarianceResult {
  findings: VarianceFinding[];
  warnings: string[];
  needsHuman: string[];
  legacyFlagged: number;
}

export interface VarianceComponents {
  delta: number;
  dup: number;
  ic: number;
  sub: number;
  broker: number;
  trunc: number;
  residual: number;
}

/** 剩餘解釋唔到 → needs_human 嘅判斷（>20 更，或者 >15% 而且 >5 更）。 */
export function varianceNeedsHuman(unexplained: number, prevCount: number): boolean {
  const pct = prevCount > 0 ? unexplained / prevCount : unexplained > 0 ? 1 : 0;
  return unexplained > VARIANCE_UNEXPLAINED_MIN || (pct > VARIANCE_UNEXPLAINED_PCT && unexplained > VARIANCE_UNEXPLAINED_PCT_MIN);
}

/** 對本月每個已指定盤嘅 active 上載做更數比較同拆解。每格只歸一個成分：
 * 重複行 → 公司兵 → 子盤變化 → 雞頭組成 → 其餘；成分加埋＋截短推算＋剩餘 ＝ 差額（`components` 可驗證）。 */
export async function explainVariances(ctx: AutoCollector, month: Date, uploads: readonly UploadScope[]): Promise<VarianceResult> {
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const lk = await loadVarianceLookups();
  const ev = await ctx.postorder();
  const result: VarianceResult = { findings: [], warnings: [], needsHuman: [], legacyFlagged: 0 };
  const daysInMonth = monthRange(month).end.getUTCDate();
  const prevDays = monthRange(prevMonth).end.getUTCDate();

  const addQuestion = (u: UploadScope, siteName: string, headline: string, sentence: string, unexplained: number) => {
    ctx.addQuestion({
      kind: "month_close_shift_variance",
      groupKey: `variance:${u.siteId}`,
      sort: 60,
      title: `「${siteName}」${headline}`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: month.toISOString().slice(0, 10),
        kind: "month_close_shift_variance",
        summary: sentence,
        suggestion: null,
        confidence: "unknown",
        action: { type: "shift_variance", siteId: u.siteId },
        candidates: [],
        prefillCandidateId: null,
      },
    });
    void unexplained;
  };

  for (const u of uploads) {
    const site = await prisma.site.findUnique({ where: { id: u.siteId }, select: { canonicalName: true, aliases: true } });
    const siteName = site?.canonicalName ?? u.siteNameRaw;
    const summary = (u.parseSummary as { shiftCount?: number; warnings?: string[] } | null) ?? null;
    const curRows = (await prisma.rosterUploadRow.findMany({ where: { uploadId: u.id, codeKind: "shift" }, select: ROW_SELECT })) as RowLite[];
    const cur = classifyRows(curRows, lk);
    const curCount = cur.countable.length;

    // 截短（日期覆蓋 <80%，或表頭偵測有警告）——獨立於 30% 閘口：一律 warning＋needs_human，唔當 explained。
    const headerWarn = (summary?.warnings ?? []).some((w) => w.startsWith("[分頁跳過]") || w.includes("block 邊界"));
    const coverage = cur.dates.size / daysInMonth;
    const truncated = curRows.length > 0 && (coverage < COVERAGE_TRUNCATED_BELOW || headerWarn);
    const missing = truncated ? missingDays(cur.dates, month) : [];
    const estMissing = truncated && cur.dates.size > 0 ? Math.round((curCount / cur.dates.size) * (daysInMonth - cur.dates.size)) : 0;
    const truncSentence = truncated
      ? `檔案可能截短：只覆蓋 ${cur.dates.size}／${daysInMonth} 日${missing.length ? `（缺 ${missing.slice(0, 8).map((d) => d.slice(8)).join("、")}${missing.length > 8 ? "…" : ""} 號）` : ""}${headerWarn ? "，表頭偵測有警告" : ""}，按日均推算少約 ${estMissing} 更`
      : "";

    const prevUpload = await prisma.rosterUpload.findFirst({
      where: { month: prevMonth, siteId: u.siteId, status: { notIn: ["superseded", "voided"] } },
      select: { id: true, parseSummary: true },
      orderBy: { uploadedAt: "desc" },
    });
    const prevRows = prevUpload ? ((await prisma.rosterUploadRow.findMany({ where: { uploadId: prevUpload.id, codeKind: "shift" }, select: ROW_SELECT })) as RowLite[]) : [];

    // 冇上月比較（新盤／上月冇上載）或者冇逐格資料（只有 parse_summary）
    if (!prevUpload || curRows.length === 0 || prevRows.length === 0) {
      if (prevUpload && (curRows.length === 0 || prevRows.length === 0)) {
        const cc = summary?.shiftCount ?? 0;
        const prevCount = (prevUpload.parseSummary as { shiftCount?: number } | null)?.shiftCount ?? null;
        if (prevCount && prevCount > 0) {
          const pct = Math.abs(cc - prevCount) / prevCount;
          if (pct > VARIANCE_FLAG_PCT) {
            result.legacyFlagged++;
            result.warnings.push(`「${u.siteNameRaw}」本月 ${cc} 格 vs 上月 ${prevCount} 格，相差 ${Math.round(pct * 10000) / 100}%——可能截短／格式異常，請人手覆核（冇逐格資料，拆唔到）`);
          }
        }
      }
      if (truncated) {
        const sentence = `「${siteName}」本月 ${curCount} 更：${truncSentence}`;
        ctx.summary.variancesUnexplained++;
        result.legacyFlagged++;
        result.findings.push({ siteId: u.siteId, siteName, current: curCount, previous: null, external: cur.external.length, internalCash: cur.internalCash.length, deltaPct: null, explained: false, sentence, unexplained: estMissing });
        result.warnings.push(`${sentence}——請人手覆核`);
        result.needsHuman.push(sentence);
        addQuestion(u, siteName, "檔案可能截短", sentence, estMissing);
      }
      continue;
    }

    const prev = classifyRows(prevRows, lk);
    const prevCount = prev.countable.length;
    const delta = curCount - prevCount;
    const pct = prevCount > 0 ? Math.abs(delta) / prevCount : curCount > 0 ? 1 : 0;
    const curRaw = curCount + cur.external.length;
    const prevRaw = prevCount + prev.external.length;
    const rawPct = prevRaw > 0 ? Math.abs(curRaw - prevRaw) / prevRaw : curRaw > 0 ? 1 : 0;
    const flagged = pct > VARIANCE_FLAG_PCT || rawPct > VARIANCE_FLAG_PCT;
    if (!flagged && !truncated) continue;

    const parts: string[] = [];
    const comp: VarianceComponents = { delta, dup: 0, ic: 0, sub: 0, broker: 0, trunc: 0, residual: 0 };

    if (flagged) {
      if (cur.external.length !== prev.external.length) parts.push(`已排除客戶自己人 ${cur.external.length} 格（上月 ${prev.external.length}）`);
      else if (cur.external.length > 0) parts.push(`已排除客戶自己人 ${cur.external.length} 格`);

      // 每格只歸一個成分（順序：重複 → 公司兵 → 子盤 → 雞頭組成）
      comp.dup = cur.duplicates - prev.duplicates;
      if (cur.duplicates > 0 || comp.dup !== 0) parts.push(`同人同日同更種重複行 ${cur.duplicates} 更${prev.duplicates ? `（上月 ${prev.duplicates}）` : ""}`);
      comp.ic = cur.internalCash.length - prev.internalCash.length;
      if (comp.ic !== 0) parts.push(`公司兵 ${cur.internalCash.length} 更（上月 ${prev.internalCash.length}）`);

      const icCur = new Set(cur.internalCash);
      const icPrev = new Set(prev.internalCash);
      const restCur = cur.countable.filter((r) => !cur.dupRows.has(r) && !icCur.has(r));
      const restPrev = prev.countable.filter((r) => !prev.dupRows.has(r) && !icPrev.has(r));
      const subCur = countBy(restCur, (r) => r.resolvedSiteId);
      const subPrev = countBy(restPrev, (r) => r.resolvedSiteId);
      const subOnlyCur = new Set([...subCur.keys()].filter((k) => !subPrev.has(k)));
      const subOnlyPrev = new Set([...subPrev.keys()].filter((k) => !subCur.has(k)));
      const subRowsCur = subCur.size + subPrev.size > 2 ? restCur.filter((r) => r.resolvedSiteId !== null && subOnlyCur.has(r.resolvedSiteId)) : [];
      const subRowsPrev = subCur.size + subPrev.size > 2 ? restPrev.filter((r) => r.resolvedSiteId !== null && subOnlyPrev.has(r.resolvedSiteId)) : [];
      comp.sub = subRowsCur.length - subRowsPrev.length;
      if (comp.sub !== 0) parts.push(`子盤變化 ${comp.sub > 0 ? "+" : ""}${comp.sub} 更（新增或者消失嘅子盤）`);

      const subSetCur = new Set(subRowsCur);
      const subSetPrev = new Set(subRowsPrev);
      const brCur = restCur.filter((r) => !subSetCur.has(r));
      const brPrev = restPrev.filter((r) => !subSetPrev.has(r));
      const brokerCur = countBy(brCur, (r) => r.settlementBrokerId);
      const brokerPrev = countBy(brPrev, (r) => r.settlementBrokerId);
      const newBrokers = [...brokerCur.keys()].filter((k) => !brokerPrev.has(k));
      const goneBrokers = [...brokerPrev.keys()].filter((k) => !brokerCur.has(k));
      comp.broker = onlyIn(brokerCur, brokerPrev) - onlyIn(brokerPrev, brokerCur);
      if (comp.broker !== 0) {
        const code = (id: string) => lk.brokerCodeById.get(id) ?? "?";
        parts.push(`雞頭組成變化：${newBrokers.length ? `新增 ${newBrokers.map(code).join("／")}` : ""}${newBrokers.length && goneBrokers.length ? "、" : ""}${goneBrokers.length ? `消失 ${goneBrokers.map(code).join("／")}` : ""}（${comp.broker > 0 ? "+" : ""}${comp.broker} 更）`);
      }
    }

    // 截短推算（本月缺嘅日子；上月亦截短就反方向）
    if (truncated) {
      parts.push(truncSentence);
      const prevCoverage = prev.dates.size / prevDays;
      const prevEst = prevCoverage < COVERAGE_TRUNCATED_BELOW && prev.dates.size > 0 ? Math.round((prevCount / prev.dates.size) * (prevDays - prev.dates.size)) : 0;
      comp.trunc = -estMissing + prevEst;
    }
    comp.residual = delta - (comp.dup + comp.ic + comp.sub + comp.broker + comp.trunc);

    // 7. Postorder 同盤更數
    let postorderMatches = false;
    if (ev && site && flagged) {
      const poRows = rowsForSite(ev.priceRows, [site.canonicalName, ...site.aliases]);
      const poTotal = poRows.reduce((a, r) => a + r.totalShift, 0);
      if (poRows.length > 0 && poTotal > 0) {
        const icCount = cur.internalCash.length;
        const tol = Math.max(3, Math.round(poTotal * 0.05));
        if (Math.abs(curCount - poTotal) <= tol || Math.abs(curCount - icCount - poTotal) <= tol) {
          postorderMatches = true;
          parts.push(`Postorder 同盤共 ${poTotal} 更，同本月更表（${curCount} 更${icCount ? `，其中公司兵 ${icCount}` : ""}）一致`);
        } else {
          parts.push(`Postorder 同盤共 ${poTotal} 更，同本月更表（${curCount} 更）唔一致`);
        }
      }
    }

    const unexplained = postorderMatches ? 0 : Math.abs(comp.residual);
    // 截短一律唔當 explained（要人確認檔案係咪齊）；其餘按「剩餘 >20，或 >15% 且 >5」。
    const explained = !truncated && !varianceNeedsHuman(unexplained, prevCount);
    const lead = `「${siteName}」本月 ${curCount} 更 vs 上月 ${prevCount} 更（${delta >= 0 ? "+" : ""}${delta}，${Math.round(pct * 1000) / 10}%）`;
    const tail = unexplained > 0 ? `；拆完仍有約 ${unexplained} 更解釋唔到` : "";
    const sentence = `${lead}：${parts.length ? parts.join("；") : "冇可拆嘅成分"}${tail}`;
    const finding: VarianceFinding = { siteId: u.siteId, siteName, current: curCount, previous: prevCount, external: cur.external.length, internalCash: cur.internalCash.length, deltaPct: Math.round(pct * 10000) / 100, explained, sentence, unexplained, components: comp };
    result.findings.push(finding);
    if (explained) {
      ctx.summary.variancesExplained++;
      ctx.line("variance", `更數差異已解釋：${sentence}`);
    } else {
      ctx.summary.variancesUnexplained++;
      result.legacyFlagged++;
      result.warnings.push(`${sentence}——${truncated ? "檔案可能截短，" : ""}請人手覆核`);
      result.needsHuman.push(sentence);
      addQuestion(u, siteName, truncated ? `檔案可能截短／更數差異（約 ${unexplained} 更）` : `更數差異解釋唔到（約 ${unexplained} 更）`, sentence, unexplained);
    }
  }
  ctx.variance.push(...result.findings);
  return result;
}
