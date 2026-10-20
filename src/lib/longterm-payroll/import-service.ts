// WP-LTPAY Phase 2（§20.4「Maxwell 名單」／交付 3）：Maxwell 長工名單
// 導入——用姓名＋MG 號對 DB 長工，建／更新 `guard_longterm_contracts`，
// 補齊 `guards` 欠缺嘅入職/出生日期/試用期（**唔覆蓋已有值**——鐵則
// 「資料全部保留」，導入淨係補空，唔會用 Maxwell 嘅數蓋走人手已經核實
// 咗嘅資料）。對唔到嘅行原封不動列返俾 caller（唔會估佢係邊個）。
//
// 保守做法：如果個長工已經有一段**人手輸入**（source=manual）嘅現行
// 合約（effectiveTo=null），呢次導入唔會碰佢（避免導入自動覆蓋會計
// 已經手動核實／調整過嘅合約段）——淨係喺 `skippedManualContract`
// 度列出嚟俾人揀要唔要人手處理。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { assertMonthRangeNotLockedTx } from "@/lib/month-lock";
import { ApiError } from "@/lib/api/errors";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns, schemeFromNumber, normalizeStaffNumber, STAFF_NUMBER_NUMBER_RE } from "@/lib/guards/staff-numbers";
import { continuousChainStart } from "./aggregate";
import { parseMaxwellWorkbook, parseMaxwellCsv, matchMaxwellRows, type MaxwellStaffRow, type GuardCandidate, type ParsedMaxwellWorkbook, type MaxwellCsvFile } from "./maxwell-import";

export interface MaxwellImportSummary {
  totalRows: number;
  matchedByStaffNo: number;
  matchedByName: number;
  unmatched: Array<{ staffNo: string | null; name: string | null; status: string }>;
  contractsCreated: number;
  contractsUpdated: number;
  skippedManualContract: Array<{ guardId: string; name: string | null }>;
  /** P9.2：合約生效區間覆蓋已鎖月份 → 逐行跳過（其餘照導入）。 */
  skippedLockedRows: number;
  guardFieldsFilled: number;
  /** P14.1：補咗 `guards.nameEn`（Maxwell 英文名，只補空）嘅人數。 */
  filled_name_en: number;
  /** P14.1：補咗 MG／MW 工號（`guard_staff_numbers`＋同步 `staffNoMw`，只補空）嘅人數。 */
  filled_staff_no_mw: number;
  /** P16a：重導入時更新咗非薪酬欄（法定假期有薪起點／休息日／試用期／年假／更時）嘅既有 maxwell_import 合約數。 */
  contracts_fields_updated: number;
  warnings: string[];
  /** P11.1：additive 欄位（`created`＝`contractsCreated`、`skippedLocked`＝`skippedLockedRows` 嘅別名，方便核對）。 */
  created: number;
  skippedLocked: number;
  /** 名單月薪同 `guards.monthlySalary` 現值唔同嘅人數（導入唔改 `monthlySalary`，只提示人手核）。 */
  salaryMismatch: number;
  /** `first_unlocked` 下，離職名單而離職日空／早過起始日 → 唔建合約嘅人數。 */
  skippedLeftBeforeStart: number;
  startMode: ContractStartMode;
  /** `first_unlocked` 時合約起始日（第一個未鎖月 1 號，YYYY-MM-DD）；`original` 或冇鎖月則 null。 */
  contractStartFrom: string | null;
}

/** P11.1：合約起始日模式。`original`＝照名單入職日（覆蓋鎖月嘅行跳過）；`first_unlocked`＝由第一個未鎖月 1 號起生效。 */
export type ContractStartMode = "original" | "first_unlocked";
export const CONTRACT_START_MODES: readonly ContractStartMode[] = ["original", "first_unlocked"];
export interface MaxwellImportOptions {
  contractStartMode?: ContractStartMode;
}

/**
 * P16a：Maxwell「法定假期」欄只有兩種值——「即時享有薪SH」同空白。
 * 含「即時」／immediate → immediate（一入職就有薪法定假）；
 * 空白或其他 → after_3_months（按《僱傭條例》做滿 3 個月先有薪法定假）。
 * 舊版把空白當 immediate，令 7 月 1 日法定假冇扣 NPSH。
 */
