// 月結鎖定（設計文件§5.1「月結鎖定/解鎖 ✓✗○(高級)✗✗」→ matrix.ts 「月結鎖定解鎖」:void，C3 拆自舊「糧務」module）。
// 鎖定之後，該月任何 shift_records/daily_requirements/special_items/
// rate_cards 寫入一律 403（見 src/lib/month-lock.ts）。
//
// P1-執行計劃.md §4 WP4 item 3：「鎖定前必須 generate 一次並顯示對數結果，
// 有紅色差異要 override 原因」——呢度**唔靠**「使用者之前有冇撳過
// generate」呢種前置狀態（避免 generate 完之後、鎖定之前數又偷偷變咗嘅
// race），改為鎖定呢一刻自己即場重新計一次 §6.3 五條對數規則
// （buildReconciliation()）：冇紅色差異（規則1/2/3 status=diff）就直接
// 鎖；有嘅話一定要 body 帶 `override_reason`（非空字串）先可以鎖，原因
// 連同對數結果快照一齊寫入 audit_log.after，留痕俾日後追溯「邊個因為
// 咩理由喺有已知差異嘅情況下都堅持鎖」。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { toMonthCloseDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { writeAudit } from "@/lib/audit";
import { Conflict, BadRequest } from "@/lib/api/errors";
import { buildReconciliation } from "@/lib/reports/reconciliation";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結鎖定解鎖", "void");
    const { id } = await params;
    const body = await readJson(req);
    const note = typeof body.roster_version_note === "string" ? body.roster_version_note : null;
    const overrideReason = typeof body.override_reason === "string" && body.override_reason.trim() ? body.override_reason.trim() : null;

    const before = await prisma.monthClose.findUniqueOrThrow({ where: { id } });
    if (before.lockedAt) throw Conflict("呢個月已經鎖定咗");

    const reconciliation = await buildReconciliation(before.month);
    if (reconciliation.hasDiff && !overrideReason) {
      throw BadRequest("對數規則（§6.3）出現紅色差異，鎖定要帶 override_reason 先做得到——見 reconciliation 欄邊條規則 status=diff");
    }

    const after = await prisma.monthClose.update({
      where: { id },
      data: { lockedAt: new Date(), lockedBy: session.userId, rosterVersionNote: note ?? before.rosterVersionNote },
    });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "month_closes",
      rowId: id,
      action: "lock_month",
      before,
      after: { ...after, override_reason: overrideReason, reconciliation_summary: reconciliation.rules.map((r) => ({ rule_no: r.ruleNo, status: r.status, diff_count: r.diffCount })) },
      ip: getClientIp(req),
    });
    return ok(brandSafeResponse({ month_close: await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(after)), reconciliation }));
  });
}
