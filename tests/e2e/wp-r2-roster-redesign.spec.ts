// WP-R2 更表編輯器重新設計（Claude Design 1a「帳冊」，README §04/§23）
// Playwright e2e——覆蓋 R1/R2 之前冇測試過嘅新視覺互動：桌面雞頭統計卡
// 撳＝篩選、手機撳格彈底部更別鍵盤、今日／週末日期欄樣式。
//
// 舊有行為（打字／拖選／複製上月／儲存／匯出／鎖定只讀／雞頭篩選 URL）
// 已經喺 wp3.spec.ts／mobile.spec.ts 覆蓋，呢度唔重複斷言。PDPO：唔寫死
// 真名，用 DB 查出嚟嘅 id／代號比對。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, findSiteIdByName } from "./db-helpers";

const SCREENSHOT_DIR =
  "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/r2";
// WP-R2 Opus 驗收第二輪 fix——呢個檔加嘅新截圖（右鍵選單／dirty 指示／
// 手機更多選單／鍵盤唔遮格）存呢度，同舊有 (a)-(d) 果批截圖分開。
const SCREENSHOT_DIR_FIX =
  "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/r2-fix";

test.describe.configure({ mode: "serial" });

// wp3.spec.ts (a) 都會用「複製上月」幫 2026-08 填第一次資料，但兩個
// spec 檔案跑嘅次序由 Playwright 自己決定（唔一定跟 CLI 參數次序），加
// 上 dev DB 喺呢部機係跨 worktree 共用（另一個 worktree／重新 seed 隨時
// 會令 2026-08 打回未排更嘅空表）——呢個 helper 令本檔測試唔靠嗰邊個
// test 執行次序，自己出現空表就先撳「複製上月」（2026-08 嘅上一個月一
// 定係 2026-07，seed 固定有資料）先繼續斷言。
async function ensureRosterHasRows(page: Page): Promise<void> {
  const hasRow = await page
    .getByTestId("roster-row")
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  if (hasRow) return;
  await page.getByRole("button", { name: /複製上月/ }).click();
  await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
  // 「複製上月」淨係本地未儲存 state——雞頭統計卡／每日合計呢類 UI 讀
  // 伺服器持久化嘅 `records`，唔會反映到未儲存嘅本地 copy。即刻儲存一
  // 次，等呢個月喺 DB 有真資料（同時等之後（或者第時）跑呢個檔案嘅其他
  // test 唔使再靠呢個 fallback）。
  const saveBtn = page.getByRole("button", { name: /^儲存$|^儲存緊/ });
  if (await saveBtn.isEnabled().catch(() => false)) {
    await saveBtn.click();
    await expect(page.getByText(/儲存失敗|輸入有錯/)).toHaveCount(0);
    await expect(page.getByText(/格未儲存/)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
  }
}

test("(a) 桌面：雞頭統計卡撳＝篩選（行數減少 + URL 帶 broker=），再撳同一張卡＝取消篩選", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 }); // 編輯器載入完成（同 wp3.spec.ts (a) 一致嘅等法）
  await ensureRosterHasRows(page);

  const cards = page.getByTestId("broker-stats-row");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  expect(await cards.count()).toBeGreaterThanOrEqual(2);

  const initialRows = await page.getByTestId("roster-row").count();
  const code = await cards.first().getAttribute("data-broker-code");
  expect(code).toBeTruthy();

  await cards.first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBe(code);
  await expect.poll(() => page.getByTestId("roster-row").count()).toBeLessThan(initialRows);
  await expect(page.getByTestId("roster-selected-broker-total")).toBeVisible();

  // README「撳卡＝篩選該雞頭（再撳取消）」——同一張卡再撳一次要取消篩選。
  await cards.first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("broker")).toBeNull();
  await expect.poll(() => page.getByTestId("roster-row").count()).toBe(initialRows);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-roster-full.png`, fullPage: true });
});

test("(b) 桌面：今日／週末日期欄樣式（data-today/data-weekend）", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  // 「今日」用香港曆日動態計（唔寫死 2026-09-14——過咗午夜就會錯），
  // 開返今日所在月份；就算呢個盤呢個月未有更表記錄，日期表頭都照樣
  // render（唔靠 shift_records 資料）。
  const hk = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const hkGet = (t: string) => Number(hk.find((p) => p.type === t)?.value);
  const y = hkGet("year"), m = hkGet("month"), todayD = hkGet("day");
  const monthStr = `${y}-${String(m).padStart(2, "0")}`;
  await page.goto(`/roster/${siteId}/${monthStr}`);
  await expect(page.getByTestId(`roster-day-header-${todayD}`)).toBeVisible({ timeout: 20_000 });

  const todayHeader = page.getByTestId(`roster-day-header-${todayD}`);
  await expect(todayHeader).toHaveAttribute("data-today", "true");

  // 搵返今個月第一個週末（六／日）同第一個非週末嘅日數，逐個同
  // JS Date 對返嘅 UTC weekday 計算一致（唔靠寫死實際日曆）。
  let weekendDay = -1;
  let weekdayDay = -1;
  const daysInSep = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= daysInSep; d++) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const isWeekend = wd === 0 || wd === 6;
    if (isWeekend && weekendDay === -1) weekendDay = d;
    if (!isWeekend && weekdayDay === -1) weekdayDay = d;
    if (weekendDay !== -1 && weekdayDay !== -1) break;
  }
  expect(weekendDay).toBeGreaterThan(0);
  expect(weekdayDay).toBeGreaterThan(0);

  await expect(page.getByTestId(`roster-day-header-${weekendDay}`)).toHaveAttribute("data-weekend", "true");
  await expect(page.getByTestId(`roster-day-header-${weekdayDay}`)).not.toHaveAttribute("data-weekend", "true");
});

// WP-R2 Opus 驗收 fix：右鍵選單（清除所選／整行填／整行清）。
test("(f) 桌面：右鍵選單三項——整行填、整行清、清除所選", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  const cell6 = page.getByTestId("roster-cell-0-6");
  await cell6.click({ button: "right" });
  const menu = page.getByTestId("roster-context-menu");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu.getByText("清除所選", { exact: true })).toBeVisible();
  await expect(menu.getByText("整行填", { exact: true })).toBeVisible();
  await expect(menu.getByText("整行清", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR_FIX}/desktop-context-menu.png` });

  // Escape 收埋選單，唔觸發任何動作。
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // 整行填：右鍵 → 整行填 → 輸入 AL → 填滿全行 → 成行（例如第 3、20 日）都變 AL。
  await cell6.click({ button: "right" });
  await expect(page.getByTestId("roster-context-menu")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("roster-context-menu").getByText("整行填", { exact: true }).click();
  const fillInput = page.getByTestId("roster-fill-row-input");
  await fillInput.fill("AL");
  await page.getByRole("button", { name: "填滿全行" }).click();
  await expect(page.getByTestId("roster-cell-0-3")).toHaveText("AL", { timeout: 10_000 });
  await expect(page.getByTestId("roster-cell-0-20")).toHaveText("AL", { timeout: 10_000 });

  // 整行清：右鍵 → 整行清 → 成行變返空。
  await cell6.click({ button: "right" });
  await expect(page.getByTestId("roster-context-menu")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("roster-context-menu").getByText("整行清", { exact: true }).click();
  await expect(page.getByTestId("roster-cell-0-3")).toHaveText("", { timeout: 10_000 });
  await expect(page.getByTestId("roster-cell-0-20")).toHaveText("", { timeout: 10_000 });

  // 清除所選：先打一個代號入格，右鍵揀「清除所選」變返空。
  await cell6.click();
  await page.keyboard.type("SL");
  await page.keyboard.press("Enter");
  await expect(cell6).toHaveText("SL", { timeout: 10_000 });
  await cell6.click({ button: "right" });
  await expect(page.getByTestId("roster-context-menu")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("roster-context-menu").getByText("清除所選", { exact: true }).click();
  await expect(cell6).toHaveText("", { timeout: 10_000 });
});

// WP-R2 Opus 驗收 fix：拖選多格之後打字要一齊填晒（README「拖選多格一齊填」）。
test("(g) 桌面：拖選 3 格 → 打 D → Enter → 三格一齊寫入", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  const c1 = page.getByTestId("roster-cell-0-9");
  const c2 = page.getByTestId("roster-cell-0-10");
  const c3 = page.getByTestId("roster-cell-0-11");
  const b1 = await c1.boundingBox();
  const b2 = await c2.boundingBox();
  const b3 = await c3.boundingBox();
  expect(b1 && b2 && b3).toBeTruthy();

  await page.mouse.move(b1!.x + b1!.width / 2, b1!.y + b1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2!.x + b2!.width / 2, b2!.y + b2!.height / 2, { steps: 5 });
  await page.mouse.move(b3!.x + b3!.width / 2, b3!.y + b3!.height / 2, { steps: 5 });
  await page.mouse.up();

  await page.keyboard.type("D");
  await page.keyboard.press("Enter");

  await expect(c1).toHaveText("D", { timeout: 10_000 });
  await expect(c2).toHaveText("D", { timeout: 10_000 });
  await expect(c3).toHaveText("D", { timeout: 10_000 });
});

