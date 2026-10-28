// HIST-2：歷史月份（2026-07 前、month_closes.historical=true）一鍵導入。
// 重用一鍵結算現有 step function（唔複製邏輯）：
//   parse_health  → stepParseHealth（自動建缺少嘅盤／子盤／更種／別名；跳過更數異常拆解）
//   guard_fix     → stepGuardFix（plan＋apply；create_minimal 起嘅新人 status=inactive、來源 historical_roster；工號／電話對到現有人就 link）
//   reconcile_apply → stepReconcileApply（runReconcileAllForMonth；歷史月份跳過 reprice 同 Postorder 未套用警告）
//   postorder_compare → 更表 vs Postorder（Roster 分頁）逐盤格數（自己嘅薄層，底層 loadPostorderEvidence／rowsForSite 共用）
//   report        → 逐盤 格數／已寫入／unresolved 原因分類＋建咗幾多盤／更種／人
// 唔跑：長工結算草稿、自動定價、計數、糧、鎖月、健康（歷史月份冇價目卡、唔出糧）。
// 鐵則：steps_json／report_json 只有盤名＋數字，冇姓名／工號／電話。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthRange, monthLabel } from "@/lib/reports/money";
import { monthStart as toMonthStart } from "@/lib/month-lock";
import { withReportContext } from "@/lib/reports/context";
import { writeAudit } from "@/lib/audit";
import { ApiError, Conflict } from "@/lib/api/errors";
import { safeErrorSummary } from "@/lib/api/http";
import { reparseRosterUpload } from "@/lib/roster-upload/service";
import { reconcileUpload, BROKER_CODE_UNMATCHED_TOLERATED } from "@/lib/roster-upload/reconcile";
import { HISTORICAL_ROSTER_SOURCE } from "@/lib/guard-fix/apply";
import { AutoCollector } from "./auto/context";
import { loadPostorderEvidence } from "./auto/postorder-evidence";
import { ONE_CLICK_ADVISORY_LOCK_KEY, HIST_IMPORT_STALE_MS } from "./one-click-lock";
import { stepParseHealth, stepGuardFix, stepReconcileApply, ONE_CLICK_STALE_MS } from "./one-click";
import { StepRunner, jobErrorMessage, type StepRecordOf } from "./step-runner";
import { bucketUnresolvedReason, compareRosterVsPostorder, type PostorderRosterCompare, type UnresolvedBucket } from "./historical-compare";
import { HIST_RULE_CONFIDENCE, S1_NO_TIME_ROW_WARNING, S1_ROW_WARNING, S3_ROW_WARNING, type HistInference, type HistRemaining, type HistReviewHint } from "./hist-inference";
import { normalizeTimeRange, shiftTypeTimeSlot } from "@/lib/roster-upload/time-range";

const HIST_IMPORT_STEP_KEYS = ["precheck", "parse_health", "guard_fix", "reconcile_apply", "postorder_compare", "report"] as const;
type HistImportStepKey = (typeof HIST_IMPORT_STEP_KEYS)[number];
const HIST_IMPORT_STEP_LABELS: Record<HistImportStepKey, string> = {
  precheck: "前置檢查",
  parse_health: "盤／更種建檔",
  guard_fix: "保安員修復",
  reconcile_apply: "全月對數套用",
  postorder_compare: "更表 vs Postorder",
  report: "報告",
};
type HistImportStepRecord = StepRecordOf<HistImportStepKey>;

function emptyHistImportSteps(): HistImportStepRecord[] {
  return HIST_IMPORT_STEP_KEYS.map((key) => ({ key, label: HIST_IMPORT_STEP_LABELS[key], status: "pending", startedAt: null, finishedAt: null, numbers: {}, warnings: [], needsHuman: [] }));
}

interface HistImportCounts {
  sites: number;
  shiftTypes: number;
  guards: number;
  /** 歷史導入建出嚟（created_by 帶 historical_roster）嘅人。 */
  historicalGuards: number;
}

