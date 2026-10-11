// P13 hotfix：「要你睇」手機流程（分頁載入／返回列表／上一題／記住位置）＋全站返回（覆蓋層入 history、手機頂欄「‹」）。
// 合成資料：保安員導入 session 350 題（重要 122、補充 228，仿正式站）＋月結 session 12 題。無 PII。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";
import { seedGuardImportQuestions } from "../lib/triage-seed";

test.describe.configure({ mode: "serial" });

const GI_REF = "e2e-p13-gi";
const MC_REF = "e2e-p13-mc";
const MOBILE = { width: 375, height: 812 };

async function cleanup() {
  const ss = await prisma.triageSession.findMany({ where: { sourceRef: { in: [GI_REF, MC_REF] } }, select: { id: true } });
  await prisma.triageQuestion.deleteMany({ where: { sessionId: { in: ss.map((s) => s.id) } } });
  await prisma.triageSession.deleteMany({ where: { sourceRef: { in: [GI_REF, MC_REF] } } });
}

async function seedGuardImport(): Promise<string> {
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const s = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: GI_REF, ownerUserId: boss.id, createdBy: boss.id } });
  await prisma.triageQuestion.createMany({
    data: seedGuardImportQuestions(350, 122).map((q) => ({ sessionId: s.id, kind: q.kind, groupKey: q.groupKey, sort: q.sort, title: q.title, evidenceJson: q.evidenceJson as never, optionsJson: q.optionsJson as never })),
  });
  return s.id;
}

async function seedMonthClose(): Promise<string> {
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const s = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: MC_REF, ownerUserId: boss.id, createdBy: boss.id } });
  const ev = (n: number) => ({ v: 1, mc: true, runId: "e2e-run", month: "2031-02-01", kind: "month_close_settlement", summary: `測試盤${n}：5 更冇結算雞頭`, suggestion: "歸 TK", confidence: "propose", action: { type: "settlement", siteId: "s", guardId: "g", count: 5 }, candidates: [{ id: "c0", label: "TK", refId: "b" }], prefillCandidateId: "c0" });
  for (let i = 1; i <= 12; i++) {
    await prisma.triageQuestion.create({ data: { sessionId: s.id, kind: "month_close_settlement", groupKey: `p13mc-${i}`, sort: i, title: `P13月結題${i}`, evidenceJson: ev(i) as never, optionsJson: [{ id: "mc_accept", label: "一撳確認" }, { id: "skip", label: "跳過" }] as never } });
  }
  return s.id;
}

async function throttle3G(page: Page) {
  const c = await page.context().newCDPSession(page);
  await c.send("Network.enable");
  // Fast 3G：1.6 Mbps 下、750 Kbps 上、RTT 150ms
  await c.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  return c;
}

