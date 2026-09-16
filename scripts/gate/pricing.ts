// WP-PRICE 最重要嘅新硬性 gate（規劃裁定 2026-09-16）：`npm run
// gate:pricing`。用 resolver 對 dev DB 7 月全部非 cancelled `shift` 記錄
// 重新計价（唔寫入，只比較），同現有 client_rate_snapshot／guard_wage_
// snapshot／broker_fee_snapshot 逐條比較——
//   - 現有 snapshot 有值嘅條目，resolver 結果必須完全相等（差異 0 條）；
//   - 現有 snapshot 係 null 嘅條目，resolver 亦必須回 null（唔准「補到」
//     7 月刻意冇价嘅記錄）；
//   - 例外清單只可以係明列而且有理由嘅（見 lib/pricing-check.ts
//     EXCEPTIONS）；每條例外規則都要 field／kind 收窄，唔准 blanket by
//     shiftTypeCode（必修 3，Opus 第二輪驗收）。
//   - code="PR" 嘅 `kind==="value_mismatch"` 差異（PR 已封死唔可以新建，
//     7 月數字係源頭轉錄）唔准靜靜吞落 exceptions，獨立逐條列出（必修 1）。
// 呢個 gate 唔過就唔准交貨（見 WP-PRICE 交帶）。
import { runPricingJulyGate, summarizeDiffs, summarizeExceptionsByRule } from "./lib/pricing-check";

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

  // 必修 3：例外逐類數量＋各類 kind 分佈（唔准淨係印一個總數）。
  console.log(`\n[gate:pricing] 例外（明列，唔計 fail）：${result.exceptions.length} 個，逐類分佈：`);
  console.log(summarizeExceptionsByRule(result.exceptions));
  if (result.exceptions.length > 0) {
    console.log(`\n[gate:pricing] 例外樣本（前 30 條）：`);
    for (const e of result.exceptions.slice(0, 30)) {
      console.log(`  [${e.exceptionId}] ${e.siteName} · ${e.shiftTypeCode} · 雞頭${e.brokerCode ?? "無"} · ${e.workDate} · ${e.field} · ${e.kind}：existing=${e.existing} resolved=${e.resolved}`);
    }
  }

  // 必修 1：PR 已封死嘅 value_mismatch——逐條列晒出嚟（唔截斷），唔准
  // 靜靜吞落例外。
  if (result.prSealedValueMismatches.length > 0) {
    console.log(`\n[gate:pricing] PR 封死（code="PR"，kind=value_mismatch，${result.prSealedValueMismatches.length} 條，8 月唔會出現，唔計 fail）：`);
    for (const d of result.prSealedValueMismatches) {
      console.log(`  ${d.siteName} · ${d.shiftTypeCode} · 雞頭${d.brokerCode ?? "無"} · ${d.workDate} · ${d.field}：existing=${d.existing} resolved=${d.resolved} 差額=${d.existing !== null && d.resolved !== null ? d.resolved - d.existing : "N/A"}`);
    }
  }

  if (result.diffs.length > 0) {
    console.log(`\n[gate:pricing] FAIL — ${result.diffs.length} 個差異（非例外）：`);
    console.log(summarizeDiffs(result.diffs));
    process.exitCode = 1;
  } else {
    console.log(
      `\n[gate:pricing] PASS — 0 差異（resolver 100% 重現 7 月 snapshot；${result.exceptions.length} 個已核實例外；${result.prSealedValueMismatches.length} 個 PR 封死已列明）`,
    );
  }
}

main().catch((err) => {
  console.error("[gate:pricing] 執行失敗", err);
  process.exitCode = 1;
});