interface HistImportSiteReport {
  siteLabel: string;
  cells: number;
  written: number;
  rosterOnly: number;
  settlementDiff: number;
  guardDiff: number;
  shiftTypeDiff: number;
  /** 真正未入（唔計 crossMonthDuplicate／outOfScope）。 */
  unresolved: number;
  unresolvedByReason: Partial<Record<UnresolvedBucket, number>>;
  /** HIST-5 S4：跨月格已由另一月檔案寫入（純重複，唔算未入）。 */
  crossMonthDuplicate: number;
  /** HIST-5 S4：跨月格目標月份唔係未鎖歷史月份（範圍外，唔算未入）。 */
  outOfScope: number;
  /** 雞頭碼對唔到、歷史模式容忍照寫入（結算雞頭留空，reason=broker_code_unmatched_tolerated）嘅格數。 */
  brokerTolerated: number;
}

export interface HistImportReport {
  month: string;
  /** run 開頭用最新 parser 重新解析嘅上載數。 */
  reparsedUploads: number;
  before: HistImportCounts;
  after: HistImportCounts;
  created: { sites: number; shiftTypes: number; guards: number; siteAliases: number; noTimeShiftTypes: Array<{ site: string; code: string }> };
  totals: { uploads: number; parseFailedUploads: number; cells: number; written: number; rosterOnly: number; settlementDiff: number; guardDiff: number; shiftTypeDiff: number; unresolved: number; unresolvedByReason: Partial<Record<UnresolvedBucket, number>>; crossMonthDuplicate: number; outOfScope: number; brokerTolerated: number };
  perSite: HistImportSiteReport[];
  postorder: ({ uploaded: true; fileName: string } & PostorderRosterCompare) | { uploaded: false };
  /** HIST-5：AI 推斷自動落地嘅決定（規則＋信心＋對象＋依據＋格數），方便抽查。姓名／工號可出，電話／身份證一律唔出。 */
  inferences: HistInference[];
  /** HIST-5：真係判斷唔到、要人決定嘅（連候選＋建議答案）。同 guard_fix step needsHuman 一致。 */
  remaining: HistRemaining[];
  /** HIST-5：抽查提示（唔算待答），例如懷疑 DB 工號登記錯。 */
  reviewHints: HistReviewHint[];
  needsHuman: string[];
}

export function histImportRunStalled(run: { status: string; applyStartedAt: Date | null }, now = new Date()): boolean {
  return run.status === "running" && !!run.applyStartedAt && now.getTime() - run.applyStartedAt.getTime() > HIST_IMPORT_STALE_MS;
}

/** 認領一個新 run（同一鍵結算共用 advisory lock，雙向互斥：一鍵結算 POST／rerun 亦會查未卡死嘅歷史導入 run）：
 * 必須係歷史月份、未鎖、冇另一個未卡死嘅一鍵結算（15 分鐘門檻）／歷史導入（30 分鐘門檻，HIST_IMPORT_STALE_MS）run。 */
export async function claimHistoricalImportRun(month: Date, startedById: string): Promise<string> {
  const m = toMonthStart(month);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - ONE_CLICK_STALE_MS);
  const histStaleBefore = new Date(now.getTime() - HIST_IMPORT_STALE_MS);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
    const mc = await tx.monthClose.findUnique({ where: { month: m }, select: { historical: true, lockedAt: true } });
    if (!mc?.historical) throw new ApiError(409, "not_historical_month", `${m.toISOString().slice(0, 7)} 未標做歷史月份，先用 POST /api/month-closes { historical: true } 標記`);
    if (mc.lockedAt) throw Conflict("呢個月已經鎖定，唔可以再導入");
    const otherOneClick = await tx.monthCloseRun.findFirst({ where: { status: "running", applyStartedAt: { gt: staleBefore } }, select: { id: true } });
    const otherHist = await tx.historicalImportRun.findFirst({ where: { status: "running", applyStartedAt: { gt: histStaleBefore } }, select: { id: true } });
    if (otherOneClick || otherHist) throw Conflict("另一個一鍵結算／歷史導入執行緊，等佢完成先再撳", { status: "busy" });
    const created = await tx.historicalImportRun.create({ data: { month: m, status: "running", startedById, applyStartedAt: now, stepsJson: emptyHistImportSteps() as unknown as Prisma.InputJsonValue } });
    return created.id;
  });
}

