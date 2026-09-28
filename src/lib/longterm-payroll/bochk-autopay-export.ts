// WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：長工 autopay 檔要出**指定
// 格式**（唔係密碼）——老闆／會計實際操作係用 BOCHK **Payroll（Payment
// Type）Editor（Excel 巨集）**貼資料，再由佢產生正式 `.DAT`；系統要出嘅
// 係「Payroll Editor 明細欄位次序」嘅 xlsx（唔係最終 `.DAT`）。格式已由
// BOCHK 公開文件《Payroll (Payment Type) Editor and File Specification
// (FPS) v1.2》核實（本地 7 月參考檔 `…-BOCHK-PayrollEditor.xls` 檔名亦
// 印證呢個判斷）。
//
// Sheet 「Payroll Editor 明細」欄位次序跟 BOCHK Editor 第 10–20 欄：
//   編號 No. / 員工賬戶銀行編號 Employee A/C Bank Code（3 位）/ 員工賬戶
//   類型 Employee Account Type（固定 BBAN）/ 員工賬戶號碼 Employee A/C /
//   員工賬戶名稱 Employee Name（bank_payee_name；BOCHK 只收 HKICL 字元：
//   0-9、空格、a-z、A-Z、&'()*+,-./$=，仲要 ≤140 字元，含中文/其他字元
//   或者過長 → 唔出行，列入缺資料）/ 金額 Amount（autopay，2 位小數）/
//   備考號 Reference（LT<YYYYMM>-<工號>，≤35）/ 備註 Remark（月份，
//   ≤140）/ 通知渠道1 e-Alert Type 1／通知電郵地址/電話號碼 1（主電話，
//   8 位——WP-BOSS5 驗收項 3：呢個規格 e-Alert 類型／聯絡**係必填**，
//   唔係「有就填、冇就留空」，電話唔係 8 位嘅人**唔出明細行**，改列入
//   缺資料，原因「通知電話要 8 位」）/ 通知渠道2（留空）/ 通知電郵
//   地址/電話號碼 2（留空）。
// Sheet 「檔頭資料」：發薪賬戶號碼（空）、發薪日期（空）、付款類別
//   （001 預設，可改）、貨幣 HKD、總筆數、總金額（=Σ金額，2 位）。
// Sheet 「缺資料」：冇 bank_code／賬戶號碼／賬戶名稱／名稱含非 HKICL
//   字元或者長過 140／賬戶號碼含 0-9／-以外字元／通知電話唔係 8 位嘅人
//   （淨係工號＋原因，冇姓名/電話/戶口號碼）。
//
// Excel 鐵則：sheet 名唔含 `/ \ ? * [ ] :`（含全形，`sanitizeSheetName()`
// 已經處理）、冇空字串格（`setCell()`）、`=` 開頭字串當文字（用
// `.value = <literal>` 賦值，唔用 formula 物件）。
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { n, monthLabel } from "@/lib/reports/money";
import { sanitizeSheetName } from "@/lib/reports/postorder-export";

/** BOCHK Payroll Editor 只收呢批字元（HKICL 標準）：0-9、空格、a-z、
 * A-Z、`&'()*+,-./$=`。 */
