// HIST-1：由 2026-07 之前月份嘅更表計長工病假／年假結餘 opening，回填 guard_leave_balances。
// HIST-2：核心邏輯搬咗去 src/lib/longterm-payroll/leave-opening.ts（API `POST /api/leave-balances/opening-from-rosters` 共用），呢個 script 變薄殼，行為不變。
// 計法／寫入規則／旗標全部見 src/lib/longterm-payroll/leave-opening.ts 檔頭。
//
//   npx tsx scripts/db/leave-opening-from-rosters.ts --as-of 2026-06 [--out data/leave-opening.json]          # dry-run（預設）：只計、只印計數
//   npx tsx scripts/db/leave-opening-from-rosters.ts --as-of 2026-06 --apply [--out data/leave-opening.json]  # 真係寫（先 dry-run 睇差異清單）
//   --merge-into-existing／--recompute-same-as-of 見 lib 檔頭。
//   --out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）；JSON 只有 guardId＋數字＋月份，唔含姓名／工號／電話。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { prisma } from "../../src/lib/db";
import { leaveOpeningFromRosters, parseAsOf } from "../../src/lib/longterm-payroll/leave-opening";

export * from "../../src/lib/longterm-payroll/leave-opening";

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  (async () => {
    const asOfRaw = val("--as-of");
    if (!asOfRaw) throw new Error("需要 --as-of YYYY-MM（例如 2026-06）");
    const out = val("--out");
    let abs: string | null = null;
    if (out) {
      abs = path.resolve(out);
      const rel = path.relative(process.cwd(), abs).split(path.sep);
      if (rel[0] !== "data" && rel[0] !== "out") throw new Error("--out 必須喺 data/ 或 out/ 之下（gitignored，唔入 git）");
    }
    console.log(`[leave-opening] 模式：${apply ? "--apply（真係寫）" : "dry-run（只計，唔寫）"}｜as-of ${asOfRaw}`);
    const r = await leaveOpeningFromRosters({ asOf: parseAsOf(asOfRaw), apply, mergeIntoExisting: argv.includes("--merge-into-existing"), recomputeSameAsOf: argv.includes("--recompute-same-as-of") });
    console.log(`[leave-opening] 長工 ${r.counts.guards} 人｜${(["create", "update", "merge", "already_merged", "unchanged", "skip_existing_newer_or_equal", "nothing_to_write"] as const).map((k) => `${k} ${r.counts[k]}`).join("｜")}｜no_hire_date ${r.counts.no_hire_date}｜sl_unpaid_segments ${r.counts.sl_unpaid_segments}`);
    if (abs) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2));
      console.log("[leave-opening] 已寫 --out（只有 guardId＋數字）");
    }
    await prisma.$disconnect();
  })().catch(async (e) => {
    console.error("[leave-opening] 失敗", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
