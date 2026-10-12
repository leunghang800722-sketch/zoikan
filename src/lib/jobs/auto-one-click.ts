// P8.1：上載完自動跑一鍵結算。每 5 分鐘檢查每個「未鎖」月份：
//   - 有有效上載（非 superseded／voided／parse_failed），而最新一個上載已經 ≥ 10 分鐘前（等齊先）
//   - 最新上載時間 > 該月最後一次一鍵結算 run 嘅 started_at（冇新檔就唔重跑）
//   - 同一批上載只觸發一次（state[month] = 上次觸發時嘅最新上載時間）
//   - 冇一鍵結算跑緊（全域 advisory xact lock＋busy 檢查，同 POST /api/month-close/one-click 同一條 lock）
// 然後 call 同一個 `runOneClickMonthClose`（P8 驗收 M1：actor＝排程系統帳號 `系統排程`，所有 audit 經 withAuditJob 帶 by_job；
// 分診 session 擁有人＝該月最新上載者（要有「一鍵結算:create」），冇就系統帳號——系統帳號擁有嘅 session 有權限嘅人都答得）。
// M2：state 空（首次跑）唔觸發，只記每個月份而家嘅最新上載時間做 baseline，之後有新上載先跑。
// 完成／失敗／halt 都通知老闆＋會計（body 只有數字／月份／原因一句）。
import { prisma } from "@/lib/db";
import { isMonthLocked } from "@/lib/month-lock";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify/create";
import { ONE_CLICK_ADVISORY_LOCK_KEY, ONE_CLICK_STALE_MS, runOneClickMonthClose } from "@/lib/month-close/one-click";
import { mergeJobState, readJobState } from "@/lib/scheduler/state";
import { ensureSystemUser } from "@/lib/system-user";
import { withAuditJob } from "@/lib/audit-job-context";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { getJobReaderSession } from "./session";
import { runLongtermInputDrafts, LONGTERM_INPUT_DRAFTS_KEY } from "./longterm-input-drafts";
import { withJobLock } from "@/lib/scheduler/lock";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

export const AUTO_ONE_CLICK_KEY = "auto_one_click";
/** 最新上載要靜置幾耐先自動跑（等齊所有檔）。 */
const UPLOAD_SETTLE_MS = 10 * 60 * 1000;

type SkipReason = "locked" | "reopened_no_new_upload" | "settling" | "no_new_upload" | "already_triggered" | "run_in_progress" | "busy";

function label(month: Date): string {
  return month.toISOString().slice(0, 7);
}

/** 該月最新有效上載嘅上載者（active 而且有「一鍵結算:create」）；唔合資格就回 null（→ 系統帳號擁有）。 */
async function pickTriageOwner(month: Date): Promise<string | null> {
  const up = await prisma.rosterUpload.findFirst({ where: { month, status: { in: ["uploaded", "parsed", "confirmed"] } }, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }], select: { uploader: { select: { id: true, status: true, name: true, tel: true, roleId: true, tokenVersion: true, role: { select: { name: true, baseRole: true } } } } } });
  const u = up?.uploader;
  if (!u || u.status !== "active") return null;
  const session = { userId: u.id, tel: u.tel, name: u.name, roleId: u.roleId, roleName: u.role.name, baseRole: u.role.baseRole, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: u.tokenVersion, loggedInAt: new Date().toISOString() } as AuthedSession;
  return (await hasPermission(session, "一鍵結算", "create")) ? u.id : null;
}

export async function runAutoOneClick(now: Date): Promise<JobResult> {
  const sysId = await ensureSystemUser();
  return withAuditJob(AUTO_ONE_CLICK_KEY, () => runAutoOneClickInner(now), sysId);
}

