// TE-4：重讀腳本嵌入身份證副本流程——倒轉卡偵測／轉正裁切、印刷佐證、--dry fixture、伺服器 no_id_card 建議套用。全部合成、無 PII、唔打 API。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { run, parseArgs } from "../scripts/staff-import/19-triage-reread";
import { applyCorroboration, cardKeyHash, cardNamesConflict, looseEnglishNameMatch, markCardNameConflict, cardRect, corroborate, cropCardToPng, padCardBox, printedOnlyProposal, scanForCard, type CardDeps } from "../scripts/staff-import/lib/card-reread";
import { detectEmbeddedCards, rotateLines } from "../scripts/staff-import/lib/triage-evidence-core";
import { hkidCheckDigitValid } from "../scripts/staff-import/lib/hkid";
import { summaryLines, type RereadProposal } from "../scripts/staff-import/lib/triage-reread-core";
import { proposalsBodySchema, planForQuestion, type ProposalField } from "@/lib/triage/proposals";

const sh = promisify(execFile);
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";
const hasMagick = await sh(MAGICK, ["-version"]).then(() => true, () => false);
const NOW = new Date("2026-10-18T00:00:00Z");
const A = { ...parseArgs(["--dry"]) };

describe("dry fixture：倒轉嵌入卡 → 轉正 → fake OCR → proposal", () => {
  it("四個新個案：印刷一致 high／二階段 medium／印刷唔一致 low＋conflict／冇卡淨印刷 low；summary 計數；schema 通過；console 冇值", async () => {
    const r = await run(A, NOW);
    const by = (n: number) => r.proposals.filter((p) => p.person_key === `dry-person-${n}`);
    const sig = (n: number) => by(n).map((p) => `${p.field}:${p.confidence}:${(p.flags ?? []).join("+")}`).sort();
    // 7：卡（倒轉，第一階段）＋證書印刷一致 → 四欄 high，printed_corroborated
    expect(sig(7)).toEqual(["dateOfBirth:high:embedded_card+printed_corroborated", "hkid:high:embedded_card+printed_corroborated", "nameEn:high:embedded_card+printed_corroborated", "nameZh:high:embedded_card+printed_corroborated"]);
    // 8：卡只有二階段先讀到、冇印刷 → TE-11.1：卡兩讀一致即 high（唔需要印刷佐證／入職表交叉）
    expect(sig(8)).toEqual(["dateOfBirth:high:embedded_card", "hkid:high:embedded_card", "nameEn:high:embedded_card", "nameZh:high:embedded_card"]);
    // 9：印刷同卡唔一致 → 全部 low＋printed_card_conflict
    expect(sig(9).every((x) => x.endsWith(":low:embedded_card+printed_card_conflict"))).toBe(true);
    expect(sig(9)).toHaveLength(4);
    // 11：卡姓名同包內姓名唔一致 → 全 low＋card_name_conflict（就算冇印刷）
    expect(sig(11)).toHaveLength(4);
    expect(sig(11).every((x) => x.includes(":low:embedded_card+card_name_conflict"))).toBe(true);
    // 10：冇卡、只有印刷 → 淨 hkid low printed_only
    expect(sig(10)).toEqual(["hkid:low:printed_only"]);
    for (const p of r.proposals.filter((x) => x.field === "hkid")) expect(hkidCheckDigitValid(p.value)).toBe(true);
    expect(r.summary).toMatchObject({ embedded_cards_found: 4, embedded_second_stage_found: 1, card_name_conflict: 1, card_printed_corroborated: 1, card_printed_conflict: 1, printed_only_review: 1, persons_failed: 0 });
    expect(proposalsBodySchema.safeParse({ version: 1, summary: r.summary, proposals: r.proposals }).success).toBe(true);
    expect(summaryLines(r.summary).join("\n")).not.toMatch(/測試|Z90000|A12345|火炭/);
  });
  it("--only-missing-hkid／--only-key／--no-embedded", async () => {
    const m = await run({ ...A, onlyMissingHkid: true }, NOW);
    expect(m.summary.persons_processed + m.summary.persons_failed + m.summary.persons_no_docs + m.summary.printed_only_review).toBeGreaterThan(0);
    expect(new Set(m.proposals.map((p) => p.person_key))).toEqual(new Set(["dry-person-7", "dry-person-8", "dry-person-9", "dry-person-10", "dry-person-11"]));
    const k = await run({ ...A, onlyKey: "dry-person-8" }, NOW);
    expect(new Set(k.proposals.map((p) => p.person_key))).toEqual(new Set(["dry-person-8"]));
    const n = await run({ ...A, noEmbedded: true, onlyMissingHkid: true }, NOW);
    expect(n.proposals).toEqual([]);
    expect(parseArgs(["--only-missing-hkid", "--no-embedded", "--vision-bin", "x", "--ocr-dir", "d"])).toMatchObject({ onlyMissingHkid: true, noEmbedded: true, visionBin: "x", ocrDir: "d" });
  });
});

