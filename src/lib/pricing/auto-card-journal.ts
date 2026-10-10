// WP-ONE-CLICK-AUTO（Opus 第三輪 N4）：任何寫入 price snapshot 嘅路徑（reconcile-apply／repriceMonthForSites／
// settlement-resync），只要 resolver 用到嘅卡 source 係 `auto:one-click:<runId>`，就補寫一行 journal
// （kind=price_snapshots）去嗰個 run，記 old／new／fields——令 undo「只按 journal」都清得到，唔使靠值相等掃描。
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;
type PriceTuple = [number | null, number | null, number | null];
export interface AutoCardUse {
  recordId: string;
  before: PriceTuple;
  after: PriceTuple;
  clientCardId?: string;
  payoutCardId?: string;
}

const AUTO_PREFIX = "auto:one-click:";
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);

export async function journalAutoCardUses(uses: AutoCardUse[], db: Db = prisma): Promise<number> {
  const relevant = uses.filter((u) => u.clientCardId || u.payoutCardId);
  if (relevant.length === 0) return 0;
  const cardIds = [...new Set(relevant.flatMap((u) => [u.clientCardId, u.payoutCardId]).filter((x): x is string => !!x))];
  const cards = await db.rateCard.findMany({ where: { id: { in: cardIds }, source: { startsWith: AUTO_PREFIX } }, select: { id: true, source: true } });
  if (cards.length === 0) return 0;
  const runOf = new Map(cards.map((c) => [c.id, c.source!.slice(AUTO_PREFIX.length)]));
  const runs = new Set((await db.monthCloseRun.findMany({ where: { id: { in: [...new Set(runOf.values())] } }, select: { id: true } })).map((r) => r.id));
  const byCard = new Map<string, Array<{ id: string; before: PriceTuple; after: PriceTuple; fields: string[] }>>();
  for (const u of relevant) {
    const perCard = new Map<string, string[]>();
    if (u.clientCardId && runOf.has(u.clientCardId) && !same(u.before[0], u.after[0])) perCard.set(u.clientCardId, [...(perCard.get(u.clientCardId) ?? []), "client"]);
    if (u.payoutCardId && runOf.has(u.payoutCardId) && (!same(u.before[1], u.after[1]) || !same(u.before[2], u.after[2]))) perCard.set(u.payoutCardId, [...(perCard.get(u.payoutCardId) ?? []), "payout"]);
    for (const [cardId, fields] of perCard) byCard.set(cardId, [...(byCard.get(cardId) ?? []), { id: u.recordId, before: u.before, after: u.after, fields }]);
  }
  let n = 0;
  for (const [cardId, rows] of byCard) {
    const runId = runOf.get(cardId)!;
    if (!runs.has(runId)) continue;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await db.monthCloseAutoChange.create({
        data: { runId, kind: "price_snapshots", refTable: "shift_records", refId: cardId, summary: `之後對數／補價用咗 auto 價卡定價 ${chunk.length} 更`, detailJson: { cardId, rows: chunk, via: "later_write" } as unknown as Prisma.InputJsonValue, undoable: true },
      });
      n += chunk.length;
    }
  }
  return n;
}

/** 人手 route 用：journal 失敗唔可以拖冧主要寫入（best effort）。 */
export async function journalAutoCardUsesSafe(uses: AutoCardUse[], db: Db = prisma): Promise<void> {
  try {
    await journalAutoCardUses(uses, db);
  } catch (e) {
    console.error("[auto-card-journal] 補寫 journal 失敗", e instanceof Error ? e.message : e);
  }
}

export const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number((v as { toString(): string }).toString()));
