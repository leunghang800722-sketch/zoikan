// P7.1：排程器——tick 冪等、advisory lock 防重跑、認領、失敗通知、開關。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { tick, runJob, ensureJobRows, sweepStaleRuns } from "@/lib/scheduler/runner";
import { withJobLock } from "@/lib/scheduler/lock";
import { isSchedulerEnabled } from "@/lib/scheduler/start";
import { isValidCron } from "@/lib/scheduler/cron";
import type { JobDef } from "@/lib/scheduler/types";
import { JOBS } from "@/lib/jobs/registry";

function def(key: string, run: JobDef["run"], schedule = "0 9 * * *"): JobDef {
  return { key, label: key, description: "t", defaultSchedule: schedule, run };
}
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const hk = (s: string) => new Date(`${s}+08:00`);

describe("P7.1 scheduler", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("ensureJobRows：建立設定行（有 next_run_at），再跑唔會覆蓋已改嘅 schedule／enabled", async () => {
    const now = hk("2026-10-11T08:00:00");
    const d = def("t_ensure", async () => ({ summary: {} }));
    await ensureJobRows([d], now);
    let row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_ensure" } });
    expect(row.nextRunAt).toEqual(hk("2026-10-11T09:00:00"));
    await prisma.scheduledJob.update({ where: { jobKey: "t_ensure" }, data: { schedule: "0 10 * * *", enabled: false } });
    await ensureJobRows([d], now);
    row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_ensure" } });
    expect(row.schedule).toBe("0 10 * * *");
    expect(row.enabled).toBe(false);
  });

  it("registry 全部 job 都有合法預設 cron", () => {
    expect(JOBS.map((j) => j.key).sort()).toEqual(["after_lock_exports", "auto_one_click", "lock_ops_digest", "longterm_input_drafts", "nightly_month_health", "open_next_month", "permit_expiry_weekly", "triage_evidence_cleanup", "triage_reminder", "whatsapp_daily_summary", "whatsapp_health", "whatsapp_parse", "whatsapp_retention"]);
    for (const j of JOBS) expect(isValidCron(j.defaultSchedule)).toBe(true);
  });

  it("tick：到期跑一次；同一時間再 tick 冪等（跑 0 次）；之後下次時間再跑", async () => {
    let calls = 0;
    const d = def("t_tick", async () => {
      calls++;
      return { summary: { n: calls } };
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    expect(await tick([d], hk("2026-10-11T08:59:00"))).toBe(0);
    expect(await tick([d], hk("2026-10-11T09:00:05"))).toBe(1);
    expect(await tick([d], hk("2026-10-11T09:00:30"))).toBe(0); // 冪等
    expect(calls).toBe(1);
    const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_tick" } });
    expect(row.nextRunAt).toEqual(hk("2026-10-12T09:00:00"));
    expect(row.lastStatus).toBe("ok");
    expect(await tick([d], hk("2026-10-12T09:01:00"))).toBe(1);
    expect(calls).toBe(2);
    const runs = await prisma.jobRun.findMany({ where: { jobKey: "t_tick" } });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "ok" && r.trigger === "schedule" && r.finishedAt)).toBe(true);
  });

  it("停用嘅 job 唔跑", async () => {
    let calls = 0;
    const d = def("t_disabled", async () => {
      calls++;
      return { summary: {} };
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    await prisma.scheduledJob.update({ where: { jobKey: "t_disabled" }, data: { enabled: false } });
    expect(await tick([d], hk("2026-10-11T10:00:00"))).toBe(0);
    expect(calls).toBe(0);
  });

  it("兩個並發 tick（模擬兩個 instance）：只跑一次", async () => {
    let calls = 0;
    const d = def("t_conc_tick", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 300));
      return { summary: {} };
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    const now = hk("2026-10-11T09:00:05");
    const [a, b] = await Promise.all([tick([d], now), tick([d], now)]);
    expect(a + b).toBe(1);
    expect(calls).toBe(1);
  });

  it("advisory lock：手動 run-now 同時撞第二次 → skipped_locked，handler 只跑一次", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = def("t_lock", async () => {
      calls++;
      await gate;
      return { summary: { ok: true } };
    });
    await ensureJobRows([d]);
    const first = runJob(d, { trigger: "manual" });
    await new Promise((r) => setTimeout(r, 200)); // 令第一個攞到 lock
    const second = await runJob(d, { trigger: "manual" });
    expect(second.outcome).toBe("skipped_locked");
    release();
    const r1 = await first;
    expect(r1.outcome).toBe("ran");
    expect(calls).toBe(1);
    const skipped = await prisma.jobRun.findMany({ where: { jobKey: "t_lock", status: "skipped" } });
    expect(skipped).toHaveLength(1);
    // lock 已釋放：再跑得
    expect((await runJob(d, { trigger: "manual" })).outcome).toBe("ran");
  });

  it("job 拋錯：status=error、last_error 記錄、1 小時後重試、通知老闆 job_failed（唔含錯誤全文）", async () => {
    const d = def("t_fail", async () => {
      throw new Error("boom-secret-detail");
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    expect(await tick([d], hk("2026-10-11T09:00:05"))).toBe(1);
    const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_fail" } });
    expect(row.lastStatus).toBe("error");
    expect(row.lastError).toContain("boom");
    expect(row.nextRunAt).toEqual(hk("2026-10-11T10:00:05")); // 失敗 → 1 小時後重試（早過下次排程）
    const n = await prisma.appNotification.findFirstOrThrow({ where: { kind: "job_failed" } });
    expect(n.audience).toEqual(["老闆"]);
    expect(n.body).not.toContain("boom");
  });

  it("manual 跑：唔改 next_run_at；未知 job 回 unknown_job", async () => {
    const d = def("t_manual", async () => ({ summary: { x: 1 } }));
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    const before = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_manual" } });
    const r = await runJob(d, { trigger: "manual", now: hk("2026-10-11T08:10:00") });
    expect(r.outcome).toBe("ran");
    const after = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_manual" } });
    expect(after.nextRunAt).toEqual(before.nextRunAt);
    expect(after.lastRunAt).not.toBeNull();
    expect((await runJob(undefined, { trigger: "manual" })).outcome).toBe("unknown_job");
  });

  it("sweepStaleRuns：>1 小時仲 running 嘅紀錄變 error", async () => {
    const old = await prisma.jobRun.create({ data: { jobKey: "t_stale", trigger: "schedule", status: "running", startedAt: new Date(Date.now() - 2 * 3600_000) } });
    const fresh = await prisma.jobRun.create({ data: { jobKey: "t_stale", trigger: "schedule", status: "running" } });
    expect(await sweepStaleRuns()).toBe(1);
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("error");
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("running");
  });

  it("SCHEDULER_ENABLED 解析：明確 0／1；冇設＝production 開、其他關", () => {
    expect(isSchedulerEnabled(env({ SCHEDULER_ENABLED: "0", NODE_ENV: "production" }))).toBe(false);
    expect(isSchedulerEnabled(env({ SCHEDULER_ENABLED: "false" }))).toBe(false);
    expect(isSchedulerEnabled(env({ SCHEDULER_ENABLED: "1", NODE_ENV: "development" }))).toBe(true);
    expect(isSchedulerEnabled(env({ NODE_ENV: "production" }))).toBe(true);
    expect(isSchedulerEnabled(env({ NODE_ENV: "development" }))).toBe(false);
    expect(isSchedulerEnabled(env({ NODE_ENV: "test" }))).toBe(false);
  });

  it("失敗重試：1 小時後再跑，最多 3 次重試；第 4 次失敗後等下個排程", async () => {
    let calls = 0;
    const d = def("t_retry", async () => {
      calls++;
      throw new Error("x");
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    let now = hk("2026-10-11T09:00:05");
    for (let i = 0; i < 4; i++) {
      expect(await tick([d], now)).toBe(1);
      const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_retry" } });
      if (i < 3) expect(row.nextRunAt).toEqual(new Date(now.getTime() + 3600_000));
      else expect(row.nextRunAt).toEqual(hk("2026-10-12T09:00:00")); // 重試用晒 → 等下個排程
      now = new Date(now.getTime() + 3600_000 + 1000);
    }
    expect(calls).toBe(4);
    expect(await tick([d], now)).toBe(0);
  });

  it("重試成功後恢復正常排程；手動失敗唔重排", async () => {
    let fail = true;
    const d = def("t_retry_ok", async () => {
      if (fail) throw new Error("x");
      return { summary: {} };
    });
    await ensureJobRows([d], hk("2026-10-11T08:00:00"));
    await tick([d], hk("2026-10-11T09:00:05"));
    fail = false;
    expect(await tick([d], hk("2026-10-11T10:00:10"))).toBe(1);
    expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_retry_ok" } })).nextRunAt).toEqual(hk("2026-10-12T09:00:00"));
    fail = true;
    const before = (await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_retry_ok" } })).nextRunAt;
    await runJob(d, { trigger: "manual" });
    expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_retry_ok" } })).nextRunAt).toEqual(before);
  });

  it("超時：記 timeout、通知老闆、tick 繼續；底層 job 未完前 lock 仍持有（run-now／重試 skipped_locked），完成後先可再跑", async () => {
    const prev = process.env.JOB_TIMEOUT_MS;
    process.env.JOB_TIMEOUT_MS = "200";
    try {
      let otherRan = 0;
      let slowCalls = 0;
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      const slow = def("t_slow", async () => {
        slowCalls++;
        await gate;
        return { summary: {} };
      });
      const other = def("t_other", async () => {
        otherRan++;
        return { summary: {} };
      });
      await ensureJobRows([slow, other], hk("2026-10-11T08:00:00"));
      const t0 = Date.now();
      expect(await tick([slow, other], hk("2026-10-11T09:00:05"))).toBe(2);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(otherRan).toBe(1);
      expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { jobKey: "t_slow" } })).lastStatus).toBe("timeout");
      expect((await prisma.jobRun.findFirstOrThrow({ where: { jobKey: "t_slow" } })).status).toBe("timeout");
      expect((await prisma.appNotification.findFirstOrThrow({ where: { kind: "job_failed" } })).title).toBe("自動排程超時");
      // 底層 job 仍跑緊：lock 未釋放
      expect((await runJob(slow, { trigger: "manual" })).outcome).toBe("skipped_locked");
      expect((await withJobLock("t_slow", async () => 1)).acquired).toBe(false);
      expect(slowCalls).toBe(1);
      // 其他 job 唔受影響
      expect((await runJob(other, { trigger: "manual" })).outcome).toBe("ran");
      finish();
      await expect.poll(async () => (await withJobLock("t_slow", async () => 1)).acquired, { timeout: 3000 }).toBe(true);
      expect((await runJob(slow, { trigger: "manual" })).outcome).toBe("ran");
      expect(slowCalls).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.JOB_TIMEOUT_MS;
      else process.env.JOB_TIMEOUT_MS = prev;
    }
  });

  it("lock 連線字串：帶 Prisma ?schema=／sslmode 都連得到", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `${prev}?schema=public&sslmode=disable&connection_limit=3`;
    try {
      expect((await withJobLock("t_url", async () => 1)).acquired).toBe(true);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });
});
