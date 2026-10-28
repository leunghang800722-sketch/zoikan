// HIST-5 端到端（經 parser＋一鍵歷史導入）：B 更種／代號推斷 S1–S4、A 身份推斷落到報告、needsHuman 與 remaining 一致、
// 報告零電話、inferences API。全部假資料（測試…名、U9xxxx 工號、fakeTel）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { GET as getInferences } from "@/app/api/month-close/historical-import/inferences/route";
import { GET as listImport } from "@/app/api/month-close/historical-import/route";
import { markHistoricalMonth } from "@/lib/month-close/historical";
import { collectHistInferences } from "@/lib/month-close/one-click";
import { runHistoricalImport, claimHistoricalImportRun, type HistImportReport } from "@/lib/month-close/historical-import";
import { fakeTel, mkGuard, mkRow, mkShiftType, mkSite, mkUpload, rosterXlsx, seedStaffList, type RosterPerson } from "./helpers/hist5";

const monthOf = (m: number) => new Date(Date.UTC(2026, m - 1, 1));

describe("HIST-5 端到端", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    for (const m of [1, 2, 3]) await markHistoricalMonth(monthOf(m), fx.userIds["老闆"], { ip: null });
  });

  async function upload(bytes: Buffer, month: string, name = `h5-${Math.random()}.xlsx`): Promise<void> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], name));
    form.set("month", month);
    const res = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
    expect(res.status).toBe(201);
  }
  async function runImport(m: number): Promise<{ report: HistImportReport; runId: string; run: Awaited<ReturnType<typeof prisma.historicalImportRun.findUniqueOrThrow>> }> {
    const runId = await claimHistoricalImportRun(monthOf(m), fx.userIds["老闆"]);
    await runHistoricalImport(runId, monthOf(m), fx.userIds["老闆"], null);
    const run = await prisma.historicalImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorMessage).toBeNull();
    expect(run.status).toBe("done");
    return { report: run.reportJson as unknown as HistImportReport, runId, run };
  }
  const person = (p: Partial<RosterPerson> & { name: string; codes: string[] }): RosterPerson => ({ broker: "TEST-BA", time: "0700-1900", ...p });

  // ---------------------------------------------------------------- S1
  it("S1：單字母代號 A 按該行時段當出更——A 早更行／A 夜更行建兩個更種；B 沿用同時段既有更種（任何 code）；報告列 (盤,字母,時段)", async () => {
    const site = await mkSite("測試單字母盤");
    await mkShiftType(site.id, "IC", "1430", "2230", 8);
    await upload(
      await rosterXlsx({
        site: "測試單字母盤",
        people: [
          person({ staffNo: "T-A01", name: "測試保安員甲", time: "0730-1930", codes: ["A", "A", "A"] }),
          person({ staffNo: "T-B01", name: "測試保安員乙", time: "1930-0730", codes: ["A", "A", ""] }),
          person({ name: "測試保安員甲", staffNo: "T-A01", time: "1430-2230", rank: "Zone IC", codes: ["", "", "B"] }),
        ],
      }),
      "2026-03",
    );
    const { report } = await runImport(3);
    const types = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null }, orderBy: [{ code: "asc" }, { startTime: "asc" }] });
    expect(types.map((t) => `${t.code}@${t.startTime?.toISOString().slice(11, 16)}`)).toEqual(["A@07:30", "A@19:30", "IC@14:30"]);
    expect(report.totals.unresolved).toBe(0);
    expect(report.perSite[0]!.written).toBe(6);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(6);
    const s1 = report.inferences.filter((i) => i.rule === "S1");
    expect(s1.map((i) => `${i.subject.code}|${i.subject.timeSlot}|${i.cells}`).sort()).toEqual(["A|0730-1930|3", "A|1930-0730|2", "B|1430-2230|1"]);
    expect(s1.every((i) => i.confidence === 0.85 && i.subject.site === "測試單字母盤")).toBe(true);
    expect(s1.find((i) => i.subject.code === "B")!.decision).toContain("IC");
    // row warning
    const rows = await prisma.rosterUploadRow.findMany({ where: { rawCode: "A" } });
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.codeKind === "shift" && JSON.stringify(r.warnings).includes("單字母代號按該行時段當出更（AI 推斷）"))).toBe(true);
    // 冪等：再跑一次，更種數不變、記錄數不變、推斷仍然列出
    const again = await runImport(3);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(3);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(6);
    expect(again.report.inferences.filter((i) => i.rule === "S1")).toHaveLength(3);
  });

  it("S1n：單字母代號但時段解析唔到 → 冇開始時間更種（只計出勤），信心 0.7", async () => {
    const site = await mkSite("測試單字母無時段盤");
    await upload(await rosterXlsx({ site: "測試單字母無時段盤", people: [person({ staffNo: "T-A01", name: "測試保安員甲", time: "SG", codes: ["A", "A", "A"] })] }), "2026-03");
    const { report } = await runImport(3);
    const types = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null } });
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ code: "A", startTime: null });
    expect(report.perSite[0]!.written).toBe(3);
    const s1n = report.inferences.filter((i) => i.rule === "S1n");
    expect(s1n).toHaveLength(1);
    expect(s1n[0]).toMatchObject({ confidence: 0.7, cells: 3, subject: { code: "A" } });
  });

  // ---------------------------------------------------------------- S2
  it("S2：母盤（有子盤）自己嘅 OT1hr 同「同 code 唔同時段」更種自動建（之前母盤被跳過）；OT hours 由 code 取；報告 S2 0.9", async () => {
    const parent = await mkSite("測試母盤");
    await mkSite("測試母盤子盤", parent.id);
    await mkShiftType(parent.id, "D", "0700", "1900", 12);
    await mkShiftType(parent.id, "D", "1900", "0700", 12);
    await upload(
      await rosterXlsx({
        site: "測試母盤",
        people: [
          person({ staffNo: "T-A01", name: "測試保安員甲", time: "0700-1515", codes: ["D", "D", ""] }), // 同 code 唔同時段
          person({ staffNo: "T-B01", name: "測試保安員乙", time: "0615-0715", rank: "OT", codes: ["OT1hr", "OT1hr", "OT1hr"] }),
        ],
      }),
      "2026-03",
    );
    const { report } = await runImport(3);
    const types = await prisma.shiftType.findMany({ where: { siteId: parent.id, voidedAt: null }, orderBy: [{ code: "asc" }, { startTime: "asc" }] });
    expect(types.map((t) => `${t.code}@${t.startTime?.toISOString().slice(11, 16) ?? "null"}`).sort()).toEqual(["D-2@07:00", "D@07:00", "D@19:00", "OT1hr@null"]);
    expect(types.find((t) => t.code === "D-2")!.endTime?.toISOString().slice(11, 16)).toBe("15:15"); // 同 code＋同開工、收工唔同 → -2 後綴另建
    expect(Number(types.find((t) => t.code === "OT1hr")!.hours)).toBe(1);
    expect(report.totals.unresolved).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { siteId: parent.id } })).toBe(5);
    const s2 = report.inferences.filter((i) => i.rule === "S2");
    expect(s2.map((i) => `${i.subject.code}|${i.cells}`).sort()).toEqual(["D-2|2", "OT1hr|3"]);
    expect(s2.every((i) => i.confidence === 0.9)).toBe(true);
  });

  // ---------------------------------------------------------------- S3
  it("S3：代號等於另一個盤嘅別名 → 寫落嗰個盤，更種喺目標盤建；row warning＋報告 S3 0.85", async () => {
    const target = await prisma.site.create({ data: { canonicalName: "測試跨盤目標", aliases: ["XP5"], clientName: "測試跨盤目標客戶", billingModel: "per_shift", createdBy: "test" } });
    const target2 = await mkSite("測試跨盤括號 (XQ6)"); // 冇別名，靠盤名尾括號內嘅短代號
    const source = await mkSite("測試跨盤來源");
    await mkShiftType(source.id, "D", "0700", "1900", 12);
    await upload(
      await rosterXlsx({
        site: "測試跨盤來源",
        people: [person({ staffNo: "T-A01", name: "測試保安員甲", time: "0800-2000", codes: ["XP5", "XP5", "D", "XQ6"] })],
      }),
      "2026-03",
    );
    const { report } = await runImport(3);
    expect(await prisma.shiftRecord.count({ where: { siteId: target.id } })).toBe(2);
    expect(await prisma.shiftRecord.count({ where: { siteId: source.id } })).toBe(1); // 第三格 D 留喺來源盤
    const types = await prisma.shiftType.findMany({ where: { siteId: target.id, voidedAt: null } });
    expect(types.map((t) => t.code)).toEqual(["XP5"]);
    const s3 = report.inferences.filter((i) => i.rule === "S3");
    expect(s3).toHaveLength(2);
    expect(s3.find((i) => i.subject.code === "XP5")).toMatchObject({ confidence: 0.85, cells: 2, subject: { site: "測試跨盤目標" } });
    expect(s3.find((i) => i.subject.code === "XQ6")).toMatchObject({ cells: 1, subject: { site: "測試跨盤括號 (XQ6)" } });
    expect(await prisma.shiftRecord.count({ where: { siteId: target2.id } })).toBe(1);
    const rows = await prisma.rosterUploadRow.findMany({ where: { rawCode: "XP5" } });
    expect(rows.every((r) => r.resolvedSiteId === target.id && JSON.stringify(r.warnings).includes("跨盤代號（AI 推斷）"))).toBe(true);
  });

  // ---------------------------------------------------------------- S4
  it("S4：跨月格——(i) 已由另一月檔案寫入＝cross_month_duplicate、(ii) 目標月份非歷史＝out_of_scope、(iii) 未鎖歷史月份冇記錄＝直接寫入；總未入只計真正未入", async () => {
    const site = await mkSite("測試跨月盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    // 3 月檔：3 月 1 日、5 日
    const marCodes = Array.from({ length: 5 }, (_, i) => (i === 0 || i === 4 ? "D" : ""));
    await upload(await rosterXlsx({ site: "測試跨月盤", people: [person({ staffNo: "T-A01", name: "測試保安員甲", codes: marCodes })] }), "2026-03", "mar.xlsx");
    // 2 月檔：由 2025-12-31 起 62 日（12/31、1 月、2 月、3/1–3/2）
    const feb = Array.from({ length: 62 }, (_, i) => (i === 0 || i === 3 || i === 32 || i === 60 ? "D" : ""));
    await upload(await rosterXlsx({ site: "測試跨月盤", year: 2025, month: 12, startDay: 31, people: [person({ staffNo: "T-A01", name: "測試保安員甲", codes: feb })] }), "2026-02", "feb.xlsx");

    const mar = await runImport(3);
    expect(mar.report.totals.written).toBe(2);
    const febRun = await runImport(2);
    const r = febRun.report;
    expect(r.totals.cells).toBe(4);
    expect(r.totals.written).toBe(2); // 2 月 1 日 + 1 月 3 日（跨月直寫，match 回自己）
    expect(r.totals.crossMonthDuplicate).toBe(1); // 3 月 1 日
    expect(r.totals.outOfScope).toBe(1); // 2025-12-31
    expect(r.totals.unresolved).toBe(0);
    expect(r.perSite[0]).toMatchObject({ crossMonthDuplicate: 1, outOfScope: 1, unresolved: 0 });
    const jan3 = await prisma.shiftRecord.findFirst({ where: { workDate: new Date(Date.UTC(2026, 0, 3)), siteId: site.id } });
    expect(jan3).not.toBeNull();
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2025, 11, 31)) } })).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 2, 1)) } })).toBe(1); // 冇重複寫
    const s4 = r.inferences.filter((i) => i.rule === "S4");
    expect(s4).toHaveLength(1);
    expect(s4[0]).toMatchObject({ confidence: 0.95, cells: 1, subject: { site: "測試跨月盤" } });
    expect(s4[0]!.decision).toContain("2026-01");
    // 冪等：再跑 2 月，jan3 已寫 → 仍然 match（唔變成重複），數字不變
    const again = await runImport(2);
    expect(again.report.totals).toMatchObject({ written: 2, crossMonthDuplicate: 1, outOfScope: 1, unresolved: 0 });
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(4);
    expect(again.report.inferences.filter((i) => i.rule === "S4")).toHaveLength(1);
  });

  it("S4：目標歷史月份已鎖 → out_of_scope，唔寫入", async () => {
    const site = await mkSite("測試跨月盤鎖");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    await prisma.monthClose.update({ where: { month: monthOf(1) }, data: { lockedAt: new Date() } });
    const feb = Array.from({ length: 40 }, (_, i) => (i === 3 || i === 33 ? "D" : "")); // 1 月 3 日（鎖咗）、2 月 2 日
    await upload(await rosterXlsx({ site: "測試跨月盤鎖", year: 2025, month: 12, startDay: 31, people: [person({ staffNo: "T-A01", name: "測試保安員甲", codes: feb })] }), "2026-02");
    const { report } = await runImport(2);
    expect(report.totals).toMatchObject({ outOfScope: 1, crossMonthDuplicate: 0, unresolved: 0, written: 1 });
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 0, 3)) } })).toBe(0);
  });

  // ---------------------------------------------------------------- A 落到報告
  it("A：R1／R2a 經完整歷史導入自動落地（寫入更次、報告 inferences、remaining 空、needsHuman 空）；報告同 steps_json 零電話", async () => {
    const site = await mkSite("測試身份盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    await seedStaffList(fx.userIds["老闆"]);
    const telOwner = fakeTel();
    await mkGuard({ name: "測試工號主", staffNo: "U90001" });
    const b1 = await mkGuard({ name: "測試姓名唯一" });
    await mkGuard({ name: "測試電話主", tel: telOwner });
    const b2 = await mkGuard({ name: "測試乙唯一" });
    await upload(
      await rosterXlsx({
        site: "測試身份盤",
        people: [
          person({ staffNo: "U90001", name: "測試姓名唯一", codes: ["D", "D", "D"] }), // R1
          person({ tel: telOwner, name: "測試乙唯一", codes: ["D", "D", ""] }), // R2a
        ],
      }),
      "2026-03",
    );
    const { report, run } = await runImport(3);
    expect(report.totals.unresolved).toBe(0);
    expect(report.remaining).toEqual([]);
    expect(report.needsHuman.filter((h) => h.includes("未配對保安員"))).toEqual([]);
    expect(report.inferences.map((i) => i.rule).sort()).toEqual(["R1", "R2a"]);
    expect(await prisma.shiftRecord.count({ where: { guardId: b1.id } })).toBe(3);
    expect(await prisma.shiftRecord.count({ where: { guardId: b2.id } })).toBe(2);
    const r1 = report.inferences.find((i) => i.rule === "R1")!;
    expect(r1).toMatchObject({ confidence: 0.9, cells: 3, subject: { name: "測試姓名唯一", staffNo: "U90001" } });
    // PII：報告、steps_json、override reason、audit 都唔含電話
    const blob = JSON.stringify([run.reportJson, run.stepsJson]);
    expect(blob).not.toContain(telOwner);
    const overrides = await prisma.guardMatchOverride.findMany();
    expect(overrides.length).toBe(2);
    expect(JSON.stringify(overrides)).not.toContain(telOwner);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { action: "guard_fix_inference" } }))).not.toContain(telOwner);
    // guard_fix step：remaining_needs_boss 同 needsHuman 一致
    const steps = run.stepsJson as Array<{ key: string; numbers: Record<string, unknown>; needsHuman: string[] }>;
    const gf = steps.find((x) => x.key === "guard_fix")!;
    expect(gf.numbers.remainingNeedsBoss).toBe(0);
    expect(gf.needsHuman).toHaveLength(0);
  });

  it("A：R3a 經完整導入——兩個同名歷史導入 minimal guard 自動合併，之後 reparse 配得返、更次全部落到保留者", async () => {
    const site = await mkSite("測試合併盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    await seedStaffList(fx.userIds["老闆"]);
    const early = await mkGuard({ name: "測試重複歷史人", status: "inactive", createdBy: "system:guard-fix:historical_roster", createdAt: new Date("2026-03-01T00:00:00Z") });
    const late = await mkGuard({ name: "測試重複歷史人", status: "inactive", createdBy: "system:guard-fix:historical_roster", createdAt: new Date("2026-03-02T00:00:00Z") });
    await upload(await rosterXlsx({ site: "測試合併盤", people: [person({ name: "測試重複歷史人", codes: ["D", "D", "D"] })] }), "2026-03");
    const { report } = await runImport(3);
    expect(report.totals.unresolved).toBe(0);
    expect(report.inferences.filter((i) => i.rule === "R3a")).toHaveLength(1);
    expect(await prisma.shiftRecord.count({ where: { guardId: early.id } })).toBe(3);
    expect(await prisma.shiftRecord.count({ where: { guardId: late.id } })).toBe(0);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: late.id } })).mergedFrom).toContain(`merged_into:${early.id}`);
    expect(await prisma.guard.count({ where: { nameZh: "測試重複歷史人" } })).toBe(2); // 不刪，只標合併
  });

  it("A：R4 經完整導入——三個同名身份（工號唔同／冇工號／簡繁＋後綴）建一位保安員，全部格落到，報告 R4", async () => {
    const site = await mkSite("測試同名盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    await seedStaffList(fx.userIds["老闆"]);
    await upload(
      await rosterXlsx({
        site: "測試同名盤",
        people: [
          person({ staffNo: "U90051", name: "測試三同名", codes: ["D", "D", "D", "D", "D", "", "", "", "", ""] }),
          person({ staffNo: "U90052", name: "测试三同名", codes: ["", "", "", "", "", "D", "D", "D", "", ""] }),
          person({ name: "測試三同名 (上)", codes: ["", "", "", "", "", "", "", "", "D", "D"] }),
        ],
      }),
      "2026-03",
    );
    const { report } = await runImport(3);
    expect(report.totals.unresolved).toBe(0);
    expect(report.perSite[0]!.written).toBe(10);
    const r4 = report.inferences.filter((i) => i.rule === "R4");
    expect(r4).toHaveLength(1);
    expect(r4[0]).toMatchObject({ confidence: 0.9, cells: 10 });
    const guards = await prisma.guard.findMany({ where: { nameAliases: { has: "测试三同名" } } });
    expect(guards).toHaveLength(1);
    expect(await prisma.shiftRecord.count({ where: { guardId: guards[0]!.id } })).toBeGreaterThan(0);
    expect(report.remaining).toEqual([]);
  });

  it("A：R5 inference 由 apply diff 的 tel_skipped_duplicate 產生（collectHistInferences），報告唔含電話", async () => {
    const plan = {
      identities: [{ seq: "I001", kind: "unmatched", staffNoRaw: "u 90077", nameRaw: "測試純新人", telRaw: "+85290010001", cells: [{ siteLabel: "測試盤", cellCount: 4 }], totalCellCount: 4 }],
      actions: { link: [], create: [], createMinimal: [], needsBoss: [], setLongterm: [], setLongtermPost: [], setReferral: [], setReferralInferred: [], setVisa: [] },
    } as unknown as Parameters<typeof collectHistInferences>[0];
    const empty = { create: [], skip: [] };
    const diffs = { mergeGuards: empty, link: empty, create: empty, createMinimal: { create: ["I001"], skip: [], telSkipped: ["I001:tel_skipped_duplicate"] }, setLongterm: empty, setLongtermPost: empty, setReferral: empty, setReferralInferred: empty, setVisa: empty } as unknown as Parameters<typeof collectHistInferences>[1];
    const into = new Map();
    collectHistInferences(plan, diffs, into, new Map());
    const infs = [...into.values()];
    expect(infs).toHaveLength(1);
    expect(infs[0]).toMatchObject({ rule: "R5", confidence: 0.85, cells: 4, subject: { name: "測試純新人", staffNo: "U90077" } });
    expect(infs[0].decision).toContain("建人時電話留空（電話屬另一人）");
    expect(JSON.stringify(infs)).not.toContain("90010001");
  });

  it("A：remaining（R3c 兩個都有盤史）——guard_fix needsHuman、報告 remaining 一致，連候選＋建議答案；唔寫入未決定嘅格", async () => {
    const site = await mkSite("測試待答盤");
    const st = await mkShiftType(site.id, "D", "0700", "1900", 12);
    await seedStaffList(fx.userIds["老闆"]);
    const g1 = await mkGuard({ name: "測試雙史人", staffNo: "U90030" });
    const g2 = await mkGuard({ name: "測試雙史人", staffNo: "U90031" });
    const rec = (guardId: string, day: number) => prisma.shiftRecord.create({ data: { guardId, siteId: site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, 1, day)), status: "confirmed", createdBy: "test" } });
    await rec(g1.id, 1);
    await rec(g2.id, 2);
    await rec(g2.id, 3);
    await upload(await rosterXlsx({ site: "測試待答盤", people: [person({ name: "測試雙史人", codes: ["D", "D", "D", "D"] })] }), "2026-03");
    const { report, run } = await runImport(3);
    expect(report.remaining).toHaveLength(1);
    expect(report.remaining[0]).toMatchObject({ reasonCode: "same_name_multi_both_history", cells: 4, recommended: { action: "link", guardId: g2.id } });
    expect(report.remaining[0]!.candidates).toHaveLength(2);
    expect(report.totals.unresolved).toBe(4);
    const steps = run.stepsJson as Array<{ key: string; numbers: Record<string, unknown>; needsHuman: string[] }>;
    const gf = steps.find((x) => x.key === "guard_fix")!;
    expect(gf.numbers.remainingNeedsBoss).toBe(1);
    expect(gf.needsHuman).toHaveLength(1);
    expect(gf.needsHuman[0]).toContain("測試雙史人");
    expect(report.needsHuman.filter((h) => h.includes("未配對保安員"))).toHaveLength(1);
  });

  // ---------------------------------------------------------------- API
  it("GET /api/month-close/historical-import/inferences：合併多月最新 done run 嘅 inferences／remaining／review_hints", async () => {
    const site = await mkSite("測試API盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    for (const [m, month] of [[2, "2026-02"], [3, "2026-03"]] as const) {
      await upload(await rosterXlsx({ site: "測試API盤", year: 2026, month: m, people: [person({ staffNo: "T-A01", name: "測試保安員甲", time: "0730-1930", codes: ["A", "A"] })] }), month);
      await runImport(m);
    }
    const res = await getInferences(new Request("http://test.local/api/month-close/historical-import/inferences?from=2026-01&to=2026-03", { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { months: Array<{ month: string; run_id: string | null; inferences: number }>; inferences: Array<{ month: string; rule: string; cells: number }>; totals: { inferences: number }; remaining: unknown[]; review_hints: unknown[] };
    expect(body.months.map((x) => [x.month, x.run_id !== null])).toEqual([["2026-01", false], ["2026-02", true], ["2026-03", true]]);
    expect(body.inferences.map((i) => i.month).sort()).toEqual(["2026-02", "2026-03"]);
    expect(body.inferences.every((i) => i.rule === "S1" && i.cells === 2)).toBe(true);
    expect(body.totals.inferences).toBe(2);
    expect(Array.isArray(body.remaining) && Array.isArray(body.review_hints)).toBe(true);
    // 參數錯誤
    const bad = await getInferences(new Request("http://test.local/api/month-close/historical-import/inferences?from=2026-13&to=2026-03", { headers: { cookie } }));
    expect(bad.status).toBe(400);
    // 沒權限（雞頭）
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const denied = await getInferences(new Request("http://test.local/api/month-close/historical-import/inferences?from=2026-02&to=2026-03", { headers: { cookie: brokerCookie } }));
    expect(denied.status).toBe(403);
    // 歷史導入 GET 回傳報告帶新欄（snake_case）
    const list = await listImport(new Request("http://test.local/api/month-close/historical-import?month=2026-03", { headers: { cookie } }));
    const lb = (await list.json()) as { runs: Array<{ report: { inferences: unknown[]; remaining: unknown[]; review_hints: unknown[]; totals: { cross_month_duplicate: number; out_of_scope: number } } }> };
    expect(lb.runs[0]!.report.inferences.length).toBe(1);
    expect(lb.runs[0]!.report.totals).toMatchObject({ cross_month_duplicate: 0, out_of_scope: 0 });
  });

  it("正式月份（非歷史）：單字母代號仍然 unknown、冇推斷；tel-owner 衝突仍然 needs_boss 路徑（plan 層見 identity test）", async () => {
    await prisma.monthClose.update({ where: { month: monthOf(3) }, data: { historical: false } });
    const site = await mkSite("測試正式月盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    await upload(await rosterXlsx({ site: "測試正式月盤", people: [person({ staffNo: "T-A01", name: "測試保安員甲", codes: ["A", "D"] })] }), "2026-03");
    const rows = await prisma.rosterUploadRow.findMany({ where: { rawCode: "A" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeKind).toBe("unknown");
    expect(JSON.stringify(rows[0]!.warnings ?? [])).not.toContain("AI 推斷");
  });

  it("輔助：mkUpload／mkRow 可用（直接行）", async () => {
    const site = await mkSite("測試輔助盤");
    const up = await mkUpload({ siteId: site.id, siteName: "測試輔助盤", userId: fx.userIds["老闆"] });
    await mkRow({ uploadId: up.id, siteId: site.id, name: "測試輔助人" });
    expect(await prisma.rosterUploadRow.count({ where: { uploadId: up.id } })).toBe(1);
  });
});
