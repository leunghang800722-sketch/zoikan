// P0（Opus 驗收重現，2026-09-20）：`backfillDefaultBrokerId()`（同目錄
// `backfill-broker.ts`，S6 Opus 對抗式驗收）淨係為咗 `scopeGuardWhere()`
// 嘅雞頭隔離用途而設——刻意剔走 internal_cash/internal_longterm/
// external/special（見嗰個檔案頂註解「淨係計外判雞頭」），令長工／
// 公司兵（93/265 個安員）跑完之後 `default_broker_id` 仍然係 NULL。
//
// 但 `default_broker_id` 仲有第二個用途：batch/route.ts、單筆
// POST /api/shift-records 嘅結算單位 fallback 鏈（見
// src/lib/pricing/settlement-broker-fallback.ts）——呢批安員嘅
// `default_broker_id` 一路係 NULL，新月份「複製上月」／新增格如果
// payload 又冇送 settlement_broker_id，就會跌到 fallback 鏈末端，起低
// `settlement_broker_id=NULL` 嘅記錄，令呢批更喺
// `buildPayrollTotals()`（逐 broker 查）完全消失。
//
// 呢個 helper 係*第二層、更闊*嘅 backfill（喺 `backfillDefaultBrokerId()`
// 之後跑，淨係補佢冇補到嘅嗰批）——邏輯逐字對照
// `prisma/migrations/20260920010000_p0_backfill_guard_default_broker/
// migration.sql`（正式站用嗰個 migration，呢度係 dev `db:seed` 嘅對等
// 版本，因為 `db:reset` 係 migrate 先、seed 後，migration 喺 dev 一定
// 0 行夾中）：
//   1. `default_broker_id` 仍然 NULL 嘅安員 → 喺 shift_records（非作廢、
//      settlement_broker_id 非 null，**唔限 kind=broker**，同
//      backfill-broker.ts 唔同）出現最多次嗰個結算單位；同票取最近
//      work_date，再同票用 broker_id 做穩定 tie-break。
//   2. 完全冇非作廢記錄嘅安員，`employment_type='longterm_autopay'`
//      （長工）→ kind=internal_longterm 嗰個 broker（用 kind 搵，唔寫死
//      id／code）。
//   3. 其餘保持 NULL。
//
// 逐個被改嘅安員寫一行 audit_log（action=migration_backfill_
// default_broker，before/after）——同 migration 嗰行用同一個 action
// 字串，等查 audit trail 唔使分兩種字串搵。
import type { PrismaClient } from "@prisma/client";

export interface BroaderBackfillStats {
  /** 逐 broker.kind 分佈——呢個 helper 究竟幫幾多個安員填咗邊種 kind
   * 嘅結算單位（前端/報告用嚟核實「冇令雞頭多睇到人」嗰個分析）。 */
  byBrokerKind: Record<string, number>;
  backfilledFromHistory: number;
  backfilledLongtermFallback: number;
  stillNull: number;
}

export async function backfillGuardDefaultBrokerBroaderP0(prisma: PrismaClient): Promise<BroaderBackfillStats> {
  const guardsNeeding = await prisma.guard.findMany({
    where: { defaultBrokerId: null },
    select: { id: true, employmentType: true },
  });

  const stats: BroaderBackfillStats = {
    byBrokerKind: {},
    backfilledFromHistory: 0,
    backfilledLongtermFallback: 0,
    stillNull: 0,
  };
  if (guardsNeeding.length === 0) return stats;

  const guardIds = guardsNeeding.map((g) => g.id);
  const records = await prisma.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, status: { not: "cancelled" }, settlementBrokerId: { not: null } },
    select: { guardId: true, settlementBrokerId: true, workDate: true },
  });

  // guardId -> brokerId -> { count, latestDate }
  const perGuard = new Map<string, Map<string, { count: number; latestDate: Date }>>();
  for (const r of records) {
    const brokerId = r.settlementBrokerId!;
    let byBroker = perGuard.get(r.guardId);
    if (!byBroker) {
      byBroker = new Map();
      perGuard.set(r.guardId, byBroker);
    }
    const existing = byBroker.get(brokerId);
    if (existing) {
      existing.count++;
      if (r.workDate > existing.latestDate) existing.latestDate = r.workDate;
    } else {
      byBroker.set(brokerId, { count: 1, latestDate: r.workDate });
    }
  }

  let internalLongtermBrokerId: string | null | undefined; // undefined=未查過
  async function getInternalLongtermBrokerId(): Promise<string | null> {
    if (internalLongtermBrokerId !== undefined) return internalLongtermBrokerId;
    const b = await prisma.broker.findFirst({ where: { kind: "internal_longterm" }, orderBy: { code: "asc" }, select: { id: true } });
    internalLongtermBrokerId = b?.id ?? null;
    return internalLongtermBrokerId;
  }

  const brokerKindById = new Map((await prisma.broker.findMany({ select: { id: true, kind: true } })).map((b) => [b.id, b.kind as string]));

  for (const g of guardsNeeding) {
    let newBrokerId: string | null = null;
    let viaLongtermFallback = false;

    const byBroker = perGuard.get(g.id);
    if (byBroker && byBroker.size > 0) {
      // 出現最多次；同票取最近 work_date；再同票 broker_id 字典序（穩定
      // tie-break，同 migration SQL 一致）。
      const entries = [...byBroker.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      let best: { brokerId: string; count: number; latestDate: Date } | null = null;
      for (const [brokerId, v] of entries) {
        if (!best || v.count > best.count || (v.count === best.count && v.latestDate.getTime() > best.latestDate.getTime())) {
          best = { brokerId, count: v.count, latestDate: v.latestDate };
        }
      }
      newBrokerId = best?.brokerId ?? null;
    } else if (g.employmentType === "longterm_autopay") {
      newBrokerId = await getInternalLongtermBrokerId();
      viaLongtermFallback = newBrokerId !== null;
    }

    if (!newBrokerId) {
      stats.stillNull++;
      continue;
    }

    await prisma.$transaction([
      prisma.guard.update({ where: { id: g.id }, data: { defaultBrokerId: newBrokerId } }),
      prisma.auditLog.create({
        data: {
          tableName: "guards",
          rowId: g.id,
          action: "migration_backfill_default_broker",
          before: { default_broker_id: null },
          after: { default_broker_id: newBrokerId },
        },
      }),
    ]);

    if (viaLongtermFallback) stats.backfilledLongtermFallback++;
    else stats.backfilledFromHistory++;
    const kind = brokerKindById.get(newBrokerId) ?? "unknown";
    stats.byBrokerKind[kind] = (stats.byBrokerKind[kind] ?? 0) + 1;
  }

  return stats;
}
