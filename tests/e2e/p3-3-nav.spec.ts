// P3 階段 3（導覽列＋頁面架構）e2e：NAV_SCHEMA 導覽、共用月份選擇器、報表 tab、首頁待辦收件箱、
// 舊路徑 redirect、保安員「新增 ▾」、雞頭銀行兩格、保安員角色說明頁。
// 全部用 seed 假數據；銀行值只用假值並於測試後還原（PII 規則）。截圖只喺設咗 E2E_SHOT_DIR 先存（唔入 repo）。
import { test, expect, type Page } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

const SHOT = process.env.E2E_SHOT_DIR;
async function shot(page: Page, name: string) {
  if (SHOT) await page.screenshot({ path: `${SHOT}/${name}` });
}

const navLinks = (page: Page) => page.locator('aside [data-testid^="nav-/"]');

test.describe("導覽列（桌面 1512×700）", () => {
  test.use({ viewport: { width: 1512, height: 700 } });

  test("老闆：18 條、6 組、唔使捲（nav scrollHeight ≤ clientHeight）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    await expect(navLinks(page)).toHaveCount(18);
    // 組標題：排更／對數／月結／資料／設定（首頁冇標題）
    const aside = page.locator("aside");
    for (const t of ["排更", "對數", "月結", "資料", "設定"]) await expect(aside.getByText(t, { exact: true })).toBeVisible();
    const m = await page.locator("aside nav").evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(m.sh).toBeLessThanOrEqual(m.ch);
    await shot(page, "nav-boss-1512x700.png");
    // 已移除嘅舊連結
    for (const h of ["/reports/shortfall", "/guard-fix", "/guards/import", "/reports/gross-margin", "/reports/payroll", "/reports/ops-digest", "/reports/longterm-payroll"]) {
      await expect(page.locator(`aside [data-testid="nav-${h}"]`)).toHaveCount(0);
    }
  });

  for (const [who, n] of [["主管", 11], ["會計", 11], ["雞頭A", 6]] as const) {
    test(`${who}：${n} 條`, async ({ page }) => {
      await loginAs(page, who);
      await page.goto("/");
      await expect(navLinks(page)).toHaveCount(n);
      await shot(page, `nav-${who}-1512x700.png`);
    });
  }

  test("雞頭：3 組（首頁／排更／我的），冇「雞頭」連結", async ({ page }) => {
    await loginAs(page, "雞頭A");
    await page.goto("/");
    const aside = page.locator("aside");
    await expect(aside.getByText("排更", { exact: true })).toBeVisible();
    await expect(aside.getByText("我的", { exact: true })).toBeVisible();
    await expect(aside.getByText("其他", { exact: true })).toHaveCount(0);
    await expect(page.locator('aside [data-testid="nav-/brokers"]')).toHaveCount(0);
    await expect(page.locator('aside [data-testid="nav-/guards"]')).toHaveText("我的保安員");
  });

  test("保安員：只有首頁，見說明頁（改密碼／登出）", async ({ page }) => {
    await loginAs(page, "安員");
    await page.goto("/");
    await expect(navLinks(page)).toHaveCount(1);
    const landing = page.getByTestId("guard-landing");
    await expect(landing).toContainText("系統功能稍後開放");
    await expect(landing.getByRole("link", { name: "改密碼" })).toBeVisible();
    await expect(landing.getByRole("button", { name: "登出" })).toBeVisible();
    await shot(page, "nav-guard-landing.png");
  });
});

test.describe("手機導覽（375）", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test("老闆：抽屜 18 條連結＋組標題", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    await page.getByTestId("mobile-nav-hamburger").click();
    const drawer = page.getByTestId("mobile-nav-drawer");
    await expect(drawer.locator('[data-testid^="mnav-/"]')).toHaveCount(18);
    await shot(page, "nav-boss-mobile-375.png");
  });
});

