// WP-STAFFNO S3/S4（Opus 驗收修復）＋Opus 驗收第二輪必修 1a／應修 3＋
// Opus 驗收第三輪必修 5：migration.sql 「(1) 甲／乙類到期日 backfill」
// 「(3) 資料搬遷」兩段嘅邏輯——原本一撞號就 RAISE EXCEPTION 中止成個
// migration，而家改做「唔 abort，兜底處理＋audit_log 留底」；甲／乙類
// 到期日 backfill 係第二輪新加，唔加就會令 `deriveSiaPermitExpiry()`
// 喺 a／b 都 null 嗰陣計出 {null,null}，永久毀走舊 `sia_permit_expiry`
// 資料。呢個 migration 本身係一次性 SQL（prisma/migrations/
// 20260919064514_wp_staffno/migration.sql），冇得直接 import 做
// function 測——呢個 test 用 synthetic guard 資料（虛構工號，PDPO 安全）
// ＋喺 `prisma.$transaction()`（single connection，保證 temp table 喺
// 同一個 tx 內跨幾個 `$executeRawUnsafe` call 都見到）入面**逐字重跑一次
// 同一段 SQL**嚟驗證邏輯，唔係直接測真 migration 執行結果（真 migration
// 已經喺 `npx prisma migrate deploy`／`db:reset` 果陣跑咗）。
//
// 下面呢兩段 SQL 常數要同 migration.sql「(1)」「(3)」保持逐字一致——
// migration.sql 改咗呢段邏輯，呢度都要跟住改，唔係就呢個 test 淨係測緊
// 一個舊版邏輯嘅分身，冇意義。
//
// 「(3) 資料搬遷」覆蓋 11 種情況（跟 Opus 驗收畀嘅 B/C/D/E/F/G/H/K 標籤，
// L/M 係第二輪應修 3 新加，N 係第三輪必修 5 新加）：
//   B：正常 staff_no（U 開頭，冇撞號）
//   C：正常 staff_no_mw（MG 開頭，冇撞號）
//   D：正常 staff_no_mw（MW 開頭，冇撞號）
//   E：staff_no 格式唔啱（冇字母前綴）→ skip + migration_skipped_invalid
//   F：兩個唔同 guard，staff_no 正規化後相同（大小寫/空白差異）→ 真撞號
//   G：跨欄撞號（一個 guard 嘅 staff_no 撞正另一個 guard 嘅 staff_no_mw）
//   H：三重撞號（三個 guard 正規化後全部相同）
//   K：帶連字符嘅合法值（邊界格式）
//   L（應修 3 新加）：開頭連續大寫字母 >4 位（例如 "ABCDE123"）——`[0-9A-
//      Z-]` 呢個字符類本身都包含字母，一個唔對齊 app `schemeFromNumber()`
//      嘅 regex 會將 "ABCDE123" 誤判做 scheme="ABCD"+number 尾段"E123"，
//      而家一定要 skip + migration_skipped_invalid。
//   M（應修 3 新加）：scheme 後跟嘅部分超過 16 位——舊版 regex 冇上限會
//      誤收，而家一定要 skip + migration_skipped_invalid（對齊
//      `STAFF_NUMBER_NUMBER_RE` 嘅 `{1,16}`）。
//   N（必修 5 新加）：staff_no 中間夾一個 NBSP（U+00A0，唔係普通 ASCII
//      空格）——Postgres `\s`（ARE）唔包 NBSP，舊版正規化 regex 除唔到，
//      而家 `'[\s<NBSP>]+'` 呢個字符類先除得走，同 app 層
//      `normalizeStaffNumber()`（JS `\s` 本身已經包含 NBSP）對齊。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import type { Prisma } from "@prisma/client";

