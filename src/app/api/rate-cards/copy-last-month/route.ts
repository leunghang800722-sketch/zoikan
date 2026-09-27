// WP-PHASE3（§20.4 Phase 3 item 3）：「複製上月卡到本月」——`POST
// /api/rate-cards/copy-last-month`。同 `/api/shift-records/reprice` 一致
// 嘅「dry_run 預覽→confirm 寫入」兩段式；權限跟 `POST /api/rate-cards`
// 一致（module「出街價」create——呢個 action 會建新 `rate_cards` 行）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isMonthLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RateCardCopyLastMonthSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { toRateCardFullDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";
import { Conflict } from "@/lib/api/errors";
import { findCopyLastMonthCandidates, applyCopyLastMonthCards } from "@/lib/pricing/copy-last-month-cards";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "create");
    const body = await readJson(req);
    const parsed = parseBody(RateCardCopyLastMonthSchema, body);
    const dryRun = parsed.dry_run !== false;
    const month = monthStart(new Date(`${parsed.month}-01`));

    if (!dryRun && (await isMonthLocked(month))) {
      throw Conflict(`${parsed.month} 已經鎖定，唔可以複製卡`);
    }

    if (dryRun) {
      const candidates = await findCopyLastMonthCandidates(parsed.month, parsed.site_id ?? null);
      return ok(brandSafeResponse({ dry_run: true, count: candidates.length, candidates }));
    }

    const { created, candidateCount } = await applyCopyLastMonthCards(parsed.month, parsed.site_id ?? null, session.userId, getClientIp(req));
    await writeAudit({
      actorUserId: session.userId,
      tableName: "rate_cards",
      rowId: "copy_last_month",
      action: "copy_last_month", // 批量操作摘要 audit（同 reprice_month 一致精神——批量動作記一行摘要，逐張卡仲有自己嘅 create audit）
      after: { month: parsed.month, siteId: parsed.site_id ?? null, candidateCount, createdCount: created.length, createdIds: created.map((c) => c.id) },
      ip: getClientIp(req),
    });

    const dto = mapListDTO({ rows: created, total: created.length, skip: 0, take: created.length }, toRateCardFullDTO);
    return ok(brandSafeResponse({ dry_run: false, candidate_count: candidateCount, created_count: created.length, rows: (await applyFieldGroupGateToList(session, "rate_cards", dto)).rows }));
  });
}
