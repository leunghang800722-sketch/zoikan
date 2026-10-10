// WP-AI-OPS §28.3：鎖月前體檢＋資料補齊提示。全部合成資料（測試XX），唔讀 data/。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildMonthHealth, intervalsOverlap, isSwing, redactMonthHealth, summarizeHealthForReport, type MonthHealth } from "@/lib/ops/month-health";
import { GET as healthRoute } from "@/app/api/reports/month-health/route";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const MAY = d("2031-05-01");

function sys(userId: string): AuthedSession {
  return { userId, tel: "", name: "", roleId: "", roleName: "老闆", baseRole: "老闆", brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString() };
}
function req(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } });
}

describe("month-health 純函數", () => {
  it("intervalsOverlap：同日重疊、首尾相接唔算、夜更跨午夜", () => {
    expect(intervalsOverlap({ start: 420, end: 1140 }, { start: 600, end: 840 })).toBe(true);
    expect(intervalsOverlap({ start: 420, end: 1140 }, { start: 1140, end: 420 })).toBe(false); // 日更 07–19 同夜更 19–07
    expect(intervalsOverlap({ start: 1140, end: 420 }, { start: 0, end: 360 })).toBe(false); // 夜更 19:00–翌日 07:00 同 00:00–06:00（同一曆日）唔重疊
    expect(intervalsOverlap({ start: 1140, end: 420 }, { start: 1200, end: 1320 })).toBe(true);
  });

  it("isSwing：基數太細唔比較；超過門檻先中", () => {
    expect(isSwing(4, 2, 20, 30)).toBe(false);
    expect(isSwing(130, 100, 20, 30)).toBe(false); // 剛好 30%
    expect(isSwing(131, 100, 20, 30)).toBe(true);
    expect(isSwing(60, 100, 20, 30)).toBe(true);
  });

  it("redactMonthHealth：缺任何所需 module 就剝明細、保留數量", () => {
    const h: MonthHealth = {
      month: "x",
      prevMonth: "y",
      hasPrev: true,
      summary: { critical: 0, warn: 0, info: 2, total: 2 },
      findings: [
        { code: "a", severity: "info", count: 2, message: "m", fixLink: "/", requires: ["更表"], detail: [{ name_zh: "n" }], detailTruncated: false },
        { code: "b", severity: "info", count: 1, message: "m", fixLink: "/", requires: ["更表", "安員個人資料"], detail: [{ name_zh: "n" }], detailTruncated: false },
      ],
    };
    const r = redactMonthHealth(h, (m) => m === "更表");
    expect(r.findings[0]!.detail).toHaveLength(1);
    expect(r.findings[1]!.detail).toBeNull();
    expect(r.findings[1]!.detailWithheld).toBe(true);
    expect(r.findings[1]!.count).toBe(1);
  });
});

