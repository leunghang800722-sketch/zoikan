// WP-UPLOAD-VOID（老闆 2026-09-25 要求）：更表上載記錄「作廢」
// integration test——正式站揀錯月份上載咗 8 月更表，之前 UI 完全冇刪
// 除／撤銷，錯誤記錄會一路留喺清單／會計首頁「待處理」／月結鎖定前置
// 檢查。呢度直接起 `roster_uploads`（唔經 xlsx 解析，`wp-roster-upload-
// reconcile-apply.test.ts` 都係用呢個做法）。
//
// §1 雞頭/安員 403
// §2 老闆作廢 parsed 版本 → 200，voided_at/voided_by/void_reason 有值，
//    audit 一條 action=void，after 帶 reason
// §3 GET list 預設唔列作廢咗嘅盤（變返 not_uploaded）；?include_voided=1
//    先見到灰色 voided_uploads
// §4 confirmed → 409
// §5 已經 voided → 409
// §6 v2 作廢 → 較舊嘅 superseded v1 回復做 parsed（重新做 active）；
//    版本號唔會撞（下一次上載係 v3，唔係 v2）
// §7 鎖月 → 403
// §8 checkRosterUploadCoverage()：voided 唔算已上載
// §9 reconcile GET／apply 對住 voided 上載 → 一律 409
// §10 PATCH／reparse 對住 voided 上載 → 409（防禦性，作廢係終態）
// §11 reason 驗證：空/太長 → 400
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload, GET as listUploads } from "@/app/api/roster-uploads/route";
import { PATCH as patchUpload } from "@/app/api/roster-uploads/[id]/route";
import { POST as voidUpload } from "@/app/api/roster-uploads/[id]/void/route";
import { POST as reparseUpload } from "@/app/api/roster-uploads/[id]/reparse/route";
import { GET as getReconcile } from "@/app/api/roster-uploads/[id]/reconcile/route";
import { POST as postApply } from "@/app/api/roster-uploads/[id]/reconcile/apply/route";
import { GET as pendingSummary } from "@/app/api/roster-uploads/pending-summary/route";
import { checkRosterUploadCoverage } from "@/lib/roster-upload/lock-precondition";
import ExcelJS from "exceljs";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, month: string, fileName = "test-roster.xlsx"): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