async function countState(): Promise<HistImportCounts> {
  const [sites, shiftTypes, guards, historicalGuards] = await Promise.all([
    prisma.site.count(),
    prisma.shiftType.count(),
    prisma.guard.count(),
    prisma.guard.count({ where: { createdBy: { endsWith: `:${HISTORICAL_ROSTER_SOURCE}` } } }),
  ]);
  return { sites, shiftTypes, guards, historicalGuards };
}

/** 歷史導入唔開分診題（題目草稿喺 collector 入面冇落地），step 文字入面「已入分診」呢類講法要改返實話。 */
export function rewriteTriageClaims(lines: string[]): string[] {
  return lines.map((l) => l.replace(/[（(]?已入分診[^）)；。]*[）)]?/g, "（歷史導入唔開分診題，請人手處理）"));
}

type StepFnResult = { numbers: Record<string, unknown>; warnings?: string[]; needsHuman?: string[] };
function cleanTriage(r: StepFnResult): StepFnResult {
  return { ...r, warnings: rewriteTriageClaims(r.warnings ?? []), needsHuman: rewriteTriageClaims(r.needsHuman ?? []) };
}

function newRunner(runId: string): StepRunner<HistImportStepKey, HistImportStepRecord> {
  return new StepRunner<HistImportStepKey, HistImportStepRecord>(emptyHistImportSteps(), (steps, currentStep) =>
    prisma.historicalImportRun.update({ where: { id: runId }, data: { stepsJson: steps as unknown as Prisma.InputJsonValue, currentStep } }).then(() => undefined),
  );
}

async function stepHistPrecheck(month: Date): Promise<StepFnResult & { halt?: string }> {
  const { start } = monthRange(month);
  const numbers: Record<string, unknown> = {};
  const warnings: string[] = [];
  const needsHuman: string[] = [];
  const mc = await prisma.monthClose.findUnique({ where: { month: start }, select: { historical: true, lockedAt: true } });
  if (!mc?.historical) return { numbers, warnings, needsHuman, halt: "呢個月唔係歷史月份，歷史導入已停低（冇寫入任何資料）" };
  if (mc.lockedAt) return { numbers, warnings, needsHuman, halt: "呢個月已鎖定，歷史導入已停低（冇寫入任何資料）" };
  const uploads = await prisma.rosterUpload.groupBy({ by: ["status"], where: { month: start, status: { notIn: ["superseded", "voided"] } }, _count: { _all: true } });
  const byStatus = Object.fromEntries(uploads.map((u) => [u.status, u._count._all]));
  const active = uploads.filter((u) => u.status !== "parse_failed").reduce((a, u) => a + u._count._all, 0);
  numbers.uploadsByStatus = byStatus;
  numbers.activeUploads = active;
  numbers.before = await countState();
  if (active === 0) return { numbers, warnings, needsHuman, halt: `${monthLabel(start)} 冇可用嘅更表上載，歷史導入已停低——先喺更表上載頁選返呢個月份上載` };
  const failed = byStatus["parse_failed"] ?? 0;
  if (failed > 0) needsHuman.push(`${failed} 份上載解析失敗，冇計入——要重新上載正確嘅更表檔`);
  const staffList = await prisma.staffListUpload.findFirst({ where: { status: "parsed" }, select: { id: true } });
  numbers.hasStaffList = !!staffList;
  if (!staffList) warnings.push("未上載 U Team 名單——保安員修復會略過，未配對嘅格會留喺 unresolved");
  const postorder = await prisma.postorderUpload.findFirst({ where: { month: start, status: "parsed" }, select: { id: true } });
  numbers.hasPostorder = !!postorder;
  if (!postorder) warnings.push("本月未上載 Postorder（建議先用 CSV 路徑上載 roster_csv＋postorder_csv，令保安員修復／建盤有更多資料，亦做得更表 vs Postorder 比對）");
  return { numbers, warnings, needsHuman };
}

