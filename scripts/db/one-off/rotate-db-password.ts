// 一次性：真正改 PostgreSQL role 嘅密碼（Zeabur PostgreSQL 嘅
// POSTGRES_PASSWORD 環境變數只喺 volume 第一次 initdb 先用；之後改變數
// 唔會改到 DB 入面已存在嘅 role 密碼，要用 ALTER ROLE）。
//
// 用法（老闆自己喺 Terminal 行，兩個值都唔會印出嚟）：
//   read -s "DATABASE_URL?舊密碼嘅連線字串: " && export DATABASE_URL
//   read -s "NEW_DB_PASSWORD?新密碼: " && export NEW_DB_PASSWORD
//   npx tsx scripts/db/one-off/rotate-db-password.ts
//   unset DATABASE_URL NEW_DB_PASSWORD
//
// 之後喺 Zeabur PostgreSQL 服務嘅 Variables 將 POSTGRES_PASSWORD 設做同一個
// 新密碼，再 Restart **app 服務**（zoikan），令 app 攞返新密碼。
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const raw = process.env.DATABASE_URL;
  const next = process.env.NEW_DB_PASSWORD;
  if (!raw) throw new Error("DATABASE_URL 未設");
  if (!next || next.length < 16) throw new Error("NEW_DB_PASSWORD 未設或者短過 16 個字");
  if (/['\\\s]/.test(next)) throw new Error("新密碼唔准有單引號、反斜線或空格");
  const u = new URL(raw);
  const role = decodeURIComponent(u.username || "root");
  console.log(`目標 DB：${u.hostname}:${u.port || "5432"}${u.pathname}，role=${role}`);
  await prisma.$queryRaw`SELECT 1`;
  console.log("舊密碼連線成功。");
  await prisma.$executeRawUnsafe(`ALTER ROLE "${role.replace(/"/g, '""')}" WITH PASSWORD '${next}'`);
  console.log("ALTER ROLE 完成——DB 密碼已改做新密碼。");
  console.log("下一步：Zeabur PostgreSQL Variables 嘅 POSTGRES_PASSWORD 設做同一個新密碼，然後 Restart app 服務（zoikan）。");
}

main()
  .catch((e) => {
    console.error("失敗：", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
