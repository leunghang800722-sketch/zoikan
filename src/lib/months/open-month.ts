// P7.2：開新月份核心（由 `POST /api/months/:month/open` 同排程 job `open_next_month` 共用——
// 唔重寫複製邏輯）。複製 broker_site_assignments／quotas／daily_requirements（上月 → 目標月），
// 冪等（已存在嘅 key 跳過）。鎖月檢查：tx 開頭 FOR SHARE（P6.1f），已鎖月拋 403 month_locked。
// shift_types／roster_layout 掛喺 site（唔跟月份），冇需要複製（見 route 嘅 note）。
import { prisma } from "@/lib/db";
import { assertMonthNotLockedTx } from "@/lib/month-lock";
import { writeAuditMany } from "@/lib/audit";

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export interface OpenMonthResult {
  sourceMonth: Date;
  assignmentsCreated: number;
  quotasCreated: number;
  drCreated: number;
  drSkippedOutOfRange: number;
  sourceHadAnything: boolean;
  /** 源頭有嘢但三張表都冇新嘢複製＝已經開咗。 */
  alreadyOpen: boolean;
}

/**
 * @param targetMonth 目標月第一日（UTC 0 時）
 * @param actorUserId audit actor；排程 job 傳 null（audit.after 帶 by_job）
 * @param createdBy 新 row 嘅 created_by（user id 或 "job:<key>"）
 */
