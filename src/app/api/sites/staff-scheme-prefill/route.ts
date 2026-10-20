// SITE-SCHEME-1／1.1：盤工號體系預設建議＋套用。
//   GET  /api/sites/staff-scheme-prefill —— 只對「有 shift／ot 更次」嘅未設定盤出建議（proposals）；結算更次全部係 external（客戶自己人）嘅盤列喺 not_applicable（唔出建議）；
//        冇更次嘅盤唔列（no_shifts 計數）。要「盤:update」（老闆）。
//   GET  …?job=<id> —— 輪詢背景補推導 job（job_runs：running｜ok｜error＋summary 計數）。
//   POST /api/sites/staff-scheme-prefill { apply:true, site_ids?:[…], overrides?:[{site_id, scheme}] } —— 只寫未設定而且屬 proposals 嘅盤（updateMany where staff_scheme IS NULL，冪等）；
//        site_ids＝只套用已剔嘅盤（冇傳＝全部 proposals，舊 client 相容）；overrides 逐盤覆寫建議（U／MP）。audit 一條 summary。
//        **歸屬補推導喺背景行**（`after()`＋job_runs）：回 202＋`job_id`，頁面輪詢；補推導只填 staff_number_id IS NULL 嘅更次（未鎖月直接寫、已鎖月寫側表），
//        結果 summary 有 backfilled／unresolved（推唔到＝人冇對應體系嘅工號卡）。冇寫入任何盤＝200、冇 job。
//        回應 by_scheme 係 [{scheme,count}] 陣列（物件 key U／MP 會被 snake_case 轉換壞）。
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { NotFound } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";
import { loadSchemeCandidates } from "@/lib/sites/staff-scheme-candidates";
import { getSiteSchemeJob, startSiteSchemeJob } from "@/lib/sites/staff-scheme-jobs";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "盤", "update");
    const jobId = new URL(req.url).searchParams.get("job");
    if (jobId) {
      const job = await getSiteSchemeJob(jobId);
      if (!job) throw NotFound("搵唔到呢個背景工作");
      return ok(brandSafeResponse({ job: { id: job.id, status: job.status, summary: job.summary } }));
    }
    const c = await loadSchemeCandidates();
    return ok(brandSafeResponse({ count: c.proposals.length, proposals: c.proposals, not_applicable: c.not_applicable, no_shifts: c.no_shifts }));
  });
}

const ApplySchema = z
  .object({
    apply: z.literal(true),
    site_ids: z.array(z.string().min(1).max(64)).max(2000).optional(),
    overrides: z.array(z.object({ site_id: z.string().min(1).max(64), scheme: z.enum(["U", "MP"]) }).strict()).max(2000).optional(),
  })
  .strict();

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "盤", "update");
    const body = parseBody(ApplySchema, await readJson(req));
    const overrides = new Map((body.overrides ?? []).map((o) => [o.site_id, o.scheme]));
    const chosen = body.site_ids ? new Set(body.site_ids) : null;
    const cand = await loadSchemeCandidates();
    const applicable = new Map(cand.proposals.map((p) => [p.site_id, p]));
    // 只套用：屬 proposals（未設定、有更次、非全 external）而且（有傳 site_ids 時）已剔嘅盤；其餘計 skipped
    const requested = chosen ? [...chosen] : [...applicable.keys()];
    const toApply = requested.filter((id) => applicable.has(id)).map((id) => ({ id, scheme: overrides.get(id) ?? applicable.get(id)!.proposed_scheme }));
    const skipped = requested.length - toApply.length;
    const bySchemeCount = { U: 0, MP: 0 };
    const appliedIds: string[] = [];
    if (toApply.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const t of toApply) {
          const r = await tx.site.updateMany({ where: { id: t.id, staffScheme: null }, data: { staffScheme: t.scheme } }); // 只寫未設定（並發／重覆撳都冪等）
          if (r.count === 1) {
            bySchemeCount[t.scheme] += 1;
            appliedIds.push(t.id);
          }
        }
        await writeAuditTx(tx, { actorUserId: session.userId, tableName: "sites", rowId: "staff_scheme_prefill", action: "site_staff_scheme_prefill", after: { applied: appliedIds.length, by_scheme: bySchemeCount, overrides: overrides.size, skipped }, ip: getClientIp(req) });
      });
    }
    const bySchemeOut = [{ scheme: "U", count: bySchemeCount.U }, { scheme: "MP", count: bySchemeCount.MP }];
    if (appliedIds.length === 0) return ok(brandSafeResponse({ applied: 0, skipped_not_applicable: skipped, by_scheme: bySchemeOut, job_id: null }));
    const job = await startSiteSchemeJob({ mode: "backfill", siteIds: appliedIds }, session.userId);
    const finished = job.finished ? await getSiteSchemeJob(job.jobId) : null;
    return ok(brandSafeResponse({ applied: appliedIds.length, skipped_not_applicable: skipped, by_scheme: bySchemeOut, job_id: job.jobId, status: finished?.status ?? "running", ...(finished ? { summary: finished.summary } : {}) }), 202);
  });
}
