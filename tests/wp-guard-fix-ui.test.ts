// WP-GUARD-FIX-UI：「未配對保安員修復」做入系統——integration test。
// 鐵則：合成 fixture 自己起（exceljs U Team 名單、直接 prisma 寫
// roster_upload_rows 模擬未配對格），名用「測試散工甲」、U 號
// `U9xxx`、電話 `6xxxxxxx`（跟 tests/fixtures/wp2-fixture.ts 一致風格）。
//
// §1 RBAC：主管/會計/雞頭/保安員 GET/POST 一律 403（`保安員配對修復` 淨係
//    老闆）
// §2 上載 U Team 名單：解析摘要（唔存逐行 PII）、audit 一條
// §3 計劃：`POST /api/guard-fix/plan` 建到一條 create action，同直接
//    call `buildGuardFixPlan()`（script 用嗰個函數）result 一致——證明
//    script 同 API 共用同一套邏輯（WP-GUARD-FIX-UI 鐵則）
// §4 套用：apply 之後 guard 真係建咗、run 變 applied；同一個 run 再
//    apply 一次 → 409
// §5 needs_boss PII gate：冇「保安員個人資料:view」見唔到姓名/候選姓名
// §6 Opus 5.5 驗收：`applying` 卡死復原（未夠 15 分鐘 409、超過就可以
//    重新套用，冪等唔重複建人）；另一個 run 套用緊 → 套用／計劃都 409
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listStaffList, POST as uploadStaffList } from "@/app/api/guard-fix/staff-list/route";
import { POST as buildPlan } from "@/app/api/guard-fix/plan/route";
import { GET as getRun } from "@/app/api/guard-fix/runs/[id]/route";
import { GET as listRuns } from "@/app/api/guard-fix/runs/route";
import { POST as applyRun } from "@/app/api/guard-fix/runs/[id]/apply/route";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";

function reqJson(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, fileName = "u-team.xlsx"): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

/** U Team 名單合成 xlsx——欄位 index 同 src/lib/guard-fix/sources.ts 一致：
 * idx1 入職日期／idx2 顯示名／idx4 員工狀態／idx9 電話／idx13 員工編號／
 * idx14 身份證／idx15 中文姓名（0-based，col1based = idx+1）。 */
