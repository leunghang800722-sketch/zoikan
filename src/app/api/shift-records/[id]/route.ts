import { MANUAL_SOURCE } from "@/lib/longterm-payroll/attendance-priority";
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
import { journalAutoCardUsesSafe, toNum } from "@/lib/pricing/auto-card-journal";
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

    // WP-BOSS5 驗收項 2（Opus 5.5 覆核應修 a）：改 `ot_hours`（OT 記錄、
    // workDate≥2026-08-01）要用 resolver 用新小時重新計價——snapshot 本身
    // 係「金額」＝每小時價×小時，淨改小時、唔跟住重算金額嘅話，個「每
    // 小時價」會靜靜錯咗（例如 3.5 小時卡×2 小時嘅金額改成 3.5 小時就
    // 代表緊錯咗嘅每小時價）。
    // 揀嘅做法：
    //   0. 帶咗 `ot_hours` 又帶咗三個 snapshot 欄其中一兩個（唔係三個一
    //      齊帶）→ 400——唔准淨帶部分欄，等 client／wage／fee 三個一齊
    //      嚟自「同一個」用戶決定，唔會出現「一半用戶手動值、一半 resolver
    //      值」呢種夾雜狀態。
    //   1. 有帶 `ot_hours`、冇同時帶齊三個 snapshot 欄（帶齊三個就當用戶
    //      自己指定成套金額，唔喺呢度插手）、記錄本身係 OT、
    //      workDate≥2026-08-01 先觸發自動重新計價；
    //   2. **逐邊獨立判斷**（唔係「有一邊搵到就成組覆蓋」）：
    //      - 收客價：resolver 揾到收客卡 → 覆蓋 `client_rate_snapshot`；
    //        揾唔到但之前非 null（人手輸入冇對應卡）→ 409；揾唔到而之前
    //        本身已經 null → 維持 null。
    //      - 出街價：resolver 揾到出街卡 → 覆蓋 `guard_wage_snapshot`／
    //        `broker_fee_snapshot`；揾唔到但之前兩個任一非 null → 409；
    //        揾唔到而之前兩個都已經 null → 維持 null。
    //      呢個分法避免「淨係揾到收客卡冇出街卡」（或者反過來）嗰種常見
    //      情況一律靜靜清走揾唔到嗰邊嘅人手金額（或者一律 409 攔住連
    //      揾到嘅嗰邊都唔覆蓋）。
    const rawKeys = new Set(Object.keys(rawBody));
    const otHoursProvided = rawKeys.has("ot_hours");
    const clientFieldProvided = rawKeys.has("client_rate_snapshot");
    const wageFieldProvided = rawKeys.has("guard_wage_snapshot");
    const feeFieldProvided = rawKeys.has("broker_fee_snapshot");
    const anyPricingFieldProvided = clientFieldProvided || wageFieldProvided || feeFieldProvided;
    const allPricingFieldsProvided = clientFieldProvided && wageFieldProvided && feeFieldProvided;
    const effectiveWorkDate = parsed.work_date ?? before.workDate;
    const otReconsiderApplies = otHoursProvided && before.recordType === "ot" && effectiveWorkDate.getTime() >= OT_HOURLY_PRICING_FROM.getTime();
    if (otReconsiderApplies && anyPricingFieldProvided && !allPricingFieldsProvided) {
      throw BadRequest(
        "改 ot_hours 同時要帶 client_rate_snapshot／guard_wage_snapshot／broker_fee_snapshot 就要三個一齊帶，唔可以淨帶其中一兩個。",
      );
    }
    let otPricingSource: { clientCardId?: string; payoutCardId?: string } = {};
    if (otReconsiderApplies && !allPricingFieldsProvided) {
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

      otPricingSource = pricing.source;
      // 收客價：獨立判斷。
      if (pricing.clientCardFound) {
        data.clientRateSnapshot = pricing.clientRate;
      } else if (before.clientRateSnapshot !== null) {
        throw Conflict("呢條 OT 記錄嘅收客價冇對應卡（人手輸入或者卡已刪）——請先清空 client_rate_snapshot 先改 ot_hours，避免舊金額同新小時對唔上。");
      }
      // 出街價（guard_wage／broker_fee 一組）：獨立判斷，唔受收客價嗰邊
      // 揾唔揾到卡影響。
      if (pricing.payoutCardFound) {
        data.guardWageSnapshot = pricing.guardWage;
        data.brokerFeeSnapshot = pricing.brokerFee;
      } else if (before.guardWageSnapshot !== null || before.brokerFeeSnapshot !== null) {
        throw Conflict(
          "呢條 OT 記錄嘅出街價冇對應卡（人手輸入或者卡已刪）——請先清空 guard_wage_snapshot／broker_fee_snapshot 先改 ot_hours，避免舊金額同新小時對唔上。",
        );
      }
    }

    // P18：改 record_type／leave_code（出勤代號）寫 source=manual，令來源優先次序以人手改動為準（同 batch 一致）。
    if ((parsed.record_type !== undefined && parsed.record_type !== before.recordType) || (parsed.leave_code !== undefined && parsed.leave_code !== before.leaveCode)) {
      data.source = MANUAL_SOURCE;
    }
    const after = await prisma.shiftRecord.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    if (otPricingSource.clientCardId || otPricingSource.payoutCardId) {
      await journalAutoCardUsesSafe([{ recordId: id, before: [toNum(before.clientRateSnapshot), toNum(before.guardWageSnapshot), toNum(before.brokerFeeSnapshot)], after: [toNum(after.clientRateSnapshot), toNum(after.guardWageSnapshot), toNum(after.brokerFeeSnapshot)], ...otPricingSource }]);
    }
    return ok(await applyFieldGroupGate(session, "shift_records", toShiftRecordFullDTO(after)));
  });
}
