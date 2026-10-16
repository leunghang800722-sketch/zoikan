// G4b：open-month／attendance-fix／reconcile-apply 嘅 audit 同寫入同一個 transaction。
// 用 DB trigger 迫 audit insert 失敗 → 資料同 audit 都要 0 行（rollback）。合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as openMonth } from "@/app/api/months/[month]/open/route";
import { POST as fixPost } from "@/app/api/longterm/attendance-fix/route";
import { applyReconcileDecisions } from "@/lib/roster-upload/reconcile-apply";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";
import { writeAuditMany } from "@/lib/audit";

async function failAuditFor(tables: string[]) {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION g4b_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'g4b forced failure'; END; $$ LANGUAGE plpgsql`);
  const list = tables.map((t) => `'${t}'`).join(",");
  await prisma.$executeRawUnsafe(`CREATE TRIGGER g4b_fail_trg BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.table_name IN (${list})) EXECUTE FUNCTION g4b_fail()`);
}
async function restoreAudit() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS g4b_fail_trg ON audit_log`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS g4b_fail()`);
}
const aug = (day: number) => new Date(Date.UTC(2026, 7, day));

describe("G4b audit 同 tx", () => {
  let fx: Wp2Fixture;
  let owner: string;
  beforeEach(async () => {
    await restoreAudit();
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("open-month：audit 失敗 → 新月份 DR／quota／assignment 都 0 行", async () => {
    const st = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "G4B", label: "g", hours: 8, headcountRequired: 1, createdBy: "t" } });
    await prisma.dailyRequirement.create({ data: { siteId: fx.site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 6, 5)), headcountRequired: 2, createdBy: "t" } });
    await prisma.quota.create({ data: { siteId: fx.site.id, shiftTypeId: st.id, brokerId: fx.brokerA.id, month: new Date(Date.UTC(2026, 6, 1)), targetShifts: 3, createdBy: "t" } });
    const a0 = await prisma.auditLog.count({ where: { tableName: { in: ["daily_requirements", "quotas", "broker_site_assignments"] } } });
    await failAuditFor(["daily_requirements", "quotas", "broker_site_assignments"]);
    try {
      const res = await openMonth(new Request("http://t/api/months/2026-08/open", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: "{}" }), { params: Promise.resolve({ month: "2026-08" }) });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await restoreAudit();
    }
    expect(await prisma.dailyRequirement.count({ where: { shiftTypeId: st.id, workDate: { gte: aug(1) } } })).toBe(0);
    expect(await prisma.quota.count({ where: { shiftTypeId: st.id, month: aug(1) } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: { in: ["daily_requirements", "quotas", "broker_site_assignments"] } } })).toBe(a0);
  });

  it("attendance-fix：audit 失敗 → 紀錄保持原狀、冇 audit", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試長工-G4b", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: fx.userIds["老闆"] } });
    const rec = await prisma.shiftRecord.create({ data: { workDate: aug(6), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, recordType: "leave", leaveCode: "NL", source: "roster_upload", createdBy: "test" } });
    const a0 = await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: rec.id } });
    await failAuditFor(["shift_records"]);
    try {
      const res = await fixPost(new Request("http://t/api/longterm/attendance-fix", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ month: "2026-08", actions: [{ guard_id: g.id, work_date: "2026-08-06", site_id: fx.site.id, set_code: "SHIFT" }] }) }));
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await restoreAudit();
    }
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(after.recordType).toBe("leave");
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records", rowId: rec.id } })).toBe(a0);
  });

  it("reconcile-apply：audit 失敗 → 套用寫入同 decision 全部 rollback", async () => {
    const up = await prisma.rosterUpload.create({
      data: { month: aug(1), siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: "g4b.xlsx", fileSha256: "sha-g4b", fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed" },
    });
    await prisma.rosterUploadRow.create({
      data: { uploadId: up.id, rowIndex: 1, workDate: aug(2), rawCode: "N", codeKind: "shift", shiftTypeId: fx.shiftType.id, resolvedSiteId: fx.site.id, guardId: fx.guardA.id, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerA.id, brokerCodeRaw: "TEST-BA" },
    });
    const { items } = await reconcileUpload(up.id);
    const actions = items.filter((i) => i.category === "roster_only").map((i) => ({ key: i.key, action: "apply_roster" as const }));
    expect(actions.length).toBeGreaterThan(0);
    const a0 = await prisma.auditLog.count({ where: { tableName: "shift_records" } });
    await failAuditFor(["shift_records", "roster_reconcile_decisions"]);
    try {
      await expect(applyReconcileDecisions({ uploadId: up.id, actions, actorUserId: fx.userIds["老闆"], ip: null })).rejects.toThrow();
    } finally {
      await restoreAudit();
    }
    expect(await prisma.shiftRecord.count({ where: { source: "roster_upload", guardId: fx.guardA.id } })).toBe(0);
    expect(await prisma.rosterReconcileDecision.count({ where: { uploadId: up.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records" } })).toBe(a0);
  });

  it("2,000 條 audit 一條 createMany 喺 tx 內 < 2 秒", async () => {
    const inputs = Array.from({ length: 2000 }, (_, i) => ({ actorUserId: fx.userIds["老闆"], tableName: "shift_records", rowId: `g4b-timing-${i}`, action: "update" as const, before: { id: `x${i}`, status: "confirmed" }, after: { id: `x${i}`, status: "confirmed", via: "t" }, ip: null }));
    const t0 = performance.now();
    await prisma.$transaction(async (tx) => {
      await writeAuditMany(inputs, tx);
    });
    const ms = performance.now() - t0;
    expect(await prisma.auditLog.count({ where: { rowId: { startsWith: "g4b-timing-" } } })).toBe(2000);
    console.log(`[g4b] 2000 audit createMany in tx: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
