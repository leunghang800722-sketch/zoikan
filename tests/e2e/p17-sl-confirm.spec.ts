// P17（老闆 2026-10-14）：更表有 SL → 彈出人手確認醫生紙先出 4/5 津貼。
// 合成保安員（`測試長工-p17-` 前綴，afterAll 清走），用「上個月」（e2e DB 只有 7 月鎖）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

function prevMonthStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
const M = prevMonthStr();
const MONTH = new Date(`${M}-01T00:00:00.000Z`);
const RAND = Math.random().toString(36).slice(2, 8);
const NAME = `測試長工-p17-${RAND}`;
let guardId: string;
const LOCK_M = "2026-05";
const lockGuardIds: string[] = [];

test.beforeAll(async () => {
  const guard = await prisma.guard.create({ data: { nameZh: NAME, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  guardId = guard.id;
  await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: "test-e2e" } });
  await prisma.guardAvgWage.create({ data: { guardId, month: MONTH, avgDailyWage: 500, source: "test-e2e" } });
  const st = await prisma.shiftType.findFirstOrThrow({ select: { id: true, siteId: true } });
  for (const d of [3, 4, 5, 6, 12, 20, 21]) {
    await prisma.shiftRecord.create({ data: { workDate: new Date(`${M}-${String(d).padStart(2, "0")}T00:00:00.000Z`), siteId: st.siteId, shiftTypeId: st.id, guardId, recordType: "leave", leaveCode: "SL", createdBy: "test-e2e" } });
  }
});

test.afterAll(async () => {
  for (const g of [guardId, ...lockGuardIds]) {
    await prisma.guardLeaveBalanceHistory.deleteMany({ where: { guardId: g } });
    await prisma.guardLeaveBalance.deleteMany({ where: { guardId: g } });
    await prisma.longtermPayrollLine.deleteMany({ where: { guardId: g } });
    await prisma.longtermPayrollInput.deleteMany({ where: { guardId: g } });
    await prisma.shiftRecord.deleteMany({ where: { guardId: g } });
    await prisma.guardAvgWage.deleteMany({ where: { guardId: g } });
    await prisma.guardLongtermContract.deleteMany({ where: { guardId: g } });
    await prisma.guard.deleteMany({ where: { id: g } });
  }
  await prisma.longtermPayrollRun.updateMany({ where: { month: MONTH }, data: { voidedAt: new Date() } });
  await prisma.monthClose.deleteMany({ where: { month: new Date(`${LOCK_M}-01T00:00:00.000Z`) } });
});

async function slAmount(page: import("@playwright/test").Page): Promise<number> {
  const rc = await page.request.post(`/api/longterm/payroll/${M}/recompute`);
  expect(rc.ok()).toBeTruthy();
  const j = await (await page.request.get(`/api/longterm/payroll/${M}`)).json();
  const line = (j.lines as Array<{ guard_name: string; sl45_amount: number | string }>).find((l) => l.guard_name === NAME)!;
  return Number(line.sl45_amount);
}

