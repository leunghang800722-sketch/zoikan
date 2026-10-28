// HIST-2 目標 2／3：歷史月份一鍵導入（API＋job）、reconcile-all 歷史月份跳過 reprice／Postorder 警告、
// create_minimal 起嘅人 status=inactive＋historical_roster 來源、更表 vs Postorder（Roster 分頁）逐盤比對。
// 合成 fixture（測試…名、T-／U9 工號、fakeTel），零真資料。
import { describe, it, expect, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";
import { fakeTel } from "./helpers/fake-tel";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";

vi.mock("@/lib/pricing/reprice", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/pricing/reprice")>();
  return { ...m, repriceMonthForSites: vi.fn(m.repriceMonthForSites) };
});

import { repriceMonthForSites } from "@/lib/pricing/reprice";
import { POST as startImport, GET as listImport } from "@/app/api/month-close/historical-import/route";
import { POST as startOneClick } from "@/app/api/month-close/one-click/route";
import { POST as rerunOneClick } from "@/app/api/month-close/one-click/[id]/rerun/route";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { POST as postPostorder } from "@/app/api/guard-fix/postorder/route";
import { runAutoOneClick, autoOneClickJob, AUTO_ONE_CLICK_KEY } from "@/lib/jobs/auto-one-click";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { mergeJobState } from "@/lib/scheduler/state";
import { markHistoricalMonth } from "@/lib/month-close/historical";
import { runHistoricalImport, claimHistoricalImportRun, rewriteTriageClaims, histImportRunStalled, type HistImportReport } from "@/lib/month-close/historical-import";
import { runReconcileAllForMonth } from "@/lib/roster-upload/reconcile-all";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan } from "@/lib/guard-fix/apply";
import { compareRosterVsPostorder, bucketUnresolvedReason } from "@/lib/month-close/historical-compare";
import { parsePostorderRosterRows } from "@/lib/month-close/auto/postorder-evidence";
import { gridFromCsvText } from "@/lib/guard-fix/postorder";