// WP-R2 Opus 驗收 fix：清空格要有 dirty 指示（喺 <td> 層，唔喺已經消失
// 咗嘅 chip 度）——量 computed box-shadow 有冇琥珀色 inset ring（P2 整合
// 驗收應修①：dirty ring 由 `#2563eb`（同選中 outline／draft 虛線撞色）
// 改咗做 `#f59e0b`）。
test("(h) 桌面：清空一個原本有代號嘅格，<td> computed box-shadow 要有 dirty inset ring", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  // 揾第一行入面一個原本已經有代號（baseline 非空）嘅格先——清空一個本身
  // 就係空嘅格，清完都仲係跟返 baseline（唔算 dirty），測唔到呢個 fix。
  const days = new Date(Date.UTC(2026, 8, 0)).getUTCDate(); // 2026-08 有幾多日
  let targetDay = -1;
  for (let d = 1; d <= days; d++) {
    const text = await page.getByTestId(`roster-cell-0-${d}`).innerText();
    if (text.trim() !== "") {
      targetDay = d;
      break;
    }
  }
  expect(targetDay).toBeGreaterThan(0);
  const cell = page.getByTestId(`roster-cell-0-${targetDay}`);
  const originalText = await cell.innerText();
  expect(originalText.trim()).not.toBe("");

  // 清空（Delete）之後格仔本身冇 chip（冇文字），但 <td> 要見到 dirty 指示。
  await cell.click();
  await page.keyboard.press("Delete");
  await expect(cell).toHaveText("", { timeout: 10_000 });
  await expect(cell).toHaveAttribute("data-dirty", "true");
  const boxShadow = await cell.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(boxShadow).toMatch(/245,\s*158,\s*11/); // #f59e0b inset ring
  await page.screenshot({ path: `${SCREENSHOT_DIR_FIX}/desktop-dirty-empty-cell.png` });
});