test("彈出：通知＋首頁卡直達；面板逐段顯示；確認／當無薪後重算金額變化", async ({ page }) => {
  await loginAs(page, "老闆");
  const gen = await page.request.post(`/api/longterm/inputs/drafts/generate?month=${M}`);
  expect(gen.ok()).toBeTruthy();
  expect((await prisma.longtermPayrollInput.count({ where: { guardId, status: "draft", voidedAt: null } }))).toBe(3);

  // 通知（無姓名）
  const notif = await (await page.request.get("/api/notifications?take=50")).json();
  const mine = (notif.rows as Array<{ kind: string; title: string; href: string }>).filter((n) => n.kind === "sl_drafts_pending" && n.href.includes(`month=${M}`));
  expect(mine.length).toBeGreaterThan(0);
  expect(mine[0]!.title).toContain("段病假要你確認醫生紙");
  expect(mine[0]!.title).not.toContain("測試");

  // 首頁收件箱卡 → 直達長工糧頁人手輸入 tab
  await page.goto("/");
  const card = page.getByTestId("inbox-sl-pending");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("病假要確認醫生紙");
  await card.click();
  await page.waitForURL(/focus=sl-drafts/);
  const panel = page.getByTestId("ltpay-sl-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const rows = panel.locator('[data-testid="ltpay-sl-row"]', { hasText: NAME });
  await expect(rows).toHaveCount(3);
  // 4 日段：夠 4 日、預計 $1600；1 日段：未夠 4 日提示
  const seg4 = rows.filter({ hasText: "SL 4 日" });
  await expect(seg4).toContainText("夠 4 日");
  await expect(seg4.getByTestId("ltpay-sl-expected")).toHaveText("$1600.00");
  await expect(rows.filter({ hasText: "SL 1 日" })).toContainText("未夠 4 日");
  // 冇「全部確認」一掣（病假）
  await expect(panel.getByText("全部確認")).toHaveCount(0);

  // 未確認＝無薪：津貼 0
  expect(await slAmount(page)).toBe(0);

  // 逐段：4 日段確認、1 日段確認（短段照出）、2 日段當無薪
  await seg4.getByTestId("ltpay-sl-confirm").click();
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await rows.filter({ hasText: "SL 1 日" }).getByTestId("ltpay-sl-confirm").click();
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await rows.first().getByTestId("ltpay-sl-unpaid").click();
  await rows.first().getByTestId("ltpay-sl-unpaid-reason").fill("員工冇交紙");
  await rows.first().getByTestId("ltpay-sl-unpaid-go").click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  const voided = await prisma.longtermPayrollInput.findFirstOrThrow({ where: { guardId, voidedAt: { not: null } } });
  expect((voided.draftEvidence as { decline_reason: string }).decline_reason).toBe("員工冇交紙");
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "confirmed", doctorNoteVerified: true } })).toBe(2);
  // 5 日 SL 已確認（4 + 1）× 500 × 0.8 = 2000
  expect(await slAmount(page)).toBe(2000);

  // 重新生成：當無薪嗰段唔再出
  await page.request.post(`/api/longterm/inputs/drafts/generate?month=${M}`);
  expect(await prisma.longtermPayrollInput.count({ where: { guardId, status: "draft", voidedAt: null } })).toBe(0);
});

test("鎖月：仲有未確認 SL 草稿 → 409 sl_drafts_pending；老闆帶原因覆蓋先鎖，audit 有紀錄；會計唔可以覆蓋", async ({ page }) => {
  const g = await prisma.guard.create({ data: { nameZh: `測試長工-p17L-${RAND}`, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test-e2e" } });
  lockGuardIds.push(g.id);
  const lockMonth = new Date(`${LOCK_M}-01T00:00:00.000Z`);
  await prisma.longtermPayrollInput.create({ data: { month: lockMonth, guardId: g.id, kind: "leave", dateFrom: `${LOCK_M}-10`, dateTo: `${LOCK_M}-13`, doctorNoteVerified: false, status: "draft", draftSource: "roster_leave:SL", draftEvidence: { dates: [`${LOCK_M}-10`], roster_upload_ids: [] }, createdBy: "test-e2e" } });
  const mc = await prisma.monthClose.create({ data: { month: lockMonth, createdBy: "test-e2e" } });

  await loginAs(page, "老闆");
  const blocked = await page.request.post(`/api/month-closes/${mc.id}/lock`, { data: { force: true } });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toBe("sl_drafts_pending");
  const noReason = await page.request.post(`/api/month-closes/${mc.id}/lock`, { data: { force: true, sl_unpaid_override: true } });
  expect(noReason.status()).toBe(400);
  const ok = await page.request.post(`/api/month-closes/${mc.id}/lock`, { data: { force: true, sl_unpaid_override: true, sl_unpaid_reason: "e2e：全部當無薪" } });
  expect(ok.status()).toBe(200);
  const audit = await prisma.auditLog.findFirst({ where: { tableName: "month_closes", rowId: mc.id, action: "lock_month" } });
  expect((audit!.after as { sl_unpaid_override: { segments: number; reason: string } }).sl_unpaid_override).toMatchObject({ segments: 1, reason: "e2e：全部當無薪" });
});