async function runAutoOneClickInner(now: Date): Promise<JobResult> {
  const settleBefore = new Date(now.getTime() - UPLOAD_SETTLE_MS);
  const staleBefore = new Date(now.getTime() - ONE_CLICK_STALE_MS);
  // 有至少一個 parsed 上載嘅月份
  const parsedMonths = await prisma.rosterUpload.findMany({ where: { status: "parsed" }, distinct: ["month"], select: { month: true }, orderBy: { month: "asc" } });
  const skipped: Record<string, SkipReason> = {};
  const triggered: Record<string, { run_id: string; status: string; drafts?: string }> = {};
  const state = await readJobState(AUTO_ONE_CLICK_KEY);
  const firstRun = state.last_trigger_upload_at === undefined;
  const triggerState: Record<string, string> = { ...((state.last_trigger_upload_at as Record<string, string> | undefined) ?? {}) };
  const baseline: Record<string, string> = {};
  let reader: Awaited<ReturnType<typeof getJobReaderSession>> | null = null;

  for (const { month } of parsedMonths) {
    const m = label(month);
    if (await isMonthLocked(month)) {
      skipped[m] = "locked";
      continue;
    }
    // 最新上載（任何仍有效狀態：uploaded／parsed／confirmed）——uploaded 代表仲處理緊，一樣要等
    const latest = await prisma.rosterUpload.aggregate({ where: { month, status: { in: ["uploaded", "parsed", "confirmed"] } }, _max: { uploadedAt: true } });
    const latestAt = latest._max.uploadedAt;
    if (!latestAt) continue;
    if (latestAt > settleBefore) {
      skipped[m] = "settling";
      continue;
    }
    if (firstRun) {
      // M2：首次跑唔觸發——記低而家嘅最新上載時間做 baseline，之後有更新嘅上載先自動跑
      baseline[m] = latestAt.toISOString();
      triggerState[m] = latestAt.toISOString();
      continue;
    }
    const lastRun = await prisma.monthCloseRun.findFirst({ where: { month }, orderBy: { startedAt: "desc" }, select: { startedAt: true, status: true, applyStartedAt: true } });
    if (lastRun && lastRun.status === "running" && lastRun.applyStartedAt && lastRun.applyStartedAt > staleBefore) {
      skipped[m] = "run_in_progress";
      continue;
    }
    if (lastRun && latestAt <= lastRun.startedAt) {
      skipped[m] = "no_new_upload";
      continue;
    }
    // P14.4：解鎖舊月份做銀行對數期間——月份曾被解鎖（audit unlock_month），而最新上載唔新過解鎖時間 → 唔自動重跑
    // （避免冇新上載就對已核對嘅舊月份重跑一鍵結算、沖走人手修正）。解鎖後有新上載先照舊觸發。
    const mc = await prisma.monthClose.findUnique({ where: { month }, select: { id: true } });
    if (mc) {
      const unlock = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mc.id, action: "unlock_month" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (unlock && latestAt <= unlock.createdAt) {
        skipped[m] = "reopened_no_new_upload";
        continue;
      }
    }
    const prevTrigger = triggerState[m];
    if (prevTrigger && new Date(prevTrigger).getTime() >= latestAt.getTime()) {
      skipped[m] = "already_triggered";
      continue;
    }

    reader ??= await getJobReaderSession();
    const actor = reader; // 排程系統帳號
    const owner = (await pickTriageOwner(month)) ?? actor.userId;
    // 同 POST /api/month-close/one-click 一樣：全域 advisory xact lock＋「有另一個跑緊」檢查
    const runId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
      const other = await tx.monthCloseRun.findFirst({ where: { status: "running", applyStartedAt: { gt: staleBefore } }, select: { id: true } });
      if (other) return null;
      const created = await tx.monthCloseRun.create({ data: { month, status: "running", startedById: actor.userId, applyStartedAt: now } });
      return created.id;
    });
    if (!runId) {
      skipped[m] = "busy";
      continue;
    }
    // 先記低「呢批上載已觸發」，之後就算 run 出事都唔會每 5 分鐘無限重跑（失敗會通知，人手處理）
    triggerState[m] = latestAt.toISOString();
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: triggerState });
    await writeAudit({ actorUserId: actor.userId, tableName: "month_close_runs", rowId: runId, action: "create", after: { id: runId, month: `${m}-01`, status: "running", by_job: AUTO_ONE_CLICK_KEY }, ip: null });

    await runOneClickMonthClose(runId, month, actor.userId, null, { triageOwnerUserId: owner });

    const run = await prisma.monthCloseRun.findUnique({ where: { id: runId }, select: { status: true, errorMessage: true, reportJson: true } });
    const status = run?.status ?? "failed";
    triggered[m] = { run_id: runId, status };
    if (status === "done") {
      const rep = (run?.reportJson ?? {}) as { auto?: { review?: unknown[] }; unpriced?: { count?: number } };
      const questions = Array.isArray(rep.auto?.review) ? rep.auto!.review!.length : 0;
      const unpriced = rep.unpriced?.count ?? 0;
      await createNotification({
        kind: "one_click_auto",
        title: `${m} 一鍵結算已自動跑完`,
        body: `${m} 一鍵結算已自動跑完：${questions} 題要你答、未定價 ${unpriced} 更。`,
        href: `/month-close?month=${m}`,
        audience: ["老闆", "會計"],
        dedupeKey: `one_click_auto:${runId}`,
      });
      // P9.1：更表剛結算完，順手更新該月長工糧草稿（失敗唔影響一鍵結算結果）
      try {
        // 同排程 job 共用 lock：另一邊跑緊就跳過（排程每日仍會補）
        const lk = await withJobLock(LONGTERM_INPUT_DRAFTS_KEY, () => runLongtermInputDrafts(now, [month]));
        if (!lk.acquired) triggered[m] = { ...triggered[m]!, drafts: "skipped_locked" } as (typeof triggered)[string];
      } catch (e) {
        console.error("[auto-one-click] longterm drafts failed", e instanceof Error ? e.message : e);
      }
    } else {
      const reason = (run?.errorMessage ?? "未知原因").replace(/\s+/g, " ").slice(0, 120);
      await createNotification({
        kind: "one_click_auto",
        title: `${m} 一鍵結算自動執行未能完成`,
        body: `${m} 一鍵結算自動執行未能完成：${reason}`,
        href: `/month-close?month=${m}`,
        audience: ["老闆", "會計"],
        dedupeKey: `one_click_auto:${runId}`,
      });
    }
  }

  if (firstRun) {
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: triggerState });
    return { status: "skipped", summary: { baseline, triggered, skipped } };
  }
  const n = Object.keys(triggered).length;
  return { status: n === 0 ? "skipped" : "ok", summary: { triggered, skipped } };
}

export const autoOneClickJob: JobDef = {
  key: AUTO_ONE_CLICK_KEY,
  label: "上載完自動一鍵結算",
  description: "每 5 分鐘：未鎖月份有新上載（靜置 10 分鐘後）就自動跑一鍵結算，完成／失敗都通知老闆同會計。唔會自動鎖月。",
  defaultSchedule: "*/5 * * * *",
  run: async (ctx) => runAutoOneClick(ctx.now),
};

/** 只供 test 用 */
export const __testPickOwner = pickTriageOwner;
