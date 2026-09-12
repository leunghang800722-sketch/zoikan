// 角色權限管理（設計文件§5.0「分頁+勾選格矩陣」）：GET 攞成個矩陣（連
// hard_denied 旗標，UI 應該用嚟灰咗嗰格＋唔畀剔——即「UI 唔顯示」嗰句）；
// PATCH 逐格開關 granted。
//
// 硬性規則防線：即使有人跳過 UI 直接打 PATCH 想開一個 hard_denied 嘅格，
// 呢度都照拒（400），唔淨係靠 requirePermission() runtime 拒——雙重保險，
// 亦即「✗ 硬性禁止：seed 唔生成、API 拒絕、UI 唔顯示」三個保證入面
// 「API 拒絕」嗰句喺呢度實現（另一半 runtime 拒喺 requirePermission.ts）。
//
// Opus 驗收殘留2：硬性禁止查詢用 role.base_role（唔係 role.name）——
// 自訂角色複製之後改名唔會逃過。
// Opus 驗收殘留6：PATCH 之前逐個 change 都查一次 prisma.permission.
// findUnique()（N 次查詢），而家改成事先一次 findMany() 攞晒 50/95 個
// permission 落嚟做 lookup map。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RolePermissionsPatchSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ACTIONS, MODULES, ROLE_NAMES, isHardDenied, type RoleName } from "@/lib/rbac/matrix";

function matrixRoleNameFor(baseRole: string): RoleName | null {
  return (ROLE_NAMES as readonly string[]).includes(baseRole) ? (baseRole as RoleName) : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "用戶管理", "view");
    const { id } = await params;
    const role = await prisma.role.findUnique({ where: { id }, include: { rolePermissions: { include: { permission: true } } } });
    if (!role) throw NotFound();

    const matrixRole = matrixRoleNameFor(role.baseRole);
    const grantedMap = new Map(role.rolePermissions.map((rp) => [`${rp.permission.module}:${rp.permission.action}`, rp.granted]));

    const cells = [];
    for (const mod of MODULES) {
      for (const action of ACTIONS) {
        const key = `${mod}:${action}`;
        // 未知 base_role（理論上唔應該發生，DB constraint 冧唔到但都預留
        // 防禦）——「未知角色一律當最嚴」，全部當 hard_denied。
        const hardDenied = matrixRole ? isHardDenied(matrixRole, mod, action) : true;
        cells.push({ module: mod, action, granted: grantedMap.get(key) ?? false, hard_denied: hardDenied });
      }
    }
    return ok(brandSafeResponse({ role_id: role.id, role_name: role.name, base_role: role.baseRole, cells }));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "用戶管理", "update");
    const { id } = await params;
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw NotFound();
    const matrixRole = matrixRoleNameFor(role.baseRole);

    const body = await readJson(req);
    const { changes } = parseBody(RolePermissionsPatchSchema, body);

    // S5（Opus 對抗式驗收）：一定要先驗 permission 存在先行 hard-deny
    // check——舊版次序調轉，一個未知 module（例如舊「報表:view」，C3 已
    // 經拆咗冇呢個 module）會令 `isHardDenied()` 喺 matrix.ts 嘅 plain
    // object lookup 攞到 `undefined` 再 `.view` 落去，拋一個未捕捉嘅
    // TypeError（500），唔係乾淨嘅 400。而家一律先查 permission 存唔存
    // 在（一次 findMany，殘留6），唔存在即刻 400，先至去到 hard-deny
    // check（呢個時候 module/action 一定係真實存在過嘅組合）。
    const allPermissions = await prisma.permission.findMany();
    const permissionIdByKey = new Map(allPermissions.map((p) => [`${p.module}:${p.action}`, p.id]));
    for (const c of changes) {
      if (!permissionIdByKey.has(`${c.module}:${c.action}`)) throw BadRequest(`未知 permission：${c.module}:${c.action}`);
    }

    for (const c of changes) {
      if (matrixRole && c.granted && isHardDenied(matrixRole, c.module as never, c.action as never)) {
        throw BadRequest(`角色「${role.name}」（base_role=${role.baseRole}）嘅 ${c.module}:${c.action} 係硬性禁止，唔可以開`);
      }
    }

    const before = await prisma.rolePermission.findMany({ where: { roleId: id }, include: { permission: true } });

    await prisma.$transaction(
      changes.map((c) => {
        const permissionId = permissionIdByKey.get(`${c.module}:${c.action}`)!;
        return prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: id, permissionId } },
          create: { roleId: id, permissionId, granted: c.granted, createdBy: session.userId },
          update: { granted: c.granted },
        });
      }),
    );

    const after = await prisma.rolePermission.findMany({ where: { roleId: id }, include: { permission: true } });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "role_permissions",
      rowId: id,
      action: "update",
      before: before.map((b) => ({ module: b.permission.module, action: b.permission.action, granted: b.granted })),
      after: after.map((a) => ({ module: a.permission.module, action: a.permission.action, granted: a.granted })),
      ip: getClientIp(req),
    });
    return ok(brandSafeResponse({ role_id: id, updated: changes.length }));
  });
}
