// P8 驗收 M1：startup 冪等建立排程系統帳號（見 src/lib/system-user.ts）。同 ensure-ai-role 一樣放 Dockerfile CMD，失敗只 warn。
import "dotenv/config";
import { ensureSystemUser } from "../../src/lib/system-user";
import { prisma } from "../../src/lib/db";

async function main() {
  const id = await ensureSystemUser();
  console.log(`[db:ensure-system-user] 系統排程帳號就緒（id ${id.slice(0, 8)}…，inactive，唔可登入）`);
}
main()
  .catch((e) => {
    console.error("[db:ensure-system-user] 失敗：", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
