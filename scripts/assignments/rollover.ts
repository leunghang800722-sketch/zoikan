// S6（Opus 對抗式驗收）：`npm run assignments:rollover -- 2026-08`——複製
// 上一個月嘅 broker_site_assignments 落新一個月（雞頭配額冇改嘅話，通常
// 每個月都係跟返上個月，等主管唔使逐個月手動重新輸入白名單）。
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function prevMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("用法: npm run assignments:rollover -- 2026-08");
    process.exit(1);
  }
  const targetMonth = monthStart(new Date(arg));
  if (Number.isNaN(targetMonth.getTime())) {
    console.error(`month 格式唔啱: ${arg}`);
    process.exit(1);
  }
  const sourceMonth = prevMonth(targetMonth);

  const sourceRows = await prisma.brokerSiteAssignment.findMany({ where: { month: sourceMonth } });
  console.log(`[assignments:rollover] ${sourceMonth.toISOString().slice(0, 7)} 有 ${sourceRows.length} 行，複製去 ${targetMonth.toISOString().slice(0, 7)}...`);

  let created = 0;
  let skipped = 0;
  for (const row of sourceRows) {
    const existing = await prisma.brokerSiteAssignment.findUnique({
      where: { brokerId_siteId_month: { brokerId: row.brokerId, siteId: row.siteId, month: targetMonth } },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.brokerSiteAssignment.create({
      data: { brokerId: row.brokerId, siteId: row.siteId, month: targetMonth, createdBy: `script:assignments-rollover-from-${sourceMonth.toISOString().slice(0, 7)}` },
    });
    created++;
  }
  console.log(`[assignments:rollover] 完成：新增 ${created} 行，已存在跳過 ${skipped} 行。`);
}

main()
  .catch((err) => {
    console.error("[assignments:rollover] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