// WP-R2 Opus 驗收 fix：月份 ‹ › dirty guard——confirm 取消唔跳月。
test("(i) 桌面：有未儲存改動撳「下一月」→ confirm，取消唔跳，確定先跳", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  const cell = page.getByTestId("roster-cell-1-4");
  await cell.click();
  await page.keyboard.type("SL");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/格未儲存/)).toBeVisible({ timeout: 10_000 });

  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "下一月" }).click();
  await page.waitForTimeout(500);
  expect(dialogMessage).toMatch(/格未儲存/);
  expect(page.url()).toContain("/2026-08");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "下一月" }).click();
  await page.waitForURL((u) => u.pathname.endsWith("/2026-09"), { timeout: 15_000 });
});

// WP-R2 Opus 驗收 fix 第 1 項：RD／SH chip 顏色唔可以俾 isLeave 橙虛線
// 蓋過（README §04 固定配色）。
test("(j) 桌面：打 RD／SH 入格，chip computed background 係固定配色（唔係橙虛線）", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  const rdCell = page.getByTestId("roster-cell-0-17");
  await rdCell.click();
  await page.keyboard.type("RD");
  await page.keyboard.press("Enter");
  await expect(rdCell).toHaveText("RD", { timeout: 10_000 });
  const rdChip = rdCell.locator("span");
  await expect(rdChip).toHaveCSS("background-color", "rgb(241, 245, 249)");

  const shCell = page.getByTestId("roster-cell-0-18");
  await shCell.click();
  await page.keyboard.type("SH");
  await page.keyboard.press("Enter");
  await expect(shCell).toHaveText("SH", { timeout: 10_000 });
  const shChip = shCell.locator("span");
  await expect(shChip).toHaveCSS("background-color", "rgb(204, 251, 241)");
});

