// Gate test（規劃裁定，Opus 對抗式驗收第三輪）：seed + report:regen 對
// **真實 7 月數據**（開發庫 `zoikan`，唔係 vitest 全域 globalSetup 嗰個
// 隔離、假數據嘅 `zoikan_test`）嘅端到端驗收。特登用獨立 child process
// 跑（顯式覆蓋 DATABASE_URL 指向開發庫），避免同其他 test file 共用嘅
// 隔離 test DB 混埋（唔想成個真實 7 月數據集污染咗其他 test 嘅 fixture
// 假設）。需要 `npm run db:start` 已經起咗開發庫先跑得（同手動
// `npm run db:seed`/`report:regen` 嘅前提一樣）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { readCsv } from "../scripts/seed/lib/csv";
import { str } from "../scripts/seed/lib/csv";
import { CSV } from "../scripts/seed/lib/paths";
import { settlementUnitToBrokerCsvId, MASTER_BROKER_CODE_TO_BROKER_CSV_ID } from "../scripts/seed/lib/mapping";
import { knownUnmappedSettlementUnits } from "../scripts/seed/lib/seed-overrides";

const REPO_ROOT = path.resolve(__dirname, "..");

function readDevDatabaseUrl(): string {
  const envPath = path.resolve(REPO_ROOT, ".env");
  const content = fs.readFileSync(envPath, "utf-8");
  const m = content.match(/^DATABASE_URL="([^"]+)"/m);
  if (!m) throw new Error(".env 搵唔到 DATABASE_URL——呢個 gate test 要求開發庫已經配置好（npm run db:start）。");
  return m[1]!;
}

let DEV_DATABASE_URL: string;
try {
  DEV_DATABASE_URL = readDevDatabaseUrl();
} catch {
  DEV_DATABASE_URL = "";
}

// 2026-09-14 教訓：平行 worktree 冇 gitignored 嘅 tools/importer/out／data/mappings-private
// （seed 嘅輸入），但 `npm run db:seed` 係先 clearAll() 再讀 CSV——喺嗰度跑呢個 gate
// 會清空共用開發庫然後先死。輸入唔齊就 skip，唔好碰個庫。
const SEED_INPUTS_PRESENT =
  fs.existsSync(path.resolve(REPO_ROOT, "tools/importer/out")) &&
  fs.existsSync(path.resolve(REPO_ROOT, "data/mappings-private"));
const describeOrSkip = DEV_DATABASE_URL && SEED_INPUTS_PRESENT ? describe : describe.skip;

describeOrSkip("Gate：seed + regen 對真實 7 月數據（開發庫）", () => {
  let devPrisma: PrismaClient;

  beforeAll(() => {
    devPrisma = new PrismaClient({ datasources: { db: { url: DEV_DATABASE_URL } } });
  });

  afterAll(async () => {
    await devPrisma.$disconnect();
  });

  it("npm run db:seed（開發庫）exit 0（唔會因為未登記嘅 settlement_unit/master_broker_code 而中止）", () => {
    expect(() =>
      execFileSync("npm", ["run", "db:seed"], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 60_000);

  it("brokerSiteAssignments：7月===90，8月 rollover===90", async () => {
    const julyCount = await devPrisma.brokerSiteAssignment.count({ where: { month: new Date(Date.UTC(2026, 6, 1)) } });
    const augCount = await devPrisma.brokerSiteAssignment.count({ where: { month: new Date(Date.UTC(2026, 7, 1)) } });
    expect(julyCount).toBe(90);
    expect(augCount).toBe(90);
  });

  it("guards.default_broker_id：backfilled===172，null(internal 或 external，冇雞頭證據)===93", async () => {
    const totalGuards = await devPrisma.guard.count();
    const backfilled = await devPrisma.guard.count({ where: { defaultBrokerId: { not: null } } });
    expect(backfilled).toBe(172);
    expect(totalGuards - backfilled).toBe(93);
  });

  it("shift_records===4188，operational_broker_id≠settlement_broker_id===0（真實 7 月數據冇呢個落差）", async () => {
    const total = await devPrisma.shiftRecord.count();
    expect(total).toBe(4188);
    const rows = await devPrisma.shiftRecord.findMany({ select: { operationalBrokerId: true, settlementBrokerId: true } });
    const diffCount = rows.filter((r) => r.operationalBrokerId !== r.settlementBrokerId).length;
    expect(diffCount).toBe(0);
  });

  it("npm run report:regen exit 0，[diff] fail===0", () => {
    const out = execFileSync("npm", ["run", "report:regen"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: DEV_DATABASE_URL },
      encoding: "utf-8",
    });
    const m = out.match(/\[diff\] pass=(\d+) fail=(\d+) known=(\d+) p0_artifact=(\d+) info=(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![2])).toBe(0);
  }, 60_000);

  it("P0 CSV 每個 distinct settlement_unit 都 map 到 broker 或者已知例外（獨立重新驗證，唔淨係信 seed script 自己冇 throw）", () => {
    type Row = { settlement_unit: string };
    const rows = readCsv<Row>(CSV.shiftRecords);
    const settlementUnitMap = settlementUnitToBrokerCsvId();
    const KNOWN_UNMAPPED = new Set(knownUnmappedSettlementUnits());
    const distinct = new Set(rows.map((r) => str(r.settlement_unit)).filter((v): v is string => v !== null));
    const unmapped = [...distinct].filter((u) => !settlementUnitMap[u] && !KNOWN_UNMAPPED.has(u));
    expect(unmapped).toEqual([]);
  });

  it("P0 CSV 每個 distinct master_broker_code 都 map 到 broker 或者已知例外（獨立重新驗證）", () => {
    type Row = { master_broker_code: string };
    const rows = readCsv<Row>(CSV.shiftRecords);
    const KNOWN_UNMAPPED = new Set(["LT"]);
    const distinct = new Set(rows.map((r) => str(r.master_broker_code)).filter((v): v is string => v !== null));
    const unmapped = [...distinct].filter((c) => !(c in MASTER_BROKER_CODE_TO_BROKER_CSV_ID) && !KNOWN_UNMAPPED.has(c));
    expect(unmapped).toEqual([]);
  });
});
