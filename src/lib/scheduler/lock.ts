// P7.1：PG session-level advisory lock（專用連線，唔經 Prisma 連線池——池會令 session lock 落喺唔同連線）。
// 連線斷開（process 死）lock 自動釋放。
import { Client } from "pg";

function connectionString(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL 未設定");
  try {
    const u = new URL(raw);
    // 只去掉 Prisma 專用參數；保留 sslmode 等 pg 認識嘅 query 參數
    for (const k of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout", "statement_cache_size"]) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return raw;
  }
}

/** 攞到 lock 就跑 fn 並回 { acquired: true, value }；攞唔到（另一個 instance／request 跑緊）回 { acquired: false }。 */
export async function withJobLock<T>(jobKey: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`zoikan:job:${jobKey}`]);
    if (!r.rows[0]?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`zoikan:job:${jobKey}`]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
