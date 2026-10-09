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
import type { McQuestionDraft } from "./types";

export const VARIANCE_FLAG_PCT = 0.3;
export const VARIANCE_UNEXPLAINED_PCT = 0.15;
export const VARIANCE_UNEXPLAINED_MIN = 20;
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
  const out: Classified = { countable: [], external: [], internalCash: [], duplicates: 0, dates: new Set() };
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
    if (seen.has(key)) out.duplicates++;
    seen.add(key);
    out.countable.push(r);
    if (r.settlementBrokerId !== null && lk.internalCashBrokerIds.has(r.settlementBrokerId)) out.internalCash.push(r);
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

/** 對本月每個已指定盤嘅 active 上載做更數比較同拆解。 */
export async function explainVariances(ctx: AutoCollector, month: Date, uploads: readonly UploadScope[]): Promise<VarianceResult> {
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const lk = await loadVarianceLookups();
  const ev = await ctx.postorder();
  const result: VarianceResult = { findings: [], warnings: [], needsHuman: [], legacyFlagged: 0 };

  for (const u of uploads) {
    const site = await prisma.site.findUnique({ where: { id: u.siteId }, select: { canonicalName: true, aliases: true } });
    const siteName = site?.canonicalName ?? u.siteNameRaw;
    const summary = (u.parseSummary as { shiftCount?: number; warnings?: string[] } | null) ?? null;
    const curRows = (await prisma.rosterUploadRow.findMany({ where: { uploadId: u.id, codeKind: "shift" }, select: ROW_SELECT })) as RowLite[];
    const prevUpload = await prisma.rosterUpload.findFirst({
      where: { month: prevMonth, siteId: u.siteId, status: { notIn: ["superseded", "voided"] } },
      select: { id: true, parseSummary: true },
      orderBy: { uploadedAt: "desc" },
    });
    if (!prevUpload) continue;
    const prevRows = (await prisma.rosterUploadRow.findMany({ where: { uploadId: prevUpload.id, codeKind: "shift" }, select: ROW_SELECT })) as RowLite[];

    // 冇逐格資料（只有 parse_summary）：沿用舊口徑，只能警告，拆唔到。
    if (curRows.length === 0 || prevRows.length === 0) {
      const curCount = summary?.shiftCount ?? 0;
      const prevCount = (prevUpload.parseSummary as { shiftCount?: number } | null)?.shiftCount ?? null;
      if (prevCount && prevCount > 0) {
        const pct = Math.abs(curCount - prevCount) / prevCount;
        if (pct > VARIANCE_FLAG_PCT) {
          result.legacyFlagged++;
          result.warnings.push(`「${u.siteNameRaw}」本月 ${curCount} 格 vs 上月 ${prevCount} 格，相差 ${Math.round(pct * 10000) / 100}%——可能截短／格式異常，請人手覆核（冇逐格資料，拆唔到）`);
        }
      }
      continue;
    }

    const cur = classifyRows(curRows, lk);
    const prev = classifyRows(prevRows, lk);
    const curCount = cur.countable.length;
    const prevCount = prev.countable.length;
    const delta = curCount - prevCount;
    const pct = prevCount > 0 ? Math.abs(delta) / prevCount : curCount > 0 ? 1 : 0;
    const curRaw = curCount + cur.external.length;
    const prevRaw = prevCount + prev.external.length;
    const rawPct = prevRaw > 0 ? Math.abs(curRaw - prevRaw) / prevRaw : curRaw > 0 ? 1 : 0;
    if (pct <= VARIANCE_FLAG_PCT && rawPct <= VARIANCE_FLAG_PCT) continue;

    const parts: string[] = [];
    let residual = delta;

    // 1. 客戶自己人（只影響原始格數，主數已排除）
    if (cur.external.length !== prev.external.length) parts.push(`已排除客戶自己人 ${cur.external.length} 格（上月 ${prev.external.length}）`);
    else if (cur.external.length > 0) parts.push(`已排除客戶自己人 ${cur.external.length} 格`);

    // 2. 重複行
    if (cur.duplicates - prev.duplicates !== 0 || cur.duplicates > 0) {
      const d = cur.duplicates - prev.duplicates;
      residual -= d;
      parts.push(`同人同日同更種重複行 ${cur.duplicates} 更${prev.duplicates ? `（上月 ${prev.duplicates}）` : ""}`);
    }

    // 3. 公司兵
    const icCur = cur.internalCash.length;
    const icPrev = prev.internalCash.length;
    if (icCur !== icPrev) {
      residual -= icCur - icPrev;
      parts.push(`公司兵 ${icCur} 更（上月 ${icPrev}）`);
    }

    // 4. 子盤變化（剩低未被前面解釋嘅格）
    const nonIcCur = cur.countable.filter((r) => !cur.internalCash.includes(r));
    const nonIcPrev = prev.countable.filter((r) => !prev.internalCash.includes(r));
    const subCur = countBy(nonIcCur, (r) => r.resolvedSiteId);
    const subPrev = countBy(nonIcPrev, (r) => r.resolvedSiteId);
    const subDelta = onlyIn(subCur, subPrev) - onlyIn(subPrev, subCur);
    if (subCur.size + subPrev.size > 2 && subDelta !== 0) {
      residual -= subDelta;
      parts.push(`子盤變化 ${subDelta > 0 ? "+" : ""}${subDelta} 更（新增或者消失嘅子盤）`);
    }

    // 5. 雞頭組成（新增／消失嘅雞頭）
    const brokerCur = countBy(nonIcCur, (r) => r.settlementBrokerId);
    const brokerPrev = countBy(nonIcPrev, (r) => r.settlementBrokerId);
    const newBrokers = [...brokerCur.keys()].filter((k) => !brokerPrev.has(k));
    const goneBrokers = [...brokerPrev.keys()].filter((k) => !brokerCur.has(k));
    const brokerDelta = onlyIn(brokerCur, brokerPrev) - onlyIn(brokerPrev, brokerCur);
    if (brokerDelta !== 0 && subDelta === 0) {
      residual -= brokerDelta;
      const code = (id: string) => lk.brokerCodeById.get(id) ?? "?";
      parts.push(`雞頭組成變化：${newBrokers.length ? `新增 ${newBrokers.map(code).join("／")}` : ""}${newBrokers.length && goneBrokers.length ? "、" : ""}${goneBrokers.length ? `消失 ${goneBrokers.map(code).join("／")}` : ""}（${brokerDelta > 0 ? "+" : ""}${brokerDelta} 更）`);
    }

    // 6. 日期覆蓋（截短）
    const { end } = monthRange(month);
    const daysInMonth = end.getUTCDate();
    const coverage = cur.dates.size / daysInMonth;
    const prevCoverage = prev.dates.size / (monthRange(prevMonth).end.getUTCDate());
    const headerWarn = (summary?.warnings ?? []).some((w) => w.startsWith("[分頁跳過]") || w.includes("block 邊界"));
    if (coverage < COVERAGE_TRUNCATED_BELOW || headerWarn) {
      const missing = missingDays(cur.dates, month);
      const est = cur.dates.size > 0 ? Math.round((curCount / cur.dates.size) * (daysInMonth - cur.dates.size)) : 0;
      const prevEst = prevCoverage < COVERAGE_TRUNCATED_BELOW && prev.dates.size > 0 ? Math.round((prevCount / prev.dates.size) * (monthRange(prevMonth).end.getUTCDate() - prev.dates.size)) : 0;
      residual += est - prevEst;
      parts.push(`檔案可能截短：只覆蓋 ${cur.dates.size}／${daysInMonth} 日${missing.length ? `（缺 ${missing.slice(0, 8).map((d) => d.slice(8)).join("、")}${missing.length > 8 ? "…" : ""} 號）` : ""}${headerWarn ? "，表頭偵測有警告" : ""}，按日均推算少約 ${est} 更`);
    }

    // 7. Postorder 同盤更數
    let postorderMatches = false;
    if (ev && site) {
      const poRows = rowsForSite(ev.priceRows, [site.canonicalName, ...site.aliases]);
      const poTotal = poRows.reduce((a, r) => a + r.totalShift, 0);
      if (poRows.length > 0 && poTotal > 0) {
        const tol = Math.max(3, Math.round(poTotal * 0.05));
        if (Math.abs(curCount - poTotal) <= tol || Math.abs(curCount - icCur - poTotal) <= tol) {
          postorderMatches = true;
          parts.push(`Postorder 同盤共 ${poTotal} 更，同本月更表（${curCount} 更${icCur ? `，其中公司兵 ${icCur}` : ""}）一致`);
        } else {
          parts.push(`Postorder 同盤共 ${poTotal} 更，同本月更表（${curCount} 更）唔一致`);
        }
      }
    }

    const unexplained = postorderMatches ? 0 : Math.abs(residual);
    const unexplainedPct = prevCount > 0 ? unexplained / prevCount : unexplained > 0 ? 1 : 0;
    const explained = !(unexplainedPct > VARIANCE_UNEXPLAINED_PCT && unexplained > VARIANCE_UNEXPLAINED_MIN);
    const lead = `「${siteName}」本月 ${curCount} 更 vs 上月 ${prevCount} 更（${delta >= 0 ? "+" : ""}${delta}，${Math.round(pct * 1000) / 10}%）`;
    const tail = unexplained > 0 ? `；拆完仍有約 ${unexplained} 更解釋唔到` : "";
    const sentence = `${lead}：${parts.length ? parts.join("；") : "冇可拆嘅成分"}${tail}`;
    const finding: VarianceFinding = {
      siteId: u.siteId,
      siteName,
      current: curCount,
      previous: prevCount,
      external: cur.external.length,
      internalCash: icCur,
      deltaPct: Math.round(pct * 10000) / 100,
      explained,
      sentence,
      unexplained,
    };
    result.findings.push(finding);
    if (explained) {
      ctx.summary.variancesExplained++;
      ctx.line("variance", `更數差異已解釋：${sentence}`);
    } else {
      ctx.summary.variancesUnexplained++;
      result.legacyFlagged++;
      result.warnings.push(`${sentence}——可能截短／格式異常，請人手覆核`);
      result.needsHuman.push(sentence);
      const draft: McQuestionDraft = {
        kind: "month_close_shift_variance",
        groupKey: `variance:${u.siteId}`,
        sort: 60,
        title: `「${siteName}」更數差異解釋唔到（約 ${unexplained} 更）`,
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
      };
      ctx.addQuestion(draft);
    }
  }
  ctx.variance.push(...result.findings);
  return result;
}