const HKICL_NAME_CHARS = /^[0-9A-Za-z &'()*+,\-./$=]*$/;
/** WP-BOSS5 驗收項 3：賬戶名稱 Employee Name ≤140 字元（BOCHK Editor 欄位長度上限）。 */
const BANK_PAYEE_NAME_MAX_LEN = 140;
/** WP-BOSS5 驗收項 3：賬戶號碼 Employee A/C——淨係收 0-9／`-`（BOCHK Editor 唔收其他字元）。 */
const ACCOUNT_NO_CHARS = /^[0-9-]*$/;

export const BOCHK_FORMAT_SOURCE = "BOCHK Payroll (Payment Type) Editor and File Specification v1.2 (FPS)";
const DEFAULT_PAYMENT_TYPE = "001";
const ACCOUNT_TYPE = "BBAN";

/** 避免寫空字串格（鐵則）——冇值就唔賦值，留返真正嘅空 cell；`=` 開頭嘅
 * 字串一律用 `.value = <literal>` 直接賦值（str cell type），唔會被當
 * 公式（公式要顯式 `{formula, result}`，呢個檔全程冇用過）。 */
function setCell(ws: ExcelJS.Worksheet, row: number, col: number, value: string | number | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  ws.getCell(row, col).value = value;
}

export interface BochkAutopayMissingRow {
  staff_no: string;
  reason: string;
}

export interface BochkAutopayResult {
  workbook: ExcelJS.Workbook;
  month: string;
  rowCount: number;
  totalAmount: number;
  missing: BochkAutopayMissingRow[];
  formatVerified: true;
  formatSource: string;
}

/** 主電話（8 位）：`guards.tel` 由 `syncLegacyGuardContactColumns()` 同
 * primary `guard_phones` 行保持一致（見 src/lib/guards/contacts.ts），
 * 唔使呢度再逐個查 guard_phones（避免 N+1）。淨係 8 位數字先當有效——
 * 格式唔啱嘅唔准估，通知渠道／號碼一齊留空。 */
function primaryPhone8(tel: string | null): string | null {
  if (!tel) return null;
  const digits = tel.replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

function staffLabel(g: { staffNo: string | null; staffNoMw: string | null; id: string }): string {
  return g.staffNo ?? g.staffNoMw ?? g.id.slice(0, 8);
}

/** 純資料組裝（唔寫 DB／唔寫 audit——呢兩樣留俾 caller，同 `buildPostorderWorkbook()` 一致分工）。 */
export async function buildBochkAutopayWorkbook(month: Date): Promise<BochkAutopayResult> {
  const monthStr = monthLabel(month);
  const run = await prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
  if (!run) {
    throw new Error(`${monthStr} 未計過長工糧（撳「重算本月」先）`);
  }

  const lines = await prisma.longtermPayrollLine.findMany({
    where: { runId: run.id },
    include: { guard: { select: { id: true, staffNo: true, staffNoMw: true, tel: true, bankCode: true, bankAccountNo: true, bankPayeeName: true } } },
    orderBy: { createdAt: "asc" },
  });

  const monthCompact = monthStr.replace("-", "");
  const missing: BochkAutopayMissingRow[] = [];
  const rows: { seq: number; bankCode: string; accountNo: string; payeeName: string; amount: number; reference: string; remark: string; alertType1: string; contact1: string }[] = [];

  let seq = 0;
  for (const l of lines) {
    const g = l.guard;
    const label = staffLabel(g);
    const reasons: string[] = [];
    if (!g.bankCode) reasons.push("冇銀行編號（bank_code）");
    if (!g.bankAccountNo) reasons.push("冇賬戶號碼");
    else if (!ACCOUNT_NO_CHARS.test(g.bankAccountNo)) reasons.push("賬戶號碼只可以係 0-9／-");
    if (!g.bankPayeeName) reasons.push("冇賬戶名稱");
    else if (!HKICL_NAME_CHARS.test(g.bankPayeeName)) reasons.push("賬戶名稱要英文（含 HKICL 唔收嘅字元）");
    else if (g.bankPayeeName.length > BANK_PAYEE_NAME_MAX_LEN) reasons.push(`賬戶名稱長過 ${BANK_PAYEE_NAME_MAX_LEN} 字元`);
    // WP-BOSS5 驗收項 3（老闆 2026-09-28 決定 6 格式跟 BOCHK Payroll
    // Editor 規格）：通知渠道 e-Alert Type／通知電話喺呢個規格係必填欄
    // （唔係得個「有就填」嘅選填），冇 8 位電話嘅人唔可以出明細行（留空
    // 兩格會令呢行喺 Editor 度唔合規格），改列入「缺資料」等會計人手
    // 跟進電話。
    const phone = primaryPhone8(g.tel);
    if (!phone) reasons.push("通知電話要 8 位");
    if (reasons.length > 0) {
      missing.push({ staff_no: label, reason: reasons.join("、") });
      continue;
    }
    seq += 1;
    const reference = `LT${monthCompact}-${label}`.slice(0, 35);
    rows.push({
      seq,
      bankCode: g.bankCode!,
      accountNo: g.bankAccountNo!,
      payeeName: g.bankPayeeName!,
      amount: n(l.autopay),
      reference,
      remark: `長工 Autopay ${monthStr}`.slice(0, 140),
      alertType1: "S",
      contact1: phone!,
    });
  }

  const totalAmount = rows.reduce((a, r) => a + r.amount, 0);

  const wb = new ExcelJS.Workbook();

  const detail = wb.addWorksheet(sanitizeSheetName("Payroll Editor 明細"));
  const detailHeader = [
    "編號 No.",
    "員工賬戶銀行編號 Employee A/C Bank Code",
    "員工賬戶類型 Employee Account Type",
    "員工賬戶號碼 Employee A/C",
    "員工賬戶名稱 Employee Name",
    "金額 Amount",
    "備考號 Reference",
    "備註 Remark",
    "通知渠道1 e-Alert Type 1",
    "通知電郵地址/電話號碼 1",
    "通知渠道2",
    "通知電郵地址/電話號碼 2",
  ];
  detailHeader.forEach((h, i) => setCell(detail, 1, i + 1, h));
  rows.forEach((r, i) => {
    const row = i + 2;
    setCell(detail, row, 1, r.seq);
    setCell(detail, row, 2, r.bankCode);
    setCell(detail, row, 3, ACCOUNT_TYPE);
    setCell(detail, row, 4, r.accountNo);
    setCell(detail, row, 5, r.payeeName);
    setCell(detail, row, 6, Math.round(r.amount * 100) / 100);
    setCell(detail, row, 7, r.reference);
    setCell(detail, row, 8, r.remark);
    setCell(detail, row, 9, r.alertType1);
    setCell(detail, row, 10, r.contact1);
    // 通知渠道2／通知電郵地址/電話號碼 2——留空（鐵則：冇值就唔賦值）。
  });

  const header = wb.addWorksheet(sanitizeSheetName("檔頭資料"));
  setCell(header, 1, 1, "發薪賬戶號碼");
  setCell(header, 2, 1, "發薪日期");
  setCell(header, 3, 1, "付款類別");
  setCell(header, 3, 2, DEFAULT_PAYMENT_TYPE);
  setCell(header, 4, 1, "貨幣");
  setCell(header, 4, 2, "HKD");
  setCell(header, 5, 1, "總筆數");
  setCell(header, 5, 2, rows.length);
  setCell(header, 6, 1, "總金額");
  setCell(header, 6, 2, Math.round(totalAmount * 100) / 100);
  // 發薪賬戶號碼／發薪日期——會計喺 Editor 填，呢兩格刻意唔賦值（留空）。

  const missingSheet = wb.addWorksheet(sanitizeSheetName("缺資料"));
  setCell(missingSheet, 1, 1, "工號");
  setCell(missingSheet, 1, 2, "原因");
  missing.forEach((m, i) => {
    setCell(missingSheet, i + 2, 1, m.staff_no);
    setCell(missingSheet, i + 2, 2, m.reason);
  });

  return {
    workbook: wb,
    month: monthStr,
    rowCount: rows.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    missing,
    formatVerified: true,
    formatSource: BOCHK_FORMAT_SOURCE,
  };
}