/** HIST-3：run 開頭先將本月所有未取代／未作廢上載（含 confirmed／parse_failed）用最新 parser 重新解析一次，
 * 唔使人手逐張撳 reparse。`reparseRosterUpload` 保持 upload id／version／status 不變（confirmed 保持 confirmed）。
 * 單張失敗唔擋整個 run（記警告，用舊 rows 繼續）。 */
async function reparseMonthUploadsForHistoricalImport(start: Date): Promise<StepFnResult> {
  const uploads = await prisma.rosterUpload.findMany({ where: { month: start, status: { notIn: ["superseded", "voided"] } }, select: { id: true, siteNameRaw: true, fileName: true }, orderBy: { uploadedAt: "asc" } });
  let reparsed = 0;
  let failed = 0;
  const warnings: string[] = [];
  for (const u of uploads) {
    try {
      await reparseRosterUpload(u.id, { autoResolveSite: true, txTimeoutMs: 10 * 60 * 1000 });
      reparsed++;
    } catch (e) {
      failed++;
      warnings.push(`上載「${u.siteNameRaw}」開頭重新解析失敗（${safeErrorSummary(e)}），沿用舊解析結果`);
    }
  }
  return { numbers: { reparsedUploads: reparsed, reparseFailedUploads: failed }, warnings };
}

export function runHistoricalImport(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  return withReportContext(() => runHistoricalImportInner(runId, month, actorUserId, ip));
}

async function runHistoricalImportInner(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  const start = toMonthStart(month);
  const runner = newRunner(runId);
  const auto = new AutoCollector(null, start, actorUserId, ip, `auto:historical-import:${runId}`);
  auto.historical = true;
  try {
    let halt: string | undefined;
    await runner.run("precheck", async () => {
      const r = await stepHistPrecheck(start);
      halt = r.halt;
      return r;
    });
    if (halt) {
      runner.skipRest("parse_health", halt);
      await runner.flush(null);
      await prisma.historicalImportRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: halt } });
      return;
    }
    await runner.run("parse_health", async () => {
      const rp = await reparseMonthUploadsForHistoricalImport(start);
      const ph = cleanTriage(await stepParseHealth(start, actorUserId, auto, { historical: true }));
      return { numbers: { ...rp.numbers, ...ph.numbers }, warnings: [...(rp.warnings ?? []), ...(ph.warnings ?? [])], needsHuman: ph.needsHuman };
    });
    await runner.run("guard_fix", async () => cleanTriage(await stepGuardFix(start, actorUserId, auto, { historical: true })));
    await runner.run("reconcile_apply", async () => cleanTriage(await stepReconcileApply(start, actorUserId, ip)));
    await runner.run("postorder_compare", () => stepHistPostorderCompare(start));
    const reportStep = await runner.run("report", async () => {
      const report = await buildHistImportReport(start, runner);
      return { numbers: report as unknown as Record<string, unknown> };
    });
    await prisma.historicalImportRun.update({ where: { id: runId }, data: { status: "done", finishedAt: new Date(), reportJson: reportStep.numbers as unknown as Prisma.InputJsonValue } });
    await writeAudit({ actorUserId, tableName: "historical_import_runs", rowId: runId, action: "update", after: { id: runId, status: "done" }, ip: null });
  } catch (e) {
    const message = jobErrorMessage(e);
    console.error("[historical-import] 執行失敗：", message);
    try {
      await prisma.historicalImportRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: message } });
      await writeAudit({ actorUserId, tableName: "historical_import_runs", rowId: runId, action: "update", after: { id: runId, status: "failed" }, ip: null });
    } catch (e2) {
      console.error("[historical-import] 標記 failed 都失敗：", safeErrorSummary(e2));
    }
  }
}

