// WP-ONE-CLICK-AUTO Opus 第三輪驗收 N1–N7：反轉 Opus repro 嘅斷言。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker, Guard, ShiftType, Site } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, sep, mkBroker, mkGuard, seedUploadWithRows } from "./lib/one-click-auto";
import { AutoCollector, SimpleWriter } from "@/lib/month-close/auto/context";
import { createCardAndPrice, runAutoPricing } from "@/lib/month-close/auto/pricing";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";
import { explainVariances } from "@/lib/month-close/auto/variance";
import { buildAutoReport } from "@/lib/month-close/auto/report";
import { repriceMonthForSites } from "@/lib/pricing/reprice";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { GET as getSession } from "@/app/api/triage/sessions/[id]/route";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("WP-ONE-CLICK-AUTO 第三輪 N1–N7", () => {
  let fx: Wp2Fixture;
  let K: Broker;
  let guard: Guard;
  let site: Site;
  let d: ShiftType;
  const boss = () => fx.userIds["老闆"];

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    K = await mkBroker("R3K", "broker");
    guard = await mkGuard({ name: "測試乙" });
    site = await prisma.site.create({ data: { canonicalName: "測試第三輪盤", clientName: "測試第三輪客戶", billingModel: "per_shift", createdBy: "t" } });
    d = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time("0700"), endTime: time("1900"), hours: 12, createdBy: "t" } });
  });
  const rec = (day: number, snap: { c?: number | null; w?: number | null; f?: number | null } = {}) =>
    prisma.shiftRecord.create({ data: { workDate: sep(day), siteId: site.id, shiftTypeId: d.id, guardId: guard.id, settlementBrokerId: K.id, operationalBrokerId: K.id, recordType: "shift", status: "confirmed", source: "roster_upload", clientRateSnapshot: snap.c ?? null, guardWageSnapshot: snap.w ?? null, brokerFeeSnapshot: snap.f ?? null, createdBy: "t" } });
  async function mkRun() {
    return prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: boss(), applyStartedAt: new Date(), finishedAt: new Date(), reportJson: {} } });
  }
  const group = () => ({ siteId: site.id, shiftTypeId: d.id, brokerId: K.id, ot: false });
  const journalRow = (runId: string, rows: unknown[]) => prisma.monthCloseAutoChange.create({ data: { runId, kind: "price_snapshots", refTable: "shift_records", refId: "x", summary: "t", detailJson: { rows } as never, undoable: true } });
  const snapOf = async (id: string) => {
    const r = await prisma.shiftRecord.findUniqueOrThrow({ where: { id } });
    return [r.clientRateSnapshot === null ? null : Number(r.clientRateSnapshot), r.guardWageSnapshot === null ? null : Number(r.guardWageSnapshot), r.brokerFeeSnapshot === null ? null : Number(r.brokerFeeSnapshot)];
  };

  it("N1：undo 之後人手價唔會畀 overwriteAuto 覆蓋（journal 只計 applied）", async () => {
    const run = await mkRun();
    const a = await rec(1, { c: 900 });
    const b = await rec(2);
    await journalRow(run.id, [{ id: a.id, fields: ["client"], before: [null, null, null], after: [900, null, null] }]);
    await prisma.monthCloseAutoChange.updateMany({ where: { runId: run.id }, data: { status: "undone" } });
    // undo 後人手填返 900（同當時自動值一樣）
    const res = await createCardAndPrice(new SimpleWriter("triage:n1", boss(), null), { month: SEPT, group: group(), need: { client: true, payout: false }, values: { clientRate: 950, guardWage: null, brokerFee: null, payoutRate: null }, evidence: "t", note: "t", confidence: "confirmed", overwriteAuto: true });
    expect(await snapOf(a.id)).toEqual([900, null, null]);
    expect((await snapOf(b.id))[0]).toBe(950);
    expect(res.overwrittenAuto).toBe(0);
  });

  it("N2：overwriteAuto 逐欄——客價同工資各自取最新 applied 記錄；人手改過嗰欄唔郁", async () => {
    const run = await mkRun();
    const r1 = await rec(1, { c: 900, w: 700, f: 20 }); // 兩欄都係系統填
    const r2 = await rec(2, { c: 910, w: 700, f: 20 }); // 客價之後被人手改成 910
    await journalRow(run.id, [{ id: r1.id, fields: ["payout"], before: [null, null, null], after: [null, 700, 20] }, { id: r2.id, fields: ["payout"], before: [null, null, null], after: [null, 700, 20] }]);
    await journalRow(run.id, [{ id: r1.id, fields: ["client"], before: [null, 700, 20], after: [900, 700, 20] }, { id: r2.id, fields: ["client"], before: [null, 700, 20], after: [900, 700, 20] }]);
    await createCardAndPrice(new SimpleWriter("triage:n2", boss(), null), { month: SEPT, group: group(), need: { client: true, payout: true }, values: { clientRate: 950, guardWage: 760, brokerFee: 30, payoutRate: 790 }, evidence: "t", note: "t", confidence: "confirmed", overwriteAuto: true });
    expect(await snapOf(r1.id)).toEqual([950, 760, 30]); // 舊版最新記錄只有客價欄 → 工資永遠覆蓋唔到
    expect(await snapOf(r2.id)).toEqual([910, 760, 30]); // 人手客價保留，工資照覆蓋
  });

  it("N3：重用舊 auto 卡要齊欄＋覆蓋成個月，唔夠就拋錯（改入分診）；齊先重用", async () => {
    const run = await mkRun();
    await rec(1);
    const mk = (data: Record<string, unknown>) => prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, effectiveFrom: sep(1), effectiveTo: null, billingModel: "per_shift", source: `auto:one-click:${run.id}`, createdBy: "t", ...data } as never });
    const partial = await mk({ clientRate: 900 }); // 冇工資欄
    const w2 = new AutoCollector(null, SEPT, boss(), null);
    const w = new SimpleWriter(`auto:one-click:other`, boss(), null);
    await expect(createCardAndPrice(w, { month: SEPT, group: group(), need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720 }, evidence: "t", note: "t", confidence: "auto" })).rejects.toThrow(/欄位唔齊|冇覆蓋/);
    expect(await prisma.rateCard.count({ where: { voidedAt: null, siteId: site.id } })).toBe(1);
    await prisma.rateCard.update({ where: { id: partial.id }, data: { guardWage: 700, brokerFee: 20, payoutRate: 720, effectiveTo: sep(14) } }); // 齊欄但只到 14 號
    await expect(createCardAndPrice(w, { month: SEPT, group: group(), need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720 }, evidence: "t", note: "t", confidence: "auto" })).rejects.toThrow();
    await prisma.rateCard.update({ where: { id: partial.id }, data: { effectiveTo: null } });
    const ok = await createCardAndPrice(w, { month: SEPT, group: group(), need: { client: true, payout: true }, values: { clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720 }, evidence: "t", note: "t", confidence: "auto" });
    expect(ok.reusedCard).toBe(true);
    expect(ok.cardId).toBe(partial.id);
    void w2;
  });

  it("N4：後續 reprice 用 auto 卡填價 → 補寫 journal 去建卡嗰個 run；undo 後清返 null 並計入未定價；undo 報 0 仍用舊卡價", async () => {
    const run = await mkRun();
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 900, guardWage: 700, brokerFee: 20, payoutRate: 720, effectiveFrom: sep(1), effectiveTo: sep(30), billingModel: "per_shift", source: `auto:one-click:${run.id}`, createdBy: "t" } });
    const rows = [];
    for (let day = 11; day <= 20; day++) rows.push(await rec(day));
    const manual = await rec(21, { c: 880, w: 650, f: 10 }); // 人手價，reprice 唔會郁
    const before = (await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT)).count;
    expect(before).toBe(10);
    const rp = await repriceMonthForSites(SEPT, [site.id], boss(), null);
    expect(rp.changed).toBe(10);
    expect((await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT)).count).toBe(0);
    const j = await prisma.monthCloseAutoChange.findMany({ where: { runId: run.id, kind: "price_snapshots", status: "applied" } });
    expect(j.reduce((a, c) => a + ((c.detailJson as { rows: unknown[] }).rows.length), 0)).toBe(10);
    const u = await undoAutoChanges(run.id, boss(), null);
    expect(u.undone.price_snapshots).toBe(10);
    expect(u.stillUsingVoidedCardPrices).toBe(0);
    for (const r of rows) expect(await snapOf(r.id)).toEqual([null, null, null]);
    expect(await snapOf(manual.id)).toEqual([880, 650, 10]);
    expect((await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT)).count).toBe(10);
  });

  describe("N5／N7 variance", () => {
    let seq = 0;
    const days = (from: string, to: string) => {
      const out: string[] = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
      return out;
    };
    const rowsFor = (n: number, maxDay = 30) => Array.from({ length: n }, (_, i) => ({ day: (i % maxDay) + 1, nameRaw: `測試人${i}`, staffNoRaw: `U6${String(i).padStart(4, "0")}`, settlementBrokerId: K.id }));
    async function run1(summary: Record<string, unknown> | undefined, rows: ReturnType<typeof rowsFor>, prevRows?: ReturnType<typeof rowsFor>) {
      seq++;
      const s = await prisma.site.create({ data: { canonicalName: `測試第三輪比對盤${seq}`, clientName: `c${seq}`, billingModel: "per_shift", createdBy: "t" } });
      if (prevRows) await seedUploadWithRows({ month: AUG, siteId: s.id, siteNameRaw: s.canonicalName, uploaderUserId: boss(), status: "confirmed", rows: prevRows });
      const cur = await seedUploadWithRows({ month: SEPT, siteId: s.id, siteNameRaw: s.canonicalName, uploaderUserId: boss(), rows, parseSummary: summary });
      const ctx = new AutoCollector(null, SEPT, boss(), null);
      return explainVariances(ctx, SEPT, [{ id: cur.id, siteId: s.id, siteNameRaw: s.canonicalName, parseSummary: summary ?? null }]);
    }
    it("N5：表頭 8/28–9/20 只算 9 月內 20/30 日 → 截短（舊版算 24 日唔截）", async () => {
      const hd = days("2026-08-28", "2026-09-20");
      const res = await run1({ headerDays: hd.length, headerDates: hd, headerDateRange: { min: hd[0], max: hd[hd.length - 1] } }, rowsFor(60, 20));
      expect(res.needsHuman).toHaveLength(1);
      expect(res.findings[0]!.sentence).toContain("表頭只覆蓋 20／30 日");
    });
    it("N5：9 月＋8 月兩個分頁表頭，9 月部分齊全 → 唔截短；8 月日子唔灌水（9 月只 12 日但連 8 月 43 日 → 截短）", async () => {
      const full = [...days("2026-08-01", "2026-08-31"), ...days("2026-09-01", "2026-09-30")];
      const ok = await run1({ headerDays: full.length, headerDates: full, headerDateRange: { min: full[0], max: full[full.length - 1] } }, rowsFor(60));
      expect(ok.needsHuman).toHaveLength(0);
      const mixed = [...days("2026-08-01", "2026-08-31"), ...days("2026-09-01", "2026-09-12")];
      const bad = await run1({ headerDays: mixed.length, headerDates: mixed, headerDateRange: { min: mixed[0], max: mixed[mixed.length - 1] } }, rowsFor(60, 12));
      expect(bad.needsHuman).toHaveLength(1);
      expect(bad.findings[0]!.sentence).toContain("12／30 日");
    });
    it("N7a：舊上載整數比較——上月 31 日齊、今月 1–24 號有更（缺 6 日）→ 截短（浮點 0.19999… 會漏）", async () => {
      const res = await run1({ shiftCount: 60, warnings: [] }, rowsFor(60, 24), rowsFor(62, 31));
      expect(res.needsHuman.concat(res.warnings).join("|")).toContain("檔案可能截短");
    });
    it("N7b：舊上載、冇上月、月尾缺 ≥20% → 至少一行資訊，唔 needs_human", async () => {
      const res = await run1({ shiftCount: 60, warnings: [] }, rowsFor(60, 20));
      expect(res.needsHuman).toHaveLength(0);
      expect(res.warnings.join("|")).toContain("只到 20 號有更");
    });
  });

  it("N6：triage 確認——已有另一題確認過嘅價 → 第二個 409「已有人確認過另一個價」；同題並發只一個 200", async () => {
    for (let i = 1; i <= 3; i++) await rec(i);
    const run = await mkRun();
    const ctx = new AutoCollector(run.id, SEPT, boss(), null);
    await runAutoPricing(ctx, SEPT);
    const report = await buildAutoReport(ctx, SEPT, run.id);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { reportJson: JSON.parse(JSON.stringify({ auto: report })) } });
    const cookie = await sessionCookieForUser(boss());
    const sres = await getSession(req(`http://x/s`, cookie), { params: Promise.resolve({ id: report.triageSessionId! }) });
    const qid = ((await sres.json()) as { questions: Array<{ id: string }> }).questions[0]!.id;
    // 另一題（模擬較早 run）已經確認咗 720
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: d.id, brokerId: K.id, clientRate: 880, guardWage: 720, brokerFee: 10, payoutRate: 730, effectiveFrom: sep(1), effectiveTo: sep(30), billingModel: "per_shift", source: "triage:other-question", createdBy: "t" } });
    const go = async (price: Record<string, number>) => {
      const ans = { option: "mc_price", price };
      const pv = await previewRoute(req(`http://x/p`, cookie, "POST", { answer: ans }), { params: Promise.resolve({ id: qid }) });
      if (pv.status !== 200) return pv;
      const { preview_hash } = (await pv.json()) as { preview_hash: string };
      return answerRoute(req(`http://x/a`, cookie, "POST", { answer: ans, preview_hash }), { params: Promise.resolve({ id: qid }) });
    };
    const clash = await go({ client_rate: 880, guard_wage: 760, broker_fee: 10 });
    expect(clash.status).toBe(409);
    expect(JSON.stringify(await clash.json())).toContain("已有人確認過另一個價");
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" }, voidedAt: null } })).toBe(1);
    const q = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qid } });
    expect(q.status).toBe("open");
    // 同題並發兩個唔同價 → 只一個 200（先作廢衝突卡）
    await prisma.rateCard.updateMany({ data: { voidedAt: new Date() } });
    const results = await Promise.all([go({ client_rate: 880, guard_wage: 720, broker_fee: 10 }), go({ client_rate: 880, guard_wage: 760, broker_fee: 10 })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "triage:" }, voidedAt: null } })).toBe(1);
  });

  it("側項 6：鎖定月份 runAutoPricing 唔做任何嘢", async () => {
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss() } as never });
    await rec(1);
    const run = await mkRun();
    const r = await runAutoPricing(new AutoCollector(run.id, SEPT, boss(), null), SEPT);
    expect(r.skippedReason).toContain("鎖定");
    expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
    void AUG; void aug;
  });
});
