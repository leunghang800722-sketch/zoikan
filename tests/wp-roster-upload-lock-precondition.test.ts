// WP-ROSTER-UPLOAD Phase B-1（B1-6，規則 10／§14）：月結鎖定前檢查——
// 該月有出更（shift_records／daily_requirements）嘅盤，冇 active 更表
// 上載→擋鎖；有上載但未對數完成（status != confirmed）→擋鎖；老闆
// force=true 可以覆寫（記落 audit），非老闆用 force 一律 403。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as monthCloseLock } from "@/app/api/month-closes/[id]/lock/route";
import { checkRosterUploadCoverage } from "@/lib/roster-upload/lock-precondition";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-ROSTER-UPLOAD Phase B-1（B1-6）：月結鎖定前檢查", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let accountantCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
  });

  it("checkRosterUploadCoverage()：完全冇上載嘅盤列入 missingUploadSites", async () => {
    const result = await checkRosterUploadCoverage(fx.unlockedMonth);
    expect(result.missingUploadSites.some((s) => s.siteId === fx.site.id)).toBe(true);
    expect(result.unconfirmedUploadSites).toHaveLength(0);
  });

  it("checkRosterUploadCoverage()：有上載但 status=parsed（未對數）列入 unconfirmedUploadSites", async () => {
    await prisma.rosterUpload.create({
      data: {
        month: fx.unlockedMonth,
        siteId: fx.site.id,
        siteNameRaw: fx.site.name,
        uploaderUserId: fx.userIds["老闆"]!,
        fileName: "test.xlsx",
        fileSha256: "x".repeat(64),
        fileBytes: Buffer.from("x"),
        fileSize: 1,
        status: "parsed",
        createdBy: fx.userIds["老闆"]!,
      },
    });
    const result = await checkRosterUploadCoverage(fx.unlockedMonth);
    expect(result.missingUploadSites).toHaveLength(0);
    expect(result.unconfirmedUploadSites.some((s) => s.siteId === fx.site.id && s.status === "parsed")).toBe(true);
  });

  it("checkRosterUploadCoverage()：status=confirmed 就唔會列出嚟", async () => {
    await prisma.rosterUpload.create({
      data: {
        month: fx.unlockedMonth,
        siteId: fx.site.id,
        siteNameRaw: fx.site.name,
        uploaderUserId: fx.userIds["老闆"]!,
        fileName: "test.xlsx",
        fileSha256: "y".repeat(64),
        fileBytes: Buffer.from("x"),
        fileSize: 1,
        status: "confirmed",
        createdBy: fx.userIds["老闆"]!,
      },
    });
    const result = await checkRosterUploadCoverage(fx.unlockedMonth);
    expect(result.missingUploadSites).toHaveLength(0);
    expect(result.unconfirmedUploadSites).toHaveLength(0);
  });

  it("POST /lock：未上載嘅盤擋鎖，400 列出盤名", async () => {
    const mc = await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } });
    const res = await monthCloseLock(req(`http://test.local/api/month-closes/${mc.id}`, ownerCookie, "POST", {}), { params: Promise.resolve({ id: mc.id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain(fx.site.name);
  });

  it("POST /lock：老闆 force=true 可以覆寫，audit 記低 roster_upload_force", async () => {
    const mc = await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } });
    const res = await monthCloseLock(req(`http://test.local/api/month-closes/${mc.id}`, ownerCookie, "POST", { force: true }), { params: Promise.resolve({ id: mc.id }) });
    expect(res.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mc.id, action: "lock_month" }, orderBy: { createdAt: "desc" } });
    const after = audit!.after as Record<string, unknown>;
    expect(after.roster_upload_force).toBe(true);
  });

  it("POST /lock：會計（有「月結鎖定解鎖:void」都好）帶 force=true → 403（淨係老闆做得到）", async () => {
    // 呢個 fixture 出廠會計冇「月結鎖定解鎖」grant（matrix.ts 出廠 O），
    // 所以先要幫佢開返，先至可以測「有 void 權限但唔係老闆」呢種情況。
    const perm = await prisma.permission.findFirstOrThrow({ where: { module: "月結鎖定解鎖", action: "void" } });
    const role = await prisma.role.findFirstOrThrow({ where: { name: "會計" } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      create: { roleId: role.id, permissionId: perm.id, granted: true },
      update: { granted: true },
    });
    const mc = await prisma.monthClose.create({ data: { month: fx.unlockedMonth, createdBy: "test" } });
    const res = await monthCloseLock(req(`http://test.local/api/month-closes/${mc.id}`, accountantCookie, "POST", { force: true }), { params: Promise.resolve({ id: mc.id }) });
    expect(res.status).toBe(403);
  });
});
