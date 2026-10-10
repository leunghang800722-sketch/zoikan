// P0（Opus 驗收重現）：新月份更表記錄冇咗結算單位（`settlement_broker_id`
// NULL）→ `buildPayrollTotals()`（src/lib/reports/payroll.ts）逐 broker
// 查，冇雞頭嘅記錄喺糧明細**完全消失**（唔止「未定價」，係整條記錄喺
// 報表憑空唔見咗）。根源：93/265 個保安員 `guards.default_broker_id` 係
// NULL（長工／公司兵），「複製上月」／新增格嘅 payload 又冇帶
// `settlement_broker_id`，令 batch/route.ts、單筆 POST 兩個 fallback 鏈
// 都跌到 `guard.default_broker_id ?? null`。
//
// 呢個 helper 抽出嚟做**單一 fallback 鏈**，`batch/route.ts`、單筆
// `POST /api/shift-records` 兩個新建/更新路徑一齊用，唔准各執一詞：
//   1. payload 傳咗嘅值（呢個 helper 唔負責——caller 自己 `??` 先）
//   2. 現存記錄嘅值（呢個 helper 都唔負責——caller 自己 `??` 先）
//   3. 同一保安員、同一盤，最近一條（任何月份）非作廢記錄嘅
//      settlement_broker_id
//   4. 同一保安員，任何盤，最近一條非作廢記錄嘅 settlement_broker_id
//   5. guard.default_broker_id
//   6. employment_type 屬長工（`longterm_*`）→ kind=internal_longterm
//      嗰個 broker（唔寫死 id／code——DB 入面代號可能變，`seed`／未來
//      migration 唔應該同呢個 helper 夾硬綁死一個 code）
//   7. 全部搵唔到 → null（呢種情況由 caller 用 D 項嘅 no_settlement_count
//      warning 处理，唔靜靜吞）
//
// 雞頭隔離：呢個 helper 淨係喺內部角色（老闆/主管/會計）新建/改記錄嘅
// fallback 鏈先會用到——雞頭 session 寫入時 settlement_broker_id 一律
// 由 server 強制等於自己 broker_id（batch/route.ts／單筆 POST 嘅
// isBrokerRole 分支），完全唔會行到呢個 helper，唔會被打破。
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

// 容許傳 `tx`（transaction client）或者外層 `prisma`——同呢個 repo 其他
// helper（例如 assertGuardOwnedByBroker）睇齊嘅寫法。
type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type SettlementBrokerFallbackInput = {
  guardId: string;
  siteId: string;
  /** guard.employment_type（"longterm_autopay" 等）——搵唔到記錄／
   * default_broker_id 先會用呢個決定攞唔攞 internal_longterm 桶。 */
  employmentType: string;
  /** guard.default_broker_id（已經喺 caller 攞咗，唔喺呢度再查一次）。 */
  defaultBrokerId: string | null;
};

/**
 * 第 3／4／5／6 級 fallback（caller 負責 1／2 級：payload／現存記錄）。
 * 搵唔到就回 null（第 7 級——由 caller 决定點樣警告用戶）。
 */
export async function resolveSettlementBrokerFallback(
  input: SettlementBrokerFallbackInput,
  client: PrismaLike = prisma,
): Promise<string | null> {
  // 3：同一保安員、同一盤，最近一條（任何月份）非作廢記錄。
  const sameSiteRecent = await client.shiftRecord.findFirst({
    where: {
      guardId: input.guardId,
      siteId: input.siteId,
      status: { not: "cancelled" },
      settlementBrokerId: { not: null },
    },
    orderBy: { workDate: "desc" },
    select: { settlementBrokerId: true },
  });
  if (sameSiteRecent?.settlementBrokerId) return sameSiteRecent.settlementBrokerId;

  // 4：同一保安員，任何盤，最近一條非作廢記錄。
  const anySiteRecent = await client.shiftRecord.findFirst({
    where: {
      guardId: input.guardId,
      status: { not: "cancelled" },
      settlementBrokerId: { not: null },
    },
    orderBy: { workDate: "desc" },
    select: { settlementBrokerId: true },
  });
  if (anySiteRecent?.settlementBrokerId) return anySiteRecent.settlementBrokerId;

  // 5：guard.default_broker_id。
  if (input.defaultBrokerId) return input.defaultBrokerId;

  // 6：長工（employment_type 開頭 "longterm_"）→ kind=internal_longterm
  // 嗰個 broker（用 kind 搵，唔寫死 id／code）。
  if (input.employmentType.startsWith("longterm_")) {
    const longtermBroker = await client.broker.findFirst({
      where: { kind: "internal_longterm" },
      orderBy: { code: "asc" },
      select: { id: true },
    });
    if (longtermBroker) return longtermBroker.id;
  }

  // 7：全部搵唔到。
  return null;
}