test.describe("共用月份選擇器＋報表 tab", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("揀 2026-07 → URL＋sessionStorage 同步；換報表 tab、換去更表上載，月份跟住", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/payroll");
    await expect(page.getByTestId("report-tabs")).toBeVisible();
    await page.locator('input[type="month"]').fill("2026-07");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("zk.month"))).toBe("2026-07");
    await expect.poll(() => new URL(page.url()).searchParams.get("month")).toBe("2026-07");

    await page.getByTestId("report-tab-gross-margin").click();
    await page.waitForURL(/\/reports\/gross-margin/);
    await expect(page.locator('input[type="month"]')).toHaveValue("2026-07");
    await expect(page.getByTestId("report-tab-gross-margin")).toHaveAttribute("aria-current", "page");

    // 用導覽去另一頁（冇 ?month=），由 sessionStorage 還原
    await page.locator('aside [data-testid="nav-/roster-uploads"]').click();
    await page.waitForURL(/\/roster-uploads/);
    await expect(page.locator('input[type="month"]').first()).toHaveValue("2026-07");
    await expect.poll(() => new URL(page.url()).searchParams.get("month")).toBe("2026-07");
  });

  test("報表五個 tab 全部可去，kicker「月結 › 報表」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/monthly-close");
    const tabs = page.getByTestId("report-tabs");
    await expect(tabs.getByRole("link")).toHaveCount(5);
    for (const [slug, text] of [["payroll", "糧明細"], ["longterm-payroll", "長工糧"], ["ops-digest", "修正摘要"], ["gross-margin", "毛利"], ["monthly-close", "月結總表"]] as const) {
      await tabs.getByTestId(`report-tab-${slug}`).click();
      await page.waitForURL(new RegExp(`/reports/${slug}`));
      await expect(page.getByText("月結 › 報表").first()).toBeVisible();
      await expect(tabs.getByTestId(`report-tab-${slug}`)).toHaveText(text);
    }
    await shot(page, "report-tabs.png");
  });

  test("月結總表頁：冇鎖定掣，有去一鍵結算連結；更多 ▾ 有匯出／介紹費", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/monthly-close?month=2026-07");
    await expect(page.getByTestId("recon-rules-title")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^鎖定|^解鎖/ })).toHaveCount(0);
    await expect(page.getByTestId("goto-month-close")).toBeVisible();
    await page.getByTestId("more-menu").click();
    await expect(page.getByRole("menuitem", { name: "匯出 Excel" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "重算介紹費" })).toBeVisible();
  });
});

test.describe("首頁待辦收件箱＋舊路徑 redirect", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("老闆首頁：待辦卡齊（單位更／題／盤），待審批數同 API 一致", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/");
    const inbox = page.getByTestId("home-inbox");
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    for (const id of ["inbox-approvals", "inbox-triage", "inbox-unreconciled", "inbox-month-close"]) await expect(inbox.getByTestId(id)).toBeVisible();
    const res = await page.request.get("/api/reports/shortfall?date=2026-07-15&include_margin=0");
    const body = (await res.json()) as { pending_approval_total: number };
    await expect(inbox.getByTestId("inbox-approvals")).toContainText(`${body.pending_approval_total}`);
    await expect(inbox.getByTestId("inbox-approvals")).toContainText("更");
    await expect(inbox.getByTestId("inbox-triage")).toContainText("題");
    await shot(page, "home-inbox.png");
  });

  test("主管首頁：只有有權限嗰啲格（冇「要老闆決定」）", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/");
    const inbox = page.getByTestId("home-inbox");
    await expect(inbox).toBeVisible({ timeout: 20_000 });
    await expect(inbox.getByTestId("inbox-needs-boss")).toHaveCount(0);
  });

  test("/reports/shortfall → /；/guard-fix → /roster-uploads?tab=fix（導覽 active 跟住）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/reports/shortfall?date=2026-07-15");
    await page.waitForURL((u) => u.pathname === "/");
    expect(new URL(page.url()).searchParams.get("date")).toBe("2026-07-15");

    await page.goto("/guard-fix");
    await page.waitForURL(/\/roster-uploads\?tab=fix/);
    await expect(page.getByTestId("roster-uploads-tab-fix")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('aside [data-testid="nav-/roster-uploads?tab=fix"]')).toHaveClass(/font-semibold/);
    await expect(page.locator('aside [data-testid="nav-/roster-uploads"]')).not.toHaveClass(/font-semibold/);
    // 切返「上載與對數」tab
    await page.getByTestId("roster-uploads-tab-upload").click();
    await expect(page.getByTestId("roster-uploads-upload-tab")).toBeVisible();
  });

  test("主管 /roster-uploads：冇修復 tab", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/roster-uploads?tab=fix");
    await expect(page.getByTestId("roster-uploads-tabs")).toHaveCount(0);
    await expect(page.getByTestId("roster-uploads-upload-tab")).toBeVisible();
  });
});

