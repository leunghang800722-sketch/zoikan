// P1-WP3：Playwright e2e（chromium only，見 tests/e2e/）。用現成起緊
// 嘅 dev server（`.claude/launch.json` 嘅 zoikan-dev，port 3000）；冇起
// 就用 `npm run dev` 自己起（reuseExistingServer 保證唔會撞埠）。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
