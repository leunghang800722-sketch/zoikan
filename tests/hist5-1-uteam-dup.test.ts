// HIST-5.1：U Team 名單同名多行 R6a／R6b／R6c、R3d、3 字名姓同名差一字變體。全部假資料（測試…名、U9xxxx 工號、fakeTel、假身份證）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { fakeTel, mkSite, mkShiftType, mkGuard, mkUpload, mkRows, planAndApply, MAR } from "./helpers/hist5";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { collectHistInferences } from "@/lib/month-close/one-click";
import { isNameVariant, isLooseNameVariant, isStrictNameVariant, type HistInference, type HistReviewHint } from "@/lib/month-close/hist-inference";
import { buildUTeamIndex, uNumberKey, type UTeamRow } from "@/lib/guard-fix/sources";
import { pickUTeamDuplicateRow } from "@/lib/guard-fix/historical-plan";

const HK1 = "A1234563";
const HK2 = "B2345671";
const urow = (o: Partial<UTeamRow> & { nameZh: string }): UTeamRow => ({ uNumber: null, displayName: null, tel: null, hkid: null, hkidNote: null, hireDate: "2026-01-05", employeeStatus: null, ...o });

describe("HIST-5.1 純函數", () => {
  it("3 字名變體：姓相同＋名其中一字相同、另一字唔同 → 變體；反例（姓唔同／名兩字都唔同／4 字照舊）", () => {
    expect(isNameVariant("測試甲", "測試乙")).toBe(true); // 末字差
    expect(isNameVariant("測試甲", "測丙甲")).toBe(true); // 中字差
    expect(isLooseNameVariant("測試甲", "測試乙")).toBe(true);
    expect(isStrictNameVariant("測試甲", "測試乙")).toBe(false);
    expect(isNameVariant("測試甲", "李試甲")).toBe(false); // 姓唔同（只差首字）
    expect(isNameVariant("測試甲", "測丙乙")).toBe(false); // 名兩字都唔同
    expect(isNameVariant("測試甲", "測試甲乙")).toBe(false); // 長度唔同（3 vs 4）
    expect(isLooseNameVariant("測試甲", "測试甲")).toBe(false); // 簡繁相同＝嚴格變體，唔算 loose
    expect(isNameVariant("測試阿甲", "測試阿乙")).toBe(true); // 4 字 ≤1 字差（現有）
  });

  it("U 號查表鍵：全形／空白／大小寫都歸一；pickUTeamDuplicateRow 次序＝工號 → R6a → R6b", () => {
    expect(uNumberKey(" ｕ９０１２３ ")).toBe("U90123");
    expect(uNumberKey("U 90123")).toBe("U90123");
    const idx = buildUTeamIndex([urow({ nameZh: "測試名單甲", uNumber: "Ｕ90123" })]);
    expect(idx.byUNumber.get(uNumberKey("u 90123"))).toBeTruthy();
    const rows = [urow({ nameZh: "測試名單乙", uNumber: "U90201", hkid: HK1, tel: "61230001" }), urow({ nameZh: "測試名單乙", uNumber: "U90202", hkid: HK2, tel: "61230002" })];
    expect(pickUTeamDuplicateRow(rows, "u 90202", null)).toMatchObject({ via: "number" });
    expect(pickUTeamDuplicateRow(rows, null, "61230002")).toMatchObject({ via: "R6b" });
    expect(pickUTeamDuplicateRow(rows, null, "61239999")).toBeNull();
    // 身份證全部一致（含只有一行有）→ R6a，有身份證嗰行優先
    const same = [urow({ nameZh: "測試名單丙", uNumber: "U90301" }), urow({ nameZh: "測試名單丙", uNumber: "U90302", hkid: HK1 }), urow({ nameZh: "測試名單丙", uNumber: "U90303", hkid: HK1 })];
    expect(pickUTeamDuplicateRow(same, null, null)).toMatchObject({ via: "R6a", row: { uNumber: "U90302" } });
    // 全部冇身份證 → 唔當重複行（可能係兩個人）
    expect(pickUTeamDuplicateRow([urow({ nameZh: "測試名單丁" }), urow({ nameZh: "測試名單丁" })], null, null)).toBeNull();
  });
});

