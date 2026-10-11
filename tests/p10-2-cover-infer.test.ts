// P10.2：由歷史反推頂位價目表＋回測。覆蓋六種情況：consistent／mixed／single_sample／推斷唔到(a 無輸入)／多盤分唔到(c)／賣假混入(b)，
// 另有 note 寫明盤名／更數、簽證與冇崗位長工排除、母盤崗位冚子盤、唯讀（零寫入）、老闆專用 403、IC 職級（更別 monthly_ic）。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { sessionCookieForUser } from "./fixtures/wp2-fixture";
import { inferCoverRates } from "@/lib/longterm-payroll/cover-infer";
import { runCoverInference, parseMonthsList } from "@/lib/longterm-payroll/cover-infer-run";
import { loadCoverShifts, gradeFromRank } from "@/lib/longterm-payroll/cover-shifts";
import { GET as inferRoute } from "@/app/api/longterm/cover-rates/infer/route";
import { POST as adoptRoute } from "@/app/api/longterm/cover-rates/adopt/route";
import { p10Base, mkLongterm, shiftAt, coverInput, D, AUG_MONTH, SEP_MONTH } from "./p10-helpers";

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("gradeFromRank／parseMonthsList", () => {
  it("Rank 欄優先；冇 Rank 跟更別", () => {
    expect(gradeFromRank("早更IC", null, "N")).toBe("IC");
    expect(gradeFromRank("保安員", "monthly_ic", "SIC")).toBe("兵");
    expect(gradeFromRank(null, "monthly_ic", "N")).toBe("IC");
    expect(gradeFromRank(null, "per_shift", "SIC")).toBe("IC");
    expect(gradeFromRank("", "per_shift", "N")).toBe("兵");
  });
  it("months 解析：去重排序、壞格式 null、上限 6 個", () => {
    expect(parseMonthsList("2026-09,2026-07,2026-07")!.map((d) => d.toISOString().slice(0, 7))).toEqual(["2026-07", "2026-09"]);
    expect(parseMonthsList("2026-13")).toBeNull();
    expect(parseMonthsList("")).toBeNull();
    expect(parseMonthsList("2026-01,2026-02,2026-03,2026-04,2026-05,2026-06,2026-07")).toBeNull();
  });
});