// P2 整合驗收①：更表有未儲存改動時，撳左欄任何連結（唔止 goMonth／
// 手機「‹」）都要有 unsaved guard——之前淨係 `goMonth`／手機頁首「‹」
// 有做（本地 `window.confirm`），`DesktopNav`／`MobileNav`／呢頁麵包屑
// 嘅 `<Link>` 冇任何攔截，撳落去會直接 client-side 跳走、改動靜靜哋
// 遺失（`beforeunload` 淨係擋得到成頁關閉，擋唔到呢種 App 內部導航）。
// 而家全部經 `GuardedLink`（`@/lib/ui/unsaved-guard` 共用 store），撳
// 左欄「首頁」應該同撳「下一月」（test (i)）一樣有 confirm。
test("(k) 桌面：更表有未儲存改動，撳左欄「首頁」→ confirm 取消唔跳，確定先跳", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");
  await page.goto(`/roster/${siteId}/2026-08`);
  await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });
  await ensureRosterHasRows(page);

  const cell = page.getByTestId("roster-cell-0-25");
  await cell.click();
  await page.keyboard.type("AL");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/格未儲存/)).toBeVisible({ timeout: 10_000 });

  const homeLink = page.locator("aside").getByRole("link", { name: "首頁", exact: true });

  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });
  await homeLink.click();
  await page.waitForTimeout(500);
  expect(dialogMessage).toMatch(/格未儲存/);
  expect(page.url()).toContain(`/roster/${siteId}/2026-08`);

  page.once("dialog", (dialog) => void dialog.accept());
  await homeLink.click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 15_000 });
});

