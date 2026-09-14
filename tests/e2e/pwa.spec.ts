// 老闆 2026-09-15：手機「加到主畫面」要出 MSG Security 盾牌 icon，唔係瀏覽器
// 預設灰底「Z」。呢度斷言：manifest 未登入都攞到（瀏覽器抓 manifest 唔會帶
// 登入 cookie 之外嘅權限）、icon 檔全部 200、登入頁有 <link rel="manifest">
// 同 apple-touch-icon。
import { test, expect } from "@playwright/test";

test("(a) /manifest.webmanifest 未登入 200，含 192／512 any＋maskable icon，name 在勤", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m.name).toBe("在勤");
  expect(m.display).toBe("standalone");
  const srcs = m.icons.map((i: { src: string; purpose?: string; sizes: string }) => `${i.src}|${i.sizes}|${i.purpose}`);
  expect(srcs).toEqual(expect.arrayContaining(["/icons/icon-192.png|192x192|any", "/icons/icon-512.png|512x512|any", "/icons/icon-maskable-512.png|512x512|maskable"]));
  for (const i of m.icons) {
    const r = await request.get(i.src);
    expect(r.status(), i.src).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
});

test("(b) apple-touch-icon／favicon 200；登入頁 head 有 manifest 同 apple-touch-icon link", async ({ page, request }) => {
  expect((await request.get("/icons/apple-touch-icon.png")).status()).toBe(200);
  expect((await request.get("/favicon.ico")).status()).toBe(200);
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#1c1917");
});
