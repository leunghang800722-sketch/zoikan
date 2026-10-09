// WP-ONE-CLICK-AUTO（§31.3 B）：更數異常自動解釋——external／公司兵／截短／重複行／雞頭組成／Postorder。
// 口徑：計數更次＝shift 格排除 external；差異 >30% 才拆；剩餘 >15% 且 >20 更先 needs_human（任務書口徑）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, mkBroker, seedUploadWithRows, seedPostorder, postorderCsv } from "./lib/one-click-auto";
import { explainVariances } from "@/lib/month-close/auto/variance";
import { AutoCollector } from "@/lib/month-close/auto/context";

type RowOpt = Parameters<typeof seedUploadWithRows>[0]["rows"][number];
function gen(n: number, f: (i: number) => Partial<RowOpt> = () => ({}), days = 30): RowOpt[] {
  return Array.from({ length: n }, (_, i) => ({ day: (i % days) + 1, nameRaw: `測試人${i}`, staffNoRaw: `U8${String(i).padStart(4, "0")}`, ...f(i) }));
}

describe("WP-ONE-CLICK-AUTO B：更數異常自動解釋", () => {
  let fx: Wp2Fixture;
  let K: { id: string };
  let Y: { id: string };
  let B10: { id: string };
  let siteSeq = 0;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("VK", "broker");
    Y = await mkBroker("VY", "internal_cash");
    B10 = await mkBroker("VB10", "external", { aliases: ["Wilson Guard", "Wilson Supervisor"] });
    siteSeq = 0;
  });

  async function scenario(prevRows: RowOpt[], curRows: RowOpt[], curSummary?: Record<string, unknown>) {
    siteSeq++;
    const site = await prisma.site.create({ data: { canonicalName: `測試比對盤${siteSeq}`, clientName: `測試比對客戶${siteSeq}`, billingModel: "per_shift", createdBy: "t" } });
    const boss = fx.userIds["老闆"];
    await seedUploadWithRows({ month: AUG, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, status: "confirmed", rows: prevRows });
    const cur = await seedUploadWithRows({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, rows: curRows, parseSummary: curSummary });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const res = await explainVariances(ctx, SEPT, [{ id: cur.id, siteId: site.id, siteNameRaw: site.canonicalName, parseSummary: curSummary ?? null }]);
    return { site, ctx, res };
  }

  const K_ROWS = (n: number) => gen(n, () => ({ settlementBrokerId: K.id }));

  it("≤30% 差異 → 冇 finding", async () => {
    const { res } = await scenario(K_ROWS(100), K_ROWS(120));
    expect(res.findings).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it("external：原始格數 +80%，但客戶自己人（rank 命中 Wilson Guard）分開計 → 主數冇變 → explained", async () => {
    const ext = gen(80, (i) => ({ rankRaw: "Wilson Guard", nameRaw: `測試客戶人${i}`, staffNoRaw: `U7${i}` }));
    const { res, ctx } = await scenario(K_ROWS(100), [...K_ROWS(100), ...ext]);
    expect(res.findings).toHaveLength(1);
    const f = res.findings[0]!;
    expect(f.explained).toBe(true);
    expect(f.current).toBe(100);
    expect(f.external).toBe(80);
    expect(f.sentence).toContain("客戶自己人 80 格");
    expect(ctx.summary.variancesExplained).toBe(1);
    expect(ctx.questions).toHaveLength(0);
  });

  it("external：雞頭種類 external（B10 代號）同 rank 別名兩種都分開計", async () => {
    const extByBroker = gen(30, (i) => ({ settlementBrokerId: B10.id, nameRaw: `測試客戶丙${i}`, staffNoRaw: `U6${i}` }));
    const extByName = gen(30, (i) => ({ nameRaw: "Wilson Supervisor", staffNoRaw: `U5${i}`, day: (i % 30) + 1 }));
    const { res } = await scenario(K_ROWS(100), [...K_ROWS(100), ...extByBroker, ...extByName]);
    expect(res.findings[0]!.external).toBe(60);
    expect(res.findings[0]!.current).toBe(100);
  });

  it("公司兵（internal_cash）+49%：拆出「公司兵 49 更」→ explained", async () => {
    const ic = gen(49, (i) => ({ settlementBrokerId: Y.id, nameRaw: `測試兵${i}`, staffNoRaw: `U4${i}` }));
    const { res } = await scenario(K_ROWS(100), [...K_ROWS(100), ...ic]);
    const f = res.findings[0]!;
    expect(f.explained).toBe(true);
    expect(f.internalCash).toBe(49);
    expect(f.sentence).toContain("公司兵 49 更");
  });

  it("截短：只覆蓋 15／30 日（按日均推算）→ 講明「檔案可能截短」＋缺邊幾日，唔同真增減混埋", async () => {
    const half = K_ROWS(100).filter((r) => r.day <= 15);
    const { res } = await scenario(K_ROWS(100), half);
    const f = res.findings[0]!;
    expect(f.sentence).toContain("檔案可能截短");
    expect(f.sentence).toContain("只覆蓋 15／30 日");
    expect(f.sentence).toContain("16"); // 缺 16 號起
    expect(f.explained).toBe(true);
  });

  it("重複行：同人同日同更種重複 60 行 → 拆出重複 → explained", async () => {
    const base = K_ROWS(100);
    const dups = base.slice(0, 60).map((r) => ({ ...r }));
    const { res } = await scenario(K_ROWS(100), [...base, ...dups]);
    const f = res.findings[0]!;
    expect(f.sentence).toContain("重複行 60 更");
    expect(f.explained).toBe(true);
  });

  it("雞頭組成：本月多咗另一個雞頭嘅一批人 → 講明新增雞頭", async () => {
    const K2 = await mkBroker("VK2", "broker");
    const extra = gen(60, (i) => ({ settlementBrokerId: K2.id, nameRaw: `測試新雞頭人${i}`, staffNoRaw: `U3${i}` }));
    const { res } = await scenario(K_ROWS(100), [...K_ROWS(100), ...extra]);
    const f = res.findings[0]!;
    expect(f.sentence).toContain("新增 VK2");
    expect(f.explained).toBe(true);
  });

  it("Postorder 同盤更數一致 → 「Postorder 共 N 更，同本月更表一致」→ explained", async () => {
    siteSeq++;
    const site = await prisma.site.create({ data: { canonicalName: "測試比對PO盤", clientName: "測試比對PO客戶", billingModel: "per_shift", createdBy: "t" } });
    const boss = fx.userIds["老闆"];
    await seedUploadWithRows({ month: AUG, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, status: "confirmed", rows: K_ROWS(100) });
    const cur = await seedUploadWithRows({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, rows: K_ROWS(190) });
    await seedPostorder(SEPT, boss, {
      postorderCsv: postorderCsv([
        { label: "測試比對PO盤 VK", prop: "PO", shift: "Day", client: 900, payout: 800, time: "0700-1900", total: 120 },
        { label: "測試比對PO盤 VK", prop: "PO", shift: "Night", client: 900, payout: 800, time: "1900-0700", total: 70 },
      ]),
    });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const res = await explainVariances(ctx, SEPT, [{ id: cur.id, siteId: site.id, siteNameRaw: site.canonicalName, parseSummary: null }]);
    const f = res.findings[0]!;
    expect(f.sentence).toContain("Postorder 同盤共 190 更");
    expect(f.explained).toBe(true);
  });

  it("解釋唔到 >15% 且 >20 更 → needs_human＋分診題 month_close_shift_variance（冇預填）", async () => {
    const { res, ctx } = await scenario(K_ROWS(100), K_ROWS(220));
    const f = res.findings[0]!;
    expect(f.explained).toBe(false);
    expect(f.unexplained).toBe(120);
    expect(res.needsHuman).toHaveLength(1);
    expect(ctx.questions.map((q) => q.kind)).toEqual(["month_close_shift_variance"]);
    expect(ctx.questions[0]!.evidence.confidence).toBe("unknown");
    expect(ctx.questions[0]!.evidence.prefillCandidateId).toBeNull();
    expect(ctx.summary.variancesUnexplained).toBe(1);
  });

  it("剩餘細（≤20 更）即使 >15% 都當 explained（且閘）", async () => {
    // 上月 40，今月 56：+40%，冇可拆成分，剩餘 16 更 ≤ 20
    const { res } = await scenario(K_ROWS(40), K_ROWS(56));
    const f = res.findings[0]!;
    expect(f.unexplained).toBe(16);
    expect(f.explained).toBe(true);
  });

  it("冇逐格資料（只有 parse_summary）→ 舊口徑警告（可能截短／格式異常），拆唔到", async () => {
    siteSeq++;
    const site = await prisma.site.create({ data: { canonicalName: "測試舊口徑盤", clientName: "x", billingModel: "per_shift", createdBy: "t" } });
    const boss = fx.userIds["老闆"];
    await seedUploadWithRows({ month: AUG, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, status: "confirmed", parseSummary: { shiftCount: 100 }, rows: [] });
    const cur = await seedUploadWithRows({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: boss, parseSummary: { shiftCount: 40 }, rows: [] });
    const ctx = new AutoCollector(null, SEPT, boss, null);
    const res = await explainVariances(ctx, SEPT, [{ id: cur.id, siteId: site.id, siteNameRaw: site.canonicalName, parseSummary: { shiftCount: 40 } }]);
    expect(res.legacyFlagged).toBe(1);
    expect(res.warnings[0]).toContain("可能截短／格式異常");
  });
});
