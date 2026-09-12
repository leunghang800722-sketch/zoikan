// Q10「雙重支付」：長工（employment_type=longterm_autopay，有 autopay 月薪）
// 但當更嘅 settlement_broker_id 屬於一個真.正嘅現金雞頭桶（kind=broker 或
// internal_cash，唔係 internal_longterm 自己嗰個 autopay 桶）——即係嗰更
// 雞頭照收現金，安員同時又出咗月薪，兩筆錢都係真實支出（老闆已確認，
// P0-執行計劃§8 Q10）。規劃 session 第三輪 item 1(b)：唔係
// operational_broker_id≠settlement_broker_id（呢個喺依家嘅 settlement_unit
// 已經跟總表雞頭桶嘅現狀下＝0，係正常，唔係漏咗），而係呢個
// employment_type × settlement broker kind 嘅組合。
import { prisma } from "../seed/lib/db";
import { n, round2 } from "./lib/money";
import { parseMonthArg } from "./lib/cli-month";

// P1-WP3：去除寫死 2026-07——`buildQ10DoublePay()` 而家收一個可選
// `month` 參數（default 保留 2026-07，golden check 冇傳參數行為不變）。
export const DEFAULT_REPORT_MONTH = new Date(Date.UTC(2026, 6, 1));
function monthRange(month: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { start, end };
}

export type Q10Bucket = { brokerCode: string; brokerName: string; shifts: number; amount: number };
// PDPO：呢個 type 淨係識別碼＋金額，唔可以擺 guard_id/staff_no/name——
// 逐人拆解淨係用「（雞頭代號, 更數, 金額）」呢個組合嚟分辨（每個人嘅
// 更數+金額組合互不相同，夠做 golden check 唔使暴露真工號）。
export type Q10GuardRow = { brokerCode: string; shifts: number; amount: number };
export type Q10Result = { buckets: Q10Bucket[]; total: number; guards: Q10GuardRow[] };

export async function buildQ10DoublePay(month: Date = DEFAULT_REPORT_MONTH): Promise<Q10Result> {
  const { start, end } = monthRange(month);
  const records = await prisma.shiftRecord.findMany({
    where: {
      recordType: "shift",
      guard: { employmentType: "longterm_autopay" },
      settlementBroker: { kind: { in: ["broker", "internal_cash"] } },
      workDate: { gte: start, lte: end },
    },
    include: { settlementBroker: true },
  });

  const byBroker = new Map<string, Q10Bucket>();
  const byGuard = new Map<string, Q10GuardRow>();
  for (const r of records) {
    const b = r.settlementBroker!;
    const cur = byBroker.get(b.id) ?? { brokerCode: b.code, brokerName: b.name, shifts: 0, amount: 0 };
    cur.shifts += 1;
    cur.amount = round2(cur.amount + n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot));
    byBroker.set(b.id, cur);

    const g = byGuard.get(r.guardId) ?? { brokerCode: b.code, shifts: 0, amount: 0 };
    g.shifts += 1;
    g.amount = round2(g.amount + n(r.guardWageSnapshot) + n(r.brokerFeeSnapshot));
    byGuard.set(r.guardId, g);
  }

  const buckets = [...byBroker.values()].sort((a, b) => b.amount - a.amount);
  const total = round2(buckets.reduce((a, b) => a + b.amount, 0));
  const guards = [...byGuard.values()].sort((a, b) => b.amount - a.amount);
  return { buckets, total, guards };
}

// Opus 驗收細嘢 4(a)：呢個唔係 Vitest 測試——項目嘅 Vitest 套件跑喺一個
// 獨立、臨時嘅假數據 DB（見 tests/global-setup.ts，PDPO 要求 fixture 用
// 假數據），冇辦法喺嗰度鎖住真實 7 月數據嘅金額。呢度用一個獨立、可以
// 直接跑嘅 golden check（對住 `npm run db:seed` 之後嘅 dev DB），數值
// 唔啱就會 exit 1，做到「鎖住」嘅效果，又唔違反「fixture 用假數據」嘅
// 測試架構。用法：`npx tsx scripts/report/q10.ts --check`。
const GOLDEN_TOTAL = 120682.94;
const GOLDEN_TOTAL_SHIFTS = 179;
const GOLDEN_GUARD_COUNT = 6;
// 逐人（雞頭代號,更數,金額）組合，唔用 guard_id/staff_no/name（PDPO）
const GOLDEN_GUARDS: Q10GuardRow[] = [
  { brokerCode: "Y", shifts: 49, amount: 23387.04 },
  { brokerCode: "K", shifts: 26, amount: 22100 },
  { brokerCode: "Y", shifts: 26, amount: 21849.88 },
  { brokerCode: "Y", shifts: 26, amount: 19000.02 },
  { brokerCode: "Y", shifts: 26, amount: 18668.52 },
  { brokerCode: "Y", shifts: 26, amount: 15677.48 },
];

export function checkQ10Golden(result: Q10Result): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const totalShifts = result.guards.reduce((a, g) => a + g.shifts, 0);
  if (Math.abs(result.total - GOLDEN_TOTAL) > 0.01) problems.push(`total: got ${result.total}, want ${GOLDEN_TOTAL}`);
  if (totalShifts !== GOLDEN_TOTAL_SHIFTS) problems.push(`totalShifts: got ${totalShifts}, want ${GOLDEN_TOTAL_SHIFTS}`);
  if (result.guards.length !== GOLDEN_GUARD_COUNT) problems.push(`guardCount: got ${result.guards.length}, want ${GOLDEN_GUARD_COUNT}`);
  const remaining = [...result.guards];
  for (const want of GOLDEN_GUARDS) {
    const idx = remaining.findIndex((g) => g.brokerCode === want.brokerCode && g.shifts === want.shifts && Math.abs(g.amount - want.amount) < 0.01);
    if (idx === -1) {
      problems.push(`冇搵到 golden guard row: ${JSON.stringify(want)}`);
    } else {
      remaining.splice(idx, 1);
    }
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const month = parseMonthArg(process.argv.slice(2));
  buildQ10DoublePay(month).then((r) => {
    console.log("Q10 雙重支付：", JSON.stringify(r, null, 2));
    if (process.argv.includes("--check")) {
      const { ok, problems } = checkQ10Golden(r);
      if (ok) {
        console.log("[q10:check] PASS —— 同 golden value 一致");
      } else {
        console.error("[q10:check] FAIL");
        for (const p of problems) console.error("  " + p);
        process.exitCode = 1;
      }
    }
    prisma.$disconnect();
  });
}