describe("scanForCard／幾何", () => {
  const L = (t: string, x: number, y: number, w: number, h = 0.012) => ({ t, c: 0.9, x, y, w, h });
  const page = [L("許可證編號 PERMIT NO. S-123456-7", 0.08, 0.85, 0.4), L("TESTER, Alpha", 0.53, 0.215, 0.14), L("測試甲", 0.53, 0.2, 0.06), L("出生日期 Date of Birth", 0.53, 0.185, 0.16), L("15-01-1990", 0.55, 0.17, 0.1), L("簽發日期 Date of Issue", 0.53, 0.15, 0.15), L("Z900001(2)", 0.72, 0.12, 0.08, 0.016)];
  it("倒轉 180° 嘅頁：detectEmbeddedCards 回 rot 180，卡區轉正後喺右下；卡內號碼唔計印刷", async () => {
    const inv = rotateLines(page, 180);
    const det = detectEmbeddedCards(inv, 210 / 297)!;
    expect(det.rot).toBe(180);
    expect(det.cards[0]!.box.x1).toBeGreaterThan(0.7);
    expect(det.cards[0]!.box.y1).toBeLessThan(0.4);
    const deps: CardDeps = { lines: async () => inv };
    const s = await scanForCard([{ docId: "d", page: 1 }], deps);
    expect(s.card).toMatchObject({ rot: 180, stage: "first" });
    expect(s.printed).toEqual([]);
  });
  it("第一階段冇卡 → 二階段（只有隱藏行）搵到；二階段頁數計數", async () => {
    const head = page.slice(0, 1);
    const deps: CardDeps = { lines: async () => head, secondStage: async () => ({ lines: [...head, ...page.slice(1)], aspect: 210 / 297 }) };
    const s = await scanForCard([{ docId: "d", page: 1 }], deps);
    expect(s.card?.stage).toBe("second");
    expect(s.secondStagePages).toBe(1);
  });
  it("cardRect／padCardBox：原點左下轉左上，夾返頁內", () => {
    expect(cardRect({ x0: 0.5, x1: 0.8, y0: 0.1, y1: 0.24 }, 1000, 2000)).toEqual({ x: 500, y: 1520, w: 300, h: 280 });
    const p = padCardBox({ x0: 0.02, x1: 0.5, y0: 0.9, y1: 0.99 });
    expect(p.x0).toBeGreaterThanOrEqual(0);
    expect(p.y1).toBeLessThanOrEqual(1);
  });
  it.skipIf(!hasMagick)("像素級：倒轉頁上嘅卡區 → 轉正裁出（長邊 ≤1600、闊>高、轉正後左上角係卡嘅標記色）", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te4t-"));
    try {
      // 1000x1400 白頁；卡區（正向 frame x 0.5–0.8、y 0.1–0.24 原點左下）塗紅，左上角再塗藍做方向標記；然後整頁倒轉 180°
      const up = path.join(dir, "up.png");
      await sh(MAGICK, ["-size", "1000x1400", "xc:white", "-fill", "red", "-draw", "rectangle 500,1064 800,1260", "-fill", "blue", "-draw", "rectangle 500,1064 560,1100", up]);
      const inv = path.join(dir, "inv.png");
      await sh(MAGICK, [up, "-rotate", "180", inv]);
      const out = path.join(dir, "card.png");
      const dim = await cropCardToPng(inv, 180, { x0: 0.5, x1: 0.8, y0: 0.1, y1: 0.24 }, out);
      expect(Math.max(dim.w, dim.h)).toBeLessThanOrEqual(1600);
      expect(dim.w).toBeGreaterThan(dim.h);
      const px = async (x: number, y: number) => (await sh(MAGICK, [out, "-format", `%[pixel:p{${x},${y}}]`, "info:"])).stdout.trim();
      // 加咗 10% 邊距，左上邊距係白；卡內偏左上（藍標記）喺轉正後仍係左上
      expect(await px(Math.round(dim.w * 0.12), Math.round(dim.h * 0.2))).toMatch(/blue|srgb\(0,0,255\)|#0000FF/i);
      expect(await px(Math.round(dim.w * 0.7), Math.round(dim.h * 0.7))).toMatch(/red|srgb\(255,0,0\)|#FF0000/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("印刷佐證規則", () => {
  const P = (field: RereadProposal["field"], value: string): RereadProposal => ({ person_key: "k", field, value, basis: "two_reads", doc: "id_card", confidence: "medium", match: { hkid: null, staff_numbers: ["U1"] } });
  it("一致→high；唔一致→low＋conflict；冇印刷→不變；卡冇 hkid", () => {
    expect(corroborate("Z9000012", ["Z9000012", "A1234563"])).toBe("corroborated");
    expect(corroborate("Z9000012", ["A1234563"])).toBe("conflict");
    expect(corroborate("Z9000012", [])).toBe("no_printed");
    const a = applyCorroboration([P("hkid", "Z9000012"), P("nameZh", "測試甲")], ["A1234563"]);
    expect(a.state).toBe("conflict");
    expect(a.proposals.every((p) => p.confidence === "low" && p.flags?.includes("printed_card_conflict"))).toBe(true);
    expect(applyCorroboration([P("nameZh", "測試甲")], ["A1234563"]).state).toBe("no_card_hkid");
    expect(printedOnlyProposal("k", ["Z9000012"], { hkid: null, staff_numbers: [] })).toMatchObject({ confidence: "low", flags: ["printed_only"], field: "hkid" });
    expect(printedOnlyProposal("k", ["Z9000012", "A1234563"], { hkid: null, staff_numbers: [] })).toBeNull();
  });
});

describe("TE-4.1：整人一致性／S1 修正值唔升 high／N2 快取 key", () => {
  const P = (field: RereadProposal["field"], value: string): RereadProposal => ({ person_key: "k", field, value, basis: "two_reads", doc: "id_card", confidence: "medium", match: { hkid: null, staff_numbers: ["U1"] } });
  it("cardNamesConflict：中文 normZh 相等、英文 token 相同先一致；包內冇姓名唔比對", () => {
    expect(cardNamesConflict({ nameZh: "測試 甲" }, { nameZh: "測試甲" })).toBe(false);
    expect(cardNamesConflict({ nameZh: "測試乙" }, { nameZh: "測試甲" })).toBe(true);
    expect(cardNamesConflict({ nameEn: "TESTER ALPHA" }, { nameEn: "ALPHA, Tester" })).toBe(false);
    expect(cardNamesConflict({ nameEn: "OTHER PERSON" }, { nameEn: "TESTER ALPHA" })).toBe(true);
    expect(cardNamesConflict({}, { nameZh: "測試甲", nameEn: "TESTER" })).toBe(false);
    const m = markCardNameConflict([P("hkid", "Z9000012")]);
    expect(m[0]).toMatchObject({ confidence: "low", flags: ["card_name_conflict"] });
  });
  it("TE-4.2 S2：中文名兩邊一致→唔理英文名差異；英文接受縮寫／連寫，姓氏要相同", () => {
    expect(cardNamesConflict({ nameZh: "測試甲", nameEn: "OTHER NAME" }, { nameZh: "測試甲", nameEn: "TESTER ALPHA" })).toBe(false);
    expect(cardNamesConflict({ nameZh: "測試甲" }, { nameZh: "測試乙" })).toBe(true);
    expect(looseEnglishNameMatch("CHAN, Tai Man", "CHAN T M")).toBe(true);
    expect(looseEnglishNameMatch("CHAN T M", "CHAN TAI MAN")).toBe(true);
    expect(looseEnglishNameMatch("CHAN TAIMAN", "CHAN TAI MAN")).toBe(true);
    expect(looseEnglishNameMatch("TAI MAN CHAN", "Chan, Tai-Man")).toBe(true);
    expect(looseEnglishNameMatch("WONG TAI MAN", "CHAN TAI MAN")).toBe(false); // 姓氏唔同
    expect(looseEnglishNameMatch("CHAN, Tai Man", "WONG T M")).toBe(false);
    expect(looseEnglishNameMatch("CHAN TAI MAN", "CHAN TAI")).toBe(false); // token 數唔同
    expect(looseEnglishNameMatch("CHAN TAI MAN", "CHAN SIU MING")).toBe(false);
    expect(cardNamesConflict({ nameEn: "CHAN T M" }, { nameEn: "CHAN TAI MAN" })).toBe(false);
  });
  it("TE-4.2 S1：卡出生日期同包內已確認出生日期唔同 → 唔一致；相同／包內未確認唔比", () => {
    expect(cardNamesConflict({ dobConfirmed: "1990-01-15" }, { dob: "1990-01-16" })).toBe(true);
    expect(cardNamesConflict({ dobConfirmed: "1990-01-15" }, { dob: "1990-01-15" })).toBe(false);
    expect(cardNamesConflict({}, { dob: "1990-01-16" })).toBe(false);
  });
  it("S1：修正過嘅印刷號同卡一致唔升 high（no_printed）；同卡唔同值 → conflict；未修正一致先 corroborated", () => {
    expect(corroborate("Z9000012", [], ["Z9000012"])).toBe("no_printed");
    expect(corroborate("Z9000012", [], ["A1234563"])).toBe("conflict");
    expect(corroborate("Z9000012", ["Z9000012"], ["A1234563"])).toBe("corroborated");
    expect(applyCorroboration([P("hkid", "Z9000012")], [], ["Z9000012"]).proposals[0]!.confidence).toBe("medium");
  });
  it("N2：cardKeyHash 隨 box／rot／stage 改變", () => {
    const b = { x0: 0.5, y0: 0.1, x1: 0.8, y1: 0.24 };
    const h = cardKeyHash({ rot: 180, box: b, stage: "first" });
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(cardKeyHash({ rot: 0, box: b, stage: "first" })).not.toBe(h);
    expect(cardKeyHash({ rot: 180, box: { ...b, x0: 0.51 }, stage: "first" })).not.toBe(h);
    expect(cardKeyHash({ rot: 180, box: b, stage: "second" })).not.toBe(h);
  });
});

describe("伺服器：no_id_card 建議", () => {
  const q = (opts = ["enter_hkid", "skip"]) => ({ kind: "no_id_card", optionsJson: opts.map((id) => ({ id })), evidenceJson: { person: {} } }) as never;
  const props = (o: Record<string, string>) => new Map(Object.entries(o)) as ReadonlyMap<ProposalField, string>;
  it("hkid（checksum 通過）＋姓名＋出生日期 → enter_hkid 帶 extra；hkid 唔合法／冇 enter_hkid 選項 → skip；冇 hkid → none", () => {
    const ok = planForQuestion(q(), props({ hkid: "Z9000012", nameZh: "測試甲", nameEn: "TESTER ALPHA", dateOfBirth: "1990-01-15" }));
    expect(ok).toMatchObject({ type: "answer", answer: { option: "enter_hkid", value: "Z9000012", extra: { name_zh: "測試甲", name_en: "TESTER ALPHA", dob: "1990-01-15" } } });
    expect(planForQuestion(q(), props({ hkid: "Z9000019" }))).toMatchObject({ type: "skip", disp: "skipped_invalid" });
    expect(planForQuestion(q(["skip"]), props({ hkid: "Z9000012" }))).toMatchObject({ type: "skip" });
    expect(planForQuestion(q(), props({ nameZh: "測試甲" }))).toEqual({ type: "none" });
    const bad = planForQuestion(q(), props({ hkid: "Z9000012", dateOfBirth: "1990-02-30" }));
    expect(bad.type === "answer" && bad.answer.extra).toBeUndefined(); // 唔合法出生日期唔帶
  });
  it("TE-3 S1：包內姓名已確認 → 建議唔帶姓名 extra", () => {
    const confirmed = { kind: "no_id_card", optionsJson: [{ id: "enter_hkid" }], evidenceJson: { person: { nameZh: { value: "既有", status: "confirmed" }, nameEn: { value: null, status: "missing" } } } } as never;
    const r = planForQuestion(confirmed, props({ hkid: "Z9000012", nameZh: "測試甲", nameEn: "TESTER" }));
    expect(r).toMatchObject({ type: "answer", answer: { extra: { name_en: "TESTER" } } });
    expect(r.type === "answer" && r.answer.extra?.name_zh).toBeUndefined();
  });
  it("TE-4.2 S1：包內出生日期已確認 → 建議唔帶 extra.dob", () => {
    const withDob = { kind: "no_id_card", optionsJson: [{ id: "enter_hkid" }], evidenceJson: { person: { dateOfBirth: { value: "1990-05-06", status: "confirmed" } } } } as never;
    const r = planForQuestion(withDob, props({ hkid: "Z9000012", dateOfBirth: "1991-02-03", nameZh: "測試甲" }));
    expect(r.type === "answer" && r.answer.extra).toEqual({ name_zh: "測試甲" });
  });
});
