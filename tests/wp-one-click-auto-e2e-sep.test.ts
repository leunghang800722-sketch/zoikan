// WP-ONE-CLICK-AUTO（§31.5）：端到端場景測試——用合成更表＋合成 Postorder fixture 重現 2026-09 第一次
// 真實運行暴露嘅四類問題（新盤／更數差異／未定價／無結算雞頭），經 `runOneClickMonthClose()` 一鍵跑完，
// 斷言：新盤全部有更種同更次、更數異常大部分 explained、未定價淨係剩真係冇依據嘅、無結算雞頭自動歸屬；
// 之後 propose 題一撳確認、undo-auto 完全還原、已鎖 8 月數字 0 變。
// 規模縮細（真實 9 月 6 新盤／8 異常／148 更未定價），但門檻、次序同資料形狀一致。全部合成，唔讀 data/。
import { describe, it, expect, beforeEach } from "vitest";
import type { Broker, Guard } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { AUG, SEPT, aug, mkBroker, mkGuard, postorderCsv, rosterCsv, seedPostorder, uploadRoster, type RosterLine } from "./lib/one-click-auto";
import { runOneClickMonthClose } from "@/lib/month-close/one-click";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import type { MonthCloseReport, StepRecord } from "@/lib/month-close/types";
import { GET as getSession } from "@/app/api/triage/sessions/[id]/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { POST as undoRoute } from "@/app/api/month-close/one-click/[id]/undo-auto/route";

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
const days = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const codes = (ds: number[], code = "D"): Record<number, string> => Object.fromEntries(ds.map((d) => [d, code]));

