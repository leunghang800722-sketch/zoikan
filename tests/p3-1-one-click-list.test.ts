// P3-1.6：one-click 列表瘦身——預設摘要、?include=full 同舊版一樣、單一 run route。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listOneClick } from "@/app/api/month-close/one-click/route";
import { GET as getOneClickRun } from "@/app/api/month-close/one-click/[id]/route";

function get(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

describe("P3-1.6 one-click 列表", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  const month = new Date(Date.UTC(2026, 8, 1));
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function mkRun(over: Record<string, unknown> = {}) {
    const steps = [
      { key: "a", label: "A", status: "done", started_at: null, finished_at: null, numbers: {}, warnings: [], needs_human: [] },
      { key: "b", label: "B", status: "skipped", started_at: null, finished_at: null, numbers: {}, warnings: [], needs_human: [] },
      { key: "c", label: "C", status: "running", started_at: null, finished_at: null, numbers: {}, warnings: [], needs_human: [] },
    ];
    return prisma.monthCloseRun.create({
      data: {
        month,
        status: "done",
        startedById: fx.userIds["老闆"],
        applyStartedAt: new Date(),
        finishedAt: new Date(),
        currentStep: "c",
        stepsJson: steps,
        reportJson: { totals: { revenue: 1234.5, cost: 1000, gross_margin: 234.5 }, big: "x".repeat(5000) },
        ...over,
      } as never,
    });
  }

  it("預設只回摘要（冇 steps／report），帶 totals 同步驟數", async () => {
    const run = await mkRun();
    const body = (await (await listOneClick(get("http://t/api/month-close/one-click?month=2026-09", cookie))).json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs).toHaveLength(1);
    const r = body.runs[0]!;
    expect(r.id).toBe(run.id);
    expect("steps" in r).toBe(false);
    expect("report" in r).toBe(false);
    expect(r).toMatchObject({ month: "2026-09-01", status: "done", current_step: "c", stalled: false, error_message: null, steps_total: 3, steps_done: 2, totals: { revenue: 1234.5, cost: 1000, gross_margin: 234.5 } });
    expect(JSON.stringify(body).length).toBeLessThan(1000);
  });

  it("沒有報告／冇 month 參數：totals null、全部月份", async () => {
    await mkRun({ reportJson: null, stepsJson: [] });
    const body = (await (await listOneClick(get("http://t/api/month-close/one-click", cookie))).json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs[0]).toMatchObject({ totals: null, steps_total: 0, steps_done: 0 });
  });

  it("?include=full 同單一 run route 回舊版完整 shape（steps／report 一模一樣）", async () => {
    const run = await mkRun();
    const full = (await (await listOneClick(get("http://t/api/month-close/one-click?month=2026-09&include=full", cookie))).json()) as { runs: Array<Record<string, unknown>> };
    expect(Object.keys(full.runs[0]!)).toEqual(["id", "month", "status", "started_at", "finished_at", "current_step", "stalled", "steps", "report", "error_message"]);
    expect(full.runs[0]!.steps).toEqual(run.stepsJson);
    expect(full.runs[0]!.report).toEqual(run.reportJson);
    const single = (await (await getOneClickRun(get(`http://t/api/month-close/one-click/${run.id}`, cookie), { params: Promise.resolve({ id: run.id }) })).json()) as { run: Record<string, unknown> };
    expect(single.run).toEqual(full.runs[0]);
  });

  it("單一 run：不存在 404；雞頭 403；主管得", async () => {
    const run = await mkRun();
    const p = { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) };
    expect((await getOneClickRun(get("http://t/x", cookie), p)).status).toBe(404);
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await getOneClickRun(get("http://t/x", broker), { params: Promise.resolve({ id: run.id }) })).status).toBe(403);
    const sup = await sessionCookieForUser(fx.userIds["主管"]);
    expect((await getOneClickRun(get("http://t/x", sup), { params: Promise.resolve({ id: run.id }) })).status).toBe(200);
  });

  it("stalled：running 超過 15 分鐘", async () => {
    await mkRun({ status: "running", finishedAt: null, applyStartedAt: new Date(Date.now() - 20 * 60_000) });
    const body = (await (await listOneClick(get("http://t/api/month-close/one-click?month=2026-09", cookie))).json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs[0]!.stalled).toBe(true);
  });
});
