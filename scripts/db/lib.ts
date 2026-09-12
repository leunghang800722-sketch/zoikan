// 呢個 Mac 冇 Postgres 冇 Docker，唔裝系統軟件——本機資料庫用 embedded-postgres（npm）。
// 見 P1-執行計劃.md §2。
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export const PG_DIR = process.env.ZOIKAN_PG_DIR ?? path.resolve(process.cwd(), ".pg");
export const PG_PORT = Number(process.env.PGPORT ?? 54329);
export const PG_USER = "postgres";
export const PG_PASSWORD = "postgres";
export const PG_DATABASE = process.env.ZOIKAN_PG_DATABASE ?? "zoikan";
export const PID_FILE = path.resolve(process.cwd(), ".pg-daemon.pid");

export function createPg(overrides: Partial<ConstructorParameters<typeof EmbeddedPostgres>[0]> = {}) {
  return new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
    onLog: () => {}, // 靜音；有需要 debug 時改返 console.log
    onError: console.error,
    ...overrides,
  });
}

export function databaseUrl(db: string = PG_DATABASE, port: number = PG_PORT) {
  return `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${db}`;
}

export async function waitForPort(port: number, timeoutMs = 20000) {
  const net = await import("node:net");
  const start = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}
