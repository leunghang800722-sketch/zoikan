// EMP-P1：更表編輯器用——呢個盤呢個月有更次嘅保安員，喺「盤 staff_scheme」嗰種工號下面有邊啲卡（俾編輯器顯示該盤體系工號，
// 同人有多張合資格卡時手揀）。盤未設定 scheme → guards 空陣列（編輯器照舊顯示 guards.staff_no）。
// 雞頭 session 唔返工號卡（工號可見性跟現有規則：雞頭唔多俾）。GET only，純讀。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const { id } = await params;
    const site = await prisma.site.findUnique({ where: { id }, select: { id: true, staffScheme: true } });
    if (!site) throw NotFound();
    const monthParam = new URL(req.url).searchParams.get("month");
    if (!monthParam) throw BadRequest("要帶 ?month=YYYY-MM");
    const parsed = new Date(monthParam.length <= 7 ? `${monthParam}-01` : monthParam);
    if (Number.isNaN(parsed.getTime())) throw BadRequest("month 格式唔啱（要 YYYY-MM）");
    const month = monthStart(parsed);
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
    if (isBrokerRole(session) || !site.staffScheme) return ok(brandSafeResponse({ site_scheme: site.staffScheme, guards: [] }));
    const recs = await prisma.shiftRecord.findMany({
      where: { siteId: id, workDate: { gte: month, lte: monthEnd }, status: { not: "cancelled" } },
      select: { guardId: true },
      distinct: ["guardId"],
    });
    const cards = await prisma.guardStaffNumber.findMany({
      where: { guardId: { in: recs.map((r) => r.guardId) }, scheme: site.staffScheme },
      select: { id: true, guardId: true, number: true, status: true, validFrom: true, validTo: true },
      orderBy: [{ status: "asc" }, { validFrom: "asc" }],
    });
    const by = new Map<string, typeof cards>();
    for (const c of cards) by.set(c.guardId, [...(by.get(c.guardId) ?? []), c]);
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return ok(
      brandSafeResponse({
        site_scheme: site.staffScheme,
        guards: [...by.entries()].map(([guard_id, cs]) => ({ guard_id, cards: cs.map((c) => ({ id: c.id, number: c.number, status: c.status, valid_from: iso(c.validFrom), valid_to: iso(c.validTo) })) })),
      }),
    );
  });
}
