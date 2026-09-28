// Gate test（規劃裁定，Opus 對抗式驗收第三輪）：seed + report:regen 對
// **真實 7 月數據**（開發庫 `zoikan`，唔係 vitest 全域 globalSetup 嗰個
// 隔離、假數據嘅 `zoikan_test`）嘅端到端驗收。特登用獨立 child process
// 跑（顯式覆蓋 DATABASE_URL 指向開發庫），避免同其他 test file 共用嘅
// 隔離 test DB 混埋（唔想成個真實 7 月數據集污染咗其他 test 嘅 fixture
// 假設）。需要 `npm run db:start` 已經起咗開發庫先跑得（同手動
// `npm run db:seed`/`report:regen` 嘅前提一樣）。
//
// **鐵則（WP-BOSS5 驗收項 6）：呢個 test 會實際 `npm run db:seed` 重新
// 種**開發庫（下面 `beforeAll()` 用 `execFileSync` 起子行程執行），會
// 覆蓋走開發庫入面所有資料同狀態——**唔可以同 `npm run gate:locked-
// months`（或者任何依賴開發庫現有資料嘅 gate script，見
// `scripts/gate/locked-months.sh` 頂註解）同時跑**，兩者會互相撞車
// （一個重新 seed 緊，另一個喺度讀緊同一個開發庫），結果唔可靠。呢個
// test 同 `gate:locked-months` 要分開、先後執行，唔可以並行（parallel）
// 或者夾埋一個 `npm run` script 一齊跑。
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

  // P0（Opus 驗收重現，2026-09-20）：舊斷言（172 backfilled／93 null）淨係
  // 反映 `backfillDefaultBrokerId()`（S6，`scripts/seed/lib/backfill-
  // broker.ts`）——嗰個 helper 刻意淨係計 kind=broker（外判雞頭）嘅證據，
  // 為咗雞頭隔離用途，長工/公司兵留 NULL。而長工/公司兵嘅
  // `default_broker_id` NULL 正正係 P0 bug 嘅根源（batch/route.ts 嘅
  // settlement_broker_id fallback 鏈跌到呢個欄）——而家 `main()` 多行咗
  // 一層更闊嘅 `backfillGuardDefaultBrokerBroaderP0()`（見
  // `scripts/seed/lib/backfill-broker-p0.ts`，逐字對照
  // `prisma/migrations/20260920010000_p0_backfill_guard_default_broker/
  // migration.sql`），淨係補第一層冇補到嗰批：257 = 172（第一層，kind=
  // broker 證據）+ 85（第二層，kind=internal_cash/internal_longterm/
  // external 嘅歷史記錄——按 kind 分佈：internal_longterm 48、
  // internal_cash 26、external 11，見 out/p1/seed-stats.json
  // `guardsDefaultBrokerBroaderBackfilledByKind_*`）。剩低 8 個
  // 真係完全冇任何非作廢 shift_record 歷史、又唔係長工（longterm_
  // autopay）——冇證據可以臆測，保持 NULL 係啱嘅（B 項嘅 runtime
  // fallback 鏈、D 項嘅 no_settlement_count 警告會兜住呢批人第一次
  // 派更嗰陣嘅情況）。
  it("guards.default_broker_id：backfilled===257，null(乜證據都冇，唔係長工)===8", async () => {
    const totalGuards = await devPrisma.guard.count();
    const backfilled = await devPrisma.guard.count({ where: { defaultBrokerId: { not: null } } });
    expect(backfilled).toBe(257);
    expect(totalGuards - backfilled).toBe(8);
  });

  it("shift_records===4188，operational_broker_id≠settlement_broker_id===0（真實 7 月數據冇呢個落差）", async () => {
    const total = await devPrisma.shiftRecord.count();
    expect(total).toBe(4188);
    const rows = await devPrisma.shiftRecord.findMany({ select: { operationalBrokerId: true, settlementBrokerId: true } });
    const diffCount = rows.filter((r) => r.operationalBrokerId !== r.settlementBrokerId).length;
    expect(diffCount).toBe(0);
  });

  // WP-STAFFNO（老闆 2026-09-19 拍板）：migration 資料搬遷（見
  // prisma/migrations/20260919064514_wp_staffno）淨係喺「migration 執行
  // 嗰一刻 guards 表已經有嘅行」先搬——`db:reset` 由空表重新 migrate，
  // backfill INSERT 嗰陣一定搬 0 行，真正令新表有數嘅係 `seedGuards()`
  // 建咗 guard 之後即刻起對應行（見 scripts/seed/index.ts
  // seedStaffNumberFromLegacyColumn()，同一套 scheme 推斷規則）。呢度
  // 直接查開發庫（已經跑完上面嗰個 `npm run db:seed`），斷言「每個有
  // staff_no／staff_no_mw 嘅 guard 都有對應 current 行」呢個不變式。
  it("guard_staff_numbers：每個有 staff_no 嘅 guard 有對應 scheme=U current 行", async () => {
    const guardsWithStaffNo = await devPrisma.guard.findMany({ where: { staffNo: { not: null } }, select: { id: true, staffNo: true } });
    expect(guardsWithStaffNo.length).toBeGreaterThan(0);
    for (const g of guardsWithStaffNo) {
      const row = await devPrisma.guardStaffNumber.findFirst({ where: { guardId: g.id, scheme: "U", status: "current" } });
      expect(row?.number, `guard ${g.id}（staff_no=${g.staffNo}）冇對應 current U 行`).toBe(g.staffNo);
    }
  });

  it("guard_staff_numbers：每個有 staff_no_mw 嘅 guard 有對應 scheme=MG／MW current 行", async () => {
    const guardsWithMw = await devPrisma.guard.findMany({ where: { staffNoMw: { not: null } }, select: { id: true, staffNoMw: true } });
    expect(guardsWithMw.length).toBeGreaterThan(0);
    for (const g of guardsWithMw) {
      const row = await devPrisma.guardStaffNumber.findFirst({
        where: { guardId: g.id, scheme: { in: ["MG", "MW"] }, status: "current" },
      });
      expect(row?.number, `guard ${g.id}（staff_no_mw=${g.staffNoMw}）冇對應 current MG/MW 行`).toBe(g.staffNoMw);
    }
  });

  it("guard_staff_numbers.number 全表 unique（DB 約束）——冇任何重複值", async () => {
    const rows = await devPrisma.guardStaffNumber.findMany({ select: { number: true } });
    const numbers = rows.map((r) => r.number);
    expect(new Set(numbers).size).toBe(numbers.length);
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
