// WP-POSTORDER-FREE（§34 A）：`POST /api/rate-cards/backfill-from-postorder { month }`——
// 掃該月一鍵自動卡＋「Postorder 有價但未定價」組合，每組出一條 month_close_pricing 題（放入 source_type=postorder_backfill 嘅 triage session）。
// 唔寫任何價；答題確認先建正式卡（見 src/lib/month-close/auto/triage.ts pricing_backfill）。冪等。權限：一鍵結算:create（老闆／會計）——答題亦要同一權限；「出街價」module 嘅 create 會計預設係關，用佢會令會計出得到題但答唔到。
// `GET ?month=YYYY-MM`——該月補齊 session 狀態（月結頁「補齊價目卡 ›」用）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { backfillFromPostorder, backfillStatus } from "@/lib/month-close/auto/backfill";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "一鍵結算", "create");
    const body = (await readJson(req)) as { month?: unknown };
    const month = typeof body.month === "string" ? parseMonthParam(body.month) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");
    const ip = getClientIp(req);
    const r = await backfillFromPostorder(session.userId, month, ip);
    await writeAudit({ actorUserId: session.userId, tableName: "rate_cards", rowId: `backfill_from_postorder:${month.toISOString().slice(0, 7)}`, action: "update", after: { month: month.toISOString().slice(0, 10), created: r.created, skipped_existing: r.skippedExisting, session_id: r.sessionId }, ip });
    return ok(brandSafeResponse({ session_id: r.sessionId, created: r.created, skipped_existing: r.skippedExisting, skipped_has_card: r.skippedHasCard, skipped_no_records: r.skippedNoRecords, from_auto_cards: r.fromAutoCards, from_postorder: r.fromPostorder, has_postorder: r.hasPostorder }));
  });
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "一鍵結算", "view");
    const monthParam = new URL(req.url).searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    if (!month) throw BadRequest("請傳 month（YYYY-MM 或 YYYY-MM-01）");
    const s = await backfillStatus(month);
    return ok(brandSafeResponse({ session_id: s?.sessionId ?? null, open: s?.open ?? 0, answered: s?.answered ?? 0, skipped: s?.skipped ?? 0, total: s?.total ?? 0 }));
  });
}