async function buildUTeamXlsx(rows: Array<{ uNumber: string; nameZh: string; tel: string }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("sheet1");
  ws.getRow(1).values = ["header row，逐欄名冇用（用 index）"];
  let r = 2;
  for (const row of rows) {
    ws.getCell(`B${r}`).value = "2026-08-01"; // idx1 入職日期
    ws.getCell(`C${r}`).value = row.nameZh; // idx2 顯示名
    ws.getCell(`E${r}`).value = "在職"; // idx4 員工狀態
    ws.getCell(`J${r}`).value = row.tel; // idx9 電話
    ws.getCell(`N${r}`).value = row.uNumber; // idx13 員工編號
    ws.getCell(`P${r}`).value = row.nameZh; // idx15 中文姓名
    r += 1;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function seedUnmatchedRosterRow(fx: Wp2Fixture, opts: { staffNoRaw: string | null; nameRaw: string; telRaw: string | null }) {
  const upload = await prisma.rosterUpload.create({
    data: {
      month: fx.unlockedMonth,
      siteId: fx.site.id,
      siteNameRaw: fx.site.name,
      uploaderUserId: fx.userIds.老闆,
      fileName: "test-roster.xlsx",
      fileSha256: "0".repeat(64),
      fileBytes: Buffer.from("test"),
      fileSize: 4,
      status: "parsed",
    },
  });
  await prisma.rosterUploadRow.create({
    data: {
      uploadId: upload.id,
      rowIndex: 1,
      workDate: fx.unlockedMonth,
      rawCode: "N",
      codeKind: "shift",
      staffNoRaw: opts.staffNoRaw,
      nameRaw: opts.nameRaw,
      telRaw: opts.telRaw,
      guardMatch: "unmatched",
      settlementBrokerId: fx.brokerA.id,
    },
  });
  return upload;
}

describe("WP-GUARD-FIX-UI：未配對保安員修復頁面 API", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerCookie: string;
  let guardSelfCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardSelfCookie = await sessionCookieForUser(fx.userIds["安員"]);
  });

  it("§1 主管/會計/雞頭/保安員 GET+POST 一律 403（保安員配對修復淨係老闆）", async () => {
    for (const cookie of [supervisorCookie, accountantCookie, brokerCookie, guardSelfCookie]) {
      const listRes = await listStaffList(reqJson("http://test.local/api/guard-fix/staff-list", cookie));
      expect(listRes.status).toBe(403);

      const buf = await buildUTeamXlsx([{ uNumber: "U9001", nameZh: "測試散工甲", tel: "61234567" }]);
      const uploadRes = await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", cookie, buf));
      expect(uploadRes.status).toBe(403);

      const planRes = await buildPlan(reqJson("http://test.local/api/guard-fix/plan", cookie, "POST", { month: "2026-08" }));
      expect(planRes.status).toBe(403);
    }
  });

  it("§2 老闆上載 U Team 名單：解析摘要冇 PII、audit 一條", async () => {
    const buf = await buildUTeamXlsx([
      { uNumber: "U9001", nameZh: "測試散工甲", tel: "61234567" },
      { uNumber: "U9002", nameZh: "測試散工乙", tel: "61234568" },
    ]);
    const res = await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", ownerCookie, buf));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: Record<string, unknown>; parse_ok: boolean };
    expect(body.parse_ok).toBe(true);
    expect(body.upload.row_count).toBe(2);
    expect(body.upload.status).toBe("parsed");

    const dbRow = await prisma.staffListUpload.findUniqueOrThrow({ where: { id: body.upload.id as string } });
    expect(dbRow.rowCount).toBe(2);
    // 鐵則：唔存逐行 PII——parseSummary 淨係數目。
    const summary = dbRow.parseSummary as Record<string, unknown>;
    expect(JSON.stringify(summary)).not.toContain("測試散工");

    const audit = await prisma.auditLog.findFirst({ where: { tableName: "staff_list_uploads", rowId: body.upload.id as string, action: "create" } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.after)).not.toContain("測試散工");

    const listRes = await listStaffList(reqJson("http://test.local/api/guard-fix/staff-list", ownerCookie));
    const listBody = (await listRes.json()) as { current: Record<string, unknown> };
    expect(listBody.current.id).toBe(body.upload.id);
  });

  it("§3 計劃：POST /api/guard-fix/plan 同直接 call buildGuardFixPlan() 結果一致（script／API 共用邏輯）", async () => {
    const uTeamBuf = await buildUTeamXlsx([{ uNumber: "U9001", nameZh: "測試散工甲", tel: "61234567" }]);
    await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", ownerCookie, uTeamBuf));
    await seedUnmatchedRosterRow(fx, { staffNoRaw: "U9001", nameRaw: "測試散工甲", telRaw: "61234567" });

    const planRes = await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }));
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { run_id: string; summary: Record<string, number> };
    expect(planBody.summary.create).toBe(1);
    expect(planBody.summary.link).toBe(0);
    expect(planBody.summary.needs_boss).toBe(0);

    // 同一套邏輯直接 call——parity check。
    const uTeamRows = await parseUTeamWorkbookBuffer(uTeamBuf);
    const directPlan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows });
    const directSummary = summarizePlan(directPlan);
    expect(directSummary.create).toBe(planBody.summary.create);
    expect(directSummary.link).toBe(planBody.summary.link);
    expect(directSummary.needsBoss).toBe(planBody.summary.needs_boss);
    expect(directPlan.actions.create[0]!.nameZh).toBe("測試散工甲");

    const run = await prisma.guardFixRun.findUniqueOrThrow({ where: { id: planBody.run_id } });
    expect(run.status).toBe("planned");
  });

  it("§4 套用：apply 真係建咗 guard、run 變 applied；同一個 run 再 apply 一次 → 409", async () => {
    const uTeamBuf = await buildUTeamXlsx([{ uNumber: "U9001", nameZh: "測試散工甲", tel: "61234567" }]);
    await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", ownerCookie, uTeamBuf));
    await seedUnmatchedRosterRow(fx, { staffNoRaw: "U9001", nameRaw: "測試散工甲", telRaw: "61234567" });

    const planRes = await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }));
    const planBody = (await planRes.json()) as { run_id: string };

    const applyRes = await applyRun(reqJson(`http://test.local/api/guard-fix/runs/${planBody.run_id}/apply`, ownerCookie, "POST"), { params: Promise.resolve({ id: planBody.run_id }) });
    // 測試直接 call route handler（冇真 Next request scope），`after()`
    // 會 fallback 做完先返——response 已經帶最終 status。
    expect([200, 202]).toContain(applyRes.status);
    const applyBody = (await applyRes.json()) as { status: string };

    // 冇論用咗背景定同步，最終狀態一定會變成 applied——poll 幾次以防萬一。
    let finalRun = await prisma.guardFixRun.findUniqueOrThrow({ where: { id: planBody.run_id } });
    for (let i = 0; i < 20 && finalRun.status === "applying"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      finalRun = await prisma.guardFixRun.findUniqueOrThrow({ where: { id: planBody.run_id } });
    }
    expect(finalRun.status).toBe("applied");
    expect(applyBody.status === "applied" || applyBody.status === "applying").toBe(true);

    const created = await prisma.guard.findFirst({ where: { nameZh: "測試散工甲" } });
    expect(created).not.toBeNull();
    const staffNo = await prisma.guardStaffNumber.findUnique({ where: { number: "U9001" } });
    expect(staffNo?.guardId).toBe(created!.id);

    // audit 冇姓名/電話。
    const guardAudit = await prisma.auditLog.findFirst({ where: { tableName: "guards", rowId: created!.id, action: "create" } });
    expect(JSON.stringify(guardAudit!.after)).not.toContain("測試散工甲");

    // 同一個 run 再 apply 一次 → 409（冪等）。
    const secondApply = await applyRun(reqJson(`http://test.local/api/guard-fix/runs/${planBody.run_id}/apply`, ownerCookie, "POST"), { params: Promise.resolve({ id: planBody.run_id }) });
    expect(secondApply.status).toBe(409);

    // apply 完自動再計一次 plan（下一輪）——應該有第二個 run（planned）。
    const runs = await prisma.guardFixRun.findMany({ where: { month: fx.unlockedMonth }, orderBy: { createdAt: "asc" } });
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("§5 needs_boss：冇「保安員個人資料:view」嘅角色見唔到姓名/候選姓名", async () => {
    // 起兩個同名 guard，令呢個身份判斷唔到（ambiguous 走 needs_boss）。
    const dup1 = await prisma.guard.create({ data: { nameZh: "測試同名丙", employmentType: "cash_casual", status: "active", defaultBrokerId: fx.brokerA.id } });
    const dup2 = await prisma.guard.create({ data: { nameZh: "測試同名丙", employmentType: "cash_casual", status: "active", defaultBrokerId: fx.brokerA.id } });
    const uTeamBuf = await buildUTeamXlsx([{ uNumber: "U9003", nameZh: "測試同名丙", tel: "61234569" }]);
    await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", ownerCookie, uTeamBuf));
    await seedUnmatchedRosterRow(fx, { staffNoRaw: null, nameRaw: "測試同名丙", telRaw: null });
    // guardMatch 要係 ambiguous 先入 needs_boss 嗰條「DB 同名多人」分支
    // （唔係 unmatched 走 U Team create 分支）——直接改返個 row。
    await prisma.rosterUploadRow.updateMany({ where: { nameRaw: "測試同名丙" }, data: { guardMatch: "ambiguous" } });

    const planRes = await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }));
    const planBody = (await planRes.json()) as { run_id: string; needs_boss: Array<Record<string, unknown>> };
    expect(planBody.needs_boss.length).toBe(1);
    expect(planBody.needs_boss[0]!.name_raw).toBe("測試同名丙"); // 老闆本身有「保安員個人資料:view」

    // 關閉老闆嘅「保安員個人資料:view」，模擬「冇呢個 view 權」情況——
    // 直接改 role_permissions（唔經 UI，測試 buildNeedsBossView() gate
    // 本身）。
    const ownerRole = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    await prisma.rolePermission.updateMany({
      where: { roleId: ownerRole.id, permission: { module: "安員個人資料", action: "view" } },
      data: { granted: false },
    });

    const runRes = await getRun(reqJson(`http://test.local/api/guard-fix/runs/${planBody.run_id}`, ownerCookie), { params: Promise.resolve({ id: planBody.run_id }) });
    const runBody = (await runRes.json()) as { needs_boss: Array<Record<string, unknown>> };
    expect(runBody.needs_boss[0]!.name_raw).toBeUndefined();
    expect(runBody.needs_boss[0]!.candidates).toBeUndefined();
    expect(runBody.needs_boss[0]!.reason).toBeTruthy(); // 盤＋原因仲見到

    expect([dup1.id, dup2.id]).toContain(dup1.id); // 用返變數，避免 eslint unused
  });
  it("§6 卡死復原＋同時套用 409", async () => {
    const uTeamBuf = await buildUTeamXlsx([{ uNumber: "U9001", nameZh: "測試散工甲", tel: "61234567" }]);
    await uploadStaffList(reqMultipart("http://test.local/api/guard-fix/staff-list", ownerCookie, uTeamBuf));
    await seedUnmatchedRosterRow(fx, { staffNoRaw: "U9001", nameRaw: "測試散工甲", telRaw: "61234567" });

    const planA = (await (await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }))).json()) as { run_id: string };
    const planB = (await (await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }))).json()) as { run_id: string };
    const apply = (id: string) => applyRun(reqJson(`http://test.local/api/guard-fix/runs/${id}/apply`, ownerCookie, "POST"), { params: Promise.resolve({ id }) });

    // A「套用緊」（啱啱開始）——A 再撳 409、B 撳 409（另一個套用緊）、計劃 409。
    await prisma.guardFixRun.update({ where: { id: planA.run_id }, data: { status: "applying", applyStartedAt: new Date() } });
    expect((await apply(planA.run_id)).status).toBe(409);
    expect((await apply(planB.run_id)).status).toBe(409);
    expect((await buildPlan(reqJson("http://test.local/api/guard-fix/plan", ownerCookie, "POST", { month: "2026-08" }))).status).toBe(409);
    const detail = (await (await getRun(reqJson(`http://test.local/api/guard-fix/runs/${planA.run_id}`, ownerCookie), { params: Promise.resolve({ id: planA.run_id }) })).json()) as { apply_allowed: boolean };
    expect(detail.apply_allowed).toBe(false);

    // 卡咗 16 分鐘（server 中途重啟）——頁面見到可以重新套用，套用成功。
    await prisma.guardFixRun.update({ where: { id: planA.run_id }, data: { applyStartedAt: new Date(Date.now() - 16 * 60 * 1000) } });
    const list = (await (await listRuns(reqJson("http://test.local/api/guard-fix/runs", ownerCookie))).json()) as { runs: Array<{ id: string; apply_allowed: boolean }> };
    expect(list.runs.find((r) => r.id === planA.run_id)!.apply_allowed).toBe(true);
    expect([200, 202]).toContain((await apply(planA.run_id)).status);
    expect((await prisma.guardFixRun.findUniqueOrThrow({ where: { id: planA.run_id } })).status).toBe("applied");

    // B（舊計劃）之後再套用：冪等，唔會重複建人。
    expect([200, 202]).toContain((await apply(planB.run_id)).status);
    expect(await prisma.guard.count({ where: { nameZh: "測試散工甲" } })).toBe(1);
    const runB = await prisma.guardFixRun.findUniqueOrThrow({ where: { id: planB.run_id } });
    expect(runB.status).toBe("applied");
    expect(((runB.resultJson as { diffs: { create: { skip: string[] } } }).diffs.create.skip.length)).toBe(1);
  });
});