// P2 整合驗收②：桌面（≥1024）助手面板開住時，「面板開時主內容縮窄」
// （`html[data-ai-panel="open"] main { padding-right: ... }`，見
// `globals.css`），唔再係之前個 overlay 版本遮住更表右上「儲存／還原／
// 匯出／複製上月」。用 `document.elementFromPoint()` 量「儲存」掣中心點
// 果度、DOM 樹上嘅嘢係咪個 button 本身（如果俾面板 overlay 遮住，嗰個
// 點會攞到面板嘅 DOM 元素，唔係個 button）——1280／1440 兩個桌面闊度都
// 要過。
test("(l) 桌面 1280／1440：AI 助手面板開住，「儲存」掣 elementFromPoint 係 button 本身（冇俾面板遮住）", async ({ page }) => {
  const siteId = await findSiteIdByName("啟航1331");
  await loginAs(page, "主管");

  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/roster/${siteId}/2026-08`);
    await page.waitForSelector('button:has-text("複製上月")', { timeout: 20_000 });

    const aiTab = page.getByTestId("ai-assistant-tab");
    await expect(aiTab).toBeVisible({ timeout: 20_000 });
    await aiTab.click();
    const panel = page.getByTestId("ai-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    const saveBtn = page.getByRole("button", { name: /^儲存$|^儲存緊/ });
    await expect(saveBtn).toBeVisible();
    const box = await saveBtn.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    const hitsSaveButton = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const btn = el?.closest("button");
        return !!btn && /儲存/.test(btn.textContent ?? "");
      },
      { x: cx, y: cy },
    );
    expect(hitsSaveButton).toBe(true);

    if (width === 1440) {
      await page.screenshot({
        path: "/private/tmp/claude-501/-Users-macbookpro-zoi-kan/41316f0d-3a34-4ae3-a8de-d2fb6db0b018/scratchpad/p1-fix/desktop-1440-ai-panel-open-roster.png",
      });
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR_FIX}/desktop-${width}-ai-panel-save-button.png` });

    // 收返個面板，等下個 viewport 嘅測試由乾淨狀態開始（`open` 有
    // localStorage 記住，唔關就會影響下次 `page.goto`）。
    await page.getByRole("button", { name: "關閉在勤助手" }).click();
    await expect(panel).toHaveCount(0);
  }
});

