// WP-GUARD-FIX（老闆 2026-09-25 要求，緊急，直接影響出糧）：8 月更表
// 「未配對安員」自動修復——build-guard-fix-plan.ts。
//
// WP-GUARD-FIX-UI：核心分類邏輯（link／create／create_minimal／
// needs_boss）搬咗去 `src/lib/guard-fix/plan.ts`（`buildGuardFixPlan()`），
// 呢個 script 而家淨係做：讀 U Team 名單／核對表 xlsx（本機檔案路徑）→
// 叫 lib → 寫 `plan.json`／`plan-summary.md`。`POST /api/guard-fix/plan`
// 用同一個 `buildGuardFixPlan()`，唔准複製貼上一份新邏輯。
//
// 讀目標 DB（`DATABASE_URL`）**實際嘅 2026-08 active 上載**（
// `roster_uploads.month=2026-08-01`、`status not in (superseded,
// voided)`）嘅 `roster_upload_rows`（`guard_match in (unmatched,
// ambiguous)`）——正式站同 dev 唔同，所以對住目標 DB 而唔係
// `records.jsonl`；dev 冇上載時 fallback 用
// `data/2026-09/aug-payroll-trial/out-rosters/records.jsonl`（逐行用
// 目標 DB 現狀行 `matchGuard()` 重新判斷邊啲仲係 unmatched/ambiguous）。
//
// 輸出 `data/2026-09/guard-fix/plan.json`（帶真實姓名/電話/身份證，
// gitignored，唔准入 git）＋`plan-summary.md`（淨係數目／盤名／格數，
// needs_hr／needs_boss 用「盤＋格數＋原因」，唔列名）。
//
// 鐵則：呢個檔案／`apply-guard-fix-plan.ts` 一律唔准喺 log／console 印
// 姓名/電話/身份證/工號原文——PII 淨係寫落 gitignored 嘅 plan.json。
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { buildGuardFixPlan, summarizePlan, formatPlanSummaryMd, describeDbTarget, NoActiveUploadsError } from "@/lib/guard-fix/plan";
import { loadUTeamList, loadCrossCheckMainSheet } from "@/lib/guard-fix/sources";

const prisma = new PrismaClient();
// 驗收（Opus 5.5）：records.jsonl fallback 淨係 dev 明文要先用。
const ALLOW_JSONL_FALLBACK = process.argv.includes("--allow-jsonl-fallback");

const AUG_MONTH = new Date("2026-08-01T00:00:00.000Z");
const RECORDS_JSONL_PATH = "data/2026-09/aug-payroll-trial/out-rosters/records.jsonl";
const PLAN_DIR = "data/2026-09/guard-fix";
const PLAN_JSON_PATH = path.join(PLAN_DIR, "plan.json");
const PLAN_SUMMARY_PATH = path.join(PLAN_DIR, "plan-summary.md");

async function main() {
  console.log(`[build-guard-fix-plan] 目標 DB：${describeDbTarget()}`);
  mkdirSync(PLAN_DIR, { recursive: true });

  const [uTeamRows, crossCheckRows] = await Promise.all([loadUTeamList(), loadCrossCheckMainSheet()]);

  let plan;
  try {
    plan = await buildGuardFixPlan({
      prisma,
      month: AUG_MONTH,
      uTeamRows,
      crossCheckRows,
      recordsJsonlFallbackPath: ALLOW_JSONL_FALLBACK ? RECORDS_JSONL_PATH : undefined,
    });
  } catch (e) {
    if (e instanceof NoActiveUploadsError) {
      throw new Error(`${e.message}（貼啱 DB 未？）——停。dev 要用 records.jsonl 就加 --allow-jsonl-fallback。`);
    }
    throw e;
  }

  writeFileSync(PLAN_JSON_PATH, JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(PLAN_SUMMARY_PATH, formatPlanSummaryMd(plan), "utf8");

  const s = summarizePlan(plan);
  console.log(`[build-guard-fix-plan] 身份總數 ${s.totalIdentities}（格總數 ${s.totalCells}）`);
  console.log(`[build-guard-fix-plan] link=${s.link} create=${s.create} create_minimal(needs_hr)=${s.createMinimal} needs_boss=${s.needsBoss}`);
  if (plan.hkidDroppedCount) console.log(`[build-guard-fix-plan] ! create 入面 ${plan.hkidDroppedCount} 個名單身份證欄唔係身份證格式，冇寫入（要 HR 補）`);
  for (const a of plan.actions.needsBoss) {
    const identity = plan.identities.find((i) => i.seq === a.seq)!;
    console.log(`[build-guard-fix-plan] needs_boss ${a.seq}：${identity.cells.map((c) => `${c.siteLabel} ${c.cellCount} 格`).join("、")}——${a.reason}`);
  }
  console.log(`[build-guard-fix-plan] plan.json → ${PLAN_JSON_PATH}`);
  console.log(`[build-guard-fix-plan] plan-summary.md → ${PLAN_SUMMARY_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
