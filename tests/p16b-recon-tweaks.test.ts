// P16b：對數工具細修——批量輸入 note 計入重複判斷、銀行檔第二表頭行跳過、同日多來源更表紀錄衝突提示。合成資料。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as XLSX from "xlsx";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as bulk } from "@/app/api/longterm/inputs/bulk/route";
import { parseBankPayrollEditor, compareBankToSystem } from "@/lib/longterm-payroll/bank-reconcile";
import { buildLongtermPayrollInputs, attendanceConflictNote } from "@/lib/longterm-payroll/aggregate";
import { ATTENDANCE_CONFLICT_PREFIX } from "@/lib/longterm-payroll/attendance-conflict";

function req(url: string, cookie: string, body?: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("P16b.1 批量輸入：note 計入重複 key", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let month: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    month = fx.unlockedMonth.toISOString().slice(0, 10);
    await prisma.guard.create({ data: { nameZh: "測試甲", nameEn: "Test Alpha", staffNoMw: "MG9601", employmentType: "longterm_autopay", createdBy: "test" } });
  });
  const two = () => [
    { staff_no_mw: "MG9601", kind: "other_allowance", amount: 650, note: "OT" },
    { staff_no_mw: "MG9601", kind: "other_allowance", amount: 650, note: "補假日工資" },
  ];

  it("同金額唔同 note → 兩行都新增；dry_run 列明 separate_by_note；重跑全 skipped；同 note 同金額仍當重複", async () => {
    const dry = await (await bulk(req("http://t/api/longterm/inputs/bulk?dry_run=1", owner, { month, rows: two() }))).json();
    expect(dry).toMatchObject({ dry_run: true, created: 2, skipped_duplicate: 0 });
    expect(dry.separate_by_note).toEqual([{ row: 2, reason: expect.stringContaining("note 唔同") }]);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: two() }))).json();
    expect(j).toMatchObject({ created: 2, skipped_duplicate: 0 });
    expect(await prisma.longtermPayrollInput.count()).toBe(2);
    const again = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: [...two(), { staff_no_mw: "MG9601", kind: "other_allowance", amount: 650, note: "  OT " }] }))).json();
    expect(again).toMatchObject({ created: 0, skipped_duplicate: 3 });
  });
});

describe("P16b.1 系統草稿確認後批量同金額唔同 note → 仍當重複", () => {
  it("cover:* 草稿已確認＋批量同金額唔同 note → skipped、唔新增", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const owner = await sessionCookieForUser(fx.userIds["老闆"]);
    const month = fx.unlockedMonth.toISOString().slice(0, 10);
    const g = await prisma.guard.create({ data: { nameZh: "測試甲", nameEn: "Test Alpha", staffNoMw: "MG9601", employmentType: "longterm_autopay", createdBy: "test" } });
    await prisma.longtermPayrollInput.create({ data: { month: fx.unlockedMonth, guardId: g.id, kind: "special_allowance", amount: 300, note: "頂位津貼（系統草稿原文）", status: "confirmed", draftSource: "cover:K", confirmedAt: new Date(), confirmedBy: fx.userIds["老闆"], createdBy: "test" } });
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: [{ staff_no_mw: "MG9601", kind: "special_allowance", amount: 300, note: "另一個寫法" }] }))).json();
    expect(j).toMatchObject({ created: 0, skipped_duplicate: 1 });
    expect(await prisma.longtermPayrollInput.count()).toBe(1);
  });
});