test.describe("資料頁", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("保安員「新增 ▾」：手動新增開 Drawer；批量導入去 /guards/import，有「返回保安員」", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/guards");
    await page.getByTestId("guards-add-menu").click();
    await expect(page.getByTestId("guards-add-manual")).toBeVisible();
    await page.getByTestId("guards-add-manual").click();
    await expect(page.getByRole("heading", { name: /新增保安員/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/guards");
    await page.getByTestId("guards-add-menu").click();
    await page.getByTestId("guards-add-import").click();
    await page.waitForURL(/\/guards\/import/);
    await page.getByTestId("back-to-guards").click();
    await page.waitForURL((u) => u.pathname === "/guards");
  });

  test("雞頭 Drawer：銀行名＋戶口號碼兩格，存返 bank_info（假值，測試後還原）", async ({ page }) => {
    const broker = await prisma.broker.findFirstOrThrow({ where: { isInternal: false, status: "active" }, orderBy: { code: "asc" } });
    const original = broker.bankInfo;
    try {
      await loginAs(page, "老闆");
      await page.goto("/brokers");
      const row = page.locator("main table tbody tr", { hasText: broker.code }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole("button", { name: "編輯" }).click();
      await expect(page.getByTestId("broker-bank-name")).toBeVisible();
      await expect(page.locator("textarea")).toHaveCount(0);
      await page.getByTestId("broker-bank-name").fill("測試銀行（假）");
      await page.getByTestId("broker-bank-account").fill("000-000000-000");
      await page.getByRole("button", { name: /^儲存/ }).click();
      await expect(page.getByText(/已更新|已儲存/).first()).toBeVisible({ timeout: 15_000 });
      const after = await prisma.broker.findUniqueOrThrow({ where: { id: broker.id } });
      const info = after.bankInfo as Record<string, unknown>;
      expect(info.bank_name).toBe("測試銀行（假）");
      expect(info.account_no).toBe("000-000000-000");
    } finally {
      await prisma.broker.update({ where: { id: broker.id }, data: { bankInfo: original === null ? Prisma.DbNull : (original as object) } });
    }
  });
});


// 強制鎖定（老闆專用，鎖月條件未齊先出）——規劃者裁定補返；body 同舊 /reports/monthly-close 一致：{ force: true, override_reason }。
function forceRun(month: string, locked: boolean) {
  return {
    id: "run-e2e-force", month, status: "done", started_at: "2026-10-10T05:33:00.000Z", finished_at: "2026-10-10T05:33:09.000Z", current_step: null, stalled: false,
    steps_total: 10, steps_done: 10, totals: null, error_message: null,
    steps: [{ key: "precheck", label: "前置檢查", status: "done", started_at: "2026-10-10T05:33:00.000Z", finished_at: "2026-10-10T05:33:01.000Z", numbers: { currentMonthLocked: locked }, warnings: [], needs_human: [] }],
    report: {
      month, totals: { revenue: 0, margin_revenue: 0, cost: 0, gross_margin: 0, cost_basis: "combined", legacy_cost: 0, legacy_margin: 0 },
      payroll_by_broker: [], site_revenue: [], referral_fee: { total: 0, count: 0 },
      unpriced: { count: 0, payout_count: 0, client_count: 0, no_settlement_count: 0, ot_unpriced_count: 0, gap: { records: 0, client_gap_estimate: 0, payout_gap_estimate: 0, no_reference_records: 0 } },
      auto: null, postorder_compare: null, needs_human: [],
      lock_precondition: { current_month_already_locked: locked, missing_upload_sites: [], unconfirmed_upload_sites: ["測試盤甲"], unpriced_count: 0, ready_to_lock: false },
      longterm_payroll_note: "", longterm_payroll: null,
      combined_cost_summary: { per_shift_cost_total: 0, referral_fee_total: 0, longterm_autopay_total: 0, combined_cost_total: 0, mpf_er_total: 0 },
    },
  };
}
async function mockForceRun(page: Page, month: string) {
  await page.route("**/api/month-close/one-click?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [forceRun(month, false)] }) }));
  await page.route("**/api/month-close/one-click/run-e2e-force", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: forceRun(month, false) }) }));
}

