// P18 驗收 M2：「出勤修正」面板寫入（權限＝長工糧:update，老闆／會計；唔經 batch API 因為會計冇「更表」權）。
// 邏輯同 shift-records/batch 對齊：改出勤代號 → source="manual"、status=confirmed、record_type／leave_code 更新、
// 類型變咗就按 resolver 重新計價；歸公司兵（settle_internal）→ settlement_broker_id 設 B07（重新計價、唔蓋 source）；
// 先全部 validate、一個 transaction 寫入、commit 後先寫 audit。唔作廢任何紀錄。
import type { Prisma, ShiftRecord } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditMany } from "@/lib/audit";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { assertMonthNotLocked, assertMonthNotLockedTx } from "@/lib/month-lock";
import { findInternalLongtermBrokerId } from "@/lib/pricing/longterm-settlement";
import { journalAutoCardUsesSafe, toNum, type AutoCardUse } from "@/lib/pricing/auto-card-journal";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards } from "@/lib/pricing/resolve-rate";
import { MANUAL_SOURCE, sourceRank } from "./attendance-priority";

interface FixAction {
  guard_id: string;
  work_date: string;
  site_id: string;
  shift_type_id?: string;
  set_code?: "SHIFT" | "RD" | "OFF" | "AL" | "SL" | "NL" | "NPL" | "SH";
  settle_internal?: true;
}
interface FixResult {
  guard_id: string;
  work_date: string;
  site_id: string;
  action: "updated" | "noop";
}

/** 紀錄嘅出勤代號（同 aggregate 一致：OFF＝RD、NPL＝NL）；正更＝SHIFT。 */
const normRecord = (r: Pick<ShiftRecord, "recordType" | "leaveCode">): string => (r.recordType === "shift" ? "SHIFT" : r.leaveCode === "OFF" ? "RD" : r.leaveCode === "NPL" ? "NL" : (r.leaveCode ?? "?"));
const normCode = (c: string): string => (c === "OFF" ? "RD" : c === "NPL" ? "NL" : c);

