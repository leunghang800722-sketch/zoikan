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
// DB（值冇變就跳過，減少無謂嘅 UPDATE／audit 雜訊）。幂等，可以隨時
// 重複跑。跟 sync-permissions.ts／ensure-ai-role.ts 一致嘅容器啟動慣例
// （Dockerfile CMD 尾，`|| warn`，唔阻止部署）。
//
// 必修 1(b)(c)（Opus 驗收第二輪）：呢個 script 硬性規定「永遠唔准將非
// null 寫成 null」，除非 a／b 至少一個有值而現算結果真係 null（即乙類
// 過 70 歲而冇甲類）——所以：
//   - a／b 兩個都 null 嘅 guard（migration backfill 唔到、或者人手都未
//     補嘅舊資料，見 prisma/migrations/20260919064514_wp_staffno/
//     migration.sql「(1)」大註解）——一律保留 DB 原值，唔覆蓋、唔寫，
//     完全跳過（`deriveSiaPermitExpiry()` 呢種情況一定計出
//     {null,null}，寫落去等於將舊 `sia_permit_expiry` 永久毀走）。
//   - a／b 其中一個有值——先有足夠資訊做合法重算（包括「乙類滿 70 歲
//     失效、冇甲類」呢種現算結果真係 null 嘅合法轉變），先允許寫
//     入，而且**任何更新都寫一條 audit_log**（`action=
//     "recompute_permit_derived"`，before/after 淨係存衍生值，唔係完整
//     row，見 src/lib/audit.ts），唔再靜默。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../../src/lib/db";
import { deriveSiaPermitExpiry, canOverrideDerivedSiaPermit } from "../../src/lib/guards/staff-numbers";
import { writeAudit } from "../../src/lib/audit";

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

// 必修 1(c)：`export` 呢個函數（原本冇 export，淨係底下即刻自己執行）——
// 等 test（tests/wp-staffno.test.ts）可以直接 import 呢個函數逐粒斷言
// 佢嘅安全閥／audit_log 行為，唔使另外重抄一份邏輯做 synthetic test
// （同 migration.sql 嗰種「冇得直接 import」唔同，呢個純粹係一個 TS
// 函數，可以直接 import）。底下 `isMain` guard 保證 test import 呢個
// 檔案唔會觸發自動執行——跟 scripts/db/ensure-ai-role.ts 一致嘅寫法。
export async function recomputePermitDerived(): Promise<{ scanned: number; updated: number; skippedBothNull: number }> {
  const guards = await prisma.guard.findMany({
    select: { id: true, siaPermitAExpiry: true, siaPermitBExpiry: true, dateOfBirth: true, siaPermitExpiry: true, siaPermitType: true },
  });
  let updated = 0;
  let skippedBothNull = 0;
  for (const g of guards) {
    // 必修 1(b)（Opus 驗收第二輪）／必修 1（第三輪，改用共用嘅
    // `canOverrideDerivedSiaPermit()`——見 src/lib/guards/staff-numbers.ts
    // 大註解，PATCH 寫入層／讀取層三處共用同一份判斷，避免漏咗一層）：
    // 安全閥——a／b 都 null，一律保留 DB 原值，唔計、唔寫。呢個 script
    // 冇「之前」概念（`hadValueBefore` default false），同讀取層一致。
    if (!canOverrideDerivedSiaPermit({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry })) {
      skippedBothNull += 1;
      continue;
    }
    const derived = deriveSiaPermitExpiry(g);
    if (sameDate(derived.siaPermitExpiry, g.siaPermitExpiry) && derived.siaPermitType === g.siaPermitType) continue;
    const before = { sia_permit_expiry: g.siaPermitExpiry, sia_permit_type: g.siaPermitType };
    await prisma.guard.update({
      where: { id: g.id },
      data: { siaPermitExpiry: derived.siaPermitExpiry, siaPermitType: derived.siaPermitType },
    });
    const after = { sia_permit_expiry: derived.siaPermitExpiry, sia_permit_type: derived.siaPermitType };
    // 必修 1(c)：任何更新都寫 audit_log，唔再靜默（包括合法嘅
    // 非null→null 轉變，例如乙類啱啱滿 70 歲、冇甲類）。
    await writeAudit({ actorUserId: null, tableName: "guards", rowId: g.id, action: "recompute_permit_derived", before, after });
    updated += 1;
  }
  return { scanned: guards.length, updated, skippedBothNull };
}

// 淨係直接 `tsx scripts/db/recompute-permit-derived.ts` 執行嗰陣先跑，
// 俾 test import `recomputePermitDerived` 唔會意外觸發 CLI 行為。
// 必修 5（Opus 驗收第三輪）：原本 `` `file://${process.argv[1]}` ``
// 呢種寫法喺 `process.argv[1]` 本身帶特殊字符（例如 Windows 路徑、空
// 格）或者唔係絕對路徑嗰陣會同 `import.meta.url`（一定係正規化咗嘅
// file URL）唔一致，令判斷唔準——改用 `fileURLToPath()`／`path.resolve()`
// 兩個都轉做正規化嘅本機路徑先比較，同 scripts/report/*.ts 嗰種寫法唔
// 同層次，但邏輯上更穩陣。
const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  recomputePermitDerived()
    .then((r) => {
      console.log(`[db:recompute-permit-derived] 完成——掃描=${r.scanned} 更新=${r.updated}（a/b都null跳過=${r.skippedBothNull}）`);
      return prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error("[db:recompute-permit-derived] 失敗", e instanceof Error ? e.message : e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
