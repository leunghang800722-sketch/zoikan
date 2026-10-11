import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { writeAudit } from "@/lib/audit";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { NotFound } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";

// S6：真正 DELETE（唔係 void）——broker_site_assignments 係純白名單配置，
// 唔係業務事實記錄，「只有作廢冇刪除」原則唔套用喺呢個表（同
// role_permissions 呢類配置表一樣）；照樣寫 audit_log 留返邊個幾時撤走
// 咗邊個雞頭喺邊個盤嘅資格。
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "配額", "void");
    const { id } = await params;
    const before = await prisma.brokerSiteAssignment.findUnique({ where: { id } });
    if (!before) throw NotFound();
    // P6.1d（H4）：撤走掛盤資格都係改嗰個月雞頭睇到嘅範圍，已鎖月份 403。
    await assertMonthNotLocked({ workDate: before.month, actorUserId: session.userId, tableName: "broker_site_assignments", rowId: id, ip: getClientIp(req) });
    await prisma.brokerSiteAssignment.delete({ where: { id } });
    await writeAudit({ actorUserId: session.userId, tableName: "broker_site_assignments", rowId: id, action: "void", before, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ok: true }));
  });
}
