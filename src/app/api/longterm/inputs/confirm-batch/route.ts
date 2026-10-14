// P9.1：`POST /api/longterm/inputs/confirm-batch`——{ ids }（≤50）把長工糧草稿轉做 confirmed（確認後先計糧）。
// 權限同 PATCH inputs（長工糧:update）；任何一條屬已鎖月份 → 整批 403；唔係草稿／已作廢 → 該條跳過。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { assertMonthNotLocked } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { LongtermInputConfirmBatchSchema } from "@/lib/api/schemas";
import { BadRequest } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { findConfirmedLeaveOverlap, OVERLAP_MSG } from "@/lib/longterm-payroll/drafts";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "update");
    const { ids } = parseBody(LongtermInputConfirmBatchSchema, await readJson(req));
    const unique = [...new Set(ids)];
    const rows = await prisma.longtermPayrollInput.findMany({ where: { id: { in: unique } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const months = new Map<number, Date>();
    for (const r of rows) months.set(r.month.getTime(), r.month);
    for (const m of months.values()) await assertMonthNotLocked({ workDate: m, actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: "batch", ip: getClientIp(req) });
    // P18：更表 SL 草稿必須逐段經 sl-decision 人手確認（醫生紙），批量確認一律拒收。
    if (rows.some((r) => r.draftSource === "roster_leave:SL" && r.status === "draft" && !r.voidedAt)) {
      throw BadRequest("病假草稿（roster_leave:SL）要逐段用 POST /api/longterm/inputs/:id/sl-decision 人手確認醫生紙，唔可以批量確認");
    }
    const results: { id: string; status: "confirmed" | "skipped"; reason: string | null }[] = [];
    for (const id of unique) {
      const before = byId.get(id);
      if (!before) {
        results.push({ id, status: "skipped", reason: "搵唔到" });
        continue;
      }
      if (before.voidedAt || before.status !== "draft") {
        results.push({ id, status: "skipped", reason: before.voidedAt ? "已作廢" : "已確認" });
        continue;
      }
      if (before.kind === "leave" && (await findConfirmedLeaveOverlap(before.guardId, before.month, before.dateFrom, before.dateTo, id))) {
        results.push({ id, status: "skipped", reason: OVERLAP_MSG });
        continue;
      }
      const after = await prisma.longtermPayrollInput.update({ where: { id }, data: { status: "confirmed", confirmedAt: new Date(), confirmedBy: session.userId } });
      await writeAudit({ actorUserId: session.userId, tableName: "longterm_payroll_inputs", rowId: id, action: "update", before, after, ip: getClientIp(req) });
      results.push({ id, status: "confirmed", reason: null });
    }
    return ok(brandSafeResponse({ results, counts: { confirmed: results.filter((r) => r.status === "confirmed").length, skipped: results.filter((r) => r.status === "skipped").length } }));
  });
}
