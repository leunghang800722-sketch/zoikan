// P10.1：頂位津貼價目表寫入（建立／改額／作廢）。鎖月：生效區間覆蓋已鎖月份唔准寫。改價＝新增一行（新生效日），唔覆寫舊價。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { BadRequest, Conflict, NotFound } from "@/lib/api/errors";
import { hkMonthStart } from "@/lib/dates";
import type { Prisma } from "@prisma/client";

/** 鎖月檢查嘅區間尾：開放式價（effective_to 空）預設查到「下個月」；但生效日本身喺更遠嘅未來月份都要查返生效日嗰個月。 */
function lockCheckTo(from: Date, to: Date | null): Date | null {
  if (to) return to;
  const now = hkMonthStart();
  const horizon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return from.getTime() > horizon.getTime() ? from : null;
}

const ymdToDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export interface CreateRateInput {
  siteId: string;
  grade: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  source: "manual" | "inferred";
  evidence?: Prisma.InputJsonValue | null;
  actorUserId: string;
  ip: string | null;
}

export async function createCoverRate(inp: CreateRateInput) {
  const site = await prisma.site.findUnique({ where: { id: inp.siteId }, select: { id: true } });
  if (!site) throw BadRequest("搵唔到呢個盤");
  const from = ymdToDate(inp.effectiveFrom);
  const to = inp.effectiveTo ? ymdToDate(inp.effectiveTo) : null;
  if (to && to < from) throw BadRequest("effective_to 唔可以早過 effective_from");
  await assertMonthRangeNotLocked({ effectiveFrom: from, effectiveTo: lockCheckTo(from, to), actorUserId: inp.actorUserId, tableName: "cover_shift_rates", rowId: "new", ip: inp.ip });
  const existing = await prisma.coverShiftRate.findUnique({ where: { siteId_grade_effectiveFrom: { siteId: inp.siteId, grade: inp.grade, effectiveFrom: from } } });
  if (existing && !existing.voidedAt) throw Conflict("呢個盤呢個職級喺呢個生效日已有價——要改價請用新嘅生效日，或者改額／作廢現有嗰行");
  const data = { amount: inp.amount, effectiveTo: to, source: inp.source, evidence: inp.evidence ?? undefined, createdBy: inp.actorUserId };
  if (existing) {
    const after = await prisma.coverShiftRate.update({ where: { id: existing.id }, data: { ...data, voidedAt: null, voidedBy: null } });
    await writeAudit({ actorUserId: inp.actorUserId, tableName: "cover_shift_rates", rowId: existing.id, action: "update", before: existing, after, ip: inp.ip });
    return after;
  }
  const created = await prisma.coverShiftRate.create({ data: { siteId: inp.siteId, grade: inp.grade, effectiveFrom: from, ...data } });
  await writeAudit({ actorUserId: inp.actorUserId, tableName: "cover_shift_rates", rowId: created.id, action: "create", after: created, ip: inp.ip });
  return created;
}

export async function updateCoverRate(id: string, patch: { amount?: number; void?: true }, actorUserId: string, ip: string | null) {
  const before = await prisma.coverShiftRate.findUnique({ where: { id } });
  if (!before) throw NotFound();
  if (before.voidedAt) throw Conflict("呢行已作廢");
  await assertMonthRangeNotLocked({ effectiveFrom: before.effectiveFrom, effectiveTo: lockCheckTo(before.effectiveFrom, before.effectiveTo), actorUserId, tableName: "cover_shift_rates", rowId: id, ip });
  if (patch.amount === undefined && !patch.void) throw BadRequest("要帶 amount 或 void:true");
  const after = await prisma.coverShiftRate.update({ where: { id }, data: patch.void ? { voidedAt: new Date(), voidedBy: actorUserId } : { amount: patch.amount } });
  await writeAudit({ actorUserId, tableName: "cover_shift_rates", rowId: id, action: patch.void ? "void" : "update", before, after, ip });
  return after;
}