/** 本月 active 上載（唔計 superseded／voided／parse_failed）對應嘅盤標籤同 shift+ot 格數，俾 Postorder 比對用。 */
async function loadUploadSiteCells(start: Date) {
  const uploads = await prisma.rosterUpload.findMany({
    where: { month: start, status: { in: ["parsed", "confirmed"] } },
    select: { id: true, siteNameRaw: true, site: { select: { canonicalName: true, aliases: true } } },
    orderBy: { siteNameRaw: "asc" },
  });
  const counts = uploads.length
    ? await prisma.rosterUploadRow.groupBy({ by: ["uploadId"], where: { uploadId: { in: uploads.map((u) => u.id) }, codeKind: { in: ["shift", "ot"] } }, _count: { _all: true } })
    : [];
  const byUpload = new Map(counts.map((c) => [c.uploadId, c._count._all]));
  return uploads.map((u) => ({
    uploadId: u.id,
    label: u.site?.canonicalName ?? u.siteNameRaw,
    names: [...new Set([u.site?.canonicalName, ...(u.site?.aliases ?? []), u.siteNameRaw].filter((x): x is string => !!x && !!x.trim()))],
    cells: byUpload.get(u.id) ?? 0,
  }));
}

async function stepHistPostorderCompare(start: Date): Promise<StepFnResult> {
  const upload = await prisma.postorderUpload.findFirst({ where: { month: start, status: "parsed" }, orderBy: { uploadedAt: "desc" } });
  if (!upload) return { numbers: { uploaded: false }, warnings: ["本月冇 Postorder 上載，略過更表 vs Postorder 比對"] };
  let ev;
  try {
    ev = await loadPostorderEvidence(upload, start);
  } catch (e) {
    return { numbers: { uploaded: true, fileName: upload.fileName, readable: false }, warnings: [`Postorder 讀唔到，略過比對（${safeErrorSummary(e)}）`] };
  }
  if (!ev.hasRoster || !(ev.rosterRows ?? []).length) {
    return { numbers: { uploaded: true, fileName: upload.fileName, readable: true, hasRoster: false }, warnings: ["Postorder 冇 Roster 分頁資料（只上載咗 PostOrder／長工組合 CSV？），略過更表 vs Postorder 比對——要 roster_csv＋postorder_csv 一齊上載"] };
  }
  const sites = await loadUploadSiteCells(start);
  const cmp = compareRosterVsPostorder(sites, ev.rosterRows ?? []);
  return {
    numbers: { uploaded: true, fileName: upload.fileName, readable: true, hasRoster: true, compare: cmp },
    warnings: cmp.totals.unmatchedSites > 0 ? [`${cmp.totals.unmatchedSites} 個盤喺 Postorder 對唔到崗位行（見報告逐盤表）`] : [],
  };
}

function addBuckets(into: Partial<Record<UnresolvedBucket, number>>, from: Partial<Record<UnresolvedBucket, number>>): void {
  for (const [k, v] of Object.entries(from) as Array<[UnresolvedBucket, number]>) into[k] = (into[k] ?? 0) + v;
}