// 逐字對照 prisma/migrations/20260919064514_wp_staffno/migration.sql
// 「(3) 資料搬遷」段——JS 字串入面 `\s` 要寫做 `\\s`（唔係 SQL 本身嘅
// 分別，係 JS string literal 會靜靜哋剝走冇特殊意義嘅 `\X` 逃逸嘅
// backslash，唔寫雙斜要就會送咗個 "s+" 落 Postgres）。必修 5：`\\s` 之後
// 嗰個字符係一個 literal NBSP（U+00A0），唔係打漏嘅普通空格。
async function runMigrationBackfill(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE wp_staffno_source AS
    SELECT
      id AS guard_id,
      created_at,
      'staff_no' AS col_name,
      UPPER(REGEXP_REPLACE(TRIM(staff_no), '[\\s ]+', '', 'g')) AS normalized
    FROM guards
    WHERE staff_no IS NOT NULL AND TRIM(staff_no) <> ''
    UNION ALL
    SELECT
      id,
      created_at,
      'staff_no_mw',
      UPPER(REGEXP_REPLACE(TRIM(staff_no_mw), '[\\s ]+', '', 'g'))
    FROM guards
    WHERE staff_no_mw IS NOT NULL AND TRIM(staff_no_mw) <> '';
  `);
  await tx.$executeRawUnsafe(`
    ALTER TABLE wp_staffno_source ADD COLUMN scheme TEXT;
  `);
  await tx.$executeRawUnsafe(`
    UPDATE wp_staffno_source SET scheme = (regexp_match(normalized, '^([A-Z]+)'))[1];
  `);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE wp_staffno_ranked AS
    SELECT
      guard_id,
      col_name,
      normalized,
      scheme,
      ROW_NUMBER() OVER (PARTITION BY normalized ORDER BY created_at ASC, guard_id ASC, col_name ASC) AS rn
    FROM wp_staffno_source
    WHERE scheme IS NOT NULL
      AND length(scheme) BETWEEN 1 AND 4
      AND normalized ~ ('^' || scheme || '[0-9A-Z-]{1,16}$');
  `);
  await tx.$executeRawUnsafe(`
    INSERT INTO "guard_staff_numbers" (id, guard_id, scheme, number, status, source, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      guard_id,
      scheme,
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
    WHERE scheme IS NULL
      OR length(scheme) NOT BETWEEN 1 AND 4
      OR normalized !~ ('^' || scheme || '[0-9A-Z-]{1,16}$');
  `);
  await tx.$executeRawUnsafe(`DROP TABLE wp_staffno_ranked;`);
  await tx.$executeRawUnsafe(`DROP TABLE wp_staffno_source;`);
}

