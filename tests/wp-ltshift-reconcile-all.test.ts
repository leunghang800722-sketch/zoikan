// WP-LTSHIFT §19 交付 C：「重新對數全月」——`runReconcileAllForMonth()`
// integration test（直接起 roster_uploads/roster_upload_rows，唔經 xlsx
// 解析）＋ `POST /api/roster-uploads/reconcile-all` 嘅並發鎖行為。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runReconcileAllForMonth, RECONCILE_ALL_ADVISORY_LOCK_KEY, reconcileAllApplyAllowed } from "@/lib/roster-upload/reconcile-all";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

async function mkUpload(fx: Wp2Fixture, opts: { status?: "parsed" | "confirmed"; siteId?: string | null } = {}) {
  return prisma.rosterUpload.create({
    data: {
      month: aug(1),
      siteId: opts.siteId === undefined ? fx.site.id : opts.siteId,
      siteNameRaw: "測試盤WP-LTSHIFT",
      uploaderUserId: fx.userIds["老闆"],
      fileName: "reconcile-all-test.xlsx",
      fileSha256: `sha-${Math.random()}`,
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: opts.status ?? "parsed",
    },
  });
}

async function mkRow(fx: Wp2Fixture, uploadId: string, rowIndex: number, day: number) {
  return prisma.rosterUploadRow.create({
    data: {
      uploadId,
      rowIndex,
      workDate: aug(day),
      rawCode: "N",
      codeKind: "shift",
      shiftTypeId: fx.shiftType.id,
      resolvedSiteId: fx.site.id,
      guardId: fx.guardA.id,
      guardMatch: "by_staff_no",
      settlementBrokerId: fx.brokerA.id,
      brokerCodeRaw: "TEST-BA",
    },
  });
}

describe("runReconcileAllForMonth", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("roster_only 全部自動套用（全部以更表為準），成一行 shift_record", async () => {
    const up = await mkUpload(fx);
    await mkRow(fx, up.id, 1, 5);
    await mkRow(fx, up.id, 2, 6);

    const result = await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    expect(result.uploadCount).toBe(1);
    expect(result.perUpload[0]!.before.rosterOnly).toBe(2);
    expect(result.perUpload[0]!.applied).toBe(2);
    expect(result.totals.applied).toBe(2);
    expect(result.totals.uploadsWithErrors).toBe(0);

    const records = await prisma.shiftRecord.findMany({ where: { siteId: fx.site.id, guardId: fx.guardA.id, workDate: { in: [aug(5), aug(6)] } } });
    expect(records).toHaveLength(2);
  });

  it("confirmed 上載都照做（唔靠 reparse）", async () => {
    const up = await mkUpload(fx, { status: "confirmed" });
    await mkRow(fx, up.id, 1, 7);
    const result = await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    expect(result.perUpload[0]!.applied).toBe(1);
  });

  it("冪等：跑完一次再跑一次，第二次 applied=0（已經 match）", async () => {
    const up = await mkUpload(fx);
    await mkRow(fx, up.id, 1, 8);
    await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    const second = await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    expect(second.perUpload[0]!.applied).toBe(0);
    expect(second.perUpload[0]!.before.rosterOnly).toBe(0);
  });

  it("上載未指定盤（site_id null）——唔套用，留低 skippedApplyReason", async () => {
    const up = await mkUpload(fx, { siteId: null });
    await prisma.rosterUploadRow.create({
      data: {
        uploadId: up.id,
        rowIndex: 1,
        workDate: aug(9),
        rawCode: "N",
        codeKind: "shift",
        shiftTypeId: fx.shiftType.id,
        resolvedSiteId: null,
        guardId: fx.guardA.id,
        guardMatch: "by_staff_no",
        settlementBrokerId: fx.brokerA.id,
      },
    });
    const result = await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    expect(result.perUpload[0]!.skippedApplyReason).toMatch(/未指定盤/);
    expect(result.perUpload[0]!.applied).toBe(0);
  });

  it("鎖定月份——拒絕執行（Locked）", async () => {
    await prisma.monthClose.create({ data: { month: aug(1), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    await expect(runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null)).rejects.toMatchObject({ status: 403 });
  });
});

describe("reconcileAllApplyAllowed（卡死復原）", () => {
  it("done/failed 隨時可以再跑；running 未過 15 分鐘唔准；running 過咗 15 分鐘先當卡死", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(reconcileAllApplyAllowed({ status: "done", startedAt: now }, now)).toBe(true);
    expect(reconcileAllApplyAllowed({ status: "failed", startedAt: now }, now)).toBe(true);
    expect(reconcileAllApplyAllowed({ status: "running", startedAt: now }, now)).toBe(false);
    const past = new Date(now.getTime() - 16 * 60 * 1000);
    expect(reconcileAllApplyAllowed({ status: "running", startedAt: past }, now)).toBe(true);
  });

  it("advisory lock key 係一個穩定常數（同 guard-fix 唔同，避免兩把鎖打架）", () => {
    expect(RECONCILE_ALL_ADVISORY_LOCK_KEY).toBe(7_710_260_926);
  });
});