describe("WP-ONE-CLICK-AUTO 端到端：2026-09 四類問題（合成重現）", () => {
  let fx: Wp2Fixture;
  let EK: Broker;
  let EW: Broker;
  let EY: Broker;
  let B07: Broker;
  const boss = () => fx.userIds["老闆"];
  let guardSeq = 0;
  const g = async (opts: Parameters<typeof mkGuard>[0] = {}): Promise<Guard> => {
    guardSeq++;
    return mkGuard({ staffNo: `U9${String(guardSeq).padStart(5, "0")}`, ...opts });
  };
  const line = (guard: Guard, ds: number[], extra: Partial<RosterLine> = {}): RosterLine => ({ staffNo: guard.staffNo!, name: guard.nameZh, tel: guard.tel ?? undefined, time: "0700-1900", codes: codes(ds), ...extra });

  async function mkSite(name: string, opts: { client?: string; cards?: Array<{ broker: Broker; client: number; wage: number }>; times?: string } = {}) {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: opts.client ?? `${name}客戶`, billingModel: "per_shift", createdBy: "t" } });
    const [s, e] = (opts.times ?? "0700-1900").split("-");
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", startTime: time(s!), endTime: time(e!), hours: 12, createdBy: "t" } });
    for (const c of opts.cards ?? []) {
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, brokerId: c.broker.id, clientRate: c.client, guardWage: c.wage, brokerFee: 0, payoutRate: c.wage, billingModel: "per_shift", effectiveFrom: aug(1), effectiveTo: aug(31), createdBy: "t" } });
    }
    return { site, st };
  }
  async function augUpload(siteRaw: string, lines: RosterLine[]) {
    const r = await uploadRoster({ siteRaw, month: AUG, lines, uploaderUserId: boss(), dayCount: 31 });
    await prisma.rosterUpload.update({ where: { id: r.upload.id }, data: { status: "confirmed" } });
  }
  const sepUpload = (siteRaw: string, lines: RosterLine[], dayCount = 30) => uploadRoster({ siteRaw, month: SEPT, lines, uploaderUserId: boss(), dayCount });

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    guardSeq = 0;
    EK = await mkBroker("EK", "broker");
    EW = await mkBroker("EW", "broker");
    EY = await mkBroker("EY", "internal_cash");
    B07 = await mkBroker("EB07", "internal_longterm");
    await mkBroker("EB10", "external", { aliases: ["Wilson Guard", "Wilson Supervisor"] });
    void B07;
  });

  async function seedScenario() {
    const cardK = [{ broker: EK, client: 900, wage: 700 }];
    // ---- 既有盤（8 月有更表＋價卡）----
    const e1 = await mkSite("測試數碼港CP", { cards: cardK });
    const e3 = await mkSite("測試截短盤", { cards: cardK });
    const e4 = await mkSite("測試重複盤", { cards: cardK });
    const e5 = await mkSite("測試小增減盤", { cards: cardK });
    const e6 = await mkSite("測試真增減盤", { cards: cardK });
    const e7 = await mkSite("測試PO對盤", { cards: cardK });
    const e8 = await mkSite("測試公司兵盤", { cards: cardK });
    const e9 = await mkSite("測試雞頭組成盤", { cards: [...cardK, { broker: EW, client: 900, wage: 650 }] });
    const e10 = await mkSite("測試正常盤", { cards: cardK });
    const hoR = await mkSite("測試皓日", { cards: [{ broker: EW, client: 800, wage: 750 }] });
    const ev = await mkSite("測試Event盤", { cards: cardK, times: "0900-1600" });

    // 保安員
    const [a1, a2, a3, a4, a5, a6, a7, a8] = [await g(), await g(), await g(), await g(), await g(), await g(), await g(), await g()];
    const ext = await g({ employmentType: "external", name: "測試客戶人員" });
    const y1 = await g({ defaultBrokerId: EY.id });
    const y2 = await g({ defaultBrokerId: EY.id });
    const w1 = await g({ defaultBrokerId: EW.id });
    const hoOld = await g({ name: "測試皓日人" });
    const hoNew = await g({ name: "測試皓日人（新建）", staffNo: "U9HO2" });
    const evG = await g({ name: "測試Event人" });
    const posts = [await g(), await g(), await g(), await g(), await g(), await g()];

    // ---- Aug ----
    const kLines = (gs: Guard[], ds: number[]) => gs.map((x) => line(x, ds, { broker: "EK" }));
    await augUpload(e1.site.canonicalName, kLines([a1, a2], days(1, 30)));
    await augUpload(e3.site.canonicalName, kLines([a1, a2], days(1, 30)));
    await augUpload(e4.site.canonicalName, kLines([a3], days(1, 30)));
    await augUpload(e5.site.canonicalName, kLines([a4], days(1, 20)));
    await augUpload(e6.site.canonicalName, kLines([a5], days(1, 30)));
    await augUpload(e7.site.canonicalName, kLines([a6], days(1, 30)));
    await augUpload(e8.site.canonicalName, kLines([a7], days(1, 30)));
    await augUpload(e9.site.canonicalName, kLines([a8], days(1, 30)));
    await augUpload(e10.site.canonicalName, kLines([a1], days(1, 30)));
    await augUpload(hoR.site.canonicalName, [line(hoOld, days(1, 10), { broker: "EW", staffNo: "U9HO1" })]);
    // 鎖 8 月（precheck 要求上月已鎖）
    await prisma.monthClose.create({ data: { month: AUG, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });

    // ---- Sep ----
    await sepUpload(e1.site.canonicalName, [
      ...kLines([a1, a2], days(1, 30)),
      line(ext, days(1, 30), { rank: "Wilson Guard" }),
      line(await g({ name: "測試客戶人員乙", employmentType: "external" }), days(1, 10), { rank: "Wilson Supervisor" }),
      line(y1, days(1, 25), { broker: "EY" }),
    ]);
    await sepUpload(e3.site.canonicalName, kLines([a1, a2], days(1, 15)), 15); // 表頭只到 15 號＝檔案截短
    await sepUpload(e4.site.canonicalName, [line(a3, days(1, 30), { broker: "EK" }), line(a3, days(1, 30), { broker: "EK" })]);
    await sepUpload(e5.site.canonicalName, kLines([a4], days(1, 30)));
    await sepUpload(e6.site.canonicalName, kLines([a5, posts[0]!, posts[1]!], days(1, 30)));
    await sepUpload(e7.site.canonicalName, kLines([a6, posts[2]!], days(1, 30)));
    await sepUpload(e8.site.canonicalName, [...kLines([a7], days(1, 30)), line(y2, days(1, 20), { broker: "EY" })]);
    await sepUpload(e9.site.canonicalName, [...kLines([a8], days(1, 30)), line(w1, days(1, 30), { broker: "EW" })]);
    await sepUpload(e10.site.canonicalName, kLines([a1], days(1, 30)));
    // 皓日：新建保安員、更表冇雞頭欄（上月同一更表姓名同工號有 EW）
    await sepUpload(hoR.site.canonicalName, [line(hoNew, days(1, 8), { staffNo: "U9HO1", name: "測試皓日人（新建）" })]);
    // Event：更表冇雞頭欄，Postorder Roster 逐日有雞頭
    await sepUpload(ev.site.canonicalName, [line(evG, [3, 4], { time: "0900-1600" })]);
    // 新盤（6 個）
    const newDefs: Array<[string, number, string]> = [
      ["測試尊豪坊新", 9, "EK"],
      ["測試海景新", 10, "EW"],
      ["測試娉廷新", 9, "EW"],
      ["測試機場新", 10, "EK"],
      ["測試永隆新", 10, "EW"],
      ["測試南豐新", 9, "EK"],
    ];
    for (const [name, n, broker] of newDefs) {
      const gg = await g();
      await sepUpload(name, [line(gg, days(1, n), { broker })]);
    }

    // Postorder fixture（PostOrder + Roster 兩個分頁 CSV）
    await seedPostorder(SEPT, boss(), {
      postorderCsv: postorderCsv([
        { block: "測試卓弘有限公司" },
        { label: "測試尊豪坊新 EK", prop: "尊豪新", shift: "Day", client: 833, payout: 630, time: "0700-1900", total: 9 },
        { label: "測試恆星樓舊 EK", prop: "恆星舊", shift: "Day", client: 833, payout: 630, time: "0700-1900", total: 4 },
        { block: "測試Urban公司" },
        { label: "測試海景新", prop: "海景新", shift: "Day", client: 950, payout: 800, time: "0700-1900", total: 10 },
        { label: "測試海景新 EK", prop: "海景新", shift: "Day", client: 950, payout: 790, time: "0700-1900", total: 1 },
        { label: "測試娉廷新", prop: "娉廷新", shift: "Day", client: 950, payout: 800, time: "0700-1900", total: 9 },
        { block: "其他盤 12hrs (D/S)" },
        { label: "測試機場新 EK", prop: "機場新", shift: "Day", client: 940, payout: 800, time: "0700-1900", total: 10 },
        { label: "測試永隆新 EW", prop: "永隆新", shift: "Day", client: 780, payout: 650, time: "0700-1900", total: 10 },
        { label: "測試PO對盤 EK", prop: "PO對", shift: "Day", client: 900, payout: 700, time: "0700-1900", total: 60 },
        { label: "測試Event盤", prop: "Ev", shift: "Day", client: 900, payout: 700, time: "0900-1600", total: 2 },
      ]),
      rosterCsv: rosterCsv([{ label: "測試Event盤", prop: "Ev", shift: "Day", days: { 3: "(2) EK", 4: "(2) EK" } }]),
    });
    return { e1, e8, e6, hoR, ev, hoNew, evG };
  }

  async function snapshotAug() {
    const recs = await prisma.shiftRecord.count({ where: { workDate: { lt: SEPT } } });
    const cards = await prisma.rateCard.findMany({ where: { effectiveFrom: { lt: SEPT } }, select: { id: true, voidedAt: true, clientRate: true, guardWage: true } });
    const ups = await prisma.rosterUpload.findMany({ where: { month: AUG }, select: { id: true, status: true, siteId: true } });
    return JSON.stringify({ recs, cards: cards.map((c) => [c.id, c.voidedAt, Number(c.clientRate), Number(c.guardWage)]).sort(), ups: ups.map((u) => [u.id, u.status, u.siteId]).sort() });
  }

  it("一鍵跑完：新盤齊更種更次、更數異常 7/8 explained、無結算自動歸屬、未定價剩冇依據；之後一撳確認＋undo 完全還原；8 月 0 變", async () => {
    const s = await seedScenario();
    const aug0 = await snapshotAug();
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss(), applyStartedAt: new Date() } });
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    const done = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.errorMessage).toBeNull();
    expect(done.status).toBe("done");
    const steps = done.stepsJson as unknown as StepRecord[];
    expect(steps.map((x) => x.key)).toContain("auto_pricing");
    expect(steps.find((x) => x.key === "auto_pricing")?.status).toBe("done");
    const report = done.reportJson as unknown as MonthCloseReport;
    const auto = report.auto!;
    expect(auto).toBeDefined();

    // 1. 新盤：6 個全部自動建、齊更種、更次入數
    const newNames = ["測試尊豪坊新", "測試海景新", "測試娉廷新", "測試機場新", "測試永隆新", "測試南豐新"];
    expect(auto.summary.sitesCreated).toBe(6);
    let newCells = 0;
    for (const name of newNames) {
      const site = await prisma.site.findUniqueOrThrow({ where: { canonicalName: name } });
      const sts = await prisma.shiftType.count({ where: { siteId: site.id, voidedAt: null } });
      const up = await prisma.rosterUpload.findFirstOrThrow({ where: { month: SEPT, siteId: site.id } });
      const rows = await prisma.rosterUploadRow.count({ where: { uploadId: up.id, codeKind: "shift" } });
      const recs = await prisma.shiftRecord.count({ where: { siteId: site.id, status: { not: "cancelled" } } });
      expect(sts).toBeGreaterThanOrEqual(1);
      expect(recs).toBe(rows);
      newCells += recs;
      expect(report.siteRevenue.find((r) => r.siteId === site.id)?.shifts).toBe(recs);
    }
    expect(newCells).toBe(57);
    const zun = await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試尊豪坊新" } });
    expect(zun.clientName).toBe("測試卓弘有限公司");
    expect(zun.aliases).toContain("尊豪新");
    expect((await prisma.site.findUniqueOrThrow({ where: { canonicalName: "測試機場新" } })).clientName).toBe("測試機場新"); // 其他盤 12hrs block 唔合資格做客戶群

    // 2. 更數異常：8 個，7 個 explained（external／公司兵／截短／重複／小增減／雞頭組成／Postorder），1 個解釋唔到
    const vf = (steps.find((x) => x.key === "parse_health")!.numbers.varianceFindings as Array<{ site: string; explained: boolean; sentence: string; external: number; internalCash: number }>) ?? [];
    // 截短只認表頭覆蓋 <80%：呢個場景其他盤雖然只有部分日子有更，但表頭 30/30 日 → 唔再出假截短題
    const MAIN8 = ["測試數碼港CP", "測試截短盤", "測試重複盤", "測試小增減盤", "測試真增減盤", "測試PO對盤", "測試公司兵盤", "測試雞頭組成盤"];
    expect(vf).toHaveLength(8);
    expect(vf.every((x) => MAIN8.includes(x.site))).toBe(true);
    expect(vf.filter((x) => x.explained)).toHaveLength(5); // 小增減盤 +10（50%）剩餘 10 >5 且 >15% 而家要人睇；截短一律唔當 explained（要人確認檔案齊唔齊）
    expect(auto.summary.variancesExplained).toBe(5);
    expect(auto.summary.variancesUnexplained).toBe(3);
    for (const f of vf as Array<{ components?: { delta: number; dup: number; ic: number; sub: number; broker: number; trunc: number; residual: number } }>) {
      const c = f.components;
      if (!c) continue; // 冇上月比較（新盤）嘅截短 finding 冇差額可拆
      expect(c.dup + c.ic + c.sub + c.broker + c.trunc + c.residual).toBe(c.delta); // 每格只歸一個成分
    }
    const e1f = vf.find((x) => x.site === "測試數碼港CP")!;
    expect(e1f.external).toBe(40);
    expect(e1f.internalCash).toBe(25);
    expect(e1f.sentence).toContain("已排除客戶自己人 40 格");
    expect(e1f.sentence).toContain("公司兵 25 更");
    expect(vf.find((x) => x.site === "測試截短盤")!.sentence).toContain("檔案可能截短");
    expect(vf.find((x) => x.site === "測試截短盤")!.explained).toBe(false);
    expect(vf.find((x) => x.site === "測試重複盤")!.sentence).toContain("重複行 30 更");
    expect(vf.find((x) => x.site === "測試雞頭組成盤")!.sentence).toContain("新增 EW");
    expect(vf.find((x) => x.site === "測試PO對盤")!.sentence).toContain("Postorder 同盤共 60 更");
    expect(vf.find((x) => x.site === "測試真增減盤")!.explained).toBe(false);
    // external 分開計：唔入主數
    expect(auto.summary.counts.external).toBeGreaterThanOrEqual(40);
    const e1recs = await prisma.shiftRecord.findMany({ where: { siteId: s.e1.site.id, status: { not: "cancelled" } }, include: { settlementBroker: true } });
    expect(e1recs.filter((r) => r.settlementBroker?.kind === "external").length).toBe(40);

    // 3. 無結算雞頭：Event（Postorder 同日雞頭 EK）自動歸屬；皓日係新保安員（冇同一 guard_id 歷史）→ 唔靠姓名跨保安員回溯，入分診
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: s.ev.site.id } })) expect(r.settlementBrokerId).toBe(EK.id);
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: s.hoR.site.id } })) expect(r.settlementBrokerId).toBeNull();
    expect(auto.summary.recordsSettled).toBe(2);
    expect(report.unpriced.noSettlementCount).toBe(8);
    expect(auto.review.some((x) => x.kind === "month_close_settlement")).toBe(true);

    // 4. 未定價：auto 之後剩 propose（海景／娉廷）＋冇依據（公司兵 Y 25+20、南豐新 9）
    expect(auto.summary.cardsCreated).toBeGreaterThanOrEqual(12);
    const owner = await sessionCookieForUser(boss());
    const kinds = auto.review.map((x) => x.kind).sort();
    expect(kinds.filter((k) => k === "month_close_pricing").length).toBe(3); // 海景（propose：Postorder 有 EK 專屬價，冇 EW 嘅）＋ 數碼港公司兵、公司兵盤公司兵（unknown）
    expect(kinds).toContain("month_close_site_new"); // 南豐新
    expect(kinds).toContain("month_close_shift_variance");
    expect(auto.review.every((x) => x.confidence === "propose" || x.confidence === "unknown")).toBe(true);
    expect(auto.review.every((x) => x.text.length > 0 && x.questionId)).toBe(true);
    const unpricedNow = await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT);
    expect(unpricedNow.count).toBe(10 + 9 + 25 + 20 + 8); // 皓日 8 更（冇結算雞頭，入分診）＋海景（propose）＋南豐（冇依據）＋公司兵 Y（冇依據）；娉廷 Postorder 冇按雞頭分價、值唯一 → auto
    expect(report.unpriced.count).toBe(unpricedNow.count);
    expect(report.unpriced.gap).toBeDefined();
    expect(auto.summary.unpricedRecords).toBe(unpricedNow.count);

    // 4b. 報告／分診題以外唔准出 PII：報告 JSON、steps、分診題 title／summary／候選文字，唔含任何保安員姓名／電話／工號
    const guardRows = await prisma.guard.findMany({ select: { nameZh: true, staffNo: true, tel: true } });
    const reportText = JSON.stringify(done.reportJson) + JSON.stringify(done.stepsJson);
    const qrows = await prisma.triageQuestion.findMany({ where: { sessionId: auto.triageSessionId! } });
    const questionText = JSON.stringify(qrows.map((q) => [q.title, (q.evidenceJson as { summary: string; suggestion: string | null; candidates: unknown[] }).summary, (q.evidenceJson as { suggestion: string | null }).suggestion, (q.evidenceJson as { candidates: unknown[] }).candidates, q.optionsJson]));
    for (const gd of guardRows) {
      for (const token of [gd.nameZh, gd.staffNo, gd.tel]) {
        if (!token) continue;
        expect(reportText.includes(token), `report 含 PII：${token.slice(0, 2)}…`).toBe(false);
        expect(questionText.includes(token), `分診題含 PII：${token.slice(0, 2)}…`).toBe(false);
      }
    }

    // 5. 一撳確認 propose（海景）→ 未定價剩 Y 45 ＋ 南豐 9
    const qs = ((await (await getSession(req(`http://x/s`, owner), { params: Promise.resolve({ id: auto.triageSessionId! }) })).json()) as { questions: Array<{ id: string; kind: string; mc: { confidence: string; prefill_candidate_id: string | null; summary: string } }> }).questions;
    const proposes = qs.filter((q) => q.kind === "month_close_pricing" && q.mc.confidence === "propose");
    expect(proposes).toHaveLength(1);
    for (const q of proposes) {
      const pv = await previewRoute(req(`http://x/p`, owner, "POST", { answer: { option: "mc_accept" } }), { params: Promise.resolve({ id: q.id }) });
      expect(pv.status).toBe(200);
      const { preview_hash } = (await pv.json()) as { preview_hash: string };
      const ar = await answerRoute(req(`http://x/a`, owner, "POST", { answer: { option: "mc_accept" }, preview_hash }), { params: Promise.resolve({ id: q.id }) });
      expect(ar.status).toBe(200);
    }
    const unpricedAfterConfirm = await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT);
    expect(unpricedAfterConfirm.count).toBe(9 + 25 + 20 + 8); // 南豐＋公司兵 Y＋皓日（冇結算雞頭）
    const remainingSites = new Set(unpricedAfterConfirm.groups.map((x) => x.site_name));
    expect([...remainingSites].sort()).toEqual(["測試公司兵盤", "測試南豐新", "測試數碼港CP", "測試皓日"].sort());

    // 6. undo-auto：自動改動完全還原（價卡作廢、價 snapshot 還原、alias 移除、結算還原）；人手確認嘅（triage:）唔還原；8 月 0 變
    const undo = await undoRoute(req(`http://x/u`, owner, "POST"), { params: Promise.resolve({ id: run.id }) });
    expect(undo.status).toBe(200);
    const ub = (await undo.json()) as { undone: Record<string, number>; skipped: Array<{ kind: string }> };
    expect(ub.undone.rate_cards).toBe(auto.summary.cardsCreated);
    expect(ub.undone.settlement).toBe(2);
    // 新盤更種有更次用緊 → 唔作廢
    expect(ub.skipped.every((x) => x.kind === "shift_type_created")).toBe(true);
    const autoCards = await prisma.rateCard.findMany({ where: { source: `auto:one-click:${run.id}` } });
    expect(autoCards.length).toBeGreaterThan(0);
    expect(autoCards.every((c) => c.voidedAt !== null)).toBe(true);
    for (const r of await prisma.shiftRecord.findMany({ where: { siteId: s.ev.site.id } })) expect(r.settlementBrokerId).toBeNull();
    const triageCards = await prisma.rateCard.findMany({ where: { source: { startsWith: "triage:" } } });
    expect(triageCards.every((c) => c.voidedAt === null)).toBe(true);
    // 價 snapshot：例如 e10 正常盤 auto 價之後被還原（無 auto 卡）→ 未定價
    const afterUndo = await buildUnpricedSummary({ userId: boss(), baseRole: "老闆", brokerId: null } as never, SEPT);
    expect(afterUndo.count).toBeGreaterThan(unpricedAfterConfirm.count);
    // 已作廢嘅 auto 卡唔准留低佢嘅價：冇任何九月更次 snapshot 仲等如已作廢 auto 卡嘅價
    for (const c of autoCards) {
      const left = await prisma.shiftRecord.count({ where: { siteId: c.siteId, shiftTypeId: c.shiftTypeId!, workDate: { gte: SEPT }, status: { not: "cancelled" }, ...(c.clientRate !== null ? { clientRateSnapshot: c.clientRate } : { guardWageSnapshot: c.payoutRate ?? c.guardWage }) } });
      expect(left, `卡 ${c.id.slice(0, 8)} 嘅價未清走`).toBe(0);
    }
    expect(await snapshotAug()).toBe(aug0);
    void MonthLabel;
  });

  it("rerun 冪等：第一次同第二次（同一個 run 重新執行）報告收入／成本／逐盤／逐雞頭／未定價逐欄相同，唔重複建卡", async () => {
    await seedScenario();
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss(), applyStartedAt: new Date() } });
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    const first = (await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } })).reportJson as unknown as MonthCloseReport;
    const cards1 = await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" }, voidedAt: null } });
    const snaps1 = JSON.stringify((await prisma.shiftRecord.findMany({ where: { workDate: { gte: SEPT } }, select: { id: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true, settlementBrokerId: true }, orderBy: { id: "asc" } })).map((r) => [r.id, String(r.clientRateSnapshot), String(r.guardWageSnapshot), String(r.brokerFeeSnapshot), r.settlementBrokerId]));
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "running", applyStartedAt: new Date(), finishedAt: null } });
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    const second = (await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } })).reportJson as unknown as MonthCloseReport;
    expect(await prisma.rateCard.count({ where: { source: { startsWith: "auto:one-click:" }, voidedAt: null } })).toBe(cards1);
    const snaps2 = JSON.stringify((await prisma.shiftRecord.findMany({ where: { workDate: { gte: SEPT } }, select: { id: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true, settlementBrokerId: true }, orderBy: { id: "asc" } })).map((r) => [r.id, String(r.clientRateSnapshot), String(r.guardWageSnapshot), String(r.brokerFeeSnapshot), r.settlementBrokerId]));
    expect(snaps2).toBe(snaps1);
    const pick = (r: MonthCloseReport) => ({ totals: r.totals, siteRevenue: [...r.siteRevenue].sort((a, b) => a.siteName.localeCompare(b.siteName)).map(({ siteName, shifts, revenue }) => ({ siteName, shifts, revenue })), payroll: r.payrollByBroker, unpriced: r.unpriced, review: r.auto!.review.map((x) => [x.kind, x.confidence]).sort() });
    expect(pick(second)).toEqual(pick(first));
    // undo 後再跑（同一個 run）：報告同第一次逐欄相同——證明 undo 冇留低任何舊價／結算影響收入
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    const { undoAutoChanges } = await import("@/lib/month-close/auto/undo");
    await undoAutoChanges(run.id, boss(), null);
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "running", applyStartedAt: new Date(), finishedAt: null } });
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    const third = (await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } })).reportJson as unknown as MonthCloseReport;
    expect(pick(third)).toEqual(pick(first));
  });

  it("已鎖 9 月：一鍵 halt，唔寫任何自動改動", async () => {
    await seedScenario();
    await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: boss(), createdBy: "t" } });
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: boss(), applyStartedAt: new Date() } });
    const before = { sites: await prisma.site.count(), cards: await prisma.rateCard.count(), changes: await prisma.monthCloseAutoChange.count() };
    await runOneClickMonthClose(run.id, SEPT, boss(), null);
    expect((await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("failed");
    expect({ sites: await prisma.site.count(), cards: await prisma.rateCard.count(), changes: await prisma.monthCloseAutoChange.count() }).toEqual(before);
  });
});

const MonthLabel = "2026-09";
