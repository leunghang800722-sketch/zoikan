// WP-AI1：AI 助手專用嘅**獨立**唯讀 DB 連線——用 `pg` 嘅 `Pool`，連
// `AI_DATABASE_URL`（`zoikan_ai_ro` 呢個角色，見
// scripts/db/ensure-ai-role.ts）。全程唔用 `@/lib/db`（Prisma 寫入客戶端
// ——即使查詢入面淨係 SELECT，都唔可以借用嗰條連線，因為嗰個角色本身有
// 全表寫入權，"連線本身" 就唔係一個可以放喺 AI 工具旁邊嘅安全邊界）。
//
// 唯讀保證嘅四層（由外到入）：
//   1. `zoikan_ai_ro` 呢個 Postgres 角色本身淨係有 USAGE ON SCHEMA ai +
//      SELECT ON ai.*（冇任何 public schema 權限，冇 INSERT/UPDATE/
//      DELETE/CREATE/TRUNCATE），`default_transaction_read_only=on`、
//      `search_path=ai`、`statement_timeout=5s`（DB 角色層設定）。
//   2. `ai.*` 係 view（唔係 base table），底層 `public.*` 表嘅敏感欄
//      （tel/bank_info/password_hash/otp_secret）喺 view 定義層已經冚咗
//      （見 prisma/migrations/20260912130100_wp_ai1_readonly_schema）。
//   3. 呢個 Pool 自己都設 `statement_timeout`／`query_timeout`（雙重，
//      唔淨係靠角色設定）。
//   4. `src/lib/ai/tools/sql-select.ts` 嘅 tokenizer 再喺 application
//      層擋 DML/DDL 關鍵字＋`public.`/`pg_catalog`/`information_schema`。
import { Pool, type QueryResult, type QueryResultRow } from "pg";

let pool: Pool | undefined;

class AiDbNotConfiguredError extends Error {
  constructor() {
    super("AI_DATABASE_URL 未設定——AI 助手嘅唯讀 DB 連線未開通");
    this.name = "AiDbNotConfiguredError";
  }
}

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.AI_DATABASE_URL;
  if (!connectionString) throw new AiDbNotConfiguredError();
  pool = new Pool({
    connectionString,
    max: 5,
    statement_timeout: 5000, // 毫秒，同 DB 角色設定嘅 5s 一致，雙重保證
    query_timeout: 5000,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  return pool;
}

/** 淨係俾 tests 用——重置 pool 單例（換 AI_DATABASE_URL 之後重新連）。 */
export function resetAiDbPoolForTests(): void {
  if (pool) void pool.end();
  pool = undefined;
}

export async function aiQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const p = getPool();
  return p.query<T>(sql, params);
}
