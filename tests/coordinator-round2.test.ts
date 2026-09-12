// 規劃 session 第二輪決定（2026-09-11）嘅測試覆蓋：
// item 1 operational≠settlement、item 2 referral 預設費率 fallback、
// item 4 rate_cards 補價唔留 null、item 6 shift_types 三聯唯一約束。
// 全部假數據 fixture，唔碰真實 7 月數據（PDPO）。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import {
  settlementUnitToBrokerCsvId,
  MASTER_BROKER_CODE_TO_BROKER_CSV_ID,
} from "../scripts/seed/lib/mapping";
import { settlementUnitAliasMap } from "../scripts/seed/lib/broker-names";

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("item 1：operational_broker_id / settlement_broker_id 對照表", () => {
  // PDPO：呢個測試唔可以硬編碼雞頭真名——淨係斷言 4 個非 PII 嘅安全 key，
  // 同（如果私隱檔存在）B01-B05 代號有對應嘅 alias，唔斷言真名字串本身。
  it("settlement_unit 對照表覆蓋晒 4 個非 PII 嘅安全 key（有一個承辦商冇對應 broker 實體，屬已知落差）", () => {
    const map = settlementUnitToBrokerCsvId();
    const safeCovered = ["公司兵", "LINK公司兵", "autopay_longterm", "external"];
    for (const k of safeCovered) {
      expect(map[k]).toBeDefined();
    }
  });

  it("私隱檔存在時，5 個外判雞頭代號（B01-B05）都有真名 alias 對照（唔斷言實際真名字串）", () => {
    const aliasMap = settlementUnitAliasMap();
    if (Object.keys(aliasMap).length === 0) {
      // 冇 data/mappings-private/brokers.csv（例如 CI／未授權環境）——
      // 已知限制，唔係 bug，跳過。
      return;
    }
    const mappedIds = new Set(Object.values(aliasMap));
    for (const id of ["B01", "B02", "B03", "B04", "B05"]) {
      expect(mappedIds.has(id)).toBe(true);
    }
  });

  it("master_broker_code K/W/Y/T/D/G 對得返 brokers.csv 嘅代號（代號本身唔係 PII）", () => {
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.K).toBe("B01");
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.W).toBe("B02");
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.Y).toBe("B06");
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.T).toBe("B05");
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.D).toBe("B04");
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.G).toBe("B03");
    // LT／空白唔喺呢個表——跌返用 settlement_unit（seed script 嘅 fallback 邏輯）
    expect(MASTER_BROKER_CODE_TO_BROKER_CSV_ID.LT).toBeUndefined();
  });

  it("schema 層面支援 settlement_broker_id ≠ operational_broker_id（硬性規則4嘅資料形狀）", async () => {
    const brokerCash = await prisma.broker.create({ data: { code: "T-CASH", name: "測試現金雞頭", kind: "broker", settlementType: "cash" } });
    const brokerLT = await prisma.broker.create({ data: { code: "T-LT", name: "測試autopay桶", kind: "internal_longterm", settlementType: "autopay" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試operational盤", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工", employmentType: "longterm_autopay", monthlySalary: 20000 } });
    const rec = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 1)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: guard.id,
        recordType: "shift",
        settlementBrokerId: brokerLT.id, // 出糧：autopay
        operationalBrokerId: brokerCash.id, // 總表成本桶：現金雞頭（Q10 情境）
      },
    });
    expect(rec.settlementBrokerId).not.toBe(rec.operationalBrokerId);
  });
});

