// 驗收（Opus 5.5，2026-09-26）：guard-fix「唔准留要老闆決定」——兩類以前
// needs_boss 嘅身份改做保守預設（按更表姓名建獨立保安員、cash_casual、無
// 工號），工號衝突嗰類寫 guard_match_overrides 令 reparse 配得返。
// 合成 fixture：名用「測試…」、工號 U9xxx、電話 6xxxxxxx。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan } from "@/lib/guard-fix/apply";
import { buildGuardMatchIndex, matchGuard } from "@/lib/roster-upload/match";
import type { UTeamRow } from "@/lib/guard-fix/sources";

const MONTH = new Date("2026-08-01T00:00:00.000Z");

describe("guard-fix 保守預設（needs_boss → 建獨立保安員）", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function setup() {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } });
    await prisma.broker.create({ data: { code: "Y", name: "測試Y", kind: "internal_cash", settlementType: "cash", createdBy: "test" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試保守盤", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const upload = await prisma.rosterUpload.create({
      data: { month: MONTH, siteId: site.id, siteNameRaw: "測試保守盤", uploaderUserId: user.id, fileName: "t.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 },
    });
    return { upload, site };
  }

  it("更表工號屬 DB 另一位保安員、DB 冇同名 → create_minimal（staff_no_conflict），套用後寫 override，matchGuard 配返新保安員", async () => {
    const { upload, site } = await setup();
    const owner = await prisma.guard.create({ data: { nameZh: "測試工號主人", employmentType: "cash_casual", staffNo: "U90001", createdBy: "test" } });
    await prisma.guardStaffNumber.create({ data: { guardId: owner.id, scheme: "U", number: "U90001", status: "current" } });
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 5, workDate: new Date("2026-08-04"), rawCode: "D", codeKind: "shift", resolvedSiteId: site.id, staffNoRaw: "U90001", nameRaw: "測試衝突甲", telRaw: "61230001", guardMatch: "ambiguous" },
    });

    const plan = await buildGuardFixPlan({ prisma, month: MONTH, uTeamRows: [] });
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]).toMatchObject({ conservative: "staff_no_conflict", matchOverrideStaffNo: "U90001", nameZh: "測試衝突甲" });

    await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MONTH });
    const created = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試衝突甲" }, include: { staffNumbers: true } });
    expect(created.employmentType).toBe("cash_casual");
    expect(created.staffNumbers).toHaveLength(0); // 無工號
    const override = await prisma.guardMatchOverride.findFirstOrThrow({ where: { guardId: created.id } });
    expect(override.reason).toContain("工號衝突待核");
    const audit = await prisma.auditLog.findFirst({ where: { rowId: created.id, action: "guard_fix_conservative_default" } });
    expect(audit).not.toBeNull();

    const idx = buildGuardMatchIndex({
      guards: await prisma.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true, nameAliases: true } }),
      staffNumbers: await prisma.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true } }),
      phones: [],
      matchOverrides: await prisma.guardMatchOverride.findMany({ where: { voidedAt: null } }),
    });
    expect(matchGuard({ staffNoRaw: "U90001", nameRaw: "測試衝突甲", telRaw: null }, idx).guardId).toBe(created.id);

    // 冪等：再 build＋apply 唔會再起人
    const plan2 = await buildGuardFixPlan({ prisma, month: MONTH, uTeamRows: [] });
    await applyGuardFixPlan({ prisma, plan: plan2, planOnly: false, month: MONTH });
    expect(await prisma.guard.count({ where: { nameZh: "測試衝突甲" } })).toBe(1);
  });

  it("EMP-P1.1 S1：link 動作加工號但該 guard 同 scheme 已有另一張現用卡 → 該項標「交老闆睇」跳過，成個 apply 唔 409 rollback", async () => {
    await setup();
    const g = await prisma.guard.create({ data: { nameZh: "測試現用甲", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "U", number: "U90701", status: "current" } });
    const plan = await buildGuardFixPlan({ prisma, month: MONTH, uTeamRows: [] });
    plan.actions.link.push({ type: "link", seq: "T-S1", guardId: g.id, reason: "測試", addStaffNumber: { scheme: "U", number: "U90702" }, addAlias: "測試現用別名" });
    const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MONTH });
    expect(diffs.link.skip.some((x) => x.startsWith("T-S1") && x.includes("交老闆睇"))).toBe(true);
    expect(diffs.link.create).not.toContain("T-S1");
    expect(await prisma.guardStaffNumber.count({ where: { guardId: g.id } })).toBe(1); // 新號冇加
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).nameAliases).not.toContain("測試現用別名"); // 成項唔做
  });

  it("淨係靠姓名喺名單搵到、電話對唔上 → create_minimal（name_only_unverified），唔用名單資料（冇身份證、冇 U 號）", async () => {
    const { upload, site } = await setup();
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 6, workDate: new Date("2026-08-05"), rawCode: "D", codeKind: "shift", resolvedSiteId: site.id, staffNoRaw: null, nameRaw: "測試同名乙", telRaw: "61230002", guardMatch: "unmatched" },
    });
    const uTeamRows: UTeamRow[] = [{ uNumber: "U90002", nameZh: "測試同名乙", displayName: null, tel: "61239999", hkid: null, hkidNote: null, hireDate: null } as UTeamRow];
    const plan = await buildGuardFixPlan({ prisma, month: MONTH, uTeamRows });
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.create).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]).toMatchObject({ conservative: "name_only_unverified", matchOverrideStaffNo: null, tel: "61230002" });

    await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MONTH });
    const created = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試同名乙" }, include: { staffNumbers: true } });
    expect(created.staffNumbers).toHaveLength(0);
    expect(created.hkid).toBeNull();
    expect(await prisma.guardMatchOverride.count()).toBe(0);
  });

  it("DB 已經有同名保安員（真係多過一個候選）→ 照舊 needs_boss（唔可以再起一個同名人令佢更加分唔到）", async () => {
    const { upload, site } = await setup();
    const owner = await prisma.guard.create({ data: { nameZh: "測試工號主人丙", employmentType: "cash_casual", createdBy: "test" } });
    await prisma.guardStaffNumber.create({ data: { guardId: owner.id, scheme: "U", number: "U90003", status: "current" } });
    await prisma.guard.create({ data: { nameZh: "測試同名丁", employmentType: "cash_casual", createdBy: "test" } });
    await prisma.rosterUploadRow.create({
      data: { uploadId: upload.id, rowIndex: 7, workDate: new Date("2026-08-06"), rawCode: "D", codeKind: "shift", resolvedSiteId: site.id, staffNoRaw: "U90003", nameRaw: "測試同名丁", telRaw: null, guardMatch: "ambiguous" },
    });
    const plan = await buildGuardFixPlan({ prisma, month: MONTH, uTeamRows: [] });
    expect(plan.actions.createMinimal).toHaveLength(0);
    expect(plan.actions.needsBoss).toHaveLength(1);
  });
});
