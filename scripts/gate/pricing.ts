// WP-PRICE 最重要嘅新硬性 gate（規劃裁定 2026-09-16）：`npm run
// gate:pricing`。用 resolver 對 dev DB 7 月全部非 cancelled `shift` 記錄
// 重新計价（唔寫入，只比較），同現有 client_rate_snapshot／guard_wage_
// snapshot／broker_fee_snapshot 逐條比較——
//   - 現有 snapshot 有值嘅條目，resolver 結果必須完全相等（差異 0 條）；
//   - 現有 snapshot 係 null 嘅條目，resolver 亦必須回 null（唔准「補到」
//     7 月刻意冇价嘅記錄）；
//   - 例外清單只可以係明列而且有理由嘅（見 lib/pricing-check.ts
//     EXCEPTIONS，目前一項都冇）。
// 呢個 gate 唔過就唔准交貨（見 WP-PRICE 交帶）。
import { runPricingJulyGate, summarizeDiffs } from "./lib/pricing-check";

async function main() {
  console.log("[gate:pricing] 用 resolveShiftPricingFromCards() 對 dev DB 7 月全部非 cancelled shift 記錄重新計价，比對現有 snapshot……");
  const result = await runPricingJulyGate();

  if (result.totalRecords === 0) {
    console.error("[gate:pricing] FAIL — dev DB 冇 7 月 shift 記錄（未 npm run db:start && npm run db:seed？）");
    process.exitCode = 1;
    return;
  }

  console.log(`[gate:pricing] 7 月非 cancelled shift 記錄：${result.totalRecords} 條，逐條 3 欄（收客價／出街工資／雞頭費）共 ${result.fieldChecks} 個比對點。`);
  console.log(`[gate:pricing] 完全相等：${result.matches}／${result.fieldChecks}`);

  if (result.exceptions.length > 0) {
    console.log(`\n[gate:pricing] 例外（明列，唔計 fail）：${result.exceptions.length} 個`);
    for (const e of result.exceptions.slice(0, 30)) {
      console.log(`  ${e.siteName} · ${e.shiftTypeCode} · 雞頭${e.brokerCode ?? "無"} · ${e.workDate} · ${e.field}：existing=${e.existing} resolved=${e.resolved} —— ${e.exceptionReason}`);
    }
  }

  if (result.diffs.length > 0) {
    console.log(`\n[gate:pricing] FAIL — ${result.diffs.length} 個差異（非例外）：`);
    console.log(summarizeDiffs(result.diffs));
    process.exitCode = 1;
  } else {
    console.log(`\n[gate:pricing] PASS — 0 差異（resolver 100% 重現 7 月 snapshot；${result.exceptions.length} 個已核實例外）`);
  }
}

main().catch((err) => {
  console.error("[gate:pricing] 執行失敗", err);
  process.exitCode = 1;
});
