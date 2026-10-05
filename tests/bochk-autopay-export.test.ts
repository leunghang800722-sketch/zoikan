// WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：`buildBochkAutopayWorkbook()`
// 單元/整合測試——HKICL 字元過濾（中文名唔出行）、電話 8 位判斷、
// reference 格式、HKICL 銀行編號建議表。RBAC／preview/xlsx 三個 sheet
// 已經有 tests/longterm-payroll-payroll-route.test.ts integration 覆蓋，
// 呢度專攻 `bochk-autopay-export.ts` 本身嘅細節規則。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { buildBochkAutopayWorkbook, BOCHK_FORMAT_SOURCE, primaryPhone8, normalizeBankAccountNo } from "@/lib/longterm-payroll/bochk-autopay-export";
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

  it("250（花旗香港）同 019（中銀香港舊編號）喺表；019 標 legacy、名同 012 分得開；其餘全部唔係 legacy", () => {
    const b250 = HKICL_BANK_OPTIONS.find((b) => b.code === "250")!;
    expect(b250.nameEn).toBe("Citibank (Hong Kong) Limited");
    expect(b250.legacy).toBeUndefined();
    const b019 = HKICL_BANK_OPTIONS.find((b) => b.code === "019")!;
    const b012 = HKICL_BANK_OPTIONS.find((b) => b.code === "012")!;
    expect(b019.legacy).toBe(true);
    expect(b019.nameEn).toBe(b012.nameEn);
    expect(b019.nameZhShort).not.toBe(b012.nameZhShort);
    expect(b019.note).toBeTruthy();
    expect(HKICL_BANK_OPTIONS.filter((b) => b.legacy).map((b) => b.code)).toEqual(["019"]);
    expect(new Set(HKICL_BANK_OPTIONS.map((b) => b.nameZhShort)).size).toBe(HKICL_BANK_OPTIONS.length); // 下拉顯示名唔重複
  });

  it("由名反推編號（fields-ext）：中國銀行／BOC 仍然淨係 012，唔會變 019", async () => {
    const { bankCodeFromName, bankByCode } = await import("../scripts/staff-import/lib/fields-ext");
    expect(bankCodeFromName("中國銀行")).toBe("012");
    expect(bankCodeFromName("Bank of China (Hong Kong) Limited")).toBe("012");
    expect(bankByCode("12")?.nameZhShort).toBe("中國銀行（香港）");
    expect(bankByCode("019")?.nameZhShort).toBe("中國銀行（香港）（前廣東省銀行）");
    expect(bankByCode("250")?.code).toBe("250");
  });

  it("冇收錄任何未核實嘅假編號（例如 999）", () => {
    expect(HKICL_BANK_CODE_SET.has("999")).toBe(false);
  });
});

// Opus 5.5 覆核應修 b：電話先去 +852／852 前綴同空格／- 先至檢查 8 位；
// 賬戶號碼先去空格先至檢查 0-9／-；正規化後嘅值先出行。
describe("primaryPhone8（去 +852／852 前綴同空格／- 先至檢查 8 位）", () => {
  it("純 8 位數字——原樣通過", () => {
    expect(primaryPhone8("91234567")).toBe("91234567");
  });
  it("帶 +852 前綴＋空格——去前綴後 8 位通過", () => {
    expect(primaryPhone8("+852 9123 4567")).toBe("91234567");
  });
  it("帶 852 前綴（冇 +）＋-——去前綴後 8 位通過", () => {
    expect(primaryPhone8("852-9123-4567")).toBe("91234567");
  });
  it("冇前綴、純空格分隔——去空格後 8 位通過", () => {
    expect(primaryPhone8("9123 4567")).toBe("91234567");
  });
  it("啱啱好 8 位、首三位數字岩巧係 852——唔會誤當「有國際區號」剝走", () => {
    // 8 位數字，唔係 11 位，唔應該觸發「852 前綴」邏輯。
    expect(primaryPhone8("85212345")).toBe("85212345");
  });
  it("剝完唔係 8 位——null（唔會屈估）", () => {
    expect(primaryPhone8("12345")).toBeNull();
    expect(primaryPhone8(null)).toBeNull();
  });
});

