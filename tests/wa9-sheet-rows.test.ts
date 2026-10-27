// WA-9 (3)：值勤／出勤記錄表逐行抽取——解析、逐行判定（兩讀一致／仲裁／低信心）、每行獨立 resolve（U 格式工號／Wilson 編號用姓名）、bench 逐行 recall／precision。
// 全部合成資料（假名、假工號），唔打 API。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import type { ResolveContext, ResolveRepo, ShiftTypeLite } from "@/lib/whatsapp/resolve";
import { resolveCardPhoto, type CardDeps } from "@/lib/whatsapp/card-resolve";
import { readCardPhoto } from "@/lib/whatsapp/card-ocr";
import type { CardEngine, CardEngineName, EngineOutcome } from "@/lib/whatsapp/card-engines";
import { parseCardText, type SheetRow } from "@/lib/whatsapp/card-parse";
import { parseTruthDetail, runBench, scoreRows, scoreSheet, summaryLines } from "../scripts/whatsapp/lib/card-bench-core";

const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const row = (n: number, name: string, no: string | null, on: string, off: string | null = null, over: Partial<SheetRow> = {}): SheetRow => ({ row: n, date: "2026-10-19", name_zh: name, staff_no_raw: no, time_on: on, time_off: off, confidence: "high", ...over });
const sheet = (rows: SheetRow[]): EngineOutcome => ({ ok: true, is_card: true, cards: [], rows, doc_type: "attendance_sheet", usage: null });
const fake = (name: CardEngineName, o: EngineOutcome): CardEngine => ({ name, model: "m", read: async () => o });
const engs = (m: Partial<Record<CardEngineName, EngineOutcome>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fake(k as CardEngineName, v!)])) as Partial<Record<CardEngineName, CardEngine>>;

describe("解析 rows", () => {
  it("JSON rows：日期只收 ISO、時間正規化、保留工號欄原樣（Wilson 純數字／手寫碼）、無姓名無工號行丟棄", () => {
    const p = parseCardText(JSON.stringify({ doc_type: "attendance_sheet", cards: [], rows: [
      { row: 1, date: "2026-10-19", name_zh: "測試甲", staff_no_raw: "U90001", time_on: "7:55", time_off: "1700", confidence: "high" },
      { row: 2, date: "10/19", name_zh: "測試乙", staff_no_raw: "6012345", time_on: "08.00", time_off: null, confidence: "low" },
      { row: 3, date: null, name_zh: null, staff_no_raw: null, time_on: "08:00", time_off: null, confidence: "high" },
    ] }));
    expect(p.doc_type).toBe("attendance_sheet");
    expect(p.cards).toEqual([]);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ row: 1, date: "2026-10-19", name_zh: "測試甲", staff_no_raw: "U90001", time_on: "07:55", time_off: "17:00" });
    expect(p.rows[1]).toMatchObject({ date: null, staff_no_raw: "6012345", confidence: "low" });
  });
});

