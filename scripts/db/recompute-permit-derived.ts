// S5（WP-STAFFNO Opus 驗收修復）：`guards.sia_permit_expiry`／
// `sia_permit_type` 而家係 API 讀取時現算（`deriveSiaPermitExpiry()`，
// 見 src/lib/guards/staff-numbers.ts），response 唔再信呢兩個 DB 欄本身
// ——但 DB 欄仍然要盡量準確，因為 `ai.guards` view（AI 助手唯讀查詢）同
// 匯出/報表仲直接讀緊呢兩個欄，佢哋唔會行 API 嗰層嘅現算邏輯。
//
// 問題：`sia_permit_expiry`／`sia_permit_type` 淨係喺 PATCH 改咗甲／乙
// 到期日或者出生日期果一刻先會重算（見 src/app/api/guards/[id]/route.ts
// PATCH）——如果一個保安員個 DOB 已經填咗，但之後淨係時間流逝令佢滿
// 70 歲（乙類法定失效），冇人再 PATCH 過佢，DB 欄就會停留喺舊值，同
// 「而家」應該係嘅值唔一致。
//
// 呢個 script 逐個 guard 重新用 deriveSiaPermitExpiry() 計一次、寫返
// DB（值冇變就跳過，減少無謂嘅 UPDATE／audit 雜訊——呢個純粹係背景校正
// job，唔寫 audit_log，唔係用戶動作）。幂等，可以隨時重複跑。跟
// sync-permissions.ts／ensure-ai-role.ts 一致嘅容器啟動慣例（Dockerfile
// CMD 尾，`|| warn`，唔阻止部署）。
import { PrismaClient } from "@prisma/client";
import { deriveSiaPermitExpiry } from "../../src/lib/guards/staff-numbers";

const prisma = new PrismaClient();

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

async function recomputePermitDerived(): Promise<{ scanned: number; updated: number }> {
  const guards = await prisma.guard.findMany({
    select: { id: true, siaPermitAExpiry: true, siaPermitBExpiry: true, dateOfBirth: true, siaPermitExpiry: true, siaPermitType: true },
  });
  let updated = 0;
  for (const g of guards) {
    const derived = deriveSiaPermitExpiry(g);
    if (sameDate(derived.siaPermitExpiry, g.siaPermitExpiry) && derived.siaPermitType === g.siaPermitType) continue;
    await prisma.guard.update({
      where: { id: g.id },
      data: { siaPermitExpiry: derived.siaPermitExpiry, siaPermitType: derived.siaPermitType },
    });
    updated += 1;
  }
  return { scanned: guards.length, updated };
}

recomputePermitDerived()
  .then((r) => {
    console.log(`[db:recompute-permit-derived] 完成——掃描=${r.scanned} 更新=${r.updated}`);
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("[db:recompute-permit-derived] 失敗", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
