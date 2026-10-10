// P1-WP3：開新月份（設計文件§4.1「主管：開新月份 → 系統複製上月更別
// 結構同所需人手」；P1-執行計劃.md §4 WP3「複製上月 shift_types／
// daily_requirements／quotas／assignments 結構」）。
//
// shift_types 本身唔跟月份行（喺 schema 屬於 site，唔屬於任何一個月），
// 冇嘢好「複製」——呢個係規劃裁定（Opus 應驗）：spec 原文列咗 shift_types
// 但 schema 冇 month 維度，呢度當佢係「確保新月份沿用返嗰個盤現存嘅
// 更別結構」（本身就自動成立，唔使動作），response 用 shift_types_note
// 講明。真正複製嘅係 daily_requirements（跟日期行，逐日 work_date 搬去
// 新月份同一日）、quotas（跟月份行，逐行複製）、broker_site_assignments
// （同 scripts/assignments/rollover.ts 邏輯一致）。
//
// 用「更表」module「create」action（spec 指定）——但呢個係全系統跨盤
// 動作，唔屬於「雞頭配額內填人」嗰種粒度（矩陣嗰粒 grant 係俾雞頭填
// 自己嘅格用嘅），所以呢度額外擋雞頭角色（防禦性深度，同
// broker-site-assignments POST 入面「就算 hard-deny 有漏都再擋一次」
// 同一手法）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { assertMonthNotLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { MonthOpenSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAuditMany } from "@/lib/audit";
import { BadRequest, Forbidden } from "@/lib/api/errors";

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export async function POST(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "create");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以開新月份（全系統跨盤動作，只限老闆/主管/會計）");

    const { month: monthParam } = await params;
    const parsedDate = new Date(monthParam.length <= 7 ? `${monthParam}-01` : monthParam);
    if (Number.isNaN(parsedDate.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM）");
    const targetMonth = monthStart(parsedDate);
    const sourceMonth = addMonths(targetMonth, -1);
    const targetMonthEnd = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0));
    const sourceMonthEnd = new Date(Date.UTC(sourceMonth.getUTCFullYear(), sourceMonth.getUTCMonth() + 1, 0));
    const targetDaysInMonth = targetMonthEnd.getUTCDate();

    await assertMonthNotLocked({ workDate: targetMonth, actorUserId: session.userId, tableName: "months", rowId: monthParam, ip: getClientIp(req) });

    const ip = getClientIp(req);
    const body = await readJson(req);
    const input = parseBody(MonthOpenSchema, body);

    // Opus 對抗式驗收 A3：成個複製過程（assignments/quotas/daily_
    // requirements 三張表）包一個 `$transaction`——之前逐行 create/
    // findUnique 冇任何交易保證，中途撞 DB 錯誤會留低「複製咗一半」嘅
    // 唔一致狀態（例如 assignments 複製晒但 quotas 得返一半）。audit_log
    // 留返 transaction 真係 commit 咗先寫（同 shift-records/batch/
    // route.ts 同一手法：rollback 咗嘅嘢唔應該喺 audit_log 留低痕跡）。
    type PendingAudit = { tableName: string; rowId: string; after: Record<string, unknown> };
    const pendingAudits: PendingAudit[] = [];

    const { assignmentsCreated, quotasCreated, drCreated, drSkippedOutOfRange, sourceHadAnything } = await prisma.$transaction(async (tx) => {
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
            data: newAssignments.map((row) => ({ brokerId: row.brokerId, siteId: row.siteId, month: targetMonth, createdBy: session.userId })),
            skipDuplicates: true,
          })
        : [];
      for (const created of createdAssignments) pendingAudits.push({ tableName: "broker_site_assignments", rowId: created.id, after: { ...created, copied_from: copiedFrom } });
      const assignmentsCreated = createdAssignments.length;

      // 2) quotas
      const sourceQuotas = await tx.quota.findMany({ where: { month: sourceMonth, voidedAt: null } });
      const existingQuotas = await tx.quota.findMany({ where: { month: targetMonth }, select: { siteId: true, shiftTypeId: true, brokerId: true } });
      const existingQuotaKeys = new Set(existingQuotas.map((r) => `${r.siteId}|${r.shiftTypeId}|${r.brokerId}`));
      const newQuotas = sourceQuotas.filter((r) => !existingQuotaKeys.has(`${r.siteId}|${r.shiftTypeId}|${r.brokerId}`));
      const createdQuotas = newQuotas.length
        ? await tx.quota.createManyAndReturn({
            data: newQuotas.map((row) => ({ month: targetMonth, siteId: row.siteId, shiftTypeId: row.shiftTypeId, brokerId: row.brokerId, targetShifts: row.targetShifts, createdBy: session.userId })),
            skipDuplicates: true,
          })
        : [];
      for (const created of createdQuotas) pendingAudits.push({ tableName: "quotas", rowId: created.id, after: { ...created, copied_from: copiedFrom } });
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
        newDR.push({ siteId: row.siteId, shiftTypeId: row.shiftTypeId, workDate: targetDate, headcountRequired: row.headcountRequired, createdBy: session.userId });
      }
      const createdDR = newDR.length ? await tx.dailyRequirement.createManyAndReturn({ data: newDR, skipDuplicates: true }) : [];
      for (const created of createdDR) pendingAudits.push({ tableName: "daily_requirements", rowId: created.id, after: { ...created, copied_from: copiedFrom } });
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
    await writeAuditMany(pendingAudits.map((a) => ({ actorUserId: session.userId, tableName: a.tableName, rowId: a.rowId, action: "create" as const, after: a.after, ip })));

    // Opus 對抗式驗收 A3：重複開同一個月份——三張表都冇新嘢複製（源頭
    // 有嘢但全部已經存在）就當「已經開咗」，回 200＋`already_open:true`
    // （唔係 201，因為冇建立任何新資源）。源頭本身乜都冇（例如上個月
    // 都未排過）就照舊 201（第一次開，只不過冇嘢好複製）。
    const alreadyOpen = assignmentsCreated === 0 && quotasCreated === 0 && drCreated === 0 && sourceHadAnything;

    return ok(
      brandSafeResponse({
        month: targetMonth.toISOString().slice(0, 10),
        source_month: sourceMonth.toISOString().slice(0, 10),
        roster_version_note: input.roster_version_note ?? null,
        broker_site_assignments_created: assignmentsCreated,
        quotas_created: quotasCreated,
        daily_requirements_created: drCreated,
        daily_requirements_skipped_out_of_range: drSkippedOutOfRange,
        already_open: alreadyOpen,
        shift_types_note: "shift_types 屬於 site（唔跟月份），冇需要複製——新月份自動沿用返個盤現存嘅更別結構",
        // P1-WP3 規劃裁定（第二輪 point 5）：`roster_layout` 都係掛喺
        // site 本身（`sites.roster_layout`），唔係逐月一份紀錄——跟
        // shift_types 同一個道理，新月份自動沿用，唔使複製。呢度加返
        // 一句 note 純粹方便前端/回報睇到呢個裁定嘅解釋，唔代表有動作。
        roster_layout_note: "roster_layout 都係掛喺 site 本身（唔跟月份），同 shift_types 一樣自動沿用，冇需要複製",
      }),
      alreadyOpen ? 200 : 201,
    );
  });
}
