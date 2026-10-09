// WP-ONE-CLICK-AUTO（§31.3 A）：stepParseHealth 盤名比對 integration——exact／auto 加 alias 對盤、
// propose 出分診題、誤合併反例（CP1-4／CP5）當新盤、新盤自動建更種＋Postorder 客戶名／別名、
// 同一 run 同名只建一個盤、journal／audit 帶 run id。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { SEPT, mkBroker, mkGuard, seedPostorder, postorderCsv, uploadRoster } from "./lib/one-click-auto";
import { stepParseHealth } from "@/lib/month-close/one-click";
import { AutoCollector } from "@/lib/month-close/auto/context";

async function mkRun(fx: Wp2Fixture) {
  return prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
}

describe("WP-ONE-CLICK-AUTO A：盤名比對", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("新盤：自動建盤＋更種（由 raw_code＋time_raw 推出）＋Postorder 客戶名／別名；同一 run 內更次可套用", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    const g1 = await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    await seedPostorder(
      SEPT,
      boss,
      {
        postorderCsv: postorderCsv([
          { block: "測試卓弘物業服務有限公司" },
          { label: "測試尊豪坊 陳測試", prop: "測試尊豪坊", shift: "Day", client: 833, payout: 638, time: "0700-1900", total: 20 },
          { label: "測試尊豪坊", prop: "測試尊豪坊短", shift: "Day", client: 833, payout: 630, time: "0700-1900", total: 4 },
          { label: "測試恆星樓", prop: "測試恆星", shift: "Night", client: 833, payout: 630, time: "1930-0730", total: 4 },
        ]),
      },
    );
    await uploadRoster({
      siteRaw: "測試尊豪坊",
      month: SEPT,
      uploaderUserId: boss,
      lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "D", 3: "D" } }],
    });
    const run = await mkRun(fx);
    const ctx = new AutoCollector(run.id, SEPT, boss, null);
    const result = await stepParseHealth(SEPT, boss, ctx);

    expect(result.numbers.autoBuiltSites).toBe(1);
    const site = await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試尊豪坊" } });
    expect(site.clientName).toBe("測試卓弘物業服務有限公司");
    expect(site.aliases).toContain("測試尊豪坊短");
    const sts = await prisma.shiftType.findMany({ where: { siteId: site.id } });
    expect(sts).toHaveLength(1);
    expect(sts[0]!.code).toBe("D");
    expect(sts[0]!.startTime?.toISOString().slice(11, 16)).toBe("07:00");
    expect(sts[0]!.endTime?.toISOString().slice(11, 16)).toBe("19:00");
    expect(Number(sts[0]!.hours)).toBe(12);
    expect(sts[0]!.billingGroup).toBe("per_shift");
    const upload = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試尊豪坊" } });
    expect(upload.siteId).toBe(site.id);
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: upload.id } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.shiftTypeId === sts[0]!.id && r.resolvedSiteId === site.id && r.guardId === g1.id)).toBe(true);

    // journal＋audit 帶 run id
    const kinds = (await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id } })).map((c) => c.kind).sort();
    expect(kinds).toEqual(["shift_type_created", "site_created"]);
    const audits = await prisma.auditLog.findMany({ where: { tableName: { in: ["sites", "shift_types"] }, rowId: { in: [site.id, sts[0]!.id] } } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const a of audits) expect(JSON.stringify(a.after)).toContain(`auto:one-click:${run.id}`);
    expect(ctx.summary.sitesCreated).toBe(1);
    expect(ctx.summary.shiftTypesCreated).toBe(1);
  });

  it("新盤冇 Postorder：客戶名同盤名，冇別名；OT 代號建 OT 更種（冇時段）", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    await uploadRoster({
      siteRaw: "測試獨立新盤",
      month: SEPT,
      uploaderUserId: boss,
      lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "OT1.5" } }],
    });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    await stepParseHealth(SEPT, boss, ctx);
    const site = await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試獨立新盤" } });
    expect(site.clientName).toBe("測試獨立新盤");
    expect(site.aliases).toEqual([]);
    const sts = await prisma.shiftType.findMany({ where: { siteId: site.id }, orderBy: { code: "asc" } });
    expect(sts.map((s) => s.code)).toEqual(["D", "OT1.5"]);
    expect(sts[1]!.startTime).toBeNull();
    expect(Number(sts[1]!.hours)).toBe(1.5);
  });

  it("exact：全形／括號差異 → 加 alias 對盤（唔建新盤），journal site_alias", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    const site = await prisma.site.create({ data: { canonicalName: "測試港大宿舍 (上)", clientName: "測試港大", billingModel: "per_shift", createdBy: "t" } });
    await uploadRoster({ siteRaw: "測試港大宿舍・（上）", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D" } }] });
    await prisma.site.create({ data: { canonicalName: "完全無關盤XYZ", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const run = await mkRun(fx);
    const ctx = new AutoCollector(run.id, SEPT, boss, null);
    // 「・」係標點，正規化後同「測試港大宿舍(上)」相同
    const result = await stepParseHealth(SEPT, boss, ctx);
    expect(result.numbers.autoBuiltSites).toBe(0);
    const up = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試港大宿舍・（上）" } });
    expect(up.siteId).toBe(site.id);
    const refreshed = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(refreshed.aliases).toContain("測試港大宿舍・（上）");
    expect(await prisma.site.count({ where: { canonicalName: { startsWith: "測試港大宿舍" } } })).toBe(1);
    const ch = await prisma.monthCloseAutoChange.findFirst({ where: { runId: run.id, kind: "site_alias" } });
    expect(ch).not.toBeNull();
    expect(ctx.summary.sitesAliased).toBe(1);
  });

  it("auto：只差一個字、第二候選低 → 自動加 alias；CP1-4／CP5 → 當新盤（唔合併）", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    await mkGuard({ name: "測試乙", staffNo: "U90002", defaultBrokerId: brokerK.id });
    const nf = await prisma.site.create({ data: { canonicalName: "測試南豐新邨大廈管理處", clientName: "測試南豐", billingModel: "per_shift", createdBy: "t" } });
    const cp5 = await prisma.site.create({ data: { canonicalName: "測試數碼港 CP5", clientName: "測試數碼港", billingModel: "per_shift", createdBy: "t" } });
    await uploadRoster({ siteRaw: "測試南豐新村大廈管理處", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D" } }] });
    await uploadRoster({ siteRaw: "測試數碼港 CP1-4", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90002", name: "測試乙", codes: { 1: "D" } }] });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const result = await stepParseHealth(SEPT, boss, ctx);
    const up1 = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試南豐新村大廈管理處" } });
    expect(up1.siteId).toBe(nf.id);
    const up2 = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試數碼港 CP1-4" } });
    expect(up2.siteId).not.toBeNull();
    expect(up2.siteId).not.toBe(cp5.id);
    expect(result.numbers.autoBuiltSites).toBe(1);
    expect(result.warnings.some((w) => w.includes("數字／字母唔同"))).toBe(true);
    expect((await prisma.site.findUniqueOrThrow({ where: { id: cp5.id } })).aliases).toEqual([]);
  });

  it("propose：兩個接近候選 → 唔自動歸盤，分診題預填；答案一撳確認先加 alias", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    // 兩個幾乎一樣嘅候選令第二候選太近 → propose
    const a = await prisma.site.create({ data: { canonicalName: "測試海景花園大廈管理處甲", clientName: "x1", billingModel: "per_shift", createdBy: "t" } });
    await prisma.site.create({ data: { canonicalName: "測試海景花園大廈管理處乙", clientName: "x2", billingModel: "per_shift", createdBy: "t" } });
    await uploadRoster({ siteRaw: "測試海景花園大廈管理處", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D" } }] });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const result = await stepParseHealth(SEPT, boss, ctx);
    const up = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試海景花園大廈管理處" } });
    // 要麼 propose（未歸盤、有分診題），要麼因為分辨字唔同被當新盤——呢組合冇分辨字，必定係 propose
    expect(up.siteId).toBeNull();
    expect(result.numbers.proposedSites).toBe(1);
    expect(ctx.questions.map((q) => q.kind)).toEqual(["month_close_site_alias"]);
    expect(ctx.questions[0]!.evidence.confidence).toBe("propose");
    expect(ctx.questions[0]!.evidence.candidates.length).toBeGreaterThanOrEqual(2);
    expect(ctx.questions[0]!.evidence.prefillCandidateId).toBeTruthy();
    expect(a.id).toBeTruthy();
    expect(result.needsHuman.some((h) => h.includes("似現有盤但唔夠硬"))).toBe(true);
  });

  it("同一 run 兩個上載盤名只係全形／括號寫法唔同 → 淨係建一個盤", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    await mkGuard({ name: "測試乙", staffNo: "U90002", defaultBrokerId: brokerK.id });
    await uploadRoster({ siteRaw: "測試新盤（東）", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D" } }] });
    await uploadRoster({ siteRaw: "測試新盤 (東)", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90002", name: "測試乙", codes: { 2: "D" } }] });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const result = await stepParseHealth(SEPT, boss, ctx);
    expect(result.numbers.autoBuiltSites).toBe(1);
    expect(await prisma.site.count({ where: { canonicalName: { startsWith: "測試新盤" } } })).toBe(1);
    const ups = await prisma.rosterUpload.findMany({ where: { month: SEPT, siteNameRaw: { startsWith: "測試新盤" } } });
    expect(new Set(ups.map((u) => u.siteId)).size).toBe(1);
  });

  it("子盤參與比對：全形括號寫法對到子盤就歸子盤，唔另建重複頂層盤", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    const parent = await prisma.site.create({ data: { canonicalName: "測試母盤城巴", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const child = await prisma.site.create({ data: { canonicalName: "測試母盤城巴 (柴灣)", clientName: "x", parentSiteId: parent.id, billingModel: "per_shift", createdBy: "t" } });
    await uploadRoster({ siteRaw: "測試母盤城巴（柴灣）", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "0700-1900", staffNo: "U90001", name: "測試甲", codes: { 1: "D" } }] });
    const before = await prisma.site.count();
    await stepParseHealth(SEPT, boss, new AutoCollector(null, SEPT, boss, null));
    expect(await prisma.site.count()).toBe(before);
    const up = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteNameRaw: "測試母盤城巴（柴灣）" } });
    expect(up.siteId).toBe(child.id);
  });

  it("新盤時段解析唔到（7am-7pm／空）：唔建 null 時段更種，出題＋warning；unknown 代號格（D-2）要提示", async () => {
    const boss = fx.userIds["老闆"];
    const brokerK = await mkBroker("TK", "broker");
    await mkGuard({ name: "測試甲", staffNo: "U90001", defaultBrokerId: brokerK.id });
    await mkGuard({ name: "測試乙", staffNo: "U90002", defaultBrokerId: brokerK.id });
    await uploadRoster({ siteRaw: "測試怪時段新盤", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", time: "7am-7pm", staffNo: "U90001", name: "測試甲", codes: { 1: "D", 2: "D-2" } }] });
    await uploadRoster({ siteRaw: "完全唔同嘅獨特新盤XYZ", month: SEPT, uploaderUserId: boss, lines: [{ broker: "TK", staffNo: "U90002", name: "測試乙", codes: { 1: "N" } }] });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const res = await stepParseHealth(SEPT, boss, ctx);
    for (const name of ["測試怪時段新盤", "完全唔同嘅獨特新盤XYZ"]) {
      const site = await prisma.site.findUniqueOrThrow({ where: { canonicalName: name } });
      expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(0);
    }
    expect(ctx.questions.filter((q) => q.kind === "month_close_site_new")).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes("時段解析唔到"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("代號系統唔識") && w.includes("D-2"))).toBe(true);
    expect(res.needsHuman.some((w) => w.includes("D-2"))).toBe(true);
  });
});
