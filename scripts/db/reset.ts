// db:reset = 停 → 刪 .pg → 起 → migrate deploy → seed。由零成功一次過。
import fs from "node:fs";
import { execSync } from "node:child_process";
import { PG_DIR, databaseUrl } from "./lib";

function run(cmd: string, env: NodeJS.ProcessEnv = process.env) {
  console.log(`[db:reset] $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env });
}

async function main() {
  try {
    run("npm run --silent db:stop");
  } catch {
    // ignore
  }
  if (fs.existsSync(PG_DIR)) {
    console.log(`[db:reset] rm -rf ${PG_DIR}`);
    fs.rmSync(PG_DIR, { recursive: true, force: true });
  }
  run("npm run --silent db:start");

  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? databaseUrl() };
  run("npx prisma migrate deploy", env);
  run("npm run --silent db:seed", env);
  console.log("[db:reset] 完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
