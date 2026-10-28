// 由 DB 一次過查晒起 `GuardMatchIndex`（roster-upload service 同 WhatsApp 解析共用）。
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildGuardMatchIndex, type GuardMatchIndex } from "./match";
import { HIST5_OVERRIDE_REASON_PREFIX } from "@/lib/month-close/hist-inference";

type Db = PrismaClient | Prisma.TransactionClient;

/** HIST-5（Opus 驗收 M1）：歷史導入 AI 推斷寫嘅「淨姓名」guard_match_overrides（staffNo=''，reason 以 `HIST5` 開頭）
 * 只喺歷史月份配對生效——正式月份（包括 WhatsApp）唔載入，否則同名新人（有自己電話）會被歷史 minimal guard 嘅淨姓名覆寫
 * 搶走（覆寫排喺電話層之前）。帶工號嘅 HIST5 覆寫（工號＋姓名完全相同先命中）同舊「工號衝突保守預設」同一機制，照載入
 * （正式月份 guard-fix create_minimal 見到同 key 已有覆寫會冪等跳過，唔可以令佢失效）。 */
export function isHistNameOnlyOverride(o: { staffNo: string; reason?: string | null }): boolean {
  return o.staffNo === "" && !!o.reason && o.reason.startsWith(HIST5_OVERRIDE_REASON_PREFIX);
}

export async function loadGuardMatchIndex(db: Db, opts: { includeHistInferenceOverrides?: boolean } = {}): Promise<GuardMatchIndex> {
  const [guardsRaw, staffNumbersRaw, phonesRaw, matchOverridesRaw] = await Promise.all([
    db.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true, nameAliases: true, mergedFrom: true } }),
    db.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true } }),
    db.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    db.guardMatchOverride.findMany({ where: { voidedAt: null }, select: { staffNo: true, nameRaw: true, guardId: true, reason: true } }),
  ]);
  const matchOverrides = opts.includeHistInferenceOverrides ? matchOverridesRaw : matchOverridesRaw.filter((o) => !isHistNameOnlyOverride(o));
  return buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw, matchOverrides });
}
