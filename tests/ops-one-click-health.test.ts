// WP-AI-OPS §28.3：一鍵結算報告帶 `health` 摘要（淨係 code／severity／count，冇明細）；
// 體檢唔擋鎖月——`lockPrecondition.readyToLock` 同體檢結果無關。合成資料。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runOneClickMonthClose } from "@/lib/month-close/one-click";

const SEPT = new Date(Date.UTC(2026, 8, 1));

describe("一鍵結算報告：health 摘要", () => {
  let fx: Wp2Fixture;
  afterAll(async () => {
    await clearAll();
    await prisma.monthCloseRun.deleteMany({ where: { month: SEPT } });
  });
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("run 完成後 report_json.health 有 critical／warn／info＋findings（冇姓名），唔影響 readyToLock", async () => {
    const boss = fx.userIds["老闆"];
    await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: boss, createdBy: "test" } });
    const site = await prisma.site.create({ data: { canonicalName: "體檢注入盤", clientName: "體檢注入盤", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
    const guard = await prisma.guard.create({ data: { staffNo: "T-OC1", nameZh: "測試體檢人", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "test" } });
    // 冇價卡、冇結算單位 → 體檢會出未定價／冇結算單位
    await prisma.shiftRecord.create({ data: { workDate: SEPT, siteId: site.id, shiftTypeId: st.id, guardId: guard.id, recordType: "shift", createdBy: "test" } });
    const upload = await prisma.rosterUpload.create({
      data: { month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, fileName: "f.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array([1]), fileSize: 1, status: "confirmed" },
    });
    await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: st.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardId: guard.id, guardMatch: "by_name", matchBasis: "name_only" } });

    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss, applyStartedAt: new Date() } });
    await runOneClickMonthClose(run.id, SEPT, boss, null);
    const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    expect({ s: after.status, e: after.errorMessage }).toEqual({ s: "done", e: null });
    const report = after.reportJson as { health: { critical: number; warn: number; info: number; findings: Array<{ code: string; severity: string; count: number }> }; lockPrecondition: { readyToLock: boolean; unpricedCount: number } };
    expect(report.health).toBeTruthy();
    expect(report.health.findings.length).toBeGreaterThan(0);
    expect(report.health.findings.some((f) => f.code === "no_settlement" || f.code === "unpriced_payout" || f.code === "unpriced_client")).toBe(true);
    expect(report.health.critical + report.health.warn + report.health.info).toBe(report.health.findings.length);
    for (const f of report.health.findings) expect(Object.keys(f).sort()).toEqual(["code", "count", "severity"]);
    expect(JSON.stringify(report.health)).not.toContain("測試體檢人");
    // 體檢只提示：readyToLock 只跟上載覆蓋／未定價（原有條件），唔因體檢 critical 而額外變 false
    expect(report.lockPrecondition.readyToLock).toBe(report.lockPrecondition.unpricedCount === 0);
  });
});
