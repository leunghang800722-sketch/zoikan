import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("schema 約束（Prisma schema v1.1）", () => {
  it("brokers.code unique", async () => {
    await prisma.broker.create({ data: { code: "X1", name: "假雞頭1", kind: "broker", settlementType: "cash" } });
    await expect(
      prisma.broker.create({ data: { code: "X1", name: "假雞頭2", kind: "broker", settlementType: "cash" } }),
    ).rejects.toThrow();
  });

  it("sites.canonical_name unique", async () => {
    await prisma.site.create({ data: { canonicalName: "唯一盤", clientName: "客", billingModel: "per_shift" } });
    await expect(
      prisma.site.create({ data: { canonicalName: "唯一盤", clientName: "客", billingModel: "per_shift" } }),
    ).rejects.toThrow();
  });

  it("guards.staff_no nullable unique：兩個空值容許，但重複實值唔容許", async () => {
    await prisma.guard.create({ data: { nameZh: "甲", employmentType: "cash_casual" } });
    await prisma.guard.create({ data: { nameZh: "乙", employmentType: "cash_casual" } }); // 兩個 null staff_no 都得
    await prisma.guard.create({ data: { staffNo: "U99999", nameZh: "丙", employmentType: "cash_casual" } });
    await expect(
      prisma.guard.create({ data: { staffNo: "U99999", nameZh: "丁", employmentType: "cash_casual" } }),
    ).rejects.toThrow();
  });

  it("shift_records unique(guard_id, work_date, shift_type_id)——硬性規則2", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "S-uniq", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試", employmentType: "cash_casual" } });
    await prisma.shiftRecord.create({
      data: { workDate: new Date(Date.UTC(2026, 6, 1)), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, recordType: "shift" },
    });
    await expect(
      prisma.shiftRecord.create({
        data: { workDate: new Date(Date.UTC(2026, 6, 1)), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, recordType: "shift" },
      }),
    ).rejects.toThrow();
  });

  it("金額用 Decimal(12,2)，唔會有浮點誤差", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "S-decimal", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試", employmentType: "cash_casual" } });
    const rec = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 1)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: guard.id,
        recordType: "shift",
        clientRateSnapshot: 870.97, // 凱和山實證數值：27000/31=870.967741...，schema 要四捨五入到 12,2
      },
    });
    expect(rec.clientRateSnapshot?.toString()).toBe("870.97");
  });

  it("audit_log 只寫入：DB trigger 拒絕 UPDATE / DELETE", async () => {
    const log = await prisma.auditLog.create({
      data: { tableName: "guards", rowId: "fake-id", action: "create", after: { nameZh: "測試" } },
    });
    await expect(
      prisma.auditLog.update({ where: { id: log.id }, data: { action: "update" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });

  it("audit_log 只寫入：statement-level trigger 拒絕 TRUNCATE", async () => {
    await prisma.auditLog.create({
      data: { tableName: "guards", rowId: "fake-id-2", action: "create", after: { nameZh: "測試" } },
    });
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_log"')).rejects.toThrow(/append-only/);
  });

  it("work_date 用 @db.Date（唔受時區影響，讀返嚟仍然係嗰個曆日）", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "S-date", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試", employmentType: "cash_casual" } });
    const rec = await prisma.shiftRecord.create({
      data: { workDate: new Date(Date.UTC(2026, 6, 31)), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, recordType: "shift" },
    });
    expect(rec.workDate.toISOString().slice(0, 10)).toBe("2026-07-31");
  });
});
