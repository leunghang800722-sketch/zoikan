// `npm run perf:snapshot -- --out path.json [--months 2026-07,2026-08]`
// ——報表／對數／診斷數字快照（老闆 2026-09-28 效能優化指令：優化前後 7／8
// 月數字要逐格一致）。輸出唔含任何人名／工號／電話：雞頭淨係用代號，含
// PII 嘅明細（對數規則 details）淨係存 sha256，比對相等就得。
//
// 除咗 `stepCompute()` 之外全部純讀。Opus 5.5 驗收建議（2026-09-28）加埋
// `stepCompute()`（一鍵結算 step6：重算介紹費＋長工糧再出總收入／成本／毛利
// ——會寫 special_items／longterm_payroll_runs，冪等：void 舊 run 建新）、
// `writePayrollXlsx`（糧單 Excel 逐 sheet 內容 hash）同 pending-summary，等
// 以後呢幾條路徑有差異都自動揪到。唔想寫 DB 就帶 `--skip-compute`。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

function systemSession(userId: string) {
  return { userId, tel: "", name: "", roleId: "", roleName: "老闆", baseRole: "老闆" as const, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString() };
}
function sha(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
}

async function main() {
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg >= 0 ? process.argv[outArg + 1]! : "perf-snapshot.json";
  const monthsArg = process.argv.indexOf("--months");
  const months = monthsArg >= 0 ? process.argv[monthsArg + 1]!.split(",") : ["2026-07", "2026-08"];

  const { prisma } = await import("@/lib/db");
  const mc = await import("@/lib/reports/monthly-close");
  const gm = await import("@/lib/reports/gross-margin");
  const pr = await import("@/lib/reports/payroll");
  const rc = await import("@/lib/reports/reconciliation");
  const rf = await import("@/lib/reports/referral-fee");
  const md = await import("@/lib/reports/month-diagnostics");
  const pe = await import("@/lib/reports/postorder-export");
  const oc = await import("@/lib/month-close/one-click");
  const ps = await import("@/lib/roster-upload/pending-summary");
  const skipCompute = process.argv.includes("--skip-compute");
  const boss = await prisma.user.findFirst({ where: { role: { name: "老闆" } }, select: { id: true } });
  const session = systemSession(boss?.id ?? "");

  const out: Record<string, unknown> = {};
  for (const m of months) {
    const [y, mo] = m.split("-").map(Number);
    const month = new Date(Date.UTC(y!, mo! - 1, 1));
    const close = await mc.buildMonthlyClose(month);
    const margin = await gm.buildGrossMargin(month);
    const payroll = await pr.buildPayrollTotals(month);
    const recon = await rc.buildReconciliation(month);
    const referral = await rf.computeReferralFeesForMonth(month);
    const diag = await md.buildMonthDiagnostics(session, month);
    const post = await pe.buildPostorderWorkbook(month);
    const pre = await oc.stepPrecheck(month, session.userId, null);
    // Opus 5.5 驗收建議：糧單 Excel 逐 sheet 內容 hash（行排序後——揪數字／
    // 內容變；另存一個未排序 hash 揪行次序變）。寫去 tmp 再讀返，唔留檔。
    const xlsxPath = path.join(os.tmpdir(), `zoikan-perf-payroll-${m}-${process.pid}.xlsx`);
    await pr.writePayrollXlsx(xlsxPath, month);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    fs.rmSync(xlsxPath, { force: true });
    const payrollXlsxSheets = wb.worksheets.map((ws) => {
      const rows: string[] = [];
      ws.eachRow((row) => rows.push(JSON.stringify((row.values as unknown[]).slice(1))));
      return { sheet: sha(ws.name), rows: rows.length, sortedSha: sha([...rows].sort()), orderedSha: sha(rows) };
    });
    out[m] = {
      monthlyClose: { main: close.mainRows, outside: close.outsideRows, longtermPayrollActual: close.longtermPayrollActual, combinedCostSummary: close.combinedCostSummary },
      grossMargin: { totals: margin.totals, sites: margin.sites.map((s) => ({ ...s })), referralFeeUnattributed: margin.referralFeeUnattributed, specialCostUnattributed: margin.specialCostUnattributed, longtermSalaryTotalAllocatable: margin.longtermSalaryTotalAllocatable, combinedCostSummary: margin.combinedCostSummary },
      payroll: payroll.map((p) => ({ code: p.brokerCode, kind: p.brokerKind, shifts: p.shifts, wage: p.wage, fee: p.fee, amount: p.amount })),
      reconciliation: recon.rules.map((r) => ({ rule: r.rule, status: r.status, diffCount: r.diffCount, detailsSha: sha(r.details) })),
      referral: { total: referral.totalAmount, lines: referral.lineItems.length, linesSha: sha(referral.lineItems) },
      diagnostics: diag,
      postorder: { siteRevenueTotal: post.siteRevenueTotal, siteCostTotal: post.siteCostTotal, summaryTotals: post.summaryTotals, siteRevenue: post.siteRevenue },
      precheck: { numbers: pre.numbers, warnings: pre.warnings.length, needsHuman: pre.needsHuman.length, halt: pre.halt ?? null },
      payrollXlsx: payrollXlsxSheets,
      pendingSummary: { ...(await ps.buildPendingSummary(month)), entries: undefined, entriesSha: sha((await ps.buildPendingSummary(month)).entries.map((e) => ({ site: e.site_name, pending: e.pending_count }))) },
    };
  }
  // stepCompute 放最後（會寫 DB），逐月：numbers 淨留數字／雞頭代號，warnings 存 sha。
  if (!skipCompute) {
    for (const m of months) {
      const [y, mo] = m.split("-").map(Number);
      const month = new Date(Date.UTC(y!, mo! - 1, 1));
      const r = await oc.stepCompute(month, session.userId, null);
      const nums = r.numbers as Record<string, unknown> & { payrollByBroker?: { brokerCode: string; shifts: number; amount: number }[] };
      (out[m] as Record<string, unknown>).stepCompute = {
        numbers: { ...nums, payrollByBroker: (nums.payrollByBroker ?? []).map((b) => ({ code: b.brokerCode, shifts: b.shifts, amount: b.amount })), longtermPayrollNote: undefined },
        warnings: r.warnings.length,
        warningsSha: sha(r.warnings),
      };
    }
  }
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(out, null, 2));
  console.log(`[perf:snapshot] 寫咗 ${outPath}（${months.join(",")}）`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
