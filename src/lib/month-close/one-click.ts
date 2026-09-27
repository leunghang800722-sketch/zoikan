// WP-ONE-CLICK Phase 1（老闆 2026-09-26「只要上載更表，按一鍵計算就幫我
// 解決晒所有問題，準確計算出當月所有糧及總報表」，§20）：
// `runOneClickMonthClose()`——單一 job，順序串連現有 lib（唔重寫已有
// 邏輯），每步寫 `month_close_runs.steps_json`，可重跑、冪等。
//
// 鐵則（任務書）：呢個 job 只係「串起」現有函數：
//   step0 前置檢查（新——冇現成 lib，見底下 `stepPrecheck()` 嘅價卡沿用邏輯）
//   step1 解析健康（複用 roster_uploads.parse_summary，新增格數差警告／
//         自動建盤）
//   step2 安員修復——`buildGuardFixPlan()`／`applyGuardFixPlan()`／
//         `reparseAllActiveUploads()`（`src/lib/guard-fix/*`）
//   step3 長工結算——`recomputeSettlement()`（`src/lib/roster-upload/
//         settlement-resync.ts`）
//   step4 全月對數＋套用——`runReconcileAllForMonth()`（`src/lib/roster-
//         upload/reconcile-all.ts`，已經含 reprice）
//   step5 定價檢查——`buildUnpricedSummary()`（`src/lib/pricing/
//         unpriced.ts`）
//   step6 計數——`recomputeReferralFees()`／`buildMonthlyClose()`／
//         `buildGrossMargin()`／`buildPayrollTotals()`／
//         `buildPayrollSourceSummary()`
//   step7 對照（可選）——Postorder 已解析嘅 `referralRows[].excelAmount`
//         同系統介紹費對比；逐雞頭付款總表冇現成解析器，一律寫「總表
//         冇提供」（唔准估）
//   step8 報告——匯總 report_json＋needs_human＋鎖月前置
//         （`checkRosterUploadCoverage()`）
//
// 背景工作／advisory lock／15 分鐘卡死復原 pattern 同 `guard-fix/apply.ts`
// ／`roster-upload/reconcile-all.ts` 一致，見
// `src/app/api/month-close/one-click/route.ts`。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthRange, monthLabel, n, round2 } from "@/lib/reports/money";
import { monthStart as toMonthStart } from "@/lib/month-lock";
import { checkRosterUploadCoverage } from "@/lib/roster-upload/lock-precondition";
import { recomputeSettlement } from "@/lib/roster-upload/settlement-resync";
import { runReconcileAllForMonth } from "@/lib/roster-upload/reconcile-all";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan, reparseAllActiveUploads } from "@/lib/guard-fix/apply";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import { parsePostorderUploadRow } from "@/lib/guard-fix/postorder";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals, buildPayrollSourceSummary } from "@/lib/reports/payroll";
import { computeReferralFeesForMonth, recomputeReferralFees, REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH } from "@/lib/reports/referral-fee";
import { writeAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { STEP_KEYS, STEP_LABELS, emptySteps, type StepKey, type StepRecord, type MonthCloseReport } from "./types";

export const ONE_CLICK_ADVISORY_LOCK_KEY = 7_710_270_927; // 自己一個 key，唔同 guard-fix(...925)／reconcile-all(...926)
export const ONE_CLICK_STALE_MS = 15 * 60 * 1000;

export function monthCloseRunStalled(run: { status: string; applyStartedAt: Date | null }, now = new Date()): boolean {
  if (run.status !== "running") return false;
  if (!run.applyStartedAt) return false; // 未認領（理論上唔會發生，claim 同 create 同一個 transaction）
  return now.getTime() - run.applyStartedAt.getTime() > ONE_CLICK_STALE_MS;
}

/** 呢個 run 可唔可以（再）執行——`done` 唔可以（要開新 run）；`failed`
 * 可以重試；`running` 淨係卡死（見 `monthCloseRunStalled()`）先可以。 */
export function monthCloseRunRerunAllowed(run: { status: string; applyStartedAt: Date | null }, now = new Date()): boolean {
  if (run.status === "failed") return true;
  if (run.status === "running") return monthCloseRunStalled(run, now);
  return false;
}

/** 內部用嘅「全權限」session——一鍵結算 job 喺伺服器背景執行，數字本身
 * 唔應該因為邊個撳咗一鍵而唔同（`buildUnpricedSummary()`／`buildMonthDiagnostics()`
 * 呢類函數嘅 `session` 參數本意係雞頭端 broker 範圍縮窄，內部角色一律
 * 睇晒），永遠唔會經 HTTP 直接暴露呢個 session。 */
function systemSession(actorUserId: string): AuthedSession {
  return {
    userId: actorUserId,
    tel: "",
    name: "",
    roleId: "",
    roleName: "老闆",
    baseRole: "老闆",
    brokerId: null,
    guardId: null,
    payoutApprovalLimit: null,
    tokenVersion: 0,
    loggedInAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// steps_json 讀寫 helper——單一 run 由頭到尾一個 async function 順序執行
// （冇並發），淨係呢個 job 自己會寫呢個 run 嘅 steps_json，唔使樂觀鎖。
// ---------------------------------------------------------------------------
class StepRunner {
  private steps: StepRecord[];
  constructor(
    private readonly runId: string,
    initial?: StepRecord[],
  ) {
    this.steps = initial && initial.length === STEP_KEYS.length ? initial : emptySteps();
  }

  private async persist(currentStep: StepKey | null): Promise<void> {
    await prisma.monthCloseRun.update({
      where: { id: this.runId },
      data: { stepsJson: this.steps as unknown as Prisma.InputJsonValue, currentStep },
    });
  }

  get(key: StepKey): StepRecord {
    return this.steps.find((s) => s.key === key)!;
  }

  /** 執行一步：寫 running → 跑 fn() → 寫 done（或者 failed，然後 rethrow
   * 俾外層決定成個 run 停唔停）。`fn` 回傳嘅 `numbers`/`warnings`/
   * `needsHuman` 冧咗就直接覆蓋（每步重跑安全，唔會累積舊值）。 */
  async run(key: StepKey, fn: () => Promise<{ numbers: Record<string, unknown>; warnings?: string[]; needsHuman?: string[] }>): Promise<StepRecord> {
    const rec = this.get(key);
    rec.status = "running";
    rec.startedAt = new Date().toISOString();
    rec.finishedAt = null;
    await this.persist(key);
    try {
      const { numbers, warnings, needsHuman } = await fn();
      rec.status = "done";
      rec.numbers = numbers;
      rec.warnings = warnings ?? [];
      rec.needsHuman = needsHuman ?? [];
      rec.finishedAt = new Date().toISOString();
      await this.persist(key);
      return rec;
    } catch (e) {
      rec.status = "failed";
      rec.warnings = [...rec.warnings, e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500)];
      rec.finishedAt = new Date().toISOString();
      await this.persist(key);
      throw e;
    }
  }

  skipRest(fromKey: StepKey, reason: string): void {
    const idx = STEP_KEYS.indexOf(fromKey);
    for (let i = idx; i < STEP_KEYS.length; i++) {
      const rec = this.steps[i];
      if (rec.status === "pending") {
        rec.status = "skipped";
        rec.warnings = [reason];
      }
    }
  }

  async flush(currentStep: StepKey | null): Promise<void> {
    await this.persist(currentStep);
  }

  allNeedsHuman(): string[] {
    return this.steps.flatMap((s) => s.needsHuman.map((h) => `【${s.label}】${h}`));
  }

  allWarnings(): string[] {
    return this.steps.flatMap((s) => s.warnings.map((w) => `【${s.label}】${w}`));
  }
}

// ---------------------------------------------------------------------------
// step0 前置檢查
// ---------------------------------------------------------------------------
export async function stepPrecheck(month: Date, actorUserId: string, ip: string | null) {
  const { start, end } = monthRange(month);
  const numbers: Record<string, unknown> = {};
  const warnings: string[] = [];
  const needsHuman: string[] = [];

  // (1) 上月已鎖——只喺上月「有出更」（有 shift_records）先強制。
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const prevRange = monthRange(prevMonth);
  const prevHasData = await prisma.shiftRecord.count({ where: { workDate: { gte: prevRange.start, lte: prevRange.end } } });
  const prevClose = await prisma.monthClose.findUnique({ where: { month: prevMonth } });
  const prevLocked = !!prevClose?.lockedAt;
  numbers.prevMonth = monthLabel(prevMonth);
  numbers.prevMonthHasData = prevHasData > 0;
  numbers.prevMonthLocked = prevLocked;
  if (prevHasData > 0 && !prevLocked) {
    needsHuman.push(`上月（${monthLabel(prevMonth)}）未鎖定，要先鎖定上月先可以一鍵結算本月`);
    // 呢個係硬停條件，由 caller 睇 needsHuman 決定停唔停（見
    // runOneClickMonthClose() PRECHECK_HALT 判斷）。
  }

  // (2) 本月每個有 active 上載嘅盤：有更種？有生效價卡？冇→自動沿用
  // 最近一張同（盤,更種）舊卡（只限 client_rate／guard_wage 都有值嘅
  // 舊卡），新卡 effective_from=本月 1 日，note「一鍵沿用」，audit。
  const uploads = await prisma.rosterUpload.findMany({
    where: { month: start, status: { notIn: ["superseded", "voided"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
  });
  const uploadIds = uploads.map((u) => u.id);
  const combos = uploadIds.length
    ? await prisma.rosterUploadRow.groupBy({
        by: ["resolvedSiteId", "shiftTypeId"],
        where: { uploadId: { in: uploadIds }, codeKind: { in: ["shift", "ot"] }, shiftTypeId: { not: null }, resolvedSiteId: { not: null } },
        _count: true,
      })
    : [];
  const siteIds = [...new Set(combos.map((c) => c.resolvedSiteId).filter((v): v is string => !!v))];
  const sites = siteIds.length ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const shiftTypeIds = [...new Set(combos.map((c) => c.shiftTypeId).filter((v): v is string => !!v))];
  const shiftTypes = shiftTypeIds.length ? await prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } }, select: { id: true, code: true } }) : [];
  const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s.code]));

  let siteMissingShiftTypeCount = 0;
  let cardsCarriedOver = 0;
  let cardsMissingNoCarryover = 0;
  for (const combo of combos) {
    const siteId = combo.resolvedSiteId!;
    const shiftTypeId = combo.shiftTypeId!;
    const siteName = siteNameById.get(siteId) ?? siteId.slice(0, 8);
    const shiftTypeCode = shiftTypeById.get(shiftTypeId) ?? shiftTypeId.slice(0, 8);
    const hasActiveCard = await prisma.rateCard.count({
      where: {
        siteId,
        OR: [{ shiftTypeId }, { shiftTypeId: null }],
        voidedAt: null,
        clientRate: { not: null },
        effectiveFrom: { lte: end },
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] }],
      },
    });
    if (hasActiveCard > 0) continue;
    // 冇生效卡——搵最近一張「呢個盤、呢個更種、client_rate／guard_wage
    // 都有值」嘅盤級通用卡（唔限 broker/guard，用嚟沿用）。
    const carryFrom = await prisma.rateCard.findFirst({
      where: { siteId, shiftTypeId, brokerId: null, guardId: null, voidedAt: null, clientRate: { not: null }, guardWage: { not: null } },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!carryFrom) {
      cardsMissingNoCarryover++;
      needsHuman.push(`盤「${siteName}」更種「${shiftTypeCode}」冇生效價卡，亦搵唔到可以沿用嘅舊卡——要人手設卡`);
      continue;
    }
    const created = await prisma.rateCard.create({
      data: {
        siteId,
        shiftTypeId,
        brokerId: null,
        guardId: null,
        clientRate: carryFrom.clientRate,
        guardWage: carryFrom.guardWage,
        brokerFee: carryFrom.brokerFee,
        payoutRate: carryFrom.payoutRate,
        billingModel: carryFrom.billingModel,
        effectiveFrom: start,
        effectiveTo: null,
        source: "one_click_carryover",
        note: `一鍵沿用（沿用 ${carryFrom.effectiveFrom.toISOString().slice(0, 10)} 生效卡）`,
        createdBy: actorUserId,
      },
    });
    await writeAudit({ actorUserId, tableName: "rate_cards", rowId: created.id, action: "create", after: created, ip });
    cardsCarriedOver++;
    warnings.push(`盤「${siteName}」更種「${shiftTypeCode}」冇生效卡，已自動沿用 ${carryFrom.effectiveFrom.toISOString().slice(0, 10)} 生效卡（一鍵沿用，見 rate_cards audit）`);
  }
  numbers.siteShiftTypeCombosChecked = combos.length;
  numbers.cardsCarriedOver = cardsCarriedOver;
  numbers.cardsMissingNoCarryover = cardsMissingNoCarryover;

  // 盤完全冇 shift_types（更表有格但呢個盤一條更別都未設）——呢類盤嘅
  // combos 唔會出現（shiftTypeId 一定 null，已經喺 group by 篩走），
  // 用返 uploads 逐盤查一次 shiftTypes 數。
  for (const u of uploads) {
    if (!u.siteId) continue;
    const count = await prisma.shiftType.count({ where: { siteId: u.siteId, voidedAt: null } });
    if (count === 0) {
      siteMissingShiftTypeCount++;
      needsHuman.push(`盤「${siteNameById.get(u.siteId) ?? u.siteNameRaw}」完全未設更種，要先喺「盤」管理加更種`);
    }
  }
  numbers.siteMissingShiftTypeCount = siteMissingShiftTypeCount;

  // (3) U Team 名單最新上載日期 >45 日→warning。
  const staffList = await prisma.staffListUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { uploadedAt: true } });
  if (staffList) {
    const ageDays = Math.floor((Date.now() - staffList.uploadedAt.getTime()) / (24 * 60 * 60 * 1000));
    numbers.staffListAgeDays = ageDays;
    if (ageDays > 45) warnings.push(`U Team 名單已經 ${ageDays} 日未更新，建議重新上載`);
  } else {
    numbers.staffListAgeDays = null;
    warnings.push("未上載過 U Team 名單——新散工冧唔到自動建檔，會落 needs_boss");
  }

  // (4) 長工本月有上載行但冇生效崗位——純粹警告（step3 會用 ≥50% 推算），
  // 唔列名，逐盤計數。
  const longtermRows = uploadIds.length
    ? await prisma.rosterUploadRow.findMany({
        where: { uploadId: { in: uploadIds }, codeKind: "shift", guard: { employmentType: "longterm_autopay" } },
        select: { guardId: true, resolvedSiteId: true },
        distinct: ["guardId", "resolvedSiteId"],
      })
    : [];
  const longtermGuardIds = [...new Set(longtermRows.map((r) => r.guardId).filter((v): v is string => !!v))];
  let noPostCount = 0;
  if (longtermGuardIds.length) {
    const withPost = await prisma.guardLongtermPost.findMany({
      where: { guardId: { in: longtermGuardIds }, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
      select: { guardId: true },
    });
    const withPostSet = new Set(withPost.map((p) => p.guardId));
    noPostCount = longtermGuardIds.filter((id) => !withPostSet.has(id)).length;
  }
  numbers.longtermGuardsThisMonth = longtermGuardIds.length;
  numbers.longtermGuardsWithoutPost = noPostCount;
  if (noPostCount > 0) warnings.push(`${noPostCount} 位長工本月有上載行但未設生效崗位——step3 會用 ≥50% 更表占比自動推算`);

  return { numbers, warnings, needsHuman };
}