export function mapStatutoryHolidayPaidFrom(statHoliday: string | null | undefined): "immediate" | "after_3_months" {
  return /即時|immediate/i.test(statHoliday ?? "") ? "immediate" : "after_3_months";
}

/** 導入由名單行推出嚟嘅非薪酬欄（新建同重導入更新共用）。 */
function nonPayFields(row: MaxwellStaffRow) {
  return {
    statutoryHolidayPaidFrom: mapStatutoryHolidayPaidFrom(row.statHoliday),
    restDayPaid: (row.restDay ?? "").toLowerCase() !== "no",
    shiftHours: row.workingHour ?? undefined,
    probationMonths: row.probationMonths,
    annualLeaveDays: row.annualLeave ?? 7,
  };
}

/** 第一個未鎖月＝最後一個已鎖月嘅下一個月（`month_closes.locked_at` 非空）；冇任何鎖月 → null。 */
async function firstUnlockedMonthStart(): Promise<Date | null> {
  const last = await prisma.monthClose.findFirst({ where: { lockedAt: { not: null } }, orderBy: { month: "desc" }, select: { month: true } });
  if (!last) return null;
  return new Date(Date.UTC(last.month.getUTCFullYear(), last.month.getUTCMonth() + 1, 1));
}

type Segment = { monthlySalary: number; effectiveFrom: Date; effectiveTo: Date | null };

/** P11.1：將合約段夾到 `start` 之後——完全喺 start 之前嘅段丟棄，跨 start 嘅段 effectiveFrom 改為 start。 */
export function clipSegmentsFrom(segments: Segment[], start: Date): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.effectiveTo && seg.effectiveTo.getTime() < start.getTime()) continue;
    out.push(seg.effectiveFrom.getTime() < start.getTime() ? { ...seg, effectiveFrom: start } : seg);
  }
  return out;
}

function isoToDate(iso: string | null): Date | null {
  return iso ? new Date(iso + "T00:00:00.000Z") : null;
}

/** 由一行 Maxwell 記錄砌返「應該存在」嘅合約段——一般得一段（現行月薪）；
 * 如果 New Basic + Effective Date 都有，就拆做兩段（舊薪至生效日前一日
 * ／新薪由生效日起），對應 §14 規則 9「月中轉合約／調薪按日拆」。 */
/** 日薪制判斷（同 8 月試算 s07 `daily_rate_staff = used_monthly < 5000`
 * 一致）：Maxwell「Monthly Salary」欄細過 5,000 嘅其實係「每更價」。
 * Opus 5.5 驗收修正：原本導入一律當月薪，日薪制長工會變成「全月 Net Basic
 * ＝一更價」（少出九成幾人工）。 */
const DAILY_RATE_THRESHOLD = 5000;

function buildSegmentsFromRow(row: MaxwellStaffRow): Array<{ monthlySalary: number; effectiveFrom: Date; effectiveTo: Date | null }> {
  const commencement = isoToDate(row.commencement);
  if (!commencement || row.basic == null) return [];
  if (row.newBasic != null && row.newBasicEff) {
    const effDate = isoToDate(row.newBasicEff)!;
    const dayBefore = new Date(effDate.getTime() - 86400000);
    if (dayBefore.getTime() >= commencement.getTime()) {
      return [
        { monthlySalary: row.basic, effectiveFrom: commencement, effectiveTo: dayBefore },
        { monthlySalary: row.newBasic, effectiveFrom: effDate, effectiveTo: null },
      ];
    }
    // 生效日喺入職日或之前——即入職嗰陣已經係新薪，冇「舊薪段」。
    return [{ monthlySalary: row.newBasic, effectiveFrom: commencement, effectiveTo: null }];
  }
  return [{ monthlySalary: row.basic, effectiveFrom: commencement, effectiveTo: null }];
}

export async function importMaxwellContracts(fileBuffer: Buffer, actorUserId: string, ip: string | null, opts: MaxwellImportOptions = {}): Promise<MaxwellImportSummary> {
  return importMaxwellParsed(await parseMaxwellWorkbook(fileBuffer), actorUserId, ip, opts);
}

