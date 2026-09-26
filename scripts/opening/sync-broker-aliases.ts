// 驗收（Opus 5.5，2026-09-26）：將 private 檔 `data/mappings-private/
// brokers.csv` 嘅雞頭稱呼（canonical_name／aliases／master_roster_aliases，
// 即 Postorder 總表「(n) xx」／「長工雞頭費 (xx)」用嘅稱呼）同步入目標 DB
// 嘅 `brokers.aliases`（按 code 對，淨係加唔刪，冪等，audit）。
//
// 點解要：WP-LTSHIFT §19 第二部分淨係喺 seed 補咗呢批別名，已上線 DB 冇；
// 呢批稱呼可能係真名，唔可以寫入 migration／git——所以做成本機 script，
// 老闆喺正式站 §19 流程開始前跑一次（同 run-guard-fix.sh 一樣貼連線字串）。
//
// 用法：DATABASE_URL=... npx tsx scripts/opening/sync-broker-aliases.ts        （淨係印數目）
//       DATABASE_URL=... npx tsx scripts/opening/sync-broker-aliases.ts --apply
// 輸出淨係 code＋數目，唔印稱呼本身。
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { readCsv } from "../seed/lib/csv";

const APPLY = process.argv.includes("--apply");
const CSV = path.resolve(process.cwd(), "data/mappings-private/brokers.csv");
const prisma = new PrismaClient();

type Row = { code?: string; canonical_name?: string; aliases?: string; master_roster_aliases?: string };

async function main() {
  if (!fs.existsSync(CSV)) throw new Error("搵唔到 data/mappings-private/brokers.csv——停（冇私隱檔就冇嘢好同步）");
  const rows = readCsv<Row>(CSV);
  let changed = 0;
  for (const r of rows) {
    const code = (r.code ?? "").trim();
    if (!code) continue;
    const wanted = [r.canonical_name ?? "", ...(r.aliases ?? "").split(";"), ...(r.master_roster_aliases ?? "").split(";")].map((s) => s.trim()).filter((s) => s && s !== code);
    const broker = await prisma.broker.findUnique({ where: { code }, select: { id: true, aliases: true } });
    if (!broker) {
      console.log(`[sync-broker-aliases] ${code}：目標 DB 冇呢個雞頭，跳過`);
      continue;
    }
    const add = [...new Set(wanted)].filter((a) => !broker.aliases.includes(a));
    if (add.length === 0) continue;
    changed += 1;
    console.log(`[sync-broker-aliases] ${code}：加 ${add.length} 個稱呼${APPLY ? "" : "（--plan，未寫）"}`);
    if (!APPLY) continue;
    await prisma.$transaction(async (tx) => {
      await tx.broker.update({ where: { id: broker.id }, data: { aliases: [...broker.aliases, ...add] } });
      await tx.auditLog.create({
        data: { actorUserId: null, tableName: "brokers", rowId: broker.id, action: "update", after: { id: broker.id, aliasesAdded: add.length, source: "sync-broker-aliases" } },
      });
    });
  }
  console.log(`[sync-broker-aliases] ${changed} 個雞頭${APPLY ? "已更新" : "要更新（加 --apply 先寫）"}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