const MAR = new Date(Date.UTC(2026, 2, 1));
const AUG = new Date(Date.UTC(2026, 7, 1));
const jsonReq = (url: string, cookie: string, method: string, body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

async function rosterXlsx(opts: { sheet: string; site: string; month: number; people: Array<{ staffNo: string; tel: string; name: string; codes: string[] }> }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheet);
  ws.getCell("A2").value = opts.site;
  ws.getCell("F4").value = "Date";
  const ndays = opts.people[0]!.codes.length;
  for (let d = 0; d < ndays; d++) ws.getRow(4).getCell(7 + d).value = new Date(Date.UTC(2026, opts.month - 1, d + 1));
  for (const [c, v] of [["A5", "Broker"], ["B5", "Time"], ["C5", "Rank"], ["D5", "Staff No."], ["E5", "Tel"], ["F5", "Name"]] as const) ws.getCell(c).value = v;
  opts.people.forEach((p, i) => {
    const r = 6 + i;
    ws.getCell(`A${r}`).value = "TEST-BA";
    ws.getCell(`B${r}`).value = "0700-1900";
    ws.getCell(`C${r}`).value = "日更保安員";
    ws.getCell(`D${r}`).value = p.staffNo;
    ws.getCell(`E${r}`).value = p.tel;
    ws.getCell(`F${r}`).value = p.name;
    p.codes.forEach((code, d) => {
      ws.getRow(r).getCell(7 + d).value = code;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function staffListXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("sheet1");
  ws.getRow(1).getCell(14).value = "員工編號";
  ws.getRow(2).getCell(14).value = "U99001";
  ws.getRow(2).getCell(16).value = "測試名單人";
  ws.getRow(2).getCell(10).value = fakeTel();
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("HIST-2 reconcile-all：歷史月份跳過 reprice 同 Postorder 未套用警告", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    vi.mocked(repriceMonthForSites).mockClear();
  });

  async function seed(month: Date) {
    const up = await prisma.rosterUpload.create({
      data: { month, siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: "h2.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
    });
    await prisma.rosterUploadRow.create({
      data: { uploadId: up.id, rowIndex: 1, workDate: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 5)), rawCode: "N", codeKind: "shift", shiftTypeId: fx.shiftType.id, resolvedSiteId: fx.site.id, guardId: fx.guardA.id, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerA.id, brokerCodeRaw: "TEST-BA" },
    });
    await prisma.postorderUpload.create({ data: { month, uploaderId: fx.userIds["老闆"], fileName: "po.csv", fileSha256: `p-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1, rowCount: 0, status: "parsed" } });
  }

  it("歷史月份：唔 reprice、冇 Postorder 警告，照樣落更", async () => {
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
    await seed(MAR);
    const r = await runReconcileAllForMonth(MAR, fx.userIds["老闆"], null);
    expect(repriceMonthForSites).not.toHaveBeenCalled();
    expect(r.repriced).toEqual({ scanned: 0, changed: 0 });
    expect(r.warnings).toEqual([]);
    expect(r.totals.applied).toBe(1);
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 2, 5)) } })).toBe(1);
  });

  it("非歷史月份：照舊 reprice＋出 Postorder 未套用警告（回歸）", async () => {
    await seed(AUG);
    const r = await runReconcileAllForMonth(AUG, fx.userIds["老闆"], null);
    expect(repriceMonthForSites).toHaveBeenCalledTimes(1);
    expect(r.warnings.some((w) => w.includes("Postorder"))).toBe(true);
  });
});

describe("HIST-2 guard-fix：歷史導入建人", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("create_minimal 起嘅人 status=inactive、created_by／audit 標 historical_roster；非歷史照舊 active", async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } });
    await prisma.broker.create({ data: { code: "Y", name: "測試Y", kind: "internal_cash", settlementType: "cash", createdBy: "test" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試歷史盤", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const upload = await prisma.rosterUpload.create({ data: { month: MAR, siteId: site.id, siteNameRaw: "測試歷史盤", uploaderUserId: user.id, fileName: "t.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 } });
    const tel = fakeTel();
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 5, workDate: new Date("2026-03-04"), rawCode: "D", codeKind: "shift", resolvedSiteId: site.id, staffNoRaw: null, nameRaw: "測試歷史人甲", telRaw: tel, guardMatch: "unmatched" },
    });
    const plan = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: [{ uNumber: "U90002", nameZh: "測試歷史人甲", displayName: null, tel: fakeTel(), hkid: null, hkidNote: null, hireDate: null, employeeStatus: null }] });
    expect(plan.actions.createMinimal).toHaveLength(1);
    await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MAR, historicalRoster: true });
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試歷史人甲" }, include: { phones: true } });
    expect(g.status).toBe("inactive");
    expect(g.createdBy).toContain("historical_roster");
    expect(g.phones.every((p) => p.source === "historical_roster")).toBe(true);
    expect(await prisma.auditLog.count({ where: { rowId: g.id, action: "guard_fix_historical_roster" } })).toBe(1);

    // 對照：非歷史導入（冇 historicalRoster）照舊 active
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 6, workDate: new Date("2026-03-05"), rawCode: "D", codeKind: "shift", resolvedSiteId: site.id, staffNoRaw: null, nameRaw: "測試歷史人乙", telRaw: fakeTel(), guardMatch: "unmatched" },
    });
    const plan2 = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: [{ uNumber: "U90003", nameZh: "測試歷史人乙", displayName: null, tel: fakeTel(), hkid: null, hkidNote: null, hireDate: null, employeeStatus: null }] });
    await applyGuardFixPlan({ prisma, plan: plan2, planOnly: false, month: MAR });
    expect((await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試歷史人乙" } })).status).toBe("active");
  });
});

describe("HIST-2 純函數", () => {
  it("bucketUnresolvedReason：多原因逐類歸", () => {
    expect(bucketUnresolvedReason("保安員未配對")).toEqual(["guard_unmatched"]);
    expect(bucketUnresolvedReason("格仔日期 2026-02-28 唔係上載月份（2026-03），唔可以寫入；保安員未配對").sort()).toEqual(["date_outside_month", "guard_unmatched"]);
    expect(bucketUnresolvedReason("更別未配對")).toEqual(["shift_type_unmatched"]);
    expect(bucketUnresolvedReason("上載未指定盤（site_id 未定），請先喺更表上載列表頁指定盤")).toEqual(["site_unresolved"]);
    expect(bucketUnresolvedReason("雞頭碼「X」對唔到任何雞頭，請先")).toEqual(["broker_code_unmatched"]);
    expect(bucketUnresolvedReason("")).toEqual(["other"]);
  });

  it("rewriteTriageClaims：唔再聲稱已入分診", () => {
    const out = rewriteTriageClaims(["未配對保安員（1）：X，共 3 格（已入分診，預填建議答案，一撳確認）", "盤名對唔到——已入分診"]);
    expect(out.join("")).not.toContain("已入分診");
    expect(out.join("")).not.toContain("一撳確認");
  });

  it("histImportRunStalled：running 超過 30 分鐘先算卡死", () => {
    const now = new Date();
    expect(histImportRunStalled({ status: "running", applyStartedAt: new Date(now.getTime() - 31 * 60_000) }, now)).toBe(true);
    expect(histImportRunStalled({ status: "running", applyStartedAt: new Date(now.getTime() - 16 * 60_000) }, now)).toBe(false);
    expect(histImportRunStalled({ status: "failed", applyStartedAt: new Date(now.getTime() - 60 * 60_000) }, now)).toBe(false);
  });

  it("Roster CSV 逐崗位行數有人日數＋更表 vs Postorder 逐盤比對", () => {
    const hdr = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "2026-03-01", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "2026-03-02", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid"];
    const row = (client: string, prop: string, shift: string, d1: string, d2: string) => [client, "", prop, shift, "900", "800", "0700-1900", prop, d1, "", "", "", "", "", prop, d2, "", "", "", "", ""];
    const rows = [
      ["", "", "", "", "", "", "", "2026-03-01", "", "", "", "", "", "", "2026-03-02"],
      ["", "", "", "", "", "", "", "Sun", "雞頭更數"],
      hdr,
      row("測試甲樓 保安乙", "甲樓", "Day", "(1) 公司兵", "(1) 公司兵"),
      row("測試甲樓", "甲樓", "Night", "(2) 淦", ""),
      row("測試乙樓", "乙樓", "Day", "", "(1) 公司兵"),
      row("測試丙樓", "丙樓", "Day", "(1) 公司兵", ""),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const parsed = parsePostorderRosterRows(gridFromCsvText(csv), MAR);
    expect(parsed.map((p) => p.cells)).toEqual([2, 1, 1, 1]);
    const cmp = compareRosterVsPostorder(
      [
        { label: "測試甲樓", names: ["測試甲樓"], cells: 3 },
        { label: "測試乙樓", names: ["測試乙樓"], cells: 2 },
        { label: "測試沒有樓", names: ["測試沒有樓"], cells: 4 },
      ],
      parsed,
    );
    expect(cmp.perSite[0]).toMatchObject({ rosterCells: 3, postorderCells: 3, diff: 0 });
    expect(cmp.perSite[1]).toMatchObject({ rosterCells: 2, postorderCells: 1, diff: 1 });
    expect(cmp.perSite[2]).toMatchObject({ postorderCells: null, diff: null });
    expect(cmp.unmatchedPostorder).toEqual([{ property: "丙樓", cells: 1 }]);
    expect(cmp.totals).toMatchObject({ matchedSites: 2, unmatchedSites: 1, sitesWithDiff: 1 });
  });
});

describe("HIST-2 POST/GET /api/month-close/historical-import", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("RBAC：雞頭 403；主管 GET 得 POST 403", async () => {
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await startImport(jsonReq("http://x/api/month-close/historical-import", broker, "POST", { month: "2026-03" }))).status).toBe(403);
    const sup = await sessionCookieForUser(fx.userIds["主管"]);
    expect((await listImport(jsonReq("http://x/api/month-close/historical-import?month=2026-03", sup, "GET"))).status).toBe(200);
    expect((await startImport(jsonReq("http://x/api/month-close/historical-import", sup, "POST", { month: "2026-03" }))).status).toBe(403);
  });

  it("M1：歷史導入 run 未卡死 → 一鍵結算 POST 同 rerun 都 409 busy；卡死（>30 分鐘）先放行", async () => {
    const hist = await prisma.historicalImportRun.create({ data: { month: MAR, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const res = await startOneClick(jsonReq("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
    expect(res.status).toBe(409);
    expect(await prisma.monthCloseRun.count()).toBe(0);
    const failed = await prisma.monthCloseRun.create({ data: { month: new Date(Date.UTC(2026, 8, 1)), status: "failed", startedById: fx.userIds["老闆"] } });
    const rr = await rerunOneClick(jsonReq(`http://x/api/month-close/one-click/${failed.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: failed.id }) });
    expect(rr.status).toBe(409);
    expect((await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("failed");
    // 25 分鐘仲未算卡死（門檻 30 分鐘）
    await prisma.historicalImportRun.update({ where: { id: hist.id }, data: { applyStartedAt: new Date(Date.now() - 25 * 60_000) } });
    expect((await startOneClick(jsonReq("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }))).status).toBe(409);
    await prisma.historicalImportRun.update({ where: { id: hist.id }, data: { applyStartedAt: new Date(Date.now() - 35 * 60_000) } });
    expect((await startOneClick(jsonReq("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }))).status).not.toBe(409);
  });

  it("M1：排程自動一鍵結算（runAutoOneClick）見到未卡死歷史導入 run → skipped busy", async () => {
    const NOW = new Date();
    await ensureJobRows([autoOneClickJob], NOW);
    await mergeJobState(AUTO_ONE_CLICK_KEY, { last_trigger_upload_at: {} });
    const DEC = new Date(Date.UTC(2026, 11, 1));
    await prisma.rosterUpload.create({ data: { month: DEC, siteNameRaw: "A1", uploaderUserId: fx.userIds["老闆"], fileName: "dec.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array(Buffer.from("fake")), fileSize: 4, status: "parsed", uploadedAt: new Date(NOW.getTime() - 60 * 60_000) } });
    await prisma.historicalImportRun.create({ data: { month: MAR, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const r = await runAutoOneClick(NOW);
    expect((r.summary as { skipped: Record<string, string> }).skipped["2026-12"]).toBe("busy");
    expect(await prisma.monthCloseRun.count()).toBe(0);
  });

  it("非歷史月份 409 not_historical_month；冇 month 400", async () => {
    const res = await startImport(jsonReq("http://x/api/month-close/historical-import", cookie, "POST", { month: "2026-03" }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("not_historical_month");
    expect((await startImport(jsonReq("http://x/api/month-close/historical-import", cookie, "POST", {}))).status).toBe(400);
  });

  it("另一個未卡死 run 擋住新 run（busy）；卡死 run 唔擋", async () => {
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
    await prisma.historicalImportRun.create({ data: { month: MAR, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    await expect(claimHistoricalImportRun(MAR, fx.userIds["老闆"])).rejects.toMatchObject({ status: 409 });
    await prisma.historicalImportRun.updateMany({ data: { applyStartedAt: new Date(Date.now() - 35 * 60_000) } });
    await expect(claimHistoricalImportRun(MAR, fx.userIds["老闆"])).resolves.toBeTruthy();
  });

  it("端到端：1–3 月 YYYYMM 分頁名更表 → 自動建盤＋更種、保安員修復、對數落更、報告只有數字", async () => {
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
    await prisma.staffListUpload.create({ data: { uploaderId: fx.userIds["老闆"], fileName: "u.xlsx", fileSha256: "u", fileBytes: new Uint8Array(await staffListXlsx()), fileSize: 10, rowCount: 1, status: "parsed" } });
    const mtel = fakeTel();
    // 現有保安員（T-A01，by staff no）＋ 一個全新人（名單入面冇、冇工號）
    const bytes = await rosterXlsx({
      sheet: "202603",
      site: "測試歷史新盤",
      month: 3,
      people: [
        { staffNo: "T-A01", tel: "6100001", name: "測試保安員甲", codes: ["D", "D", "RD"] },
        { staffNo: "", tel: mtel, name: "測試歷史新人", codes: ["D", "", "D"] },
      ],
    });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "hist-new.xlsx"));
    form.set("month", "2026-03");
    const up = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
    expect(up.status).toBe(201);
    expect(await prisma.rosterUpload.count({ where: { month: MAR, status: "parsed" } })).toBe(1);

    const runId = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await runHistoricalImport(runId, MAR, fx.userIds["老闆"], null);
    const run = await prisma.historicalImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorMessage).toBeNull();
    expect(run.status).toBe("done");
    const report = run.reportJson as unknown as HistImportReport;
    expect(report.month).toBe("2026-03");
    expect(report.created.sites).toBe(1);
    expect(report.created.shiftTypes).toBe(1);
    expect(report.created.guards).toBe(1);
    expect(report.totals.cells).toBe(5); // 甲 3 格（D D RD）＋新人 2 格（空格唔計）
    expect(report.totals.written).toBeGreaterThanOrEqual(3); // 甲嘅三格（含 RD）至少落咗
    expect(report.perSite).toHaveLength(1);
    expect(report.perSite[0]!.siteLabel).toBe("測試歷史新盤");
    expect(report.postorder).toEqual({ uploaded: false });
    // 新人（名單入面冇）→ create_minimal，inactive＋historical_roster
    const created = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試歷史新人" } });
    expect(created.status).toBe("inactive");
    expect(created.createdBy).toContain("historical_roster");
    // 報告 JSON 冇姓名／電話
    const json = JSON.stringify(run.stepsJson) + JSON.stringify(run.reportJson);
    expect(json).not.toContain("測試保安員甲");
    expect(json).not.toContain("測試歷史新人");
    expect(json).not.toContain(mtel);
    // 冇動過一鍵結算 run、冇鎖、冇 reprice
    expect(await prisma.monthCloseRun.count({ where: { month: MAR } })).toBe(0);
    // 冪等：再跑一次，寫入數不變
    const written = await prisma.shiftRecord.count({ where: { workDate: { gte: MAR, lt: new Date(Date.UTC(2026, 3, 1)) } } });
    const runId2 = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await runHistoricalImport(runId2, MAR, fx.userIds["老闆"], null);
    expect(await prisma.shiftRecord.count({ where: { workDate: { gte: MAR, lt: new Date(Date.UTC(2026, 3, 1)) } } })).toBe(written);
    expect(await prisma.guard.count({ where: { nameZh: "測試歷史新人" } })).toBe(1);
  });

  it("Postorder CSV 路徑喺歷史月份照常上載（parsed），報告有「更表 vs Postorder」逐盤格數", async () => {
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
    const bytes = await rosterXlsx({ sheet: "202603", site: "測試歷史新盤", month: 3, people: [{ staffNo: "T-A01", tel: "6100001", name: "測試保安員甲", codes: ["D", "D", "D"] }] });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "hist-new.xlsx"));
    form.set("month", "2026-03");
    expect((await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }))).status).toBe(201);

    const hdr = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", "2026-03-01", "雞頭名", "備註", "其他", "救更價", "Unbilled", "Paid", "2026-03-02", "雞頭名", "備註"];
    const row = (d1: string, d2: string) => ["測試歷史新盤", "", "歷新", "Day", "900", "800", "0700-1900", "歷新", d1, "", "", "", "", "", "歷新", d2, ""];
    const rosterCsv = [["", "", "", "", "", "", "", "2026-03-01"], ["", "", "", "", "", "", "", "Sun", "雞頭更數"], hdr, row("(1) 公司兵", "(1) 公司兵"), row("(1) 公司兵", "")].map((r) => r.join(",")).join("\n");
    const poCsv = [["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間"], ["測試歷史新盤", "", "歷新", "Day", "900", "800", "0700-1900"]].map((r) => r.join(",")).join("\n");
    const pf = new FormData();
    pf.set("month", "2026-03");
    pf.set("roster_csv", new File([rosterCsv], "Roster.csv"));
    pf.set("postorder_csv", new File([poCsv], "PostOrder.csv"));
    const poRes = await postPostorder(new Request("http://test.local/api/guard-fix/postorder", { method: "POST", headers: { cookie }, body: pf }));
    expect(poRes.status).toBe(201);
    const poBody = (await poRes.json()) as { parse_ok: boolean };
    expect(poBody.parse_ok).toBe(true);

    const runId = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await runHistoricalImport(runId, MAR, fx.userIds["老闆"], null);
    const run = await prisma.historicalImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("done");
    const report = run.reportJson as unknown as HistImportReport;
    expect(report.postorder.uploaded).toBe(true);
    if (!report.postorder.uploaded) return;
    expect(report.postorder.perSite).toEqual([{ label: "測試歷史新盤", rosterCells: 3, postorderCells: 3, postorderRows: 2, diff: 0 }]);
  });
});