describe("WP-STAFFNO S3/S4/應修3/必修5：migration 資料搬遷邏輯（synthetic 11 case，全部唔 abort）", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
  const at = (n: number) => new Date(t0 + n * 1000);

  let guardIds: Record<string, string> = {};

  beforeEach(async () => {
    await clearAll();
    guardIds = {};

    // B：正常 U 號，冇撞號。
    guardIds.B = (await prisma.guard.create({ data: { nameZh: "案例B", employmentType: "cash_casual", staffNo: "U900001", createdAt: at(1) } })).id;
    // C：正常 MG 號。
    guardIds.C = (await prisma.guard.create({ data: { nameZh: "案例C", employmentType: "cash_casual", staffNoMw: "MG900002", createdAt: at(2) } })).id;
    // D：正常 MW 號。
    guardIds.D = (await prisma.guard.create({ data: { nameZh: "案例D", employmentType: "cash_casual", staffNoMw: "MW900003", createdAt: at(3) } })).id;
    // E：格式唔啱（冇字母前綴）。
    guardIds.E = (await prisma.guard.create({ data: { nameZh: "案例E", employmentType: "cash_casual", staffNo: "00500", createdAt: at(4) } })).id;
    // F：同欄撞號（大小寫/空白差異，正規化後相同）——guard F1 較早。
    guardIds.F1 = (await prisma.guard.create({ data: { nameZh: "案例F1", employmentType: "cash_casual", staffNo: "U90000", createdAt: at(10) } })).id;
    guardIds.F2 = (await prisma.guard.create({ data: { nameZh: "案例F2", employmentType: "cash_casual", staffNo: " u90000 ", createdAt: at(11) } })).id;
    // G：跨欄撞號——guard G1（staff_no）較早，guard G2（staff_no_mw）較遲。
    guardIds.G1 = (await prisma.guard.create({ data: { nameZh: "案例G1", employmentType: "cash_casual", staffNo: "MG90000", createdAt: at(20) } })).id;
    guardIds.G2 = (await prisma.guard.create({ data: { nameZh: "案例G2", employmentType: "cash_casual", staffNoMw: "MG90000", createdAt: at(21) } })).id;
    // H：三重撞號。
    guardIds.H1 = (await prisma.guard.create({ data: { nameZh: "案例H1", employmentType: "cash_casual", staffNo: "U98000", createdAt: at(30) } })).id;
    guardIds.H2 = (await prisma.guard.create({ data: { nameZh: "案例H2", employmentType: "cash_casual", staffNo: "u98000", createdAt: at(31) } })).id;
    guardIds.H3 = (await prisma.guard.create({ data: { nameZh: "案例H3", employmentType: "cash_casual", staffNo: " U98000 ", createdAt: at(32) } })).id;
    // K：合法邊界格式（帶連字符）。
    guardIds.K = (await prisma.guard.create({ data: { nameZh: "案例K", employmentType: "cash_casual", staffNo: "MP-001A", createdAt: at(40) } })).id;
    // L（應修 3）：開頭連續大寫字母 >4 位——"ABCDE123" 頭 5 位全部係字母，
    // 對齊 schemeFromNumber() 一定係 invalid，唔可以誤判做 scheme="ABCD"。
    guardIds.L = (await prisma.guard.create({ data: { nameZh: "案例L", employmentType: "cash_casual", staffNo: "ABCDE123", createdAt: at(50) } })).id;
    // M（應修 3）：scheme 後面跟住 17 位（>16 上限）——"U" + 17 位數字。
    guardIds.M = (await prisma.guard.create({ data: { nameZh: "案例M", employmentType: "cash_casual", staffNo: `U${"1".repeat(17)}`, createdAt: at(60) } }))
      .id;
    // N（必修 5）：staff_no 中間夾一個 NBSP（U+00A0）——正規化之後要係
    // "U90004"，冇任何空白／NBSP 殘留。
    guardIds.N = (await prisma.guard.create({ data: { nameZh: "案例N", employmentType: "cash_casual", staffNo: "U 90004", createdAt: at(70) } })).id;

    await prisma.$transaction(async (tx) => {
      await runMigrationBackfill(tx);
    });
  });

  it("全部 11 種情況都冇令個 transaction abort（beforeEach 冇拋錯就已經證明）", () => {
    expect(true).toBe(true);
  });

  it("B：正常 U 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.B } });
    expect(row?.scheme).toBe("U");
    expect(row?.number).toBe("U900001");
    expect(row?.status).toBe("current");
  });

  it("C：正常 MG 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.C } });
    expect(row?.scheme).toBe("MG");
    expect(row?.number).toBe("MG900002");
  });

  it("D：正常 MW 號 → 一行 current", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.D } });
    expect(row?.scheme).toBe("MW");
    expect(row?.number).toBe("MW900003");
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
    const rows = await prisma.guardStaffNumber.findMany({ where: { number: "MG90000" } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.guardId).toBe(guardIds.G1);
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.G2, action: "migration_skipped_duplicate" } });
    expect(logs.length).toBe(1);
  });

  it("H：三重撞號 → 最早嗰個攞 current，其餘兩個各自 skip + audit（兩條）", async () => {
    const rows = await prisma.guardStaffNumber.findMany({ where: { number: "U98000" } });
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

  it("L（應修3）：開頭連續字母 >4 位（\"ABCDE123\"）→ 冇新表行、skip + audit，唔會誤判做 scheme=\"ABCD\"", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.L } });
    expect(row).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.L, action: "migration_skipped_invalid" } });
    expect(logs.length).toBe(1);
  });

  it("M（應修3）：scheme 後面 17 位（超過 16 位上限）→ 冇新表行、skip + audit", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.M } });
    expect(row).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", rowId: guardIds.M, action: "migration_skipped_invalid" } });
    expect(logs.length).toBe(1);
  });

  it("N（必修5）：staff_no 夾住 NBSP（U+00A0）→ 正規化除得走，一行 current，number 冇任何空白/NBSP 殘留", async () => {
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: guardIds.N } });
    expect(row?.scheme).toBe("U");
    expect(row?.number).toBe("U90004");
  });

  it("總計：8 行 current（B/C/D/F/G/H/K/N 各一），4 條 migration_skipped_duplicate，3 條 migration_skipped_invalid（E/L/M）", async () => {
    const allGuardIds = Object.values(guardIds);
    const total = await prisma.guardStaffNumber.count({ where: { guardId: { in: allGuardIds } } });
    expect(total).toBe(8);
    const dupLogs = await prisma.auditLog.count({
      where: { tableName: "guard_staff_numbers", rowId: { in: allGuardIds }, action: "migration_skipped_duplicate" },
    });
    expect(dupLogs).toBe(4);
    const invalidLogs = await prisma.auditLog.count({
      where: { tableName: "guard_staff_numbers", rowId: { in: allGuardIds }, action: "migration_skipped_invalid" },
    });
    expect(invalidLogs).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Opus 驗收第二輪必修 1(a)(c)／第三輪必修 2：甲／乙類到期日 backfill——
// 逐字對照 migration.sql「(1) 甲／乙類到期日 backfill」段。
//
// 必修 2（Opus 驗收第三輪）：原本規則淨係分「B」定「其餘」（`<> 'B'`
// 就當甲類），而家收窄做「逐字等於 'A'」先入 a 欄——C／D／null／自由
// 文字呢批唔再 backfill，a／b 留 null（規劃師：舊牌照資料除非用戶明確
// 填甲／乙到期日，否則任何一層都唔准改，C／D 唔係「用戶明確填」）。
// ---------------------------------------------------------------------------
async function runPermitBackfill(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`
    UPDATE "guards"
    SET "sia_permit_a_expiry" = "sia_permit_expiry"
    WHERE "sia_permit_expiry" IS NOT NULL
      AND "sia_permit_a_expiry" IS NULL
      AND "sia_permit_b_expiry" IS NULL
      AND UPPER(TRIM(COALESCE("sia_permit_type", ''))) = 'A';
  `);
  await tx.$executeRawUnsafe(`
    UPDATE "guards"
    SET "sia_permit_b_expiry" = "sia_permit_expiry"
    WHERE "sia_permit_expiry" IS NOT NULL
      AND "sia_permit_a_expiry" IS NULL
      AND "sia_permit_b_expiry" IS NULL
      AND UPPER(TRIM(COALESCE("sia_permit_type", ''))) = 'B';
  `);
}

describe("WP-STAFFNO 必修1(a)(c)/必修2：migration 甲／乙類到期日 backfill（synthetic，type A/B/小寫b/帶空白B 會 backfill；C/D/null/自由文字唔會）", () => {
  const expiry = new Date("2027-05-01T00:00:00.000Z");
  let guardIds: Record<string, string> = {};

  beforeEach(async () => {
    await clearAll();
    guardIds = {};
    // type A → 入 a 欄。
    guardIds.typeA = (
      await prisma.guard.create({
        data: { nameZh: "案例typeA", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "A" },
      })
    ).id;
    // type B → 入 b 欄。
    guardIds.typeB = (
      await prisma.guard.create({
        data: { nameZh: "案例typeB", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "B" },
      })
    ).id;
    // type 小寫 " b "（大小寫/空白噪音）→ 正規化後都係 'B'，入 b 欄。
    guardIds.typeLowerB = (
      await prisma.guard.create({
        data: { nameZh: "案例typeLowerB", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: " b " },
      })
    ).id;
    // type 帶空白 "  A  "（純空白噪音，唔涉及大小寫）→ 正規化後都係
    // 'A'，入 a 欄。
    guardIds.typeSpacedA = (
      await prisma.guard.create({
        data: { nameZh: "案例typeSpacedA", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "  A  " },
      })
    ).id;
    // 必修 2：type null（冇填）→ 唔再當「其餘」入 a 欄，而家 a／b 都要
    // 留 null，舊 `sia_permit_expiry`／`sia_permit_type` 原封不動。
    guardIds.typeNull = (
      await prisma.guard.create({
        data: { nameZh: "案例typeNull", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: null },
      })
    ).id;
    // 必修 2：type C（單選白名單其餘值之一）→ 唔再 backfill，a／b 留
    // null。
    guardIds.typeC = (
      await prisma.guard.create({
        data: { nameZh: "案例typeC", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "C" },
      })
    ).id;
    // 必修 2：type D（單選白名單其餘值之一）→ 同上，唔 backfill。
    guardIds.typeD = (
      await prisma.guard.create({
        data: { nameZh: "案例typeD", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "D" },
      })
    ).id;
    // 必修 2：type 自由文字（例如「ABC」，唔屬於單選白名單任何一個值）
    // → 同上，唔 backfill。
    guardIds.typeFreeText = (
      await prisma.guard.create({
        data: { nameZh: "案例typeFreeText", employmentType: "cash_casual", siaPermitExpiry: expiry, siaPermitType: "ABC" },
      })
    ).id;
    // 冇 sia_permit_expiry → 完全唔郁（a/b 一直 null）。
    guardIds.noExpiry = (await prisma.guard.create({ data: { nameZh: "案例noExpiry", employmentType: "cash_casual" } })).id;

    await prisma.$transaction(async (tx) => {
      await runPermitBackfill(tx);
    });
  });

  it("type A → sia_permit_a_expiry 攞到舊值，b 仍然 null", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeA } });
    expect(g.siaPermitAExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitBExpiry).toBeNull();
  });

  it("type B → sia_permit_b_expiry 攞到舊值，a 仍然 null", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeB } });
    expect(g.siaPermitBExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitAExpiry).toBeNull();
  });

  it("type 小寫/帶空白 \" b \" → 正規化後都當 B，入 b 欄", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeLowerB } });
    expect(g.siaPermitBExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitAExpiry).toBeNull();
  });

  it("type 帶空白 \"  A  \" → 正規化後當 A，入 a 欄", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeSpacedA } });
    expect(g.siaPermitAExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitBExpiry).toBeNull();
  });

  it("必修2：type null（冇填）→ 唔 backfill，a／b 都仍然 null，舊 sia_permit_expiry/type 逐字不變", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeNull } });
    expect(g.siaPermitAExpiry).toBeNull();
    expect(g.siaPermitBExpiry).toBeNull();
    expect(g.siaPermitExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitType).toBeNull();
  });

  it("必修2：type C（單選白名單其餘值）→ 唔再誤當甲類，a／b 都仍然 null，舊值逐字不變", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeC } });
    expect(g.siaPermitAExpiry).toBeNull();
    expect(g.siaPermitBExpiry).toBeNull();
    expect(g.siaPermitExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitType).toBe("C");
  });

  it("必修2：type D → 同 C 一致，唔 backfill", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeD } });
    expect(g.siaPermitAExpiry).toBeNull();
    expect(g.siaPermitBExpiry).toBeNull();
    expect(g.siaPermitExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitType).toBe("D");
  });

  it("必修2：type 自由文字（\"ABC\"）→ 同 C/D 一致，唔 backfill", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.typeFreeText } });
    expect(g.siaPermitAExpiry).toBeNull();
    expect(g.siaPermitBExpiry).toBeNull();
    expect(g.siaPermitExpiry?.toISOString()).toBe(expiry.toISOString());
    expect(g.siaPermitType).toBe("ABC");
  });

  it("冇 sia_permit_expiry → a/b 一直 null（backfill 冇嘢好搬）", async () => {
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: guardIds.noExpiry } });
    expect(g.siaPermitAExpiry).toBeNull();
    expect(g.siaPermitBExpiry).toBeNull();
  });

  it("必修2：backfill 之後再跑 recomputePermitDerived()——C/D/null/自由文字呢批 a/b 都 null 嘅 guard 完全唔被觸碰，舊 sia_permit_expiry/type 經 migration+recompute 兩層之後逐字不變", async () => {
    const { recomputePermitDerived } = await import("../scripts/db/recompute-permit-derived");
    const untouchedIds = [guardIds.typeNull, guardIds.typeC, guardIds.typeD, guardIds.typeFreeText];
    const before = await prisma.guard.findMany({ where: { id: { in: untouchedIds } } });
    await recomputePermitDerived();
    const after = await prisma.guard.findMany({ where: { id: { in: untouchedIds } } });
    for (const b of before) {
      const a = after.find((g) => g.id === b.id)!;
      expect(a.siaPermitExpiry?.toISOString()).toBe(b.siaPermitExpiry?.toISOString());
      expect(a.siaPermitType).toBe(b.siaPermitType);
      expect(a.siaPermitAExpiry).toBeNull();
      expect(a.siaPermitBExpiry).toBeNull();
    }
  });
});
