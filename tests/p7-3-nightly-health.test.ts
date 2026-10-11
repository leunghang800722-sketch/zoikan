// P7.3：每晚體檢——新紅項先通知（dedupe）、全綠＋月結完成→可以鎖月、已鎖月份跳過、唯讀。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import type { MonthHealth } from "@/lib/ops/month-health";

const { mockHealth } = vi.hoisted(() => ({ mockHealth: { fn: null as null | ((month: Date) => unknown) } }));
vi.mock("@/lib/ops/month-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/month-health")>();
  return {
    ...actual,
    buildMonthHealth: async (month: Date, session: Parameters<typeof actual.buildMonthHealth>[1]) => (mockHealth.fn ? mockHealth.fn(month) : actual.buildMonthHealth(month, session)),
  };
});

import { runNightlyMonthHealth } from "@/lib/jobs/nightly-month-health";

const hk = (s: string) => new Date(`${s}+08:00`);
function health(month: Date, findings: Array<{ code: string; severity: "critical" | "warn" | "info"; count: number }>): MonthHealth {
  const label = month.toISOString().slice(0, 7);
  const f = findings.map((x) => ({ ...x, message: "含盤名嘅訊息不應入通知", fixLink: "/", requires: [], detail: [{ site_name: "秘密盤名" }], detailTruncated: false }));
  return {
    month: label,
    prevMonth: "x",
    hasPrev: true,
    summary: { critical: f.filter((x) => x.severity === "critical").length, warn: f.filter((x) => x.severity === "warn").length, info: f.filter((x) => x.severity === "info").length, total: f.length },
    findings: f,
  };
}

describe("P7.3 nightly_month_health", () => {
  let fx: Wp2Fixture;
  const NOW = hk("2026-10-11T21:00:00");
  const CUR = new Date(Date.UTC(2026, 9, 1));
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    mockHealth.fn = null;
  });

  it("真 buildMonthHealth 跑得通（唯讀）：本月＋未鎖上月都有結果，冇寫任何業務表", async () => {
    const before = await prisma.shiftRecord.count();
    const r = await runNightlyMonthHealth(NOW);
    expect(Object.keys((r.summary as { months: object }).months).sort()).toEqual(["2026-09", "2026-10"]);
    expect(await prisma.shiftRecord.count()).toBe(before);
  });

  it("新紅項先通知；同樣紅項第二晚唔再通知；多一項才再通知", async () => {
    mockHealth.fn = (m) => health(m, [{ code: "unpriced_client", severity: "critical", count: 5 }, { code: "x_info", severity: "info", count: 9 }]);
    await runNightlyMonthHealth(NOW);
    // 每次 run 要有一筆 ok 紀錄，下次先比較得（runJob 會寫；呢度模擬）
    const saveRun = async (summary: unknown) => prisma.jobRun.create({ data: { jobKey: "nightly_month_health", trigger: "schedule", status: "ok", finishedAt: new Date(), summary: summary as object } });
    const r1 = await runNightlyMonthHealth(NOW);
    expect(r1.summary).toMatchObject({ new_red: 2 }); // 未存紀錄＝兩個月都係新
    await saveRun(r1.summary);
    const n1 = await prisma.appNotification.findMany({ where: { kind: "month_health_red" } });
    expect(n1).toHaveLength(2); // 2026-09、2026-10 各一條
    expect(n1.every((n) => n.body.includes("unpriced_client ×5") && !n.body.includes("秘密盤名"))).toBe(true);

    const r2 = await runNightlyMonthHealth(hk("2026-10-12T21:00:00"));
    expect(r2.summary).toMatchObject({ new_red: 0 });
    await saveRun(r2.summary);
    expect(await prisma.appNotification.count({ where: { kind: "month_health_red" } })).toBe(2);

    mockHealth.fn = (m) => health(m, [{ code: "unpriced_client", severity: "critical", count: 5 }, { code: "overlap_same_day", severity: "critical", count: 1 }]);
    const r3 = await runNightlyMonthHealth(hk("2026-10-13T21:00:00"));
    expect(r3.summary).toMatchObject({ new_red: 2 }); // 兩個月各 1 項新
    const all = await prisma.appNotification.findMany({ where: { kind: "month_health_red" } });
    expect(all).toHaveLength(4);
    expect(all.some((n) => n.title.includes("1 項新紅項"))).toBe(true);
  });

  it("全綠＋一鍵結算 run done → 可以鎖月（只通知一次）；run 未完成／仍有警告唔通知", async () => {
    mockHealth.fn = (m) => health(m, []);
    await runNightlyMonthHealth(NOW);
    expect(await prisma.appNotification.count({ where: { kind: "month_ready_to_lock" } })).toBe(0); // 冇 run
    await prisma.monthCloseRun.create({ data: { month: CUR, status: "running", startedById: fx.userIds["老闆"] } });
    await runNightlyMonthHealth(NOW);
    expect(await prisma.appNotification.count({ where: { kind: "month_ready_to_lock" } })).toBe(0); // run 未 done
    await prisma.monthCloseRun.create({ data: { month: CUR, status: "done", startedById: fx.userIds["老闆"], startedAt: new Date(Date.now() + 1000) } });
    mockHealth.fn = (m) => health(m, [{ code: "w", severity: "warn", count: 1 }]);
    await runNightlyMonthHealth(NOW);
    expect(await prisma.appNotification.count({ where: { kind: "month_ready_to_lock" } })).toBe(0); // 有警告
    mockHealth.fn = (m) => health(m, []);
    await runNightlyMonthHealth(NOW);
    await runNightlyMonthHealth(hk("2026-10-12T21:00:00"));
    const n = await prisma.appNotification.findMany({ where: { kind: "month_ready_to_lock" } });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: "2026-10 可以鎖月", audience: ["老闆"], dedupeKey: "month_ready_to_lock:2026-10" });
  });

  it("已鎖月份唔跑體檢", async () => {
    await prisma.monthClose.create({ data: { month: CUR, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    const seen: string[] = [];
    mockHealth.fn = (m) => {
      seen.push(m.toISOString().slice(0, 7));
      return health(m, []);
    };
    await runNightlyMonthHealth(NOW);
    expect(seen).toEqual(["2026-09"]);
  });
});