describe("item 2：referral_fee_rates site_id nullable（預設費率）", () => {
  it("site_id=null 代表該雞頭全盤預設費率，有 site_id 嘅行可以覆蓋", async () => {
    const broker = await prisma.broker.create({ data: { code: "T-REF", name: "測試雞頭", kind: "broker", settlementType: "cash" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試盤-referral", clientName: "客", billingModel: "per_shift" } });
    const month = new Date(Date.UTC(2026, 6, 1));

    const defaultRate = await prisma.referralFeeRate.create({
      data: { brokerId: broker.id, siteId: null, month, feePerShift: 30 },
    });
    const overrideRate = await prisma.referralFeeRate.create({
      data: { brokerId: broker.id, siteId: site.id, month, feePerShift: 60 },
    });
    expect(defaultRate.siteId).toBeNull();
    expect(overrideRate.siteId).toBe(site.id);
    expect(Number(overrideRate.feePerShift)).toBeGreaterThan(Number(defaultRate.feePerShift));
  });

  it("同一 broker+month 淨係得一行 site_id=null 嘅預設（partial unique index）", async () => {
    const broker = await prisma.broker.create({ data: { code: "T-REF2", name: "測試雞頭2", kind: "broker", settlementType: "cash" } });
    const month = new Date(Date.UTC(2026, 6, 1));
    await prisma.referralFeeRate.create({ data: { brokerId: broker.id, siteId: null, month, feePerShift: 30 } });
    await expect(
      prisma.referralFeeRate.create({ data: { brokerId: broker.id, siteId: null, month, feePerShift: 40 } }),
    ).rejects.toThrow();
  });
});

describe("item 4：shift_records 唔准留 null 嘅價（有對應 rate_cards 就補）", () => {
  it("schema 支援由 rate_cards 補返 shift_record 嘅 snapshot（雞頭專屬價）", async () => {
    const broker = await prisma.broker.create({ data: { code: "T-EVT", name: "測試雞頭Event", kind: "broker", settlementType: "cash" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試Event盤", clientName: "客", billingModel: "per_shift" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "Event", label: "Event Guard" } });
    await prisma.rateCard.create({
      data: {
        siteId: site.id,
        shiftTypeId: st.id,
        brokerId: broker.id,
        guardWage: 1080,
        brokerFee: 0,
        payoutRate: 1080,
        billingModel: "per_shift",
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      },
    });
    // 模擬 seed 嘅 fallback：搵返呢張卡嘅 guard_wage 填入 shift_record
    const card = await prisma.rateCard.findFirstOrThrow({ where: { siteId: site.id, shiftTypeId: st.id, brokerId: broker.id } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試EventGuard", employmentType: "cash_casual" } });
    const rec = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 6, 1)),
        siteId: site.id,
        shiftTypeId: st.id,
        guardId: guard.id,
        recordType: "shift",
        settlementBrokerId: broker.id,
        operationalBrokerId: broker.id,
        guardWageSnapshot: card.guardWage,
        brokerFeeSnapshot: card.brokerFee,
      },
    });
    expect(rec.guardWageSnapshot).not.toBeNull();
    expect(Number(rec.guardWageSnapshot)).toBe(1080);
  });
});

describe("item 6：shift_types UNIQUE(site_id, code, start_time)", () => {
  it("同一盤同一code同一時段唔准撞", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試ShiftType撞key", clientName: "客", billingModel: "per_shift" } });
    const startTime = new Date(Date.UTC(1970, 0, 1, 19, 30));
    await prisma.shiftType.create({ data: { siteId: site.id, code: "MR-Night", startTime } });
    await expect(
      prisma.shiftType.create({ data: { siteId: site.id, code: "MR-Night", startTime } }),
    ).rejects.toThrow();
  });

  it("加個數字尾綴（MR-Night-2）就唔撞——seed script 嘅 dedup 策略", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試ShiftType-dedup", clientName: "客", billingModel: "per_shift" } });
    const startTime = new Date(Date.UTC(1970, 0, 1, 19, 30));
    await prisma.shiftType.create({ data: { siteId: site.id, code: "MR-Night", startTime } });
    const second = await prisma.shiftType.create({ data: { siteId: site.id, code: "MR-Night-2", startTime } });
    expect(second.code).toBe("MR-Night-2");
  });
});
