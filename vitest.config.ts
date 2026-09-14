import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 同 tsconfig.json 嘅 "@/*" -> "./src/*" 對齊，等 test file 可以直接
    // import route handler／lib（P1-WP2：integration test 直接調用 App
    // Router route handler，唔起真 Next server）。
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false, // 全部 test file 共用同一個 embedded postgres，唔可以並行
    // P1-WP3：`tests/e2e/*.spec.ts` 係 Playwright（`npx playwright test`
    // 跑，見 playwright.config.ts），唔係 Vitest——`*.spec.ts` 呢個命名
    // 岩巧撞正 Vitest 預設嘅 test file pattern，要明確排除，否則 Vitest
    // 會嘗試收集 Playwright 嘅 `test.describe`/`test()` 全局函數，成個
    // test file 爆錯。
    // R1 驗收修正：`.claude/worktrees/**` 係其他 agent 平行開嘅 git
    // worktree（各自 checkout 一份完整 repo 副本，包括 tests/ 同呢個
    // vitest config 自己）——冇呢條 exclude，喺主工作樹跑 `vitest run`
    // 會撈埋人哋 worktree 入面嗰份 test 副本一齊跑（同一條 test 跑兩
    // 次、甚至撞另一個 agent 改緊一半嘅檔案）。
    exclude: ["**/node_modules/**", "tests/e2e/**", ".claude/**"],
  },
});
