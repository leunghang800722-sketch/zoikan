// P9.1：長工糧人手輸入草稿（每日 21:30 香港；更表上載自動一鍵結算完成後亦觸發一次）。
// 本月＋上月（未鎖）：由更表 SL 日子生成病假段草稿（唔帶金額、未確認唔計糧）；另計勤工獎合資格清單（唔建 input、唔填金額）。
// 老闆規則：唔准自動加任何金額。通知 body 只有月份／數字；姓名只喺長工糧頁內顯示。
import { hkDateStr, hkMonthStart } from "@/lib/dates";
import { createNotification } from "@/lib/notify/create";
import { generateLongtermInputDrafts, listAttendanceBonusEligible, type DraftMonthResult } from "@/lib/longterm-payroll/drafts";
import { withAuditJob } from "@/lib/audit-job-context";
import { ensureSystemUser } from "@/lib/system-user";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

export const LONGTERM_INPUT_DRAFTS_KEY = "longterm_input_drafts";

function monthsToProcess(now: Date): Date[] {
  const cur = hkMonthStart(now);
  return [new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1)), cur];
}

async function processMonth(month: Date, actorUserId: string, today: string): Promise<{ draft: DraftMonthResult; bonus: number | null }> {
  const draft = await generateLongtermInputDrafts(month, actorUserId);
  if (draft.locked) return { draft, bonus: null };
  const m = draft.month;
  if (draft.created + draft.updated > 0 && draft.pending > 0) {
    await createNotification({
      kind: "longterm_drafts",
      title: `${m} 長工糧有草稿待確認`,
      body: `${m} 長工糧有 ${draft.pending} 條草稿待確認（草稿未確認唔計糧），請到長工糧頁 › 人手輸入處理。`,
      href: `/reports/longterm-payroll?month=${m}`,
      audience: ["會計"],
      dedupeKey: `longterm_drafts:${m}:${today}:${draft.pending}`,
    });
  }
  if (draft.mismatches > 0) {
    await createNotification({
      kind: "longterm_drafts",
      title: `${m} 更表同已確認輸入唔同`,
      body: `${m} 有 ${draft.mismatches} 條已確認嘅病假段，更表嘅 SL 日子已經改咗，請到長工糧頁 › 人手輸入覆核。`,
      href: `/reports/longterm-payroll?month=${m}`,
      audience: ["會計"],
      dedupeKey: `longterm_drafts_mismatch:${m}:${draft.mismatches}:${today}`,
    });
  }
  const bonus = await listAttendanceBonusEligible(month);
  const open = bonus.eligible.filter((e) => !e.already_filled).length;
  if (open > 0) {
    await createNotification({
      kind: "longterm_bonus_eligible",
      title: `${m} 勤工獎合資格 ${open} 人`,
      body: `${m} 勤工獎合資格 ${open} 人（更表冇 SL／NL／NPL；遲到系統未有紀錄，未能核對），去長工糧頁 › 人手填金額。`,
      href: `/reports/longterm-payroll?month=${m}`,
      audience: ["會計"],
      dedupeKey: `longterm_bonus_eligible:${m}:${open}`,
    });
  }
  return { draft, bonus: bonus.eligible.length };
}

export async function runLongtermInputDrafts(now: Date, onlyMonths?: Date[]): Promise<JobResult> {
  const sysId = await ensureSystemUser();
  return withAuditJob(
    LONGTERM_INPUT_DRAFTS_KEY,
    async () => {
      const today = hkDateStr(now);
      const out: Record<string, unknown> = {};
      let touched = 0;
      for (const month of onlyMonths ?? monthsToProcess(now)) {
        const r = await processMonth(month, sysId, today);
        out[r.draft.month] = { ...r.draft, bonus_eligible: r.bonus };
        touched += r.draft.created + r.draft.updated + r.draft.voided;
      }
      return { status: touched === 0 ? "skipped" : "ok", summary: { months: out } } as JobResult;
    },
    sysId,
  );
}

export const longtermInputDraftsJob: JobDef = {
  key: LONGTERM_INPUT_DRAFTS_KEY,
  label: "長工糧人手輸入草稿",
  description: "每日 21:30：本月同上月（未鎖）由更表 SL 日子生成病假段草稿（唔帶金額、未確認唔計糧），並計勤工獎合資格清單（唔填金額）。鎖月月份唔郁。",
  defaultSchedule: "30 21 * * *",
  run: async (ctx) => runLongtermInputDrafts(ctx.now),
};
