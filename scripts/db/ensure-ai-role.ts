// WP-AI1：建立（或者幂等地更新）一個**淨係得 SELECT**嘅 Postgres 登入角色
// `zoikan_ai_ro`，畀 AI 助手嘅查詢連線用（`src/lib/ai/db.ts`）。呢個角色
// 淨係 GRANT USAGE ON SCHEMA ai + SELECT ON ai.* view（唔會有任何 public
// schema 權限，亦冇 INSERT/UPDATE/DELETE/CREATE 任何寫入權），DB 級保證
// 「AI 助手架構上做唔到任何寫入」——唔淨係靠應用層 code review。
//
// 用主連線（`DATABASE_URL`，通常係 postgres superuser）執行 DDL——`pg`
// 呢個 package（`embedded-postgres` 本身依賴緊，已經喺 node_modules）,
// 唔用 `@/lib/db`（Prisma 寫入客戶端，AI 呢一側全程唔可以掂佢，見
// tests/ai-structural-guard.test.ts）。
//
// 幂等：可以喺 Dockerfile CMD、`npm run db:reset`、開發機重複執行，唔會
// 因為角色/grant 已經存在而報錯。
//
// AI_DB_PASSWORD 冇設——跳過並 warn（唔中止部署；冇呢粒 env 嘅環境代表
// AI 助手功能未開通，唔應該阻住其他一切正常運作嘅部署流程）。
import "dotenv/config";
import { Client } from "pg";

export const AI_RO_ROLE = "zoikan_ai_ro";

function quoteLiteral(s: string): string {
  // 密碼經 quote_literal 風格逐字轉義（單引號兩粒），呢度用最簡單嘅
  // 手動轉義——密碼嚟自 env（受控輸入），唔係用戶輸入，唔需要成套 SQL
  // injection 防禦，但都係轉義好過連埋唔轉義。
  return `'${s.replace(/'/g, "''")}'`;
}

/** 抽出嚟做獨立可測試嘅函數——`tests/ai-ro-connection.test.ts`（真 DB
 * 攻擊測試）直接 call 呢個，唔使 shell out 起 child process。CLI 入口
 * （下面 `main()`）淨係負責由 env 讀 password/databaseUrl 再 call 呢個。 */
export async function ensureAiRole(opts: { databaseUrl: string; password: string }): Promise<void> {
  const { databaseUrl, password } = opts;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [AI_RO_ROLE]);
    if (rows.length === 0) {
      console.log(`[db:ensure-ai-role] 建立角色 ${AI_RO_ROLE}`);
      await client.query(`CREATE ROLE ${AI_RO_ROLE} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      console.log(`[db:ensure-ai-role] 角色 ${AI_RO_ROLE} 已存在，更新密碼`);
      await client.query(`ALTER ROLE ${AI_RO_ROLE} LOGIN PASSWORD ${quoteLiteral(password)}`);
    }

    // 淨係 USAGE + SELECT ON ai.* ——冇任何其他 grant。
    await client.query(`GRANT USAGE ON SCHEMA ai TO ${AI_RO_ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ai TO ${AI_RO_ROLE}`);
    // 之後新加嘅 ai.* view（由 owner 建立，即跑 migration 嗰個主連線用戶）
    // 都自動有呢個 SELECT，唔使每次加 view 都手動再 grant 一次。
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT SELECT ON TABLES TO ${AI_RO_ROLE}`);

    // 呢個角色嘅 session 一律：唯讀 transaction、5 秒 statement timeout、
    // search_path 鎖死喺 ai（連寫 "SELECT * FROM sites" 都會行去 ai.sites
    // 唔係 public.sites——src/lib/ai/tools/sql-select.ts 仲會喺 code 層再
    // 明文拒絕 `public.`/`pg_catalog`/`information_schema`，呢度係第一重）。
    await client.query(`ALTER ROLE ${AI_RO_ROLE} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${AI_RO_ROLE} SET statement_timeout = '5s'`);
    await client.query(`ALTER ROLE ${AI_RO_ROLE} SET search_path = ai`);

    console.log(`[db:ensure-ai-role] 完成——${AI_RO_ROLE} 淨係有 USAGE ON SCHEMA ai + SELECT ON ai.*，冇任何其他權限。`);
  } finally {
    await client.end();
  }
}

async function main() {
  const password = process.env.AI_DB_PASSWORD;
  if (!password) {
    console.warn(
      "[db:ensure-ai-role] 冇設 AI_DB_PASSWORD，跳過建立/更新 zoikan_ai_ro 呢個角色——AI 助手功能喺呢個環境未開通（唔中止）。",
    );
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("[db:ensure-ai-role] 冇設 DATABASE_URL，冇辦法連主連線執行 DDL");
  }

  await ensureAiRole({ databaseUrl, password });
  console.log(`[db:ensure-ai-role] 完成——${AI_RO_ROLE} 淨係有 USAGE ON SCHEMA ai + SELECT ON ai.*，冇任何其他權限。`);
}

// 淨係直接 `tsx scripts/db/ensure-ai-role.ts` 執行嗰陣先跑 main()——俾
// tests import `ensureAiRole` 唔會意外觸發 CLI 行為（例如冇
// AI_DB_PASSWORD 就靜靜哋 return，測試想要嘅係明確傳參數嗰個版本）。
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[db:ensure-ai-role]", err);
    process.exit(1);
  });
}
