// HIST-5 A：歷史導入身份推斷 R1–R5（plan＋apply 層，直接插未配對行，唔經 parser）。
// 全部假資料：測試…名、U9xxxx 工號、fakeTel。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { fakeTel, mkSite, mkShiftType, mkGuard, mkUpload, mkRow, mkRows, planAndApply, MAR } from "./helpers/hist5";
import { matchGuard } from "@/lib/roster-upload/match";
import { loadGuardMatchIndex } from "@/lib/roster-upload/guard-index";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan } from "@/lib/guard-fix/apply";
import { isNameVariant, foldName, longestConsecutiveRunContaining } from "@/lib/month-close/hist-inference";

describe("HIST-5 純函數：姓名折返", () => {
  it("foldName／isNameVariant：簡繁、後綴、NFKC、相差一字", () => {
    expect(foldName("测试陈张 (上)")).toBe(foldName("測試陳張"));
    expect(foldName("測試陳張(摩)")).toBe(foldName("測試陳張"));
    expect(isNameVariant("测试陈张", "測試陳張")).toBe(true);
    expect(isNameVariant("測試阿甲甲", "測試阿甲乙")).toBe(true); // 相差一字（≥4 字）
    expect(isNameVariant("測試甲", "測試乙")).toBe(false); // 3 字名相差一字多數係唔同人，唔當變體
    expect(isNameVariant("測試阿甲", "測試阿乙")).toBe(true); // 4 字
    expect(isNameVariant("測試保安員甲", "完全唔同人名")).toBe(false);
  });
  it("longestConsecutiveRunContaining", () => {
    const m = (mo: number) => new Date(Date.UTC(2026, mo - 1, 1));
    expect(longestConsecutiveRunContaining([m(1), m(2), m(3)], m(3))).toBe(3);
    expect(longestConsecutiveRunContaining([m(1), m(3), m(4)], m(3))).toBe(2);
    expect(longestConsecutiveRunContaining([m(1), m(2)], m(3))).toBe(0);
  });
});

