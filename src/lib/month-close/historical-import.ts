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
import { reconcileUpload } from "@/lib/roster-upload/reconcile";
import { HISTORICAL_ROSTER_SOURCE } from "@/lib/guard-fix/apply";
import { AutoCollector } from "./auto/context";
import { loadPostorderEvidence } from "./auto/postorder-evidence";
import { ONE_CLICK_ADVISORY_LOCK_KEY, HIST_IMPORT_STALE_MS } from "./one-click-lock";
import { stepParseHealth, stepGuardFix, stepReconcileApply, ONE_CLICK_STALE_MS } from "./one-click";
import { StepRunner, jobErrorMessage, type StepRecordOf } from "./step-runner";
import { bucketUnresolvedReason, compareRosterVsPostorder, type PostorderRosterCompare, type UnresolvedBucket } from "./historical-compare";

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
  unresolved: number;
  unresolvedByReason: Partial<Record<UnresolvedBucket, number>>;
}

export interface HistImportReport {
  month: string;
  before: HistImportCounts;
  after: HistImportCounts;
  created: { sites: number; shiftTypes: number; guards: number; siteAliases: number };
  totals: { uploads: number; parseFailedUploads: number; cells: number; written: number; rosterOnly: number; settlementDiff: number; guardDiff: number; shiftTypeDiff: number; unresolved: number; unresolvedByReason: Partial<Record<UnresolvedBucket, number>> };
  perSite: HistImportSiteReport[];
  postorder: ({ uploaded: true; fileName: string } & PostorderRosterCompare) | { uploaded: false };
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

export function runHistoricalImport(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  return withReportContext(() => runHistoricalImportInner(runId, month, actorUserId, ip));
}

async function runHistoricalImportInner(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  const start = toMonthStart(month);
  const runner = newRunner(runId);
  const auto = new AutoCollector(null, start, actorUserId, ip, `auto:historical-import:${runId}`);
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
    await runner.run("parse_health", async () => cleanTriage(await stepParseHealth(start, actorUserId, auto, { historical: true })));
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
  };
  for (const u of uploads) {
    const { items, summary } = await reconcileUpload(u.id);
    const byReason: Partial<Record<UnresolvedBucket, number>> = {};
    for (const it of items) {
      if (it.category !== "unresolved") continue;
      for (const b of bucketUnresolvedReason(it.unresolvedReason ?? "")) byReason[b] = (byReason[b] ?? 0) + 1;
    }
    const row: HistImportSiteReport = {
      siteLabel: u.site?.canonicalName ?? u.siteNameRaw,
      cells: cellsByUpload.get(u.id) ?? 0,
      written: summary.byCategory.match,
      rosterOnly: summary.byCategory.roster_only,
      settlementDiff: summary.byCategory.settlement_diff,
      guardDiff: summary.byCategory.guard_diff,
      shiftTypeDiff: summary.byCategory.shift_type_diff,
      unresolved: summary.byCategory.unresolved,
      unresolvedByReason: byReason,
    };
    perSite.push(row);
    totals.cells += row.cells;
    totals.written += row.written;
    totals.rosterOnly += row.rosterOnly;
    totals.settlementDiff += row.settlementDiff;
    totals.guardDiff += row.guardDiff;
    totals.shiftTypeDiff += row.shiftTypeDiff;
    totals.unresolved += row.unresolved;
    addBuckets(totals.unresolvedByReason, byReason);
  }

  const pn = runner.get("postorder_compare").numbers;
  const postorder: HistImportReport["postorder"] =
    pn.uploaded === true && pn.hasRoster === true && pn.compare ? { uploaded: true, fileName: String(pn.fileName ?? ""), ...(pn.compare as PostorderRosterCompare) } : { uploaded: false };

  const pf = runner.get("parse_health").numbers;
  return {
    month: monthLabel(start),
    before,
    after,
    created: {
      sites: Number(pf.autoBuiltSites ?? 0),
      shiftTypes: Number(pf.shiftTypesCreated ?? 0),
      guards: after.historicalGuards - before.historicalGuards,
      siteAliases: Number(pf.sitesAliased ?? 0),
    },
    totals,
    perSite,
    postorder,
    needsHuman: runner.allNeedsHuman(),
  };
}

