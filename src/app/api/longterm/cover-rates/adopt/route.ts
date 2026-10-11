// P10.2：`POST /api/longterm/cover-rates/adopt`——採用推斷建議（老闆專用；整條推斷鏈入面**唯一會寫價目表**嘅一步）。
// 後端重跑推斷核對每行：consistent 必須等於建議值；mixed／single_sample 金額必須係歷史出現過嘅金額；生效日要未鎖。
// 同 (盤,職級,生效日) 已有價嘅行跳過（回報 skipped）。逐行寫 audit（source=inferred＋證據摘要）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { runCoverInference, parseMonthsList } from "@/lib/longterm-payroll/cover-infer-run";
import { createCoverRate } from "@/lib/longterm-payroll/cover-rates-service";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { CoverRateAdoptSchema } from "@/lib/api/schemas";
import { ApiError, BadRequest, Forbidden } from "@/lib/api/errors";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    if (session.baseRole !== "老闆") throw Forbidden("採用推斷價淨係老闆先可以做");
    const body = parseBody(CoverRateAdoptSchema, await readJson(req));
    const months = parseMonthsList(body.months);
    if (!months) throw BadRequest("months 格式唔啱");
    const inferred = await runCoverInference(months);
    const byKey = new Map(inferred.suggestions.map((s) => [`${s.site_id}|${s.grade}`, s]));
    for (const it of body.items) {
      const s = byKey.get(`${it.site_id}|${it.grade}`);
      if (!s) throw new ApiError(422, "not_inferred", "有一行喺呢批月份推斷唔到");
      if (s.status !== it.status) throw new ApiError(422, "status_changed", "推斷結果同你睇到嘅唔同（資料已變），請重新推斷");
      if (!s.amounts.some((a) => a.amount === it.amount)) throw new ApiError(422, "amount_not_observed", "金額唔係歷史出現過嘅金額");
      if (s.status === "consistent" && s.suggested_amount !== it.amount) throw new ApiError(422, "amount_not_observed", "consistent 行金額要等於建議值");
    }
    const created: string[] = [];
    const skipped: { site_id: string; grade: string; reason: string }[] = [];
    for (const it of body.items) {
      const s = byKey.get(`${it.site_id}|${it.grade}`)!;
      try {
        const row = await createCoverRate({
          siteId: it.site_id,
          grade: it.grade,
          amount: it.amount,
          effectiveFrom: body.effective_from,
          source: "inferred",
          evidence: { months: inferred.months, status: s.status, amounts: s.amounts, total_shifts: s.total_shifts, guard_count: s.guard_count },
          actorUserId: session.userId,
          ip: getClientIp(req),
        });
        created.push(row.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) skipped.push({ site_id: it.site_id, grade: it.grade, reason: "已有價" });
        else throw e;
      }
    }
    return ok(brandSafeResponse({ created: created.length, skipped }), 201);
  });
}