describe("readCardPhoto：值勤表逐行", () => {
  const R = [row(1, "測試甲", "U90001", "07:55", "17:00"), row(2, "測試乙", "6012345", "08:00", "17:05"), row(3, "測試丙", null, "08:10")];
  it("兩個引擎逐行完全一致 → 全部 confirmed，唔仲裁；一張相 N 行＝N 張卡；Wilson 編號只暫存", async () => {
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet(R), deepseek: sheet(R) }) });
    expect(r).toMatchObject({ kind: "cards", doc_type: "attendance_sheet", arbiter_used: false });
    expect(r.cards.map((c) => [c.name_zh, c.staff_no, c.wilson_staff_no_raw ?? null, c.status, c.time_on, c.row_date])).toEqual([
      ["測試甲", "U90001", null, "confirmed", "07:55", "2026-10-19"],
      ["測試乙", null, "6012345", "confirmed", "08:00", "2026-10-19"],
      ["測試丙", null, null, "confirmed", "08:10", "2026-10-19"],
    ]);
  });
  it("某行兩邊唔一致（時間）→ 仲裁；仲裁同其中一邊一致＝confirmed（時間取多數）", async () => {
    const B = [R[0]!, row(2, "測試乙", "6012345", "08:30", "17:05"), R[2]!];
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet(R), deepseek: sheet(B), claude: sheet(R) }) });
    expect(r.arbiter_used).toBe(true);
    expect(r.cards.every((c) => c.status === "confirmed")).toBe(true);
    expect(r.cards[1]).toMatchObject({ time_on: "08:00" });
  });
  it("漏讀某行（只一個引擎有）＝review 行；低信心行＝review；單票行唔准丟（誤讀都出 review 卡，姓名放 name_candidates）", async () => {
    const lop = [R[0]!, row(2, "測試乙", "6012345", "08:00", "17:05", { confidence: "low" })];
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet([...lop, R[2]!]), deepseek: sheet(lop), claude: sheet(lop) }) });
    expect(r.cards.map((c) => [c.name_zh, c.status, c.reasons.join(",")])).toEqual([
      ["測試甲", "confirmed", ""],
      ["測試乙", "review", "row_low_confidence"],
      ["測試丙", "review", "card_disputed"],
    ]);
    const mis = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet([R[0]!, row(2, "測試乙", "6012345", "08:00", "17:05")]), deepseek: sheet([R[0]!, row(2, "測試己", "6012345", "08:00", "17:05")]), claude: sheet([R[0]!, row(2, "測試乙", "6012345", "08:00", "17:05")]) }) });
    // 單票誤讀行：行號可信（三個引擎行數一致）→ 標 row_misread_suspect，但**唔丟**，出 review 卡（姓名放 name_candidates）
    expect(mis.cards.map((c) => [c.name_zh, c.status])).toEqual([["測試甲", "confirmed"], ["測試乙", "confirmed"], ["測試己", "review"]]);
    expect(mis.cards[2]).toMatchObject({ name_candidates: ["測試己"], reasons: expect.arrayContaining(["row_misread_suspect"]) });
  });
  it("M1 probe：一個引擎漏讀一行並重新編號（行號錯位）→ 漏嗰個人唔准消失，出 review 卡（引擎次序倒轉結果一樣）", async () => {
    const q = sheet([row(1, "測試甲", "6012345", "08:00", "17:00"), row(2, "測試丙", "6012347", "08:00", "17:00")]); // 漏乙，丙變 2
    const h = sheet([row(1, "測試甲", "6012345", "08:00", "17:00"), row(2, "測試乙", "6012346", "08:00", "17:00"), row(3, "測試丙", "6012347", "08:00", "17:00")]);
    for (const [a, b] of [[q, h], [h, q]] as const) {
      const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: a, deepseek: b, claude: sheet([]) }) });
      const names = r.cards.map((c) => c.name_zh);
      expect(names).toContain("測試乙");
      expect(r.cards.find((c) => c.name_zh === "測試乙")!.status).toBe("review");
    }
  });
  it("所有引擎都失敗 → unreadable", async () => {
    const dead: EngineOutcome = { ok: false, error: "failed", usage: null, reason: "api_error_500" };
    const r = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet(R), deepseek: dead, claude: dead }) });
    expect(r.kind).toBe("cards"); // 單個引擎讀到 → 全部 review（單票）
    expect(r.cards.every((c) => c.status === "review")).toBe(true);
    const none = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet([]), deepseek: sheet([]), claude: sheet([]) }) });
    expect(none.kind).toBe("unreadable");
  });
});

describe("resolve：每行獨立", () => {
  const S1 = "site-1";
  const TS = new Date("2026-10-19T10:00:00Z"); // HK 2026-10-19 18:00
  const guards = [
    { id: "g1", nameZh: "測試甲", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
    { id: "g2", nameZh: "測試乙", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
    { id: "g3", nameZh: "測試丙", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
  ];
  const index = buildGuardMatchIndex({ guards, staffNumbers: [{ number: "U90001", guardId: "g1", status: "current" }], phones: [] });
  const types: ShiftTypeLite[] = [{ id: "t-d", siteId: S1, code: "D", label: "日更", startHour: 8 }, { id: "t-n", siteId: S1, code: "N", label: "夜更", startHour: 20 }];
  const repo: ResolveRepo = { shiftTypes: async () => types, recentGuardIdsAtSite: async () => new Set(["g1", "g2", "g3"]), recentGuardIdsOfBroker: async () => new Set(), existing: async () => [], headcount: async () => ({ required: null, current: 0 }), quota: async () => null, monthLocked: async () => false };
  const ctx: ResolveContext = { ts: TS, group: { id: "grp", kind: "site", siteId: S1, brokerId: null, shiftWordMap: {}, autoWrite: true }, senderGuardId: null, senderTelNorm: null, sites: [{ id: S1, canonicalName: "測試盤", aliases: [] }], index, repo };
  const deps: CardDeps = { scheduled: async () => [], recentSites: async () => new Map() };

  it("一張表 N 行 → N 條記錄：U 格式工號用工號卡、Wilson 編號用姓名（範圍內）、時間定更、每行日期；低信心行出題", async () => {
    const res = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet([row(1, "測試甲", "U90001", "08:00", "20:00"), row(2, "測試乙", "6012345", "20:05", null, { date: "2026-10-18" }), row(3, "測試丙", null, "08:10", null, { confidence: "low" })]), deepseek: sheet([row(1, "測試甲", "U90001", "08:00", "20:00"), row(2, "測試乙", "6012345", "20:05", null, { date: "2026-10-18" }), row(3, "測試丙", null, "08:10", null, { confidence: "low" })]) }) });
    const rs = await resolveCardPhoto({ ctx, input: { kind: "photo", photo: res }, mediaId: "m1", deps });
    expect(rs).toHaveLength(3);
    expect(rs[0]).toMatchObject({ guardId: "g1", workDate: "2026-10-19", shiftTypeId: "t-d", routed: "auto_write" });
    expect(rs[0]!.resolution.basis.person).toBe("card_staff_no");
    expect(rs[1]).toMatchObject({ guardId: "g2", workDate: "2026-10-18", shiftTypeId: "t-n", routed: "auto_write" }); // 前一日夜更：每行自己嘅日期
    expect(rs[1]!.resolution.basis.person).toBe("card_name_in_scope");
    expect(rs[1]!.src?.card).toMatchObject({ wilson_no: "6012345", row_no: 2, doc_type: "attendance_sheet", total: 3 });
    expect(rs[2]).toMatchObject({ guardId: "g3", routed: "triage" });
    expect(rs[2]!.resolution.reasons).toEqual(expect.arrayContaining(["row_low_confidence"]));
  });
  it("同一人同日喺表入面出現兩次 → 合成一行（唔重複）；日期喺窗口外 → date_out_of_range 出題", async () => {
    const R2 = [row(1, "測試甲", "U90001", "08:00"), row(2, "測試甲", "U90001", "08:05"), row(3, "測試乙", null, "08:00", null, { date: "2026-08-01" })];
    const res = await readCardPhoto(BYTES, { strategy: "S1", engines: engs({ tesseract: sheet(R2), deepseek: sheet(R2) }) });
    const rs = await resolveCardPhoto({ ctx, input: { kind: "photo", photo: res }, mediaId: null, deps });
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ guardId: "g1", routed: "auto_write" });
    expect(rs[1]!.resolution.reasons).toContain("date_out_of_range");
    expect(rs[1]!.routed).toBe("triage");
  });
});

