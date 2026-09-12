// 呢個腳本以 detached 背景 process 執行，長開住個 embedded postgres。
// 唔好直接跑呢個檔——用 `npm run db:start` / `npm run db:stop`。
import fs from "node:fs";
import { createPg, PG_DIR, PID_FILE } from "./lib";

async function main() {
  const pg = createPg();
  const alreadyInitialised = fs.existsSync(PG_DIR) && fs.existsSync(`${PG_DIR}/PG_VERSION`);
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase(process.env.ZOIKAN_PG_DATABASE ?? "zoikan");
  } catch {
    // 已經存在，忽略
  }

  fs.writeFileSync(PID_FILE, String(process.pid));

  const cleanup = () => {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);

  // 長開住，唔好俾 process 自然完結（embedded-postgres 嘅 exit hook 會喺
  // process 收到 SIGTERM/SIGINT 時自動做 pg.stop()）
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[db:daemon] failed", err);
  process.exit(1);
});
