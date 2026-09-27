// WP-LTPAY §21 任務 5b：`GET /api/longterm/payroll/:month`——`/reports/
// longterm-payroll` 頁面主資料源。讀最新一個未 void 嘅
// `longterm_payroll_runs`／`_lines`（未跑過就 `run:null`／`lines:[]`，
// 前端顯示「未計過，撳『重算本月』」）；逐行 join 埋安員姓名／工號
// （PDPO：淨係呢兩個非敏感識別欄，銀行/身份證留喺 `/guards` 詳情頁）；
// 帶埋上個月嘅 Gross／Autopay 做「同上月比較」。module「長工糧」
// （老闆／會計，同「安員銀行資料」一致粒度）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { toLongtermRunDTO, toLongtermLineWithGuardDTO } from "@/lib/longterm-payroll/dto";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam, monthLabel, n, round2 } from "@/lib/reports/money";
import { isMonthLocked } from "@/lib/month-lock";

function prevMonth(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
}

export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);

    const [run, prevRun, locked] = await Promise.all([
      prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } }),
      prisma.longtermPayrollRun.findFirst({ where: { month: prevMonth(month), voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } }),
      isMonthLocked(month),
    ]);

    if (!run) {
      return ok(brandSafeResponse({ month: monthLabel(month), locked, run: null, lines: [], totals: null }));
    }

    const [lines, prevLines] = await Promise.all([
      prisma.longtermPayrollLine.findMany({ where: { runId: run.id }, include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } }, orderBy: { createdAt: "asc" } }),
      prevRun ? prisma.longtermPayrollLine.findMany({ where: { runId: prevRun.id }, select: { guardId: true, gross: true, autopay: true } }) : Promise.resolve([]),
    ]);
    const prevByGuard = new Map(prevLines.map((l) => [l.guardId, { gross: n(l.gross), autopay: n(l.autopay) }]));

    const linesDto = lines.map((l) => {
      const prev = prevByGuard.get(l.guardId) ?? null;
      return toLongtermLineWithGuardDTO({
        ...l,
        guardName: l.guard.nameZh,
        guardStaffNo: l.guard.staffNo ?? l.guard.staffNoMw ?? null,
        prevGross: prev ? prev.gross : null,
        prevAutopay: prev ? prev.autopay : null,
        grossDelta: prev ? round2(n(l.gross) - prev.gross) : null,
        autopayDelta: prev ? round2(n(l.autopay) - prev.autopay) : null,
      });
    });

    return ok(
      brandSafeResponse({
        month: monthLabel(month),
        locked,
        run: toLongtermRunDTO(run),
        lines: linesDto,
        totals: run.totalsJson,
        prev_month: prevRun ? monthLabel(prevMonth(month)) : null,
      }),
    );
  });
}
