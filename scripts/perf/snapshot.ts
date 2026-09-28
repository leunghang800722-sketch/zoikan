// `npm run perf:snapshot -- --out path.json [--months 2026-07,2026-08]`
// ——報表／對數／診斷數字快照（老闆 2026-09-28 效能優化指令：優化前後 7／8
// 月數字要逐格一致）。純讀 DB。輸出唔含任何人名／工號／電話：雞頭淨係用
// 代號，含 PII 嘅明細（對數規則 details）淨係存 sha256，比對相等就得。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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
    out[m] = {
      monthlyClose: { main: close.mainRows, outside: close.outsideRows, longtermPayrollActual: close.longtermPayrollActual, combinedCostSummary: close.combinedCostSummary },
      grossMargin: { totals: margin.totals, sites: margin.sites.map((s) => ({ ...s })), referralFeeUnattributed: margin.referralFeeUnattributed, specialCostUnattributed: margin.specialCostUnattributed, longtermSalaryTotalAllocatable: margin.longtermSalaryTotalAllocatable, combinedCostSummary: margin.combinedCostSummary },
      payroll: payroll.map((p) => ({ code: p.brokerCode, kind: p.brokerKind, shifts: p.shifts, wage: p.wage, fee: p.fee, amount: p.amount })),
      reconciliation: recon.rules.map((r) => ({ rule: r.rule, status: r.status, diffCount: r.diffCount, detailsSha: sha(r.details) })),
      referral: { total: referral.totalAmount, lines: referral.lineItems.length, linesSha: sha(referral.lineItems) },
      diagnostics: diag,
      postorder: { siteRevenueTotal: post.siteRevenueTotal, siteCostTotal: post.siteCostTotal, summaryTotals: post.summaryTotals, siteRevenue: post.siteRevenue },
      precheck: { numbers: pre.numbers, warnings: pre.warnings.length, needsHuman: pre.needsHuman.length, halt: pre.halt ?? null },
    };
  }
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(out, null, 2));
  console.log(`[perf:snapshot] 寫咗 ${outPath}（${months.join(",")}）`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
