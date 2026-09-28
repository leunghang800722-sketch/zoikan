import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeShiftRecordWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerShiftRecordDTO } from "@/lib/broker-dto";
import { toShiftRecordFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { ShiftRecordUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict, NotFound } from "@/lib/api/errors";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, OT_HOURLY_PRICING_FROM, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const { id } = await params;
    const where = scopeShiftRecordWhere(session, { id });
    const row = await prisma.shiftRecord.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerShiftRecordDTO(row)));
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 雞頭「更表:update」硬性 deny（C3），呢個 route 淨係內部角色行得到。
    const session = await requirePermission(req, "更表", "update");
    const { id } = await params;
    const where = scopeShiftRecordWhere(session, { id });
    const before = await prisma.shiftRecord.findFirst({ where });
    if (!before) throw NotFound();

    // 改更本身用舊 work_date 嘅月份判斷鎖定；如果 body 有帶新 work_date
    // 想搬去另一個月，兩個月份都要冚（防止靠改期避開鎖定，或者反過來
    // 寫入一個已鎖定嘅月）。
    await assertMonthNotLocked({ workDate: before.workDate, actorUserId: session.userId, tableName: "shift_records", rowId: id, ip: getClientIp(req) });

    const rawBody = await readJson(req);
    // S4：改用 parseBody(ShiftRecordUpdateSchema)——之前用 pickFields+
    // coerceDateFields，日期格式錯會一路衝到 Prisma 先爆 500；而家 zod
    // 喺呢度就 400。
    const parsed = parseBody(ShiftRecordUpdateSchema, rawBody);
    await assertFieldGroupWritable(session, "shift_records", parsed);

    if (parsed.shift_type_id) {
      const st = await prisma.shiftType.findUnique({ where: { id: parsed.shift_type_id }, select: { siteId: true } });
      if (!st) throw BadRequest("shift_type_id 唔存在");
      if (st.siteId !== before.siteId) throw BadRequest("shift_type_id 唔屬於呢條更次原本嘅 site");
    }

    if (parsed.work_date) {
      await assertMonthNotLocked({
        workDate: parsed.work_date,
        actorUserId: session.userId,
        tableName: "shift_records",
        rowId: id,
        ip: getClientIp(req),
      });
    }

    const data = snakeToCamelShallow(parsed) as Prisma.ShiftRecordUncheckedUpdateInput;

    // WP-BOSS5 驗收項 2：改 `ot_hours`（OT 記錄、workDate≥2026-08-01）要
    // 用 resolver 用新小時重新計价——snapshot 本身係「金額」＝每小時价×
    // 小時，淨改小時、唔跟住重算金額嘅話，個「每小時价」會靜靜錯咗（例如
    // 3.5 小時卡×2 小時嘅金額改成 3.5 小時就代表緊錯咗嘅每小時价）。
    // 揀嘅做法：
    //   1. 呢次 PATCH 有帶 `ot_hours`、冇同時帶三個 snapshot 欄（帶咗就
    //      當用戶自己指定金額，唔喺呢度插手）、記錄本身係 OT、
    //      workDate≥2026-08-01 先觸發；
    //   2. resolver 揾到 OT 卡 → 三欄覆蓋做「每小時价×新小時」（同
    //      resolve-rate.ts `applyOtHourlyPricing()` 一致口徑，hours 為
    //      0/搵唔到都已經喺 resolver 入面變返 null＋unpriced）；
    //   3. resolver 完全揾唔到卡：
    //      - 之前三個 snapshot 本身已經全部 null（本來就係未定价 OT）
    //        → 維持三欄 null（冇嘢好覆蓋，等新小時都係未定价 OT）；
    //      - 之前三個 snapshot 任一非 null（呢個金額冇對應卡，即係人手
    //        輸入／舊卡刪咗）→ 409：唔准淨改小時令個「金額」同「新小時」
    //        再對唔上（會令 84.85/小時嗰類每小時价靜靜變錯），要求用戶
    //        先手動清空三欄先改小時，等佢自己揀新金額。
    const rawKeys = new Set(Object.keys(rawBody));
    const otHoursProvided = rawKeys.has("ot_hours");
    const pricingFieldsProvided = rawKeys.has("client_rate_snapshot") || rawKeys.has("guard_wage_snapshot") || rawKeys.has("broker_fee_snapshot");
    const effectiveWorkDate = parsed.work_date ?? before.workDate;
    if (otHoursProvided && !pricingFieldsProvided && before.recordType === "ot" && effectiveWorkDate.getTime() >= OT_HOURLY_PRICING_FROM.getTime()) {
      const effectiveShiftTypeId = parsed.shift_type_id ?? before.shiftTypeId;
      const [shiftType, broker] = await Promise.all([
        prisma.shiftType.findUnique({ where: { id: effectiveShiftTypeId }, select: { code: true, billingGroup: true } }),
        before.settlementBrokerId ? prisma.broker.findUnique({ where: { id: before.settlementBrokerId }, select: { kind: true } }) : Promise.resolve(null),
      ]);
      const cards = await fetchEffectiveRateCards(before.siteId, effectiveWorkDate, effectiveWorkDate);
      const pricing = resolveShiftPricingFromCards(cards, {
        siteId: before.siteId,
        shiftTypeId: effectiveShiftTypeId,
        shiftTypeCode: shiftType?.code ?? "",
        shiftTypeBillingGroup: shiftType?.billingGroup ?? "per_shift",
        settlementBrokerId: before.settlementBrokerId,
        brokerKind: (broker?.kind as BrokerKindLike | undefined) ?? null,
        guardId: parsed.guard_id ?? before.guardId,
        workDate: effectiveWorkDate,
        isExternal: parsed.is_external ?? before.isExternal,
        recordType: "ot",
        otHours: Number(parsed.ot_hours),
      });
      const cardFound = pricing.clientCardFound || pricing.payoutCardFound;
      if (cardFound) {
        data.clientRateSnapshot = pricing.clientRate;
        data.guardWageSnapshot = pricing.guardWage;
        data.brokerFeeSnapshot = pricing.brokerFee;
      } else {
        const beforeHadValue = before.clientRateSnapshot !== null || before.guardWageSnapshot !== null || before.brokerFeeSnapshot !== null;
        if (beforeHadValue) {
          throw Conflict("呢條 OT 記錄嘅收客價／出街價冇對應卡（人手輸入或者卡已刪）——請先清空 client_rate_snapshot／guard_wage_snapshot／broker_fee_snapshot 先改 ot_hours，避免舊金額同新小時對唔上。");
        }
        data.clientRateSnapshot = null;
        data.guardWageSnapshot = null;
        data.brokerFeeSnapshot = null;
      }
    }

    const after = await prisma.shiftRecord.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(after)));
  });
}
