import fs from "node:fs";
import { PID_FILE } from "./lib";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("[db:stop] 冇搵到 pidfile，embedded postgres 應該冇行緊");
    return;
  }
  const pid = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
  if (!pid || !isPidAlive(pid)) {
    console.log("[db:stop] pidfile 有殘留但 process 已經唔喺度，清理返");
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return;
  }
  console.log(`[db:stop] 停緊 daemon pid ${pid} ...`);
  process.kill(pid, "SIGTERM");

  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (!isPidAlive(pid)) {
      console.log("[db:stop] 已停");
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error("[db:stop] 20 秒內未停到，可能要手動 kill");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
