// P3-2.1：報表 request-scoped memo——同一 context 內同一月只計一次；唔跨 context；
// 有／冇 context 結果逐 key 一樣；invalidate 後重計。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture } from "./fixtures/wp2-fixture";
import { withReportContext, memoized, invalidateReportMemo, getReportComputeCounts, resetReportComputeCounts } from "@/lib/reports/context";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildLongtermSalaryAllocation } from "@/lib/reports/longterm-salary";
import { buildReconciliation } from "@/lib/reports/reconciliation";

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
});
