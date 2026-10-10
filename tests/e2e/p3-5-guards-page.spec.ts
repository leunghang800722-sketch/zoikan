// P3-5.2：保安員名冊分頁 render——一次最多 render 100 行（DOM 節點 <5,000），「載入更多」逐頁加；搜尋照舊由 server 做。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

test.use({ viewport: { width: 1440, height: 900 } });

test("保安員名冊：首屏最多 100 行；載入更多逐頁加；DOM 節點 <5,000", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/guards");
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 30_000 });
  const total = (await (await page.request.get("/api/guards?take=1")).json()).total as number;
  const rows = main.locator("table tbody tr");
  const first = await rows.count();
  expect(first).toBeLessThanOrEqual(100);
  expect(await page.evaluate(() => document.querySelectorAll("*").length)).toBeLessThan(5000);
  if (total > 100) {
    expect(first).toBe(100);
    await expect(page.getByTestId("guards-shown-count")).toContainText(`顯示 100 / ${total}`);
    await page.getByTestId("guards-load-more").click();
    await expect(rows).toHaveCount(Math.min(200, total));
    // 全部載入後唔再有掣
    while (await page.getByTestId("guards-load-more").count()) await page.getByTestId("guards-load-more").click();
    await expect(rows).toHaveCount(total);
  } else {
    await expect(page.getByTestId("guards-load-more")).toHaveCount(0);
  }
});

test("保安員名冊：搜尋照舊由 server 做（唔受分頁 render 影響）", async ({ page }) => {
  await loginAs(page, "老闆");
  await page.goto("/guards");
  const main = page.locator("main");
  await expect(main.getByText("載入緊…")).toHaveCount(0, { timeout: 30_000 });
  // 攞最尾一位（必定喺第一頁 100 行之外，如果總數 >100）嘅姓名，搜尋應該搵得到
  const all = (await (await page.request.get("/api/guards?take=500")).json()).rows as Array<{ name_zh: string }>;
  const last = all[all.length - 1]!.name_zh;
  await main.getByPlaceholder(/姓名 \/ 工號/).fill(last);
  await expect(main.locator("table tbody tr", { hasText: last }).first()).toBeVisible({ timeout: 15_000 });
});
