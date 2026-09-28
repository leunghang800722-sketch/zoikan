// WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：`buildBochkAutopayWorkbook()`
// 單元/整合測試——HKICL 字元過濾（中文名唔出行）、電話 8 位判斷、
// reference 格式、HKICL 銀行編號建議表。RBAC／preview/xlsx 三個 sheet
// 已經有 tests/longterm-payroll-payroll-route.test.ts integration 覆蓋，
// 呢度專攻 `bochk-autopay-export.ts` 本身嘅細節規則。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { buildBochkAutopayWorkbook, BOCHK_FORMAT_SOURCE } from "@/lib/longterm-payroll/bochk-autopay-export";
import { HKICL_BANK_OPTIONS, HKICL_BANK_CODE_SET } from "@/lib/longterm-payroll/hkicl-bank-codes";

describe("HKICL_BANK_OPTIONS（建議下拉，逐個核實過先可以入呢個陣列）", () => {
  it("逐項都係 3 位數字編號，冇重複", () => {
    const codes = HKICL_BANK_OPTIONS.map((b) => b.code);
    for (const c of codes) expect(c).toMatch(/^\d{3}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("包含核實過嘅常見銀行（HSBC 004／BOCHK 012／恒生 024）", () => {
    expect(HKICL_BANK_CODE_SET.has("004")).toBe(true);
    expect(HKICL_BANK_CODE_SET.has("012")).toBe(true);
    expect(HKICL_BANK_CODE_SET.has("024")).toBe(true);
  });

  it("冇收錄任何未核實嘅假編號（例如 999）", () => {
    expect(HKICL_BANK_CODE_SET.has("999")).toBe(false);
  });
});

describe("buildBochkAutopayWorkbook：HKICL 字元過濾／缺資料判斷", () => {
  let fx: Wp2Fixture;
  let b07Id: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07-BOCHK", name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
    b07Id = b07.id;
  });

  async function makeGuard(opts: { bankCode?: string | null; bankAccountNo?: string | null; bankPayeeName?: string | null; tel?: string | null }) {
    const guard = await prisma.guard.create({
      data: {
        nameZh: `測試長工-bochk-${Math.random().toString(36).slice(2, 6)}`,
        employmentType: "longterm_autopay",
        hireDate: new Date("2020-01-01"),
        // 注意：`??` 會將顯式傳嘅 `null`（測試想模擬「冇 bank_code」）都
        // 當「冇傳」蓋做預設值——呢度特登用 `!== undefined` 分開兩種
        // 情況，等 `makeGuard({ bankCode: null })` 真係得到 null。
        bankCode: opts.bankCode !== undefined ? opts.bankCode : "004",
        bankAccountNo: opts.bankAccountNo ?? "6001234567",
        bankPayeeName: opts.bankPayeeName ?? "TEST PAYEE",
        tel: opts.tel ?? null,
        createdBy: "test",
      },
    });
    await prisma.guardLongtermContract.create({
      data: { guardId: guard.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: "test" },
    });
    for (let d = 1; d <= 20; d++) {
      await prisma.shiftRecord.create({
        data: { workDate: new Date(Date.UTC(2026, 7, d)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: guard.id, settlementBrokerId: b07Id, operationalBrokerId: b07Id, recordType: "shift", createdBy: "test" },
      });
    }
    return guard;
  }

  it("賬戶名稱含中文——唔出行，列入缺資料，原因講明「賬戶名稱要英文」", async () => {
    await makeGuard({ bankPayeeName: "陳大文" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(0);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]!.reason).toContain("賬戶名稱要英文");
  });

  it("賬戶名稱純 HKICL 字元（含 &'()*+,-./$= 呢批符號）——正常出行", async () => {
    await makeGuard({ bankPayeeName: "TEST & CO. (HK) LTD-PAYEE'S NAME" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(0);
  });

  it("冇 bank_code——唔出行，缺資料原因講明；有齊資料——format_verified/format_source 正確", async () => {
    await makeGuard({ bankCode: null });
    const withAll = await makeGuard({ tel: "9123 4567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]!.reason).toContain("冇銀行編號");
    expect(result.formatVerified).toBe(true);
    expect(result.formatSource).toBe(BOCHK_FORMAT_SOURCE);

    // 有效 8 位電話（去走空格）→ 通知渠道1=S，號碼=8 位數字。
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    // header 一行 + 1 data row（withAll）——揾返嗰行（seq=1）。
    expect(row.getCell(2, 9).value).toBe("S");
    expect(row.getCell(2, 10).value).toBe("91234567");
    void withAll;
  });

  it("電話唔係 8 位數字——通知渠道／號碼留空，唔會屈估", async () => {
    await makeGuard({ tel: "12345" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    expect(row.getCell(2, 9).value).toBeNull();
    expect(row.getCell(2, 10).value).toBeNull();
  });

  it("reference 格式＝LT<YYYYMM>-<工號>", async () => {
    const g = await prisma.guard.update({ where: { id: (await makeGuard({})).id }, data: { staffNo: "MG001" } });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    expect(row.getCell(2, 7).value).toBe("LT202608-MG001");
    void g;
  });

  it("未計過長工糧——拋錯（route 層接住轉 400，唔准靜靜當 0）", async () => {
    await expect(buildBochkAutopayWorkbook(new Date("2026-08-01"))).rejects.toThrow("未計過長工糧");
  });

  it("sheet 名唔含鐵則禁止字元，三個 sheet 齊全", async () => {
    await makeGuard({});
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    const names = result.workbook.worksheets.map((w) => w.name);
    expect(names).toEqual(["Payroll Editor 明細", "檔頭資料", "缺資料"]);
    for (const nm of names) expect(nm).not.toMatch(/[/\\?*[\]:／＼？＊［］：]/);
  });
});