describe("inferCoverRates 純函數", () => {
  const siteNames = new Map([["sB", "盤B"], ["sC", "盤C"]]);
  const sh = (guardId: string, month: string, siteId: string, grade: "IC" | "兵" = "兵", n = 1) =>
    Array.from({ length: n }, (_, i) => ({ guardId, month, date: `${month}-0${i + 1}`, siteId, grade }));
  const inp = (id: string, guardId: string, month: string, amount: number, note: string) => ({ id, guardId, month, amount, note });

  it("consistent／mixed(眾數、平手無建議)／single_sample 狀態同證據", () => {
    const r = inferCoverRates({
      months: ["2026-08"],
      shifts: [...sh("g1", "2026-08", "sB", "兵", 2), ...sh("g2", "2026-08", "sB", "兵", 1), ...sh("g3", "2026-08", "sC", "兵", 1), ...sh("g4", "2026-08", "sC", "IC", 2), ...sh("g5", "2026-08", "sC", "IC", 2)],
      inputs: [inp("1", "g1", "2026-08", 400, "頂位津貼"), inp("2", "g2", "2026-08", 200, "頂位"), inp("3", "g3", "2026-08", 300, "頂位"), inp("4", "g4", "2026-08", 500, "頂位"), inp("5", "g5", "2026-08", 600, "頂位")],
      siteNames,
    });
    const get = (s: string, g: string) => r.suggestions.find((x) => x.site_id === s && x.grade === g)!;
    expect(get("sB", "兵")).toMatchObject({ status: "consistent", suggested_amount: 200, total_shifts: 3, guard_count: 2, needs_choice: false });
    expect(get("sC", "兵")).toMatchObject({ status: "single_sample", suggested_amount: 300, total_shifts: 1 });
    const ic = get("sC", "IC");
    expect(ic.status).toBe("mixed");
    expect(ic.needs_choice).toBe(true);
    expect(ic.suggested_amount).toBeNull(); // 250 vs 300 各 2 更平手
    expect(ic.amounts.map((a) => a.amount).sort()).toEqual([250, 300]);
  });

  it("mixed 有眾數就建議眾數（仍要老闆揀）", () => {
    const r = inferCoverRates({
      months: ["2026-08"],
      shifts: [...sh("g1", "2026-08", "sB", "兵", 3), ...sh("g2", "2026-08", "sB", "兵", 1)],
      inputs: [inp("1", "g1", "2026-08", 600, "頂位"), inp("2", "g2", "2026-08", 300, "頂位")],
      siteNames,
    });
    expect(r.suggestions[0]).toMatchObject({ status: "mixed", suggested_amount: 200, needs_choice: true });
  });

  it("推斷唔到：(a) 無輸入 (b) 賣假混入／冇頂位更 (c) 多盤分唔到", () => {
    const r = inferCoverRates({
      months: ["2026-08"],
      shifts: [...sh("g1", "2026-08", "sB", "兵", 2), ...sh("g2", "2026-08", "sB", "兵", 1), ...sh("g2", "2026-08", "sC", "兵", 1)],
      inputs: [inp("1", "g2", "2026-08", 600, "頂位津貼"), inp("2", "g3", "2026-08", 800, "頂位＋賣假"), inp("3", "g4", "2026-08", 100, "頂位")],
      siteNames,
    });
    expect(r.suggestions).toHaveLength(0);
    expect(r.unresolved.no_input).toEqual([{ site_id: "sB", site_name: "盤B", grade: "兵", shifts: 2, guard_count: 1, months: ["2026-08"] }]);
    expect(r.unresolved.ambiguous).toEqual([{ guard_id: "g2", month: "2026-08", total_amount: 600, keys: [{ site_id: "sB", site_name: "盤B", grade: "兵", shifts: 1 }, { site_id: "sC", site_name: "盤C", grade: "兵", shifts: 1 }] }]);
    expect(r.unresolved.no_shift.map((x) => x.reason).sort()).toEqual(["no_cover_shift", "sell_leave_mixed"]);
  });

  it("note 寫明盤名＋更數：多盤都分得到", () => {
    const r = inferCoverRates({
      months: ["2026-08"],
      shifts: [...sh("g1", "2026-08", "sB", "兵", 2), ...sh("g1", "2026-08", "sC", "兵", 1)],
      inputs: [inp("1", "g1", "2026-08", 300, "頂位 盤B 3更"), inp("2", "g1", "2026-08", 150, "頂位 盤C")],
      siteNames,
    });
    expect(r.unresolved.ambiguous).toHaveLength(0);
    expect(r.suggestions.find((s) => s.site_id === "sB")).toMatchObject({ suggested_amount: 100, total_shifts: 3 });
    expect(r.suggestions.find((s) => s.site_id === "sC")).toMatchObject({ suggested_amount: 150, total_shifts: 1, status: "single_sample" });
  });

  it("回測：吻合率、差額人月、最大差額、未有價", () => {
    const r = inferCoverRates({
      months: ["2026-08"],
      shifts: [...sh("g1", "2026-08", "sB", "兵", 2), ...sh("g2", "2026-08", "sB", "兵", 1), ...sh("g3", "2026-08", "sB", "兵", 1), ...sh("g4", "2026-08", "sC", "兵", 1)],
      inputs: [inp("1", "g1", "2026-08", 400, "頂位"), inp("2", "g2", "2026-08", 200, "頂位"), inp("3", "g3", "2026-08", 250, "頂位")],
      siteNames,
    });
    // sB 兵：g1 200×2、g2 200、g3 250 → mixed，眾數 200（3 更）
    expect(r.suggestions[0]!.suggested_amount).toBe(200);
    const s = r.backtest.summary;
    expect(s.guard_months).toBe(4);
    expect(s.matched).toBe(2); // g1、g2
    expect(s.diff_nonzero).toBe(1); // g3 實際 250 vs 應有 200
    expect(s.max_abs_diff).toBe(50);
    expect(s.unpriced_guard_months).toBe(1); // g4 去咗未有價嘅盤C
    expect(s.match_rate).toBe(0.5);
    expect(r.backtest.rows.find((x) => x.guard_id === "g3")).toMatchObject({ expected: 200, actual: 250, diff: 50 });
  });
});

