// P7：通知（首頁區塊、全部頁、已讀、角色隔離）、自動排程頁（老闆專用、開關、時間表、立即跑）、
// 開新月掣、通知電郵設定、價卡 ?pending=1。假資料；排程器喺 e2e 關閉（SCHEDULER_ENABLED=0）。
import { test, expect } from "@playwright/test";
import { loginAs, logout } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

async function userId(tel: string) {
  return (await prisma.user.findFirstOrThrow({ where: { tel } })).id;
}

test.describe.configure({ mode: "serial" });

test.describe("P7 自動化", () => {
  test.beforeEach(async ({ page }) => {
    await prisma.appNotification.deleteMany({});
    await prisma.appNotification.createMany({
      data: [
        { kind: "month_opened", title: "2031-01 已開好", body: "2031-01 已開好：掛盤 3／配額 4／每日需求 5／價卡自動複製 6、待確認 1", href: "/roster", audience: ["老闆", "主管", "會計"], dedupeKey: "e2e-1" },
        { kind: "rate_cards_pending", title: "1 張價卡要你確認", body: "2031-01 有 1 張價卡價錢有變或係新組合，未自動複製。", href: "/rate-cards?month=2031-01&pending=1", audience: ["老闆", "會計"], dedupeKey: "e2e-2" },
        { kind: "month_ready_to_lock", title: "2031-01 可以鎖月", body: "體檢全綠。", href: "/reports/monthly-close", audience: ["老闆"], dedupeKey: "e2e-3" },
      ],
    });
    await page.context().clearCookies();
  });
  test.afterAll(async () => {
    await prisma.appNotification.deleteMany({});
    await prisma.user.updateMany({ where: { tel: { in: [TEST_TEL["老闆"], TEST_TEL["會計"], TEST_TEL["主管"]] } }, data: { notifyEmail: null, notifyPrefs: {} } });
  });

  test("老闆：首頁通知區、未讀 badge、撳一條已讀並跳轉；全部頁全部已讀", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    const section = page.getByTestId("home-notifications");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("home-notifications-unread")).toHaveText("未讀 3");
    await expect(page.locator('aside a[href="/"]').first()).toContainText("3");
    // 無 PII：內容只有數字／月份
    await expect(section).not.toContainText("@");
    await section.getByTestId("home-notification-item").filter({ hasText: "價卡要你確認" }).click();
    await page.waitForURL(/\/rate-cards\?month=2031-01&pending=1/);
    const bossId = await userId(TEST_TEL["老闆"]);
    expect(await prisma.appNotification.count({ where: { readBy: { array_contains: bossId } } })).toBe(1);
    // 價卡頁 ?pending=1：自動跑預覽（2031-01 冇候選）
    await expect(page.getByText(/複製上月卡預覽 2031-01/)).toBeVisible();
    await page.goto("/notifications");
    await expect(page.getByTestId("notification-item")).toHaveCount(3);
    await page.getByTestId("notifications-toggle-unread").click();
    await expect(page.getByTestId("notification-item")).toHaveCount(2);
    await page.getByTestId("notifications-read-all").click();
    await expect(page.getByText("冇未讀通知")).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("home-notifications-unread")).toHaveCount(0);
  });

  test("會計只見自己 audience 嘅通知；主管只見一條；已讀互不影響", async ({ page }) => {
    await loginAs(page, "會計");
    await page.goto("/notifications");
    await expect(page.getByTestId("notification-item")).toHaveCount(2);
    await expect(page.getByText("可以鎖月")).toHaveCount(0);
    await logout(page);
    await loginAs(page, "主管");
    await page.goto("/notifications");
    await expect(page.getByTestId("notification-item")).toHaveCount(1);
  });

  test("自動排程頁：老闆專用；開關、改時間表、立即跑（唯讀 job）", async ({ page }) => {
    await loginAs(page, "會計");
    await expect(page.locator("aside").getByText("自動排程")).toHaveCount(0);
    await page.goto("/settings/jobs");
    await expect(page.getByTestId("jobs-page")).toBeVisible();
    await expect(page.getByText(/淨係老闆/)).toBeVisible();
    await logout(page);

    await loginAs(page, "老闆");
    await page.goto("/settings/jobs");
    for (const k of ["open_next_month", "nightly_month_health", "triage_reminder"]) await expect(page.getByTestId(`job-${k}`)).toBeVisible();
    await page.getByTestId("job-triage_reminder-run-now").click();
    await expect(page.getByText(/待答題催辦：試跑/)).toBeVisible();
    await expect.poll(() => prisma.jobRun.count({ where: { jobKey: "triage_reminder", trigger: "manual" } })).toBeGreaterThan(0);
    await page.getByTestId("job-nightly_month_health-run-now").click();
    await expect(page.getByText(/每晚鎖月前體檢：試跑成功/)).toBeVisible();
    // 改時間表（非法 → 錯誤；合法 → 儲存）
    const sched = page.getByTestId("job-triage_reminder-schedule");
    await sched.fill("not cron");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText(/時間表唔啱/)).toBeVisible();
    await sched.fill("30 9 * * *");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText(/時間表已改為「30 9 \* \* \*」/)).toBeVisible();
    // 停用 → 啟用
    await page.getByTestId("job-triage_reminder-toggle").click();
    await expect(page.getByTestId("job-triage_reminder")).toContainText("已停用");
    await page.getByTestId("job-triage_reminder-toggle").click();
    await expect(page.getByTestId("job-triage_reminder")).toContainText("啟用中");
    // 還原預設時間表
    await sched.fill("0 9 * * *");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText(/時間表已改為「0 9 \* \* \*」/)).toBeVisible();
  });

  test("盤頁「開新月」掣：確認後呼叫 API（冪等）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/sites");
    await page.getByTestId("open-month-input").fill("2031-01");
    await page.getByTestId("open-month-button").click();
    await page.getByTestId("confirm-dialog-ok").click();
    await expect(page.getByText(/2031-01 已開好|2031-01 已經開咗/)).toBeVisible();
  });

  test("通知電郵：老闆喺用戶頁改別人；本人喺改密碼頁改自己；audit 唔存電郵", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/users");
    await page.getByTestId("user-notify-button").first().click();
    await page.getByTestId("notify-email-input").fill("someone@example.test");
    await page.getByTestId("notify-pref-triage_reminder").uncheck();
    await page.getByTestId("notify-save").click();
    await expect(page.getByText("已儲存")).toBeVisible();
    expect(await prisma.user.count({ where: { notifyEmail: "someone@example.test" } })).toBe(1);
    const audits = await prisma.auditLog.findMany({ where: { action: "notify_email_update" } });
    expect(JSON.stringify(audits)).not.toContain("example.test");
    await page.context().clearCookies(); // 抽屜開住會擋住登出掣

    await loginAs(page, "會計");
    await page.goto("/change-password");
    await page.getByTestId("notify-email-input").fill("acc@example.test");
    await page.getByTestId("notify-save").click();
    await expect(page.getByText("已儲存")).toBeVisible();
    const acc = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["會計"] } });
    expect(acc.notifyEmail).toBe("acc@example.test");
    await prisma.user.updateMany({ data: { notifyEmail: null, notifyPrefs: {} } });
  });
});
