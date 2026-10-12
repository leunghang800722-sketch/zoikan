// P14：長工糧頁——「人手輸入」批量導入（預覽→確認寫入）、「銀行對數」（上載 Payroll Editor → summary → 標原因）。
// 合成保安員（測試-p14-<rand>，afterAll 清走）；批量導入用 2026-08（未鎖），銀行對數用 2026-11（自建 run）。
import { test, expect } from "@playwright/test";
import * as XLSX from "xlsx";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const NOV = new Date(Date.UTC(2026, 10, 1));
const RAND = Math.random().toString(36).slice(2, 8).toUpperCase();
const gids: string[] = [];
let runId: string;

test.beforeAll(async () => {
  for (const [k, amt] of [["A", 15000], ["B", 12000]] as const) {
    const g = await prisma.guard.create({ data: { nameZh: `測試p14${k}${RAND}`, nameEn: `P14 Test ${k} ${RAND}`, staffNoMw: `MG98${k === "A" ? "01" : "02"}${RAND.slice(0, 2)}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
    gids.push(g.id);
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: amt, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
  }
  const run = await prisma.longtermPayrollRun.create({ data: { month: NOV, status: "draft", createdBy: "test-e2e" } });
  runId = run.id;
  for (const [i, gid] of gids.entries()) {
    const amt = i === 0 ? 15000 : 12000;
    await prisma.longtermPayrollLine.create({ data: { runId, guardId: gid, contractSnapshot: [], daysInMonth: 30, workDays: 26, netBasic: amt, gross: amt, autopay: amt, notesJson: [] } });
  }
});

test.afterAll(async () => {
  await prisma.longtermPayrollRun.deleteMany({ where: { id: runId } });
  await prisma.longtermPayrollInput.deleteMany({ where: { guardId: { in: gids } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: gids } } });
  await prisma.guard.deleteMany({ where: { id: { in: gids } } });
});

test("批量導入：上載 CSV → 預覽（行數／配唔到顯示工號唔顯示姓名）→ 確認寫入 → 再上載全部略過", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await page.getByTestId("ltpay-tab-inputs").click();
  const csv = `staff_no_mw,name_en,kind,amount,note\n${(await prisma.guard.findUniqueOrThrow({ where: { id: gids[0]! } })).staffNoMw},,special_allowance,500,e2e\n,P14 Test B ${RAND},deduction,100,\nMG9999ZZ,,uniform,50,\n`;
  await page.getByTestId("ltpay-bulk-file").setInputFiles({ name: "bulk.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const prev = page.getByTestId("ltpay-bulk-preview");
  await expect(prev).toContainText("共 3 行，配到 2 行", { timeout: 15_000 });
  await expect(prev).toContainText("預計新增 2");
  await expect(prev).toContainText("配唔到 1 行");
  await expect(prev).toContainText("MG9999ZZ");
  await expect(prev).not.toContainText(`測試p14`);
  await page.getByTestId("ltpay-bulk-confirm").click();
  await expect.poll(() => prisma.longtermPayrollInput.count({ where: { guardId: { in: gids }, draftSource: "bulk_import", month: AUG } }), { timeout: 15_000 }).toBe(2);
  // 再上載同一檔：全部重複
  await page.getByTestId("ltpay-bulk-file").setInputFiles({ name: "bulk.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("ltpay-bulk-preview")).toContainText("重複略過 2", { timeout: 15_000 });
  await expect(page.getByTestId("ltpay-bulk-confirm")).toBeDisabled();
});

test("銀行對數：上載 Payroll Editor → summary → 差異行標原因（未解釋遞減）→ 匯出 CSV 連結", async ({ page }) => {
  const aoa: unknown[][] = [["BOCHK Payroll Editor"]];
  while (aoa.length < 10) aoa.push([]);
  aoa.push(["編號", "員工賬戶銀行編號", "員工賬戶類型*", "員工賬戶號碼 *", "員工賬戶名稱", "金額 (HKD)", "備考號", "備註"]);
  aoa.push([1, "012", "BBAN", "1", `P14  TEST A ${RAND}`, 15000, "", ""]); // 英文名配對（有空格），吻合
  aoa.push([2, "012", "BBAN", "2", `P14 TEST B ${RAND}`, 11900, "", ""]); // 差額 -100
  aoa.push([3, "012", "BBAN", "3", "NOBODY HERE", 777, "", ""]); // 只喺銀行
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Payroll Editor");
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "biff8" }));

  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-11");
  await page.getByTestId("ltpay-tab-recon").click();
  await page.getByTestId("ltpay-recon-file").setInputFiles({ name: "payroll-editor.xls", mimeType: "application/vnd.ms-excel", buffer });
  const sum = page.getByTestId("ltpay-recon-summary");
  await expect(sum).toContainText("銀行行數／系統人數", { timeout: 20_000 });
  await expect(sum).toContainText("3／2");
  await expect(sum).toContainText("未解釋");
  const rows = page.getByTestId("ltpay-recon-row");
  await expect(rows).toHaveCount(2); // 只睇差異：差額 1＋只喺銀行 1
  await expect(rows.first()).toContainText("有差額");
  await rows.first().getByTestId("ltpay-recon-expand").click();
  await expect(page.getByTestId("ltpay-recon-components")).toContainText("Net Basic");
  await rows.first().getByTestId("ltpay-recon-reason").selectOption("attendance_day");
  await expect.poll(() => prisma.longtermBankReconciliationRow.count({ where: { reasonCode: "attendance_day", reconciliation: { month: NOV } } }), { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId("ltpay-recon-csv")).toBeVisible();
  // 銀行名唔入庫原文
  const stored = await prisma.longtermBankReconciliationRow.findMany({ where: { reconciliation: { month: NOV } } });
  expect(JSON.stringify(stored)).not.toContain("NOBODY");
});