test.describe("P13 要你睇手機流程", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });
  test.afterAll(async () => {
    await cleanup();
  });

  test("350 題 session：模擬 3G 首屏請求 ≤5 題、<40KB、第一題 1 秒內；舊寫法（無 take）量對照", async ({ page }) => {
    await cleanup();
    const sid = await seedGuardImport();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("triage-card-supp")).toHaveText("補充 228 題");

    const c = await throttle3G(page);
    const urls: { url: string; bytes: number }[] = [];
    page.on("response", async (r) => {
      if (r.url().includes("/api/triage/sessions/") && r.request().method() === "GET") urls.push({ url: r.url(), bytes: (await r.body().catch(() => Buffer.alloc(0))).length });
    });
    const t0 = Date.now();
    await card.getByRole("button", { name: "繼續答" }).click();
    await expect(page.getByTestId("triage-progress")).toContainText("第 1 題／共 122 題");
    await expect(page.getByTestId("triage-dialog")).toContainText("TEST PERSON 1待核對");
    const firstMs = Date.now() - t0;
    const first = urls.find((u) => u.url.includes("take="));
    expect(first, "首屏請求要帶 take").toBeTruthy();
    expect(first!.url).toContain("take=5");
    expect(first!.bytes).toBeLessThan(40_000);
    expect(urls.every((u) => u.url.includes("take="))).toBe(true);
    expect(firstMs).toBeLessThan(1000);
    // 對照：舊寫法（無 take）同一模擬 3G
    const before = await page.evaluate(async (id) => {
      const t = performance.now();
      const r = await fetch(`/api/triage/sessions/${id}?status=open`);
      const txt = await r.text();
      return { bytes: txt.length, ms: Math.round(performance.now() - t) };
    }, sid);
    console.log(`[P13 量度] before（無 take）：${before.bytes} bytes／${before.ms} ms；after（take=5）：${first!.bytes} bytes；第一題出現 ${firstMs} ms（模擬 Fast 3G）`);
    await c.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  test("上一題／返回列表／記住位置／頁數 prefetch", async ({ page }) => {
    await cleanup();
    await seedGuardImport();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const takes: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/triage/sessions/") && r.url().includes("take=")) takes.push(r.url());
    });
    const card = page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" });
    await card.getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("triage-dialog");
    await expect(dlg).toContainText("TEST PERSON 1待核對");
    await expect(page.getByTestId("triage-prev")).toHaveCount(0); // 第一題冇上一題
    // 跳過第 1、2 題（跳過 server 寫入），去到第 3 題
    await page.getByTestId("triage-skip").click();
    await expect(dlg).toContainText("TEST PERSON 2待核對");
    await page.getByTestId("triage-skip").click();
    await expect(dlg).toContainText("TEST PERSON 3待核對");
    await expect.poll(() => takes.length, { timeout: 8000 }).toBeGreaterThanOrEqual(2); // 去到第 3 題背景 prefetch 下一頁
    expect(takes.some((u) => u.includes("cursor="))).toBe(true);
    // 上一題：回看第 2 題（跳過咗，可重新答），再上一題第 1 題，下一題返
    await page.getByTestId("triage-prev").click();
    await expect(dlg).toContainText("TEST PERSON 2待核對");
    await expect(page.getByTestId("triage-progress")).toContainText("回看第 2 題");
    await expect(page.getByTestId("triage-skip")).toBeVisible(); // 跳過嘅可以重新答
    await page.getByTestId("triage-prev").click();
    await expect(dlg).toContainText("TEST PERSON 1待核對");
    await expect(page.getByTestId("triage-prev")).toBeDisabled();
    await page.getByTestId("triage-next").click();
    await page.getByTestId("triage-next").click();
    await expect(dlg).toContainText("TEST PERSON 3待核對");
    await expect(page.getByTestId("triage-next")).toHaveCount(0);
    // 返回列表：對話框關，仍喺 /triage，冇整頁重載（counts 更新：重要 120）
    await page.getByTestId("triage-later").click();
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    await expect(card.or(page.getByTestId("triage-session-card").filter({ hasText: "重要 120 題" }))).toBeVisible();
    // 記住位置：重新開由第 3 題繼續
    await page.getByTestId("triage-session-card").filter({ hasText: "重要 120 題" }).getByRole("button", { name: "繼續答" }).click();
    await expect(page.getByTestId("triage-resume")).toContainText("由第 3 題繼續");
    await expect(dlg).toContainText("TEST PERSON 3待核對");
    // 由頭開始：連跳過咗嘅一齊攞，由第 1 題
    await page.getByTestId("triage-restart").click();
    await expect(dlg).toContainText("TEST PERSON 1待核對");
    await expect(page.getByTestId("triage-progress")).toContainText(/第 1 題／共約\s?\d+ 題/);
  });

  test("重新整理後覆蓋層：UI 關得到／系統返回關得到，同一頁、唔多退一格", async ({ page }) => {
    await cleanup();
    await seedGuardImport();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const openIt = async () => page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" }).getByRole("button", { name: "繼續答" }).click();
    // (1) 開 → reload → 再開 → UI「返回列表」連撳兩次都關到
    await openIt();
    await expect(page.getByTestId("triage-dialog")).toBeVisible();
    await page.reload();
    await openIt();
    await expect(page.getByTestId("triage-dialog")).toBeVisible();
    await page.getByTestId("triage-later").click();
    await expect(page.getByTestId("triage-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    // (2) 再開 → 系統返回關到
    await openIt();
    await expect(page.getByTestId("triage-dialog")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("triage-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    // (3) 手機抽屜：開 → reload → 再開 → 撳背景關到；再開 → Esc 關到
    await page.getByTestId("mobile-nav-hamburger").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
    await page.reload();
    await page.getByTestId("mobile-nav-hamburger").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
    await page.getByTestId("mobile-nav-overlay").click({ position: { x: 360, y: 400 } });
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);
    await page.getByTestId("mobile-nav-hamburger").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    // (4) 系統返回關抽屜（reload 後）
    await page.getByTestId("mobile-nav-hamburger").click();
    await page.goBack();
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
  });

  test("返回慢（popstate 遲到 700ms）：返回列表只退一格；重新整理後唔開 overlay 直接導航，back 一次就返到原頁", async ({ page }) => {
    await cleanup();
    await seedGuardImport();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await page.evaluate(() => {
      const w = window as unknown as { __backCalls: number };
      w.__backCalls = 0;
      const orig = History.prototype.back;
      History.prototype.back = function () {
        w.__backCalls++;
        setTimeout(() => orig.call(this), 700);
      };
    });
    await page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" }).getByRole("button", { name: "繼續答" }).click();
    await page.getByTestId("triage-later").click();
    await expect(page.getByTestId("triage-dialog")).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __backCalls: number }).__backCalls)).toBe(1);
    await expect(page).toHaveURL(/\/triage$/);
    // g：開 overlay → reload → 唔開 → Link 去另一頁 → back 一次返原頁
    await page.reload();
    await page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" }).getByRole("button", { name: "繼續答" }).click();
    await expect(page.getByTestId("triage-dialog")).toBeVisible();
    await page.reload(); // 舊 entry 仲喺 history，頁面冇 overlay
    await page.getByTestId("mobile-nav-hamburger").click();
    await page.getByTestId("mnav-/guards").click();
    await expect(page).toHaveURL(/\/guards/);
    await page.goBack();
    await expect(page).toHaveURL(/\/triage$/);
  });

  test("history：對話框／Drawer／手機抽屜入 history，返回只關覆蓋層", async ({ page }) => {
    await cleanup();
    await seedGuardImport();
    await seedMonthClose();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const len0 = await page.evaluate(() => history.length);
    await page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" }).getByRole("button", { name: "繼續答" }).click();
    await expect(page.getByTestId("triage-dialog")).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
    await page.goBack();
    await expect(page.getByTestId("triage-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    // UI 關閉唔會留多餘 entry
    await page.getByTestId("triage-session-card").filter({ hasText: "重要 122 題" }).getByRole("button", { name: "繼續答" }).click();
    await page.getByTestId("triage-later").click();
    await expect(page.getByTestId("triage-dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (history.state as { zkOverlay?: string } | null)?.zkOverlay)).toBeUndefined();
    // 手機抽屜
    await page.getByTestId("mobile-nav-hamburger").click();
    await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("mobile-nav-drawer")).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
    // Drawer（/brokers 新增）＋取消
    await page.goto("/brokers");
    await page.getByRole("button", { name: /新增雞頭/ }).first().click();
    await expect(page.getByText("新增雞頭").first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/brokers$/);
    await expect(page.getByRole("heading", { name: "新增雞頭" })).toHaveCount(0);
  });

  test("月結對話框：分頁（首屏 take=5）＋返回列表＋上一題回看＋history 返回", async ({ page }) => {
    await cleanup();
    await seedMonthClose();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const reqs: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/triage/sessions/") && r.method() === "GET") reqs.push(r.url());
    });
    await page.getByTestId("triage-session-card").filter({ hasText: "一鍵結算" }).first().getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("mc-triage-dialog");
    await expect(dlg).toContainText("P13月結題1");
    expect(reqs[0]).toContain("take=5");
    await expect(page.getByTestId("mc-pos")).toHaveText("1 / 12");
    await page.getByTestId("mc-skip").click();
    await expect(dlg).toContainText("P13月結題2");
    await expect(page.getByTestId("mc-prev")).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId("mc-skip").click();
    await expect(dlg).toContainText("P13月結題3");
    await page.getByTestId("mc-prev").click();
    await expect(page.getByTestId("mc-readonly")).toContainText("P13月結題2");
    await expect(page.getByTestId("mc-readonly")).toContainText("已跳過");
    await page.getByTestId("mc-reanswer").click();
    await expect(dlg).toContainText("P13月結題2");
    // 系統返回：關對話框，仍喺 /triage
    await page.goBack();
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/triage$/);
  });

  test("手機頂欄「‹」：/ → /triage 返 /；直開深層頁去父頁；首頁冇「‹」", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/");
    await expect(page.getByTestId("mobile-nav-hamburger")).toBeVisible();
    await expect(page.getByTestId("mobile-nav-back")).toHaveCount(0);
    await page.getByTestId("mobile-nav-hamburger").click();
    await page.getByTestId("mnav-/triage").click();
    await expect(page).toHaveURL(/\/triage$/);
    await page.getByTestId("mobile-nav-back").click();
    await expect(page).toHaveURL(/\/$/);
    // 直接開深層頁（冇紀錄）→ 去父路徑
    await page.evaluate(() => sessionStorage.clear());
    await page.goto("/month-close/files");
    await page.getByTestId("mobile-nav-back").click();
    await expect(page).toHaveURL(/\/month-close(\?|$)/);
  });
});
