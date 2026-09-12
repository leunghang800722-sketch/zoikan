import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PID_FILE, PG_PORT, databaseUrl, waitForPort } from "./lib";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (fs.existsSync(PID_FILE)) {
    const pid = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
    if (pid && isPidAlive(pid)) {
      console.log(`[db:start] embedded postgres 已經喺行緊 (pid ${pid})`);
      console.log(`[db:start] DATABASE_URL=${databaseUrl()}`);
      return;
    }
    fs.unlinkSync(PID_FILE);
  }

  const tsxBin = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
  const daemonScript = path.resolve(process.cwd(), "scripts", "db", "daemon.ts");
  const logFile = path.resolve(process.cwd(), ".pg-daemon.log");
  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  console.log("[db:start] 起緊 embedded postgres（背景 daemon）...");
  const child = spawn(tsxBin, [daemonScript], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();

  const ready = await waitForPort(PG_PORT, 30000);
  if (!ready) {
    console.error(`[db:start] 30 秒內未見 postgres 開始監聽 port ${PG_PORT}，睇 ${logFile}`);
    process.exit(1);
  }
  // 俾少少時間畀 daemon 寫 pidfile / createDatabase
  await new Promise((r) => setTimeout(r, 500));
  console.log(`[db:start] 準備好。DATABASE_URL=${databaseUrl()}`);
  console.log("[db:start] 建議：export DATABASE_URL 或用 .env 存返呢個值");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
