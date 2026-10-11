// P10.1：`GET/POST /api/longterm/cover-rates`——頂位津貼價目表（逐盤逐職級）。
// view＝長工糧:view（老闆＋會計）；寫入＝老闆專用（baseRole 硬性核對）。價目表只影響「頂位草稿」金額，草稿未確認唔計糧。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toCoverRateDTO } from "@/lib/longterm-payroll/dto";
import { createCoverRate } from "@/lib/longterm-payroll/cover-rates-service";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { CoverRateCreateSchema } from "@/lib/api/schemas";
import { Forbidden } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const includeVoided = new URL(req.url).searchParams.get("include_voided") === "1";
    const rows = await prisma.coverShiftRate.findMany({
      where: includeVoided ? {} : { voidedAt: null },
      include: { site: { select: { canonicalName: true } } },
      orderBy: [{ siteId: "asc" }, { grade: "asc" }, { effectiveFrom: "desc" }],
      take: 1000,
    });
    return ok(brandSafeResponse({ rows: rows.map((r) => toCoverRateDTO({ ...r, siteName: r.site.canonicalName })) }));
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    if (session.baseRole !== "老闆") throw Forbidden("頂位價目表淨係老闆先可以改");
    const p = parseBody(CoverRateCreateSchema, await readJson(req));
    const created = await createCoverRate({ siteId: p.site_id, grade: p.grade, amount: p.amount, effectiveFrom: p.effective_from, effectiveTo: p.effective_to ?? null, source: "manual", actorUserId: session.userId, ip: getClientIp(req) });
    return ok(toCoverRateDTO(created), 201);
  });
}
