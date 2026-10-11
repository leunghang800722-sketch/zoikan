// P1-WP3：開新月份（設計文件§4.1「主管：開新月份 → 系統複製上月更別
// 結構同所需人手」；P1-執行計劃.md §4 WP3「複製上月 shift_types／
// daily_requirements／quotas／assignments 結構」）。
//
// shift_types 本身唔跟月份行（喺 schema 屬於 site，唔屬於任何一個月），
// 冇嘢好「複製」——呢個係規劃裁定（Opus 應驗）：spec 原文列咗 shift_types
// 但 schema 冇 month 維度，呢度當佢係「確保新月份沿用返嗰個盤現存嘅
// 更別結構」（本身就自動成立，唔使動作），response 用 shift_types_note
// 講明。真正複製嘅係 daily_requirements（跟日期行，逐日 work_date 搬去
// 新月份同一日）、quotas（跟月份行，逐行複製）、broker_site_assignments
// （同 scripts/assignments/rollover.ts 邏輯一致）。
//
// 用「更表」module「create」action（spec 指定）——但呢個係全系統跨盤
// 動作，唔屬於「雞頭配額內填人」嗰種粒度（矩陣嗰粒 grant 係俾雞頭填
// 自己嘅格用嘅），所以呢度額外擋雞頭角色（防禦性深度，同
// broker-site-assignments POST 入面「就算 hard-deny 有漏都再擋一次」
// 同一手法）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { assertMonthNotLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { MonthOpenSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { openMonth } from "@/lib/months/open-month";
import { BadRequest, Forbidden } from "@/lib/api/errors";

export async function POST(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "create");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以開新月份（全系統跨盤動作，只限老闆/主管/會計）");

    const { month: monthParam } = await params;
    const parsedDate = new Date(monthParam.length <= 7 ? `${monthParam}-01` : monthParam);
    if (Number.isNaN(parsedDate.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM）");
    const targetMonth = monthStart(parsedDate);

    await assertMonthNotLocked({ workDate: targetMonth, actorUserId: session.userId, tableName: "months", rowId: monthParam, ip: getClientIp(req) });

    const ip = getClientIp(req);
    const body = await readJson(req);
    const input = parseBody(MonthOpenSchema, body);

    const { sourceMonth, assignmentsCreated, quotasCreated, drCreated, drSkippedOutOfRange, alreadyOpen } = await openMonth({
      targetMonth,
      actorUserId: session.userId,
      createdBy: session.userId,
      ip,
      rowIdForLock: monthParam,
    });

    // Opus 對抗式驗收 A3：重複開同一個月份——三張表都冇新嘢複製（源頭
    // 有嘢但全部已經存在）就當「已經開咗」，回 200＋`already_open:true`
    // （唔係 201，因為冇建立任何新資源）。源頭本身乜都冇（例如上個月
    // 都未排過）就照舊 201（第一次開，只不過冇嘢好複製）。

    return ok(
      brandSafeResponse({
        month: targetMonth.toISOString().slice(0, 10),
        source_month: sourceMonth.toISOString().slice(0, 10),
        roster_version_note: input.roster_version_note ?? null,
        broker_site_assignments_created: assignmentsCreated,
        quotas_created: quotasCreated,
        daily_requirements_created: drCreated,
        daily_requirements_skipped_out_of_range: drSkippedOutOfRange,
        already_open: alreadyOpen,
        shift_types_note: "shift_types 屬於 site（唔跟月份），冇需要複製——新月份自動沿用返個盤現存嘅更別結構",
        // P1-WP3 規劃裁定（第二輪 point 5）：`roster_layout` 都係掛喺
        // site 本身（`sites.roster_layout`），唔係逐月一份紀錄——跟
        // shift_types 同一個道理，新月份自動沿用，唔使複製。呢度加返
        // 一句 note 純粹方便前端/回報睇到呢個裁定嘅解釋，唔代表有動作。
        roster_layout_note: "roster_layout 都係掛喺 site 本身（唔跟月份），同 shift_types 一樣自動沿用，冇需要複製",
      }),
      alreadyOpen ? 200 : 201,
    );
  });
}
