// 應修 3（Opus 驗收覆核）：`prisma/migrations/
// 20260920010000_p0_backfill_guard_default_broker/migration.sql`（連同
// dev `db:seed` 嘅對等版本 `scripts/seed/lib/backfill-broker-p0.ts`
// `backfillGuardDefaultBrokerBroaderP0()`）之前冇理會 `brokers.status`
// ——已停用（`status='inactive'`）嘅結算單位一樣可以被揀嚟做某個安員
// 新嘅 `default_broker_id`，令新月份 fallback 鏈靜靜幫佢揀一個而家已經
// 唔再用嘅雞頭。而家兩邊都要求 `status='active'`（`internal_longterm`
// fallback 同理）。
//
// 呢個 migration 本身係一次性 SQL，冇得直接 import 做 function 測——
// 跟 tests/wp-staffno-migration.test.ts 嘅 pattern：呢度用 synthetic
// broker／guard／shift_record 資料，喺 `prisma.$transaction()`
// （single connection）入面**逐字重跑一次同一段 SQL**驗證邏輯。呢段
// SQL 常數要同 migration.sql 保持逐字一致——migration.sql 改咗呢段
// 邏輯，呢度都要跟住改。
//
// `backfillGuardDefaultBrokerBroaderP0()` 就直接 import function 測
// （dev-seed 用嗰個，可以直接 call）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import type { Prisma } from "@prisma/client";
import { backfillGuardDefaultBrokerBroaderP0 } from "../scripts/seed/lib/backfill-broker-p0";

// 逐字對照 prisma/migrations/20260920010000_p0_backfill_guard_default_broker/
// migration.sql（應修 3 之後嘅版本——`guard_broker_counts` JOIN
// brokers 加 `status='active'`；`internal_longterm_broker` 加
// `status='active'`）。
async function runP0BackfillMigration(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`
    WITH guard_broker_counts AS (
      SELECT
        sr."guard_id" AS guard_id,
        sr."settlement_broker_id" AS broker_id,
        COUNT(*) AS cnt,
        MAX(sr."work_date") AS latest_date
      FROM "shift_records" sr
      JOIN "brokers" b ON b."id" = sr."settlement_broker_id"
      WHERE sr."status" <> 'cancelled'
        AND sr."settlement_broker_id" IS NOT NULL
        AND b."status" = 'active'
      GROUP BY sr."guard_id", sr."settlement_broker_id"
    ),
    guard_top_broker AS (
      SELECT DISTINCT ON (guard_id)
        guard_id,
        broker_id
      FROM guard_broker_counts
      ORDER BY guard_id, cnt DESC, latest_date DESC, broker_id ASC
    ),
    internal_longterm_broker AS (
      SELECT "id" FROM "brokers" WHERE "kind" = 'internal_longterm' AND "status" = 'active' ORDER BY "code" ASC LIMIT 1
    ),
    guard_backfill AS (
      SELECT
        g."id" AS guard_id,
        COALESCE(
          gtb.broker_id,
          CASE
            WHEN g."employment_type" = 'longterm_autopay' THEN (SELECT "id" FROM internal_longterm_broker)
            ELSE NULL
          END
        ) AS new_broker_id
      FROM "guards" g
      LEFT JOIN guard_top_broker gtb ON gtb.guard_id = g."id"
      WHERE g."default_broker_id" IS NULL
    ),
    updated AS (
      UPDATE "guards" g
      SET "default_broker_id" = gb.new_broker_id
      FROM guard_backfill gb
      WHERE g."id" = gb.guard_id
        AND gb.new_broker_id IS NOT NULL
      RETURNING g."id" AS guard_id, gb.new_broker_id AS new_broker_id
    )
    INSERT INTO "audit_log" ("id", "actor_user_id", "table_name", "row_id", "action", "before", "after", "ip", "created_at")
    SELECT
      md5(random()::text || clock_timestamp()::text || u.guard_id::text || 'default_broker_backfill')::uuid,
      NULL,
      'guards',
      u.guard_id,
      'migration_backfill_default_broker',
      jsonb_build_object('default_broker_id', NULL),
      jsonb_build_object('default_broker_id', u.new_broker_id),
      NULL,
      CURRENT_TIMESTAMP
    FROM updated u;
  `);
}

async function makeSiteAndShiftType() {
  const site = await prisma.site.create({
    data: { canonicalName: `測試盤-應修3-${Date.now()}-${Math.random()}`, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:p0-backfill" },
  });
  const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "夜更", hours: 12, createdBy: "test:p0-backfill" } });
  return { site, shiftType };
}

