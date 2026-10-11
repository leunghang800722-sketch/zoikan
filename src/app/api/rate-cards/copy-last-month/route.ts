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
import { findCopyLastMonthCandidates, applyCopyLastMonthCards, classifyCopyCandidates } from "@/lib/pricing/copy-last-month-cards";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { isBrokerRole } from "@/lib/broker-isolation";

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
      const found = await findCopyLastMonthCandidates(parsed.month, parsed.site_id ?? null);
      // P7.2（additive）：每個候選加 change_class（same｜new｜rate_changed｜changed_in_month）——
      // 非 same 嘅係排程唔會自動複製、要人確認嘅卡。
      const classified = await classifyCopyCandidates(parsed.month, found);
      const candidates = classified.map((c) => ({ ...c.candidate, change_class: c.cls }));
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

// P7.2：`GET /api/rate-cards/copy-last-month?month=YYYY-MM`——只回「仲有幾多張候選未複製」數量
// （首頁「價卡待確認」卡用；唔回價錢）。權限：出街價 view，雞頭 403。
export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "view");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以睇全公司價卡待確認數");
    const month = new URL(req.url).searchParams.get("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw BadRequest("month 要係 YYYY-MM");
    const candidates = await findCopyLastMonthCandidates(month, null);
    // additive：auto_copy＝排程 25 號會自動複製（change_class=same）嘅張數；needs_confirm＝其餘要人確認。
    const classified = await classifyCopyCandidates(month, candidates);
    const autoCopy = classified.filter((c) => c.cls === "same").length;
    return ok(brandSafeResponse({ month, count: candidates.length, auto_copy: autoCopy, needs_confirm: candidates.length - autoCopy }));
  });
}