describe("HIST-5.1 R6 名單同名多行", () => {
  let fx: Wp2Fixture;
  let site: { id: string };
  let upload: { id: string };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    site = await mkSite("測試名單盤");
    upload = await mkUpload({ siteId: site.id, siteName: "測試名單盤", userId: fx.userIds["老闆"] });
  });

  it("R6a：同名多行身份證一致（一行有、其餘空）→ 用有身份證嗰行 create（信心 0.85），唔 needs_boss，guard 帶名單身份證／U 號", async () => {
    const uRows = [urow({ nameZh: "測試名單甲", uNumber: "U90401" }), urow({ nameZh: "測試名單甲", uNumber: "U90402", hkid: HK1 }), urow({ nameZh: "測試名單甲", uNumber: "U90403", hkid: HK1 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試名單甲" }, 3);
    const { plan, diffs } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.historical!.remaining).toHaveLength(0);
    expect(plan.actions.create).toHaveLength(1);
    expect(plan.actions.create[0]).toMatchObject({ uNumber: "U90402", hkid: HK1 });
    expect(plan.actions.create[0]!.inference).toMatchObject({ rule: "R6a", confidence: 0.85, cells: 3 });
    expect(JSON.stringify(plan.actions.create[0]!.inference)).not.toContain(HK1);
    expect(diffs.create.create).toHaveLength(1);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試名單甲" } });
    expect(g.hkid).toBe(HK1);
    expect((await prisma.guardStaffNumber.findMany({ where: { guardId: g.id } })).map((n) => n.number)).toEqual(["U90402"]);
    expect(await prisma.auditLog.count({ where: { rowId: g.id, action: "guard_fix_inference" } })).toBe(1);
    // 收集到報告
    const inf = new Map<string, HistInference>();
    collectHistInferences(plan, diffs, inf, new Map());
    expect([...inf.values()].map((i) => i.rule)).toEqual(["R6a"]);
  });

  it("R6b：同名多行身份證唔同，更表電話剛好等於其中一行 → 用嗰行 create（信心 0.85，evidence 唔出電話）", async () => {
    const tel2 = fakeTel();
    const uRows = [urow({ nameZh: "測試名單乙", uNumber: "U90411", hkid: HK1, tel: fakeTel() }), urow({ nameZh: "測試名單乙", uNumber: "U90412", hkid: HK2, tel: tel2 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試名單乙", tel: tel2 }, 2);
    const { plan } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.create).toHaveLength(1);
    expect(plan.actions.create[0]).toMatchObject({ uNumber: "U90412", hkid: HK2 });
    expect(plan.actions.create[0]!.inference).toMatchObject({ rule: "R6b", confidence: 0.85 });
    expect(JSON.stringify(plan.actions.create[0]!.inference)).not.toContain(tel2);
    expect((await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試名單乙" } })).hkid).toBe(HK2);
  });

  it("R6c：分辨唔到，更表工號 DB 冇人用 → 唔用名單資料建獨立保安員、登記工號 current，出 review_hint（信心 0.7）", async () => {
    const tel = fakeTel();
    const uRows = [urow({ nameZh: "測試名單丙", uNumber: "U90421", hkid: HK1, tel: fakeTel() }), urow({ nameZh: "測試名單丙", uNumber: "U90422", hkid: HK2, tel: fakeTel() })];
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90429", name: "測試名單丙", tel }, 4);
    const { plan, diffs } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.create).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    const cm = plan.actions.createMinimal[0]!;
    expect(cm.inference).toMatchObject({ rule: "R6c", confidence: 0.7, cells: 4 });
    expect(cm.staffNumber).toEqual({ scheme: "U", number: "U90429" });
    expect(cm.overrides).toEqual([{ staffNo: "U90429", nameRaw: "測試名單丙" }]);
    const hint = plan.historical!.reviewHints.find((h) => h.rule === "R6c")!;
    expect(hint.hint).toBe("名單有 2 個同名行，未用名單資料（身份證／入職日未補）");
    // DB：冇身份證／入職日、冇用名單 U 號，登記更表工號，電話照更表
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試名單丙" }, include: { phones: true } });
    expect(g.hkid).toBeNull();
    expect(g.hireDate).toBeNull();
    expect((await prisma.guardStaffNumber.findMany({ where: { guardId: g.id } })).map((n) => `${n.number}:${n.status}`)).toEqual(["U90429:current"]);
    expect(g.phones.map((p) => p.tel)).toEqual([tel]);
    expect((await prisma.guardMatchOverride.findMany({ where: { guardId: g.id } })).every((o) => o.reason.startsWith("HIST5 R6c"))).toBe(true);
    // 收集：推斷＋抽查提示
    const inf = new Map<string, HistInference>();
    const hints = new Map<string, HistReviewHint>();
    collectHistInferences(plan, diffs, inf, hints);
    expect([...inf.values()].map((i) => i.rule)).toEqual(["R6c"]);
    expect([...hints.values()].map((h) => h.rule)).toEqual(["R6c"]);
  });

  it("R6c：更表工號 DB 已有人用（舊卡 former，配對層唔認）→ 唔登記工號，只寫 override；電話屬別人 → tel 留空（同 R2）", async () => {
    const tel = fakeTel();
    const old = await mkGuard({ name: "測試工號主丁", staffNo: "U90439" });
    await prisma.guardStaffNumber.update({ where: { number: "U90439" }, data: { status: "former" } });
    // 電話被兩個 guard 共用（findByTel 唯一才算命中）→ 去到名單階段，而電話屬別人 → R6c 留空
    for (const n of ["測試電話主丁甲", "測試電話主丁乙"]) await prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", status: "active", createdBy: "test", tel } });
    const uRows = [urow({ nameZh: "測試名單丁", hkid: HK1 }), urow({ nameZh: "測試名單丁", hkid: HK2 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90439", name: "測試名單丁", tel }, 2);
    const { plan } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    const cm = plan.actions.createMinimal[0]!;
    expect(cm.inference).toMatchObject({ rule: "R6c" });
    expect(cm.tel).toBeNull();
    expect(cm.staffNumber ?? null).toBeNull();
    expect(cm.overrides).toEqual([{ staffNo: "U90439", nameRaw: "測試名單丁" }]);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試名單丁" }, include: { phones: true } });
    expect(g.phones).toHaveLength(0);
    expect((await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "U90439" } })).guardId).toBe(old.id);
    expect(await prisma.guardMatchOverride.count({ where: { guardId: g.id } })).toBe(1);
  });

  it("R6c：選中行（R6a）被原有 refuse 條件拒（名單身份證已喺 DB）→ 唔再 needs_boss，改建獨立保安員＋hint 講被拒原因", async () => {
    const holder = await mkGuard({ name: "測試身份證持有人" });
    await prisma.guard.update({ where: { id: holder.id }, data: { hkid: HK1 } });
    const uRows = [urow({ nameZh: "測試名單己", uNumber: "U90451", hkid: HK1 }), urow({ nameZh: "測試名單己", uNumber: "U90452", hkid: HK1 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試名單己" }, 2);
    const { plan } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.historical!.remaining).toHaveLength(0);
    expect(plan.actions.create).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]!.inference).toMatchObject({ rule: "R6c", confidence: 0.7 });
    const hint = plan.historical!.reviewHints.find((h) => h.rule === "R6c")!;
    expect(hint.hint).toContain("名單有 2 個同名行，未用名單資料");
    expect(hint.hint).toContain("名單身份證已經喺 DB");
    expect(JSON.stringify(plan)).not.toContain(HK1.slice(1)); // 身份證唔入 inference／hint（create 動作本身冇用名單資料）
  });

  it("R6c + R4：三個身份同名（兩個工號＋冇工號）各自 R6c → R4 合一，只建一個人；hint 掛喺主身份並收集到", async () => {
    const uRows = [urow({ nameZh: "測試名單庚", hkid: HK1 }), urow({ nameZh: "測試名單庚", hkid: HK2 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90461", name: "測試名單庚", rowIndex: 701 }, 5);
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "U90462", name: "測試名單庚", rowIndex: 702 }, 3);
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試名單庚", rowIndex: 703 }, 2);
    const { plan, diffs } = await planAndApply(true, uRows);
    expect(plan.actions.needsBoss).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(1);
    const cm = plan.actions.createMinimal[0]!;
    expect(cm.inference).toMatchObject({ rule: "R4", cells: 10 });
    expect(cm.staffNumber).toEqual({ scheme: "U", number: "U90461" });
    expect(cm.overrides).toHaveLength(3);
    expect((cm.extraInferences ?? []).filter((i) => i.rule === "R6c")).toHaveLength(3);
    expect(await prisma.guard.count({ where: { nameZh: "測試名單庚" } })).toBe(1);
    // hint 全部掛喺倖存嗰個 seq
    expect(plan.historical!.reviewHints.every((h) => h.seq === cm.seq)).toBe(true);
    const hints = new Map<string, HistReviewHint>();
    collectHistInferences(plan, diffs, new Map(), hints);
    expect([...hints.values()].filter((h) => h.rule === "R6c").length).toBeGreaterThanOrEqual(1);
  });

  it("正式模式不變：名單同名多行照舊 needs_boss，唔出 inference／create；同 U 號全形/空白索引唔影響", async () => {
    const uRows = [urow({ nameZh: "測試名單辛", hkid: HK1 }), urow({ nameZh: "測試名單辛", hkid: HK1 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試名單辛" }, 2);
    const plan = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: uRows });
    expect(plan.historical).toBeUndefined();
    expect(plan.actions.needsBoss).toHaveLength(1);
    expect(plan.actions.needsBoss[0]!.reason).toContain("U Team 名單同名多過一個");
    expect(plan.actions.create).toHaveLength(0);
    expect(plan.actions.createMinimal).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toContain("R6");
  });

  it("名單 U 號帶全形／空白，更表工號寫法唔同 → 仍用 U 號搵到行（唔落名單同名多行路徑）", async () => {
    const uRows = [urow({ nameZh: "測試名單壬", uNumber: "Ｕ 90471", hkid: HK1 }), urow({ nameZh: "測試名單壬", uNumber: "U90472", hkid: HK2 })];
    await mkRows({ uploadId: upload.id, siteId: site.id, staffNo: "u90471", name: "測試名單壬" }, 2);
    const { plan } = await planAndApply(true, uRows);
    expect(plan.actions.create).toHaveLength(1);
    expect(plan.actions.create[0]!.reason).toBe("U Team 名單 U 號搵到");
    expect(plan.actions.create[0]!.hkid).toBe(HK1);
    expect(plan.actions.createMinimal).toHaveLength(0);
  });
});

describe("HIST-5.1 R3d／3 字名變體（plan＋apply）", () => {
  let fx: Wp2Fixture;
  let site: { id: string };
  let upload: { id: string };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    site = await mkSite("測試合併盤");
    upload = await mkUpload({ siteId: site.id, siteName: "測試合併盤", userId: fx.userIds["老闆"] });
  });
  const HIST_BY = "system:guard-fix:historical_roster";

  it("R3d（no_history）：一個歷史 minimal＋一個真實 guard（名差一字，別名同更表用名）→ 併入真實，信心 0.7，shift_records 搬、minimal 標 merged_into，出 hint", async () => {
    const st = await mkShiftType(site.id, "D", "0700", "1900");
    const real = await mkGuard({ name: "測試同名真", aliases: ["測試同名乙"], staffNo: "U90501" });
    const minimal = await mkGuard({ name: "測試同名乙", status: "inactive", createdBy: HIST_BY });
    await prisma.shiftRecord.create({ data: { guardId: minimal.id, siteId: site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 0, 5)), status: "confirmed", createdBy: "test" } });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試同名乙", kind: "ambiguous" }, 2);
    const { plan, diffs } = await planAndApply();
    expect(plan.historical!.remaining).toHaveLength(0);
    expect(plan.actions.link).toHaveLength(0);
    expect(plan.actions.mergeGuards).toHaveLength(1);
    const ma = plan.actions.mergeGuards![0]!;
    expect(ma).toMatchObject({ keepGuardId: real.id, mergeGuardIds: [minimal.id] });
    expect(ma.inference).toMatchObject({ rule: "R3d", confidence: 0.7 });
    expect(plan.historical!.reviewHints.find((h) => h.rule === "R3d")!.hint).toBe("歷史 minimal 同名併入真實保安員");
    expect(diffs.mergeGuards.create).toEqual([ma.seq]);
    expect(await prisma.shiftRecord.count({ where: { guardId: real.id } })).toBe(1);
    const m = await prisma.guard.findUniqueOrThrow({ where: { id: minimal.id } });
    expect(m.mergedFrom).toContain(`merged_into:${real.id}`);
    const hints = new Map<string, HistReviewHint>();
    collectHistInferences(plan, diffs, new Map(), hints);
    expect([...hints.values()].map((h) => h.rule)).toEqual(["R3d"]);
  });

  it("R3d（both_history）：真實 guard 同盤有歷史 → 信心 0.75；minimal 亦有歷史照併", async () => {
    const st = await mkShiftType(site.id, "D", "0700", "1900");
    const real = await mkGuard({ name: "測試同名真丙", aliases: ["測試同名丙"], staffNo: "U90511" });
    const minimal = await mkGuard({ name: "測試同名丙", status: "inactive", createdBy: HIST_BY });
    const rec = (guardId: string, day: number) => prisma.shiftRecord.create({ data: { guardId, siteId: site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 1, day)), status: "confirmed", createdBy: "test" } });
    await rec(real.id, 1);
    await rec(real.id, 2);
    await rec(minimal.id, 3);
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試同名丙", kind: "ambiguous" }, 2);
    const { plan } = await planAndApply();
    expect(plan.historical!.remaining).toHaveLength(0);
    expect(plan.actions.mergeGuards).toHaveLength(1);
    expect(plan.actions.mergeGuards![0]!.inference).toMatchObject({ rule: "R3d", confidence: 0.75, cells: 2 });
    expect(await prisma.shiftRecord.count({ where: { guardId: real.id } })).toBe(3);
  });

  it("R3d 反例：兩個真實 guard 同名（無 minimal）照舊 R3c／remaining，唔合併", async () => {
    await mkGuard({ name: "測試雙真人", staffNo: "U90521" });
    await mkGuard({ name: "測試雙真人", staffNo: "U90522" });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測試雙真人", kind: "ambiguous" }, 2);
    const { plan } = await planAndApply();
    expect(plan.actions.mergeGuards ?? []).toHaveLength(0);
    expect(plan.historical!.remaining).toHaveLength(1);
    expect(plan.historical!.remaining[0]!.reasonCode).toBe("same_name_multi_no_history");
  });

  it("3 字名變體（R2b）：電話屬 A，更表姓名同 A 姓相同、名差一字 → link A＋加別名，信心 0.80（嚴格變體 0.85）；姓唔同 → 唔係變體，R2c 建獨立人 tel 留空", async () => {
    const tel1 = fakeTel();
    const tel2 = fakeTel();
    const a = await mkGuard({ name: "測試甲", tel: tel1 });
    await mkGuard({ name: "測試乙", tel: tel2 });
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "測丙甲", tel: tel1, rowIndex: 801 }, 2); // 姓同、中字差 → 變體
    await mkRows({ uploadId: upload.id, siteId: site.id, name: "李試乙", tel: tel2, rowIndex: 802 }, 2); // 姓唔同 → 唔係
    const { plan } = await planAndApply();
    expect(plan.actions.link).toHaveLength(1);
    expect(plan.actions.link[0]).toMatchObject({ guardId: a.id });
    expect(plan.actions.link[0]!.inference).toMatchObject({ rule: "R2b", confidence: 0.8 });
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: a.id } })).nameAliases).toContain("測丙甲");
    expect(plan.actions.createMinimal).toHaveLength(1);
    expect(plan.actions.createMinimal[0]!.inference).toMatchObject({ rule: "R2c" });
    expect(plan.actions.createMinimal[0]!.tel).toBeNull();
  });
});