describe("HIST-5 身份推斷 plan＋apply", () => {
  let fx: Wp2Fixture;
  let site: { id: string };
  let upload: { id: string };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    site = await mkSite("測試推斷盤");
    upload = await mkUpload({ siteId: site.id, siteName: "測試推斷盤", userId: fx.userIds["老闆"] });
  });

  async function bind(staffNo: string | null, name: string, tel: string | null = null) {
    // 模擬歷史月份 reparse（service.ts 喺歷史月份先載入 HIST5 淨姓名覆寫；正式月份唔載入，見 hist5-formal-isolation.test.ts）。
    return matchGuard({ staffNoRaw: staffNo, nameRaw: name, telRaw: tel }, await loadGuardMatchIndex(prisma, { includeHistInferenceOverrides: true }));
  }

  it("R1：工號屬別人、姓名唯一（含簡繁＋後綴）→ link 姓名對到嗰位，寫 override，唔加工號；信心 0.9＋依據", async () => {
    const owner = await mkGuard({ name: "測試工號主", staffNo: "U90001" });
    const b = await mkGuard({ name: "測試姓名唯一" });
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90001", name: "测试姓名唯一 (上)", kind: "ambiguous" }, 3);
    const { plan, diffs } = await planAndApply();
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.link).toHaveLength(1);
    const la = plan.actions.link[0]!;
    expect(la.guardId).toBe(b.id);
    expect(la.addStaffNumber).toBeNull();
    expect(la.inference).toMatchObject({ rule: "R1", confidence: 0.9, cells: 3 });
    expect(la.inference!.evidence.join("｜")).toContain("測試工號主");
    expect(la.inference!.evidence.join("｜")).toContain("冇工號");
    expect(diffs.link.create).toEqual([la.seq]);
    // DB：B 冇被加工號；工號主人不變；override 帶 HIST5 reason
    expect(await prisma.guardStaffNumber.count({ where: { guardId: b.id } })).toBe(0);
    expect((await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "U90001" } })).guardId).toBe(owner.id);
    const ov = await prisma.guardMatchOverride.findFirstOrThrow({ where: { guardId: b.id } });
    expect(ov).toMatchObject({ staffNo: "U90001", nameRaw: "测试姓名唯一 (上)" });
    expect(ov.reason).toMatch(/^HIST5 R1/);
    expect(await prisma.auditLog.count({ where: { rowId: b.id, action: "guard_fix_inference" } })).toBe(1);
    // reparse 時真係配到 B
    const r = await bind("U90001", "测试姓名唯一 (上)");
    expect(r).toMatchObject({ guardId: b.id, matchedViaStaffNoConflictOverride: true });
    // 冪等：再 plan 唔再出動作（身份已無未配對行時）；同 key 再 apply 為 no-op
    const again = await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MAR, historicalRoster: true });
    expect(again.link.create).toEqual([]);
  });

  it("R1：同一身份連續 3 個月用同一個屬別人嘅號 → 照 link，另列 review_hints（懷疑 DB 工號登記錯）", async () => {
    await mkGuard({ name: "測試工號主", staffNo: "U90001" });
    await mkGuard({ name: "測試姓名唯一" });
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90001", name: "測試姓名唯一", kind: "ambiguous" }, 2);
    for (const mo of [1, 2]) {
      const m = new Date(Date.UTC(2026, mo - 1, 1));
      const up = await mkUpload({ siteId: site.id, siteName: "測試推斷盤", month: m, userId: fx.userIds["老闆"] });
      await mkRow({ uploadId: up.id, siteId: site.id, staffNo: "U90001", name: "測試姓名唯一", month: m, kind: "ambiguous" });
    }
    const { plan } = await planAndApply();
    expect(plan.actions.link).toHaveLength(1);
    expect(plan.historical!.reviewHints).toHaveLength(1);
    expect(plan.historical!.reviewHints[0]).toMatchObject({ rule: "R1", subject: { name: "測試姓名唯一", staffNo: "U90001" } });
    expect(plan.historical!.reviewHints[0]!.hint).toContain("懷疑 DB 工號登記錯");
    expect(plan.historical!.remaining).toHaveLength(0);
  });

  it("R2a：電話屬別人 A，更表姓名唯一對到 B → link B，唔加電話", async () => {
    const tel = fakeTel();
    const a = await mkGuard({ name: "測試電話主", tel });
    const b = await mkGuard({ name: "測試乙唯一" });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試乙唯一", tel, kind: "ambiguous" }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.link).toHaveLength(1);
    expect(plan.actions.link[0]!.inference).toMatchObject({ rule: "R2a", confidence: 0.9 });
    expect(plan.actions.link[0]!.guardId).toBe(b.id);
    expect(await prisma.guardPhone.count({ where: { guardId: b.id } })).toBe(0);
    expect((await prisma.guardPhone.findMany({ where: { guardId: a.id } })).map((p) => p.tel)).toEqual([tel]);
    expect(JSON.stringify(plan.actions.link[0]!.inference)).not.toContain(tel);
    expect(await bind(null, "測試乙唯一", tel)).toMatchObject({ guardId: b.id });
  });

  it("R2b：電話屬 A，更表姓名 DB 冇但係 A 嘅變體（簡繁／相差一字）→ link A＋加別名", async () => {
    const tel1 = fakeTel();
    const tel2 = fakeTel();
    const a1 = await mkGuard({ name: "測試陳張", tel: tel1 });
    const a2 = await mkGuard({ name: "測試阿甲甲", tel: tel2 });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "测试陈张", tel: tel1, rowIndex: 201 }, 2);
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試阿甲乙", tel: tel2, rowIndex: 202 }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.link.map((l) => l.inference!.rule).sort()).toEqual(["R2b", "R2b"]);
    expect(plan.actions.createMinimal).toHaveLength(0);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: a1.id } })).nameAliases).toContain("测试陈张");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: a2.id } })).nameAliases).toContain("測試阿甲乙");
    expect(plan.actions.link.every((l) => l.inference!.confidence === 0.85)).toBe(true);
  });

  it("R2c：電話屬 A，更表姓名 DB 冇、亦唔係變體 → create_minimal 但 tel 留空（歷史導入 inactive）", async () => {
    const tel = fakeTel();
    const a = await mkGuard({ name: "測試電話主甲", tel });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "完全唔同嘅人", tel }, 2);
    const { plan, diffs } = await planAndApply();
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]!.tel).toBeNull();
    expect(plan.actions.createMinimal[0]!.inference).toMatchObject({ rule: "R2c", confidence: 0.85 });
    expect(plan.actions.needsBoss).toHaveLength(0);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "完全唔同嘅人" }, include: { phones: true } });
    expect(g.phones).toHaveLength(0);
    expect(g.tel).toBeNull();
    expect(g.status).toBe("inactive");
    expect((await prisma.guardPhone.findMany({ where: { guardId: a.id } })).map((p) => p.tel)).toEqual([tel]);
    expect(diffs.createMinimal.telSkipped ?? []).toHaveLength(0);
    // override（淨姓名）令 reparse 配到新人，唔會再被電話層拉去 A
    expect(await bind(null, "完全唔同嘅人", tel)).toMatchObject({ guardId: g.id });
    expect(JSON.stringify(plan)).toContain("疑共用電話");
  });

  it("R3a：同名多候選全部係歷史導入 minimal → 合併（保留最早，shift_records／長工崗位改指，撞 unique 跳過），之後 reparse 配得返", async () => {
    const st = await mkShiftType(site.id, "D", "0700", "1900");
    const early = await mkGuard({ name: "測試同名人", status: "inactive", createdBy: "system:guard-fix:historical_roster", createdAt: new Date("2026-03-01T00:00:00Z") });
    const late = await mkGuard({ name: "測試同名人", status: "inactive", createdBy: "system:guard-fix:historical_roster", createdAt: new Date("2026-03-02T00:00:00Z") });
    const late2 = await mkGuard({ name: "測試同名人", status: "inactive", createdBy: "system:guard-fix:historical_roster", createdAt: new Date("2026-03-03T00:00:00Z") });
    const rec = (guardId: string, day: number) => prisma.shiftRecord.create({ data: { guardId, siteId: site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 2, day)), status: "confirmed", createdBy: "test" } });
    await rec(early.id, 1);
    await rec(late.id, 1); // 撞 unique（同日同更種）
    await rec(late.id, 2);
    await rec(late2.id, 3);
    await prisma.guardLongtermPost.create({ data: { guardId: late.id, siteId: site.id, effectiveFrom: MAR, source: "manual", createdBy: "test" } });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試同名人", kind: "ambiguous" }, 3);
    const { plan, diffs } = await planAndApply();
    expect(plan.actions.mergeGuards).toHaveLength(1);
    expect(plan.actions.mergeGuards![0]!.keepGuardId).toBe(early.id);
    expect(plan.actions.mergeGuards![0]!.inference).toMatchObject({ rule: "R3a", confidence: 0.9 });
    expect(diffs.mergeGuards.create).toHaveLength(1);
    const kept = await prisma.shiftRecord.findMany({ where: { guardId: early.id }, orderBy: { workDate: "asc" } });
    expect(kept.map((r) => r.workDate.getUTCDate())).toEqual([1, 2, 3]);
    expect(await prisma.shiftRecord.count({ where: { guardId: late.id } })).toBe(1); // 撞 unique 嗰條留喺被合併者
    expect(await prisma.guardLongtermPost.count({ where: { guardId: early.id } })).toBe(1);
    const lateRow = await prisma.guard.findUniqueOrThrow({ where: { id: late.id } });
    expect(lateRow.status).toBe("inactive");
    expect(lateRow.mergedFrom).toContain(`merged_into:${early.id}`);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: early.id } })).mergedFrom.sort()).toEqual([late.id, late2.id].sort());
    expect(await prisma.auditLog.count({ where: { action: "guard_fix_merge", rowId: { in: [late.id, late2.id] } } })).toBe(2);
    // 被合併者唔再係候選 → 淨姓名即刻配得返保留者
    expect(await bind(null, "測試同名人")).toMatchObject({ guardId: early.id, guardMatch: "by_name" });
    // 冪等
    const again = await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MAR, historicalRoster: true });
    expect(again.mergeGuards.create).toEqual([]);
  });

  it("R3b：一個本名完全相同＋其餘係後綴變體 → 揀本名相同嗰個，變體係 minimal 就合併；變體係真人就只連結唔合併", async () => {
    const exact = await mkGuard({ name: "測試後綴人", staffNo: "U90010" });
    const variantMin = await mkGuard({ name: "測試後綴人 (上)", status: "inactive", createdBy: "system:guard-fix:historical_roster" });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試後綴人", kind: "ambiguous", rowIndex: 301 }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.mergeGuards).toHaveLength(1);
    expect(plan.actions.mergeGuards![0]).toMatchObject({ keepGuardId: exact.id, mergeGuardIds: [variantMin.id] });
    expect(plan.actions.mergeGuards![0]!.inference.rule).toBe("R3b");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: variantMin.id } })).mergedFrom).toContain(`merged_into:${exact.id}`);
    expect(await bind(null, "測試後綴人")).toMatchObject({ guardId: exact.id });

    // 變體係真人（有工號）→ 只連結
    await clearAll();
    fx = await seedWp2Fixture();
    site = await mkSite("測試推斷盤二");
    upload = await mkUpload({ siteId: site.id, siteName: "測試推斷盤二", userId: fx.userIds["老闆"] });
    const exact2 = await mkGuard({ name: "測試後綴人乙" });
    const variantReal = await mkGuard({ name: "測試後綴人乙(摩)", staffNo: "U90011" });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試後綴人乙", kind: "ambiguous" }, 2);
    const r2 = await planAndApply();
    expect(r2.plan.actions.mergeGuards).toHaveLength(0);
    expect(r2.plan.actions.link).toHaveLength(1);
    expect(r2.plan.actions.link[0]).toMatchObject({ guardId: exact2.id });
    expect(r2.plan.actions.link[0]!.inference!.rule).toBe("R3b");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: variantReal.id } })).mergedFrom).toEqual([]);
  });

  it("R3c：兩個真實同名 guard，淨係一個喺同盤（含子盤）±3 個月內有更次 → 0.8 自動 link", async () => {
    const child = await mkSite("測試推斷子盤", site.id);
    const st = await mkShiftType(child.id, "D", "0700", "1900");
    const g1 = await mkGuard({ name: "測試真同名", staffNo: "U90020" });
    await mkGuard({ name: "測試真同名", staffNo: "U90021" });
    // g1 喺子盤 1 月有更次（母盤 3 月出現——家族內，±3 個月內）
    await prisma.shiftRecord.create({ data: { guardId: g1.id, siteId: child.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 0, 15)), status: "confirmed", createdBy: "test" } });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試真同名", kind: "ambiguous" }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.link).toHaveLength(1);
    expect(plan.actions.link[0]).toMatchObject({ guardId: g1.id });
    expect(plan.actions.link[0]!.inference).toMatchObject({ rule: "R3c", confidence: 0.8 });
    expect(plan.historical!.remaining).toHaveLength(0);
    // cancelled 唔計
  });

  it("R3c：兩個都有盤史／都冇 → 留 remaining，recommended 揀同盤更多嗰個（都冇就揀 active）", async () => {
    const st = await mkShiftType(site.id, "D", "0700", "1900");
    const g1 = await mkGuard({ name: "測試雙史人", staffNo: "U90030" });
    const g2 = await mkGuard({ name: "測試雙史人", staffNo: "U90031" });
    const rec = (guardId: string, day: number, status: "confirmed" | "cancelled" = "confirmed") => prisma.shiftRecord.create({ data: { guardId, siteId: site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 1, day)), status, createdBy: "test" } });
    await rec(g1.id, 1);
    await rec(g2.id, 2);
    await rec(g2.id, 3);
    await rec(g1.id, 4, "cancelled"); // cancelled 唔計
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試雙史人", kind: "ambiguous", rowIndex: 401 }, 4);
    // 另一個：兩個都冇史，一個 inactive 一個 active
    await mkGuard({ name: "測試無史人", status: "inactive", staffNo: "U90040" });
    const act = await mkGuard({ name: "測試無史人", staffNo: "U90041" });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試無史人", kind: "ambiguous", rowIndex: 402 }, 3);
    const { plan } = await planAndApply();
    expect(plan.actions.link).toHaveLength(0);
    expect(plan.actions.needsBoss).toHaveLength(0);
    const rem = plan.historical!.remaining;
    expect(rem).toHaveLength(2);
    const both = rem.find((r) => r.subject.name === "測試雙史人")!;
    expect(both.reasonCode).toBe("same_name_multi_both_history");
    expect(both.cells).toBe(4);
    expect(both.candidates.map((c) => c.sameSiteHistoryCells).sort()).toEqual([1, 2]);
    expect(both.recommended).toMatchObject({ action: "link", guardId: g2.id });
    const none = rem.find((r) => r.subject.name === "測試無史人")!;
    expect(none.reasonCode).toBe("same_name_multi_no_history");
    expect(none.recommended).toMatchObject({ action: "link", guardId: act.id });
    expect(none.candidates.every((c) => c.staffNumbers.length === 1)).toBe(true);
  });

  it("R4：三個身份同名（工號唔同／冇工號／簡繁＋後綴）→ 當同一人：格數最多為主（登記工號），其餘寫 override", async () => {
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90051", name: "測試三同名", rowIndex: 501 }, 5);
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90052", name: "测试三同名", rowIndex: 502 }, 3);
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試三同名 (上)", rowIndex: 503 }, 2);
    const { plan, diffs } = await planAndApply();
    expect(plan.actions.createMinimal).toHaveLength(1);
    const cm = plan.actions.createMinimal[0]!;
    expect(cm.inference).toMatchObject({ rule: "R4", confidence: 0.9, cells: 10 });
    expect(cm.staffNumber).toEqual({ scheme: "U", number: "U90051" });
    expect(cm.overrides).toHaveLength(3);
    expect(diffs.createMinimal.create).toHaveLength(1);
    const guards = await prisma.guard.findMany({ where: { nameZh: "測試三同名" } });
    expect(guards).toHaveLength(1);
    const g = guards[0]!;
    expect((await prisma.guardStaffNumber.findMany({ where: { guardId: g.id } })).map((n) => n.number)).toEqual(["U90051"]);
    expect([...g.nameAliases].sort()).toEqual(["测试三同名", "測試三同名 (上)"].sort());
    expect(await bind("U90051", "測試三同名")).toMatchObject({ guardId: g.id });
    expect(await bind("U90052", "测试三同名")).toMatchObject({ guardId: g.id, matchedViaStaffNoConflictOverride: true });
    expect(await bind(null, "測試三同名 (上)")).toMatchObject({ guardId: g.id });
    expect((await prisma.guardMatchOverride.findMany({ where: { guardId: g.id } })).every((o) => o.reason.startsWith("HIST5 R4"))).toBe(true);
    // 冇第二個 guard 被建
    expect(await prisma.guard.count({ where: { nameZh: { contains: "三同名" } } })).toBe(1);
  });

  it("R4 + 電話規則：同名身份之一帶共用電話 → 建人 tel 留空，另一身份嘅電話唔受影響", async () => {
    const shared = fakeTel();
    await mkGuard({ name: "測試電話持有人", tel: shared });
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90061", name: "測試雙身份", tel: shared, rowIndex: 601 }, 4);
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試雙身份", rowIndex: 602 }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]!.tel).toBeNull();
    expect(plan.actions.createMinimal[0]!.inference!.rule).toBe("R4");
    expect(plan.actions.createMinimal[0]!.extraInferences!.map((i) => i.rule)).toContain("R2c");
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試雙身份" }, include: { phones: true } });
    expect(g.phones).toHaveLength(0);
  });

  it("R5：原有 create_minimal 建人時電話撞 DB（電話寫法唔同）→ 電話留空，apply diff 記 tel_skipped_duplicate", async () => {
    const tel = fakeTel();
    await mkGuard({ name: "測試電話持有人乙", tel });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試純新人", tel: `+852${tel}` }, 2);
    const { plan, diffs } = await planAndApply();
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(diffs.createMinimal.telSkipped).toEqual([`${plan.actions.createMinimal[0]!.seq}:tel_skipped_duplicate`]);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試純新人" }, include: { phones: true } });
    expect(g.phones).toHaveLength(0);
  });

  it("正式模式（historical=false 或不傳）行為不變：冇 historical／mergeGuards／inference，電話共用照舊 needs_boss", async () => {
    const tel = fakeTel();
    await mkGuard({ name: "測試電話主丙", tel });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "完全唔同嘅人乙", tel }, 2);
    const plan = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: [] });
    expect(plan.historical).toBeUndefined();
    expect(plan.actions.mergeGuards).toBeUndefined();
    expect(plan.actions.needsBoss).toHaveLength(1);
    expect(plan.actions.needsBoss[0]!.code).toBe("weak_evidence");
    expect(plan.actions.link).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toContain("HIST5");
  });

  it("conflicting_methods（電話主人 A 同 U Team 身份證主人 B 唔同）→ remaining，recommended 用姓名規則揀", async () => {
    const tel = fakeTel();
    const a = await mkGuard({ name: "測試電話主丁", tel });
    const b = await mkGuard({ name: "測試身份證主" });
    await prisma.guard.update({ where: { id: b.id }, data: { hkid: "Z123456(7)" } });
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90090", name: "測試身份證主", tel }, 2);
    await prisma.broker.upsert({ where: { code: "Y" }, create: { code: "Y", name: "測試Y", kind: "internal_cash", settlementType: "cash", createdBy: "test" }, update: {} });
    const plan = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: [{ uNumber: "U90090", nameZh: "測試身份證主", displayName: null, tel: null, hkid: "Z123456(7)", hkidNote: null, hireDate: null, employeeStatus: null }], historical: true });
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.historical!.remaining).toHaveLength(1);
    expect(plan.historical!.remaining[0]).toMatchObject({ reasonCode: "conflicting_methods", cells: 2 });
    expect(plan.historical!.remaining[0]!.candidates.map((c) => c.guardId).sort()).toEqual([a.id, b.id].sort());
    expect(plan.historical!.remaining[0]!.recommended).toMatchObject({ action: "link", guardId: b.id });
    expect(JSON.stringify(plan.historical)).not.toContain(tel);
  });
});