export async function applyAttendanceFix(params: { month: Date; actions: FixAction[]; actorUserId: string; ip: string | null }) {
  const { month, actions, actorUserId, ip } = params;
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  await assertMonthNotLocked({ workDate: start, actorUserId, tableName: "shift_records", rowId: "attendance-fix", ip });

  const guardIds = [...new Set(actions.map((a) => a.guard_id))];
  const contracts = await prisma.guardLongtermContract.findMany({
    where: { guardId: { in: guardIds }, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
    select: { guardId: true },
  });
  const longterm = new Set(contracts.map((c) => c.guardId));
  for (const a of actions) {
    if (!longterm.has(a.guard_id)) throw BadRequest("只可以修正該月有長工合約嘅保安員");
    const d = new Date(`${a.work_date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d < start || d > end) throw BadRequest(`work_date ${a.work_date} 唔屬於 ${start.toISOString().slice(0, 7)}`);
  }
  const needInternal = actions.some((a) => a.settle_internal);
  const b07 = needInternal ? await findInternalLongtermBrokerId() : null;
  if (needInternal && !b07) throw BadRequest("揾唔到公司兵（B07）結算單位");

  const records = await prisma.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: { in: ["shift", "leave"] } },
    include: { shiftType: { select: { code: true, billingGroup: true } } },
  });
  const keyOf = (guardId: string, date: string, siteId: string) => `${guardId}|${date}|${siteId}`;
  const byKey = new Map<string, typeof records>();
  for (const r of records) {
    const k = keyOf(r.guardId, r.workDate.toISOString().slice(0, 10), r.siteId);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  // ---- 逐個動作計劃（未寫任何嘢）----
  type Plan = { id: string; data: Prisma.ShiftRecordUncheckedUpdateInput; recordType: "shift" | "leave"; settlementBrokerId: string | null; reprice: boolean; pricingSource?: Record<string, unknown>; before: (typeof records)[number] };
  const plans = new Map<string, Plan>();
  const results: FixResult[] = [];
  for (const a of actions) {
    const recs = byKey.get(keyOf(a.guard_id, a.work_date, a.site_id)) ?? [];
    if (recs.length === 0) throw NotFound(`搵唔到 ${a.work_date} 嘅出勤紀錄（可能已被更改，請重新整理）`);
    let changed = false;
    if (a.set_code) {
      const want = normCode(a.set_code);
      const bestRank = Math.min(...recs.map((r) => sourceRank(r.source)));
      const top = recs.filter((r) => sourceRank(r.source) === bestRank);
      const differing = top.filter((r) => normRecord(r) !== want);
      if (differing.length > 0) {
        const target = differing.find((r) => r.shiftTypeId === a.shift_type_id) ?? differing.sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())[0]!;
        const isLeave = want !== "SHIFT";
        const cur = plans.get(target.id);
        const typeChanged = target.recordType !== (isLeave ? "leave" : "shift");
        plans.set(target.id, {
          id: target.id,
          before: target,
          recordType: isLeave ? "leave" : "shift",
          settlementBrokerId: cur?.settlementBrokerId ?? target.settlementBrokerId,
          reprice: typeChanged || (cur?.reprice ?? false),
          data: { ...(cur?.data ?? {}), recordType: isLeave ? "leave" : "shift", leaveCode: isLeave ? (a.set_code as never) : null, source: MANUAL_SOURCE, status: "confirmed" },
        });
        changed = true;
      }
    }
    if (a.settle_internal && b07) {
      for (const r of recs.filter((x) => x.recordType === "shift" && x.settlementBrokerId !== b07)) {
        const cur = plans.get(r.id);
        plans.set(r.id, {
          id: r.id,
          before: r,
          recordType: cur?.recordType ?? "shift",
          settlementBrokerId: b07,
          reprice: true,
          data: { ...(cur?.data ?? {}), settlementBrokerId: b07 },
        });
        changed = true;
      }
    }
    results.push({ guard_id: a.guard_id, work_date: a.work_date, site_id: a.site_id, action: changed ? "updated" : "noop" });
  }

  // ---- 重新計價（類型或結算單位變咗先做；同 batch 一致由 resolver 揀價；LINK 類盤保留現值）----
  const siteIds = [...new Set([...plans.values()].map((p) => p.before.siteId))];
  const sites = siteIds.length ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, guardsPaidByClient: true } }) : [];
  const paidByClient = new Map(sites.map((s) => [s.id, s.guardsPaidByClient]));
  const brokerIds = [...new Set([...plans.values()].map((p) => p.settlementBrokerId).filter((v): v is string => v !== null))];
  const brokers = brokerIds.length ? await prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true } }) : [];
  const kindOf = new Map(brokers.map((b) => [b.id, b.kind]));
  const cardsBySite = new Map<string, Awaited<ReturnType<typeof fetchEffectiveRateCards>>>();
  for (const p of plans.values()) {
    if (!p.reprice || paidByClient.get(p.before.siteId)) continue;
    let cards = cardsBySite.get(p.before.siteId);
    if (!cards) {
      cards = await fetchEffectiveRateCards(p.before.siteId, start, end);
      cardsBySite.set(p.before.siteId, cards);
    }
    const pricing = resolveShiftPricingFromCards(cards, {
      siteId: p.before.siteId,
      shiftTypeId: p.before.shiftTypeId,
      shiftTypeCode: p.before.shiftType.code,
      shiftTypeBillingGroup: p.before.shiftType.billingGroup ?? "per_shift",
      settlementBrokerId: p.settlementBrokerId,
      brokerKind: p.settlementBrokerId ? (kindOf.get(p.settlementBrokerId) ?? null) : null,
      guardId: p.before.guardId,
      workDate: p.before.workDate,
      isExternal: p.before.isExternal,
      recordType: p.recordType,
    });
    p.pricingSource = pricing.source as Record<string, unknown>;
    p.data = { ...p.data, clientRateSnapshot: pricing.clientRate ?? null, guardWageSnapshot: pricing.guardWage ?? null, brokerFeeSnapshot: pricing.brokerFee ?? null };
  }

  // ---- 寫入（一個 transaction；audit 喺 commit 後先寫）----
  const afters = new Map<string, ShiftRecord>();
  if (plans.size > 0) {
    await prisma.$transaction(
      async (tx) => {
        await assertMonthNotLockedTx(tx, { workDate: start, actorUserId, tableName: "shift_records", rowId: "attendance-fix", ip });
        const ids = [...plans.keys()].sort();
        await tx.$queryRaw`SELECT id FROM shift_records WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
        for (const p of plans.values()) afters.set(p.id, await tx.shiftRecord.update({ where: { id: p.id }, data: p.data }));
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    // `via` 標記經 AUDIT_META_PASSTHROUGH_KEYS 保留（shift_records audit 其餘欄位照 DTO mapping）
    await writeAuditMany([...plans.values()].map((p) => ({ actorUserId, tableName: "shift_records", rowId: p.id, action: "update" as const, before: p.before, after: { ...afters.get(p.id)!, via: "longterm_attendance_fix" }, ip })));
    // N4 不變式：寫咗價錢 snapshot 就補 journal（best effort，令 undo 清得到）
    const uses: AutoCardUse[] = [];
    for (const p of plans.values()) {
      if (!p.pricingSource) continue;
      const a = afters.get(p.id)!;
      uses.push({ recordId: p.id, before: [toNum(p.before.clientRateSnapshot), toNum(p.before.guardWageSnapshot), toNum(p.before.brokerFeeSnapshot)], after: [toNum(a.clientRateSnapshot), toNum(a.guardWageSnapshot), toNum(a.brokerFeeSnapshot)], ...p.pricingSource });
    }
    await journalAutoCardUsesSafe(uses);
  }
  const updated = results.filter((r) => r.action === "updated").length;
  return { results, updated, noop: updated === 0 };
}
