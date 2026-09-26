// WP-LTSHIFT §19 交付 C：「重新對數全月」一鍵——`POST /api/roster-
// uploads/reconcile-all { month }`。順序處理呢個月全部 active（parsed／
// confirmed）上載：
//   1. `recomputeSettlement(uploadId)`——長工格 settlement／operational
//      重新跟返最新 `guard_longterm_posts`／`referral_broker_id`／
//      `visa_sponsored_by_broker_id`（唔換 row id，confirmed 上載都做）。
//   2. `reconcileUpload(uploadId)`——攞返呢張上載成份 roster_only／
//      settlement_diff／unresolved 等分類（記憶體一次攞晒，冇分頁缺口）。
//   3. `roster_only`＋`settlement_diff` 兩類全部用 `apply_roster` 套用
//      （每上載一個 transaction，`applyReconcileDecisions()` 內部已經有
//      SAVEPOINT 逐項——一項失敗唔影響其他項），每批 ≤2000（schema
//      `RosterReconcileApplySchema` 上限）。
//   4. 逐盤／全月 before/after 數目收埋做 `reconcile_all_runs.result_
//      json`（純數目＋盤名，冇 PII）。
//
// 同 `guard-fix/apply.ts` 一致嘅背景工作／advisory lock／卡死復原
// 設計（15 分鐘，`RECONCILE_ALL_STALE_MS`）——見 `src/app/api/roster-
// uploads/reconcile-all/route.ts`。
import { prisma } from "@/lib/db";
import { assertMonthNotLocked, monthStart as toMonthStart } from "@/lib/month-lock";
import { reconcileUpload } from "./reconcile";
import { applyReconcileDecisions } from "./reconcile-apply";
import { recomputeSettlement } from "./settlement-resync";
import { hasParsedPostorderForMonth } from "@/lib/pricing/longterm-settlement";
import { repriceMonthForSites } from "@/lib/pricing/reprice";

/** 同 guard-fix 嗰個 key（7_710_250_925）刻意用另一個數字，兩個 lock
 * 唔會互相排隊（reconcile-all 淨係改 shift_records／guard_longterm_
 * posts，guard-fix apply 淨係改 guards／guard_staff_numbers，冇資源
 * 重疊，冇需要共用一把鎖）。 */
export const RECONCILE_ALL_ADVISORY_LOCK_KEY = 7_710_260_926;
export const RECONCILE_ALL_STALE_MS = 15 * 60 * 1000;

export function reconcileAllApplyAllowed(run: { status: string; startedAt: Date }, now = new Date()): boolean {
  if (run.status !== "running") return true; // done／failed 隨時可以再跑
  return now.getTime() - run.startedAt.getTime() > RECONCILE_ALL_STALE_MS; // running 但過咗 15 分鐘＝卡死
}

const APPLY_BATCH_SIZE = 2000; // 同 RosterReconcileApplySchema 上限一致

export interface ReconcileAllPerUploadResult {
  uploadId: string;
  siteLabel: string;
  before: { rosterOnly: number; settlementDiff: number; unresolved: number };
  settlementScanned: number;
  settlementChanged: number;
  applied: number;
  skippedApplyReason: string | null;
  errors: string[];
}

export interface ReconcileAllResult {
  month: string;
  /** 驗收（Opus 5.5）：非阻擋性提示（例如 Postorder 上載咗但未套用安員配對修復）。 */
  warnings: string[];
  uploadCount: number;
  /** 驗收修正（任務 3）：開頭自動 reprice 嘅結果（淨係補 null／修 B07
   * 舊價，唔覆蓋人手價，見 `src/lib/pricing/reprice.ts`）——之前呢步要
   * 老闆喺更表頁自己撳「重新計价」，而家「重新對數全月」自動做埋。 */
  repriced: { scanned: number; changed: number };
  perUpload: ReconcileAllPerUploadResult[];
  totals: {
    rosterOnlyBefore: number;
    settlementDiffBefore: number;
    unresolvedBefore: number;
    settlementChanged: number;
    applied: number;
    uploadsWithErrors: number;
  };
}

/** 核心邏輯，一個月一次。冪等：重跑一次淨係處理仲有嘅 roster_only／
 * settlement_diff（已套用嘅上次已經變咗 match，唔會再計一次）。 */
