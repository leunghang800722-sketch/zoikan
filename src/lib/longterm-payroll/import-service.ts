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
  warnings: string[];
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

export async function importMaxwellContracts(fileBuffer: Buffer, actorUserId: string, ip: string | null): Promise<MaxwellImportSummary> {
  return importMaxwellParsed(await parseMaxwellWorkbook(fileBuffer), actorUserId, ip);
}

/** CSV 路徑（正式站操作員淨係可以傳 CSV）——在職／離職兩個分頁各自匯出。 */
export async function importMaxwellContractsCsv(files: MaxwellCsvFile[], actorUserId: string, ip: string | null): Promise<MaxwellImportSummary> {
  return importMaxwellParsed(parseMaxwellCsv(files), actorUserId, ip);
}

async function importMaxwellParsed(parsed: ParsedMaxwellWorkbook, actorUserId: string, ip: string | null): Promise<MaxwellImportSummary> {
  const { rows, warnings } = parsed;

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
    skippedManualContract: [],
    skippedLockedRows: 0,
    guardFieldsFilled: 0,
    warnings: [...warnings],
  };

  for (const m of matches) {
    if (!m.guardId) continue;
    const row = m.row;
    // P9.2：遇已鎖月份只跳過呢一行（該行 tx 回滾；permission_denied audit 已獨立寫入），其餘照導入
    const filledBefore = summary.guardFieldsFilled;
    try {
      await importOneRow(m, row);
    } catch (e) {
      if (e instanceof ApiError && e.code === "month_locked") {
        summary.guardFieldsFilled = filledBefore; // 該行 tx 已回滾
        summary.skippedLockedRows += 1;
        summary.warnings.push(`${row.name ?? row.staffNo ?? "（未知）"}：合約生效區間覆蓋已鎖月份，呢行跳過（${e.message}）`);
        continue;
      }
      throw e;
    }
  }

  return summary;

  async function importOneRow(m: (typeof matches)[number], row: MaxwellStaffRow): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.guard.findUnique({ where: { id: m.guardId! } });
      if (!guard) return;

      // 補空——唔覆蓋已有值（鐵則：資料全部保留）。
      const fillData: Prisma.GuardUpdateInput = {};
      if (!guard.hireDate && row.commencement) fillData.hireDate = isoToDate(row.commencement);
      if (!guard.dateOfBirth && row.dob) fillData.dateOfBirth = isoToDate(row.dob);
      if (guard.probationMonths == null && row.probationMonths != null) fillData.probationMonths = row.probationMonths;
      if (!guard.leaveDate && row.status === "left" && row.lastDay) fillData.leaveDate = isoToDate(row.lastDay);
      if (Object.keys(fillData).length) {
        await tx.guard.update({ where: { id: guard.id }, data: fillData });
        summary.guardFieldsFilled += 1;
      }

      const openContract = await tx.guardLongtermContract.findFirst({
        where: { guardId: guard.id, voidedAt: null, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      if (openContract && openContract.source === "manual") {
        summary.skippedManualContract.push({ guardId: guard.id, name: guard.nameZh });
        return;
      }

      const segments = buildSegmentsFromRow(row);
      if (!segments.length) {
        summary.warnings.push(`${row.name ?? row.staffNo ?? "（未知）"}：Maxwell 行冇 Commencement Date 或 Basic Salary，跳過合約建立`);
        return;
      }

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
      if (unchanged) return;

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
            statutoryHolidayPaidFrom: /3\s*month|3\s*個月|滿\s*3/i.test(row.statHoliday ?? "") ? "after_3_months" : "immediate",
            effectiveFrom: seg.effectiveFrom,
            effectiveTo: seg.effectiveTo,
            restDayPaid: (row.restDay ?? "").toLowerCase() !== "no",
            shiftHours: row.workingHour ?? undefined,
            probationMonths: row.probationMonths,
            annualLeaveDays: row.annualLeave ?? 7,
            mpfExemptReason: "auto",
            source: "maxwell_import",
            note: `Maxwell 導入（${row.status === "active" ? "在職名單" : "離職名單"} row ${row.sheetRow}）`,
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
