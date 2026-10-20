// HIST-1：歷史月份（2026-07 前）——可上載更表＋對數＋落更（shift_records 含 leave SL／AL），但唔跑月結／糧／介紹費／鎖月，排程 job 跳過。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { POST as createMonthClose } from "@/app/api/month-closes/route";
import { PATCH as patchMonthClose } from "@/app/api/month-closes/[id]/route";
import { POST as lockMonth } from "@/app/api/month-closes/[id]/lock/route";
import { POST as oneClickPost } from "@/app/api/month-close/one-click/route";
import { GET as pendingSummary } from "@/app/api/roster-uploads/pending-summary/route";
import { applyReconcileDecisions } from "@/lib/roster-upload/reconcile-apply";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";
import { runAutoOneClick, autoOneClickJob, AUTO_ONE_CLICK_KEY } from "@/lib/jobs/auto-one-click";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { mergeJobState } from "@/lib/scheduler/state";
import { buildMonthHealth } from "@/lib/ops/month-health";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { isHistoricalMonth, markHistoricalMonth, HIST_MAX_MONTH } from "@/lib/month-close/historical";
import { ONE_CLICK_ADVISORY_LOCK_KEY } from "@/lib/month-close/one-click-lock";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

const MAY = new Date(Date.UTC(2026, 4, 1));
const jsonReq = (url: string, cookie: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

async function buildXlsx(siteName: string, y: number, m: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(y));
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(y, m - 1, 1));
  for (const [c, v] of [["A5", "Broker"], ["B5", "Time"], ["C5", "Rank"], ["D5", "Staff No."], ["E5", "Tel"], ["F5", "Name"]] as const) ws.getCell(c).value = v;
  ws.getCell("A6").value = "TEST-BA";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = "T-A01";
  ws.getCell("E6").value = "6100001";
  ws.getCell("F6").value = "測試保安員甲";
  ws.getCell("G6").value = "N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("HIST-1 歷史月份", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function mkUploadWithRows(month: Date) {
    const day = (d: number) => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), d));
    const up = await prisma.rosterUpload.create({
      data: { month, siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: "hist1.xlsx", fileSha256: "h".repeat(64), fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed" },
    });
    const row = (rowIndex: number, d: Date, rawCode: string, codeKind: "shift" | "leave", shiftTypeId: string | null) =>
      prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex, workDate: d, rawCode, codeKind, shiftTypeId, resolvedSiteId: fx.site.id, guardId: fx.guardA.id, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerA.id, brokerCodeRaw: "TEST-BA" } });
    await row(1, day(2), "N", "shift", fx.shiftType.id);
    await row(1, day(3), "SL", "leave", null);
    await row(1, day(4), "SL", "leave", null);
    await row(1, day(5), "AL", "leave", null);
    return up;
  }

  it("冇 month_closes 行嘅舊月份（2026-05）：上載 201、對數套用落更（含 SL／AL），冇自動開 month_closes／一鍵結算 run／介紹費", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(await buildXlsx(fx.site.name, 2026, 5))], "may.xlsx"));
    form.set("month", "2026-05");
    const res = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
    expect(res.status).toBe(201);
    expect(await prisma.rosterUpload.count({ where: { month: MAY } })).toBe(1);

    const MAR = new Date(Date.UTC(2026, 2, 1)); // 另一個舊月份做對數套用（避免同 5 月 xlsx 上載同盤同月版本序列混淆）
    const up = await mkUploadWithRows(MAR);
    const { items } = await reconcileUpload(up.id);
    const actions = items.filter((i) => i.category !== "match" && i.category !== "unresolved").map((i) => ({ key: i.key, action: "apply_roster" as const }));
    const r = await applyReconcileDecisions({ uploadId: up.id, actions, actorUserId: fx.userIds["老闆"], ip: null });
    expect(r.results.every((x) => x.ok)).toBe(true);
    const leaves = await prisma.shiftRecord.findMany({ where: { guardId: fx.guardA.id, workDate: { gte: MAR, lte: new Date(Date.UTC(2026, 2, 31)) }, recordType: "leave" }, select: { leaveCode: true, workDate: true }, orderBy: { workDate: "asc" } });
    expect(leaves.map((l) => l.leaveCode)).toEqual(["SL", "SL", "AL"]);
    expect(await prisma.monthClose.count({ where: { month: { in: [MAY, MAR] } } })).toBe(0);
    expect(await prisma.monthCloseRun.count({ where: { month: { in: [MAY, MAR] } } })).toBe(0);
    expect(await prisma.specialItem.count({ where: { month: { in: [MAY, MAR] } } })).toBe(0);
    expect(await isHistoricalMonth(MAY)).toBe(false);
  });

  it("POST /api/month-closes { historical:true } 標記；已有未鎖空行就地標記；已鎖月 409", async () => {
    const r1 = await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-05", historical: true }));
    expect(r1.status).toBe(201);
    expect((await r1.json()).historical).toBe(true);
    expect(await isHistoricalMonth(MAY)).toBe(true);
    // 已有行（未鎖、冇 run）→ 就地標記
    const apr = new Date(Date.UTC(2026, 3, 1));
    await prisma.monthClose.create({ data: { month: apr } });
    const r2 = await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-04", historical: true }));
    expect(r2.status).toBe(200);
    expect((await prisma.monthClose.findUniqueOrThrow({ where: { month: apr } })).historical).toBe(true);
    // 已鎖月（fixture 2026-06）→ 409
    const r3 = await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-06", historical: true }));
    expect(r3.status).toBe(409);
    expect((await prisma.monthClose.findUniqueOrThrow({ where: { month: fx.lockedMonth } })).historical).toBe(false);
    // 做過一鍵結算 run 嘅月份 → 409
    const jul = new Date(Date.UTC(2026, 6, 1));
    await prisma.monthClose.create({ data: { month: jul } });
    await prisma.monthCloseRun.create({ data: { month: jul, status: "done", startedById: fx.userIds["老闆"] } });
    expect((await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-07", historical: true }))).status).toBe(409);
  });

  it("歷史月份：一鍵結算 POST 409 historical_month；鎖月 409；月結健康／長工糧計算 throw 409；冇任何副作用", async () => {
    await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-05", historical: true }));
    const mc = await prisma.monthClose.findUniqueOrThrow({ where: { month: MAY } });
    const oc = await oneClickPost(jsonReq("http://test.local/api/month-close/one-click", cookie, { month: "2026-05" }));
    expect(oc.status).toBe(409);
    expect((await oc.json()).error).toBe("historical_month");
    const lk = await lockMonth(jsonReq(`http://test.local/api/month-closes/${mc.id}/lock`, cookie, {}), { params: Promise.resolve({ id: mc.id }) });
    expect(lk.status).toBe(409);
    expect((await lk.json()).error).toBe("historical_month");
    expect((await prisma.monthClose.findUniqueOrThrow({ where: { id: mc.id } })).lockedAt).toBeNull();
    await expect(buildMonthHealth(MAY, { userId: fx.userIds["老闆"] } as unknown as AuthedSession)).rejects.toMatchObject({ code: "historical_month" });
    await expect(recomputeLongtermPayroll(MAY, fx.userIds["老闆"])).rejects.toMatchObject({ code: "historical_month" });
    expect(await prisma.monthCloseRun.count({ where: { month: MAY } })).toBe(0);
    expect(await prisma.longtermPayrollRun.count({ where: { month: MAY } })).toBe(0);
  });

  it("auto_one_click 排程：歷史月份有 parsed 上載都 skipped=historical，唔開 run；非歷史月照舊觸發", async () => {
    const NOW = new Date();
    await ensureJobRows([autoOneClickJob], NOW);
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: {} });
    await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-05", historical: true }));
    const old = new Date(NOW.getTime() - 60 * 60_000);
    const mk = (month: Date) => prisma.rosterUpload.create({ data: { month, siteNameRaw: "A1", uploaderUserId: fx.userIds["老闆"], fileName: `${month.toISOString()}.xlsx`, fileSha256: "0".repeat(64), fileBytes: new Uint8Array(Buffer.from("fake")), fileSize: 4, status: "parsed", uploadedAt: old } });
    await mk(MAY);
    const DEC = new Date(Date.UTC(2026, 11, 1));
    await mk(DEC);
    const r = await runAutoOneClick(NOW);
    const sum = r.summary as { skipped: Record<string, string>; triggered: Record<string, unknown> };
    expect(sum.skipped["2026-05"]).toBe("historical");
    expect(Object.keys(sum.triggered)).toEqual(["2026-12"]);
    expect(await prisma.monthCloseRun.count({ where: { month: MAY } })).toBe(0);
  });

  it("待對數總覽（pending-summary）唔計歷史月份；明確指定嗰個月照出", async () => {
    await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-05", historical: true }));
    await mkUploadWithRows(MAY);
    const get = async (qs: string) => (await (await pendingSummary(new Request(`http://test.local/api/roster-uploads/pending-summary${qs}`, { headers: { cookie } }))).json()) as { entries: { month: string }[]; total: number };
    expect((await get("?months=0")).entries).toHaveLength(0);
    expect((await get("?month=2026-05")).entries.length).toBeGreaterThan(0);
  });

  it("HIST-1.1 M1：只可標早過 HIST_MAX_MONTH（2026-07-01）——新建同就地標記兩條路都擋 7 月及之後；有未作廢長工糧 run 擋，已作廢嘅唔擋", async () => {
    expect(HIST_MAX_MONTH.toISOString().slice(0, 10)).toBe("2026-07-01");
    for (const m of ["2026-07", "2026-08", "2027-01"]) {
      expect((await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: m, historical: true }))).status, `新建 ${m}`).toBe(409);
      await prisma.monthClose.create({ data: { month: new Date(`${m}-01T00:00:00Z`) } });
      expect((await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: m, historical: true }))).status, `就地 ${m}`).toBe(409);
    }
    // 6 月前：有未作廢長工糧 run → 409；作廢咗 → 可標
    const apr = new Date(Date.UTC(2026, 3, 1));
    const run = await prisma.longtermPayrollRun.create({ data: { month: apr, status: "computed", createdBy: fx.userIds["老闆"] } });
    expect((await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-04", historical: true }))).status).toBe(409);
    await prisma.longtermPayrollRun.update({ where: { id: run.id }, data: { voidedAt: new Date(), status: "void" } });
    expect((await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-04", historical: true }))).status).toBe(201);
  });

  it("HIST-1.1：標記同一鍵結算共用 advisory lock——有人持鎖（模擬一鍵結算開 run 中）時標記要等；放鎖後先完成", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const gotLock = new Promise<void>((r) => (acquired = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${ONE_CLICK_ADVISORY_LOCK_KEY})`);
      acquired();
      await held;
    });
    await gotLock;
    let done = false;
    const marking = markHistoricalMonth(MAY, fx.userIds["老闆"]!, { ip: null }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await marking).row.historical).toBe(true);
  });

  it("HIST-1.1：PATCH { historical:false } 取消標記（老闆專用、寫 audit）；非老闆 403；非歷史 409；其他 body 400；取消後排程唔再跳過", async () => {
    await createMonthClose(jsonReq("http://test.local/api/month-closes", cookie, { month: "2026-05", historical: true }));
    const mc = await prisma.monthClose.findUniqueOrThrow({ where: { month: MAY } });
    const patch = (c: string, body: unknown) => patchMonthClose(new Request(`http://test.local/api/month-closes/${mc.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: mc.id }) });
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    expect((await patch(acc, { historical: false })).status).toBe(403);
    expect((await patch(cookie, { historical: true })).status).toBe(400);
    expect((await patch(cookie, { historical: false, locked: true })).status).toBe(400);
    const r = await patch(cookie, { historical: false });
    expect(r.status).toBe(200);
    expect((await r.json()).historical).toBe(false);
    expect(await isHistoricalMonth(MAY)).toBe(false);
    const audits = await prisma.auditLog.findMany({ where: { tableName: "month_closes", rowId: mc.id, action: "update" } });
    expect(audits.some((a) => (a.after as { historical?: boolean } | null)?.historical === false)).toBe(true);
    expect((await patch(cookie, { historical: false })).status).toBe(409); // 已唔係歷史
  });
});
