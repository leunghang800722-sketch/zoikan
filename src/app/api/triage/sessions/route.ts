// WP-AI-OPS §28.4：`GET /api/triage/sessions?mine=1`——列出分診 session（老闆見全部；mine=1 或其他角色＝自己上載嗰批）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { listSessionsFor, countOpenFor, isBoss, TRIAGE_OWNER_ROLES } from "@/lib/triage/session";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const mine = new URL(req.url).searchParams.get("mine") === "1";
    const [sessions, open_total] = await Promise.all([listSessionsFor(actor, { mine }), countOpenFor(actor)]);
    const open_supplementary = sessions.reduce((a, s) => a + s.counts.supplementary_open, 0);
    // 老闆：可轉交對象（啟用中嘅老闆／會計／主管）
    const eligible_owners = isBoss(actor)
      ? (await prisma.user.findMany({ where: { status: "active", role: { baseRole: { in: [...TRIAGE_OWNER_ROLES] } } }, select: { id: true, name: true, role: { select: { name: true } } }, orderBy: { name: "asc" } })).map((u) => ({ id: u.id, name: u.name, role_name: u.role.name }))
      : [];
    return ok(brandSafeResponse({ sessions: sessions.map((s) => ({ ...s })), open_total, open_supplementary, eligible_owners }));
  });
}
