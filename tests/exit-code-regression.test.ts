// B1（Opus 對抗式驗收第四輪）回歸 test：`npx vitest run` 有 test 紅都
// exit 0，成因係 `tests/global-setup.ts` 導入嘅 `embedded-postgres`
// 內部用 `async-exit-hook`，喺 event loop 自然 drain 嗰陣用硬編碼
// `process.exit(0)` 蓋過 vitest 自己計好嘅 exit code（詳細分析見
// tests/global-setup.ts 頂部 B1 註解）。修法係喺 globalSetup 嘅
// teardown 解除晒 async-exit-hook 嘅全部事件監聽。
//
// 呢個 test 用**獨立 nested child process**（唔係同一個 vitest worker
// 入面直接 import）重跑一次完整嘅 `tests/global-setup.ts`（起自己一個
// embedded-postgres，用唔同 port/dir 避免撞正外層已經行緊嗰個），先至
// 真係模擬到 `npx vitest run` 本身嘅完整生命週期（包括 globalSetup 嘅
// teardown 幾時觸發、event loop 幾時 drain）——淨係喺 test body 入面
// assert 啲邏輯唔夠，一定要實際跑一次先驗證得到呢個 fix 未俾人手多手
// 多改走。
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const FAIL_PROBE_FILE = path.join(REPO_ROOT, "tests", "__tmp_exit_probe_fail.test.ts");
const PASS_PROBE_FILE = path.join(REPO_ROOT, "tests", "__tmp_exit_probe_pass.test.ts");

function runNestedVitest(probeFile: string): number {
  const relPath = path.relative(REPO_ROOT, probeFile);
  try {
    execFileSync("npx", ["vitest", "run", relPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // 獨立 port/dir，唔撞外層已經行緊嗰個 embedded-postgres（見
        // tests/global-setup.ts 嘅 WP2_TEST_PG_PORT/WP2_TEST_PG_DIR）。
        WP2_TEST_PG_PORT: "54501",
        WP2_TEST_PG_DIR: ".exit-code-probe-pg",
      },
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    const e = err as { status?: number | null };
    return e.status ?? -1;
  }
}

function cleanup() {
  for (const f of [FAIL_PROBE_FILE, PASS_PROBE_FILE]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  const pgDir = path.join(REPO_ROOT, ".exit-code-probe-pg");
  if (fs.existsSync(pgDir)) fs.rmSync(pgDir, { recursive: true, force: true });
}

describe("B1：npx vitest run 嘅 exit code 一定要反映真實測試結果", () => {
  afterAll(() => {
    cleanup();
  });

  it("必紅 test 檔 → nested `npx vitest run` exit code ≠ 0（跑完自動刪走臨時檔）", () => {
    fs.writeFileSync(
      FAIL_PROBE_FILE,
      `import { describe, it, expect } from "vitest";\ndescribe("__tmp exit code probe（必紅，跑完自動刪）__", () => {\n  it("deliberately fails", () => {\n    expect(1).toBe(2);\n  });\n});\n`,
    );
    try {
      const code = runNestedVitest(FAIL_PROBE_FILE);
      expect(code).not.toBe(0);
    } finally {
      if (fs.existsSync(FAIL_PROBE_FILE)) fs.rmSync(FAIL_PROBE_FILE);
    }
  }, 60_000);

  it("全過 test 檔 → nested `npx vitest run` exit code === 0（確認 fix 冇連累正常情況）", () => {
    fs.writeFileSync(
      PASS_PROBE_FILE,
      `import { describe, it, expect } from "vitest";\ndescribe("__tmp exit code probe（全過，跑完自動刪）__", () => {\n  it("passes", () => {\n    expect(1).toBe(1);\n  });\n});\n`,
    );
    try {
      const code = runNestedVitest(PASS_PROBE_FILE);
      expect(code).toBe(0);
    } finally {
      if (fs.existsSync(PASS_PROBE_FILE)) fs.rmSync(PASS_PROBE_FILE);
    }
  }, 60_000);
});
