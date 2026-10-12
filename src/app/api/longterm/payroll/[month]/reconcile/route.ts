// P14.3：銀行 BOCHK Payroll Editor 對數。
//   POST（長工糧:create，老闆／會計；multipart `file`，xls／xlsx）——解析 Payroll Editor，同該月有效 run 逐人配對，寫入
//        longterm_bank_reconciliations／_rows，回 summary。密碼保護檔 400（中文提示）。唔改任何糧單數字，鎖月都可對數。
//   GET（長工糧:view）——最近一次結果＋rows（姓名／工號照長工糧 module gate；bank_only 行只有行號同金額；
//        差異行帶系統該行組成，方便追根因）。`?format=csv` 匯出差異 CSV（唔含銀行名原文、戶口）。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ApiError, BadRequest } from "@/lib/api/errors";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";
import { findActiveRun, runBankReconciliation, unresolvedCount, type ReconSummary } from "@/lib/longterm-payroll/bank-reconcile";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

const STATUS_RANK: Record<string, number> = { diff: 0, bank_only: 1, system_only: 2, equal: 3 };

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function POST(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw BadRequest("要用 multipart/form-data 上載（file）");
    }
    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) throw BadRequest("要帶 file（BOCHK Payroll Editor 嘅 xls／xlsx）");
    if (fileEntry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
    const buffer = Buffer.from(await fileEntry.arrayBuffer());
    if (!buffer.length) throw BadRequest("檔案係空嘅");
    if (!buffer.subarray(0, 4).equals(OLE_MAGIC) && !buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw BadRequest("唔係 Excel 檔案（要 .xls 或 .xlsx）");
    const out = await runBankReconciliation({ month, fileName: fileEntry.name || "payroll-editor", buffer, actorUserId: session.userId });
    await writeAudit({ actorUserId: session.userId, tableName: "longterm_bank_reconciliations", rowId: out.reconciliationId, action: "create", after: { month: monthLabel(month), run_id: out.runId, summary: out.summary }, ip: getClientIp(req) });
    return ok(brandSafeResponse({ month: monthLabel(month), reconciliation_id: out.reconciliationId, run_id: out.runId, summary: out.summary }), 201);
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);
    const format = new URL(req.url).searchParams.get("format");
    if (format !== null && format !== "csv") throw BadRequest("format 只可以係 csv");

    const [rec, run] = await Promise.all([
      prisma.longtermBankReconciliation.findFirst({ where: { month }, orderBy: { uploadedAt: "desc" } }),
      findActiveRun(month),
    ]);
    if (!rec) {
      if (format === "csv") throw new ApiError(404, "not_found", "呢個月未上載過銀行檔");
      return ok(brandSafeResponse({ month: monthLabel(month), reconciliation: null, summary: null, rows: [] }));
    }
    const rawRows = await prisma.longtermBankReconciliationRow.findMany({
      where: { reconciliationId: rec.id },
      include: { guard: { select: { nameZh: true, staffNo: true, staffNoMw: true } } },
      orderBy: [{ bankRowNo: "asc" }],
    });
    const lineIds = rawRows.filter((r) => r.systemLineId && r.status !== "equal").map((r) => r.systemLineId!);
    const lines = lineIds.length ? await prisma.longtermPayrollLine.findMany({ where: { id: { in: lineIds } } }) : [];
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    const rows = rawRows
      .map((r) => {
        const l = r.systemLineId ? lineById.get(r.systemLineId) : undefined;
        return {
          id: r.id,
          bank_row_no: r.bankRowNo,
          guard_id: r.guardId,
          guard_name: r.guard?.nameZh ?? null,
          guard_staff_no: r.guard ? (r.guard.staffNo ?? r.guard.staffNoMw ?? null) : null,
          bank_amount: num(r.bankAmount),
          system_autopay: num(r.systemAutopay),
          diff: num(r.diff),
          match_by: r.matchBy,
          status: r.status,
          reason_code: r.reasonCode,
          reason_note: r.reasonNote,
          resolved_at: r.resolvedAt ? r.resolvedAt.toISOString() : null,
          components: l
            ? {
                work_days: l.workDays,
                days_in_month: l.daysInMonth,
                net_basic: num(l.netBasic),
                ot_hours: num(l.otHours),
                ot_amount: num(l.otAmount),
                rest_day_payment: num(l.restDayPayment),
                npsh: num(l.npsh),
                npl_days: num(l.nplDays),
                npsl_days: num(l.npslDays),
                deduction: num(l.deduction),
                special_allowance: num(l.specialAllowance),
                other_allowance: num(l.otherAllowance),
                al_payment: num(l.alPayment),
                sl45_amount: num(l.sl45Amount),
                gross: num(l.gross),
                mpf_ee: num(l.mpfEe),
                mpf_er: num(l.mpfEr),
                autopay: num(l.autopay),
                notes: l.notesJson,
              }
            : null,
        };
      })
      .sort((a, b) => STATUS_RANK[a.status]! - STATUS_RANK[b.status]! || Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0) || a.bank_row_no - b.bank_row_no);

    if (format === "csv") {
      const head = ["bank_row_no", "staff_no", "system_autopay", "bank_amount", "diff", "match_by", "status", "reason_code", "reason_note"];
      const body = rows.filter((r) => r.status !== "equal").map((r) => [r.bank_row_no || "", r.guard_staff_no, r.system_autopay, r.bank_amount, r.diff, r.match_by, r.status, r.reason_code, r.reason_note].map(csvCell).join(","));
      return new NextResponse("﻿" + [head.join(","), ...body].join("\r\n"), {
        status: 200,
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="bank-reconcile-${monthLabel(month)}-diffs.csv"` },
      });
    }

    const summary = { ...(rec.summaryJson as unknown as ReconSummary), unresolved: unresolvedCount(rawRows) };
    return ok(
      brandSafeResponse({
        month: monthLabel(month),
        reconciliation: { id: rec.id, run_id: rec.runId, file_name: rec.fileName, uploaded_at: rec.uploadedAt.toISOString(), stale: !run || run.id !== rec.runId },
        summary,
        rows,
      }),
    );
  });
}
