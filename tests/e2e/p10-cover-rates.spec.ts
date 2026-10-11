// P10：頂位價目表頁＋由歷史反推頁＋頂位草稿確認。合成資料（`測試頂位-e2e-` 前綴，afterAll 清走），用 2026-08；
// 價目表生效日用 2026-12-01（唔撞已鎖月份）。覆蓋：老闆推斷（唯讀，零寫入）→採用→價目表出現；改額／作廢；
// 會計只可睇（infer 頁 forbidden、冇新增表單）；頂位草稿（長工糧頁標「頂位價目表」、$金額、確認）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUG = new Date(Date.UTC(2026, 7, 1));
const RAND = Math.random().toString(36).slice(2, 8);
const HOME = `測試頂位-e2e-家-${RAND}`;
const COVER = `測試頂位-e2e-頂-${RAND}`;
let homeId: string;
let coverId: string;
const shiftTypeIds: string[] = [];
const guardIds: string[] = [];

test.beforeAll(async () => {
  // 頂位更＝settlement 係外判雞頭（aggregate 口徑：非 B07 且有值）
  const b07 = await prisma.broker.findFirstOrThrow({ where: { kind: { not: "internal_longterm" }, status: "active" } });
  const home = await prisma.site.create({ data: { canonicalName: HOME, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  const cover = await prisma.site.create({ data: { canonicalName: COVER, clientName: "測試客戶-e2e", billingModel: "per_shift", createdBy: "test-e2e" } });
  homeId = home.id;
  coverId = cover.id;
  const stCover = await prisma.shiftType.create({ data: { siteId: coverId, code: "N", hours: 12, createdBy: "test-e2e" } });
  shiftTypeIds.push(stCover.id);
  for (const [i, shifts, amount] of [[1, [3, 4], 400], [2, [5], 200]] as const) {
    const g = await prisma.guard.create({ data: { nameZh: `測試頂位長工-e2e-${i}-${RAND}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
    guardIds.push(g.id);
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
    await prisma.guardLongtermPost.create({ data: { guardId: g.id, siteId: homeId, effectiveFrom: new Date("2020-01-01"), source: "manual", createdBy: "test-e2e" } });
    for (const d of shifts) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, d)), siteId: coverId, shiftTypeId: stCover.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "test-e2e" } });
    }
    await prisma.longtermPayrollInput.create({ data: { month: AUG, guardId: g.id, kind: "other_allowance", amount, note: "頂位津貼", createdBy: "test-e2e" } });
  }
});

test.afterAll(async () => {
  await prisma.coverShiftRate.deleteMany({ where: { siteId: { in: [homeId, coverId] } } });
  await prisma.longtermPayrollInput.deleteMany({ where: { guardId: { in: guardIds } } });
  await prisma.shiftRecord.deleteMany({ where: { guardId: { in: guardIds } } });
  await prisma.guardLongtermPost.deleteMany({ where: { guardId: { in: guardIds } } });
  await prisma.guardLongtermContract.deleteMany({ where: { guardId: { in: guardIds } } });
  await prisma.guard.deleteMany({ where: { id: { in: guardIds } } });
  await prisma.shiftType.deleteMany({ where: { id: { in: shiftTypeIds } } });
  await prisma.site.deleteMany({ where: { id: { in: [homeId, coverId] } } });
});

test("老闆：推斷（唯讀）→建議一致 200 → 採用 → 價目表出現 → 改額 → 作廢", async ({ page }) => {
  await loginAs(page, "老闆");
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/longterm/")) writes.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/settings/cover-rates/infer");
  await page.getByTestId("cover-infer-months").fill("2026-08");
  await page.getByTestId("cover-infer-run").click();
  const row = page.getByTestId("cover-infer-row").filter({ hasText: COVER });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText("一致");
  await expect(row).toContainText("200");
  await expect(row).toContainText("3 更／2 人");
  await expect(page.getByTestId("cover-infer-backtest-summary")).toContainText("個人月");
  await expect(page.getByTestId("cover-infer-stats")).toContainText("頂位更");
  expect(await page.content()).not.toContain("測試頂位長工"); // 頁面冇姓名
  expect(writes).toHaveLength(0); // 推斷零寫入（長工糧 API 冇任何非 GET 請求）
  expect(await prisma.coverShiftRate.count({ where: { siteId: coverId } })).toBe(0);
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/p10-infer.png", fullPage: true });

  // 採用（只揀我哋嗰行）
  const picks = page.getByTestId("cover-infer-pick");
  for (let i = 0; i < (await picks.count()); i++) await picks.nth(i).uncheck();
  await row.getByTestId("cover-infer-pick").check();
  await page.getByTestId("cover-infer-eff").fill("2026-12-01");
  await page.getByTestId("cover-infer-adopt").click();
  await expect(page.getByText("已採用 1 行")).toBeVisible({ timeout: 10_000 });
  const saved = await prisma.coverShiftRate.findMany({ where: { siteId: coverId } });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ grade: "兵", source: "inferred" });
  expect(Number(saved[0]!.amount)).toBe(200);

  // 價目表頁
  await page.goto("/settings/cover-rates");
  const rrow = page.getByTestId("cover-rate-row").filter({ hasText: COVER });
  await expect(rrow).toHaveCount(1, { timeout: 15_000 });
  await expect(rrow).toContainText("歷史反推");
  await rrow.getByTestId("cover-rate-edit").click();
  await rrow.getByTestId("cover-rate-edit-amount").fill("220");
  await rrow.getByTestId("cover-rate-save").click();
  await expect(rrow).toContainText("220", { timeout: 10_000 });
  expect(Number((await prisma.coverShiftRate.findFirstOrThrow({ where: { siteId: coverId } })).amount)).toBe(220);

  // 手動新增另一職級
  await page.getByTestId("cover-rates-site").selectOption({ label: COVER });
  await page.getByTestId("cover-rates-grade").selectOption("IC");
  await page.getByTestId("cover-rates-amount").fill("260");
  await page.getByTestId("cover-rates-from").fill("2026-12-01");
  await page.getByTestId("cover-rates-submit").click();
  await expect(page.getByTestId("cover-rate-row").filter({ hasText: COVER })).toHaveCount(2, { timeout: 10_000 });

  // 作廢兵價
  await page.getByTestId("cover-rate-row").filter({ hasText: COVER }).filter({ hasText: "歷史反推" }).getByTestId("cover-rate-void").click();
  await expect(page.getByTestId("cover-rate-row").filter({ hasText: COVER })).toHaveCount(1, { timeout: 10_000 });
});

test("會計：價目表只可睇（冇新增表單）、infer 頁 forbidden；infer API 403", async ({ page }) => {
  await loginAs(page, "會計");
  await page.goto("/settings/cover-rates");
  await expect(page.getByTestId("cover-rates-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("cover-rates-add")).toHaveCount(0);
  await expect(page.getByTestId("cover-rate-edit")).toHaveCount(0);
  await page.goto("/settings/cover-rates/infer");
  await expect(page.getByTestId("cover-infer-forbidden")).toBeVisible({ timeout: 15_000 });
  const status = await page.evaluate(async () => (await fetch("/api/longterm/cover-rates/infer?months=2026-08")).status);
  expect(status).toBe(403);
});

test("會計：頂位草稿喺長工糧頁標「頂位價目表」＋金額，確認後轉 confirmed", async ({ page }) => {
  const draft = await prisma.longtermPayrollInput.create({
    data: {
      month: AUG,
      guardId: guardIds[0]!,
      kind: "other_allowance",
      amount: 480,
      note: "頂位津貼（草稿）——按價目表自動計 2 更，待確認",
      status: "draft",
      draftSource: "cover:rates",
      draftEvidence: { lines: [], shifts: 2 },
      createdBy: "test-e2e",
    },
  });
  await loginAs(page, "會計");
  await page.goto("/reports/longterm-payroll");
  await page.locator('input[type="month"]').fill("2026-08");
  await page.getByTestId("ltpay-tab-inputs").click();
  const panel = page.getByTestId("ltpay-drafts");
  const mine = panel.locator('[data-testid="ltpay-draft-row"]', { hasText: `測試頂位長工-e2e-1-${RAND}` });
  await expect(mine).toHaveCount(1, { timeout: 15_000 });
  await expect(mine).toContainText("頂位價目表");
  await expect(mine.getByTestId("ltpay-draft-cover-amount")).toContainText("$480");
  await expect(mine.getByTestId("ltpay-draft-cover-amount")).toContainText("2 更");
  await mine.getByTestId("ltpay-draft-confirm").click();
  await expect(mine).toHaveCount(0, { timeout: 10_000 });
  expect((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("confirmed");
});