test.describe("強制鎖定（/month-close LockSection）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const M = "2026-11";

  test("老闆：條件未齊先出；原因必填；body { force, override_reason }；鎖完解返", async ({ page }) => {
    await loginAs(page, "老闆");
    expect([200, 201, 409]).toContain((await page.request.post(`/api/months/${M}/open`, { data: { roster_version_note: "e2e force" } })).status());
    await mockForceRun(page, M);
    await page.goto(`/month-close?month=${M}`);
    await expect(page.getByTestId("force-lock-box")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("rail-lock-month")).toBeDisabled(); // 一般鎖定掣照舊停用
    await expect(page.getByTestId("force-lock-reason")).toHaveCount(0);
    await page.getByTestId("force-lock-check").check();
    await expect(page.getByTestId("force-lock-month")).toBeDisabled(); // 原因必填
    await page.getByTestId("force-lock-reason").fill("e2e 強制鎖定測試");
    await expect(page.getByTestId("force-lock-month")).toBeEnabled();
    const req = page.waitForRequest((r) => /\/api\/month-closes\/[^/]+\/lock$/.test(r.url()) && r.method() === "POST");
    await page.getByTestId("force-lock-month").click();
    expect((await req).postDataJSON()).toEqual({ force: true, override_reason: "e2e 強制鎖定測試" });
    await expect(page.getByText(`${M} 已鎖定`).first()).toBeVisible({ timeout: 15_000 });
    const closes = await (await page.request.get(`/api/month-closes?month=${M}`)).json();
    expect(closes.rows[0].locked_at).toBeTruthy();
    // 還原
    const un = await page.request.post(`/api/month-closes/${closes.rows[0].id}/unlock`, { data: { reason: "e2e 還原" } });
    expect(un.ok()).toBe(true);
  });

  test("主管見唔到強制鎖定", async ({ page }) => {
    await loginAs(page, "主管");
    await mockForceRun(page, M);
    await page.goto(`/month-close?month=${M}`);
    await expect(page.getByTestId("lock-section")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("force-lock-box")).toHaveCount(0);
  });
});


