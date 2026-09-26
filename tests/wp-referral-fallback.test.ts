// WP-REFERRAL-FALLBACK（老闆 2026-09-26 緊急）：正式站從未上載過
// Postorder .xlsm，操作員淨係上載得 CSV（冇公式，`set_referral` 計唔到
// 邊個長工，見 `src/lib/guard-fix/plan.ts` `buildPostorderActions()`），
// 令 8 月長工介紹費計 0。呢個測試檔驗證新動作 `set_referral_inferred`
// （`src/lib/pricing/longterm-settlement.ts` `inferReferralBrokerFromRosters()`
// 嘅 guard-fix plan/apply 集成）——**完全唔傳 `postorder` option**，證明
// 呢條規則唔靠 Postorder 一樣計到介紹雞頭。
//
// 純函數本身（決策鏈 7 種情況）嘅單元測試喺
// `tests/longterm-settlement.test.ts`；呢個檔淨係測 plan.ts／apply.ts
// 嘅集成（action 生成、冪等套用、audit 唔帶姓名）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildGuardFixPlan, summarizePlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan } from "@/lib/guard-fix/apply";

describe("WP-REFERRAL-FALLBACK：set_referral_inferred（唔靠 Postorder）", () => {
  let fx: Wp2Fixture;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  async function makeLongtermGuardWithPost(): Promise<{ id: string }> {
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工丁", employmentType: "longterm_autopay", status: "active", createdBy: "test:wp-referral-fallback" } });
    await prisma.guardLongtermPost.create({
      data: { guardId: guard.id, siteId: fx.site.id, effectiveFrom: fx.unlockedMonth, effectiveTo: null, source: "manual", createdBy: "test:wp-referral-fallback" },
    });
    return { id: guard.id };
  }

  async function makeShiftRows(guardId: string, count: number) {
    const upload = await prisma.rosterUpload.create({
      data: {
        month: fx.unlockedMonth,
        siteId: fx.site.id,
        siteNameRaw: fx.site.name,
        uploaderUserId: fx.userIds["老闆"],
        fileName: "test-roster.xlsx",
        fileSha256: `sha-${guardId}`,
        fileBytes: Buffer.from("test"),
        fileSize: 4,
        status: "parsed",
      },
    });
    for (let d = 1; d <= count; d++) {
      await prisma.rosterUploadRow.create({
        data: {
          uploadId: upload.id,
          rowIndex: d,
          workDate: new Date(Date.UTC(2026, 7, d)),
          rawCode: "N",
          codeKind: "shift",
          resolvedSiteId: fx.site.id,
          guardId,
          guardMatch: "by_staff_no",
          settlementBrokerId: fx.brokerA.id,
        },
      });
    }
    return upload;
  }

  it("冇上載 Postorder（`postorder` option 唔傳）都計到——guard 自己崗位盤更表雞頭碼推返供應雞頭", async () => {
    const guard = await makeLongtermGuardWithPost();
    await makeShiftRows(guard.id, 5);

    const plan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows: [] });
    expect(plan.postorder).toBeNull(); // 冇傳 postorder option
    expect(plan.actions.setReferral).toHaveLength(0); // Postorder 嗰個 action 仍然 0 項

    const mine = plan.actions.setReferralInferred.find((a) => a.guardId === guard.id);
    expect(mine).toBeTruthy();
    expect(mine!.brokerId).toBe(fx.brokerA.id);
    const brokerRow = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } });
    expect(mine!.brokerCode).toBe(brokerRow.code);

    const summary = summarizePlan(plan);
    expect(summary.setReferralInferred).toBe(1);
  });

  it("已經有 referral_broker_id 嘅長工——唔再出 action（冪等範圍：只計 referral_broker_id IS NULL）", async () => {
    const guard = await makeLongtermGuardWithPost();
    await makeShiftRows(guard.id, 5);
    await prisma.guard.update({ where: { id: guard.id }, data: { referralBrokerId: fx.brokerB.id } });

    const plan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows: [] });
    expect(plan.actions.setReferralInferred.find((a) => a.guardId === guard.id)).toBeUndefined();
  });

  it("唔係長工（cash_casual）——唔計", async () => {
    const guard = await prisma.guard.create({ data: { nameZh: "測試散工戊", employmentType: "cash_casual", status: "active", createdBy: "test:wp-referral-fallback" } });
    await prisma.guardLongtermPost.create({
      data: { guardId: guard.id, siteId: fx.site.id, effectiveFrom: fx.unlockedMonth, effectiveTo: null, source: "manual", createdBy: "test:wp-referral-fallback" },
    });
    await makeShiftRows(guard.id, 5);

    const plan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows: [] });
    expect(plan.actions.setReferralInferred.find((a) => a.guardId === guard.id)).toBeUndefined();
  });

  it("套用：更新 guards.referral_broker_id，audit 唔帶姓名；再套用一次冪等跳過", async () => {
    const guard = await makeLongtermGuardWithPost();
    await makeShiftRows(guard.id, 5);

    const plan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows: [] });
    expect(plan.actions.setReferralInferred).toHaveLength(1);

    const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false });
    expect(diffs.setReferralInferred.create).toHaveLength(1);

    const updated = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(updated.referralBrokerId).toBe(fx.brokerA.id);

    const audit = await prisma.auditLog.findFirst({ where: { tableName: "guards", rowId: guard.id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit!.after)).not.toContain("測試長工丁");

    // 再套用同一份 plan（planJson 已經 stale，但 apply 邏輯本身套用前會
    // 再查一次現況）——冪等跳過。
    const diffs2 = await applyGuardFixPlan({ prisma, plan, planOnly: false });
    expect(diffs2.setReferralInferred.create).toHaveLength(0);
    expect(diffs2.setReferralInferred.skip).toHaveLength(1);
  });

  it("planOnly=true——唔真係寫入，diffs.create 照計", async () => {
    const guard = await makeLongtermGuardWithPost();
    await makeShiftRows(guard.id, 5);

    const plan = await buildGuardFixPlan({ prisma, month: fx.unlockedMonth, uTeamRows: [] });
    const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: true });
    expect(diffs.setReferralInferred.create).toHaveLength(1);

    const guardAfter = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(guardAfter.referralBrokerId).toBeNull();
  });
});
