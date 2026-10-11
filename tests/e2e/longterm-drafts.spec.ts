// P9.1：長工糧「人手輸入」tab 草稿——草稿列表（標「草稿」、未確認唔計糧）、單條確認、全部確認（5 秒撤銷）、
// 勤工獎合資格清單（只列名）。合成保安員（`測試長工-draft-` 前綴，afterAll 清走），用 2026-08（未鎖）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const RAND = Math.random().toString(36).slice(2, 8);
let guardId: string;

test.beforeAll(async () => {
  const guard = await prisma.guard.create({ data: { nameZh: `測試長工-draft-${RAND}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  guardId = guard.id;
  await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
  for (const [from, to] of [["2026-08-03", "2026-08-05"], ["2026-08-10", "2026-08-10"], ["2026-08-20", "2026-08-21"]]) {
    await prisma.longtermPayrollInput.create({
      data: {
        month: AUG,
        guardId,
        kind: "leave",
        dateFrom: from,
        dateTo: to,
        doctorNoteVerified: false,
        note: "病假段（醫生紙待核）——由更表 SL 自動生成草稿",
        status: "draft",
        draftSource: "roster_leave:SL",
        draftEvidence: { dates: [from], roster_upload_ids: [] },
        createdBy: "test-e2e",
      },
    });
  }
});

test.afterAll(async () => {
  await prisma.longtermPayrollInput.deleteMany({ where: { guardId } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId } });
  await prisma.guard.deleteMany({ where: { id: guardId } });
});

test("草稿列表標「草稿」＋勤工獎合資格清單；單條確認；全部確認可撤銷、再確認 5 秒後生效", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await page.getByTestId("ltpay-tab-inputs").click();

  const panel = page.getByTestId("ltpay-drafts");
  await expect(panel).toContainText("草稿未確認唔計糧", { timeout: 15_000 });
  const mine = panel.locator('[data-testid="ltpay-draft-row"]', { hasText: `測試長工-draft-${RAND}` });
  await expect(mine).toHaveCount(3);
  await expect(mine.first()).toContainText("草稿");
  await expect(mine.first()).toContainText("更表 SL");

  // 勤工獎合資格清單（只列名）
  await expect(page.getByTestId("ltpay-bonus-eligible")).toContainText("只列名，唔填金額");

  // 單條確認
  await mine.first().getByTestId("ltpay-draft-confirm").click();
  await expect(mine).toHaveCount(2, { timeout: 10_000 });
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "confirmed" } })).toBe(1);

  // 全部確認 → 撤銷（零請求）
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/")) writes.push(`${r.method()} ${r.url()}`);
  });
  await page.getByTestId("ltpay-drafts-confirm-all").click();
  await expect(page.getByTestId("ltpay-drafts-undo-bar")).toBeVisible();
  await page.getByTestId("ltpay-drafts-undo-bar").getByTestId("undo-bar-undo").click();
  await expect(page.getByTestId("ltpay-drafts-undo-bar")).toHaveCount(0);
  await page.waitForTimeout(5500);
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "draft" } })).toBe(2);
  expect(writes).toHaveLength(0); // 撤銷＝零非 GET 請求

  // 再全部確認，等 5 秒送出
  await page.getByTestId("ltpay-drafts-confirm-all").click();
  await expect(page.getByTestId("ltpay-drafts-summary")).toContainText("已確認", { timeout: 15_000 });
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "draft" } })).toBe(0);
});
