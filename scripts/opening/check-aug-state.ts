// 唯讀：數吓目標 DB（DATABASE_URL）而家有幾多盤／更種／價目卡／安員，同
// 8 月開盤 script 寫過幾多行（createdBy='system:aug-opening'）。用嚟喺
// --apply 失敗之後確認 transaction 真係 rollback 咗（應該全部 0），或者
// apply 成功之後對返 plan 數目。唔寫任何嘢、唔印個人資料。
//   DATABASE_URL='<正式站>' npx tsx scripts/opening/check-aug-state.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function dbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "（DATABASE_URL 未設，用 .env）";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "（DATABASE_URL 格式讀唔到）";
  }
}

async function main() {
  console.log(`目標 DB：${dbTarget()}`);
  const BY = "system:aug-opening";
  const [sites, shiftTypes, rateCards, guards, sitesBy, shiftTypesBy, rateCardsBy, guardsBy, closedJuly, auditBy] = await Promise.all([
    prisma.site.count(),
    prisma.shiftType.count({ where: { voidedAt: null } }),
    prisma.rateCard.count({ where: { voidedAt: null } }),
    prisma.guard.count(),
    prisma.site.count({ where: { createdBy: BY } }),
    prisma.shiftType.count({ where: { createdBy: BY } }),
    prisma.rateCard.count({ where: { createdBy: BY } }),
    prisma.guard.count({ where: { createdBy: BY } }),
    prisma.rateCard.count({ where: { effectiveTo: new Date("2026-07-31T00:00:00Z"), voidedAt: null } }),
    prisma.auditLog.count({ where: { actorUserId: null, tableName: { in: ["sites", "shift_types", "rate_cards", "guards"] }, createdAt: { gte: new Date("2026-09-24T00:00:00Z") } } }),
  ]);
  const augCards = await prisma.rateCard.count({ where: { effectiveFrom: new Date("2026-08-01T00:00:00Z"), voidedAt: null } });
  console.log(`盤 ${sites}（開盤 script 建：${sitesBy}）`);
  console.log(`更種 ${shiftTypes}（開盤 script 建：${shiftTypesBy}）`);
  console.log(`價目卡 ${rateCards}（開盤 script 建：${rateCardsBy}；8 月 1 日生效：${augCards}；7 月 31 日到期：${closedJuly}）`);
  console.log(`安員 ${guards}（開盤 script 建：${guardsBy}）`);
  console.log(`9 月 24 日起 system 對四張表嘅 audit：${auditBy}`);
  const written = sitesBy + shiftTypesBy + rateCardsBy + guardsBy;
  console.log(written === 0 ? "結論：開盤 script 未寫入任何嘢（rollback 乾淨／未套用）。" : `結論：開盤 script 已寫入 ${written} 行。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
