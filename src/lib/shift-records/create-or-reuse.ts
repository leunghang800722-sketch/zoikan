// G2（Gemini 審查跟進）：單條新建 shift_record——撞 unique（guard／日／更別）而
// 現存行係 status=cancelled 就「重用」呢行（update），唔再 409。同更表 batch
// （existingByKey）、更表上載（reconcile-apply）一致。非 cancelled 嘅現存行仍然 409
// （呼叫者見到 P2002 或 Conflict 就轉 409）。audit 同 create／update 喺同一個 transaction。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { MANUAL_SOURCE } from "@/lib/longterm-payroll/attendance-priority";
import { resolveShiftStaffNumbers, staffNumberData } from "@/lib/shift-records/staff-number";


export interface CreateOrReuseResult {
  record: Prisma.ShiftRecordGetPayload<object>;
  reused: boolean;
  /** EMP-P1：冇推到工號卡（唔擋儲存）。 */
  noStaffNumber: boolean;
}

/** 重用 cancelled 行時，先將所有「非 key」欄重設做新建預設，再蓋上今次 data——避免舊行殘留
 * （例如舊 OT 時數、parent、billed／paid、人手 rescue 價、provenance）。id／createdAt／createdBy 保留。 */
function resetDefaults(): Prisma.ShiftRecordUncheckedUpdateInput {
  return {
    settlementBrokerId: null,
    operationalBrokerId: null,
    referralFeeSnapshot: null,
    rescueRate: null,
    status: "confirmed", // create 預設；雞頭分支／caller 明確帶 status 會蓋過
    recordType: "shift",
    leaveCode: null,
    otHours: null,
    parentShiftId: null,
    locationTag: null,
    isExternal: false,
    billed: false,
    paid: false,
    settlementPage: null,
    clientRateSnapshot: null,
    guardWageSnapshot: null,
    brokerFeeSnapshot: null,
    provenance: Prisma.DbNull, // SQL NULL（唔係 JSON null）
    // EMP-P1：工號歸屬三欄一齊清（跟住會按今次資料重新推導）
    staffNumberId: null,
    staffScheme: null,
    staffNumberSource: null,
  };
}

export async function createOrReuseShiftRecord(input: {
  data: Prisma.ShiftRecordUncheckedCreateInput;
  actorUserId: string;
  ip: string | null;
}): Promise<CreateOrReuseResult> {
  const { data, actorUserId, ip } = input;
  const source = data.source ?? MANUAL_SOURCE;
  return prisma.$transaction(async (tx) => {
    // EMP-P1：推導用邊張工號卡（同一 tx）；payload 明確 staff_number_id 會驗證屬同一個 guard。
    const staffMissing = new Set<string>();
    const staff = (
      await resolveShiftStaffNumbers(
        tx,
        [{ key: "k", guardId: data.guardId, siteId: data.siteId, workDate: data.workDate as Date, explicitStaffNumberId: typeof data.staffNumberId === "string" ? data.staffNumberId : null, settlementBrokerId: (data.settlementBrokerId as string | null | undefined) ?? null }],
        staffMissing,
      )
    ).get("k") ?? null;
    const staffData = staffNumberData(staff);
    const existing = await tx.shiftRecord.findUnique({
      where: { guardId_workDate_shiftTypeId: { guardId: data.guardId, workDate: data.workDate as Date, shiftTypeId: data.shiftTypeId } },
    });
    if (!existing) {
      const created = await tx.shiftRecord.create({ data: { ...data, ...staffData, source, createdBy: actorUserId } });
      await writeAuditTx(tx, { actorUserId, tableName: "shift_records", rowId: created.id, action: "create", after: created, ip });
      return { record: created, reused: false, noStaffNumber: staffMissing.has("k") };
    }
    if (existing.status !== "cancelled") {
      // 同現行語意一致：交俾呼叫者轉 409（用同 P2002 一樣嘅 code，route 既有 catch 直接接住）。
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed (active shift_record exists)", { code: "P2002", clientVersion: Prisma.prismaVersion.client });
    }
    const { guardId: _g, workDate: _w, shiftTypeId: _s, ...rest } = data;
    void _g; void _w; void _s;
    const updated = await tx.shiftRecord.update({
      where: { id: existing.id },
      data: { ...resetDefaults(), ...(rest as Prisma.ShiftRecordUncheckedUpdateInput), ...staffData, source },
    });
    await writeAuditTx(tx, {
      actorUserId,
      tableName: "shift_records",
      rowId: updated.id,
      action: "update",
      before: existing,
      after: { ...updated, reused_cancelled: true },
      ip,
    });
    return {
      record: updated,
      reused: true,
      noStaffNumber: staffMissing.has("k"),
    };
  });
}