describe("loadCoverShifts／runCoverInference（DB，合成 fixture）", () => {
  it("固定崗位唔算頂位；母盤崗位冚子盤；簽證／冇崗位長工排除；IC 跟更別", async () => {
    const b = await p10Base();
    const g = await mkLongterm(b, "測試甲");
    await shiftAt(b, g.id, "A", D(8, 1)); // 自己崗位
    await shiftAt(b, g.id, "AChild", D(8, 2)); // 母盤崗位冚子盤
    await shiftAt(b, g.id, "B", D(8, 3)); // 頂位 兵
    await shiftAt(b, g.id, "C", D(8, 4), { ic: true }); // 頂位 IC
    const visa = await mkLongterm(b, "測試簽證", { visa: true });
    await shiftAt(b, visa.id, "B", D(8, 3));
    const nopost = await mkLongterm(b, "測試冇崗位", { post: null });
    await shiftAt(b, nopost.id, "B", D(8, 3));
    const load = await loadCoverShifts([AUG_MONTH]);
    expect(load.shifts.map((s) => [s.date, s.siteId === b.sites.B.id ? "B" : "C", s.grade]).sort()).toEqual([
      ["2026-08-03", "B", "兵"],
      ["2026-08-04", "C", "IC"],
    ]);
    expect(load.noPostShifts).toBe(1);
  });

  async function scenario() {
    const b = await p10Base();
    const mk = (n: string, opts?: Parameters<typeof mkLongterm>[2]) => mkLongterm(b, n, opts);
    // B 兵 consistent 200：g1 兩更 400、g2 一更 200
    const g1 = await mk("測試1");
    await shiftAt(b, g1.id, "B", D(8, 3));
    await shiftAt(b, g1.id, "B", D(8, 4));
    await coverInput(b, g1.id, AUG_MONTH, 400, "頂位津貼");
    const g2 = await mk("測試2");
    await shiftAt(b, g2.id, "B", D(8, 5));
    await coverInput(b, g2.id, AUG_MONTH, 200, "頂位");
    // C 兵 single_sample 300
    const g3 = await mk("測試3");
    await shiftAt(b, g3.id, "C", D(8, 6));
    await coverInput(b, g3.id, AUG_MONTH, 300, "頂位");
    // C IC mixed：g4 兩更 500（250）、g5 九月一更 300
    const g4 = await mk("測試4");
    await shiftAt(b, g4.id, "C", D(8, 7), { ic: true });
    await shiftAt(b, g4.id, "C", D(8, 8), { ic: true });
    await coverInput(b, g4.id, AUG_MONTH, 500, "頂位");
    const g5 = await mk("測試5");
    await shiftAt(b, g5.id, "C", D(9, 7), { ic: true });
    await coverInput(b, g5.id, SEP_MONTH, 300, "頂位");
    // E：g6 有頂位更冇輸入（a）；g8 輸入混賣假（b）
    const g6 = await mk("測試6");
    await shiftAt(b, g6.id, "E", D(8, 9));
    await shiftAt(b, g6.id, "E", D(8, 10));
    const g8 = await mk("測試8");
    await shiftAt(b, g8.id, "E", D(8, 11));
    await coverInput(b, g8.id, AUG_MONTH, 800, "頂位＋賣假");
    // 多盤分唔到 (c)
    const g7 = await mk("測試7");
    await shiftAt(b, g7.id, "B", D(8, 12));
    await shiftAt(b, g7.id, "C", D(8, 13));
    await coverInput(b, g7.id, AUG_MONTH, 600, "頂位");
    // 有輸入冇頂位更 (b)
    const g9 = await mk("測試9");
    await coverInput(b, g9.id, AUG_MONTH, 100, "頂位");
    // 漏判風險：冇標頂位嘅其他津貼 + 有頂位更
    const g10 = await mk("測試10");
    await shiftAt(b, g10.id, "E", D(8, 14));
    await coverInput(b, g10.id, AUG_MONTH, 999, "津貼");
    // 草稿唔計
    await coverInput(b, g2.id, AUG_MONTH, 9999, "頂位", "draft");
    return { b, g: { g1, g2, g3, g4, g5, g6, g7, g8, g9, g10 } };
  }

  it("六種情況全部正確（建議值／狀態／推斷唔到清單／回測）", async () => {
    const { b, g } = await scenario();
    const r = await runCoverInference([AUG_MONTH, SEP_MONTH]);
    const get = (site: "B" | "C" | "E", grade: string) => r.suggestions.find((x) => x.site_id === b.sites[site].id && x.grade === grade);
    expect(get("B", "兵")).toMatchObject({ status: "consistent", suggested_amount: 200, total_shifts: 3, guard_count: 2 });
    expect(get("C", "兵")).toMatchObject({ status: "single_sample", suggested_amount: 300 });
    expect(get("C", "IC")).toMatchObject({ status: "mixed", needs_choice: true, suggested_amount: 250, total_shifts: 3, guard_count: 2 });
    expect(get("E", "兵")).toBeUndefined();
    expect(r.suggestions).toHaveLength(3);
    expect(r.unresolved.no_input.map((x) => [x.site_name, x.grade, x.shifts, x.guard_count])).toEqual([[b.sites.E.name, "兵", 4, 3]]); // g6 兩更＋g8 一更（輸入混賣假被剔走）＋g10 一更（只有未標頂位嘅津貼）
    expect(r.unresolved.no_shift.map((x) => [x.reason, x.guard_id]).sort()).toEqual([["no_cover_shift", g.g9.id], ["sell_leave_mixed", g.g8.id]].sort());
    expect(r.unresolved.ambiguous).toHaveLength(1);
    expect(r.unresolved.ambiguous[0]).toMatchObject({ guard_id: g.g7.id, total_amount: 600 });
    expect(r.stats).toMatchObject({ cover_shifts: 13, tagged_inputs: 8, untagged_other_allowance_guard_months: 1, no_post_shifts: 0 });
    // 回測：g1 400✓ g2 200✓ g3 300✓ g4 500✗(IC 250×2=500 ✓) g5 九月 IC 一更 250 vs 300 → +50
    const bt = r.backtest.summary;
    const row = (id: string) => r.backtest.rows.find((x) => x.guard_id === id)!;
    expect(row(g.g1.id)).toMatchObject({ expected: 400, actual: 400, diff: 0 });
    expect(row(g.g4.id)).toMatchObject({ expected: 500, actual: 500, diff: 0 });
    expect(row(g.g5.id)).toMatchObject({ expected: 250, actual: 300, diff: 50 });
    expect(row(g.g6.id)).toMatchObject({ expected: 0, unpriced_shifts: 2 });
    expect(row(g.g8.id)).toMatchObject({ has_mixed_input: true, actual: 0 });
    expect(row(g.g10.id)).toMatchObject({ actual: 0, unpriced_shifts: 1 });
    expect(row(g.g7.id)).toMatchObject({ expected: 500, actual: 600, diff: 100 }); // 多盤分唔到：用建議價砌應有 200+300
    expect(bt.max_abs_diff).toBe(100);
    expect(bt.by_month.map((m) => m.month)).toEqual(["2026-08", "2026-09"]);
    expect(bt.match_rate).toBe(Math.round((bt.matched / bt.guard_months) * 100) / 100);
    // 回應冇姓名
    expect(JSON.stringify(r)).not.toContain("測試");
  });

  it("API：非老闆 403（會計）、老闆 200；推斷唯讀（價目表／輸入／audit 行數不變）；壞 months 400", async () => {
    const { b } = await scenario();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const url = "http://x/api/longterm/cover-rates/infer?months=2026-08,2026-09";
    const g = (cookie: string, u = url) => inferRoute(new Request(u, { headers: { cookie } }));
    const counts = async () => [await prisma.coverShiftRate.count(), await prisma.longtermPayrollInput.count(), await prisma.shiftRecord.count(), await prisma.auditLog.count({ where: { action: { in: ["create", "update", "void"] } } })];
    const before = await counts();
    expect((await g(acct)).status).toBe(403);
    expect((await g(owner, "http://x/api/longterm/cover-rates/infer")).status).toBe(400);
    const res = await g(owner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions.length).toBe(3);
    expect(body.backtest.summary.guard_months).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("測試");
    expect(await counts()).toEqual(before);
  });

  it("adopt：只寫通過核對嘅行；mixed 要揀歷史金額；鎖月 403；已有價跳過；audit 帶證據；非老闆 403", async () => {
    const { b } = await scenario();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const post = (cookie: string, body: unknown) => adoptRoute(new Request("http://x/api/longterm/cover-rates/adopt", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const base = { months: "2026-08,2026-09", effective_from: "2026-12-01" };
    const itemB = { site_id: b.sites.B.id, grade: "兵", amount: 200, status: "consistent" };
    expect((await post(acct, { ...base, items: [itemB] })).status).toBe(403);
    expect(await prisma.coverShiftRate.count()).toBe(0);
    // 金額唔係歷史金額
    expect((await post(owner, { ...base, items: [{ ...itemB, amount: 777 }] })).status).toBe(422);
    // mixed 揀咗歷史金額 300（非建議值）OK；status 唔符 422
    expect((await post(owner, { ...base, items: [{ site_id: b.sites.C.id, grade: "IC", amount: 300, status: "consistent" }] })).status).toBe(422);
    expect(await prisma.coverShiftRate.count()).toBe(0);
    // 鎖月
    await prisma.monthClose.create({ data: { month: D(12, 1), lockedAt: new Date(), lockedBy: b.actorUserId } });
    expect((await post(owner, { ...base, items: [itemB] })).status).toBe(403);
    expect(await prisma.coverShiftRate.count()).toBe(0);
    await prisma.monthClose.deleteMany({});
    const ok = await post(owner, { ...base, items: [itemB, { site_id: b.sites.C.id, grade: "IC", amount: 300, status: "mixed" }] });
    expect(ok.status).toBe(201);
    expect((await ok.json()).created).toBe(2);
    const rows = await prisma.coverShiftRate.findMany({ orderBy: { grade: "asc" } });
    expect(rows.map((r) => [r.grade, Number(r.amount), r.source])).toEqual([["IC", 300, "inferred"], ["兵", 200, "inferred"]]);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "cover_shift_rates", rowId: rows[1]!.id, action: "create" } });
    expect(JSON.stringify(audit?.after)).toContain("total_shifts");
    // 再採用同一行＝跳過
    const again = await post(owner, { ...base, items: [itemB] });
    const j = await again.json();
    expect(j.created).toBe(0);
    expect(j.skipped).toHaveLength(1);
  });
});
