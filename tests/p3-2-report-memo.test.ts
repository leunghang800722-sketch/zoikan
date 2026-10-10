// P3-2.1：報表 request-scoped memo——同一 context 內同一月只計一次；唔跨 context；
// 有／冇 context 結果逐 key 一樣；invalidate 後重計。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture } from "./fixtures/wp2-fixture";
import * as ctx from "@/lib/reports/context";
import { withReportContext, memoized, currentReportMemoStore, invalidateReportMemo, getReportComputeCounts, resetReportComputeCounts } from "@/lib/reports/context";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildLongtermSalaryAllocation } from "@/lib/reports/longterm-salary";
import { buildReconciliation } from "@/lib/reports/reconciliation";
import { prisma } from "@/lib/db";
import { runOneClickMonthClose } from "@/lib/month-close/one-click";

const M = new Date(Date.UTC(2026, 7, 1));

async function allReports() {
  const [close, margin, payroll] = await Promise.all([buildMonthlyClose(M), buildGrossMargin(M), buildPayrollTotals(M)]);
  const alloc = await buildLongtermSalaryAllocation(M);
  return { close, margin, payroll, alloc: { total: alloc.totalAllocatable, bySite: [...alloc.bySite.entries()], missing: alloc.missingSalary } };
}

describe("P3-2.1 報表 request-scoped memo", () => {
  beforeEach(async () => {
    await clearAll();
    await seedWp2Fixture();
    resetReportComputeCounts();
  });

  it("冇 context：每次都直接計（行為不變）", async () => {
    await buildMonthlyClose(M);
    await buildMonthlyClose(M);
    expect(getReportComputeCounts().close).toBe(2);
  });

  it("同一 context：buildMonthlyClose＋buildGrossMargin（內嵌 close）＋reconciliation 只計 1 次 close", async () => {
    await withReportContext(async () => {
      await Promise.all([buildMonthlyClose(M), buildGrossMargin(M)]);
      await buildReconciliation(M); // rule1／rule3 各自叫 close
      await buildMonthlyClose(M);
    });
    const c = getReportComputeCounts();
    expect(c.close).toBe(1);
    expect(c.margin).toBe(1);
    expect(c.ltsalary).toBe(1);
  });

  it("有 context 同冇 context 結果逐 key 一樣", async () => {
    const plain = await allReports();
    const memo = await withReportContext(allReports);
    expect(JSON.parse(JSON.stringify(memo))).toEqual(JSON.parse(JSON.stringify(plain)));
  });

  it("唔跨 context／request：兩個 context 各計一次", async () => {
    await withReportContext(() => buildMonthlyClose(M));
    await withReportContext(() => buildMonthlyClose(M));
    expect(getReportComputeCounts().close).toBe(2);
  });

  it("巢狀 context 開全新 Map；invalidate 後重計；不同月份／threshold 唔共用", async () => {
    await withReportContext(async () => {
      await buildMonthlyClose(M);
      await withReportContext(() => buildMonthlyClose(M));
      expect(getReportComputeCounts().close).toBe(2);
      invalidateReportMemo();
      await buildMonthlyClose(M);
      expect(getReportComputeCounts().close).toBe(3);
      await buildMonthlyClose(new Date(Date.UTC(2026, 8, 1)));
      expect(getReportComputeCounts().close).toBe(4);
      await buildGrossMargin(M, { thresholdPct: 8 });
      await buildGrossMargin(M, { thresholdPct: 20 });
      expect(getReportComputeCounts().margin).toBe(2);
    });
  });

  it("memoized：reject 唔跨 context 殘留；同 key 共用同一 Promise", async () => {
    await withReportContext(async () => {
      let n = 0;
      const f = () => memoized("x:1", async () => ++n);
      const [a, b] = await Promise.all([f(), f()]);
      expect([a, b, n]).toEqual([1, 1, 1]);
    });
  });

  it("背景 one-click run 唔會讀到發起 request 嘅 memo（毒值入 ambient memo，run 照樣成功且 report 用真數）", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    const sept = new Date(Date.UTC(2026, 8, 1));
    const run = await prisma.monthCloseRun.create({ data: { month: sept, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    await withReportContext(async () => {
      // 模擬發起 request 嘅 ambient memo：同 key 放一個形狀錯嘅毒值（若 run 讀到，.mainRows 會 throw → run failed）
      for (const m of [sept, fx.unlockedMonth]) {
        await memoized(`close:${m.toISOString()}`, async () => ({ poison: true }));
        await memoized(`margin:${m.toISOString()}:8`, async () => ({ poison: true }));
        await memoized(`payroll:${m.toISOString()}`, async () => "poison");
      }
      await runOneClickMonthClose(run.id, sept, fx.userIds["老闆"], null);
    });
    const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("done");
    expect(JSON.stringify(after.reportJson)).not.toContain("poison");
  });

  it("one-click run 開自己嘅全新 memo context（讀 als.getStore()：run 內每次 memoized 見到嘅 store ≠ 發起 request 嘅 store）", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    const sept = new Date(Date.UTC(2026, 8, 1));
    const run = await prisma.monthCloseRun.create({ data: { month: sept, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const dbSpyOriginal = prisma.monthCloseRun.update.bind(prisma.monthCloseRun);
    const events: Array<{ kind: "ctx" | "memo" | "db"; store: Map<string, Promise<unknown>> | undefined }> = [];
    const originalMemoized = ctx.memoized;
    const originalWith = ctx.withReportContext;
    const memoSpy = vi.spyOn(ctx, "memoized").mockImplementation(((key: string, fn: () => Promise<unknown>) => {
      events.push({ kind: "memo", store: currentReportMemoStore() });
      return originalMemoized(key, fn);
    }) as typeof ctx.memoized);
    const withSpy = vi.spyOn(ctx, "withReportContext").mockImplementation(((fn: () => Promise<unknown>) => {
      return originalWith(() => {
        events.push({ kind: "ctx", store: currentReportMemoStore() }); // 新 context 內嘅 store
        return fn();
      });
    }) as typeof ctx.withReportContext);
    // run 一開始寫 DB（更新 run 進度）之前，就必須已經開咗自己嘅 context——用 DB 寫入做時間標記。
    const dbSpy = vi.spyOn(prisma.monthCloseRun, "update").mockImplementation(((args: unknown) => {
      events.push({ kind: "db", store: currentReportMemoStore() });
      return (dbSpyOriginal as (a: unknown) => unknown)(args);
    }) as never);
    try {
      await withReportContext(async () => {
        const outer = currentReportMemoStore();
        expect(outer).toBeDefined();
        events.length = 0; // 唔計測試自己開嘅 outer context
        await runOneClickMonthClose(run.id, sept, fx.userIds["老闆"], null);
        expect(events.some((e) => e.kind === "memo")).toBe(true); // run 真係用過 memo
        // 第一個動作必須係「開新 context」，之後每次 memoized 見到嘅 store 都唔係發起 request 嗰個
        expect(events.some((e) => e.kind === "db")).toBe(true);
        expect(events[0]!.kind).toBe("ctx"); // 開新 context 先於任何 DB 寫入同 memo
        expect(events[0]!.store).not.toBe(outer);
        expect(events.every((e) => e.store !== undefined && e.store !== outer)).toBe(true);
        expect(outer!.size).toBe(0); // run 冇污染發起 request 嘅 store
      });
    } finally {
      memoSpy.mockRestore();
      withSpy.mockRestore();
      dbSpy.mockRestore();
    }
  });
});