async function buildHistImportReport(start: Date, runner: StepRunner<HistImportStepKey, HistImportStepRecord>): Promise<HistImportReport> {
  const before = (runner.get("precheck").numbers.before as HistImportCounts | undefined) ?? { sites: 0, shiftTypes: 0, guards: 0, historicalGuards: 0 };
  const after = await countState();
  const uploads = await prisma.rosterUpload.findMany({
    where: { month: start, status: { in: ["parsed", "confirmed"] } },
    select: { id: true, siteNameRaw: true, site: { select: { canonicalName: true } } },
    orderBy: { siteNameRaw: "asc" },
  });
  const cellRows = uploads.length
    ? await prisma.rosterUploadRow.groupBy({ by: ["uploadId"], where: { uploadId: { in: uploads.map((u) => u.id) }, codeKind: { in: ["shift", "ot", "leave"] } }, _count: { _all: true } })
    : [];
  const cellsByUpload = new Map(cellRows.map((c) => [c.uploadId, c._count._all]));

  const perSite: HistImportSiteReport[] = [];
  const totals: HistImportReport["totals"] = {
    uploads: uploads.length,
    parseFailedUploads: Number(((runner.get("precheck").numbers.uploadsByStatus as Record<string, number> | undefined) ?? {})["parse_failed"] ?? 0),
    cells: 0,
    written: 0,
    rosterOnly: 0,
    settlementDiff: 0,
    guardDiff: 0,
    shiftTypeDiff: 0,
    unresolved: 0,
    unresolvedByReason: {},
    crossMonthDuplicate: 0,
    outOfScope: 0,
    brokerTolerated: 0,
  };
  for (const u of uploads) {
    const { items, summary } = await reconcileUpload(u.id);
    const byReason: Partial<Record<UnresolvedBucket, number>> = {};
    let crossMonthDuplicate = 0;
    let outOfScope = 0;
    let unresolvedCount = 0;
    for (const it of items) {
      if (it.category !== "unresolved") continue;
      const buckets = bucketUnresolvedReason(it.unresolvedReason ?? "");
      // HIST-5 S4：跨月重複／範圍外唔算「未入」（只要冇其他未入原因）。
      const genuine = buckets.filter((b) => b !== "cross_month_duplicate" && b !== "out_of_scope");
      if (genuine.length === 0) {
        if (buckets.includes("cross_month_duplicate")) crossMonthDuplicate++;
        else outOfScope++;
        continue;
      }
      unresolvedCount++;
      for (const b of genuine) byReason[b] = (byReason[b] ?? 0) + 1;
    }
    const row: HistImportSiteReport = {
      siteLabel: u.site?.canonicalName ?? u.siteNameRaw,
      cells: cellsByUpload.get(u.id) ?? 0,
      written: summary.byCategory.match,
      rosterOnly: summary.byCategory.roster_only,
      settlementDiff: summary.byCategory.settlement_diff,
      guardDiff: summary.byCategory.guard_diff,
      shiftTypeDiff: summary.byCategory.shift_type_diff,
      unresolved: unresolvedCount,
      unresolvedByReason: byReason,
      crossMonthDuplicate,
      outOfScope,
      brokerTolerated: items.filter((it) => it.roster?.settlementReason === BROKER_CODE_UNMATCHED_TOLERATED).length,
    };
    perSite.push(row);
    totals.cells += row.cells;
    totals.written += row.written;
    totals.rosterOnly += row.rosterOnly;
    totals.settlementDiff += row.settlementDiff;
    totals.guardDiff += row.guardDiff;
    totals.shiftTypeDiff += row.shiftTypeDiff;
    totals.unresolved += row.unresolved;
    totals.crossMonthDuplicate += row.crossMonthDuplicate;
    totals.outOfScope += row.outOfScope;
    totals.brokerTolerated += row.brokerTolerated;
    addBuckets(totals.unresolvedByReason, byReason);
  }

  const pn = runner.get("postorder_compare").numbers;
  const postorder: HistImportReport["postorder"] =
    pn.uploaded === true && pn.hasRoster === true && pn.compare ? { uploaded: true, fileName: String(pn.fileName ?? ""), ...(pn.compare as PostorderRosterCompare) } : { uploaded: false };

  const pf = runner.get("parse_health").numbers;
  const gf = runner.get("guard_fix").numbers;
  return {
    month: monthLabel(start),
    reparsedUploads: Number(pf.reparsedUploads ?? 0),
    before,
    after,
    created: {
      sites: Number(pf.autoBuiltSites ?? 0),
      shiftTypes: Number(pf.shiftTypesCreated ?? 0),
      guards: after.historicalGuards - before.historicalGuards,
      siteAliases: Number(pf.sitesAliased ?? 0),
      // 時段欄唔係時間而建嘅冇開始時間更種（以代號為鍵）——時段未知，只計出勤。
      noTimeShiftTypes: (pf.noTimeShiftTypes as Array<{ site: string; code: string }> | undefined) ?? [],
    },
    totals,
    perSite,
    postorder,
    inferences: [...((gf.inferences as HistInference[] | undefined) ?? []), ...(await deriveStageInferences(start, uploads.map((u) => u.id)))],
    remaining: (gf.remaining as HistRemaining[] | undefined) ?? [],
    reviewHints: (gf.reviewHints as HistReviewHint[] | undefined) ?? [],
    needsHuman: runner.allNeedsHuman(),
  };
}


