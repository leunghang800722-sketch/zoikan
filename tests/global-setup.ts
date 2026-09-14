// Vitest globalSetup：起一個獨立、臨時嘅 embedded-postgres（同 npm run
// db:start 嘅開發用資料庫完全分開，用完即棄），跑晒 migration，畀
// tests/*.test.ts 用。全部 fixture 用假數據——唔會掂到 tools/importer/out/
// 或 data/ 嘅真實 7 月數據（PDPO）。
import path from "node:path";
import { execSync } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
// B1（Opus 對抗式驗收第四輪）：`embedded-postgres` 內部用
// `async-exit-hook`（module import 嗰陣就全局註冊，見 node_modules/
// embedded-postgres/dist/index.js 尾嗰句 `AsyncExitHook(gracefulShutdown)`）
// 幫手喺 process 退出前清埋啲 postgres 進程。但 `async-exit-hook@2.0.1`
// 註冊 `beforeExit` 事件嗰陣硬編碼咗 exit code = 0（`add.hookEvent
// ('beforeExit', 0)`），一旦事件循環自然 drain（例如 `npx vitest run`
// 全部 test 跑完之後），佢就會用 `process.exit(0)` 蓋過 vitest 自己計
// 好嘅 exit code——即使有 test 紅，`npx vitest run`／`npm test` 都會
// 報 exit 0，CI gate 形同虛設（已實測重現：故意整一個必紅 test，
// `npx vitest run` 都係 exit 0；抽走呢個 workaround 就會見到）。
// 呢個係 `async-exit-hook` 呢個套件本身嘅設計缺陷／bug，唔係我哋段碼
// 嘅邏輯錯——我哋自己喺 teardown 手動 `pg.stop()` 之後，已經冇需要
// 佢嗰個全局 exit-hook 再介入，所以喺 teardown 尾解除晒佢註冊嘅全部
// 事件監聽（保留單一 unhookEvent("beforeExit") 會令 async-exit-hook
// 內部 state 唔一致，喺 `exit` 事件嗰陣拋 `done is not a function`
// 嘅 unhandled rejection 噪音——雖然唔會再影響 exit code，但成批解除
// 先乾淨）。
import AsyncExitHook from "async-exit-hook";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedRolesPermissionsMatrix } from "../src/lib/rbac/seed";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { TEST_USER_SLOTS, TEST_USER_TEL, TEST_USER_PASSWORD, roleNameForSlot } from "./fixtures/test-users";

// port/dir 可以由環境變數覆蓋——`tests/exit-code-regression.test.ts` 要
// 喺一個已經行緊嘅 vitest run（已經佔用咗預設 port/dir）入面，用 child
// process 再起一個獨立嘅 nested `npx vitest run` 去重現/驗證 B1 個 exit
// code bug 修法，兩個 embedded-postgres 唔可以撞同一個 port/dir。
const PG_DIR = path.resolve(process.cwd(), process.env.WP2_TEST_PG_DIR || ".pg-test");
const PORT = Number(process.env.WP2_TEST_PG_PORT) || 54399;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/zoikan_test`;

export default async function setup() {
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false, // 完咗自動刪走 .pg-test/
    onLog: () => {},
    onError: console.error,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("zoikan_test");

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL },
  });

  process.env.DATABASE_URL = DATABASE_URL;
  // P1-WP2：session cookie 加密密碼，測試用固定值（≥32 字符），唔係真密碼。
  process.env.SESSION_SECRET = "test-only-session-secret-do-not-use-in-prod-xyz";

  // 2026-09-15：AI 助手嘅唯讀 pool（`src/lib/ai/db.ts`）讀 `AI_DATABASE_URL`——
  // 以前冇喺呢度設，worker 見唔到（.env 唔會自動入 process.env），AI 工具 test
  // 要靠環境碰巧先過，而且就算有都係打 dev DB 而唔係 fixture。而家喺
  // zoikan_test 建返 `zoikan_ai_ro` 角色（同正式站 ensure-ai-role 同一段
  // code，只 SELECT `ai` schema、read-only session）並指過去，AI 工具 test
  // 全部查 fixture 數據。密碼係測試用固定值，唔係任何真環境嘅密碼。
  const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";
  await ensureAiRole({ databaseUrl: DATABASE_URL, password: TEST_AI_PASSWORD });
  const aiUrl = new URL(DATABASE_URL);
  aiUrl.username = AI_RO_ROLE;
  aiUrl.password = TEST_AI_PASSWORD;
  process.env.AI_DATABASE_URL = aiUrl.toString();

  // P1-WP2：RBAC 矩陣（roles/permissions/role_permissions）+ 6 個固定假
  // 測試帳號，成個 test run 淨係種一次（唔喺 clearAll() 度刪）——原因見
  // tests/lib/db.ts clearAll() 頂嘅註解：audit_log 真係 append-only，一個
  // 用戶寫過一條 audit_log 之後就冇得再刪，所以 users/roles/permissions
  // 呢幾樣嘢要成個 run 淨係種一次，每個 test 淨係改業務資料（brokers/
  // sites/guards/…），需要邊個角色嘅 session 就用
  // tests/fixtures/test-users.ts 嘅 TEST_USER_TEL 查返個固定用戶。
  const prisma = new PrismaClient();
  try {
    const { roleIds } = await seedRolesPermissionsMatrix(prisma, "test-global-setup:wp2");
    const passwordHash = await bcrypt.hash(TEST_USER_PASSWORD, 4); // 測試用低 cost，加快速度
    for (const slot of TEST_USER_SLOTS) {
      await prisma.user.create({
        data: {
          name: `測試${slot}`,
          tel: TEST_USER_TEL[slot],
          passwordHash,
          roleId: roleIds[roleNameForSlot(slot)],
          createdBy: "test-global-setup:wp2",
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  return async () => {
    await pg.stop();
    // 見頂部 B1 註解：`pg.stop()` 已經做齊真正嘅清理，解除
    // async-exit-hook 全部事件監聽，等 Node 行返預設（尊重
    // `process.exitCode`）嘅退出路徑，唔畀佢嗰個硬編碼 exit(0) 蓋過
    // vitest 嘅真實測試結果。
    for (const ev of AsyncExitHook.hookedEvents()) AsyncExitHook.unhookEvent(ev);
  };
}