// ---------------------------------------------------------------------------
// step1 解析健康
// ---------------------------------------------------------------------------
export async function stepParseHealth(month: Date, actorUserId: string) {
  const { start } = monthRange(month);
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const warnings: string[] = [];
  const needsHuman: string[] = [];

  const uploads = await prisma.rosterUpload.findMany({
    where: { month: start, status: { notIn: ["superseded", "voided"] } },
    select: { id: true, siteId: true, siteNameRaw: true, parseSummary: true, status: true },
  });

  let autoBuiltSites = 0;
  let formatDiffWarnings = 0;
  let totalShiftCount = 0;
  for (const u of uploads) {
    const summary = (u.parseSummary as { shiftCount?: number } | null) ?? null;
    const shiftCount = summary?.shiftCount ?? 0;
    totalShiftCount += shiftCount;

    if (u.siteId) {
      const prevUpload = await prisma.rosterUpload.findFirst({
        where: { month: prevMonth, siteId: u.siteId, status: { notIn: ["superseded", "voided"] } },
        select: { parseSummary: true },
        orderBy: { uploadedAt: "desc" },
      });
      const prevCount = (prevUpload?.parseSummary as { shiftCount?: number } | null)?.shiftCount ?? null;
      if (prevCount && prevCount > 0) {
        const diffPct = Math.abs(shiftCount - prevCount) / prevCount;
        if (diffPct > 0.3) {
          formatDiffWarnings++;
          warnings.push(`「${u.siteNameRaw}」本月 ${shiftCount} 格 vs 上月 ${prevCount} 格，相差 ${round2(diffPct * 100)}%——可能截短／格式異常，請人手覆核`);
        }
      }
      continue;
    }

    // site_id=null——自動用檔內盤名建盤（狀態待核＝新盤未經人手核實正式
    // 資料，billing per_shift，client_name＝盤名），warning 唔停。
    try {
      const { assignRosterUploadSite, reparseRosterUpload } = await import("@/lib/roster-upload/service");
      const newSite = await prisma.site.create({
        data: { canonicalName: u.siteNameRaw, clientName: u.siteNameRaw, billingModel: "per_shift", status: "active" },
      });
      await writeAudit({ actorUserId, tableName: "sites", rowId: newSite.id, action: "create", after: newSite, ip: null });
      await assignRosterUploadSite(u.id, newSite.id);
      await reparseRosterUpload(u.id, { autoResolveSite: false });
      autoBuiltSites++;
      warnings.push(`上載「${u.siteNameRaw}」盤名對唔到現有盤，已自動建盤「${u.siteNameRaw}」（待核，billing=per_shift）並重新對照，請人手覆核`);
    } catch (e) {
      needsHuman.push(`上載「${u.siteNameRaw}」盤名對唔到，自動建盤失敗（${e instanceof Error ? e.message.slice(0, 200) : String(e)}），要人手 PATCH 指定盤`);
    }
  }

  return {
    numbers: { uploadCount: uploads.length, totalShiftCount, autoBuiltSites, formatDiffWarnings },
    warnings,
    needsHuman,
  };
}