describe("buildMonthHealth（DB）", () => {
  let fx: Wp2Fixture;
  let health: MonthHealth;
  let siteB: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const boss = fx.userIds["老闆"];
    const siteA = fx.site.id;
    siteB = (await prisma.site.create({ data: { canonicalName: "測試盤B-體檢", clientName: "測試客B", billingModel: "per_shift", createdBy: "t" } })).id;
    const mkSt = (siteId: string, code: string, s: string, e: string) => prisma.shiftType.create({ data: { siteId, code, startTime: t(s), endTime: t(e), createdBy: "t" } });
    const stDay = await mkSt(siteA, "D", "07:00", "19:00");
    const stNight = await mkSt(siteA, "NN", "19:00", "07:00");
    const stShort = await mkSt(siteA, "X", "10:00", "14:00");
    const stB = await mkSt(siteB, "D", "07:00", "19:00");

    const mkG = (staffNo: string, nameZh: string, extra: Record<string, unknown> = {}) =>
      prisma.guard.create({ data: { staffNo, nameZh, employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, hkid: "Z111111(1)", tel: "6200001", createdBy: "t", ...extra } });
    const g1 = await mkG("T-H1", "測試體檢一", { employmentType: "longterm_autopay", hkid: null, tel: null }); // 缺 hkid／tel／bank
    const g2 = await mkG("T-H2", "測試體檢二", { hkid: "Z222222(2)", tel: "6200002" });
    const g3 = await mkG("T-H3", "測試體檢三", { hkid: "Z333333(3)", tel: "6200003", siaPermitExpiry: d("2031-05-10") });
    const g4 = await mkG("T-H4", "測試體檢四", { hkid: "Z444444(4)", tel: "6200004" });
    const g5 = await mkG("T-H5", "測試體檢五", { employmentType: "longterm_autopay", hkid: "Z555555(5)", tel: "6200005", bankCode: "024" });

    let n = 0;
    const rec = (guardId: string, day: string, siteId: string, shiftTypeId: string, extra: Record<string, unknown> = {}) =>
      prisma.shiftRecord.create({
        data: { workDate: d(day), siteId, shiftTypeId, guardId, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "shift", createdBy: `t${n++}`, ...extra },
      });
    // 重疊：G2 5/5 日更＋短更（同盤）；5/6 兩盤同時間
    await rec(g2.id, "2031-05-05", siteA, stDay.id);
    await rec(g2.id, "2031-05-05", siteA, stShort.id);
    await rec(g2.id, "2031-05-06", siteA, stDay.id);
    await rec(g2.id, "2031-05-06", siteB, stB.id);
    // 跨盤唔重疊：夜更（19–07）＋ B 盤日更（07–19）
    await rec(g2.id, "2031-05-07", siteA, stNight.id);
    await rec(g2.id, "2031-05-07", siteB, stB.id, { clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    // >26 更：G4 27 日
    for (let i = 1; i <= 27; i++) await rec(g4.id, `2031-05-${String(i).padStart(2, "0")}`, siteA, stDay.id, { clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    // 許可證過期：G3 5/12 出更（到期 5/10）
    await rec(g3.id, "2031-05-12", siteA, stDay.id, { clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    // 長工同日有假又有更：G5 5/8
    await rec(g5.id, "2031-05-08", siteA, stDay.id, { clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    await prisma.shiftRecord.create({ data: { workDate: d("2031-05-08"), siteId: siteA, shiftTypeId: stShort.id, guardId: g5.id, recordType: "leave", leaveCode: "AL", settlementBrokerId: fx.brokerA.id, createdBy: "t" } });
    // G1（缺資料）出一更，冇結算單位
    await rec(g1.id, "2031-05-09", siteA, stDay.id, { settlementBrokerId: null, clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    // 上月（2031-04）：A 盤 60 更、每更收 1000／成本 900 → 本月 A 盤更數／收入／成本大幅下跌
    for (const g of [g4, g2]) {
      for (let i = 1; i <= 30; i++) await rec(g.id, `2031-04-${String(i).padStart(2, "0")}`, siteA, stDay.id, { clientRateSnapshot: 1000, guardWageSnapshot: 800, brokerFeeSnapshot: 100 });
    }

    // 更表上載＋行
    const up = await prisma.rosterUpload.create({
      data: { month: MAY, siteId: siteA, siteNameRaw: fx.site.name, uploaderUserId: boss, fileName: "f.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array([1]), fileSize: 1, status: "parsed" },
    });
    const row = (rowIndex: number, extra: Record<string, unknown>) =>
      prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex, workDate: d("2031-05-05"), rawCode: "D", codeKind: "shift", ...extra } });
    await row(1, { guardId: g2.id, guardMatch: "by_staff_no", matchBasis: "staff_no" });
    await row(2, { guardId: g2.id, guardMatch: "by_staff_no", matchBasis: "staff_no" }); // 重複行
    await row(3, { guardId: g4.id, guardMatch: "by_name", matchBasis: "name_only", workDate: d("2031-05-06") });
    await row(4, { guardId: g3.id, guardMatch: "by_name", matchBasis: "name_only", workDate: d("2031-05-07") });
    await row(5, { guardMatch: "unmatched", workDate: d("2031-05-08") });
    await row(6, { guardMatch: "ambiguous", workDate: d("2031-05-09") });

    health = await buildMonthHealth(MAY, sys(boss));
  });

  const find = (code: string) => health.findings.find((f) => f.code === code);

  it("同人同日：時間重疊（2 組）／跨盤唔重疊（1 組）", () => {
    expect(find("overlap_same_day")).toMatchObject({ severity: "critical", count: 2 });
    expect(find("cross_site_same_day")).toMatchObject({ severity: "warn", count: 1 });
    expect(find("overlap_same_day")!.detail![0]).toHaveProperty("name_zh", "測試體檢二");
  });

  it("單月 >26 更、更表重複行、長工同日有假又有更、許可證過期", () => {
    expect(find("over_max_shifts")).toMatchObject({ count: 1 });
    expect(find("over_max_shifts")!.detail![0]).toMatchObject({ staff_no: "T-H4", shift_count: 27 });
    expect(find("roster_duplicate_rows")).toMatchObject({ count: 1 });
    expect(find("roster_duplicate_rows")!.detail![0]).toMatchObject({ rows: 2, raw_code: "D" });
    expect(find("longterm_leave_and_shift")).toMatchObject({ count: 1 });
    expect(find("permit_expired_working")).toMatchObject({ count: 1 });
    expect(find("permit_expired_working")!.detail![0]).toMatchObject({ staff_no: "T-H3", permit_expiry: "2031-05-10", shifts_after_expiry: 1 });
  });

  it("未定價、冇結算單位、name_only／ambiguous／unmatched 格", () => {
    expect(find("unpriced_payout")!.count).toBeGreaterThan(0);
    expect(find("unpriced_client")!.count).toBeGreaterThan(0);
    expect(find("no_settlement")).toMatchObject({ severity: "critical", count: 1 });
    expect(find("name_only_cells")).toMatchObject({ count: 2 });
    expect(find("ambiguous_cells")).toMatchObject({ severity: "critical", count: 1 });
    expect(find("unmatched_cells")).toMatchObject({ severity: "critical", count: 1 });
    expect(find("name_only_cells")!.detail![0]).toMatchObject({ site_name: fx.site.name, cells: 2 });
  });

  it("同上月比：A 盤更數／收入／成本同上月 60 更相差超過門檻", () => {
    expect(health.hasPrev).toBe(true);
    const shifts = find("site_shifts_swing");
    expect(shifts).toBeDefined();
    expect(shifts!.detail!.some((r) => r.site_name === fx.site.name)).toBe(true);
    expect(find("site_revenue_swing")).toBeDefined();
  });

  it("資料補齊：缺身份證／電話／長工銀行編號", () => {
    expect(find("gap_hkid")).toMatchObject({ severity: "info", count: 1 });
    expect(find("gap_hkid")!.detail![0]).toMatchObject({ staff_no: "T-H1" });
    expect(find("gap_tel")).toMatchObject({ count: 1 });
    expect(find("gap_bank_code")).toMatchObject({ severity: "warn", count: 1 });
  });

  it("排序：critical 先；摘要數字對得上；體檢唔擋鎖月（純讀，冇寫 DB）", async () => {
    expect(health.summary.total).toBe(health.findings.length);
    expect(health.summary.critical).toBe(health.findings.filter((f) => f.severity === "critical").length);
    const sev = health.findings.map((f) => f.severity);
    expect(sev.indexOf("warn")).toBeGreaterThan(sev.lastIndexOf("critical"));
    expect(await prisma.monthClose.count({ where: { month: MAY } })).toBe(0);
  });

  it("report 摘要：淨係 code＋severity＋count，冇姓名／工號", () => {
    const s = summarizeHealthForReport(health);
    const json = JSON.stringify(s);
    expect(json).toContain("overlap_same_day");
    for (const secret of ["測試體檢", "T-H", "Z111111", "6200001"]) expect(json).not.toContain(secret);
    expect(s.critical).toBe(health.summary.critical);
  });

  it("體檢只讀：跑前後 shift_records／audit_log 條數不變", async () => {
    const before = [await prisma.shiftRecord.count(), await prisma.auditLog.count()];
    await buildMonthHealth(MAY, sys(fx.userIds["老闆"]));
    expect([await prisma.shiftRecord.count(), await prisma.auditLog.count()]).toEqual(before);
  });

  describe("GET /api/reports/month-health（權限＋遮罩）", () => {
    const url = "http://test.local/api/reports/month-health?month=2031-05";

    it("老闆：有明細；hkid／電話值永遠唔出現", async () => {
      const res = await healthRoute(req(url, await sessionCookieForUser(fx.userIds["老闆"])));
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).toContain("overlap_same_day");
      expect(text).toContain("測試體檢二");
      for (const secret of ["Z111111(1)", "Z222222(2)", "Z555555(5)", "6200001", "6200002", "024"]) expect(text).not.toContain(secret);
      expect(text).toContain("fix_link");
    });

    it("會計：有明細（更表＋個人資料＋銀行資料 view 出廠都有）", async () => {
      const json = (await (await healthRoute(req(url, await sessionCookieForUser(fx.userIds["會計"])))).json()) as { findings: Array<{ code: string; detail: unknown[] | null; detail_withheld?: boolean }> };
      expect(json.findings.find((f) => f.code === "gap_bank_code")!.detail).not.toBeNull();
    });

    it("冇「更表」view 嘅會計：只有數量，明細全部剝走", async () => {
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "更表", action: "view" } }, data: { granted: false } });
      const json = (await (await healthRoute(req(url, await sessionCookieForUser(fx.userIds["會計"])))).json()) as { findings: Array<{ code: string; count: number; detail: unknown[] | null; detail_withheld?: boolean }>; can_view_detail: boolean };
      expect(json.can_view_detail).toBe(false);
      const f = json.findings.find((x) => x.code === "overlap_same_day")!;
      expect(f.count).toBe(2);
      expect(f.detail).toBeNull();
      expect(f.detail_withheld).toBe(true);
    });

    it("有「更表」但冇「保安員個人資料」／「保安員銀行資料」view：缺身份證／銀行編號只有數量，其他明細照有", async () => {
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: { in: ["安員個人資料", "安員銀行資料"] }, action: "view" } }, data: { granted: false } });
      const json = (await (await healthRoute(req(url, await sessionCookieForUser(fx.userIds["會計"])))).json()) as { findings: Array<{ code: string; count: number; detail: unknown[] | null; detail_withheld?: boolean }> };
      const hk = json.findings.find((x) => x.code === "gap_hkid")!;
      const bank = json.findings.find((x) => x.code === "gap_bank_code")!;
      const tel = json.findings.find((x) => x.code === "gap_tel")!;
      expect(hk).toMatchObject({ count: 1, detail: null, detail_withheld: true });
      expect(bank).toMatchObject({ count: 1, detail: null, detail_withheld: true });
      expect(tel.detail).not.toBeNull();
      expect(json.findings.find((x) => x.code === "overlap_same_day")!.detail).not.toBeNull();
    });

    it("主管（月結總表 view 預設關）／雞頭／保安員 403", async () => {
      for (const role of ["主管", "雞頭", "安員"] as const) {
        expect((await healthRoute(req(url, await sessionCookieForUser(fx.userIds[role])))).status).toBe(403);
      }
    });
  });
});