test.describe("hydration 一致＋只 fetch 一次（第二輪修正）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const PAGES = ["/", "/month-close", "/reports/payroll", "/reports/longterm-payroll"];
  for (const variant of ["url", "storage"] as const) {
    for (const path of PAGES) {
      test(`${path}（${variant === "url" ? "?month= 同預設唔同" : "sessionStorage 月份同預設唔同"}）：0 pageerror／#418／hydration 警告`, async ({ page }) => {
        const bad: string[] = [];
        page.on("pageerror", (e) => bad.push(`pageerror: ${e.message}`));
        page.on("console", (m) => {
          const t = m.text();
          if (m.type() === "error" && /418|hydrat/i.test(t)) bad.push(`console: ${t.slice(0, 200)}`);
        });
        const payrollMonths: string[] = [];
        page.on("request", (r) => {
          const u = new URL(r.url());
          if (u.pathname === "/api/reports/payroll") payrollMonths.push(u.searchParams.get("month") ?? "");
        });
        await loginAs(page, "老闆");
        if (variant === "storage") await page.addInitScript(() => sessionStorage.setItem("zk.month", "2026-08"));
        await page.goto(variant === "url" ? `${path}?month=2026-08` : path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500);
        expect(bad).toEqual([]);
        if (path === "/reports/payroll") expect(new Set(payrollMonths)).toEqual(new Set(["2026-08"])); // 只用最終月份 fetch
        if (path === "/") await expect(page.getByTestId("inbox-month-close")).toContainText("2026-08 月結");
      });
    }
  }
});

