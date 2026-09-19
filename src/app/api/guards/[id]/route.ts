import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole, isInternalRole } from "@/lib/broker-isolation";
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
import {
  applyLegacyStaffNoPatch,
  writeStaffNumberAudits,
  deriveSiaPermitExpiry,
  canOverrideDerivedSiaPermit,
  isSiaPermitBLapsedByAge,
  assertNoLegacySiaPermitWrite,
  assertBrokerNoLegacyStaffNoWrite,
} from "@/lib/guards/staff-numbers";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Guard, Prisma } from "@prisma/client";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

// S5（Opus 驗收修復）：`sia_permit_expiry`／`sia_permit_type` 讀取時一律
// 現算（覆蓋 DB 欄）——同 `src/app/api/guards/route.ts` 列表一致理由
// （DB 欄寫入時有更新，但「時間流逝」引致嘅陳舊，例如生日過咗令乙類滿
// 70 歲失效，冇再寫入就唔會自動反映）。
//
// 必修 1(b)（Opus 驗收第二輪）：甲／乙類到期日（`sia_permit_a_expiry`／
// `sia_permit_b_expiry`）兩個都係 null 嘅時候，`deriveSiaPermitExpiry()`
// 一定計出 {null,null}——呢種情況唔可以用現算值覆蓋 DB 原有嘅
// `sia_permit_expiry`／`sia_permit_type`（可能仲存住 migration backfill
// 唔到、或者人手都未補嘅舊資料，見 migration.sql「(1) 甲／乙類到期日
// backfill」大註解）；一律保留 DB 原值，唔覆蓋、唔喺呢層計。淨係當 a／b
// 其中一個有值，先用現算值覆蓋（呢種情況先有足夠資訊重新推導，包括乙類
// 滿 70 歲失效呢類會令現算結果變返 null 嘅合法轉變）。
//
// 必修 1／4（Opus 驗收第三輪）：上面呢個判斷而家抽做共用嘅
// `canOverrideDerivedSiaPermit()`（見 src/lib/guards/staff-numbers.ts
// 大註解，PATCH 寫入層／script 三處共用，避免各自抄一次、漏咗一層），
// 讀取層冇「之前」概念，一律 default `hadValueBefore=false`，行為同之前
// 一致。順手加埋 `siaPermitBLapsedByAge`（衍生 flag，唔係 PII）——乙類
// 因為滿 70 歲失效嗰陣，列表/抽屜唔應該顯示成「未填」，見
// src/lib/guards/staff-numbers.ts isSiaPermitBLapsedByAge() 頂註解。
function withDerivedGuard<T extends Guard>(row: T): T & { siaPermitBLapsedByAge: boolean } {
  const siaPermitBLapsedByAge = isSiaPermitBLapsedByAge(row);
  if (!canOverrideDerivedSiaPermit({ siaPermitAExpiry: row.siaPermitAExpiry, siaPermitBExpiry: row.siaPermitBExpiry })) {
    return { ...row, siaPermitBLapsedByAge };
  }
  return { ...row, ...deriveSiaPermitExpiry(row), siaPermitBLapsedByAge };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const row = await prisma.guard.findFirst({ where });
    if (!row) throw NotFound();
    const derived = withDerivedGuard(row);
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(derived)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(derived)));
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
    // M2a（Opus 驗收修復）：雞頭帶 staff_no／staff_no_mw 一律 403（硬性，
    // 唔靠矩陣個 cell），見 src/lib/guards/staff-numbers.ts
    // assertBrokerNoLegacyStaffNoWrite() 頂註解。
    assertBrokerNoLegacyStaffNoWrite(isBrokerRole(session), body);
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
    //
    // 必修 1（Opus 驗收第三輪）：merge 之後 a／b 兩個都 null 嗰陣，
    // `deriveSiaPermitExpiry()` 一定計出 {null,null}——呢個之前完全冇擋，
    // 例如 guard 舊值 a/b 都係 null（migration backfill 唔到嘅舊資料，
    // 見 migration.sql「(1)」）、舊 `sia_permit_expiry`／`sia_permit_type`
    // 仲存住有效資料，淨係 PATCH 改 `date_of_birth`（完全唔關牌照事）都
    // 會觸發呢段、將個 {null,null} 寫落去，永久毀走舊值——同讀取層／
    // script 早已有嘅安全閥唔一致（漏咗寫入層呢層）。而家用共用嘅
    // `canOverrideDerivedSiaPermit()`（見 src/lib/guards/staff-numbers.ts
    // 大註解）：`hadValueBefore` 傳 `before` 呢個 guard a／b 有冇值——如果
    // merge 之後兩個都 null，但 `before` 原本 a／b 至少一個有值，即係
    // 用戶今次明確將佢哋清空，先寫 null（反映用戶嘅明確操作）；如果
    // `before` 本身 a／b 就已經係 null（冇嘢好清），就算 body 送咗
    // `null`（同現值一樣，唔算真轉變）都唔寫，保留 DB 原有
    // `sia_permit_expiry`／`sia_permit_type`。
    const DERIVED_INPUT_KEYS = ["siaPermitAExpiry", "siaPermitBExpiry", "dateOfBirth"] as const;
    if (DERIVED_INPUT_KEYS.some((k) => k in data)) {
      const merged = {
        siaPermitAExpiry: "siaPermitAExpiry" in data ? ((data as Record<string, unknown>).siaPermitAExpiry as Date | null) : before.siaPermitAExpiry,
        siaPermitBExpiry: "siaPermitBExpiry" in data ? ((data as Record<string, unknown>).siaPermitBExpiry as Date | null) : before.siaPermitBExpiry,
        dateOfBirth: "dateOfBirth" in data ? ((data as Record<string, unknown>).dateOfBirth as Date | null) : before.dateOfBirth,
      };
      const hadValueBefore = before.siaPermitAExpiry != null || before.siaPermitBExpiry != null;
      if (canOverrideDerivedSiaPermit({ siaPermitAExpiry: merged.siaPermitAExpiry, siaPermitBExpiry: merged.siaPermitBExpiry, hadValueBefore })) {
        const derived = deriveSiaPermitExpiry(merged);
        (data as Record<string, unknown>).siaPermitExpiry = derived.siaPermitExpiry;
        (data as Record<string, unknown>).siaPermitType = derived.siaPermitType;
      }
    }

    const { guardAfter, legacyChanges } = await prisma.$transaction(async (tx) => {
      let guardAfter: Guard = before;
      if (Object.keys(data).length > 0) {
        guardAfter = await tx.guard.update({ where: { id }, data });
      }
      const legacyResult =
        staffNoLegacy || staffNoMwLegacy
          ? await applyLegacyStaffNoPatch(tx, {
              guardId: id,
              staffNo: staffNoLegacy,
              staffNoMw: staffNoMwLegacy,
              createdBy: session.userId,
              revealConflictGuardId: isInternalRole(session),
            })
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
    const derivedAfter = withDerivedGuard(guardAfter);
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(derivedAfter)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(derivedAfter)));
  });
}
