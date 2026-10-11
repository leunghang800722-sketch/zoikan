// P7.3：待答題催辦——超過 2 日、重要題、通知負責人、每日 dedupe。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runTriageReminder } from "@/lib/jobs/triage-reminder";

const hk = (s: string) => new Date(`${s}+08:00`);
const NOW = hk("2026-10-11T09:00:00");
const ago = (days: number) => new Date(NOW.getTime() - days * 86400000);

describe("P7.3 triage_reminder", () => {
  let fx: Wp2Fixture;
  let n = 0;
  async function question(sessionId: string, opts: { kind?: string; status?: string; createdAt: Date }) {
    n++;
    return prisma.triageQuestion.create({ data: { sessionId, kind: opts.kind ?? "name_not_confirmed", groupKey: `g${n}`, title: "t", status: opts.status ?? "open", createdAt: opts.createdAt } });
  }
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("只通知負責人；補充類／新題／已答唔計；同日 dedupe，翌日再提醒", async () => {
    const a = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: "p7a", ownerUserId: fx.userIds["會計"], createdBy: "t" } });
    const b = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: "p7b", ownerUserId: fx.userIds["主管"], createdBy: "t" } });
    await question(a.id, { createdAt: ago(3) });
    await question(a.id, { createdAt: ago(5) });
    await question(a.id, { kind: "field_review", createdAt: ago(9) }); // 補充類，唔計
    await question(a.id, { createdAt: ago(1) }); // 未夠 2 日
    await question(b.id, { status: "answered", createdAt: ago(9) }); // 已答
    const r = await runTriageReminder(NOW);
    expect(r.summary).toMatchObject({ owners_notified: 1, stale_questions: 2 });
    const ns = await prisma.appNotification.findMany();
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ kind: "triage_reminder", audience: [fx.userIds["會計"]], href: "/triage", title: "2 題待答超過 2 日" });
    expect(ns[0]!.body).toContain("最舊 5 日");
    // 同日再跑：dedupe
    await runTriageReminder(hk("2026-10-11T09:30:00"));
    expect(await prisma.appNotification.count()).toBe(1);
    // 翌日再提醒
    await runTriageReminder(hk("2026-10-12T09:00:00"));
    expect(await prisma.appNotification.count()).toBe(2);
  });

  it("冇逾期題＝skipped，不產生通知", async () => {
    const r = await runTriageReminder(NOW);
    expect(r.status).toBe("skipped");
    expect(await prisma.appNotification.count()).toBe(0);
  });
});