describe("應修 3：migration.sql（逐字重跑）——已停用嘅結算單位唔會俾揀做 backfill 候選", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("guard 有 3 條已停用 broker 記錄＋1 條 active broker 記錄——揀返 active 嗰個（就算次數少）", async () => {
    const { site, shiftType } = await makeSiteAndShiftType();
    const brokerActive = await prisma.broker.create({
      data: { code: "ZA1", name: "測試雞頭-active", kind: "broker", settlementType: "cash", status: "active", createdBy: "test:p0-backfill" },
    });
    const brokerInactive = await prisma.broker.create({
      data: { code: "ZI1", name: "測試雞頭-inactive", kind: "broker", settlementType: "cash", status: "inactive", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-A", employmentType: "cash_casual", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.shiftRecord.create({
        data: {
          siteId: site.id,
          shiftTypeId: shiftType.id,
          guardId: guard.id,
          workDate: new Date(Date.UTC(2026, 6, 1 + i)),
          settlementBrokerId: brokerInactive.id,
          operationalBrokerId: brokerInactive.id,
          recordType: "shift",
          status: "confirmed",
          createdBy: "test:p0-backfill",
        },
      });
    }
    await prisma.shiftRecord.create({
      data: {
        siteId: site.id,
        shiftTypeId: shiftType.id,
        guardId: guard.id,
        workDate: new Date(Date.UTC(2026, 6, 10)),
        settlementBrokerId: brokerActive.id,
        operationalBrokerId: brokerActive.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test:p0-backfill",
      },
    });

    await prisma.$transaction((tx) => runP0BackfillMigration(tx));

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBe(brokerActive.id); // 唔係次數較多嘅 brokerInactive

    const log = await prisma.auditLog.findFirst({ where: { rowId: guard.id, action: "migration_backfill_default_broker" } });
    expect(log).toBeTruthy();
    expect((log!.after as Record<string, unknown>).default_broker_id).toBe(brokerActive.id);
  });

  it("guard 淨係得已停用 broker 嘅記錄、又唔係長工——保持 NULL（唔臆測）", async () => {
    const { site, shiftType } = await makeSiteAndShiftType();
    const brokerInactive = await prisma.broker.create({
      data: { code: "ZI2", name: "測試雞頭-inactive2", kind: "broker", settlementType: "cash", status: "inactive", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-B", employmentType: "cash_casual", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });
    await prisma.shiftRecord.create({
      data: {
        siteId: site.id,
        shiftTypeId: shiftType.id,
        guardId: guard.id,
        workDate: new Date(Date.UTC(2026, 6, 1)),
        settlementBrokerId: brokerInactive.id,
        operationalBrokerId: brokerInactive.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test:p0-backfill",
      },
    });

    await prisma.$transaction((tx) => runP0BackfillMigration(tx));

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBeNull();
    const log = await prisma.auditLog.findFirst({ where: { rowId: guard.id, action: "migration_backfill_default_broker" } });
    expect(log).toBeNull();
  });

  it("長工（longterm_autopay）、冇任何記錄，DB 入面淨係得已停用嘅 internal_longterm broker——保持 NULL（唔揀第二個）", async () => {
    await prisma.broker.create({
      data: { code: "ZL1", name: "測試內部長工-inactive", kind: "internal_longterm", settlementType: "salary", status: "inactive", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-C", employmentType: "longterm_autopay", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });

    await prisma.$transaction((tx) => runP0BackfillMigration(tx));

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBeNull();
  });

  it("對照組：長工、冇任何記錄，有 active 嘅 internal_longterm broker——照舊 backfill 到（證明應修 3 冇整壞正常情況）", async () => {
    const brokerLongtermActive = await prisma.broker.create({
      data: { code: "ZL2", name: "測試內部長工-active", kind: "internal_longterm", settlementType: "salary", status: "active", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-D", employmentType: "longterm_autopay", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });

    await prisma.$transaction((tx) => runP0BackfillMigration(tx));

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBe(brokerLongtermActive.id);
  });
});

describe("應修 3：backfillGuardDefaultBrokerBroaderP0()（dev db:seed 對等版本）——同一組 inactive 案例", () => {
  beforeEach(async () => {
    await clearAll();
  });

  it("guard 有已停用 broker 嘅記錄（次數多）＋active broker 嘅記錄（次數少）——揀 active，stats.backfilledFromHistory=1", async () => {
    const { site, shiftType } = await makeSiteAndShiftType();
    const brokerActive = await prisma.broker.create({
      data: { code: "ZA3", name: "測試雞頭-active3", kind: "broker", settlementType: "cash", status: "active", createdBy: "test:p0-backfill" },
    });
    const brokerInactive = await prisma.broker.create({
      data: { code: "ZI3", name: "測試雞頭-inactive3", kind: "broker", settlementType: "cash", status: "inactive", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-E", employmentType: "cash_casual", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });
    for (let i = 0; i < 2; i++) {
      await prisma.shiftRecord.create({
        data: {
          siteId: site.id,
          shiftTypeId: shiftType.id,
          guardId: guard.id,
          workDate: new Date(Date.UTC(2026, 6, 1 + i)),
          settlementBrokerId: brokerInactive.id,
          operationalBrokerId: brokerInactive.id,
          recordType: "shift",
          status: "confirmed",
          createdBy: "test:p0-backfill",
        },
      });
    }
    await prisma.shiftRecord.create({
      data: {
        siteId: site.id,
        shiftTypeId: shiftType.id,
        guardId: guard.id,
        workDate: new Date(Date.UTC(2026, 6, 10)),
        settlementBrokerId: brokerActive.id,
        operationalBrokerId: brokerActive.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test:p0-backfill",
      },
    });

    const stats = await backfillGuardDefaultBrokerBroaderP0(prisma);
    expect(stats.backfilledFromHistory).toBe(1);
    expect(stats.stillNull).toBe(0);

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBe(brokerActive.id);
  });

  it("長工、冇記錄、淨係得已停用 internal_longterm broker——stats.stillNull=1，defaultBrokerId 保持 NULL", async () => {
    await prisma.broker.create({
      data: { code: "ZL3", name: "測試內部長工-inactive3", kind: "internal_longterm", settlementType: "salary", status: "inactive", createdBy: "test:p0-backfill" },
    });
    const guard = await prisma.guard.create({
      data: { nameZh: "測試安員-應修3-F", employmentType: "longterm_autopay", defaultBrokerId: null, createdBy: "test:p0-backfill" },
    });

    const stats = await backfillGuardDefaultBrokerBroaderP0(prisma);
    expect(stats.stillNull).toBe(1);
    expect(stats.backfilledLongtermFallback).toBe(0);

    const after = await prisma.guard.findUniqueOrThrow({ where: { id: guard.id } });
    expect(after.defaultBrokerId).toBeNull();
  });
});
