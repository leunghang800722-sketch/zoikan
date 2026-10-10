// WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）：
// 電話獨立子表——GET（primary 先、其餘跟住，`createdAt` 排序）／POST
// （新增一行；第一行自動變 primary，之後跟 `is_primary`，原 primary
// 自動降級）。跟 `src/app/api/guards/[id]/staff-numbers/route.ts` 一致
// 嘅 module selector 模式（內部角色「保安員」，雞頭「自己保安員」），寫入
// （POST）一樣硬性擋雞頭——「雞頭 session 只可以讀自己啲人，唔可以寫」
// 係呢個子資源嘅絕對規則，唔靠矩陣個 cell 出廠開關（同 staff-numbers 一
// 致理由，見嗰個檔案頂註解）。
import { guardModule, assertScopedGuard } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { toGuardPhoneDTO } from "@/lib/api/dto";
import { toGuardPhoneBrokerDTO } from "@/lib/broker-dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardPhoneCreateSchema } from "@/lib/api/schemas";
import { createGuardPhone, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { assertTelAvailable, rethrowIdentityConflict } from "@/lib/guards/identity";
import { writeAudit } from "@/lib/audit";
import { Forbidden } from "@/lib/api/errors";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    await assertScopedGuard(session, id);
    const rows = await prisma.guardPhone.findMany({ where: { guardId: id }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] });
    // 雞頭讀呢個 sub-resource 用窄版 DTO（tel／label／is_primary，冇
    // note／source／created_by），內部角色先見全欄，見
    // src/lib/broker-dto.ts GUARD_PHONE_BROKER_FIELDS 頂註解。
    const mapper = isBrokerRole(session) ? toGuardPhoneBrokerDTO : toGuardPhoneDTO;
    return ok(rows.map(mapper));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以新增電話");
    const { id } = await params;
    await assertScopedGuard(session, id);
    const body = await readJson(req);
    const parsed = parseBody(GuardPhoneCreateSchema, body);

    const result = await prisma.$transaction(async (tx) => {
      // WP-STAFF-IMPORT B1：電話全表唯一——同另一個保安員重複 → 409（唔回顯對方資料）。
      await assertTelAvailable(tx, parsed.tel, id);
      const created = await createGuardPhone(tx, {
        guardId: id,
        tel: parsed.tel,
        label: parsed.label ?? null,
        isPrimary: parsed.is_primary,
        note: parsed.note ?? null,
        source: "manual",
        createdBy: session.userId,
      });
      await syncLegacyGuardContactColumns(tx, id, ["tel"]);
      return created;
    }).catch(rethrowIdentityConflict);

    await writeAudit({ actorUserId: session.userId, tableName: "guard_phones", rowId: result.created.id, action: "create", after: result.created, ip: getClientIp(req) });
    if (result.demotedPrimary) {
      await writeAudit({
        actorUserId: session.userId,
        tableName: "guard_phones",
        rowId: result.demotedPrimary.after.id,
        action: "update",
        before: result.demotedPrimary.before,
        after: result.demotedPrimary.after,
        ip: getClientIp(req),
      });
    }

    return ok(
      brandSafeResponse({
        ...toGuardPhoneDTO(result.created),
        demotedPrimary: result.demotedPrimary ? toGuardPhoneDTO(result.demotedPrimary.after) : null,
      }),
      201,
    );
  });
}
