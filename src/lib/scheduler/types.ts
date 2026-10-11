// P7.1：排程 job 定義。job 本身只准經現有 lib 寫入（含鎖月檢查），唔直接寫 SQL。
interface JobContext {
  jobKey: string;
  trigger: "schedule" | "manual";
  now: Date;
}
export interface JobResult {
  /** 預設 ok；job 自己判斷「無事可做／被鎖月跳過」可回 skipped。 */
  status?: "ok" | "skipped";
  /** 寫入 job_runs.summary——只准數字／id／月份，唔准 PII。 */
  summary: Record<string, unknown>;
}
export interface JobDef {
  key: string;
  label: string;
  description: string;
  /** 5 欄 cron（香港時間）。 */
  defaultSchedule: string;
  run(ctx: JobContext): Promise<JobResult>;
}
