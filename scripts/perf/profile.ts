// `npm run perf:profile [-- --out path.json]`——效能基線量度（老闆 2026-09-28
// 指令：優化前後要有客觀數字對比）。對 dev DB 逐個報表／對數 lib
// function 量度：牆鐘時間、SQL 條數、SQL 總耗時（Prisma query event）。
// 純讀（唔寫 DB；stepPrecheck 亦係純讀），唔印任何人名／工號／電話——
// 淨係 function 名、月份、數字。
//
// 做法：喺 import 任何 lib 之前，先將一個開咗 query log 嘅 PrismaClient
// 放入 globalThis.prisma——src/lib/db.ts 喺非 production 會重用呢個單例，
// 所以全部 lib 都經呢個 client 行，query 事件先數得到。
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
let queryCount = 0;
let queryMs = 0;
client.$on("query", (e) => {
  queryCount += 1;
  queryMs += e.duration;
});
(globalThis as unknown as { prisma?: PrismaClient }).prisma = client;

type Row = { name: string; month: string; wallMs: number; queries: number; sqlMs: number; note?: string };

async function measure(name: string, month: string, fn: () => Promise<unknown>): Promise<Row> {
  queryCount = 0;
  queryMs = 0;
  const t0 = performance.now();
  let note: string | undefined;
  try {
    await fn();
  } catch (e) {
    note = `ERROR ${e instanceof Error ? e.constructor.name : "unknown"}`;
  }
  const wallMs = Math.round(performance.now() - t0);
  return { name, month, wallMs, queries: queryCount, sqlMs: Math.round(queryMs), note };
}

function systemSession(userId: string) {
  return { userId, tel: "", name: "", roleId: "", roleName: "老闆", baseRole: "老闆" as const, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString() };
}

async function main() {
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;
  const monthsArg = process.argv.indexOf("--months");
  const months = monthsArg >= 0 ? process.argv[monthsArg + 1]!.split(",") : ["2026-07", "2026-08"];

  const mc = await import("@/lib/reports/monthly-close");
  const gm = await import("@/lib/reports/gross-margin");
  const pr = await import("@/lib/reports/payroll");
  const rc = await import("@/lib/reports/reconciliation");
  const rf = await import("@/lib/reports/referral-fee");
  const md = await import("@/lib/reports/month-diagnostics");
  const up = await import("@/lib/pricing/unpriced");
  const ro = await import("@/lib/reports/roster-overview");
  const pe = await import("@/lib/reports/postorder-export");
  const lt = await import("@/lib/longterm-payroll/aggregate");
  const bd = await import("@/lib/reports/broker-dashboard");
  const rcu = await import("@/lib/roster-upload/reconcile");
  const oc = await import("@/lib/month-close/one-click");
  const re = await import("@/lib/roster-export");
  const od = await import("@/lib/ops/digest");
  const mh = await import("@/lib/ops/month-health");

  const boss = await client.user.findFirst({ where: { role: { name: "老闆" } }, select: { id: true } });
  const session = systemSession(boss?.id ?? "");
  const rows: Row[] = [];

  for (const m of months) {
    const [y, mo] = m.split("-").map(Number);
    const month = new Date(Date.UTC(y!, mo! - 1, 1));
    const upload = await client.rosterUpload.findFirst({ where: { month, voidedAt: null, status: { in: ["parsed", "confirmed"] } }, orderBy: { fileSize: "desc" }, select: { id: true, siteId: true } });
    const broker = await client.broker.findFirst({ where: { kind: "external" }, orderBy: { code: "asc" }, select: { id: true } });
    const site = await client.site.findFirst({ where: { shiftRecords: { some: { workDate: { gte: month } } } }, select: { id: true } }).catch(() => null);

    rows.push(await measure("buildMonthlyClose", m, () => mc.buildMonthlyClose(month)));
    rows.push(await measure("buildGrossMargin", m, () => gm.buildGrossMargin(month)));
    rows.push(await measure("buildPayrollTotals", m, () => pr.buildPayrollTotals(month)));
    rows.push(await measure("buildReconciliation", m, () => rc.buildReconciliation(month)));
    rows.push(await measure("computeReferralFeesForMonth", m, () => rf.computeReferralFeesForMonth(month)));
    rows.push(await measure("buildMonthDiagnostics", m, () => md.buildMonthDiagnostics(session, month)));
    rows.push(await measure("buildUnpricedSummary", m, () => up.buildUnpricedSummary(session, month)));
    rows.push(await measure("buildRosterOverview", m, () => ro.buildRosterOverview(session, month)));
    rows.push(await measure("buildPostorderWorkbook", m, () => pe.buildPostorderWorkbook(month)));
    rows.push(await measure("buildLongtermPayrollInputs", m, () => lt.buildLongtermPayrollInputs(month)));
    if (broker) rows.push(await measure("buildBrokerDashboard", m, () => bd.buildBrokerDashboard(broker.id, month)));
    if (upload) rows.push(await measure("reconcileUpload(largest)", m, () => rcu.reconcileUpload(upload.id)));
    // WP-AI-OPS §28.2／§28.3：每月修正摘要＋鎖月前體檢（純讀）。
    rows.push(await measure("buildOpsDigest", m, () => od.buildOpsDigest(month, session)));
    rows.push(await measure("buildMonthHealth", m, () => mh.buildMonthHealth(month, session)));
    rows.push(await measure("stepPrecheck", m, () => oc.stepPrecheck(month, session.userId, null)));
    if (site) rows.push(await measure("buildRosterWorkbookForSite", m, () => re.buildRosterWorkbookForSite(site.id, month)));
  }

  console.log(`| function | month | wall ms | SQL count | SQL ms | note |`);
  console.log(`|---|---|---:|---:|---:|---|`);
  for (const r of rows) console.log(`| ${r.name} | ${r.month} | ${r.wallMs} | ${r.queries} | ${r.sqlMs} | ${r.note ?? ""} |`);
  if (outPath) fs.writeFileSync(path.resolve(outPath), JSON.stringify(rows, null, 2));
  await client.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
