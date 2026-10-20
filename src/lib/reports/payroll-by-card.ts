// EMP-P2：糧明細以「工號卡」為最細聚合單位。
//   硬規則：聚合 key 永遠含工號卡 id（`guardId|staffNumberId`，冇歸屬＝`none`）；唔准先按人合計再拆。
//   卡歸屬 = shift_records.staff_number_id，已鎖月更次（P1 回填只寫側表）再 fallback 去 shift_record_staff_attributions；
//   兩邊都冇 → 「未標工號」一組（key 尾 `none`），唔准靜靜併入 U。
//   只係歸屬／分組：金額欄照舊係 guard_wage_snapshot／broker_fee_snapshot 嘅 SUM，唔掂任何計糧邏輯。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { n, round2, monthRange } from "./money";
import { memoized } from "./context";

const NO_CARD = "none";
export const NO_CARD_LABEL = "未標工號";

/** 聚合 key：永遠含工號卡 id。 */
export function cardKey(guardId: string, staffNumberId: string | null): string {
  return `${guardId}|${staffNumberId ?? NO_CARD}`;
}

export interface CardPayrollRow {
  /** `guardId|staffNumberId(or 'none')`——同一人同一張卡跨雞頭會有多行（各自 settlementBrokerId），key 相同 */
  key: string;
  guardId: string;
  staffNumberId: string | null;
  /** 卡嘅 scheme（U／MP／MG／MW…）；未標工號＝null */
  scheme: string | null;
  /** 卡號；未標工號＝null */
  number: string | null;
  settlementBrokerId: string | null;
  shifts: number;
  /** EMP-P2.2：其中 LINK 盤（sites.guards_paid_by_client）嘅更數——本身冇計價（snapshot null），金額照舊唔入 */
  linkShifts: number;
  wage: number;
  fee: number;
  amount: number;
}

interface RawGroup {
  settlement_broker_id: string | null;
  guard_id: string;
  card_id: string | null;
  scheme: string | null;
  shifts: bigint | number;
  link_shifts: bigint | number;
  wage: Prisma.Decimal | null;
  fee: Prisma.Decimal | null;
}

/**
 * 每 (結算單位 × 保安員 × 工號卡) 一行。
 *   - EMP-P2.3 M1：結算單位 kind=external（settlementType=none，客戶自己嘅人，唔入糧）嘅更次剔出，唔計人數、唔出行（睇 `countExternalShifts`）。
 *   - EMP-P2.3 S1：LINK 盤（sites.guards_paid_by_client）更次即使有舊 snapshot 都唔計入 wage／fee（SQL FILTER NOT guards_paid_by_client），
 *     但仍計入 shifts／linkShifts（備註「LINK 盤更數 N（唔計價）」）。
 */
export function buildPayrollByCard(month: Date): Promise<CardPayrollRow[]> {
  return memoized(`payrollcard:${monthRange(month).start.toISOString()}`, () => buildPayrollByCardUncached(month));
}

async function buildPayrollByCardUncached(month: Date): Promise<CardPayrollRow[]> {
  const { start, end } = monthRange(month);
  const groups = await prisma.$queryRaw<RawGroup[]>(Prisma.sql`
    SELECT sr.settlement_broker_id AS settlement_broker_id,
           sr.guard_id AS guard_id,
           COALESCE(sr.staff_number_id, a.staff_number_id) AS card_id,
           COALESCE(sr.staff_scheme, a.staff_scheme) AS scheme,
           COUNT(*) AS shifts,
           COUNT(*) FILTER (WHERE st.guards_paid_by_client) AS link_shifts,
           SUM(sr.guard_wage_snapshot) FILTER (WHERE NOT COALESCE(st.guards_paid_by_client, false)) AS wage,
           SUM(sr.broker_fee_snapshot) FILTER (WHERE NOT COALESCE(st.guards_paid_by_client, false)) AS fee
      FROM shift_records sr
      LEFT JOIN shift_record_staff_attributions a ON a.shift_record_id = sr.id
      LEFT JOIN sites st ON st.id = sr.site_id
      LEFT JOIN brokers sb ON sb.id = sr.settlement_broker_id
     WHERE sr.record_type IN ('shift', 'ot')
       AND sr.work_date >= ${start.toISOString().slice(0, 10)}::date AND sr.work_date <= ${end.toISOString().slice(0, 10)}::date
       AND sr.status <> 'cancelled'
       AND (sb.kind IS NULL OR sb.kind <> 'external')
     GROUP BY 1, 2, 3, 4
     ORDER BY 2, 3, 1`);
  const cardIds = [...new Set(groups.map((g) => g.card_id).filter((v): v is string => !!v))];
  const cards = cardIds.length ? await prisma.guardStaffNumber.findMany({ where: { id: { in: cardIds } }, select: { id: true, number: true, scheme: true } }) : [];
  const cardById = new Map(cards.map((c) => [c.id, c]));
  return groups.map((g) => {
    const wage = round2(n(g.wage));
    const fee = round2(n(g.fee));
    const card = g.card_id ? (cardById.get(g.card_id) ?? null) : null;
    return {
      key: cardKey(g.guard_id, g.card_id),
      guardId: g.guard_id,
      staffNumberId: g.card_id,
      scheme: card?.scheme ?? g.scheme,
      number: card?.number ?? null,
      settlementBrokerId: g.settlement_broker_id,
      shifts: Number(g.shifts),
      linkShifts: Number(g.link_shifts),
      wage,
      fee,
      amount: round2(wage + fee),
    };
  });
}

export interface SchemeSubtotal {
  /** null＝未標工號 */
  scheme: string | null;
  shifts: number;
  wage: number;
  fee: number;
  amount: number;
}

/** 每雞頭（settlement_broker_id）× scheme 小計——`BrokerPayrollTotal.by_scheme` 用（additive）。key＝brokerId ?? ''。 */
export function schemeSubtotalsByBroker(rows: readonly CardPayrollRow[]): Map<string, SchemeSubtotal[]> {
  const byBroker = new Map<string, Map<string, SchemeSubtotal>>();
  for (const r of rows) {
    const bk = r.settlementBrokerId ?? "";
    const m = byBroker.get(bk) ?? byBroker.set(bk, new Map()).get(bk)!;
    const sk = r.scheme ?? NO_CARD;
    const cur = m.get(sk) ?? { scheme: r.scheme, shifts: 0, wage: 0, fee: 0, amount: 0 };
    cur.shifts += r.shifts;
    cur.wage = round2(cur.wage + r.wage);
    cur.fee = round2(cur.fee + r.fee);
    cur.amount = round2(cur.wage + cur.fee);
    m.set(sk, cur);
  }
  const out = new Map<string, SchemeSubtotal[]>();
  for (const [bk, m] of byBroker) out.set(bk, [...m.values()].sort((a, b) => (a.scheme ?? "￿").localeCompare(b.scheme ?? "￿")));
  return out;
}

/** EMP-P2.3 M1：客戶自己人（結算單位 kind=external）更數——獨立計數，唔入逐人糧單／by_card 聚合。 */
export async function countExternalShifts(month: Date): Promise<number> {
  const { start, end } = monthRange(month);
  const r = await prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
    SELECT COUNT(*) AS n
      FROM shift_records sr
      JOIN brokers sb ON sb.id = sr.settlement_broker_id
     WHERE sb.kind = 'external' AND sr.record_type IN ('shift', 'ot') AND sr.status <> 'cancelled'
       AND sr.work_date >= ${start.toISOString().slice(0, 10)}::date AND sr.work_date <= ${end.toISOString().slice(0, 10)}::date`);
  return Number(r[0]?.n ?? 0);
}
