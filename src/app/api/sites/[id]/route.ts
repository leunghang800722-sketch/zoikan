import { siteReadModule } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeSiteWhere, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerSiteDTO } from "@/lib/broker-dto";
import { toSiteDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { SiteUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { startSiteSchemeJob } from "@/lib/sites/staff-scheme-jobs";
import { BadRequest, NotFound } from "@/lib/api/errors";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, siteReadModule, "view");
    const { id } = await params;
    const where = scopeSiteWhere(session, { id });
    const row = await prisma.site.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(toBrokerSiteDTO(row));
    return ok(await applyFieldGroupGate(session, "sites", toSiteDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "update");
    const { id } = await params;
    const before = await prisma.site.findUniqueOrThrow({ where: { id } });
    const body = await readJson(req);
    const parsed = parseBody(SiteUpdateSchema, body);
    await assertFieldGroupWritable(session, "sites", parsed);
    // status="ended" 一定要經 void endpoint（強制填原因、留痕），唔准直接
    // update 繞過——見設計文件§5.0「只有作廢冇刪除」。
    if (parsed.status === "ended") throw BadRequest("盤「結束」要用 /void（強制填原因）");
    // WP-POSTORDER-FREE（§34 B）：盤預設結算雞頭要係存在而且啟用中嘅雞頭（null＝清走）。
    if (parsed.default_settlement_broker_id) {
      const b = await prisma.broker.findUnique({ where: { id: parsed.default_settlement_broker_id }, select: { status: true } });
      if (!b) throw BadRequest("搵唔到呢個雞頭");
      if (b.status !== "active") throw BadRequest("呢個雞頭已停用，唔可以做盤預設雞頭");
    }
    const data = snakeToCamelShallow(parsed) as Prisma.SiteUncheckedUpdateInput;
    const after = await prisma.site.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "sites", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    // SITE-SCHEME-1.1：改 staff_scheme（設定成非 null 值而且真係變咗）→ 背景重推導：未鎖月「自動推導」歸屬（site_scheme／backfill:range／backfill:sole）清走再按新體系重推；
    // 已鎖月（含側表）唔郁。回應 additive `reinfer { job_id, note }`（job 結果睇 GET /api/sites/staff-scheme-prefill?job=<id> 嘅 summary.locked_kept）。
    const dto = await applyFieldGroupGate(session, "sites", toSiteDTO(after));
    if (after.staffScheme && before.staffScheme !== after.staffScheme) {
      const job = await startSiteSchemeJob({ mode: "reinfer", siteId: id }, session.userId);
      return ok({ ...dto, reinfer: { job_id: job.jobId, note: "更次工號歸屬背景重推導中（未鎖月自動推導嘅會重推；已鎖月嘅唔會改，要人手處理）" } } as unknown as typeof dto);
    }
    return ok(dto);
  });
}
