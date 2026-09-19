import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO } from "@/lib/broker-dto";
import { toGuardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable, dropUnchangedFieldGroupValues } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import { applyLegacyStaffNoPatch, writeStaffNumberAudits, deriveSiaPermitExpiry, assertNoLegacySiaPermitWrite } from "@/lib/guards/staff-numbers";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Guard, Prisma } from "@prisma/client";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const row = await prisma.guard.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(row)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const before = await prisma.guard.findFirst({ where });
    if (!before) throw NotFound();
    const body = await readJson(req);
    assertNoLegacySiaPermitWrite(body);
    const parsed = parseBody(GuardUpdateSchema, body);
    // WP-PII（Opus 驗收必修 2a）：前端編輯抽屜起草成個 form，撳「儲存」
    // 成個 form 一齊送——冇改嘅 field-group 受控欄（例如長工冇改月薪，
    // 但主管淨係改咗電話）唔算「想寫」，先由 body 度刪走，先至再
    // assertFieldGroupWritable()（唔係就會被冇改嘅欄嗰個 field-group
    // 誤 403，見 src/lib/api/field-groups.ts dropUnchangedFieldGroupValues()
    // 大註解）。
    const effectiveBody = await dropUnchangedFieldGroupValues(session, "guards", parsed, before as unknown as Record<string, unknown>);
    // WP-PII：body 帶「收客價/出街價/安員個人資料/安員銀行資料」任何一組
    // 欄位，冇對應 module 嘅 update 權限一律 403（唔准靜靜忽略）——同
    // rate-cards/sites 等 route 一致做法（見 src/lib/api/field-groups.ts）。
    await assertFieldGroupWritable(session, "guards", effectiveBody);

    // WP-STAFFNO：`staff_no`／`staff_no_mw`（舊前端／舊 API 用法）而家係
    // 由 `guard_staff_numbers` 新表 sync 返嚟嘅值，唔可以再直接落
    // `prisma.guard.update()`（唔係就會同新表寫入撞埋、兩邊唔一致）——
    // 抽出嚟轉做對新表嘅 upsert（`applyLegacyStaffNoPatch()`），落完數
    // 由佢自己喺同一個 transaction 內 sync 返呢兩個欄。
    //
    // 「值冇變就當冇改」——同 dropUnchangedFieldGroupValues() 一致精神
    // （見 src/lib/api/field-groups.ts 大註解）：前端編輯抽屜起草成個
    // form，撳「儲存」成個 form（包括未改嘅 `staff_no`）一齊送。呢兩個
    // 欄冇 field-group view/update oracle 問題（唔係 PII，全部有權睇嘅
    // 角色都見到現值），淨係值同 `before.staffNo`/`staffNoMw`（呢個
    // guard 而家真係嘅 current 值）一樣就跳過——唔係嘅話，每次撳「儲存」
    // （包括淨係改電話呢類完全唔關工號事嘅編輯）都會重新觸發
    // `applyLegacyStaffNoPatch()`，同「呢個號本身已經係呢個 guard 嘅
    // current」呢個真實狀態撞正 `upsertCurrentStaffNumber()` 嘅「number
    // 已經有人用緊」檢查（呢個檢查刻意唔理會「有人」係咪即係自己，逼
    // 真正想轉號一定要行呢個 upsert，一個 no-op 嘅重複送出唔應該被拒）。
    const rawStaffNo = (effectiveBody as Record<string, unknown>).staff_no as string | undefined;
    const rawStaffNoMw = (effectiveBody as Record<string, unknown>).staff_no_mw as string | undefined;
    const staffNoLegacy = rawStaffNo && rawStaffNo.trim().toUpperCase() !== (before.staffNo ?? "").toUpperCase() ? rawStaffNo : undefined;
    const staffNoMwLegacy = rawStaffNoMw && rawStaffNoMw.trim().toUpperCase() !== (before.staffNoMw ?? "").toUpperCase() ? rawStaffNoMw : undefined;
    const rest = { ...(effectiveBody as Record<string, unknown>) };
    delete rest.staff_no;
    delete rest.staff_no_mw;
    const data = snakeToCamelShallow(rest) as Prisma.GuardUncheckedUpdateInput;

    // WP-STAFFNO：body 改咗甲／乙到期日或者出生日期，就要重新計
    // `sia_permit_expiry`／`sia_permit_type`（三個 input 入面隨便一個變
    // 咗都要重算，用 `before` 補返冇改嗰啲）。
    const DERIVED_INPUT_KEYS = ["siaPermitAExpiry", "siaPermitBExpiry", "dateOfBirth"] as const;
    if (DERIVED_INPUT_KEYS.some((k) => k in data)) {
      const merged = {
        siaPermitAExpiry: "siaPermitAExpiry" in data ? ((data as Record<string, unknown>).siaPermitAExpiry as Date | null) : before.siaPermitAExpiry,
        siaPermitBExpiry: "siaPermitBExpiry" in data ? ((data as Record<string, unknown>).siaPermitBExpiry as Date | null) : before.siaPermitBExpiry,
        dateOfBirth: "dateOfBirth" in data ? ((data as Record<string, unknown>).dateOfBirth as Date | null) : before.dateOfBirth,
      };
      const derived = deriveSiaPermitExpiry(merged);
      (data as Record<string, unknown>).siaPermitExpiry = derived.siaPermitExpiry;
      (data as Record<string, unknown>).siaPermitType = derived.siaPermitType;
    }

    const { guardAfter, legacyChanges } = await prisma.$transaction(async (tx) => {
      let guardAfter: Guard = before;
      if (Object.keys(data).length > 0) {
        guardAfter = await tx.guard.update({ where: { id }, data });
      }
      const legacyResult =
        staffNoLegacy || staffNoMwLegacy
          ? await applyLegacyStaffNoPatch(tx, { guardId: id, staffNo: staffNoLegacy, staffNoMw: staffNoMwLegacy, createdBy: session.userId })
          : { changes: [] };
      if (legacyResult.changes.length > 0) {
        guardAfter = await tx.guard.findUniqueOrThrow({ where: { id } });
      }
      return { guardAfter, legacyChanges: legacyResult.changes };
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "update", before, after: guardAfter, ip: getClientIp(req) });
    if (legacyChanges.length > 0) {
      await writeStaffNumberAudits(session.userId, legacyChanges, getClientIp(req));
    }
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(guardAfter)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(guardAfter)));
  });
}
