// P8.1：上載完自動跑一鍵結算——觸發條件逐個、同批只跑一次、人手 run 跑緊跳過、已鎖跳過、通知無 PII、audit by_job。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runAutoOneClick, autoOneClickJob, AUTO_ONE_CLICK_KEY } from "@/lib/jobs/auto-one-click";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { mergeJobState, readJobState } from "@/lib/scheduler/state";
import { ensureSystemUser } from "@/lib/system-user";
import { assertNoPii } from "@/lib/notify/create";

const DEC = new Date(Date.UTC(2026, 11, 1)); // 2026-12：上月（11 月）冇資料 → precheck 通過
const SEPT = new Date(Date.UTC(2026, 8, 1)); // 2026-09：上月（8 月）有資料未鎖 → precheck halt（失敗路徑）
// 用真實時間：month_close_runs.started_at 係 DB default now()，fake 時間會同佢錯位
let NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("P8.1 auto_one_click", () => {
  let fx: Wp2Fixture;
  async function upload(month: Date, at: Date, status: "parsed" | "uploaded" | "voided" = "parsed", name = "A1") {
    const bytes = Buffer.from("fake");
    return prisma.rosterUpload.create({
      data: { month, siteNameRaw: name, uploaderUserId: fx.userIds["老闆"], fileName: `${name}.xlsx`, fileSha256: "0".repeat(64), fileBytes: new Uint8Array(bytes), fileSize: bytes.length, status, uploadedAt: at },
    });
  }
  beforeEach(async () => {
    NOW = new Date();
    await clearAll();
    fx = await seedWp2Fixture();
    await ensureJobRows([autoOneClickJob], NOW);
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: {} }); // 已過首次 baseline（M2 另有測試）
  });

  it("上載靜置 ≥10 分鐘 → 跑一次一鍵結算，通知老闆＋會計，audit by_job", async () => {
    await upload(DEC, minsAgo(15));
    const r = await runAutoOneClick(NOW);
    expect(Object.keys((r.summary as { triggered: object }).triggered)).toEqual(["2026-12"]);
    const runs = await prisma.monthCloseRun.findMany({ where: { month: DEC } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    const ns = await prisma.appNotification.findMany({ where: { kind: "one_click_auto" } });
    expect(ns).toHaveLength(1);
    expect(ns[0]!.title).toBe("2026-12 一鍵結算已自動跑完");
    expect(ns[0]!.body).toMatch(/^2026-12 一鍵結算已自動跑完：\d+ 題要你答、未定價 \d+ 更。$/);
    expect(ns[0]!.href).toBe("/month-close?month=2026-12");
    expect(ns[0]!.audience).toEqual(["老闆", "會計"]);
    expect(() => assertNoPii(ns[0]!.title, ns[0]!.body)).not.toThrow();
    const sysId = await ensureSystemUser();
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_close_runs", rowId: runs[0]!.id, action: "create" } });
    expect(audit?.actorUserId).toBe(sysId);
    expect(runs[0]!.startedById).toBe(sysId);
    expect((audit?.after as Record<string, unknown>).by_job).toBe(AUTO_ONE_CLICK_KEY);
  });

  it("10 分鐘內仍有新檔 → 等齊先（settling），唔跑", async () => {
    await upload(DEC, minsAgo(30), "parsed", "A1");
    await upload(DEC, minsAgo(3), "parsed", "A2");
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "settling" });
    expect(await prisma.monthCloseRun.count()).toBe(0);
    expect(r.status).toBe("skipped");
  });

  it("仲有 uploaded（解析未完）嘅新檔 → 都要等", async () => {
    await upload(DEC, minsAgo(30), "parsed", "A1");
    await upload(DEC, minsAgo(2), "uploaded", "A2");
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "settling" });
  });

  it("同一批上載只跑一次；有新上載先再跑", async () => {
    await upload(DEC, minsAgo(60));
    await runAutoOneClick(NOW);
    await prisma.rosterUpload.updateMany({ data: { status: "parsed" } }); // 假檔 reparse 會變 parse_failed，還原
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const r2 = await runAutoOneClick(later);
    expect((r2.summary as { skipped: Record<string, string> }).skipped["2026-12"]).toMatch(/no_new_upload|already_triggered/);
    expect(await prisma.monthCloseRun.count({ where: { month: DEC } })).toBe(1);
    // 新檔（仍喺 NOW 之後 20 分鐘前）→ 再跑
    const t3 = new Date(NOW.getTime() + 60 * 60_000);
    await upload(DEC, new Date(t3.getTime() - 20 * 60_000), "parsed", "A9");
    await prisma.rosterUpload.updateMany({ data: { status: "parsed" } });
    const r3 = await runAutoOneClick(t3);
    expect(Object.keys((r3.summary as { triggered: object }).triggered)).toEqual(["2026-12"]);
    expect(await prisma.monthCloseRun.count({ where: { month: DEC } })).toBe(2);
  });

  it("state 記低 already_triggered：run 紀錄被清走都唔會重跑同一批", async () => {
    await upload(DEC, minsAgo(60));
    await runAutoOneClick(NOW);
    await prisma.monthCloseAutoChange.deleteMany({});
    await prisma.monthCloseRun.deleteMany({});
    await prisma.rosterUpload.updateMany({ data: { status: "parsed" } });
    const r = await runAutoOneClick(new Date(NOW.getTime() + 300_000));
    expect((r.summary as { skipped: Record<string, string> }).skipped["2026-12"]).toBe("already_triggered");
  });

  it("人手 run 跑緊 → 跳過", async () => {
    await upload(DEC, minsAgo(60));
    await prisma.monthCloseRun.create({ data: { month: DEC, status: "running", startedById: fx.userIds["老闆"], startedAt: minsAgo(70), applyStartedAt: minsAgo(1) } });
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "run_in_progress" });
    expect(await prisma.monthCloseRun.count()).toBe(1);
  });

  it("另一個月份有 run 跑緊（全域 busy）→ 跳過", async () => {
    await upload(DEC, minsAgo(60));
    await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: minsAgo(1) } });
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "busy" });
  });

  it("已鎖月份 → 跳過", async () => {
    await upload(DEC, minsAgo(60));
    await prisma.monthClose.create({ data: { month: DEC, lockedAt: minsAgo(500), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: object }).skipped).toEqual({ "2026-12": "locked" });
    expect(await prisma.monthCloseRun.count()).toBe(0);
  });

  it("冇 parsed 上載（只有 voided）→ 唔理", async () => {
    await upload(DEC, minsAgo(60), "voided");
    const r = await runAutoOneClick(NOW);
    expect(r.summary).toEqual({ triggered: {}, skipped: {} });
    expect(await prisma.monthCloseRun.count()).toBe(0);
  });

  it("precheck halt（上月未鎖）→ run failed，通知講原因一句，無 PII", async () => {
    await upload(SEPT, minsAgo(60));
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { triggered: Record<string, { status: string }> }).triggered["2026-09"]!.status).toBe("failed");
    const n = await prisma.appNotification.findFirst({ where: { kind: "one_click_auto" } });
    expect(n!.title).toBe("2026-09 一鍵結算自動執行未能完成");
    expect(n!.body).toContain("上月未鎖定");
    expect(() => assertNoPii(n!.title, n!.body)).not.toThrow();
  });

  it("M1：自動 run 嘅每一條 audit actor＝系統帳號且帶 by_job；冇一條掛老闆；分診 owner 規則", async () => {
    const before = new Set((await prisma.auditLog.findMany({ select: { id: true } })).map((a) => a.id));
    await upload(DEC, minsAgo(15));
    await runAutoOneClick(NOW);
    const sysId = await ensureSystemUser();
    const audits = (await prisma.auditLog.findMany()).filter((a) => !before.has(a.id));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const a of audits) {
      expect(a.actorUserId, `${a.tableName}:${a.action}`).toBe(sysId);
      expect((a.after as Record<string, unknown> | null)?.by_job, `${a.tableName}:${a.action}`).toBe(AUTO_ONE_CLICK_KEY);
    }
    const run = await prisma.monthCloseRun.findFirstOrThrow({ where: { month: DEC } });
    expect(run.startedById).toBe(sysId);
  });

  it("M1：分診 session owner＝該月最新上載者（有「一鍵結算:create」）；冇資格（雞頭／已停用）就系統帳號", async () => {
    const sysId = await ensureSystemUser();
    // 會計上載（有 create）→ owner＝會計
    const bytes = Buffer.from("fake");
    const mk = (uploader: string, at: Date) => prisma.rosterUpload.create({ data: { month: DEC, siteNameRaw: "A1", uploaderUserId: uploader, fileName: "a.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array(bytes), fileSize: bytes.length, status: "parsed", uploadedAt: at } });
    await mk(fx.userIds["會計"], minsAgo(20));
    const { __testPickOwner } = await import("@/lib/jobs/auto-one-click");
    expect(await __testPickOwner(DEC)).toBe(fx.userIds["會計"]);
    // 最新上載者係雞頭（冇一鍵結算:create）→ null（＝系統帳號）
    await mk(fx.userIds["雞頭"], minsAgo(12));
    expect(await __testPickOwner(DEC)).toBeNull();
    void sysId;
  });

  it("M1：老闆帳號全部停用，job 照跑（用系統帳號）", async () => {
    const bosses = await prisma.user.findMany({ where: { role: { baseRole: "老闆" }, status: "active" }, select: { id: true } });
    await ensureSystemUser();
    await prisma.user.updateMany({ where: { id: { in: bosses.map((b) => b.id) } }, data: { status: "inactive" } });
    try {
      await upload(DEC, minsAgo(15));
      const r = await runAutoOneClick(NOW);
      expect(Object.keys((r.summary as { triggered: object }).triggered)).toEqual(["2026-12"]);
      expect((await prisma.monthCloseRun.findFirstOrThrow({ where: { month: DEC } })).status).toBe("done");
    } finally {
      await prisma.user.updateMany({ where: { id: { in: bosses.map((b) => b.id) } }, data: { status: "active" } });
    }
  });

  it("M2：首次跑（state 空）唔觸發，只記 baseline；之後有新上載先跑", async () => {
    await prisma.scheduledJob.updateMany({ where: { jobKey: AUTO_ONE_CLICK_KEY }, data: { state: {} } });
    const first = await upload(DEC, minsAgo(60));
    const r = await runAutoOneClick(NOW);
    expect(r.status).toBe("skipped");
    expect((r.summary as { baseline: Record<string, string> }).baseline).toEqual({ "2026-12": first.uploadedAt.toISOString() });
    expect(await prisma.monthCloseRun.count()).toBe(0);
    expect((await readJobState(AUTO_ONE_CLICK_KEY)).last_trigger_upload_at).toEqual({ "2026-12": first.uploadedAt.toISOString() });
    // 同一批：之後亦唔觸發
    expect(Object.keys((await runAutoOneClick(new Date(NOW.getTime() + 300_000))).summary as object)).not.toContain("baseline");
    expect(await prisma.monthCloseRun.count()).toBe(0);
    // 有新上載 → 先跑
    const later = new Date(NOW.getTime() + 3600_000);
    await upload(DEC, new Date(later.getTime() - 20 * 60_000), "parsed", "A2");
    const r3 = await runAutoOneClick(later);
    expect(Object.keys((r3.summary as { triggered: object }).triggered)).toEqual(["2026-12"]);
  });
});