describe("normalizeBankAccountNo（去空格先至檢查）", () => {
  it("去晒空格", () => {
    expect(normalizeBankAccountNo("600 1234 567")).toBe("6001234567");
  });
  it("純空格——當冇值（null）", () => {
    expect(normalizeBankAccountNo("   ")).toBeNull();
  });
  it("冇值——null", () => {
    expect(normalizeBankAccountNo(null)).toBeNull();
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
    await makeGuard({ bankPayeeName: "TEST & CO. (HK) LTD-PAYEE'S NAME", tel: "91234567" });
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

  // WP-BOSS5 驗收項 3（老闆 2026-09-28 決定 6，BOCHK 規格 e-Alert 類型／
  // 聯絡係必填）：電話唔係 8 位——唔准出明細行（唔止留空兩格），改列入
  // 缺資料，原因講明「通知電話要 8 位」。
  it("電話唔係 8 位數字——唔出明細行，列入缺資料（原因「通知電話要 8 位」），唔會屈估", async () => {
    await makeGuard({ tel: "12345" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(0);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]!.reason).toContain("通知電話要 8 位");
  });

  it("冇電話（tel=null）——一樣係「通知電話要 8 位」缺資料，唔出明細行", async () => {
    await makeGuard({ tel: null });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(0);
    expect(result.missing[0]!.reason).toContain("通知電話要 8 位");
  });

  it("reference 格式＝LT<YYYYMM>-<工號>", async () => {
    const g = await prisma.guard.update({ where: { id: (await makeGuard({ tel: "91234567" })).id }, data: { staffNo: "MG001" } });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    expect(row.getCell(2, 7).value).toBe("LT202608-MG001");
    void g;
  });

  it("賬戶名稱長過 140 字元——唔出行，列入缺資料", async () => {
    await makeGuard({ bankPayeeName: "A".repeat(141), tel: "91234567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(0);
    expect(result.missing[0]!.reason).toContain("賬戶名稱長過 140 字元");
  });

  it("賬戶號碼含 HKICL 唔收嘅字元（例如空格／英文字母）——唔出行，列入缺資料", async () => {
    await makeGuard({ bankAccountNo: "600 ABC 123", tel: "91234567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(0);
    expect(result.missing[0]!.reason).toContain("賬戶號碼只可以係 0-9／-");
  });

  it("賬戶號碼純 0-9／- ——正常出行", async () => {
    await makeGuard({ bankAccountNo: "600-123-4567", tel: "91234567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(0);
  });

  it.each(["019", "250"])("bank_code %s——照編號正常出行（唔再依賴銀行名）", async (code) => {
    await makeGuard({ bankCode: code, tel: "91234567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(0);
    expect(result.workbook.getWorksheet("Payroll Editor 明細")!.getCell(2, 2).value).toBe(code);
  });

  // Opus 5.5 覆核應修 b：賬戶號碼含空格分組（人手輸入常見）——去咗空格
  // 之後淨係 0-9／-，應該正常出行，而且出行嘅值係正規化後（去咗空格）
  // 嘅值，唔係原始輸入。
  it("賬戶號碼含空格分組（例如「600 1234 567」）——去空格後正常出行，出行值係正規化後嘅值", async () => {
    await makeGuard({ bankAccountNo: "600 1234 567", tel: "91234567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(0);
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    expect(row.getCell(2, 4).value).toBe("6001234567");
  });

  // Opus 5.5 覆核應修 b：電話帶 +852 國際區號前綴——之前會被直接 \D
  // 去晒非數字變 11 位，誤判「唔係 8 位」列入缺資料；而家先剝前綴先至
  // 檢查，應該正常出行。
  it("電話帶 +852 國際區號前綴（例如「+852 9123 4567」）——去前綴後正常出行，通知號碼係去咗前綴嘅 8 位", async () => {
    await makeGuard({ tel: "+852 9123 4567" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const result = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    expect(result.rowCount).toBe(1);
    expect(result.missing.length).toBe(0);
    const row = result.workbook.getWorksheet("Payroll Editor 明細")!;
    expect(row.getCell(2, 9).value).toBe("S");
    expect(row.getCell(2, 10).value).toBe("91234567");
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

  it("M5：已鎖月份——preview 回 locked_month_warning；下載要 confirm_locked=1；兩者都寫 audit（月份／行數／總額，冇戶口）；金額唔變", async () => {
    await makeGuard({ tel: "91234567", bankAccountNo: "6009990001" });
    await recomputeLongtermPayroll(new Date("2026-08-01"), fx.userIds["老闆"], null);
    const before = await buildBochkAutopayWorkbook(new Date("2026-08-01"));
    await prisma.monthClose.create({ data: { month: new Date("2026-08-01"), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "t" } });
    const { GET } = await import("@/app/api/longterm/payroll/[month]/autopay/route");
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const call = (q: string) => GET(new Request(`http://t/api/longterm/payroll/2026-08/autopay${q}`, { headers: { cookie } }), { params: Promise.resolve({ month: "2026-08" }) } as never);
    const pv = await call("?preview=1");
    const pj = await pv.json();
    expect(pj.locked_month_warning).toContain("請確認呢個月未出過糧");
    expect(pj.total_amount).toBe(before.totalAmount);
    expect((await call("")).status).toBe(400);
    const ok = await call("?confirm_locked=1");
    expect(ok.status).toBe(200);
    const aud = await prisma.auditLog.findMany({ where: { rowId: "bochk-autopay:2026-08", action: "export_download" }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(JSON.stringify(aud)).toContain("confirmedLocked");
    expect(JSON.stringify(aud)).not.toContain("6009990001");
  });
});