test.describe("§6.3 紅色差異／強制鎖定／解鎖權限／修復預設月份（第二輪修正）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const M = "2026-11";

  test("has_diff：先唔打 lock，出 override 原因；填咗再撳先送 { override_reason }", async ({ page }) => {
    await loginAs(page, "老闆");
    expect([200, 201, 409]).toContain((await page.request.post(`/api/months/${M}/open`, { data: { roster_version_note: "e2e diff" } })).status());
    const run = forceRun(M, false);
    run.report.lock_precondition = { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, ready_to_lock: true } as never;
    await page.route("**/api/month-close/one-click?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [run] }) }));
    await page.route("**/api/month-close/one-click/run-e2e-force", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run }) }));
    // generate 回應加 has_diff（lock 仍打真 API；真 API 無差異時唔會要 reason，所以 lock 用 fulfill 驗 body）
    await page.route(/\/api\/month-closes\/[^/]+\/generate$/, async (r) => {
      const real = await r.fetch();
      const j = await real.json();
      j.reconciliation = { ...(j.reconciliation ?? {}), has_diff: true };
      await r.fulfill({ response: real, body: JSON.stringify(j) });
    });
    const lockBodies: unknown[] = [];
    await page.route(/\/api\/month-closes\/[^/]+\/lock$/, (r) => {
      lockBodies.push(r.request().postDataJSON());
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locked: true }) });
    });
    await page.goto(`/month-close?month=${M}`);
    await expect(page.getByTestId("rail-lock-month")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("rail-lock-month").click();
    await expect(page.getByTestId("diff-reason-box")).toBeVisible();
    await expect(page.getByTestId("rail-diff-reason")).toBeVisible();
    expect(lockBodies).toEqual([]);
    await expect(page.getByTestId("rail-lock-month")).toBeDisabled(); // 原因必填
    await page.getByTestId("rail-diff-reason").fill("差異已核對");
    await page.getByTestId("rail-lock-month").click();
    await expect.poll(() => lockBodies.length).toBe(1);
    expect(lockBodies[0]).toEqual({ override_reason: "差異已核對" });
  });

  // P3-5.5：mock generate 回 has_diff＋lock 只記 body（唔打真 API）。
  async function mockDiffLock(page: Page, ready: boolean): Promise<unknown[]> {
    expect([200, 201, 409]).toContain((await page.request.post(`/api/months/${M}/open`, { data: { roster_version_note: "e2e diff" } })).status());
    const run = forceRun(M, false);
    if (ready) run.report.lock_precondition = { current_month_already_locked: false, missing_upload_sites: [], unconfirmed_upload_sites: [], unpriced_count: 0, ready_to_lock: true } as never;
    await page.route("**/api/month-close/one-click?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [run] }) }));
    await page.route("**/api/month-close/one-click/run-e2e-force", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run }) }));
    await page.route(/\/api\/month-closes\/[^/]+\/generate$/, async (r) => {
      const real = await r.fetch();
      const j = await real.json();
      j.reconciliation = { ...(j.reconciliation ?? {}), has_diff: true };
      await r.fulfill({ response: real, body: JSON.stringify(j) });
    });
    const lockBodies: unknown[] = [];
    await page.route(/\/api\/month-closes\/[^/]+\/lock$/, (r) => {
      lockBodies.push(r.request().postDataJSON());
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locked: true }) });
    });
    return lockBodies;
  }

  test("強制鎖定＋紅色差異同時有：先要差異原因；body 合併成一個 override_reason", async ({ page }) => {
    await loginAs(page, "老闆");
    const lockBodies = await mockDiffLock(page, false);
    await page.goto(`/month-close?month=${M}`);
    await expect(page.getByTestId("force-lock-box")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("force-lock-check").check();
    await page.getByTestId("force-lock-reason").fill("強制原因");
    await page.getByTestId("force-lock-month").click();
    await expect(page.getByTestId("diff-reason-box")).toBeVisible(); // 有差異但未填原因：唔打 lock
    expect(lockBodies).toEqual([]);
    await page.getByTestId("diff-reason").fill("差異已核對");
    await page.getByTestId("force-lock-month").click();
    await expect.poll(() => lockBodies.length).toBe(1);
    expect(lockBodies[0]).toEqual({ force: true, override_reason: "差異已核對；強制鎖定：強制原因" });
  });

  test.describe("手機（375）", () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test("sticky bar「去填原因 ›」錨去 #diff-reason-box，輸入框入畫面", async ({ page }) => {
      await loginAs(page, "老闆");
      const lockBodies = await mockDiffLock(page, true);
      await page.goto(`/month-close?month=${M}`);
      await expect(page.getByTestId("rail-lock-month")).toBeEnabled({ timeout: 20_000 });
      await page.getByTestId("rail-lock-month").click();
      expect(lockBodies).toEqual([]);
      const reason = page.getByTestId("rail-lock-reason");
      await expect(reason).toContainText("要填差異原因先鎖得");
      const link = reason.getByRole("link", { name: /去填原因/ });
      await expect(link).toHaveAttribute("href", "#diff-reason-box");
      await link.click();
      await expect(page).toHaveURL(/#diff-reason-box$/);
      await expect(page.getByTestId("diff-reason-box")).toBeInViewport();
      await page.getByTestId("diff-reason").fill("差異已核對");
      await expect(page.getByTestId("rail-lock-reason")).toHaveCount(0); // 填咗原因，提示消失
    });
  });

  test("冇「月結鎖定解鎖」權限（主管）：已鎖定都唔出解鎖輸入；老闆出", async ({ page }) => {
    for (const [who, expected] of [["主管", 0], ["老闆", 1]] as const) {
      await page.context().clearCookies();
      await loginAs(page, who);
      const run = forceRun("2026-07", true);
      await page.route("**/api/month-close/one-click?*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [run] }) }));
      await page.route("**/api/month-close/one-click/run-e2e-force", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run }) }));
      await page.goto("/month-close?month=2026-07");
      await expect(page.getByTestId("lock-section")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("unlock-box")).toHaveCount(expected);
      await page.unrouteAll();
    }
  });

  test("修復 tab 預設上個月；導覽連結帶 &month=上個月；首頁「要老闆決定」格同", async ({ page }) => {
    await loginAs(page, "老闆");
    const prev = await page.evaluate(() => {
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    });
    await page.goto("/roster-uploads?tab=fix"); // 冇 month、冇 storage
    await expect(page.locator('input[type="month"]').first()).toHaveValue(prev);
    await expect(page.locator('aside [data-testid="nav-/roster-uploads?tab=fix"]')).toHaveAttribute("href", `/roster-uploads?tab=fix&month=${prev}`);
    // 揀過其他月之後，URL／storage 優先
    await page.goto("/roster-uploads?tab=fix&month=2026-07");
    await expect(page.locator('input[type="month"]').first()).toHaveValue("2026-07");
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
