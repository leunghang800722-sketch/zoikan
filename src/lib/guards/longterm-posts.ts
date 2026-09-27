// WP-PHASE3 Opus 5.5 驗收：`guard_longterm_posts` 寫入共用檢查——安員
// 抽屜「長工」區（POST／PATCH）同「轉長工」共用。
//
// - 同一個安員、同一個盤，未作廢嘅崗位記錄生效期唔可以重疊（重疊會令長
//   工結算／介紹雞頭推算讀到兩條一樣嘅盤，亦令「終止」唔知終止邊條）；
//   唔同盤可以同時生效（長工短期掛兩個盤，由人手判斷，同 guard-fix
//   `set_longterm_post` 一致）。
// - `effective_to` 唔可以早過 `effective_from`。
import { prisma } from "@/lib/db";
import { BadRequest, Conflict } from "@/lib/api/errors";

export async function assertLongtermPostPeriodOk(input: {
  guardId: string;
  siteId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  excludePostId?: string;
}): Promise<void> {
  const { guardId, siteId, effectiveFrom, effectiveTo, excludePostId } = input;
  if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw BadRequest("終止日（effective_to）唔可以早過生效日（effective_from）");
  }
  const clash = await prisma.guardLongtermPost.findFirst({
    where: {
      guardId,
      siteId,
      voidedAt: null,
      ...(excludePostId ? { id: { not: excludePostId } } : {}),
      // 重疊：對方開始 <= 我結束（我冇結束＝無限）且 對方結束（null＝無限）>= 我開始
      ...(effectiveTo ? { effectiveFrom: { lte: effectiveTo } } : {}),
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }],
    },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  if (clash) {
    const from = clash.effectiveFrom.toISOString().slice(0, 10);
    const to = clash.effectiveTo ? clash.effectiveTo.toISOString().slice(0, 10) : "現在";
    throw Conflict(`呢個安員喺呢個盤已經有一條生效期重疊嘅崗位記錄（${from}～${to}）——要改請先終止嗰條`, { conflictPostId: clash.id });
  }
}

/** 介紹雞頭／簽證形式贊助雞頭：雞頭要存在（400），唔可以係 B07 呢類
 * 「內部長工結算單位」（`kind=internal_longterm`）——佢唔係供應人嘅雞頭，
 * 設咗會令介紹費／簽證形式結算跟錯單位。`internal_cash`（例：代號 Y）
 * 現有資料有做介紹雞頭嘅記錄，唔擋（要唔要擋等規劃定）。 */
export async function assertReferralBrokerAllowed(brokerId: string, label: string): Promise<void> {
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { id: true, kind: true } });
  if (!broker) throw BadRequest(`搵唔到呢個${label}`);
  if (broker.kind === "internal_longterm") throw BadRequest(`${label}唔可以係內部長工結算單位（B07）`);
}