export async function openMonth(params: { targetMonth: Date; actorUserId: string | null; createdBy: string; ip: string | null; rowIdForLock: string; byJob?: string }): Promise<OpenMonthResult> {
  const { targetMonth, actorUserId, createdBy, ip } = params;
  const sourceMonth = addMonths(targetMonth, -1);
  const targetMonthEnd = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0));
  const sourceMonthEnd = new Date(Date.UTC(sourceMonth.getUTCFullYear(), sourceMonth.getUTCMonth() + 1, 0));
  const targetDaysInMonth = targetMonthEnd.getUTCDate();
  const byJob = params.byJob ? { by_job: params.byJob } : {};

  type PendingAudit = { tableName: string; rowId: string; after: Record<string, unknown> };
  const pendingAudits: PendingAudit[] = [];

  const { assignmentsCreated, quotasCreated, drCreated, drSkippedOutOfRange, sourceHadAnything } = await prisma.$transaction(async (tx) => {
    // P6.1f（H6）：tx 開頭 FOR SHARE 再查鎖月（route 層檢查喺 tx 外面）。
    await assertMonthNotLockedTx(tx, { workDate: targetMonth, actorUserId, tableName: "months", rowId: params.rowIdForLock, ip });
    // P3-2.9（附錄 b A-15）：每張表「一次 findMany 攞 target 已存在 key → createManyAndReturn
    // （skipDuplicates 防並發）→ 用返回嘅行寫 audit」，取代逐行 findUnique＋create。
    const copiedFrom = sourceMonth.toISOString().slice(0, 7);

    // 1) broker_site_assignments（同 scripts/assignments/rollover.ts 邏輯一致）
    const sourceAssignments = await tx.brokerSiteAssignment.findMany({ where: { month: sourceMonth } });
    const existingAssignments = await tx.brokerSiteAssignment.findMany({ where: { month: targetMonth }, select: { brokerId: true, siteId: true } });
    const existingAssignmentKeys = new Set(existingAssignments.map((r) => `${r.brokerId}|${r.siteId}`));
    const newAssignments = sourceAssignments.filter((r) => !existingAssignmentKeys.has(`${r.brokerId}|${r.siteId}`));
    const createdAssignments = newAssignments.length
      ? await tx.brokerSiteAssignment.createManyAndReturn({
          data: newAssignments.map((row) => ({ brokerId: row.brokerId, siteId: row.siteId, month: targetMonth, createdBy })),
          skipDuplicates: true,
        })
      : [];
    for (const created of createdAssignments) pendingAudits.push({ tableName: "broker_site_assignments", rowId: created.id, after: { ...created, copied_from: copiedFrom, ...byJob } });
    const assignmentsCreated = createdAssignments.length;

    // 2) quotas
    const sourceQuotas = await tx.quota.findMany({ where: { month: sourceMonth, voidedAt: null } });
    const existingQuotas = await tx.quota.findMany({ where: { month: targetMonth }, select: { siteId: true, shiftTypeId: true, brokerId: true } });
    const existingQuotaKeys = new Set(existingQuotas.map((r) => `${r.siteId}|${r.shiftTypeId}|${r.brokerId}`));
    const newQuotas = sourceQuotas.filter((r) => !existingQuotaKeys.has(`${r.siteId}|${r.shiftTypeId}|${r.brokerId}`));
    const createdQuotas = newQuotas.length
      ? await tx.quota.createManyAndReturn({
          data: newQuotas.map((row) => ({ month: targetMonth, siteId: row.siteId, shiftTypeId: row.shiftTypeId, brokerId: row.brokerId, targetShifts: row.targetShifts, createdBy })),
          skipDuplicates: true,
        })
      : [];
    for (const created of createdQuotas) pendingAudits.push({ tableName: "quotas", rowId: created.id, after: { ...created, copied_from: copiedFrom, ...byJob } });
    const quotasCreated = createdQuotas.length;

    // 3) daily_requirements——逐日搬去新月份「同一日」（新月份日數少過來源
    // 月份時，多出嗰幾日冇對應，跳過；唔硬 clamp 落最後一日，避免將 31
    // 號嘅所需人手錯誤地疊落 30 號度）。
    const sourceDR = await tx.dailyRequirement.findMany({ where: { workDate: { gte: sourceMonth, lte: sourceMonthEnd }, voidedAt: null } });
    const existingDR = await tx.dailyRequirement.findMany({ where: { workDate: { gte: targetMonth, lte: targetMonthEnd } }, select: { siteId: true, shiftTypeId: true, workDate: true } });
    const existingDRKeys = new Set(existingDR.map((r) => `${r.siteId}|${r.shiftTypeId}|${r.workDate.getTime()}`));
    let drSkippedOutOfRange = 0;
    const newDR: Array<{ siteId: string; shiftTypeId: string; workDate: Date; headcountRequired: number; createdBy: string }> = [];
    for (const row of sourceDR) {
      const day = row.workDate.getUTCDate();
      if (day > targetDaysInMonth) {
        drSkippedOutOfRange++;
        continue;
      }
      const targetDate = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth(), day));
      if (existingDRKeys.has(`${row.siteId}|${row.shiftTypeId}|${targetDate.getTime()}`)) continue;
      newDR.push({ siteId: row.siteId, shiftTypeId: row.shiftTypeId, workDate: targetDate, headcountRequired: row.headcountRequired, createdBy });
    }
    const createdDR = newDR.length ? await tx.dailyRequirement.createManyAndReturn({ data: newDR, skipDuplicates: true }) : [];
    for (const created of createdDR) pendingAudits.push({ tableName: "daily_requirements", rowId: created.id, after: { ...created, copied_from: copiedFrom, ...byJob } });
    const drCreated = createdDR.length;

    return {
      assignmentsCreated,
      quotasCreated,
      drCreated,
      drSkippedOutOfRange,
      sourceHadAnything: sourceAssignments.length > 0 || sourceQuotas.length > 0 || sourceDR.length > 0,
    };
  }, { timeout: 60_000, maxWait: 10_000 }); // P3-1.7（B-3）：daily_requirements 逐行 round trip，預設 5 s 太短


  // transaction 已經成功 commit——而家先逐條真係寫 audit_log。
  await writeAuditMany(pendingAudits.map((a) => ({ actorUserId, tableName: a.tableName, rowId: a.rowId, action: "create" as const, after: a.after, ip })));

  const alreadyOpen = assignmentsCreated === 0 && quotasCreated === 0 && drCreated === 0 && sourceHadAnything;
  return { sourceMonth, assignmentsCreated, quotasCreated, drCreated, drSkippedOutOfRange, sourceHadAnything, alreadyOpen };
}
