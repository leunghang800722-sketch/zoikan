// SITE-SCHEME-1：盤工號體系預設建議＋一次過套用。
//   GET  /api/sites/staff-scheme-prefill —— 每個未設定 staff_scheme 嘅盤（status 非 ended）嘅建議：site id、盤名、客戶、建議體系、理由（要「盤:update」＝老闆）。
//   POST /api/sites/staff-scheme-prefill { apply:true, overrides?:[{site_id, scheme}] } —— 只寫未設定嘅盤（updateMany where staff_scheme IS NULL，冪等）；
//        回應 by_scheme 係 [{scheme,count}] 陣列（物件 key U／MP 會被 snake_case 轉換壞）。
//        overrides 逐盤覆寫建議（U／MP）；寫完即刻對呢批盤嘅更次補推導工號歸屬（只填空位，未鎖月直接寫、已鎖月寫側表），回 backfilled 計數；audit 一條 summary。
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";
import { proposeStaffScheme } from "@/lib/sites/staff-scheme-prefill";
import { backfillSiteStaffNumbers } from "@/lib/shift-records/backfill-site-staff-numbers";

async function unsetSites() {
  return prisma.site.findMany({ where: { staffScheme: null, status: { not: "ended" } }, select: { id: true, canonicalName: true, clientName: true, clientGroup: true, aliases: true, guardsPaidByClient: true, staffScheme: true }, orderBy: [{ canonicalName: "asc" }, { id: "asc" }] });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "盤", "update");
    const sites = await unsetSites();
    const proposals = sites.map((s) => {
      const p = proposeStaffScheme(s)!;
      return { site_id: s.id, site_name: s.canonicalName, client_name: s.clientName, guards_paid_by_client: s.guardsPaidByClient, proposed_scheme: p.scheme, reason: p.reason };
    });
    return ok(brandSafeResponse({ count: proposals.length, proposals }));
  });
}

const ApplySchema = z
  .object({
    apply: z.literal(true),
    overrides: z.array(z.object({ site_id: z.string().min(1).max(64), scheme: z.enum(["U", "MP"]) }).strict()).max(2000).optional(),
  })
  .strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "update");
    const body = parseBody(ApplySchema, await readJson(req));
    const overrides = new Map((body.overrides ?? []).map((o) => [o.site_id, o.scheme]));
    const sites = await unsetSites();
    if (sites.length === 0 && overrides.size === 0) return ok(brandSafeResponse({ applied: 0, skipped_already_set: 0, backfilled: 0, by_scheme: [{ scheme: "U", count: 0 }, { scheme: "MP", count: 0 }], backfill: null }));
    const bySiteId = new Set(sites.map((s) => s.id));
    const unknown = [...overrides.keys()].filter((id) => !bySiteId.has(id));
    // overrides 指向已設定／已結束／唔存在嘅盤：唔寫（只寫未設定），計入 skipped_already_set
    const toApply = sites.map((s) => ({ id: s.id, scheme: overrides.get(s.id) ?? proposeStaffScheme(s)!.scheme }));
    if (toApply.length > 2000) throw BadRequest("一次最多套用 2000 個盤");
    const bySchemeCount = { U: 0, MP: 0 };
    const appliedIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      for (const t of toApply) {
        const r = await tx.site.updateMany({ where: { id: t.id, staffScheme: null }, data: { staffScheme: t.scheme } }); // 只寫未設定（並發／重覆撳都冪等）
        if (r.count === 1) {
          bySchemeCount[t.scheme] += 1;
          appliedIds.push(t.id);
        }
      }
      await writeAuditTx(tx, { actorUserId: session.userId, tableName: "sites", rowId: "staff_scheme_prefill", action: "site_staff_scheme_prefill", after: { applied: appliedIds.length, by_scheme: bySchemeCount, overrides: overrides.size, skipped_already_set: unknown.length }, ip: getClientIp(req) });
    });
    const backfill = await backfillSiteStaffNumbers(appliedIds);
    return ok(brandSafeResponse({ applied: appliedIds.length, skipped_already_set: unknown.length, backfilled: backfill.backfilled, by_scheme: [{ scheme: "U", count: bySchemeCount.U }, { scheme: "MP", count: bySchemeCount.MP }], backfill }));
  });
}
