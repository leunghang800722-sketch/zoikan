// WP-PRICE 最重要嘅新硬性 gate（規劃裁定 2026-09-16，「兩者都要」）——
// 呢個 test file 係 `scripts/gate/pricing.ts`（`npm run gate:pricing`）
// 嘅 vitest 版本，共用 `scripts/gate/lib/pricing-check.ts` 嗰份邏輯。
//
// 注意：`tests/global-setup.ts` 會將 `process.env.DATABASE_URL` 掉包做
// 一個獨立、剛 migrate 完、冇 seed 任何 7 月數據嘅 embedded postgres（見
// 嗰個檔案頂註解）——所以呢度**唔可以**用 `@/lib/db` 嗰個 app 單例（佢
// import 嗰刻已經綁死咗掉包之後嘅 test DB URL）。`runPricingJulyGate()`
// 接受一個明確嘅 `databaseUrl`，呢度用 `scripts/db/lib.ts` 嘅
// `databaseUrl()`（`npm run db:start` 起嘅開發用 embedded postgres，
// `npm run db:seed` 之後有 7 月真實數據）直接連過去。連唔到／冇 7 月
// 數據（dev DB 未起、未 seed）就當呢個環境未具備條件，跳過（console.warn
// 講清楚，唔畀個 test 喺冇 dev DB 嘅環境／CI 度紅），呢個唔代表 gate 冇
// 跑過——真正嘅 gate 結果以 `npm run gate:pricing`（喺主樹、dev DB 已
// db:start+db:seed 嘅情況下）為準。
import { describe, it, expect } from "vitest";
import { runPricingJulyGate, summarizeDiffs } from "../scripts/gate/lib/pricing-check";
import { databaseUrl } from "../scripts/db/lib";

describe("WP-PRICE gate：resolveShiftPricingFromCards() 100% 重現 7 月 shift_records snapshot", () => {
  it("dev DB（npm run db:start + db:seed）7 月全部非 cancelled shift 記錄，resolver 重算結果同現有 snapshot 逐條零差異", async () => {
    let result: Awaited<ReturnType<typeof runPricingJulyGate>>;
    try {
      result = await runPricingJulyGate(databaseUrl());
    } catch (err) {
      console.warn(`[pricing-reproduce-july] 連唔到 dev DB（${databaseUrl()}）——要 npm run db:start 先有得驗，呢個 test 喺呢個環境跳過。錯誤：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (result.totalRecords === 0) {
      console.warn("[pricing-reproduce-july] dev DB 冇 7 月 shift 記錄（未 npm run db:seed）——呢個 test 喺呢個環境跳過。真正嘅 gate 結果以 npm run gate:pricing（主樹、已 db:seed）為準。");
      return;
    }
    console.log(`[pricing-reproduce-july] ${result.totalRecords} 條 7 月非 cancelled shift 記錄，${result.fieldChecks} 個比對點，完全相等 ${result.matches} 個，例外 ${result.exceptions.length} 個。`);
    expect(result.diffs, `resolver 重現 7 月 snapshot 有 ${result.diffs.length} 個差異：\n${summarizeDiffs(result.diffs)}`).toHaveLength(0);
  });
});