const S_MARKERS = [S1_ROW_WARNING, S1_NO_TIME_ROW_WARNING, S3_ROW_WARNING];

/** HIST-5 S1／S2／S3／S4 推斷——由 DB 狀態反推（rows.warnings 記號、auto 建更種 audit、跨月寫入嘅 provenance），
 * 唔靠 run 內存，所以重跑導入（冪等、冇新建嘢）報告都仲見到呢月嘅推斷。報告只有盤名＋代號＋時段＋格數。 */
async function deriveStageInferences(start: Date, uploadIds: string[]): Promise<HistInference[]> {
  if (uploadIds.length === 0) return [];
  const out: HistInference[] = [];
  const siteRows = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteName = new Map(siteRows.map((x) => [x.id, x.canonicalName]));

  // ---- S1／S1n／S3：rows.warnings 記號 ----
  const marked = await prisma.rosterUploadRow.findMany({
    where: { uploadId: { in: uploadIds }, codeKind: "shift", OR: S_MARKERS.map((m) => ({ warnings: { array_contains: [m] } })) },
    select: { rawCode: true, timeRaw: true, warnings: true, shiftTypeId: true, resolvedSiteId: true },
  });
  const typeIds = [...new Set(marked.map((r) => r.shiftTypeId).filter((x): x is string => !!x))];
  const types = typeIds.length ? await prisma.shiftType.findMany({ where: { id: { in: typeIds } }, select: { id: true, code: true, startTime: true, endTime: true } }) : [];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const groups = new Map<string, { rule: "S1" | "S1n" | "S3"; site: string; code: string; slot: string | null; matched: string | null; cells: number }>();
  for (const r of marked) {
    const warns = Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
    const rule = warns.includes(S3_ROW_WARNING) ? "S3" : warns.includes(S1_NO_TIME_ROW_WARNING) ? "S1n" : "S1";
    const site = (r.resolvedSiteId && siteName.get(r.resolvedSiteId)) || "（盤名未定）";
    const slot = normalizeTimeRange(r.timeRaw);
    const st = r.shiftTypeId ? typeById.get(r.shiftTypeId) : undefined;
    const matched = st ? `${st.code}${shiftTypeTimeSlot(st.startTime, st.endTime) ? `（${shiftTypeTimeSlot(st.startTime, st.endTime)}）` : "（冇開始時間）"}` : null;
    const key = `${rule}|${site}|${r.rawCode.trim()}|${slot ?? ""}|${matched ?? ""}`;
    const g = groups.get(key) ?? { rule, site, code: r.rawCode.trim(), slot, matched, cells: 0 };
    g.cells++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const base = { confidence: HIST_RULE_CONFIDENCE[g.rule], subject: { site: g.site, code: g.code, ...(g.slot ? { timeSlot: g.slot } : {}) }, cells: g.cells };
    if (g.rule === "S3") {
      out.push({ ...base, rule: "S3", decision: `代號「${g.code}」係另一個盤嘅名／別名 → 寫落「${g.site}」，${g.matched ? `配／建更種「${g.matched}」` : "未能配到更種"}`, evidence: [`代號「${g.code}」等於盤「${g.site}」嘅名稱或別名（跨盤標記）`, g.slot ? `該行時段 ${g.slot}` : "該行時段解析唔到，只計出勤"] });
    } else if (g.rule === "S1n") {
      out.push({ ...base, rule: "S1n", decision: `單字母代號「${g.code}」按「呢行自己嘅更」計出勤，更種「${g.matched ?? "未建"}」（冇開始時間）`, evidence: ["單字母代號（A–Z）喺對照表冇定義", "該行時段欄解析唔到時間"] });
    } else {
      out.push({ ...base, rule: "S1", decision: `單字母代號「${g.code}」按該行時段 ${g.slot} 當出更，配到更種「${g.matched ?? "未建"}」`, evidence: ["單字母代號（A–Z）喺對照表冇定義", `該行時段欄 ${g.slot}；該盤${g.matched?.startsWith(`${g.code}（`) ? "自動建同代號更種" : "已有同時段更種（任何 code）就沿用"}`] });
    }
  }

  // ---- S2：歷史導入自動建嘅更種（audit auto_source）——扣走 S1／S3 記號行 ----
  const created = await prisma.auditLog.findMany({
    where: { tableName: "shift_types", action: "create", after: { path: ["auto_source"], string_starts_with: "auto:historical-import:" } },
    select: { rowId: true },
  });
  const createdIds = [...new Set(created.map((c) => c.rowId))];
  if (createdIds.length > 0) {
    const rows = await prisma.rosterUploadRow.findMany({
      where: { uploadId: { in: uploadIds }, shiftTypeId: { in: createdIds } },
      select: { shiftTypeId: true, warnings: true, codeKind: true },
    });
    const cellsByType = new Map<string, number>();
    for (const r of rows) {
      const warns = Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
      if (warns.some((w) => S_MARKERS.includes(w))) continue;
      cellsByType.set(r.shiftTypeId!, (cellsByType.get(r.shiftTypeId!) ?? 0) + 1);
    }
    const st2 = await prisma.shiftType.findMany({ where: { id: { in: [...cellsByType.keys()] } }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, hours: true } });
    for (const t of st2) {
      const slot = shiftTypeTimeSlot(t.startTime, t.endTime);
      const isOt = /^OT\d/i.test(t.code);
      out.push({
        rule: "S2",
        confidence: HIST_RULE_CONFIDENCE.S2,
        subject: { site: siteName.get(t.siteId) ?? "（盤名未定）", code: t.code, ...(slot ? { timeSlot: slot } : {}) },
        decision: `自動建更種「${t.code}」${slot ? `（${slot}）` : isOt ? `（OT ${t.hours === null ? "—" : Number(t.hours)} 小時）` : "（冇開始時間，只計出勤）"}`,
        evidence: ["更表代號喺該盤冇對應更種（冇同 code，或者同 code 但時段唔同）", slot ? `由更表該行時段 ${slot} 取開始／收工時間` : isOt ? "OT 小時由代號數字取" : "時段欄唔係時間，建冇開始時間更種"],
        cells: cellsByType.get(t.id) ?? 0,
      });
    }
  }

  // ---- S4：跨月格直接寫入目標歷史月份（source=roster_upload，provenance.upload_id 屬今月上載，workDate 唔喺今月）----
  const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const crossWritten: Array<{ siteId: string; workDate: Date }> = [];
  for (const uid of uploadIds) {
    const recs = await prisma.shiftRecord.findMany({
      where: { source: "roster_upload", provenance: { path: ["upload_id"], equals: uid }, OR: [{ workDate: { lt: start } }, { workDate: { gte: monthEnd } }] },
      select: { siteId: true, workDate: true },
    });
    crossWritten.push(...recs);
  }
  const s4 = new Map<string, number>();
  for (const r of crossWritten) {
    const key = `${siteName.get(r.siteId) ?? "（盤名未定）"}|${r.workDate.toISOString().slice(0, 7)}`;
    s4.set(key, (s4.get(key) ?? 0) + 1);
  }
  for (const [key, cells] of s4) {
    const [site, target] = key.split("|") as [string, string];
    out.push({
      rule: "S4",
      confidence: HIST_RULE_CONFIDENCE.S4,
      subject: { site },
      decision: `跨月格直接寫入 ${target}（歷史月份、未鎖，該 (保安員,日期,盤) 原本冇更次）`,
      evidence: [`格仔日期屬 ${target}，唔係上載月份 ${start.toISOString().slice(0, 7)}`, `${target} 係未鎖歷史月份，冇既有更次 → 同一 upsert 路徑寫入`],
      cells,
    });
  }
  return out;
}
