// WP-STAFFNO S3/S4（Opus 驗收修復）：migration.sql 「(2) 資料搬遷」段
// 嘅資料搬遷邏輯——原本一撞號就 RAISE EXCEPTION 中止成個 migration，而家
// 改做「唔 abort，兜底處理＋audit_log 留底」。呢個 migration 本身係一次
// 性 SQL（prisma/migrations/20260919064514_wp_staffno/migration.sql），
// 冇得直接 import 做 function 測——呢個 test 用 synthetic guard 資料
// （虛構工號，PDPO 安全）＋喺 `prisma.$transaction()`（single connection，
// 保證 temp table 喺同一個 tx 內跨幾個 `$executeRawUnsafe` call 都見到）
// 入面**逐字重跑一次同一段 SQL**嚟驗證邏輯，唔係直接測真 migration
// 執行結果（真 migration 已經喺 `npx prisma migrate deploy`／
// `db:reset` 果陣跑咗）。
//
// 下面呢段 SQL 常數要同 migration.sql「(2) 資料搬遷」保持逐字一致——
// migration.sql 改咗呢段邏輯，呢度都要跟住改，唔係就呢個 test 淨係測緊
// 一個舊版邏輯嘅分身，冇意義。
//
// 覆蓋 8 種情況（跟 Opus 驗收畀嘅 B/C/D/E/F/G/H/K 標籤）：
//   B：正常 staff_no（U 開頭，冇撞號）
//   C：正常 staff_no_mw（MG 開頭，冇撞號）
//   D：正常 staff_no_mw（MW 開頭，冇撞號）
//   E：staff_no 格式唔啱（冇字母前綴）→ skip + migration_skipped_invalid
//   F：兩個唔同 guard，staff_no 正規化後相同（大小寫/空白差異）→ 真撞號
//   G：跨欄撞號（一個 guard 嘅 staff_no 撞正另一個 guard 嘅 staff_no_mw）
//   H：三重撞號（三個 guard 正規化後全部相同）
//   K：帶連字符嘅合法值（邊界格式）
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import type { Prisma } from "@prisma/client";

