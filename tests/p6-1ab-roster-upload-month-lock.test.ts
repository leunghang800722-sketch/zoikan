// P6.1a（H1）／P6.1b（H2）：已鎖月份嘅更表上載：新上載 POST、PATCH 改盤
// 一律 403 month_locked，DB 零改動；未鎖月份行為不變。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { PATCH as patchUpload } from "@/app/api/roster-uploads/[id]/route";
import { assignRosterUploadSite } from "@/lib/roster-upload/service";

function reqMultipart(cookie: string, buffer: Buffer, month: string, fileName: string): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  form.set("month", month);
  return new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form });
}

async function buildXlsx(siteName: string, y: number, m: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(y));
  ws.getCell("A2").value = siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(y, m - 1, 1));
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
  ws.getCell("F6").value = "測試保安員甲";
  ws.getCell("G6").value = "N";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function patchReq(cookie: string, id: string, body: unknown) {
  return new Request(`http://test.local/api/roster-uploads/${id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

describe("P6.1a/b：已鎖月份嘅更表上載寫入口", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function mkUpload(month: Date, status: "parsed" | "confirmed", fileName: string, siteId: string | null) {
    return prisma.rosterUpload.create({
      data: {
        month, siteId, siteNameRaw: fx.site.name, uploaderUserId: fx.userIds["老闆"], fileName,
        fileSha256: `sha-${fileName}`, fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status, createdBy: fx.userIds["老闆"],
      },
    });
  }

  it("P6.1a：POST 上載去已鎖月（2026-06）→ 403 month_locked；舊 confirmed 版本唔會變 superseded、冇新 row", async () => {
    const old = await mkUpload(fx.lockedMonth, "confirmed", "old.xlsx", fx.site.id);
    const old2 = await mkUpload(fx.lockedMonth, "parsed", "old2.xlsx", fx.site.id);
    const before = await prisma.rosterUpload.count();
    const res = await createUpload(reqMultipart(ownerCookie, await buildXlsx(fx.site.name, 2026, 6), "2026-06", "new.xlsx"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("month_locked");
    expect(await prisma.rosterUpload.count()).toBe(before);
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("confirmed");
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: old2.id } })).status).toBe("parsed");
    expect(await prisma.rosterUploadRow.count()).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "roster_uploads", action: "permission_denied" } });
    expect(audit).not.toBeNull();
  });

  it("P6.1a：POST 上載去未鎖月（2026-08）→ 照常 201", async () => {
    const res = await createUpload(reqMultipart(ownerCookie, await buildXlsx(fx.site.name, 2026, 8), "2026-08", "ok.xlsx"));
    expect(res.status).toBe(201);
    expect(await prisma.rosterUpload.count({ where: { month: fx.unlockedMonth } })).toBe(1);
  });

  it("P6.1b：PATCH 改盤、upload 喺已鎖月 → 403 month_locked；site_id／版本／rows 零改動", async () => {
    const up = await mkUpload(fx.lockedMonth, "parsed", "locked.xlsx", fx.site.id);
    const other = await mkUpload(fx.lockedMonth, "parsed", "other.xlsx", fx.siteUnassigned.id);
    const res = await patchUpload(patchReq(ownerCookie, up.id, { site_id: fx.siteUnassigned.id }), { params: Promise.resolve({ id: up.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("month_locked");
    const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: up.id } });
    expect(after.siteId).toBe(fx.site.id);
    expect(after.version).toBe(1);
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("parsed");
  });

  it("P6.1b：lib assignRosterUploadSite() 直接 call（其他 caller）已鎖月亦拒絕", async () => {
    const up = await mkUpload(fx.lockedMonth, "parsed", "lib.xlsx", fx.site.id);
    await expect(assignRosterUploadSite(up.id, fx.siteUnassigned.id)).rejects.toMatchObject({ code: "month_locked" });
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: up.id } })).siteId).toBe(fx.site.id);
  });

  it("P6.1b：未鎖月 PATCH 改盤行為不變（200）", async () => {
    const up = await mkUpload(fx.unlockedMonth, "parsed", "free.xlsx", fx.site.id);
    const res = await patchUpload(patchReq(ownerCookie, up.id, { site_id: fx.siteUnassigned.id }), { params: Promise.resolve({ id: up.id }) });
    expect(res.status).toBe(200);
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: up.id } })).siteId).toBe(fx.siteUnassigned.id);
  });
});
