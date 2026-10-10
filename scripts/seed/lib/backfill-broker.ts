// S6（Opus 對抗式驗收）：guards.default_broker_id backfill——WP1 seed 一直
// 冇填呢個欄（`seedGuards()` 淨係讀 CSV 現成嘅 employment_type 等，冇
// default_broker_id 呢一欄嘅來源），令 C1 嘅 broker-isolation 邏輯
// （`scopeGuardWhere` 靠 default_broker_id 做主要判斷）喺真實 7 月數據
// 度冇料到——雞頭登入之後見唔到自己啲人，因為 database 入面冇任何 guard
// 嘅 default_broker_id 有值。
//
// 規則：7 月該保安員 settlement broker（kind=broker，即係外判雞頭，唔計
// internal_cash/internal_longterm/external/special）出現最多嗰個，就係
// 佢嘅 default_broker_id；淨係喺 internal 或 external（kind=
// internal_cash/internal_longterm/external/special）出過更嘅人，冇雞頭
// 證據，backfill 唔到，留 null（唔係 bug，係冇對應嘅外判雞頭——A5，
// Opus 對抗式驗收第三輪：字眼統一做「internal 或 external，冇雞頭
// 證據」，唔再用具體例子）。
import type { PrismaClient } from "@prisma/client";

export interface BackfillStats {
  totalGuards: number;
  backfilled: number;
  nullNoBrokerKindEvidence: number;
}

export async function backfillDefaultBrokerId(prisma: PrismaClient): Promise<BackfillStats> {
  const brokers = await prisma.broker.findMany({ select: { id: true, kind: true } });
  const brokerKindById = new Map(brokers.map((b) => [b.id, b.kind]));

  const records = await prisma.shiftRecord.findMany({
    where: { settlementBrokerId: { not: null } },
    select: { guardId: true, settlementBrokerId: true },
  });

  // guardId -> brokerId -> count
  const counts = new Map<string, Map<string, number>>();
  for (const r of records) {
    const brokerId = r.settlementBrokerId!;
    if (brokerKindById.get(brokerId) !== "broker") continue; // 淨係計外判雞頭，唔計 internal_cash/salary/external
    let byBroker = counts.get(r.guardId);
    if (!byBroker) {
      byBroker = new Map();
      counts.set(r.guardId, byBroker);
    }
    byBroker.set(brokerId, (byBroker.get(brokerId) ?? 0) + 1);
  }

  const guards = await prisma.guard.findMany({ select: { id: true, defaultBrokerId: true } });
  let backfilled = 0;
  let nullNoEvidence = 0;
  for (const g of guards) {
    if (g.defaultBrokerId) continue; // 已經有值就唔覆蓋（尊重任何未來嘅明確來源）
    const byBroker = counts.get(g.id);
    if (!byBroker || byBroker.size === 0) {
      nullNoEvidence++;
      continue;
    }
    // 揀出現次數最多嗰個（同票揀 brokerId 字典序最細嗰個，保證 deterministic）
    let bestBrokerId: string | null = null;
    let bestCount = -1;
    for (const [brokerId, count] of [...byBroker.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (count > bestCount) {
        bestCount = count;
        bestBrokerId = brokerId;
      }
    }
    if (bestBrokerId) {
      await prisma.guard.update({ where: { id: g.id }, data: { defaultBrokerId: bestBrokerId } });
      backfilled++;
    } else {
      nullNoEvidence++;
    }
  }

  return { totalGuards: guards.length, backfilled, nullNoBrokerKindEvidence: nullNoEvidence };
}