describe("P16b.2 銀行檔第二表頭行", () => {
  const HEADER = ["編號", "員工賬戶銀行編號", "員工賬戶類型*", "員工賬戶號碼 *", "員工賬戶名稱", "金額 (HKD/…)", "備考號", "備註"];
  it("兩個表頭行（中文第 11 行＋英文第 16 行）→ 第二個跳過、header_rows_skipped=1、唔入 rows", () => {
    const aoa: unknown[][] = [["BOCHK Payroll Editor"]];
    while (aoa.length < 10) aoa.push([]);
    aoa.push(HEADER);
    aoa.push([1, "012", "BBAN", "111222", "TEST ALPHA", 100, "", ""]);
    aoa.push([2, "012", "BBAN", "333444", "TEST BRAVO", 200, "", ""]);
    aoa.push([3, "012", "BBAN", "555666", "TEST CHARLIE", "abc", "", ""]); // 真壞金額（有數字）仍保留
    aoa.push(["No.", "Bank Code", "A/C Type", "Account No.", "Account Name", "Amount(HKD/CNY)", "Reference", "Remarks"]);
    aoa.push([4, "012", "BBAN", "777888", "TEST DELTA", 300, "", ""]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Payroll Editor");
    const p = parseBankPayrollEditor(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })));
    expect(p.headerRowsSkipped).toBe(1);
    expect(p.rows.map((r) => r.nameNorm)).toEqual(["TESTALPHA", "TESTBRAVO", "TESTCHARLIE", "TESTDELTA"]);
    const { summary } = compareBankToSystem(p.rows, [], "2026-08");
    expect(summary.bad_amount_rows).toBe(1);
  });
  it("冇金額但有正常姓名嘅行唔當表頭，留做 bad_amount_rows", () => {
    const aoa: unknown[][] = [];
    while (aoa.length < 10) aoa.push([]);
    aoa.push(HEADER);
    aoa.push(["x", "y", "z", "p", "Some Person", "", "", ""]);
    aoa.push([1, "012", "BBAN", "111222", "TEST ALPHA", 100, "", ""]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Payroll Editor");
    const p = parseBankPayrollEditor(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })));
    expect(p.headerRowsSkipped).toBe(0);
    expect(p.rows).toHaveLength(2);
    expect(compareBankToSystem(p.rows, [], "2026-08").summary.bad_amount_rows).toBe(1);
  });
});

describe("P16b.3 同日多來源更表紀錄衝突提示", () => {
  afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
  });
  const d = (day: number) => new Date(Date.UTC(2026, 7, day));

  it("純函數：來源間代號一致→無；唔一致→有 MM-DD（來源 代號）；OT 唔計；單一來源→無", () => {
    const base = { recordType: "shift", leaveCode: null };
    expect(attendanceConflictNote([{ workDate: d(3), ...base, source: "roster_upload" }, { workDate: d(3), ...base, source: "master_roster" }])).toBeNull();
    expect(attendanceConflictNote([{ workDate: d(3), ...base, source: "roster_upload" }, { workDate: d(3), recordType: "ot", leaveCode: null, source: "payroll_only" }])).toBeNull();
    const n = attendanceConflictNote([
      { workDate: d(4), ...base, source: "roster_upload" },
      { workDate: d(4), recordType: "leave", leaveCode: "SL", source: "master_roster" },
      { workDate: d(5), recordType: "leave", leaveCode: "NL", source: "master_roster" },
      { workDate: d(5), recordType: "leave", leaveCode: "RD", source: "master_roster" },
      { workDate: d(5), recordType: "leave", leaveCode: "AL", source: "payroll_only" },
    ])!;
    expect(n.startsWith(ATTENDANCE_CONFLICT_PREFIX)).toBe(true);
    expect(n).toContain("08-04（master_roster 代號 SL / roster_upload 代號 班；已採用：來源 roster_upload）");
    expect(n).toContain("08-05（master_roster 代號 NL＋RD / payroll_only 代號 AL；已採用：來源 master_roster）");
  });

  it("aggregate：合成兩來源衝突 → line.notes 有 ⚠ 提示，數字（workDays／autopay）同冇衝突來源一樣", async () => {
    await clearAll();
    const site = await prisma.site.create({ data: { canonicalName: `測試盤-${Math.random().toString(36).slice(2, 8)}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "test" } });
    const st2 = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", hours: 12, createdBy: "test" } });
    const b07 = await prisma.broker.create({ data: { code: `T-B07-${Math.random().toString(36).slice(2, 6)}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } });
    const g = await prisma.guard.create({ data: { nameZh: "測試長工-衝突", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: user.id } });
    for (let day = 1; day <= 10; day++) await prisma.shiftRecord.create({ data: { workDate: d(day), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", source: "roster_upload", createdBy: "test" } });
    const before = (await buildLongtermPayrollInputs(new Date(Date.UTC(2026, 7, 1)))).lines[0]!;
    expect(before.notes.some((x) => x.startsWith(ATTENDANCE_CONFLICT_PREFIX))).toBe(false);
    await prisma.shiftRecord.create({ data: { workDate: d(4), siteId: site.id, shiftTypeId: st2.id, guardId: g.id, recordType: "leave", leaveCode: "SL", source: "master_roster", createdBy: "test" } });
    const after = (await buildLongtermPayrollInputs(new Date(Date.UTC(2026, 7, 1)))).lines[0]!;
    const note = after.notes.find((x) => x.startsWith(ATTENDANCE_CONFLICT_PREFIX));
    expect(note).toContain("08-04（master_roster 代號 SL / roster_upload 代號 班；已採用：來源 roster_upload）");
    expect(after.workDays).toBe(before.workDays);
    expect(after.netBasic).toBe(before.netBasic);
  });
});
