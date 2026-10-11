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

/**
 * 攞到 lock 就跑 fn 並回 { acquired: true, value }；攞唔到（另一個 instance／request 跑緊）回 { acquired: false }。
 * fn 可以呼叫 `hold(promise)`：lock 會一直持有到該 promise settle 先釋放（用於 job 逾時——
 * 排程唔再等，但底層 job 仲跑緊，期間唔准再開第二個）。冇 hold 就喺 fn 返回時釋放。
 */
export async function withJobLock<T>(jobKey: string, fn: (hold: (p: Promise<unknown>) => void) => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  const cleanup = async () => {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`zoikan:job:${jobKey}`]).catch(() => undefined);
    await client.end().catch(() => undefined);
  };
  let held: Promise<unknown> | null = null;
  try {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`zoikan:job:${jobKey}`]);
    if (!r.rows[0]?.ok) {
      await client.end().catch(() => undefined);
      return { acquired: false };
    }
    const value = await fn((p) => {
      held = p;
    });
    if (held) void (held as Promise<unknown>).then(() => undefined, () => undefined).then(cleanup);
    else await cleanup();
    return { acquired: true, value };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
