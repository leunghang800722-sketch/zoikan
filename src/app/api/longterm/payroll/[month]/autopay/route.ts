// WP-LTPAY §21 任務 5c：`GET /api/longterm/payroll/:month/autopay`——
// BOCHK autopay 檔下載（老闆／會計，module「長工糧」`export` action）。
//
// **格式待銀行核實**：任務樣本
// `data/2026-07/reference/2026-07-長工autopay-BOCHK-PayrollEditor.xls`
// 存在，但係一個**密碼保護**嘅舊版 `.xls`（OLE 格式）——2026-09-27 用
// npm `xlsx`（SheetJS 0.18.5）試過讀，`XLSX.readFile()` 直接拋
// `Error: File is password-protected`，冇密碼冧唔開，實際欄位次序/
// 表頭完全未核實過（唔止「未解析」，係**根本打唔開**）。試完即刻
// `npm uninstall xlsx`（呢個套件 npm registry 冇修過 prototype-pollution/
// ReDoS 嘅版本，`npm audit` 標 high，唔留喺 package.json 度）。
// 跟任務書寫明嘅 fallback：出 CSV，欄位 `bank_code,account_no,
// payee_name,amount,reference`，`bank_code` 用 `guards.bank_name`
// （自由文字，未必係 BOCHK 要求嘅數字銀行代碼）頂住，等有人拎到密碼
// 打開個 `.xls` 核實實際欄位次序／BOCHK Payroll Editor 接受嘅格式之後
// 先改。
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";
import { parseMonthParam, monthLabel, n } from "@/lib/reports/money";
import { writeAudit } from "@/lib/audit";

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request, { params }: { params: Promise<{ month: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "export");
    const { month: monthParam } = await params;
    const month = parseMonthParam(monthParam);
    if (!month) throw BadRequest(`唔啱嘅月份格式：${monthParam}（要 YYYY-MM）`);

    const run = await prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, orderBy: { createdAt: "desc" } });
    if (!run) throw BadRequest(`${monthLabel(month)} 未計過長工糧（撳「重算本月」先）`);

    const lines = await prisma.longtermPayrollLine.findMany({
      where: { runId: run.id },
      include: { guard: { select: { id: true, nameZh: true, staffNo: true, staffNoMw: true, bankName: true, bankAccountNo: true, bankPayeeName: true } } },
      orderBy: { createdAt: "asc" },
    });

    const rows: string[] = [];
    const missing: string[] = [];
    for (const l of lines) {
      const g = l.guard;
      if (!g.bankAccountNo || !g.bankPayeeName) {
        missing.push(g.staffNo ?? g.staffNoMw ?? g.id);
        continue;
      }
      const ref = `LT${monthLabel(month).replace("-", "")}-${g.staffNo ?? g.staffNoMw ?? g.id.slice(0, 8)}`;
      rows.push([csvField(g.bankName ?? ""), csvField(g.bankAccountNo), csvField(g.bankPayeeName), csvField(n(l.autopay).toFixed(2)), csvField(ref)].join(","));
    }

    const isPreview = new URL(req.url).searchParams.get("preview") === "1";
    await writeAudit({
      actorUserId: session.userId,
      tableName: "longterm_payroll_runs",
      rowId: run.id,
      action: "export_download",
      after: { month: monthLabel(month), rowCount: rows.length, missingBankInfoCount: missing.length, preview: isPreview },
      ip: getClientIp(req),
    });

    if (isPreview) {
      return ok(brandSafeResponse({ month: monthLabel(month), row_count: rows.length, missing_bank_info: missing, format_verified: false }));
    }

    const csv = ["bank_code,account_no,payee_name,amount,reference", ...rows].join("\r\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="longterm-autopay-${monthLabel(month)}.csv"`,
        "X-Missing-Bank-Info-Count": String(missing.length),
        "X-Format-Verified": "false",
      },
    });
  });
}