/**
 * P3-2.5：批量版第 3／4 級——每個 guard 最近一條非作廢、有結算單位嘅記錄（`DISTINCT ON`，一條 SQL）。
 * `siteId` 有值＝只睇該盤（第 3 級），冇＝任何盤（第 4 級）。排序同單個版一樣（work_date 新→舊）。
 */
async function recentSettlementBrokerByGuard(client: PrismaLike, guardIds: string[], siteId: string | null): Promise<Map<string, string>> {
  if (guardIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ guard_id: string; settlement_broker_id: string }>>(
    Prisma.sql`SELECT DISTINCT ON (guard_id) guard_id, settlement_broker_id
      FROM shift_records
      WHERE guard_id = ANY(${guardIds}::text[])
        ${siteId ? Prisma.sql`AND site_id = ${siteId}` : Prisma.empty}
        AND status <> 'cancelled'::"ShiftRecordStatus"
        AND settlement_broker_id IS NOT NULL
      ORDER BY guard_id, work_date DESC`,
  );
  return new Map(rows.map((r) => [r.guard_id, r.settlement_broker_id]));
}

/**
 * 一次過幫一批 guardId 預先算好 fallback（避免逐格 await 一個一個查，
 * batch/route.ts 一次過起晒 plans 之後會有多格同一個 guard）。Memoize
 * 用 `${guardId}|${siteId}` 做 key——同一保安員唔同盤嘅 fallback（第 3
 * 級）唔同，唔可以共用。
 *
 * P3-2.5：`prefetch(inputs)` 一次過（兩條 `DISTINCT ON` SQL＋最多一條長工桶查詢）預先填好
 * 一批 guard 嘅結果，取代每個 guard 2–3 條查詢；結果同單個 `resolveSettlementBrokerFallback()`
 * 逐級判斷一致（tests/p3-2-batch-write.test.ts 對比）。未 prefetch 嘅 key 照舊逐個查。
 */
export function createSettlementBrokerFallbackResolver(client: PrismaLike = prisma) {
  const cache = new Map<string, Promise<string | null>>();
  async function resolve(input: SettlementBrokerFallbackInput): Promise<string | null> {
    const key = `${input.guardId}|${input.siteId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolveSettlementBrokerFallback(input, client);
      cache.set(key, pending);
    }
    return pending;
  }
  resolve.prefetch = async function prefetch(inputs: SettlementBrokerFallbackInput[]): Promise<void> {
    const todo = new Map<string, SettlementBrokerFallbackInput>();
    for (const i of inputs) {
      const key = `${i.guardId}|${i.siteId}`;
      if (!cache.has(key) && !todo.has(key)) todo.set(key, i);
    }
    if (todo.size === 0) return;
    // 同一批一般同一個盤；唔同盤就按盤分組各查一次。
    const bySite = new Map<string, SettlementBrokerFallbackInput[]>();
    for (const i of todo.values()) (bySite.get(i.siteId) ?? bySite.set(i.siteId, []).get(i.siteId)!).push(i);
    const allGuardIds = [...new Set([...todo.values()].map((i) => i.guardId))];
    const anySite = await recentSettlementBrokerByGuard(client, allGuardIds, null);
    let longtermBrokerId: string | null | undefined;
    for (const [siteId, list] of bySite) {
      const sameSite = await recentSettlementBrokerByGuard(client, [...new Set(list.map((i) => i.guardId))], siteId);
      for (const i of list) {
        let result: string | null = sameSite.get(i.guardId) ?? anySite.get(i.guardId) ?? i.defaultBrokerId ?? null;
        if (!result && i.employmentType.startsWith("longterm_")) {
          if (longtermBrokerId === undefined) {
            longtermBrokerId = (await client.broker.findFirst({ where: { kind: "internal_longterm" }, orderBy: { code: "asc" }, select: { id: true } }))?.id ?? null;
          }
          result = longtermBrokerId;
        }
        cache.set(`${i.guardId}|${i.siteId}`, Promise.resolve(result));
      }
    }
  };
  return resolve;
}