/** CSV 路徑（正式站操作員淨係可以傳 CSV）——在職／離職兩個分頁各自匯出。 */
export async function importMaxwellContractsCsv(files: MaxwellCsvFile[], actorUserId: string, ip: string | null, opts: MaxwellImportOptions = {}): Promise<MaxwellImportSummary> {
  return importMaxwellParsed(parseMaxwellCsv(files), actorUserId, ip, opts);
}

async function importMaxwellParsed(parsed: ParsedMaxwellWorkbook, actorUserId: string, ip: string | null, opts: MaxwellImportOptions = {}): Promise<MaxwellImportSummary> {
  const { rows, warnings } = parsed;
  const startMode: ContractStartMode = opts.contractStartMode ?? "original";
  const clipStart = startMode === "first_unlocked" ? await firstUnlockedMonthStart() : null;

  const candidates = await prisma.guard.findMany({
    select: { id: true, nameZh: true, staffNoMw: true, staffNo: true },
  });
  const matches = matchMaxwellRows(
    rows,
    candidates.map((c): GuardCandidate => ({ guardId: c.id, nameZh: c.nameZh, staffNoMw: c.staffNoMw, staffNo: c.staffNo })),
  );

  const summary: MaxwellImportSummary = {
    totalRows: rows.length,
    matchedByStaffNo: matches.filter((m) => m.status === "matched_staff_no").length,
    matchedByName: matches.filter((m) => m.status === "matched_name").length,
    unmatched: matches.filter((m) => m.status === "unmatched").map((m) => ({ staffNo: m.row.staffNo, name: m.row.name, status: m.row.status })),
    contractsCreated: 0,
    contractsUpdated: 0,
    contracts_fields_updated: 0,
    skippedManualContract: [],
    skippedLockedRows: 0,
    guardFieldsFilled: 0,
    filled_name_en: 0,
    filled_staff_no_mw: 0,
    warnings: [...warnings],
    created: 0,
    skippedLocked: 0,
    salaryMismatch: 0,
    skippedLeftBeforeStart: 0,
    startMode,
    contractStartFrom: clipStart ? clipStart.toISOString().slice(0, 10) : null,
  };

  for (const m of matches) {
    if (!m.guardId) continue;
    const row = m.row;
    // P9.2：遇已鎖月份只跳過呢一行（該行 tx 回滾；permission_denied audit 已獨立寫入），其餘照導入
    const filledBefore = summary.guardFieldsFilled;
    const mismatchBefore = summary.salaryMismatch;
    const nameEnBefore = summary.filled_name_en;
    const staffNoMwBefore = summary.filled_staff_no_mw;
    try {
      await importOneRow(m, row);
    } catch (e) {
      if (e instanceof ApiError && e.code === "month_locked") {
        summary.guardFieldsFilled = filledBefore; // 該行 tx 已回滾
        summary.salaryMismatch = mismatchBefore;
        summary.filled_name_en = nameEnBefore;
        summary.filled_staff_no_mw = staffNoMwBefore;
        summary.skippedLockedRows += 1;
        summary.warnings.push(`${row.name ?? row.staffNo ?? "（未知）"}：合約生效區間覆蓋已鎖月份，呢行跳過（${e.message}）`);
        continue;
      }
      throw e;
    }
  }

  summary.created = summary.contractsCreated;
  summary.skippedLocked = summary.skippedLockedRows;
  if (startMode === "first_unlocked" && summary.salaryMismatch) summary.warnings.push(`${summary.salaryMismatch} 人名單月薪同系統現值（guards.monthlySalary）唔同（未改，請人手核）`);
  return summary;

  async function importOneRow(m: (typeof matches)[number], row: MaxwellStaffRow): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.guard.findUnique({ where: { id: m.guardId! } });
      if (!guard) return;

      // 補空——唔覆蓋已有值（鐵則：資料全部保留）。
      const fillData: Prisma.GuardUpdateInput = {};
      if (!guard.dateOfBirth && row.dob) fillData.dateOfBirth = isoToDate(row.dob);
      if (guard.probationMonths == null && row.probationMonths != null) fillData.probationMonths = row.probationMonths;
      // P14.1：補英文名（銀行 Payroll Editor 對數主鍵）——只補空、永不覆蓋；永不改 monthlySalary。
      const nameEn = row.nameEn?.trim();
      if (!guard.nameEn && nameEn) {
        fillData.nameEn = nameEn;
        summary.filled_name_en += 1;
      }
      if (Object.keys(fillData).length) {
        await tx.guard.update({ where: { id: guard.id }, data: fillData });
        summary.guardFieldsFilled += 1;
      }
      // P14.1：補 MG／MW 工號——照現有 staff_numbers 機制（upsertCurrentStaffNumber＋syncLegacyStaffNoColumns）；
      // 撞號（另一人用緊）→ 只加警告，唔影響其餘導入。
      // EMP-P3：入職／離職日改寫落 MG 卡（valid_from＝導入嘅入職日；離職名單 → 卡同時結束 former／resigned／valid_to＝最後一日），
      // 人卡 hire_date／leave_date 唔再直接寫，由 syncLegacyGuardEmploymentColumns 鏡像決定（見 staff-numbers.ts）：
      //   (a) 冇任何 MG 卡（舊寫法條件：legacy staffNoMw 空）→ 開 MG 卡；
      //   (b) 有 MG 卡但全部已結束（former），而導入入職日遲過最後一張卡 valid_to（舊卡 resigned）→ 開新 MG 卡（新聘用段）；
      //   (c) 有 MG current 卡 + 離職名單 → 結束該卡（resigned，valid_to＝最後一日），令鏡像出嚟嘅人卡離職日跟返名單。
      const mwRaw = row.staffNo ? normalizeStaffNumber(row.staffNo) : "";
      const commence = isoToDate(row.commencement);
      const lastDay = row.status === "left" && row.lastDay ? isoToDate(row.lastDay) : null;
      const isMgRow = !!mwRaw && STAFF_NUMBER_NUMBER_RE.test(mwRaw) && schemeFromNumber(mwRaw) === "MG";
      let mgDatedByImport = false;
      let leaverStale = false;
      if (isMgRow) {
        const mgCards = await tx.guardStaffNumber.findMany({ where: { guardId: guard.id, scheme: "MG" }, orderBy: { createdAt: "asc" } });
        const currentMg = mgCards.find((c) => c.status === "current") ?? null;
        // EMP-P3.1／P3.2：離職名單嘅最後一日早過「將被結束嗰張卡 valid_from」「人卡 hire_date」「現行合約鏈起點」任何一個＝屬於上一段聘用（再入職者），
        // 唔結束張卡，加 summary 警告 leaver_date_before_segment（guardId＋日期），交人手處理。
        let closeDay: Date | null = lastDay;
        if (lastDay) {
          const segs = await tx.guardLongtermContract.findMany({ where: { guardId: guard.id, voidedAt: null }, select: { effectiveFrom: true, effectiveTo: true }, orderBy: { effectiveFrom: "asc" } });
          const chainStart = continuousChainStart(segs.map((c) => ({ effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo })), new Date());
          const refs = [currentMg?.validFrom ?? null, guard.hireDate, chainStart ?? null].filter((d): d is Date => !!d);
          // EMP-P3.2：只睇「最後一日」早過參考日（屬上一段）；導入入職日同人卡／卡差幾日好常見（續約隔幾日、手key差），唔阻結束卡，最多出非阻擋提示
          const hit = refs.find((r) => lastDay.getTime() < r.getTime());
          if (hit) {
            summary.warnings.push(`[leaver_date_before_segment] guardId=${guard.id} lastDay=${lastDay.toISOString().slice(0, 10)} segmentRef=${hit.toISOString().slice(0, 10)}：離職日早過現行聘用段起點，屬上一段聘用，唔結束 MG 卡`);
            closeDay = null;
            leaverStale = true;
          } else if (commence) {
            const differs = refs.find((r) => commence.getTime() < r.getTime());
            if (differs) summary.warnings.push(`[import_hire_date_differs] guardId=${guard.id} importHire=${commence.toISOString().slice(0, 10)} segmentRef=${differs.toISOString().slice(0, 10)}：導入入職日早過卡／人卡／合約鏈日期（只提示，仍照離職日結束卡）`);
          }
        }
        const taken = await tx.guardStaffNumber.findUnique({ where: { number: mwRaw }, select: { id: true, guardId: true } });
        if (!currentMg) {
          const lastTo = mgCards.reduce<Date | null>((m, c) => (c.validTo && (!m || c.validTo.getTime() > m.getTime()) ? c.validTo : m), null);
          const firstEver = mgCards.length === 0 && !guard.staffNoMw;
          const newSegment = mgCards.length > 0 && !!commence && !!lastTo && commence.getTime() > lastTo.getTime();
          if (taken) {
            if (taken.guardId !== guard.id) summary.warnings.push(`保安員 ${guard.id.slice(0, 8)}：Maxwell 工號 ${mwRaw} 已經掛喺另一個保安員，唔補工號`);
            else if (newSegment) summary.warnings.push(`保安員 ${guard.id.slice(0, 8)}：Maxwell 工號 ${mwRaw} 同舊 MG 卡同號，未開新聘用段 MG 卡（請人手處理）`);
          } else if (firstEver || newSegment) {
            try {
              await upsertCurrentStaffNumber(tx, {
                guardId: guard.id,
                scheme: "MG",
                number: mwRaw,
                source: "import:maxwell",
                createdBy: actorUserId,
                validFrom: commence,
                ...(closeDay && (!commence || closeDay.getTime() >= commence.getTime()) ? { status: "former" as const, validTo: closeDay, endReason: "resigned" as const } : {}),
              });
              await syncLegacyStaffNoColumns(tx, guard.id, { actorUserId });
              summary.filled_staff_no_mw += 1;
              mgDatedByImport = !!commence || !!closeDay;
            } catch (e) {
              if (!(e instanceof ApiError)) throw e;
              summary.warnings.push(`保安員 ${guard.id.slice(0, 8)}：開 MG 卡失敗（${e.message}）`);
            }
          }
        } else if (closeDay && !currentMg.validTo && (!currentMg.validFrom || closeDay.getTime() >= currentMg.validFrom.getTime())) {
          await tx.guardStaffNumber.update({ where: { id: currentMg.id }, data: { status: "former", validTo: closeDay, endReason: "resigned" } });
          await syncLegacyStaffNoColumns(tx, guard.id, { actorUserId });
          mgDatedByImport = true;
        }
      } else if (!guard.staffNoMw && mwRaw && STAFF_NUMBER_NUMBER_RE.test(mwRaw) && schemeFromNumber(mwRaw) === "MW") {
        // MW（寫字樓）：舊做法不變——只喺冇任何 MG／MW 行時補
        const existingMw = await tx.guardStaffNumber.count({ where: { guardId: guard.id, scheme: { in: ["MG", "MW"] } } });
        const taken = await tx.guardStaffNumber.findUnique({ where: { number: mwRaw }, select: { id: true } });
        if (existingMw === 0 && !taken) {
          await upsertCurrentStaffNumber(tx, { guardId: guard.id, scheme: "MW", number: mwRaw, source: "import:maxwell", createdBy: actorUserId });
          await syncLegacyStaffNoColumns(tx, guard.id, { actorUserId });
          summary.filled_staff_no_mw += 1;
        } else if (taken) {
          summary.warnings.push(`保安員 ${guard.id.slice(0, 8)}：Maxwell 工號 ${mwRaw} 已經掛喺另一個保安員，唔補工號`);
        }
      }
      // 冇 MG 卡可以記日期（例如名單冇 MG 號）→ 照舊補空人卡入職／離職日（唔覆蓋已有值）
      if (!mgDatedByImport) {
        const fill: Prisma.GuardUpdateInput = {};
        if (!guard.hireDate && commence) fill.hireDate = commence;
        if (!guard.leaveDate && lastDay && !leaverStale) fill.leaveDate = lastDay;
        if (Object.keys(fill).length && !(await hasDatedLongtermCard(tx, guard.id))) {
          await tx.guard.update({ where: { id: guard.id }, data: fill });
          summary.guardFieldsFilled += 1;
        }
      }

      const openContract = await tx.guardLongtermContract.findFirst({
        where: { guardId: guard.id, voidedAt: null, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      if (openContract && openContract.source === "manual") {
        summary.skippedManualContract.push({ guardId: guard.id, name: guard.nameZh });
        return;
      }

      const originalSegments = buildSegmentsFromRow(row);
      // P11.1：first_unlocked＝由第一個未鎖月 1 號起生效（原入職日喺 note 留痕），避開鎖月。
      let segments = clipStart ? clipSegmentsFrom(originalSegments, clipStart) : originalSegments;
      // M1：first_unlocked 下離職名單嘅人——離職日空或早過起始日 → 唔建合約；否則最後一段 effectiveTo＝離職日。
      if (clipStart && row.status === "left" && segments.length) {
        const lastDay = isoToDate(row.lastDay);
        if (!lastDay || lastDay.getTime() < clipStart.getTime()) {
          summary.skippedLeftBeforeStart += 1;
          summary.warnings.push(`${row.name ?? row.staffNo ?? "（未知）"}：離職名單，${lastDay ? `離職日早過合約起始日 ${clipStart.toISOString().slice(0, 10)}` : "冇離職日，無法判斷合約結束日"}，唔建合約`);
          return;
        }
        segments = segments
          .filter((seg) => seg.effectiveFrom.getTime() <= lastDay.getTime())
          .map((seg) => (!seg.effectiveTo || seg.effectiveTo.getTime() > lastDay.getTime() ? { ...seg, effectiveTo: lastDay } : seg));
      }
      if (!segments.length) {
        summary.warnings.push(`${row.name ?? row.staffNo ?? "（未知）"}：Maxwell 行冇 Commencement Date 或 Basic Salary，跳過合約建立`);
        return;
      }

      // P11.1：名單現行月薪（最後一段）同 guards.monthlySalary 唔同 → 只計數提示，唔寫（毛利表長工分攤讀 guards.monthlySalary）。
      const currentSalary = segments[segments.length - 1].monthlySalary;
      if (guard.monthlySalary != null && Number(guard.monthlySalary) !== currentSalary) summary.salaryMismatch += 1;

      // 現有 maxwell_import 合約同呢次算出嚟嘅「應有」合約唔同 → 全部
      // void 舊嘅（source=maxwell_import 先會，唔會 void 人手行），
      // 再建新（保留歷史：void 唔刪，`voidedAt`／`note` 留痕）。
      const existingAuto = await tx.guardLongtermContract.findMany({
        where: { guardId: guard.id, voidedAt: null, source: "maxwell_import" },
      });
      const unchanged =
        existingAuto.length === segments.length &&
        existingAuto.every((e, i) => {
          const s = segments[i];
          return Number(e.monthlySalary) === s.monthlySalary && e.effectiveFrom.getTime() === s.effectiveFrom.getTime() && (e.effectiveTo?.getTime() ?? null) === (s.effectiveTo?.getTime() ?? null) && e.payBasis === (s.monthlySalary < DAILY_RATE_THRESHOLD ? "daily" : "monthly");
        });
      if (unchanged) {
        // P16a：薪酬段冇變，但非薪酬欄（法定假期有薪起點等）可能唔同——只更新 source=maxwell_import 嗰啲
        // （人手 manual 合約上面已 return）；鎖月照舊（覆蓋已鎖月先 403／跳過）。薪酬段邏輯不變。
        const want = nonPayFields(row);
        let touched = false;
        for (const e of existingAuto) {
          const diff: Prisma.GuardLongtermContractUpdateInput = {};
          if (e.statutoryHolidayPaidFrom !== want.statutoryHolidayPaidFrom) diff.statutoryHolidayPaidFrom = want.statutoryHolidayPaidFrom;
          if (e.restDayPaid !== want.restDayPaid) diff.restDayPaid = want.restDayPaid;
          if (want.shiftHours !== undefined && Number(e.shiftHours) !== Number(want.shiftHours)) diff.shiftHours = want.shiftHours;
          if (e.probationMonths !== want.probationMonths) diff.probationMonths = want.probationMonths;
          if (Number(e.annualLeaveDays) !== Number(want.annualLeaveDays)) diff.annualLeaveDays = want.annualLeaveDays;
          if (!Object.keys(diff).length) continue;
          await assertMonthRangeNotLockedTx(tx, { effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo, actorUserId, tableName: "guard_longterm_contracts", rowId: e.id, ip });
          const after = await tx.guardLongtermContract.update({ where: { id: e.id }, data: diff });
          await writeAuditTx(tx, { actorUserId, tableName: "guard_longterm_contracts", rowId: e.id, action: "update", before: e, after, ip });
          touched = true;
        }
        if (touched) summary.contracts_fields_updated += 1;
        return;
      }

      // P6.1c（H3）：作廢舊合約／新建合約之前，舊段同新段嘅生效區間內任何一個月
      // 已鎖定就 403（同人手 POST／PATCH 合約一樣嘅 assertMonthRangeNotLocked）。
      // 唔改就唔查（上面 unchanged 已 return）。被拒嗰行之前已 commit 嘅行保留
      // （每行獨立 tx，重跑導入係冪等）。
      for (const e of existingAuto) {
        await assertMonthRangeNotLockedTx(tx, { effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo, actorUserId, tableName: "guard_longterm_contracts", rowId: e.id, ip });
      }
      for (const seg of segments) {
        await assertMonthRangeNotLockedTx(tx, { effectiveFrom: seg.effectiveFrom, effectiveTo: seg.effectiveTo, actorUserId, tableName: "guard_longterm_contracts", rowId: `new:${guard.id}`, ip });
      }

      for (const e of existingAuto) {
        const voidedAfter = await tx.guardLongtermContract.update({ where: { id: e.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
        // P6.1c（H3）：作廢要寫 audit（同人手 void 同 shape：action=void、before／after）。
        await writeAuditTx(tx, { actorUserId, tableName: "guard_longterm_contracts", rowId: e.id, action: "void", before: e, after: voidedAfter, ip });
      }
      for (const seg of segments) {
        const created = await tx.guardLongtermContract.create({
          data: {
            guardId: guard.id,
            monthlySalary: seg.monthlySalary,
            // 日薪制：monthlySalary 保留 Maxwell 原數（即每更價），計糧用 dailyRate。
            payBasis: seg.monthlySalary < DAILY_RATE_THRESHOLD ? "daily" : "monthly",
            dailyRate: seg.monthlySalary < DAILY_RATE_THRESHOLD ? seg.monthlySalary : undefined,
            ...nonPayFields(row),
            effectiveFrom: seg.effectiveFrom,
            effectiveTo: seg.effectiveTo,
            mpfExemptReason: "auto",
            source: "maxwell_import",
            note: `Maxwell 導入（${row.status === "active" ? "在職名單" : "離職名單"} row ${row.sheetRow}）${clipStart ? `；由第一個未鎖月 ${clipStart.toISOString().slice(0, 10)} 起生效${row.commencement && row.commencement < clipStart.toISOString().slice(0, 10) ? `，原入職日 ${row.commencement}` : ""}` : ""}`,
            createdBy: actorUserId,
          },
        });
        await writeAuditTx(tx, {
          actorUserId,
          tableName: "guard_longterm_contracts",
          rowId: created.id,
          action: "create",
          after: { guardId: guard.id, monthlySalary: seg.monthlySalary, effectiveFrom: seg.effectiveFrom, source: "maxwell_import" },
          ip,
        });
        summary.contractsCreated += 1;
      }
      if (existingAuto.length) summary.contractsUpdated += 1;
    });
  }
}

/** 呢個人有冇帶日期嘅長工體系（MG）卡——有就人卡日期由鏡像決定，導入唔再直接補。 */
async function hasDatedLongtermCard(tx: Prisma.TransactionClient, guardId: string): Promise<boolean> {
  const c = await tx.guardStaffNumber.findFirst({ where: { guardId, scheme: "MG", OR: [{ validFrom: { not: null } }, { validTo: { not: null } }] }, select: { id: true } });
  return !!c;
}
