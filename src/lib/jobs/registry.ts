// P7：排程 job 登記表（新增 job 喺度加一行；時間表／開關存 scheduled_jobs）。
import type { JobDef } from "@/lib/scheduler/types";
import { openNextMonthJob } from "./open-next-month";
import { nightlyMonthHealthJob } from "./nightly-month-health";
import { triageReminderJob } from "./triage-reminder";
import { autoOneClickJob } from "./auto-one-click";
import { afterLockExportsJob } from "./after-lock-exports";
import { permitExpiryWeeklyJob } from "./permit-expiry-weekly";
import { lockOpsDigestJob } from "./lock-ops-digest";
import { longtermInputDraftsJob } from "./longterm-input-drafts";
import { whatsappRetentionJob } from "./whatsapp-retention";
import { whatsappHealthJob } from "./whatsapp-health";
import { triageEvidenceCleanupJob } from "./triage-evidence-cleanup";
import { whatsappParseJob, whatsappDailySummaryJob } from "./whatsapp-parse";

export const JOBS: JobDef[] = [openNextMonthJob, nightlyMonthHealthJob, triageReminderJob, autoOneClickJob, afterLockExportsJob, permitExpiryWeeklyJob, lockOpsDigestJob, longtermInputDraftsJob, whatsappRetentionJob, whatsappParseJob, whatsappDailySummaryJob, whatsappHealthJob, triageEvidenceCleanupJob];

export function findJob(key: string): JobDef | undefined {
  return JOBS.find((j) => j.key === key);
}
