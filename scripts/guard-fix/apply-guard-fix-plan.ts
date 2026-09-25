// WP-GUARD-FIX（老闆 2026-09-25 要求，緊急，直接影響出糧）：apply-guard-
// fix-plan.ts——讀 `data/2026-09/guard-fix/plan.json`（build-guard-fix-
// plan.ts 生成），寫入 DB。預設 `--plan`（唔寫，淨係印 diff：新建/連結/
// 跳過數目，冇 PII）；`--apply` 先真係寫。
//
// WP-GUARD-FIX-UI：套用邏輯（transaction／冪等／reparse 迴圈）搬咗去
// `src/lib/guard-fix/apply.ts`（`applyGuardFixPlan()`／
// `reparseAllActiveUploads()`），呢個 script 而家淨係做：讀
// plan.json → 檢查 dbTarget → 叫 lib → 印結果。`POST /api/guard-fix/
// runs/:id/apply` 用返同一組函數，唔准複製貼上一份新邏輯。
//
// 鐵則：audit 唔帶姓名／電話——由 `applyGuardFixPlan()` 內部保證。
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { applyGuardFixPlan, reparseAllActiveUploads } from "@/lib/guard-fix/apply";
import { describeDbTarget } from "@/lib/guard-fix/plan";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const PLAN_ONLY = !APPLY;
const PLAN_JSON_PATH = "data/2026-09/guard-fix/plan.json";
const AUG_MONTH = new Date("2026-08-01T00:00:00.000Z");

async function main() {
  console.log(`[apply-guard-fix-plan] 目標 DB：${describeDbTarget()}${APPLY ? "" : "（--plan，唔會寫入）"}`);
  const plan = JSON.parse(readFileSync(PLAN_JSON_PATH, "utf8")) as GuardFixPlan;
  console.log(`[apply-guard-fix-plan] plan 產生於 ${plan.generatedAt}，資料嚟源 ${plan.sourceMode}`);
  // 驗收（Opus 5.5）：plan 係對住另一個 DB build 嘅——停。
  if (plan.dbTarget !== describeDbTarget()) {
    throw new Error(`plan.json 係對住 ${plan.dbTarget} build 嘅，而家目標係 ${describeDbTarget()}——停，請對住目標 DB 重新 build。`);
  }
  console.log(`[apply-guard-fix-plan] link=${plan.actions.link.length} create=${plan.actions.create.length} create_minimal=${plan.actions.createMinimal.length} needs_boss=${plan.actions.needsBoss.length}`);

  // timeout 30 分鐘、maxWait 30 秒——同 opening apply-aug-plan.ts P2028
  // 教訓一致（老闆可能經 Zeabur 公開 port 對正式站行）。
  const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: PLAN_ONLY, txTimeoutMs: 1_800_000 });

  console.log(`\n=== link（登記工號／加別名）=== 處理 ${diffs.link.create.length}／跳過 ${diffs.link.skip.length}`);
  for (const s of diffs.link.skip) console.log(`  ! ${s}`);
  console.log(`=== create（新散工，U Team 名單有）=== 新建 ${diffs.create.create.length}／跳過 ${diffs.create.skip.length}`);
  for (const s of diffs.create.skip) console.log(`  ! ${s}`);
  console.log(`=== create_minimal（needs_hr）=== 新建 ${diffs.createMinimal.create.length}／跳過 ${diffs.createMinimal.skip.length}`);
  for (const s of diffs.createMinimal.skip) console.log(`  ! ${s}`);
  console.log(`\n[apply-guard-fix-plan] ${APPLY ? "已經寫入 DB（同一個 transaction）。" : "淨係印咗 diff，冇寫入（要真係寫用 --apply）。"}`);

  if (!APPLY) return;

  // -----------------------------------------------------------------
  // --apply 完成之後：對目標 DB 2026-08 全部 active 上載逐個 reparse。
  // -----------------------------------------------------------------
  const result = await reparseAllActiveUploads(prisma, AUG_MONTH, { txTimeoutMs: 600_000 });
  if (result.confirmedSkippedCount) {
    console.log(`\n[apply-guard-fix-plan] ! ${result.confirmedSkippedCount} 個 2026-08 上載已經對數確認（confirmed），唔 reparse（已寫入 shift_records 嘅唔郁）。`);
  }
  if (result.perUpload.length === 0) {
    console.log("\n[apply-guard-fix-plan] 目標 DB 冇 2026-08 active 上載，跳過 reparse（dev 環境未上載更表嗰陣正常）。");
    return;
  }
  console.log(`\n=== reparse 2026-08 全部 active 上載（${result.perUpload.length} 個）===`);
  for (const r of result.perUpload) {
    console.log(`  ${r.siteLabel}：unmatched ${r.before.unmatched}→${r.after.unmatched}，ambiguous ${r.before.ambiguous}→${r.after.ambiguous}`);
  }
  console.log(`\n[apply-guard-fix-plan] 總結：修復前 ${result.totalBefore} 格未配對 → 修復後 ${result.totalAfter} 格未配對`);

  if (result.totalAfter > 0) {
    const uploadIds = result.perUpload.map((r) => r.uploadId);
    const remaining = await prisma.rosterUploadRow.findMany({
      where: { uploadId: { in: uploadIds }, guardMatch: { in: ["unmatched", "ambiguous"] } },
      select: { uploadId: true, guardMatch: true },
    });
    const labelByUploadId = new Map(result.perUpload.map((r) => [r.uploadId, r.siteLabel]));
    const bySite = new Map<string, { unmatched: number; ambiguous: number }>();
    for (const r of remaining) {
      const label = labelByUploadId.get(r.uploadId)!;
      if (!bySite.has(label)) bySite.set(label, { unmatched: 0, ambiguous: 0 });
      const entry = bySite.get(label)!;
      if (r.guardMatch === "unmatched") entry.unmatched += 1;
      else entry.ambiguous += 1;
    }
    console.log("剩低（盤＋格數＋原因，需要 needs_hr／needs_boss 覆核，唔印名）：");
    for (const [label, n] of bySite) {
      console.log(`  - ${label}：unmatched ${n.unmatched} 格／ambiguous ${n.ambiguous} 格`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