describe("bench：逐行 truth／recall／precision", () => {
  it("parseTruthDetail／scoreRows／scoreSheet", () => {
    const t = parseTruthDetail("file,staff_nos,rows\nsheet1.jpg,,測試甲~U90001|測試乙~6012345|測試丙\ncard1.jpg,U92345,\n");
    expect(t.get("sheet1.jpg")!.rows).toEqual([{ name: "測試甲", staff_no: "U90001" }, { name: "測試乙", staff_no: "6012345" }, { name: "測試丙", staff_no: null }]);
    expect(t.get("card1.jpg")!.nos.has("U92345")).toBe(true);
    const truth = t.get("sheet1.jpg")!.rows;
    expect(scoreRows([{ name: "測試甲", staff_no_raw: "u 90001" }, { name: "測試乙", staff_no_raw: "6012346" }, { name: "測試丙", staff_no_raw: null }], truth)).toEqual({ matched: 2, produced: 3, truth: 3 });
    expect(scoreSheet({ matched: 3, produced: 3, truth: 3 })).toBe("exact");
    expect(scoreSheet({ matched: 2, produced: 2, truth: 3 })).toBe("review");
    expect(scoreSheet({ matched: 2, produced: 3, truth: 3 })).toBe("wrong");
    expect(scoreSheet({ matched: 0, produced: 0, truth: 3 })).toBe("unreadable");
  });
  it("runBench：多人表引擎 row recall／precision；策略只計 confirmed 行，review 行另計；輸出無姓名／工號", async () => {
    const truth = [{ name: "測試甲", staff_no: "U90001" }, { name: "測試乙", staff_no: null }, { name: "測試丙", staff_no: null }];
    const full = [row(1, "測試甲", "U90001", "08:00"), row(2, "測試乙", null, "08:00"), row(3, "測試丙", null, "08:00")];
    const rep = await runBench({
      photos: [{ id: "s1", truth: new Set(), rows: truth }],
      engines: [{ key: "tesseract", engine: fake("tesseract", sheet(full)) }, { key: "deepseek", engine: fake("deepseek", sheet(full.slice(0, 2))) }, { key: "claude", engine: fake("claude", sheet(full)) }],
      strategies: ["S1"],
      load: async () => BYTES,
    });
    expect(rep.engines.find((e) => e.engine === "tesseract")).toMatchObject({ exact: 1, row_recall: 1, row_precision: 1 });
    expect(rep.engines.find((e) => e.engine === "deepseek")).toMatchObject({ review: 1, row_recall: 0.67, row_precision: 1 });
    const s1 = rep.strategies.find((s) => s.strategy === "S1")!;
    expect(s1).toMatchObject({ row_recall: 1, row_precision: 1, rows_review: 0, exact: 1, arbiter_triggered: 1 });
    const txt = summaryLines(rep).join("\n");
    expect(txt).toMatch(/逐行 recall/);
    expect(txt).not.toMatch(/測試|U90001/);
  });
  it("S4：引擎冇出任何行 → row_precision 係 null（唔係 0）", async () => {
    const truth = [{ name: "測試甲", staff_no: "U90001" }, { name: "測試乙", staff_no: null }];
    const rep = await runBench({
      photos: [{ id: "s1", truth: new Set(), rows: truth }],
      engines: [{ key: "tesseract", engine: fake("tesseract", sheet([])) }, { key: "deepseek", engine: fake("deepseek", sheet([])) }, { key: "claude", engine: fake("claude", sheet([])) }],
      strategies: ["S1"],
      load: async () => BYTES,
    });
    expect(rep.engines.find((e) => e.engine === "tesseract")).toMatchObject({ row_recall: 0, row_precision: null });
    expect(summaryLines(rep).join("\n")).toMatch(/precision —/);
  });
});