async function buildXlsx(siteName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = aug(1);
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = "TEST-BA";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = "T-A01";
  ws.getCell("E6").value = "6100001";
  ws.getCell("F6").value = "測試安員甲";
  ws.getCell("G6").value = "N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let fileSeq = 0;
/** 直接起 roster_uploads（唔經 xlsx 解析）——測 void 業務規則唔需要真
 * 解析結果，淨係需要一條有齊必填欄嘅記錄。 */
async function mkUpload(
  fx: Wp2Fixture,
  opts: { siteId?: string | null; month?: Date; version?: number; status?: "uploaded" | "parsed" | "parse_failed" | "superseded" | "confirmed" | "voided"; withRow?: boolean; fileName?: string },
) {
  fileSeq += 1;
  const siteId = opts.siteId === undefined ? fx.site.id : opts.siteId;
  const up = await prisma.rosterUpload.create({
    data: {
      month: opts.month ?? fx.unlockedMonth,
      siteId,
      siteNameRaw: fx.site.name,
      uploaderUserId: fx.userIds["老闆"],
      fileName: opts.fileName ?? `void-test-${fileSeq}.xlsx`,
      fileSha256: `sha-void-${fileSeq}`,
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      version: opts.version ?? 1,
      status: opts.status ?? "parsed",
      createdBy: fx.userIds["老闆"],
    },
  });
  if (opts.withRow) {
    await prisma.rosterUploadRow.create({
      data: {
        uploadId: up.id,
        rowIndex: 6,
        workDate: aug(1),
        rawCode: "N",
        codeKind: "shift",
        guardMatch: "unmatched",
        warnings: undefined,
      },
    });
  }
  return up;
}

describe("WP-UPLOAD-VOID：更表上載記錄作廢", () => {
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

  it("§1 雞頭/安員 403", async () => {
    const u = await mkUpload(fx, {});
    const res1 = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, brokerCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });
    expect(res1.status).toBe(403);
    const res2 = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, guardSelfCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });
    expect(res2.status).toBe(403);
  });

  it("§2 老闆/主管/會計作廢 parsed 上載 → 200，voided_at/voided_by/void_reason 有值，audit action=void", async () => {
    for (const cookie of [ownerCookie, supervisorCookie, accountantCookie]) {
      const u = await mkUpload(fx, {});
      const res = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, cookie, "POST", { reason: "老闆揀錯月份，作廢" }), { params: Promise.resolve({ id: u.id }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { upload: Record<string, unknown> };
      expect(body.upload.status).toBe("voided");
      expect(body.upload.voided_at).toBeTruthy();
      expect(body.upload.voided_by).toBeTruthy();
      expect(body.upload.void_reason).toBe("老闆揀錯月份，作廢");

      const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: u.id } });
      expect(after.status).toBe("voided");
      expect(after.voidedAt).toBeTruthy();
      expect(after.voidReason).toBe("老闆揀錯月份，作廢");

      const audit = await prisma.auditLog.findFirst({ where: { tableName: "roster_uploads", rowId: u.id, action: "void" }, orderBy: { createdAt: "desc" } });
      expect(audit).not.toBeNull();
      expect((audit!.after as Record<string, unknown>).void_reason).toBe("老闆揀錯月份，作廢");
    }
  });

  it("§3 GET list：作廢咗嘅盤預設變返 not_uploaded；?include_voided=1 先見到灰色 voided_uploads", async () => {
    const u = await mkUpload(fx, {});
    await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });

    const monthStr = fx.unlockedMonth.toISOString().slice(0, 7);
    const listRes = await listUploads(req(`http://test.local/api/roster-uploads?month=${monthStr}`, ownerCookie));
    const listBody = (await listRes.json()) as { sites: Array<Record<string, unknown>>; voided_uploads: unknown[] };
    const entry = listBody.sites.find((s) => s.site_id === fx.site.id);
    expect(entry!.upload_status).toBe("not_uploaded");
    expect(listBody.voided_uploads).toHaveLength(0);

    const listRes2 = await listUploads(req(`http://test.local/api/roster-uploads?month=${monthStr}&include_voided=1`, ownerCookie));
    const listBody2 = (await listRes2.json()) as { voided_uploads: Array<Record<string, unknown>> };
    expect(listBody2.voided_uploads).toHaveLength(1);
    expect((listBody2.voided_uploads[0]!.upload as Record<string, unknown>).id).toBe(u.id);
  });

  it("§4 confirmed 上載 → 409（要先去對數頁處理）", async () => {
    const u = await mkUpload(fx, { status: "confirmed" });
    const res = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("對數");
  });

  it("§5 已經作廢 → 409", async () => {
    const u = await mkUpload(fx, { status: "voided" });
    const res = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });
    expect(res.status).toBe(409);
  });

  it("§6 v2 作廢 → 較舊嘅 superseded v1 回復做 parsed（active）；版本號唔會撞", async () => {
    const v1 = await mkUpload(fx, { version: 1, status: "superseded", withRow: true, fileName: "v1.xlsx" });
    const v2 = await mkUpload(fx, { version: 2, status: "parsed", fileName: "v2.xlsx" });

    const res = await voidUpload(req(`http://test.local/api/roster-uploads/${v2.id}/void`, ownerCookie, "POST", { reason: "上錯月份" }), { params: Promise.resolve({ id: v2.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revived_upload_id: string | null; revived_version: number | null };
    expect(body.revived_upload_id).toBe(v1.id);
    expect(body.revived_version).toBe(1);

    const v1After = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1After.status).toBe("parsed");
    const v2After = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: v2.id } });
    expect(v2After.status).toBe("voided");

    // 只得 v1 一個 active，GET list 見到 v1。
    const monthStr = fx.unlockedMonth.toISOString().slice(0, 7);
    const listRes = await listUploads(req(`http://test.local/api/roster-uploads?month=${monthStr}`, ownerCookie));
    const listBody = (await listRes.json()) as { sites: Array<Record<string, unknown>> };
    const entry = listBody.sites.find((s) => s.site_id === fx.site.id);
    expect((entry!.upload as Record<string, unknown>).id).toBe(v1.id);

    // 再上載一個新版——version 要係 3（唔可以撞返 voided 嘅 v2）。
    const res3 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx(fx.site.name), monthStr, "v3.xlsx"));
    expect(res3.status).toBe(201);
    const body3 = (await res3.json()) as { upload: { version: number } };
    expect(body3.upload.version).toBe(3);

    const allVersions = await prisma.rosterUpload.findMany({ where: { siteId: fx.site.id }, orderBy: { version: "asc" } });
    expect(allVersions.map((x) => [x.version, x.status])).toEqual([
      [1, "superseded"], // 新上載嚟到，v1（一路係 active）而家先轉 superseded
      [2, "voided"],
      [3, "parsed"],
    ]);
  });

  it("§6b 作廢一個 superseded 嘅舊版（唔係 active）：唔觸發回復邏輯", async () => {
    const v1 = await mkUpload(fx, { version: 1, status: "superseded", withRow: true, fileName: "v1.xlsx" });
    const v2 = await mkUpload(fx, { version: 2, status: "parsed", fileName: "v2.xlsx" });

    const res = await voidUpload(req(`http://test.local/api/roster-uploads/${v1.id}/void`, ownerCookie, "POST", { reason: "清走舊歷史版本" }), { params: Promise.resolve({ id: v1.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revived_upload_id: string | null };
    expect(body.revived_upload_id).toBeNull();

    const v2After = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: v2.id } });
    expect(v2After.status).toBe("parsed"); // v2 一路係 active，唔受影響
  });

  it("§7 該月已鎖 → 403", async () => {
    const mc = await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const u = await mkUpload(fx, {});
    const res = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "測試" }), { params: Promise.resolve({ id: u.id }) });
    expect(res.status).toBe(403);
    await prisma.monthClose.delete({ where: { id: mc.id } });
  });

  it("§8 checkRosterUploadCoverage()：voided 唔算已上載", async () => {
    await mkUpload(fx, { status: "voided" });
    const result = await checkRosterUploadCoverage(fx.unlockedMonth);
    expect(result.missingUploadSites.some((s) => s.siteId === fx.site.id)).toBe(true);
  });

  it("§9 reconcile GET／apply 對住 voided 上載 → 一律 409", async () => {
    const u = await mkUpload(fx, { status: "voided" });
    const getRes = await getReconcile(req(`http://test.local/api/roster-uploads/${u.id}/reconcile`, ownerCookie), { params: Promise.resolve({ id: u.id }) });
    expect(getRes.status).toBe(409);

    const applyRes = await postApply(req(`http://test.local/api/roster-uploads/${u.id}/reconcile/apply`, ownerCookie, "POST", { actions: [] }), { params: Promise.resolve({ id: u.id }) });
    expect(applyRes.status).toBe(409);
  });

  it("§10 PATCH／reparse 對住 voided 上載 → 409", async () => {
    const u = await mkUpload(fx, { status: "voided" });
    const patchRes = await patchUpload(req(`http://test.local/api/roster-uploads/${u.id}`, ownerCookie, "PATCH", { site_id: fx.siteUnassigned.id }), { params: Promise.resolve({ id: u.id }) });
    expect(patchRes.status).toBe(409);
    const reparseRes = await reparseUpload(req(`http://test.local/api/roster-uploads/${u.id}/reparse`, ownerCookie, "POST"), { params: Promise.resolve({ id: u.id }) });
    expect(reparseRes.status).toBe(409);
  });

  it("§11 reason 驗證：空/太長 → 400", async () => {
    const u = await mkUpload(fx, {});
    const empty = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "" }), { params: Promise.resolve({ id: u.id }) });
    expect(empty.status).toBe(400);
    const tooLong = await voidUpload(req(`http://test.local/api/roster-uploads/${u.id}/void`, ownerCookie, "POST", { reason: "x".repeat(201) }), { params: Promise.resolve({ id: u.id }) });
    expect(tooLong.status).toBe(400);
  });

  it("§12 pending-summary 唔會計入 voided 上載（本身已經淨計 status=parsed）", async () => {
    const u = await mkUpload(fx, { status: "voided" });
    await prisma.rosterUploadRow.create({
      data: { uploadId: u.id, rowIndex: 6, workDate: aug(1), rawCode: "N", codeKind: "shift", guardMatch: "unmatched", guardId: fx.guardA.id, shiftTypeId: fx.shiftType.id, warnings: undefined },
    });
    const monthStr = fx.unlockedMonth.toISOString().slice(0, 7);
    const res = await pendingSummary(req(`http://test.local/api/roster-uploads/pending-summary?month=${monthStr}`, ownerCookie));
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries.find((e) => e.upload_id === u.id)).toBeUndefined();
  });
});