// ---------------------------------------------------------------------------
// step2 安員修復——循環最多 3 輪直至冇新（可套用嘅）動作
// ---------------------------------------------------------------------------
export async function stepGuardFix(month: Date, actorUserId: string) {
  const warnings: string[] = [];
  const needsHuman: string[] = [];
  const rounds: Array<Record<string, number>> = [];

  const staffList = await prisma.staffListUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" } });
  if (!staffList) {
    warnings.push("未上載 U Team 名單，安員修復略過——未配對安員會留低喺對數頁人手處理");
    return { numbers: { rounds: [] }, warnings, needsHuman };
  }
  const uTeamRows = await parseUTeamWorkbookBuffer(Buffer.from(staffList.fileBytes));

  const { start } = monthRange(month);
  let lastPlanNeedsBoss: { seq: string; siteLabels: string[]; totalCellCount: number }[] = [];

  for (let round = 1; round <= 3; round++) {
    // 注意：唔使喺呢度自己攞 GUARD_FIX_ADVISORY_LOCK_KEY——`applyGuardFixPlan()`
    // 下面已經喺自己嘅 transaction 入面攞緊呢把鎖（apply.ts:79），呢度淨係
    // build plan（讀），冇寫入，唔需要鎖；一鍵結算本身用另一把獨立鎖
    // （`ONE_CLICK_ADVISORY_LOCK_KEY`）保證同一時間淨係一個 run，兩把鎖
    // 唔會撞。
    const postorderUpload = await prisma.postorderUpload.findFirst({ where: { month: start, status: "parsed" }, orderBy: { uploadedAt: "desc" } });
    const postorder = postorderUpload ? { uploadId: postorderUpload.id, fileName: postorderUpload.fileName, ...(await parsePostorderUploadRow(postorderUpload)) } : undefined;

    let plan;
    try {
      plan = await buildGuardFixPlan({ prisma, month: start, uTeamRows, postorder });
    } catch (e) {
      // 冇 active 上載（NoActiveUploadsError）等——安員修復對呢個月冇嘢做。
      warnings.push(`安員修復計劃計算唔到（${e instanceof Error ? e.message.slice(0, 200) : String(e)}），略過`);
      break;
    }
    const summary = summarizePlan(plan);
    const actionable = summary.link + summary.create + summary.createMinimal + summary.setLongterm + summary.setLongtermPost + summary.setReferral + summary.setReferralInferred + summary.setVisa;
    rounds.push({ round, link: summary.link, create: summary.create, createMinimal: summary.createMinimal, needsBoss: summary.needsBoss, setLongterm: summary.setLongterm, setLongtermPost: summary.setLongtermPost, setReferral: summary.setReferral, setReferralInferred: summary.setReferralInferred, setVisa: summary.setVisa });

    lastPlanNeedsBoss = plan.actions.needsBoss.map((a) => {
      const identity = plan.identities.find((i) => i.seq === a.seq);
      return { seq: a.seq, siteLabels: identity?.cells.map((c) => `${c.siteLabel}×${c.cellCount}`) ?? [], totalCellCount: identity?.totalCellCount ?? 0 };
    });

    if (actionable === 0) break;

    const run = await prisma.guardFixRun.create({
      data: {
        month: start,
        staffListUploadId: staffList.id,
        postorderUploadId: postorderUpload?.id ?? null,
        createdById: actorUserId,
        planJson: plan as unknown as Prisma.InputJsonValue,
        summaryJson: { ...summary, hkidDroppedCount: plan.hkidDroppedCount } as unknown as Prisma.InputJsonValue,
        status: "planned",
      },
    });
    try {
      const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, txTimeoutMs: 20 * 60 * 1000, month: start });
      const reparse = await reparseAllActiveUploads(prisma, start, { txTimeoutMs: 10 * 60 * 1000 });
      await prisma.guardFixRun.update({ where: { id: run.id }, data: { status: "applied", appliedAt: new Date(), resultJson: { diffs, reparse } as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      await prisma.guardFixRun.update({ where: { id: run.id }, data: { status: "failed", resultJson: { error: e instanceof Error ? e.message.slice(0, 300) : String(e) } as unknown as Prisma.InputJsonValue } });
      warnings.push(`安員修復第 ${round} 輪套用失敗，已停低（可以重新執行一鍵結算重試）：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      break;
    }
  }

  if (lastPlanNeedsBoss.length > 0) {
    for (const item of lastPlanNeedsBoss) {
      needsHuman.push(`未配對安員（${item.seq}）：${item.siteLabels.join("、")}，共 ${item.totalCellCount} 格——要老闆喺「安員配對修復」頁睇 needs_boss 逐條核實`);
    }
  }

  return { numbers: { rounds, remainingNeedsBoss: lastPlanNeedsBoss.length }, warnings, needsHuman };
}

// ---------------------------------------------------------------------------
// step3 長工結算——全部 active 上載 recomputeSettlement()
// ---------------------------------------------------------------------------
export async function stepLongtermSettlement(month: Date, actorUserId: string) {
  const { start } = monthRange(month);
  const uploads = await prisma.rosterUpload.findMany({ where: { month: start, status: { in: ["parsed", "confirmed"] } }, select: { id: true, siteNameRaw: true } });
  let scanned = 0;
  let changed = 0;
  const warnings: string[] = [];
  for (const u of uploads) {
    try {
      const r = await recomputeSettlement(u.id, actorUserId);
      scanned += r.longtermScanned;
      changed += r.changed;
    } catch (e) {
      warnings.push(`「${u.siteNameRaw}」重算結算單位失敗：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }
  return { numbers: { uploadsScanned: uploads.length, longtermRowsScanned: scanned, longtermRowsChanged: changed }, warnings };
}

// ---------------------------------------------------------------------------
// step4 全月對數＋套用——runReconcileAllForMonth()（已含 reprice）
// ---------------------------------------------------------------------------
export async function stepReconcileApply(month: Date, actorUserId: string, ip: string | null) {
  const result = await runReconcileAllForMonth(month, actorUserId, ip);
  const warnings = [...result.warnings];
  const needsHuman: string[] = [];
  for (const u of result.perUpload) {
    if (u.errors.length > 0) needsHuman.push(`「${u.siteLabel}」對數套用有 ${u.errors.length} 項失敗——要人手喺對數頁覆核`);
  }
  return {
    numbers: {
      uploadCount: result.uploadCount,
      repricedScanned: result.repriced.scanned,
      repricedChanged: result.repriced.changed,
      rosterOnlyBefore: result.totals.rosterOnlyBefore,
      settlementDiffBefore: result.totals.settlementDiffBefore,
      unresolvedBefore: result.totals.unresolvedBefore,
      settlementChanged: result.totals.settlementChanged,
      applied: result.totals.applied,
      uploadsWithErrors: result.totals.uploadsWithErrors,
      perUpload: result.perUpload.map((u) => ({ siteLabel: u.siteLabel, before: u.before, applied: u.applied, errors: u.errors.length })),
    },
    warnings,
    needsHuman,
  };
}

// ---------------------------------------------------------------------------
// step5 定價檢查
// ---------------------------------------------------------------------------
export async function stepPricingCheck(month: Date, actorUserId: string) {
  const summary = await buildUnpricedSummary(systemSession(actorUserId), month);
  const needsHuman = summary.groups.slice(0, 30).map((g) => `盤「${g.site_name}」雞頭「${g.broker_code ?? "（未定）"}」更種「${g.shift_type_code}」：${g.count} 更未定價（${g.category}）`);
  return {
    numbers: { count: summary.count, payoutCount: summary.payoutCount, clientCount: summary.clientCount, noSettlementCount: summary.noSettlementCount, otUnpricedCount: summary.otUnpricedCount, groupCount: summary.groups.length },
    needsHuman,
  };
}

// ---------------------------------------------------------------------------
// step6 計數
// ---------------------------------------------------------------------------
export async function stepCompute(month: Date, actorUserId: string, ip: string | null) {
  const warnings: string[] = [];

  let referralTotal = 0;
  let referralCount = 0;
  if (month >= toMonthStart(new Date(REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH))) {
    try {
      const r = await recomputeReferralFees(month, actorUserId, ip);
      referralTotal = round2(n(r.totalAmount));
      referralCount = r.lineItems.length;
    } catch (e) {
      warnings.push(`介紹費重算失敗（${e instanceof Error ? e.message.slice(0, 200) : String(e)}），改用現有 special_items 讀值`);
      const r = await computeReferralFeesForMonth(month);
      referralTotal = round2(n(r.totalAmount));
      referralCount = r.lineItems.length;
    }
  } else {
    warnings.push(`${monthLabel(month)} 早過自動介紹費起計月份（${REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH.slice(0, 7)}），唔重算，維持人手輸入嘅金額`);
    const r = await computeReferralFeesForMonth(month);
    referralTotal = round2(n(r.totalAmount));
    referralCount = r.lineItems.length;
  }

  const [close, margin, payroll, payrollSource] = await Promise.all([buildMonthlyClose(month), buildGrossMargin(month), buildPayrollTotals(month), buildPayrollSourceSummary(month)]);
  const totalRevenue = round2([...close.mainRows, ...close.outsideRows].reduce((a, r) => a + n(r.revenue), 0));
  const totalMargin = round2(margin.sites.reduce((a, s) => a + n(s.profit), 0));
  const totalCost = round2(totalRevenue - totalMargin);

  return {
    numbers: {
      totalRevenue,
      totalCost,
      totalMargin,
      siteCount: close.mainRows.length + close.outsideRows.length,
      payrollByBroker: payroll.map((p) => ({ brokerCode: p.brokerCode, brokerName: p.brokerName, shifts: p.shifts, amount: round2(p.amount) })),
      referralFeeTotal: referralTotal,
      referralFeeCount: referralCount,
      payrollSourceSummary: payrollSource,
      longtermPayrollNote: "長工糧未計（Phase 2——WP-LTPAY）",
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// step7 對照（可選）——本月有 Postorder 上載先做，唔准估。
// ---------------------------------------------------------------------------
export async function stepPostorderCompare(month: Date, referralSystemTotal: number) {
  const { start } = monthRange(month);
  const postorderUpload = await prisma.postorderUpload.findFirst({ where: { month: start, status: "parsed" }, orderBy: { uploadedAt: "desc" } });
  if (!postorderUpload) {
    return { numbers: { uploaded: false }, warnings: [] as string[] };
  }
  const parsed = await parsePostorderUploadRow(postorderUpload);
  const rowsWithAmount = parsed.referralRows.filter((r) => r.excelAmount !== null);
  const excelTotal = rowsWithAmount.length ? round2(rowsWithAmount.reduce((a, r) => a + (r.excelAmount ?? 0), 0)) : null;
  const diff = excelTotal !== null ? round2(referralSystemTotal - excelTotal) : null;
  const warnings: string[] = [];
  if (parsed.referralRows.length !== rowsWithAmount.length) {
    warnings.push(`總表冇提供 ${parsed.referralRows.length - rowsWithAmount.length} 行介紹費行嘅快取金額——唔准估，呢部分未計入對照`);
  }
  warnings.push("總表冇提供逐雞頭付款欄位解析（現有解析器只解析長工崗位格＋介紹費行＋簽證），逐雞頭付款對照寫「總表冇提供」");
  return {
    numbers: {
      uploaded: true,
      fileName: postorderUpload.fileName,
      referralRowCount: parsed.referralRows.length,
      referralExcelTotal: excelTotal,
      referralSystemTotal,
      referralDiff: diff,
      brokerPayoutCompare: "總表冇提供",
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
export async function runOneClickMonthClose(runId: string, month: Date, actorUserId: string, ip: string | null): Promise<void> {
  const monthStartDate = toMonthStart(month);
  const run = await prisma.monthCloseRun.findUnique({ where: { id: runId } });
  const runner = new StepRunner(runId, (run?.stepsJson as unknown as StepRecord[]) ?? undefined);

  try {
    const precheck = await runner.run("precheck", () => stepPrecheck(monthStartDate, actorUserId, ip));
    const prevMonthNotLocked = precheck.needsHuman.some((h) => h.includes("未鎖定"));
    if (prevMonthNotLocked) {
      runner.skipRest("parse_health", "上月未鎖定，一鍵結算已停低——請先鎖定上月");
      await runner.flush(null);
      await prisma.monthCloseRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: "上月未鎖定，已停低" } });
      return;
    }

    await runner.run("parse_health", () => stepParseHealth(monthStartDate, actorUserId));
    await runner.run("guard_fix", () => stepGuardFix(monthStartDate, actorUserId));
    await runner.run("longterm_settlement", () => stepLongtermSettlement(monthStartDate, actorUserId));
    await runner.run("reconcile_apply", () => stepReconcileApply(monthStartDate, actorUserId, ip));
    await runner.run("pricing_check", () => stepPricingCheck(monthStartDate, actorUserId));
    const compute = await runner.run("compute", () => stepCompute(monthStartDate, actorUserId, ip));
    const referralSystemTotal = (compute.numbers.referralFeeTotal as number) ?? 0;
    await runner.run("postorder_compare", () => stepPostorderCompare(monthStartDate, referralSystemTotal));

    const reportStep = await runner.run("report", async () => {
      const coverage = await checkRosterUploadCoverage(monthStartDate);
      const currentClose = await prisma.monthClose.findUnique({ where: { month: monthStartDate } });
      const report: MonthCloseReport = {
        month: monthLabel(monthStartDate),
        totals: { revenue: (compute.numbers.totalRevenue as number) ?? 0, cost: (compute.numbers.totalCost as number) ?? 0, grossMargin: (compute.numbers.totalMargin as number) ?? 0 },
        payrollByBroker: (compute.numbers.payrollByBroker as MonthCloseReport["payrollByBroker"]) ?? [],
        siteRevenue: await (async () => {
          const close = await buildMonthlyClose(monthStartDate);
          return [...close.mainRows, ...close.outsideRows].map((r) => ({ siteId: r.siteId, siteName: r.canonicalName, shifts: r.shifts, revenue: round2(n(r.revenue)) }));
        })(),
        referralFee: { total: referralSystemTotal, count: (compute.numbers.referralFeeCount as number) ?? 0 },
        unpriced: {
          count: (runner.get("pricing_check").numbers.count as number) ?? 0,
          payoutCount: (runner.get("pricing_check").numbers.payoutCount as number) ?? 0,
          clientCount: (runner.get("pricing_check").numbers.clientCount as number) ?? 0,
          noSettlementCount: (runner.get("pricing_check").numbers.noSettlementCount as number) ?? 0,
          otUnpricedCount: (runner.get("pricing_check").numbers.otUnpricedCount as number) ?? 0,
        },
        postorderCompare: runner.get("postorder_compare").numbers.uploaded
          ? {
              uploaded: true,
              referralExcelTotal: (runner.get("postorder_compare").numbers.referralExcelTotal as number | null) ?? null,
              referralSystemTotal,
              referralDiff: (runner.get("postorder_compare").numbers.referralDiff as number | null) ?? null,
              note: "逐雞頭付款總表冇提供（現有解析器未涵蓋），唔准估",
            }
          : null,
        needsHuman: runner.allNeedsHuman(),
        lockPrecondition: {
          currentMonthAlreadyLocked: !!currentClose?.lockedAt,
          missingUploadSites: coverage.missingUploadSites.map((s) => s.siteName),
          unconfirmedUploadSites: coverage.unconfirmedUploadSites.map((s) => `${s.siteName}（${s.status}）`),
          readyToLock: coverage.missingUploadSites.length === 0 && coverage.unconfirmedUploadSites.length === 0 && !currentClose?.lockedAt,
        },
        longtermPayrollNote: "長工糧未計（Phase 2——WP-LTPAY，跟 8 月試算第十三版口徑另做）",
      };
      return { numbers: report as unknown as Record<string, unknown> };
    });

    await prisma.monthCloseRun.update({
      where: { id: runId },
      data: { status: "done", finishedAt: new Date(), reportJson: reportStep.numbers as unknown as Prisma.InputJsonValue },
    });
    await writeAudit({ actorUserId, tableName: "month_close_runs", rowId: runId, action: "update", after: { id: runId, status: "done" }, ip: null });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 500) : String(e);
    console.error("[one-click] 執行失敗：", message);
    try {
      await prisma.monthCloseRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: message } });
      await writeAudit({ actorUserId, tableName: "month_close_runs", rowId: runId, action: "update", after: { id: runId, status: "failed" }, ip: null });
    } catch (e2) {
      console.error("[one-click] 標記 failed 都失敗：", e2 instanceof Error ? e2.message : String(e2));
    }
  }
}

export { STEP_KEYS, STEP_LABELS };