export async function runReconcileAllForMonth(month: Date, actorUserId: string, ip: string | null): Promise<ReconcileAllResult> {
  const monthStartDate = toMonthStart(month);
  // 鎖定月份唔准動——同 apply_roster 單張上載一致嘅閘，喺呢度做一次
  // 早期檢查，唔使逐張上載先撞到先知。
  await assertMonthNotLocked({ workDate: monthStartDate, actorUserId, tableName: "roster_uploads", rowId: "reconcile-all", ip });

  // 驗收（Opus 5.5）：Postorder 上載咗但未套用引用佢嘅安員配對修復計劃——
  // 長工崗位盤未跟總表更新（仍然用舊崗位／占比推算），提示先套用再重跑。
  const warnings: string[] = [];
  const latestPostorder = await prisma.postorderUpload.findFirst({ where: { month: monthStartDate, status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { id: true } });
  if (latestPostorder && !(await hasParsedPostorderForMonth(monthStartDate))) {
    warnings.push("本月最新 Postorder 已上載但未套用安員配對修復計劃——長工崗位未跟總表更新（暫時沿用舊崗位／占比推算）；請先喺「安員配對修復」計劃＋套用，再重新對數全月");
  }

  const uploads = await prisma.rosterUpload.findMany({
    where: { month: monthStartDate, status: { in: ["parsed", "confirmed"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
    orderBy: { siteNameRaw: "asc" },
  });
  const siteIds = uploads.map((u) => u.siteId).filter((x): x is string => !!x);
  const sites = siteIds.length ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }) : [];

  // 驗收修正（任務 3）：對數／套用之前，先幫呢個月有上載嘅盤 reprice
  // 一次（補 null／修 B07 舊價，唔覆蓋人手價）——之前要老闆喺更表頁自己
  // 撳一次「重新計价」（見 docs/api.md「WP-LTSHIFT 驗收修正」正式站
  // 步驟 3），而家「重新對數全月」呢一鍵自動做埋，正式站唔使再撳嗰個掣。
  const repriced = await repriceMonthForSites(monthStartDate, siteIds, actorUserId, ip);
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));

  const perUpload: ReconcileAllPerUploadResult[] = [];
  const totals = { rosterOnlyBefore: 0, settlementDiffBefore: 0, unresolvedBefore: 0, settlementChanged: 0, applied: 0, uploadsWithErrors: 0 };

  for (const u of uploads) {
    const siteLabel = (u.siteId && siteNameById.get(u.siteId)) || u.siteNameRaw || "（盤名未定）";
    const errors: string[] = [];
    let settlementScanned = 0;
    let settlementChanged = 0;
    try {
      const rs = await recomputeSettlement(u.id, actorUserId);
      settlementScanned = rs.longtermScanned;
      settlementChanged = rs.changed;
    } catch (e) {
      errors.push(`重算結算單位失敗：${e instanceof Error ? e.message : String(e)}`);
    }

    let before = { rosterOnly: 0, settlementDiff: 0, unresolved: 0 };
    let applied = 0;
    let skippedApplyReason: string | null = null;
    try {
      const { items } = await reconcileUpload(u.id);
      before = {
        rosterOnly: items.filter((i) => i.category === "roster_only").length,
        settlementDiff: items.filter((i) => i.category === "settlement_diff").length,
        unresolved: items.filter((i) => i.category === "unresolved").length,
      };
      if (!u.siteId) {
        skippedApplyReason = "上載未指定盤，未套用（roster_only/settlement_diff 留低俾人手喺對數頁指定盤之後再處理）";
      } else {
        const keys = items.filter((i) => i.category === "roster_only" || i.category === "settlement_diff").map((i) => i.key);
        for (let i = 0; i < keys.length; i += APPLY_BATCH_SIZE) {
          const batchKeys = keys.slice(i, i + APPLY_BATCH_SIZE);
          const actions = batchKeys.map((key) => ({ key, action: "apply_roster" as const, reason: "WP-LTSHIFT §19「重新對數全月」：全部以更表為準" }));
          const res = await applyReconcileDecisions({ uploadId: u.id, actions, actorUserId, ip });
          for (const r of res.results) {
            if (r.ok) applied += 1;
            else errors.push(`${r.key}：${r.error ?? "套用失敗"}`);
          }
        }
      }
    } catch (e) {
      errors.push(`對數／套用失敗：${e instanceof Error ? e.message : String(e)}`);
    }

    totals.rosterOnlyBefore += before.rosterOnly;
    totals.settlementDiffBefore += before.settlementDiff;
    totals.unresolvedBefore += before.unresolved;
    totals.settlementChanged += settlementChanged;
    totals.applied += applied;
    if (errors.length > 0) totals.uploadsWithErrors += 1;

    perUpload.push({ uploadId: u.id, siteLabel, before, settlementScanned, settlementChanged, applied, skippedApplyReason, errors });
  }

  return { month: monthStartDate.toISOString().slice(0, 10), warnings, uploadCount: uploads.length, repriced, perUpload, totals };
}
