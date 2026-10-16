// P1-WP3：Playwright e2e（chromium only，見 tests/e2e/）。用現成起緊
// 嘅 dev server（`.claude/launch.json` 嘅 zoikan-dev，port 3000）；冇起
// 就用 `npm run dev` 自己起（reuseExistingServer 保證唔會撞埠）。
import { defineConfig, devices } from "@playwright/test";

// 並行 worktree 各自跑 e2e 時可用 PW_PORT 換 port（預設 3000），避免撞埋同一個 dev server。
const PW_PORT = Number(process.env.PW_PORT) || 3000;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PW_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // W1：PW_SERVER_CMD 可覆寫（例：`npx next start -p 3214`＝跑 production build；預設 dev server 不變）
    command: process.env.PW_SERVER_CMD || `npm run dev -- -p ${PW_PORT}`,
    url: `http://localhost:${PW_PORT}`,
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
    // P7：e2e 唔開排程器（避免 25 號 09:00 等時間點令測試資料被自動改動）。
    env: { ...process.env, AI_LLM: "fake", SCHEDULER_ENABLED: "0" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
