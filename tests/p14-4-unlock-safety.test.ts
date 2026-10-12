// P14.4：解鎖舊月份（7、8 月）做銀行對數期間，各排程 job 對舊月份嘅行為。
// - auto_one_click：曾解鎖而冇新上載 → 唔重跑（新增安全條件）；解鎖後有新上載 → 照舊觸發
// - longterm_input_drafts：只處理上月＋本月
// - open_next_month：目標＝下個月，唔掂舊月
// - nightly_month_health：只體檢本月＋未鎖上月，唯讀
// （after_lock_exports／lock_ops_digest 重鎖時會重出檔：見 tests/p8-3-*.test.ts「解鎖再鎖 → 重新生成」，可接受。）
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runAutoOneClick, autoOneClickJob, AUTO_ONE_CLICK_KEY } from "@/lib/jobs/auto-one-click";
import { runLongtermInputDrafts } from "@/lib/jobs/longterm-input-drafts";
import { openNextMonthJob } from "@/lib/jobs/open-next-month";
import { runNightlyMonthHealth } from "@/lib/jobs/nightly-month-health";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { mergeJobState } from "@/lib/scheduler/state";

const DEC = new Date(Date.UTC(2026, 11, 1));
const AUG = new Date(Date.UTC(2026, 7, 1));
let NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("P14.4 解鎖期安全", () => {
  let fx: Wp2Fixture;
  async function upload(month: Date, at: Date) {
    const bytes = Buffer.from("fake");
    return prisma.rosterUpload.create({ data: { month, siteNameRaw: "A1", uploaderUserId: fx.userIds["老闆"], fileName: "A1.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array(bytes), fileSize: bytes.length, status: "parsed", uploadedAt: at } });
  }
  async function markUnlocked(month: Date, at: Date) {
    const mc = await prisma.monthClose.upsert({ where: { month }, create: { month, createdBy: "test" }, update: { lockedAt: null } });
    await prisma.auditLog.create({ data: { actorUserId: fx.userIds["老闆"], tableName: "month_closes", rowId: mc.id, action: "unlock_month", createdAt: at } });
  }
  beforeEach(async () => {
    NOW = new Date();
    await clearAll();
    fx = await seedWp2Fixture();
    await ensureJobRows([autoOneClickJob], NOW);
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: {} });
  });

  it("auto_one_click：曾解鎖、冇新上載（上載舊過解鎖）→ 唔重跑", async () => {
    await upload(DEC, minsAgo(60));
    await markUnlocked(DEC, minsAgo(5));
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "reopened_no_new_upload" });
    expect(await prisma.monthCloseRun.count()).toBe(0);
  });

  it("auto_one_click：解鎖後有新上載 → 照舊觸發；從未解鎖嘅月份行為不變", async () => {
    await upload(DEC, minsAgo(15));
    await markUnlocked(DEC, minsAgo(60));
    const r = await runAutoOneClick(NOW);
    expect(Object.keys((r.summary as { triggered: object }).triggered)).toEqual(["2026-12"]);
    expect(await prisma.monthCloseRun.count({ where: { month: DEC } })).toBe(1);
  });

  it("longterm_input_drafts：只處理上月＋本月（舊月份即使未鎖都唔掂）", async () => {
    await prisma.monthClose.upsert({ where: { month: AUG }, create: { month: AUG, createdBy: "test" }, update: { lockedAt: null } });
    const r = await runLongtermInputDrafts(new Date("2026-10-12T04:00:00Z"));
    expect(Object.keys((r.summary as { months: object }).months).sort()).toEqual(["2026-09", "2026-10"]);
  });

  it("open_next_month：目標係下個月，唔掂已解鎖舊月", async () => {
    const drBefore = await prisma.dailyRequirement.count({ where: { workDate: { gte: AUG, lt: new Date(Date.UTC(2026, 8, 1)) } } });
    const r = await openNextMonthJob.run({ jobKey: "open_next_month", trigger: "manual", now: new Date("2026-10-25T01:00:00Z") });
    expect((r.summary as { month?: string }).month ?? "2026-11").toBe("2026-11");
    expect(await prisma.dailyRequirement.count({ where: { workDate: { gte: AUG, lt: new Date(Date.UTC(2026, 8, 1)) } } })).toBe(drBefore);
    expect(await prisma.dailyRequirement.count({ where: { workDate: { lt: new Date(Date.UTC(2026, 10, 1)), gte: new Date(Date.UTC(2026, 9, 1)) } } })).toBe(0);
  });

  it("nightly_month_health：只體檢本月＋上月，舊月份唔入（唯讀）", async () => {
    const auditBefore = await prisma.auditLog.count();
    const r = await runNightlyMonthHealth(new Date("2026-10-12T04:00:00Z"));
    expect(Object.keys((r.summary as { months: object }).months).sort()).toEqual(["2026-09", "2026-10"]);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
  });
});
