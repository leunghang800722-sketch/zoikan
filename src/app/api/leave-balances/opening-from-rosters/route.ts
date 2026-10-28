// HIST-2：歷史假期結餘回填 API——由 2026-07 前月份更表（shift_records leaveCode SL／AL）計長工病假／年假結餘 opening。
// `POST /api/leave-balances/opening-from-rosters { as_of: "2026-06", apply: false|true, merge_into_existing: true, recompute_same_as_of?: false }`
// 核心邏輯同 `scripts/db/leave-opening-from-rosters.ts` 共用（src/lib/longterm-payroll/leave-opening.ts）。
// apply=false（預設）＝dry-run，回差異清單（guard_id＋數字＋旗標，唔帶任何姓名／工號／電話；前端顯示人名要經現有保安員 lookup）；
// apply=true 先真係寫，寫 audit（summary＋逐個 guard）。權限「糧務:create」（老闆／會計）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { leaveOpeningFromRosters, parseAsOf } from "@/lib/longterm-payroll/leave-opening";
import { HIST_MAX_MONTH } from "@/lib/month-close/historical";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "create");
    const body = (await readJson(req)) as { as_of?: unknown; apply?: unknown; merge_into_existing?: unknown; recompute_same_as_of?: unknown };
    if (typeof body.as_of !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.as_of)) throw BadRequest("請傳 as_of（YYYY-MM，例如 2026-06）");
    for (const k of ["apply", "merge_into_existing", "recompute_same_as_of"] as const) {
      if (body[k] !== undefined && typeof body[k] !== "boolean") throw BadRequest(`${k} 要係 true／false`);
    }
    const asOf = parseAsOf(body.as_of);
    if (asOf.getTime() >= HIST_MAX_MONTH.getTime()) throw BadRequest(`as_of 要早過 ${HIST_MAX_MONTH.toISOString().slice(0, 7)}（呢個係歷史月份回填；之後月份由正式糧務計）`);
    try {
      const result = await leaveOpeningFromRosters({
        asOf,
        apply: body.apply === true,
        mergeIntoExisting: body.merge_into_existing === true,
        recomputeSameAsOf: body.recompute_same_as_of === true,
        actorUserId: session.userId,
        ip: getClientIp(req),
        auditEachRow: true,
      });
      return ok(brandSafeResponse(result as unknown as Record<string, unknown>));
    } catch (e) {
      // lib 對「合併模式 as-of 太遲」等用中文 Error 拒絕——轉 409 俾前端顯示。
      if (e instanceof Error && e.constructor === Error) throw Conflict(e.message);
      throw e;
    }
  });
}
