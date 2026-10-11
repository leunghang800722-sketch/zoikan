// P7：排程 job 登記表（新增 job 喺度加一行；時間表／開關存 scheduled_jobs）。
import type { JobDef } from "@/lib/scheduler/types";
import { openNextMonthJob } from "./open-next-month";
import { nightlyMonthHealthJob } from "./nightly-month-health";
import { triageReminderJob } from "./triage-reminder";
import { autoOneClickJob } from "./auto-one-click";

export const JOBS: JobDef[] = [openNextMonthJob, nightlyMonthHealthJob, triageReminderJob, autoOneClickJob];

export function findJob(key: string): JobDef | undefined {
  return JOBS.find((j) => j.key === key);
}