test.describe("手機（375×812）", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("(c) 撳格彈底部更別鍵盤，撳鍵寫入該格（用未鎖定嘅 2026-08）", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    // 手機頁首冇「複製上月」掣（README §23 冇呢個 action）——依賴呢個
    // describe block 之前嘅 (a) 已經幫 2026-08 確保有資料（`test.describe.
    // configure({ mode: "serial" })` 令成個檔案由上到下順序跑）。
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("roster-mobile-keypad")).toHaveCount(0);

    const cell = page.getByTestId("roster-cell-0-5");
    await cell.click();

    const keypad = page.getByTestId("roster-mobile-keypad");
    await expect(keypad).toBeVisible({ timeout: 10_000 });
    await expect(keypad.getByText(/揀更別/)).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/mobile-roster-keypad.png` });

    await keypad.getByRole("button", { name: "AL", exact: true }).click();

    await expect(keypad).toHaveCount(0);
    await expect(cell).toHaveText("AL", { timeout: 10_000 });

    // 清除：撳返個格 → 鍵盤再彈 → 撳「清除」→ 格變返空。
    await cell.click();
    await expect(keypad).toBeVisible({ timeout: 10_000 });
    await keypad.getByRole("button", { name: "清除", exact: true }).click();
    await expect(keypad).toHaveCount(0);
    await expect(cell).toHaveText("", { timeout: 10_000 });
  });

  test("(d) 鎖定月份撳格唔彈鍵盤", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    // 2026-07 已鎖定（wp3.spec.ts (d) 匯出斷言用嘅同一個盤/月）。
    await page.goto(`/roster/${siteId}/2026-07`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/已鎖定/).first()).toBeVisible();

    await page.getByTestId("roster-cell-0-5").click({ force: true });
    await expect(page.getByTestId("roster-mobile-keypad")).toHaveCount(0);
  });

  // WP-R2 Opus 驗收 fix 第 5 項：手機頁首「⋯」更多選單要有齊四個動作。
  test("(e) 手機「⋯」選單有加保安員／複製上月／匯出 Excel／還原四項", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const moreBtn = page.getByTestId("roster-mobile-more");
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();
    const menu = page.getByTestId("roster-mobile-more-menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await expect(menu.getByText("加保安員", { exact: true })).toBeVisible();
    await expect(menu.getByText(/複製上月/)).toBeVisible();
    await expect(menu.getByText(/匯出 Excel|未有更表模板/)).toBeVisible();
    await expect(menu.getByText(/還原/)).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR_FIX}/mobile-more-menu.png` });

    // 撳外面收埋。
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
  });

  // WP-R2 Opus 驗收 fix 第 9 項：手機撳近底部嘅格，鍵盤（fixed 約 143px）
  // 唔可以遮住揀咗嘅格——量 boundingBox 確認格喺鍵盤頂之上。
  test("(f) 手機撳近底部嘅格，格仔會滾去鍵盤上面，唔會俾鍵盤遮住", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const rowCount = await page.getByTestId("roster-row").count();
    const lastRowIndex = rowCount - 1;
    const cell = page.getByTestId(`roster-cell-${lastRowIndex}-28`);
    await cell.scrollIntoViewIfNeeded();
    await cell.click();

    const keypad = page.getByTestId("roster-mobile-keypad");
    await expect(keypad).toBeVisible({ timeout: 10_000 });

    const cellBox = await cell.boundingBox();
    const keypadBox = await keypad.boundingBox();
    expect(cellBox).toBeTruthy();
    expect(keypadBox).toBeTruthy();
    // 格底邊要喺鍵盤頂邊之上（容許 1px 誤差）。
    expect(cellBox!.y + cellBox!.height).toBeLessThanOrEqual(keypadBox!.y + 1);

    await page.screenshot({ path: `${SCREENSHOT_DIR_FIX}/mobile-cell-above-keypad.png` });
  });

  // P2 整合驗收應修②：compact 實體鍵盤打多字代號（SH 呢種）以前逐個
  // keystroke 即刻寫入（打「S」即刻當完整代號寫咗，跟住個「H」已經冇
  // sel 可以再寫），而家改做 buffer——打「S」先喺格入面細字顯示緊
  // 「S」（唔開 inline input，格仔本身冇變成 input），打埋「H」之後
  // 「SH」冇更長候選，即刻寫入正式 chip。
  test("(g) compact 實體鍵盤打 S→H：先見 buffer「S」，打完即刻寫入「SH」", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    const cell = page.getByTestId("roster-cell-0-26");
    await cell.click();
    await expect(page.getByTestId("roster-mobile-keypad")).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("s");
    const buffer = page.getByTestId("roster-cell-key-buffer");
    // 未夠鐘／未打埋之前，格入面顯示緊 buffer（細字），唔係已經 commit
    // 咗嘅正式 chip——`cell` 本身（`<td>`）嘅文字同 buffer testid 個
    // span 一致，都係未完成嘅 "S"。
    await expect(buffer).toHaveText("S");
    await expect(cell).toHaveText("S");

    await page.keyboard.press("h");
    await expect(cell).toHaveText("SH", { timeout: 10_000 });
    await expect(buffer).toHaveCount(0);
  });

  // 同上，補 Escape 取消 buffer（唔寫入）同埋 timeout 自動寫入呢兩個分支。
  test("(h) compact 實體鍵盤：Escape 取消 buffer；打一個字冇更長候選之後等 timeout 自動寫入", async ({ page }) => {
    const siteId = await findSiteIdByName("啟航1331");
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/2026-08`);
    await expect(page.getByTestId("roster-row").first()).toBeVisible({ timeout: 20_000 });

    // Escape 取消：打「A」（AL 嘅字首，仲有更長候選，會等）→ Escape → 格仍然空。
    const escCell = page.getByTestId("roster-cell-0-27");
    await escCell.click();
    await page.keyboard.press("a");
    await expect(page.getByTestId("roster-cell-key-buffer")).toHaveText("A");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("roster-cell-key-buffer")).toHaveCount(0);
    await expect(escCell).toHaveText("");

    // Timeout 自動寫入：打「A」（AL 字首）之後唔再打，等夠 500ms → 自動寫入「A」。
    const timeoutCell = page.getByTestId("roster-cell-0-29");
    await timeoutCell.click();
    await page.keyboard.press("a");
    await expect(page.getByTestId("roster-cell-key-buffer")).toHaveText("A");
    await expect(timeoutCell).toHaveText("A", { timeout: 3_000 });
    await expect(page.getByTestId("roster-cell-key-buffer")).toHaveCount(0);
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
