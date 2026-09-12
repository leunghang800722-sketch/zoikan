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
    // WP-AI2：`tests/e2e/ai.spec.ts` 側欄 AI 助手 e2e 唔打真 AI Hub——
    // `AI_LLM=fake` 令 `src/lib/ai/llm.ts` 嘅 `getLlmClient()` 回一個假
    // client（見嗰個檔案嘅註解，零工具調用、固定廣東話回覆，唔削弱
    // guard／權限）。`reuseExistingServer: true` 之下，如果開發者自己已經
    // 起緊一個冇呢個 env 嘅 dev server（例如手動 `npm run dev` 想連真
    // AI Hub 人手試），Playwright 會沿用嗰個現有 server——AI 相關場景會
    // 打真 AI Hub（有 key 先works），呢個係已知限制，需要嘅話重啟一個
    // 由呢度帶住 `AI_LLM=fake` 起嘅 server。
    env: { ...process.env, AI_LLM: "fake" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
