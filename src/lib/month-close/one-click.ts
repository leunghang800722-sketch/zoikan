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
import { runReconcileAllForMonth, RECONCILE_ALL_ADVISORY_LOCK_KEY, RECONCILE_ALL_STALE_MS } from "@/lib/roster-upload/reconcile-all";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan, reparseAllActiveUploads, GUARD_FIX_ADVISORY_LOCK_KEY } from "@/lib/guard-fix/apply";
import { APPLY_STALE_MS } from "@/lib/guard-fix/view";
import { safeErrorSummary } from "@/lib/api/http";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import { parsePostorderUploadRow } from "@/lib/guard-fix/postorder";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals, buildPayrollSourceSummary } from "@/lib/reports/payroll";
import { computeReferralFeesForMonth, recomputeReferralFees, REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH } from "@/lib/reports/referral-fee";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { findCopyLastMonthCandidates, type CopyLastMonthCandidate } from "@/lib/pricing/copy-last-month-cards";
import { writeAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { STEP_KEYS, STEP_LABELS, emptySteps, type StepKey, type StepRecord, type MonthCloseReport } from "./types";

export const ONE_CLICK_ADVISORY_LOCK_KEY = 7_710_270_927; // 自己一個 key，唔同 guard-fix(...925)／reconcile-all(...926)
export const ONE_CLICK_STALE_MS = 15 * 60 * 1000;
/** 安員修復最多循環幾輪（dev 8 月實測第 3 輪仲有 3 個動作、第 4 輪先 0）。 */
const GUARD_FIX_MAX_ROUNDS = 5;

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

/** 寫入 `error_message`／step warnings 嘅錯誤訊息——自己 throw 嘅
 * `Error`（中文說明句）原文保留；其他（Prisma／lib）錯誤一律經
 * `safeErrorSummary()` 淨係攞最後一行＋長度上限，唔會將 query payload
 * （可能有姓名／電話）寫落 DB 俾主管睇到。 */
function jobErrorMessage(e: unknown): string {
  if (e instanceof Error && e.constructor === Error) return (e.message.split("\n").pop() ?? "").slice(0, 300);
  return safeErrorSummary(e);
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
      rec.warnings = [...rec.warnings, jobErrorMessage(e)];
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
/** Opus 驗收收窄嘅「卡沿用」規則——淨係沿用「上月通用逐更卡」：
 *   - 同盤同更種、`broker_id`／`guard_id` 皆 null（唔沿用雞頭級／逐人卡，
 *     例如 B07／長工日均卡）；
 *   - `billing_model` 係 null 或 `per_shift`（唔沿用 `special` 特殊卡——
 *     例如 7 月 Event Guard 一筆過收入卡——同 `monthly_fixed`／`admin_fee`
 *     月費卡）；
 *   - `client_rate`／`guard_wage` 都有值、未作廢；
 *   - `effective_from` 早過本月、`effective_to` 啱啱係上月最後一日（即係
 *     一張「上月仲生效、上月底先完」嘅卡）——唔沿用未來卡（會將下月價
 *     倒灌返本月）、唔沿用早幾個月已經收咗嘅舊卡（過期卡）。
 * LINK（guards_paid_by_client）盤喺 caller 已經略過。 */
export async function findCarryoverCard(siteId: string, shiftTypeId: string, monthStartDate: Date) {
  const prevMonthEnd = new Date(monthStartDate.getTime() - 24 * 60 * 60 * 1000);
  return prisma.rateCard.findFirst({
    where: {
      siteId,
      shiftTypeId,
      brokerId: null,
      guardId: null,
      voidedAt: null,
      clientRate: { not: null },
      guardWage: { not: null },
      OR: [{ billingModel: null }, { billingModel: "per_shift" }],
      effectiveFrom: { lt: monthStartDate },
      effectiveTo: prevMonthEnd,
    },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 簽名保留 actorUserId／ip：呼叫方（runOneClickMonthClose）一律傳呢兩個參數，Phase 3 之後 step0 唔再寫卡／audit（見下面大註解），暫時用唔著，但保留簽名等日後 step0 加返其他需要 actor/ip 嘅動作唔使改晒 call site。
export async function stepPrecheck(month: Date, actorUserId: string, ip: string | null): Promise<{ numbers: Record<string, unknown>; warnings: string[]; needsHuman: string[]; halt?: string }> {
  const { start, end } = monthRange(month);
  const numbers: Record<string, unknown> = {};
  const warnings: string[] = [];
  const needsHuman: string[] = [];

  // (0) 本月已鎖——一鍵結算會寫卡／建盤／改安員／套用對數，鎖咗嘅月一律
  // 唔郁（Opus 驗收：原版淨係靠 step4 `assertMonthNotLocked()` 擋，但
  // step0–3 已經寫咗卡／建咗盤先至爆）。
  const thisClose = await prisma.monthClose.findUnique({ where: { month: start } });
  numbers.currentMonthLocked = !!thisClose?.lockedAt;
  if (thisClose?.lockedAt) {
    needsHuman.push(`本月（${monthLabel(start)}）已經鎖定，一鍵結算唔會再改任何資料——要改先由老闆解鎖`);
    return { numbers, warnings, needsHuman, halt: "本月已鎖定，一鍵結算已停低（冇寫入任何資料）" };
  }

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
    // 硬停：即刻返，唔好再落去做 (2) 卡沿用（Opus 驗收：原版照寫卡先停）。
    return { numbers, warnings, needsHuman, halt: "上月未鎖定，一鍵結算已停低——請先鎖定上月" };
  }

  // (2) 本月每個有 active 上載嘅盤：有更種？有生效價卡？冇→唔寫卡（WP-
  // PHASE3），淨係喺 needsHuman 建議去價目卡頁撳「複製上月卡到本月」（有
  // 候選先建議）或者人手設卡。
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
  const sites = siteIds.length ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true, guardsPaidByClient: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const paidByClientSiteIds = new Set(sites.filter((s) => s.guardsPaidByClient).map((s) => s.id));
  const shiftTypeIds = [...new Set(combos.map((c) => c.shiftTypeId).filter((v): v is string => !!v))];
  const shiftTypes = shiftTypeIds.length ? await prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } }, select: { id: true, code: true } }) : [];
  const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s.code]));

  let siteMissingShiftTypeCount = 0;
  // WP-PHASE3（§20.4 Phase 3 item 3，老闆／規劃裁定「§20.3 原意係建議＋
  // 一撳」）：呢度**唔再自動寫卡**——舊版 step0 見到 (盤,更種) 冇本月卡就
  // 自動搵上月通用卡複製一張落 DB（`source=one_click_carryover`），Phase 3
  // 已經起咗獨立「複製上月卡到本月」功能（`src/lib/pricing/copy-last-
  // month-cards.ts`＋價目卡頁掣，人手預覽先確認），一鍵結算 step0 改做
  // 純偵測＋建議，唔再幫用戶靜靜寫卡（任務書「唔准靜靜出錯數」精神一
  // 致：價錢可能已經變，自動沿用完全唔覆核就落 DB 有風險）。`cardsCarried
  // Over` 呢個 numbers key 保留（值恆為 0）——history/報告頁如果仲有邊度
  // 讀緊呢粒 key 唔會突然 undefined。
  const cardsCarriedOver = 0;
  let cardsMissingNoCarryover = 0;
  // WP-PHASE3 Opus 5.5 驗收：建議要同價目卡頁「複製上月卡到本月」掣嘅候選
  // 一致——原本用 `findCarryoverCard()`（淨係盤級通用卡），但 8 月實際卡
  // 絕大部分係雞頭專屬價，結果掣撳落會複製，報告就話「冇上月卡可以沿用
  // ——要人手設卡」，兩邊講嘢唔一致。而家直接用同一個
  // `findCopyLastMonthCandidates()`（唔寫 DB）判斷。
  const copyCandidates = await findCopyLastMonthCandidates(monthLabel(start));
  const copyCandidatesByCombo = new Map<string, CopyLastMonthCandidate[]>();
  for (const c of copyCandidates) {
    const key = `${c.siteId}|${c.shiftTypeId}`;
    copyCandidatesByCombo.set(key, [...(copyCandidatesByCombo.get(key) ?? []), c]);
  }
  // 效能優化（老闆 2026-09-28 指令）：原本逐 (盤,更種) 組合打一條 rate_cards
  // count（~120 條），改做一條 findMany 攞齊呢批盤本月生效、有收客價嘅卡，
  // 再喺記憶體判斷「有更種對正嘅卡或者盤級通用卡（shift_type_id IS NULL）」
  // ——where 條件同原本一樣，結果不變。
  const activeCardRows = siteIds.length
    ? await prisma.rateCard.findMany({
        where: {
          siteId: { in: siteIds },
          voidedAt: null,
          clientRate: { not: null },
          effectiveFrom: { lte: end },
          AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] }],
        },
        select: { siteId: true, shiftTypeId: true },
      })
    : [];
  const activeCardCombos = new Set(activeCardRows.map((c) => `${c.siteId}|${c.shiftTypeId ?? ""}`));
  for (const combo of combos) {
    const siteId = combo.resolvedSiteId!;
    const shiftTypeId = combo.shiftTypeId!;
    const siteName = siteNameById.get(siteId) ?? siteId.slice(0, 8);
    const shiftTypeCode = shiftTypeById.get(shiftTypeId) ?? shiftTypeId.slice(0, 8);
    // LINK（guards_paid_by_client）盤：客戶直接出糧、唔逐更計价，本身就唔
    // 需要逐更卡（同 unpriced.ts 一致），唔查。
    if (paidByClientSiteIds.has(siteId)) continue;
    const hasActiveCard = activeCardCombos.has(`${siteId}|${shiftTypeId}`) || activeCardCombos.has(`${siteId}|`);
    if (hasActiveCard) continue;
    cardsMissingNoCarryover++;
    // 淨係查有冇上月卡可以複製（俾用戶睇到「撳咗『複製上月卡』有冇用」），
    // 唔寫 DB。
    const cands = copyCandidatesByCombo.get(`${siteId}|${shiftTypeId}`) ?? [];
    if (cands.length === 0) {
      needsHuman.push(`盤「${siteName}」更種「${shiftTypeCode}」冇生效價卡，亦冇上月卡可以複製——要人手設卡（去價目卡頁）`);
    } else {
      const detail = cands
        .slice(0, 5)
        .map((c) => `${c.brokerId ? (c.brokerLabel.split(" ")[0] ?? "雞頭") : "通用"} 收客 ${c.clientRate ?? "—"}／工資 ${c.guardWage ?? "—"}`)
        .join("；");
      needsHuman.push(
        `盤「${siteName}」更種「${shiftTypeCode}」冇本月生效卡，搵到 ${cands.length} 張上月卡（${detail}${cands.length > 5 ? "；…" : ""}）——去價目卡頁撳「複製上月卡到本月」一撳套用（或者人手設卡）`,
      );
    }
  }
  numbers.siteShiftTypeCombosChecked = combos.length;
  numbers.cardsCarriedOver = cardsCarriedOver;
  numbers.cardsMissingNoCarryover = cardsMissingNoCarryover;

  // 盤完全冇 shift_types（更表有格但呢個盤一條更別都未設）——呢類盤嘅
  // combos 唔會出現（shiftTypeId 一定 null，已經喺 group by 篩走）。
  // Opus 驗收：原版逐「上載嘅盤」查，一檔多子盤嘅母盤（例：城巴車廠，
  // 格全部歸子盤、母盤本身刻意冇更種）會誤報；而家改做逐「格實際歸屬
  // 嘅盤」（`resolved_site_id`，shift/ot 格）查。
  const rowSites = uploadIds.length
    ? await prisma.rosterUploadRow.groupBy({
        by: ["resolvedSiteId"],
        where: { uploadId: { in: uploadIds }, codeKind: { in: ["shift", "ot"] }, resolvedSiteId: { not: null } },
        _count: true,
      })
    : [];
  // 效能優化：逐盤 shift_types count 改做一條 groupBy 攞「有更種嘅盤」集合。
  const sitesWithShiftTypes = new Set(
    rowSites.length
      ? (await prisma.shiftType.groupBy({ by: ["siteId"], where: { siteId: { in: rowSites.map((r) => r.resolvedSiteId!) }, voidedAt: null } })).map((g) => g.siteId)
      : [],
  );
  for (const r of rowSites) {
    const sid = r.resolvedSiteId!;
    if (!sitesWithShiftTypes.has(sid)) {
      siteMissingShiftTypeCount++;
      const name = siteNameById.get(sid) ?? (await prisma.site.findUnique({ where: { id: sid }, select: { canonicalName: true } }))?.canonicalName ?? sid.slice(0, 8);
      needsHuman.push(`盤「${name}」完全未設更種（本月有 ${r._count} 格），要先喺「盤」管理加更種`);
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
  // WP-PHASE3（item 2）：`longtermGuardsWithoutPostIds`——結構化 guardId
  // 清單（唔帶姓名，同 report_json 一直嘅「唔放 PII」慣例一致），俾前端
  // 「一鍵結算」報告頁每項砌一個連結去安員抽屜「長工」區撳「設崗位」（例
  // 如 `/guards?open=<id>`），唔使人手逐個喺名冊搵。上限 50 個（報告 JSON
  // 唔應該無上限咁大）。
  let longtermGuardsWithoutPostIds: string[] = [];
  if (longtermGuardIds.length) {
    const withPost = await prisma.guardLongtermPost.findMany({
      where: { guardId: { in: longtermGuardIds }, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
      select: { guardId: true },
    });
    const withPostSet = new Set(withPost.map((p) => p.guardId));
    const withoutPostIds = longtermGuardIds.filter((id) => !withPostSet.has(id));
    noPostCount = withoutPostIds.length;
    longtermGuardsWithoutPostIds = withoutPostIds.slice(0, 50);
  }
  numbers.longtermGuardsThisMonth = longtermGuardIds.length;
  numbers.longtermGuardsWithoutPost = noPostCount;
  numbers.longtermGuardsWithoutPostIds = longtermGuardsWithoutPostIds;
  if (noPostCount > 0) warnings.push(`${noPostCount} 位長工本月有上載行但（執行前）未設生效崗位——之後「安員修復」會先由 Postorder 補崗位，仲係冇先由「長工結算」用 ≥50% 更表占比推算；報告下面有連結可以逐個去安員抽屜「長工」區撳「設崗位」`);

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
    select: { id: true, siteId: true, siteNameRaw: true, parseSummary: true, status: true, fileName: true },
    orderBy: { uploadedAt: "asc" },
  });

  // Opus 驗收：同一次 run 入面兩個上載盤名寫法唔同（全形／空白／大細楷）
  // 都唔好建兩個盤——用 `normalizeSiteLabel()`（同 matchSite 一致 NFKC＋
  // 空白摺合）做 key。
  const { normalizeSiteLabel, matchSite } = await import("@/lib/roster-upload/match");
  const builtThisRun = new Map<string, string>(); // normName → siteId
  const autoBuiltSiteNames: string[] = [];
  let rematchedSites = 0;
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

    // 解析失敗嘅上載：`site_name_raw` 會跌返做檔名——唔可以攞檔名建盤。
    if (u.status === "parse_failed") {
      needsHuman.push(`上載「${u.fileName}」解析失敗，冇計入本月——要重新上載正確嘅更表檔`);
      continue;
    }

    // site_id=null——(a) 先用而家嘅盤主檔（含之後先加嘅 aliases／檔名鍵）
    // 重新自動配對一次（同上載時一樣經 `resolveRosterUploadSite()`）；
    // (b) 真係對唔到先用檔內盤名建盤（`SiteStatus` 冇「待核」值，用
    // `active`，喺報告「要人決定」列出「待核盤」），同一 run 同名唔重複建。
    try {
      const { assignRosterUploadSite, reparseRosterUpload } = await import("@/lib/roster-upload/service");
      await reparseRosterUpload(u.id, { autoResolveSite: true });
      const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: u.id }, select: { siteId: true } });
      if (after.siteId) {
        rematchedSites++;
        warnings.push(`上載「${u.siteNameRaw}」而家對到現有盤（盤主檔之後有更新），已自動指定`);
        continue;
      }
      // 建盤防重複嘅 key 再寬少少：連空白都唔計（「XX (東)」／「XX（東）」／
      // 「XX(東)」當同一個），淨係用嚟決定「唔好再建多個」，唔影響
      // matchSite() 本身嘅嚴格比對。
      const looseKey = (raw: string) => normalizeSiteLabel(raw).replace(/\s+/g, "");
      const normName = looseKey(u.siteNameRaw);
      const allSites = await prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } });
      let siteId =
        builtThisRun.get(normName) ??
        matchSite(u.siteNameRaw, allSites) ??
        allSites.find((s) => looseKey(s.canonicalName) === normName || s.aliases.some((a) => looseKey(a) === normName))?.id ??
        null;
      if (!siteId) {
        const newSite = await prisma.site.create({
          data: { canonicalName: u.siteNameRaw.trim(), clientName: u.siteNameRaw.trim(), billingModel: "per_shift", status: "active", createdBy: actorUserId },
        });
        await writeAudit({ actorUserId, tableName: "sites", rowId: newSite.id, action: "create", after: newSite, ip: null });
        siteId = newSite.id;
        builtThisRun.set(normName, siteId);
        autoBuiltSites++;
        autoBuiltSiteNames.push(newSite.canonicalName);
        needsHuman.push(`【待核盤】上載「${u.siteNameRaw}」對唔到任何現有盤，已自動建新盤「${newSite.canonicalName}」（按更計、未有更種／價卡）——請去「盤」管理核實，係舊盤另一個寫法就將佢併返（加 alias）`);
      }
      await assignRosterUploadSite(u.id, siteId);
      await reparseRosterUpload(u.id, { autoResolveSite: false });
    } catch (e) {
      needsHuman.push(`上載「${u.siteNameRaw}」盤名對唔到，自動建盤失敗（${safeErrorSummary(e)}），要人手喺更表上載頁指定盤`);
    }
  }

  return {
    numbers: { uploadCount: uploads.length, totalShiftCount, autoBuiltSites, autoBuiltSiteNames, rematchedSites, formatDiffWarnings },
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

  let converged = false;
  for (let round = 1; round <= GUARD_FIX_MAX_ROUNDS; round++) {
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
      warnings.push(`安員修復計劃計算唔到（${safeErrorSummary(e)}），略過`);
      break;
    }
    const summary = summarizePlan(plan);
    const actionable = summary.link + summary.create + summary.createMinimal + summary.setLongterm + summary.setLongtermPost + summary.setReferral + summary.setReferralInferred + summary.setVisa;
    rounds.push({ round, link: summary.link, create: summary.create, createMinimal: summary.createMinimal, needsBoss: summary.needsBoss, setLongterm: summary.setLongterm, setLongtermPost: summary.setLongtermPost, setReferral: summary.setReferral, setReferralInferred: summary.setReferralInferred, setVisa: summary.setVisa });

    lastPlanNeedsBoss = plan.actions.needsBoss.map((a) => {
      const identity = plan.identities.find((i) => i.seq === a.seq);
      return { seq: a.seq, siteLabels: identity?.cells.map((c) => `${c.siteLabel}×${c.cellCount}`) ?? [], totalCellCount: identity?.totalCellCount ?? 0 };
    });

    if (actionable === 0) {
      converged = true;
      break;
    }

    // Opus 驗收：同「安員配對修復」頁共用同一套「套用緊」判斷——喺
    // GUARD_FIX 鎖入面檢查冇第二個未卡死 run 套用緊，然後直接建一個
    // `applying` 狀態嘅 run（頁面「計算計劃」／「套用」見到會 409 等佢），
    // 唔再以 `planned` 狀態偷偷套用（原版頁面完全睇唔到呢個 job 套用緊）。
    let run;
    try {
      run = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${GUARD_FIX_ADVISORY_LOCK_KEY})`);
        const busy = await tx.guardFixRun.findFirst({ where: { status: "applying", applyStartedAt: { gt: new Date(Date.now() - APPLY_STALE_MS) } }, select: { id: true } });
        if (busy) throw new Error("「安員配對修復」頁有另一個修復計劃套用緊");
        return tx.guardFixRun.create({
          data: {
            month: start,
            staffListUploadId: staffList.id,
            postorderUploadId: postorderUpload?.id ?? null,
            createdById: actorUserId,
            planJson: plan as unknown as Prisma.InputJsonValue,
            summaryJson: { ...summary, hkidDroppedCount: plan.hkidDroppedCount } as unknown as Prisma.InputJsonValue,
            status: "applying",
            applyStartedAt: new Date(),
          },
        });
      });
    } catch (e) {
      // 人手套用緊——呢一步唔可以靜靜略過（未配對安員會令糧數錯），成個
      // run 標 failed，等佢完成再「重新執行」。
      throw new Error(`安員修復第 ${round} 輪開始唔到：${safeErrorSummary(e)}——等「安員配對修復」頁嗰個套用完成，再撳「重新執行」`);
    }
    try {
      const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, txTimeoutMs: 20 * 60 * 1000, month: start });
      const reparse = await reparseAllActiveUploads(prisma, start, { txTimeoutMs: 10 * 60 * 1000 });
      await prisma.guardFixRun.update({ where: { id: run.id }, data: { status: "applied", appliedAt: new Date(), resultJson: { diffs, reparse } as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      await prisma.guardFixRun.update({ where: { id: run.id }, data: { status: "failed", resultJson: { error: safeErrorSummary(e) } as unknown as Prisma.InputJsonValue } });
      // 套用失敗唔可以當 warning 繼續行落去計糧（未配對安員會令數錯）——
      // 成個 run 標 failed，重新執行安全（guard-fix apply 冪等）。
      throw new Error(`安員修復第 ${round} 輪套用失敗：${safeErrorSummary(e)}`);
    }
  }
  if (!converged && rounds.length === GUARD_FIX_MAX_ROUNDS) {
    needsHuman.push(`安員修復跑咗 ${GUARD_FIX_MAX_ROUNDS} 輪仲有新動作未收斂——再撳一次「一鍵結算」會接住做`);
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
      warnings.push(`「${u.siteNameRaw}」重算結算單位失敗：${safeErrorSummary(e)}`);
    }
  }
  return { numbers: { uploadsScanned: uploads.length, longtermRowsScanned: scanned, longtermRowsChanged: changed }, warnings };
}

// ---------------------------------------------------------------------------
// step4 全月對數＋套用——runReconcileAllForMonth()（已含 reprice）
// ---------------------------------------------------------------------------
export async function stepReconcileApply(month: Date, actorUserId: string, ip: string | null) {
  // Opus 驗收：同更表上載頁「重新對數全月」共用同一個 `reconcile_all_runs`
  // 認領（同一把 RECONCILE_ALL 鎖＋「冇第二個未卡死 running」檢查）——
  // 頁面嗰粒掣喺 job 做緊呢步嗰陣會 409，job 見到人手嗰個做緊亦會停低
  // （run failed，訊息叫人等佢完先重新執行），唔會兩個同時套用。
  const now = new Date();
  const allRunId = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${RECONCILE_ALL_ADVISORY_LOCK_KEY})`);
    const other = await tx.reconcileAllRun.findFirst({ where: { status: "running", startedAt: { gt: new Date(now.getTime() - RECONCILE_ALL_STALE_MS) } }, select: { id: true } });
    if (other) throw new Error("更表上載頁有另一個「重新對數全月」執行緊——等佢完成，再撳「重新執行」");
    return (await tx.reconcileAllRun.create({ data: { month, status: "running", startedById: actorUserId } })).id;
  });
  let result;
  try {
    result = await runReconcileAllForMonth(month, actorUserId, ip);
    await prisma.reconcileAllRun.update({ where: { id: allRunId }, data: { status: "done", finishedAt: new Date(), resultJson: result as unknown as Prisma.InputJsonValue } });
  } catch (e) {
    await prisma.reconcileAllRun.update({ where: { id: allRunId }, data: { status: "failed", finishedAt: new Date(), errorMessage: safeErrorSummary(e) } }).catch(() => undefined);
    throw e;
  }
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
      warnings.push(`介紹費重算失敗（${safeErrorSummary(e)}），改用現有 special_items 讀值`);
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

  // 效能優化（老闆 2026-09-28 指令）：原版先計一次 buildGrossMargin()（攞
  // legacy 成本／毛利），重算長工糧之後再計第二次（攞 combinedCostSummary）
  // ——但 `totals`（更次成本／介紹費／月薪分攤估算）完全唔讀長工糧 run，
  // 淨係 `longtermPayrollActual`／`combinedCostSummary` 先讀，所以改做先重算
  // 長工糧、再計一次毛利表就攞齊兩樣，數字同原版逐個 key 一樣，慳返一次
  // 成個毛利表（含內嵌月結總表）嘅計算。
  // WP-LTPAY Phase 2 §21 任務 3d：接駁長工月薪糧 aggregate 層——每次
  // 一鍵結算都重算呢個月嘅長工糧（冪等：void 舊 run 建新，見
  // aggregate.ts `recomputeLongtermPayroll()`）。失敗唔可以拖跨成個
  // 一鍵結算（呢層仲未經 7/8 月 gate 驗證，見 §21.2）——降級做
  // warning，report 用 note 講清楚未計。
  let longtermPayroll: MonthCloseReport["longtermPayroll"] = null;
  let longtermPayrollNote = "";
  try {
    const lt = await recomputeLongtermPayroll(month, actorUserId, ip);
    longtermPayroll = { grossTotal: lt.totals.grossTotal, autopayTotal: lt.totals.autopayTotal, mpfEeTotal: lt.totals.mpfEeTotal, mpfErTotal: lt.totals.mpfErTotal, guardCount: lt.totals.guardCount };
    const visa = lt.totals.visaPassthrough;
    longtermPayrollNote = `長工糧 ${lt.totals.guardCount} 人${visa.guardCount ? `（含簽證形式長工 ${visa.guardCount} 人，照出糧，Autopay ${visa.autopayTotal} 由雞頭結算扣返）` : ""}：Gross ${lt.totals.grossTotal}／Autopay ${lt.totals.autopayTotal}／MPF EE ${lt.totals.mpfEeTotal}／ER ${lt.totals.mpfErTotal}。老闆已確認可人手輸入（賣假／頂位／勤工獎）——呢啲同病假段醫生紙／平均工資要會計喺「長工糧」頁人手輸入先計到，鎖月前要喺「長工糧」頁逐人覆核`;
    if (lt.warnings.length) warnings.push(...lt.warnings.map((w) => `長工糧：${w}`));
  } catch (e) {
    longtermPayrollNote = `長工糧重算失敗（${safeErrorSummary(e)}）——月結總表／毛利成本暫唔含長工 autopay，要人手覆核`;
    warnings.push(longtermPayrollNote);
  }

  const [close, margin, payroll, payrollSource] = await Promise.all([buildMonthlyClose(month), buildGrossMargin(month), buildPayrollTotals(month), buildPayrollSourceSummary(month)]);
  // 總收入＝月結總表（主表＋月結以外）；成本／毛利＝毛利即時表 `totals`
  // （同一 lib、同頁面一致）。Opus 驗收：原版用「月結總表收入 − 毛利」
  // 倒數成本，將月結以外收入混入，得出一個任何頁面都搵唔到嘅成本數。
  const totalRevenue = round2([...close.mainRows, ...close.outsideRows].reduce((a, r) => a + n(r.revenue), 0));
  const totalMargin = round2(margin.totals.profit);
  const totalCost = round2(margin.totals.cost);
  const marginRevenue = round2(margin.totals.revenue);

  // §21 任務 5a：一鍵結算報告顯示合併成本摘要（更次成本／長工 Autopay／
  // 介紹費／合計／MPF ER）——`recomputeLongtermPayroll()` 啱啱先喺上面
  // 跑完，要重新讀一次 `buildMonthlyClose()` 嘅 `combinedCostSummary`
  // 先攞到反映最新 run 嘅摘要（`close` 呢個變量係喺 `recomputeLongtermPayroll()`
  // 之前計嘅，嗰陣仲未有呢次 run）。
  //
  // Opus 5.5 驗收（老闆要求「總成本／毛利」唔好令人睇錯）：改用毛利表
  // （`buildGrossMargin()`）嘅合併摘要——同上面 `marginRevenue` 同一個
  // 範圍（唔計月結以外），毛利先係「同一把尺」。2026-08 起而且長工糧
  // 有 run：報告「總成本／毛利」改用合併口徑（更次成本＋介紹費＋長工
  // Autopay 真實數，取代 P0 遺留「按更數估算分攤長工月薪」嗰個估算）；
  // 原本毛利表成本保留做 `legacyCost` 對照。7 月或者長工糧重算失敗 →
  // 維持舊口徑（`costBasis="legacy"`），頁面會講明。
  const combinedCostSummary = margin.combinedCostSummary;
  const useCombined = combinedCostSummary !== null && longtermPayroll !== null;
  const reportCost = useCombined ? combinedCostSummary.combinedCostTotal : totalCost;
  const reportMargin = useCombined ? round2(marginRevenue - combinedCostSummary.combinedCostTotal) : totalMargin;

  return {
    numbers: {
      totalRevenue,
      totalCost: reportCost,
      totalMargin: reportMargin,
      legacyCost: totalCost,
      legacyMargin: totalMargin,
      costBasis: useCombined ? "combined" : "legacy",
      marginRevenue,
      siteCount: close.mainRows.length + close.outsideRows.length,
      payrollByBroker: payroll.map((p) => ({ brokerCode: p.brokerCode, brokerName: p.brokerName, shifts: p.shifts, amount: round2(p.amount) })),
      referralFeeTotal: referralTotal,
      referralFeeCount: referralCount,
      payrollSourceSummary: payrollSource,
      longtermPayroll,
      longtermPayrollNote,
      combinedCostSummary,
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
  // 每次（重新）執行都由全新 steps 開始——唔好保留上一次失敗／停低嘅
  // 狀態（Opus 驗收：原版重新執行停低時，舊 run 嘅 done/skipped 會殘留）。
  const runner = new StepRunner(runId);

  try {
    let halt: string | undefined;
    await runner.run("precheck", async () => {
      const r = await stepPrecheck(monthStartDate, actorUserId, ip);
      halt = r.halt;
      return r;
    });
    if (halt) {
      runner.skipRest("parse_health", halt);
      await runner.flush(null);
      await prisma.monthCloseRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), errorMessage: halt } });
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
      const unpricedCount = (runner.get("pricing_check").numbers.count as number) ?? 0;
      const report: MonthCloseReport = {
        month: monthLabel(monthStartDate),
        totals: {
          revenue: (compute.numbers.totalRevenue as number) ?? 0,
          marginRevenue: (compute.numbers.marginRevenue as number) ?? 0,
          cost: (compute.numbers.totalCost as number) ?? 0,
          grossMargin: (compute.numbers.totalMargin as number) ?? 0,
          costBasis: (compute.numbers.costBasis as "combined" | "legacy" | undefined) ?? "legacy",
          legacyCost: (compute.numbers.legacyCost as number | undefined) ?? (compute.numbers.totalCost as number) ?? 0,
          legacyMargin: (compute.numbers.legacyMargin as number | undefined) ?? (compute.numbers.totalMargin as number) ?? 0,
        },
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
          unpricedCount: unpricedCount,
          // Opus 驗收：§20.3 step8「前置條件全綠先亮」——除咗上載覆蓋，
          // 仲有未定價更（冇價就鎖會鎖死錯數）。
          readyToLock: coverage.missingUploadSites.length === 0 && coverage.unconfirmedUploadSites.length === 0 && !currentClose?.lockedAt && unpricedCount === 0,
        },
        longtermPayroll: (compute.numbers.longtermPayroll as MonthCloseReport["longtermPayroll"]) ?? null,
        longtermPayrollNote: (compute.numbers.longtermPayrollNote as string) ?? "",
        combinedCostSummary: (compute.numbers.combinedCostSummary as MonthCloseReport["combinedCostSummary"]) ?? null,
      };
      return { numbers: report as unknown as Record<string, unknown> };
    });

    await prisma.monthCloseRun.update({
      where: { id: runId },
      data: { status: "done", finishedAt: new Date(), reportJson: reportStep.numbers as unknown as Prisma.InputJsonValue },
    });
    await writeAudit({ actorUserId, tableName: "month_close_runs", rowId: runId, action: "update", after: { id: runId, status: "done" }, ip: null });
  } catch (e) {
    const message = jobErrorMessage(e);
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
