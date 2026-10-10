// P3-2.1：用 SQL 簽名量度「同一月報表被重複計幾多次」（有／冇 memo 都量得到，before/after 同一把尺）。
//   buildMonthlyClose 嘅第一條查詢＝`sites ORDER BY canonical_name`（無 where）→ 每次實際計算 1 條；
//   buildGrossMargin 嘅 monthly_fixed 盤查詢（billing_model=monthly_fixed AND monthly_fee IS NOT NULL）→ 每次 1 條。
// P3_COUNT_ONLY=1（搬去 before 基準 worktree 跑）：只印數字，唔斷言。
import { describe, it, expect, beforeEach, vi } from "vitest";

const queries = await vi.hoisted(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const list: string[] = [];
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on("query", (q) => list.push(q.query));
  (globalThis as unknown as { prisma: unknown }).prisma = client;
  return list;
});
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { POST as generate } from "@/app/api/month-closes/[id]/generate/route";
import { GET as grossMargin } from "@/app/api/reports/gross-margin/route";
import { GET as monthlyClose } from "@/app/api/reports/monthly-close/route";
import { runOneClickMonthClose } from "@/lib/month-close/one-click";

const COUNT_ONLY = process.env.P3_COUNT_ONLY === "1";
const closes = () => queries.filter((q) => q.includes('FROM "public"."sites" WHERE 1=1 ORDER BY "public"."sites"."canonical_name" ASC')).length;
const margins = () => queries.filter((q) => q.includes('"billing_model" =') && q.includes('"monthly_fee" IS NOT NULL')).length;
function mark() {
  return { l: closes(), m: margins() };
}
function closesSince(a: { l: number; m: number }) {
  return { close: closes() - a.l, margin: margins() - a.m };
}
const report = (name: string, v: unknown) => console.log(`P3COUNT ${name} ${JSON.stringify(v)}`);

describe("P3-2.1 報表重複計算次數", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("月結工作台 generate route", async () => {
    const a = mark();
    const res = await generate(new Request("http://t/api/month-closes/2026-08/generate", { method: "POST", headers: { cookie } }), { params: Promise.resolve({ id: "2026-08" }) });
    expect(res.status).toBe(200);
    const c = closesSince(a);
    report("generate", c);
    if (!COUNT_ONLY) expect(c.close).toBe(1);
  });

  it("月結工作台入頁：generate＋gross-margin 並行", async () => {
    const a = mark();
    const [g, m] = await Promise.all([
      generate(new Request("http://t/api/month-closes/2026-08/generate", { method: "POST", headers: { cookie } }), { params: Promise.resolve({ id: "2026-08" }) }),
      grossMargin(new Request("http://t/api/reports/gross-margin?month=2026-08", { headers: { cookie } })),
    ]);
    expect([g.status, m.status]).toEqual([200, 200]);
    const c = closesSince(a);
    report("workbench(generate+gross-margin)", c);
    if (!COUNT_ONLY) expect(c.close).toBe(2); // 每個 request 各 1 次（唔跨 request）：4 → 2
  });

  it("monthly-close route", async () => {
    const a = mark();
    expect((await monthlyClose(new Request("http://t/api/reports/monthly-close?month=2026-08", { headers: { cookie } }))).status).toBe(200);
    const c = closesSince(a);
    report("monthly-close route", c);
    if (!COUNT_ONLY) expect(c.close).toBe(1);
  });

  it("一鍵結算整個 run（8 月鎖定、9 月計）", async () => {
    await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const sept = new Date(Date.UTC(2026, 8, 1));
    const run = await prisma.monthCloseRun.create({ data: { month: sept, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const a = mark();
    await runOneClickMonthClose(run.id, sept, fx.userIds["老闆"], null);
    const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    const c = closesSince(a);
    report("one-click run", { status: after.status, ...c });
    expect(after.status).toBe("done");
    if (!COUNT_ONLY) expect(c.close).toBeLessThanOrEqual(2); // 9 月 1 次（compute＋report 共用）＋體檢上月 1 次
  });
});