// 逐字對照 prisma/migrations/20260919064514_wp_staffno/migration.sql
// 「(2) 資料搬遷」段——JS 字串入面 `\s` 要寫做 `\\s`（唔係 SQL 本身嘅
// 分別，係 JS string literal 會靜靜哋剝走冇特殊意義嘅 `\X` 逃逸嘅
// backslash，唔寫雙斜要就會送咗個 "s+" 落 Postgres）。
async function runMigrationBackfill(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE wp_staffno_source AS
    SELECT
      id AS guard_id,
      created_at,
      'staff_no' AS col_name,
      UPPER(REGEXP_REPLACE(TRIM(staff_no), '\\s+', '', 'g')) AS normalized
    FROM guards
    WHERE staff_no IS NOT NULL AND TRIM(staff_no) <> ''
    UNION ALL
    SELECT
      id,
      created_at,
      'staff_no_mw',
      UPPER(REGEXP_REPLACE(TRIM(staff_no_mw), '\\s+', '', 'g'))
    FROM guards
    WHERE staff_no_mw IS NOT NULL AND TRIM(staff_no_mw) <> '';
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE wp_staffno_ranked AS
    SELECT
      guard_id,
      col_name,
      normalized,
      ROW_NUMBER() OVER (PARTITION BY normalized ORDER BY created_at ASC, guard_id ASC) AS rn
    FROM wp_staffno_source
    WHERE normalized ~ '^[A-Z]{1,4}[0-9A-Z-]+$';
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      guard_id,
      UPPER(substring(normalized FROM '^[A-Z]{1,4}')),
      normalized,
      'current',
      'migration:' || col_name,
      now(),
      now()
    FROM wp_staffno_ranked
    WHERE rn = 1;
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO audit_log (id, actor_user_id, table_name, row_id, action, before, after, ip, created_at)
    SELECT
      gen_random_uuid(),
      NULL,
      'guard_staff_numbers',
      guard_id,
      'migration_skipped_duplicate',
      NULL,
      jsonb_build_object('column', col_name, 'number', normalized, 'reason', 'dup-test'),
      NULL,
      now()
    FROM wp_staffno_ranked
    WHERE rn > 1;
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO audit_log (id, actor_user_id, table_name, row_id, action, before, after, ip, created_at)
    SELECT
      gen_random_uuid(),
      NULL,
      'guard_staff_numbers',
      guard_id,
      'migration_skipped_invalid',
      NULL,
      jsonb_build_object('column', col_name, 'raw_normalized', normalized, 'reason', 'invalid-test'),
      NULL,
      now()
    FROM wp_staffno_source
    WHERE normalized !~ '^[A-Z]{1,4}[0-9A-Z-]+$';
  `);
  await tx.$executeRawUnsafe(`DROP TABLE wp_staffno_ranked;`);
  await tx.$executeRawUnsafe(`DROP TABLE wp_staffno_source;`);
}

describe("WP-STAFFNO S3/S4：migration 資料搬遷邏輯（synthetic 8 case，全部唔 abort）", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
  const at = (n: number) => new Date(t0 + n * 1000);

  let guardIds: Record<string, string> = {};

  beforeEach(async () => {
    await clearAll();
    guardIds = {};

    // B：正常 U 號，冇撞號。
    guardIds.B = (await prisma.guard.create({ data: { nameZh: "案例B", employmentType: "cash_casual", staffNo: "U100001", createdAt: at(1) } })).id;
    // C：正常 MG 號。
    guardIds.C = (await prisma.guard.create({ data: { nameZh: "案例C", employmentType: "cash_casual", staffNoMw: "MG200002", createdAt: at(2) } })).id;
    // D：正常 MW 號。
    guardIds.D = (await prisma.guard.create({ data: { nameZh: "案例D", employmentType: "cash_casual", staffNoMw: "MW200003", createdAt: at(3) } })).id;
    // E：格式唔啱（冇字母前綴）。
    guardIds.E = (await prisma.guard.create({ data: { nameZh: "案例E", employmentType: "cash_casual", staffNo: "00500", createdAt: at(4) } })).id;
    // F：同欄撞號（大小寫/空白差異，正規化後相同）——guard F1 較早。
    guardIds.F1 = (await prisma.guard.create({ data: { nameZh: "案例F1", employmentType: "cash_casual", staffNo: "U90000", createdAt: at(10) } })).id;
    guardIds.F2 = (await prisma.guard.create({ data: { nameZh: "案例F2", employmentType: "cash_casual", staffNo: " u90000 ", createdAt: at(11) } })).id;
    // G：跨欄撞號——guard G1（staff_no）較早，guard G2（staff_no_mw）較遲。
    guardIds.G1 = (await prisma.guard.create({ data: { nameZh: "案例G1", employmentType: "cash_casual", staffNo: "MG70000", createdAt: at(20) } })).id;
    guardIds.G2 = (await prisma.guard.create({ data: { nameZh: "案例G2", employmentType: "cash_casual", staffNoMw: "MG70000", createdAt: at(21) } })).id;
    // H：三重撞號。
    guardIds.H1 = (await prisma.guard.create({ data: { nameZh: "案例H1", employmentType: "cash_casual", staffNo: "U80000", createdAt: at(30) } })).id;
    guardIds.H2 = (await prisma.guard.create({ data: { nameZh: "案例H2", employmentType: "cash_casual", staffNo: "u80000", createdAt: at(31) } })).id;
    guardIds.H3 = (await prisma.guard.create({ data: { nameZh: "案例H3", employmentType: "cash_casual", staffNo: " U80000 ", createdAt: at(32) } })).id;
    // K：合法邊界格式（帶連字符）。
    guardIds.K = (await prisma.guard.create({ data: { nameZh: "案例K", employmentType: "cash_casual", staffNo: "MP-001A", createdAt: at(40) } })).id;

    await prisma.$transaction(async (tx) => {
      await runMigrationBackfill(tx);
    });
  });

  it("全部 8 種情況都冇令個 transaction abort（beforeEach 冇拋錯就已經證明）", () => {
    expect(true).toBe(true);
  });

  it("B：正常 U 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.B } });
    expect(row?.scheme).toBe("U");
    expect(row?.number).toBe("U100001");
    expect(row?.status).toBe("current");
  });

  it("C：正常 MG 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.C } });
    expect(row?.scheme).toBe("MG");
    expect(row?.number).toBe("MG200002");
  });

  it("D：正常 MW 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.D } });
    expect(row?.scheme).toBe("MW");
    expect(row?.number).toBe("MW200003");
  });

  it("E：格式唔啱（冇字母前綴）→ 冇新表行，audit_log migration_skipped_invalid，guards.staff_no 原值不變", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.E } });
    expect(row).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.E, action: "migration_skipped_invalid" } });
    expect(logs.length).toBe(1);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.E } });
    expect(guard.staffNo).toBe("00500"); // migration 完全唔郁 guards 表本身嘅值
  });

  it("F：同欄真撞號（大小寫/空白）→ 較早嗰個攞 current，較遲嗰個 skip + audit", async () => {
    const rows = await prisma.guardStaffNumber.findMany({ where: { number: "U90000" } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.guardId).toBe(guardIds.F1);
    const skippedRow = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.F2 } });
    expect(skippedRow).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.F2, action: "migration_skipped_duplicate" } });
    expect(logs.length).toBe(1);
  });

  it("G：跨欄撞號（staff_no vs staff_no_mw）→ 較早嗰個攞 current，較遲嗰個 skip + audit", async () => {
    const rows = await prisma.guardStaffNumber.findMany({ where: { number: "MG70000" } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.guardId).toBe(guardIds.G1);
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.G2, action: "migration_skipped_duplicate" } });
    expect(logs.length).toBe(1);
  });

  it("H：三重撞號 → 最早嗰個攞 current，其餘兩個各自 skip + audit（兩條）", async () => {
    const rows = await prisma.guardStaffNumber.findMany({ where: { number: "U80000" } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.guardId).toBe(guardIds.H1);
    const logs = await prisma.auditLog.findMany({
      where: { tableName: "guard_staff_numbers", rowId: { in: [guardIds.H2, guardIds.H3] }, action: "migration_skipped_duplicate" },
    });
    expect(logs.length).toBe(2);
  });

  it("K：帶連字符嘅合法邊界格式 → scheme 擷取啱、一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.K } });
    expect(row?.scheme).toBe("MP");
    expect(row?.number).toBe("MP-001A");
  });

  it("總計：7 行 current（B/C/D/F/G/H/K 各一），4 條 migration_skipped_duplicate，1 條 migration_skipped_invalid", async () => {
    const allGuardIds = Object.values(guardIds);
    const total = await prisma.guardStaffNumber.count({ where: { guardId: { in: allGuardIds } } });
    expect(total).toBe(7);
    const dupLogs = await prisma.auditLog.count({
      where: { tableName: "guard_staff_numbers", rowId: { in: allGuardIds }, action: "migration_skipped_duplicate" },
    });
    expect(dupLogs).toBe(4);
    const invalidLogs = await prisma.auditLog.count({
      where: { tableName: "guard_staff_numbers", rowId: { in: allGuardIds }, action: "migration_skipped_invalid" },
    });
    expect(invalidLogs).toBe(1);
  });
});
