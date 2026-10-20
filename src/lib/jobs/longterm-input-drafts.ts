// P9.1：長工糧人手輸入草稿（每日 21:30 香港；更表上載自動一鍵結算完成後亦觸發一次）。
// 本月＋上月（未鎖）：由更表 SL 日子生成病假段草稿（唔帶金額、未確認唔計糧）；另計勤工獎合資格清單（唔建 input、唔填金額；通知只發上月）。
// 老闆規則：唔准自動加任何金額。通知 body 只有月份／數字；姓名只喺長工糧頁內顯示。
import { createHash } from "node:crypto";
import { hkDateStr, hkMonthStart } from "@/lib/dates";
import { createNotification } from "@/lib/notify/create";
import { generateLongtermInputDrafts, listAttendanceBonusEligible, type DraftMonthResult } from "@/lib/longterm-payroll/drafts";
import { notifySlDraftsPending } from "@/lib/longterm-payroll/sl-confirm";
import { generateCoverDrafts, type CoverDraftResult } from "@/lib/longterm-payroll/cover-drafts";
import { historicalMonthKeys } from "@/lib/month-close/historical";
import { withAuditJob } from "@/lib/audit-job-context";
import { ensureSystemUser } from "@/lib/system-user";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

export const LONGTERM_INPUT_DRAFTS_KEY = "longterm_input_drafts";

function monthsToProcess(now: Date): Date[] {
  const cur = hkMonthStart(now);
  return [new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1)), cur];
}

async function processMonth(month: Date, actorUserId: string, today: string, notifyBonus: boolean): Promise<{ draft: DraftMonthResult; bonus: number | null; cover: CoverDraftResult | null }> {
  const draft = await generateLongtermInputDrafts(month, actorUserId);
  if (draft.locked) return { draft, bonus: null, cover: null };
  // P10.3：頂位草稿（按價目表；無價嘅組合唔生成、通知老闆／會計去設定）
  const cover = await generateCoverDrafts(month, actorUserId);
  if (cover.created + cover.updated > 0 && cover.pending > 0) {
    await createNotification({
      kind: "longterm_drafts",
      title: `${draft.month} 頂位津貼有草稿待確認`,
      body: `${draft.month} 有頂位津貼草稿（按價目表自動計，未確認唔計糧），請到長工糧頁 › 人手輸入處理。`,
      href: `/reports/longterm-payroll?month=${draft.month}`,
      audience: ["會計"],
      dedupeKey: `cover_drafts:${draft.month}:${today}:${cover.created}:${cover.updated}`,
    });
  }
  if (cover.unpriced.length > 0) {
    await createNotification({
      kind: "cover_rates_missing",
      title: `${draft.month} 有頂位價未設定`,
      body: `${cover.unpriced.length} 個盤／職級未有頂位價，去設定 ›`,
      href: "/settings/cover-rates",
      audience: ["老闆", "會計"],
      dedupeKey: `cover_rates_missing:${draft.month}:${createHash("sha1").update(cover.unpriced.map((u) => `${u.site_id}.${u.grade}`).join(",")).digest("hex").slice(0, 12)}`,
    });
  }
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
  // P17（老闆 2026-10-14）：有未確認 SL 草稿就主動彈出（通知＋首頁收件箱＋一鍵結算報告＋鎖月擋）；dedupe＝月＋草稿 id 集合 hash。
  await notifySlDraftsPending(month);
  const bonus = await listAttendanceBonusEligible(month);
  const open = bonus.eligible.filter((e) => !e.already_filled).length;
  // 勤工獎只喺「上月」（即將出糧嗰個月）通知；本月未完，唔推
  if (open > 0 && notifyBonus) {
    await createNotification({
      kind: "longterm_bonus_eligible",
      title: `${m} 勤工獎合資格 ${open} 人`,
      body: `${m} 勤工獎合資格 ${open} 人（更表冇 SL／NL／NPL；遲到系統未有紀錄，未能核對），去長工糧頁 › 人手填金額。`,
      href: `/reports/longterm-payroll?month=${m}`,
      audience: ["會計"],
      dedupeKey: `longterm_bonus_eligible:${m}:${open}`,
    });
  }
  return { draft, bonus: bonus.eligible.length, cover };
}

export async function runLongtermInputDrafts(now: Date, onlyMonths?: Date[]): Promise<JobResult> {
  const sysId = await ensureSystemUser();
  return withAuditJob(
    LONGTERM_INPUT_DRAFTS_KEY,
    async () => {
      const today = hkDateStr(now);
      const out: Record<string, unknown> = {};
      const prevMonth = monthsToProcess(now)[0]!;
      let touched = 0;
      const historical = await historicalMonthKeys(); // HIST-1：歷史月份唔生成草稿
      for (const month of onlyMonths ?? monthsToProcess(now)) {
        if (historical.has(month.getTime())) {
          out[month.toISOString().slice(0, 7)] = { skipped: "historical" };
          continue;
        }
        const r = await processMonth(month, sysId, today, month.getTime() === prevMonth.getTime());
        out[r.draft.month] = { ...r.draft, bonus_eligible: r.bonus, cover: r.cover };
        touched += r.draft.created + r.draft.updated + r.draft.voided + (r.cover ? r.cover.created + r.cover.updated + r.cover.voided : 0);
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
