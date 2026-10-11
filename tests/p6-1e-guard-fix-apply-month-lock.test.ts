// P6.1e（H5）：guard-fix apply 同 reparseAllActiveUploads() 對已鎖月份 403，DB 零改動。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as applyRun } from "@/app/api/guard-fix/runs/[id]/apply/route";
import { reparseAllActiveUploads } from "@/lib/guard-fix/apply";

describe("P6.1e：guard-fix 鎖月", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function mkRun(month: Date) {
    const sl = await prisma.staffListUpload.create({
      data: { uploaderId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: "z".repeat(64), fileBytes: Buffer.from("x"), fileSize: 1, rowCount: 0 },
    });
    return prisma.guardFixRun.create({
      data: { month, staffListUploadId: sl.id, createdById: fx.userIds["老闆"], planJson: {}, summaryJson: {}, status: "planned" },
    });
  }
  async function mkUpload(month: Date) {
    const up = await prisma.rosterUpload.create({
      data: { month, siteId: fx.site.id, siteNameRaw: fx.site.name, uploaderUserId: fx.userIds["老闆"], fileName: "f.xlsx", fileSha256: "q".repeat(64), fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed", createdBy: fx.userIds["老闆"] },
    });
    await prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex: 6, workDate: new Date(Date.UTC(2026, 5, 1)), rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });
    return up;
  }

  it("apply route：run.month 已鎖 → 403 month_locked，run 維持 planned", async () => {
    const run = await mkRun(fx.lockedMonth);
    const res = await applyRun(new Request(`http://test.local/api/guard-fix/runs/${run.id}/apply`, { method: "POST", headers: { cookie: ownerCookie } }), { params: Promise.resolve({ id: run.id }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("month_locked");
    expect((await prisma.guardFixRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("planned");
  });

  it("reparseAllActiveUploads()：已鎖月 → reject，rows 零改動", async () => {
    const up = await mkUpload(fx.lockedMonth);
    const rowsBefore = await prisma.rosterUploadRow.findMany({ where: { uploadId: up.id }, select: { id: true } });
    await expect(reparseAllActiveUploads(prisma, fx.lockedMonth)).rejects.toMatchObject({ code: "month_locked" });
    const rowsAfter = await prisma.rosterUploadRow.findMany({ where: { uploadId: up.id }, select: { id: true } });
    expect(rowsAfter.map((r) => r.id)).toEqual(rowsBefore.map((r) => r.id));
  });

  it("reparseAllActiveUploads()：未鎖月照常（冇 confirmed → 空結果仍然過）", async () => {
    const r = await reparseAllActiveUploads(prisma, fx.unlockedMonth);
    expect(r.perUpload).toEqual([]);
  });
});
