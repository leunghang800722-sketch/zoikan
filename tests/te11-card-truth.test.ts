// TE-11：身份證英文名兩行合併（extract／裁圖／Vision token 規則）、證件為準自動答（proposals）、import 規則 C、自動關閉自檢。全部合成。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractIdCard } from "../scripts/staff-import/lib/extract";
import { boxForRequest, type CropRequest } from "../scripts/staff-import/lib/triage-evidence-core";
import { cropRequest, drawSyntheticPage, verifyCrop, type VisionRunner } from "../scripts/staff-import/20-triage-evidence";
import { resolvePerson, type NameVision, type PersonDocIn } from "../scripts/staff-import/lib/person-fields";
import type { DocExtract } from "../scripts/staff-import/lib/aggregate";
import type { PhoneFinal } from "../scripts/staff-import/lib/phone";
import { auditAutoClose, summarizeAutoClose } from "../scripts/staff-import/lib/auto-close-audit";
import { dryData, run as runAutoClose, parseArgs as autoCloseArgs } from "../scripts/staff-import/23-auto-close-audit";
import { planForQuestion, type ProposalField, type ProposalMeta } from "@/lib/triage/proposals";
import type { OcrLine } from "../scripts/staff-import/lib/ocr";

const sh = promisify(execFile);
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";
const hasMagick = await sh(MAGICK, ["-version"]).then(() => true, () => false);
const A4 = 210 / 297;
const L = (t: string, x: number, y: number, w: number, h = 0.04): OcrLine => ({ t, c: 0.9, x, y, w, h });

/** 卡好細：英文名換行成兩行（第二行 gap 0.05 ≤1.3×行高 0.052；舊「below」規則 cy 差 >0.045 會漏） */
const twoLineCard = (second = "MAN KEI"): OcrLine[] => [
  L("香港永久性居民身份證", 0.12, 0.85, 0.34, 0.025),
  L("HONG KONG PERMANENT IDENTITY CARD", 0.12, 0.82, 0.44, 0.02),
  L("CHAN, TAI", 0.1, 0.7, 0.15),
  L(second, 0.1, 0.61, 0.12),
  L("測試甲", 0.1, 0.55, 0.12, 0.03),
  L("出生日期 Date of Birth", 0.1, 0.5, 0.24, 0.02),
  L("15-01-1990", 0.14, 0.47, 0.16, 0.02),
];

describe("A 身份證英文名兩行合併（extract）", () => {
  it("第二行（≤1.3×行高、左對齊、Title-case）接成一個值；evidence 兩行", () => {
    const r = extractIdCard(1, twoLineCard());
    expect(r.nameEn?.value).toBe("CHAN TAI MAN KEI");
    expect(r.nameEn?.evidence).toContain("MAN KEI");
    expect(r.nameEn?.flags).toBeUndefined();
  });
  it("唔係續行：出生日期 label／行距太遠／唔左對齊／小寫 token → 唔合併", () => {
    expect(extractIdCard(1, twoLineCard("Date of Birth")).nameEn?.value).toBe("CHAN TAI");
    const far = twoLineCard().map((l) => (l.t === "MAN KEI" ? { ...l, y: 0.55 } : l));
    expect(extractIdCard(1, far).nameEn?.value).toBe("CHAN TAI");
    const shifted = twoLineCard().map((l) => (l.t === "MAN KEI" ? { ...l, x: 0.3 } : l));
    expect(extractIdCard(1, shifted).nameEn?.value).toBe("CHAN TAI");
    expect(extractIdCard(1, twoLineCard("man kei")).nameEn?.value).toBe("CHAN TAI");
  });
});

describe("A 裁圖取兩行聯合 box；Vision token 規則", () => {
  const req = (): CropRequest => ({ field: "name_en", docKind: "id_card", priority: 1, doc: { type: "id_card", docId: "d", page: 1 } });
  it("name_en box 覆蓋兩行（y0 低過第二行底）", () => {
    const b = boxForRequest(req(), twoLineCard(), A4).box!;
    expect(b.y0).toBeLessThanOrEqual(0.61);
    expect(b.y1).toBeGreaterThanOrEqual(0.74);
  });
  it.skipIf(!hasMagick)("verifyCrop：讀數 token 數 < max(包內, 入職表) → name_truncated；夠 → 通過", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te11-"));
    try {
      const png = path.join(dir, "c.png");
      await sh(MAGICK, ["-size", "300x60", "xc:white", png]);
      const reading = (t: string): VisionRunner => async (paths) => paths.map(() => ({ lines: [{ t, c: 0.9, x: 0.1, y: 0.2, w: 0.5, h: 0.5 }] }));
      const exp = ["CHAN TAI", "CHAN TAI MAN KEI"]; // 包內 2 token、入職表 4 token
      expect(await verifyCrop(png, "name_en", exp, reading("CHAN, TAI MAN"), dir)).toMatchObject({ ok: false, reason: "name_truncated", missing: 1 });
      expect(await verifyCrop(png, "name_en", exp, reading("CHAN, TAI MAN KEI"), dir)).toMatchObject({ ok: true });
      expect(await verifyCrop(png, "name_en", ["CHAN TAI"], reading("CHAN, TAI"), dir)).toMatchObject({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(!hasMagick)("cropRequest：name_truncated → 向下延伸一行重驗一次；仍少 token → 跳過", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te11-"));
    try {
      const lines = twoLineCard().filter((l) => l.t !== "MAN KEI"); // OCR 漏咗第二行
      const png = path.join(dir, "p.png");
      await drawSyntheticPage({ doc: { type: "id_card", docId: "d", page: 1 }, lines, hidden: [L("MAN KEI", 0.1, 0.61, 0.12)] } as never, png);
      const heights: number[] = [];
      const hook = (okAt: number) => async (crop: string) => {
        heights.push(Number((await sh(MAGICK, [crop, "-format", "%h", "info:"])).stdout));
        return heights.length >= okAt ? ({ ok: true as const, score: 1, rotate: 0 as const }) : ({ ok: false as const, reason: "name_truncated" as const, score: 0.6, missing: 1 });
      };
      const r1 = await cropRequest(req(), png, lines, dir, undefined, hook(2));
      expect("bytes" in r1).toBe(true);
      expect(heights[1]!).toBeGreaterThan(heights[0]!);
      heights.length = 0;
      expect(await cropRequest(req(), png, lines, dir, undefined, hook(99))).toMatchObject({ reason: "name_truncated" });
      expect(heights).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("B 證件為準：planForQuestion（name_not_confirmed／hkid_not_confirmed）", () => {
  const q = (kind: string, opts: string[], person: object = {}) => ({ kind, optionsJson: opts.map((id) => ({ id })), evidenceJson: { person: { nameZh: { value: "舊名甲", status: "review" }, nameEn: { value: "OLD", status: "review" }, hkid: { value: "Z9000013", status: "review" }, ...person } } }) as never;
  const props = (o: Record<string, string>) => new Map(Object.entries(o)) as ReadonlyMap<ProposalField, string>;
  const high: ProposalMeta = { confidence: "high", basis: "two_reads", doc: "id_card" };
  const meta = (o: Record<string, Partial<ProposalMeta>>) => new Map(Object.entries(o).map(([k, v]) => [k, { ...high, ...v }])) as unknown as ReadonlyMap<ProposalField, ProposalMeta>;
  it("name_not_confirmed：卡 high 同包內唔一致 → enter_name（＋extra.name_en）；medium／low／衝突旗／arbiter → 照舊 skip；同包內一致 → use_package_name", () => {
    const opts = ["use_package_name", "enter_name", "skip"];
    const r = planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙", nameEn: "CHAN TAI MAN" }), meta({ nameZh: {}, nameEn: { confidence: "medium" } }));
    expect(r).toMatchObject({ type: "answer", answer: { option: "enter_name", value: "卡上名乙", extra: { name_en: "CHAN TAI MAN" } }, fields: ["nameZh", "nameEn"] });
    const noEn = planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙" }), meta({ nameZh: {} }));
    expect(noEn).toMatchObject({ type: "answer", answer: { option: "enter_name", value: "卡上名乙" } });
    expect(noEn.type === "answer" && noEn.answer.extra).toBeUndefined();
    for (const bad of [{ confidence: "medium" as const }, { confidence: "low" as const }, { basis: "arbiter" as const }, { doc: "onboarding_form" as const }, { flags: ["card_name_conflict"] }]) expect(planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙" }), meta({ nameZh: bad }))).toMatchObject({ type: "skip", disp: "skipped_value_mismatch" });
    expect(planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙" }))).toMatchObject({ type: "skip" }); // 冇 meta＝照舊
    // TE-11.1：入職表唔一致（form_differs）／印刷佐證一致只係資訊，唔阻擋
    for (const f of [["form_differs"], ["printed_corroborated"], ["embedded_card", "printed_corroborated", "form_differs"]]) expect(planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙" }), meta({ nameZh: { flags: f } }))).toMatchObject({ type: "answer", answer: { option: "enter_name" } });
    expect(planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "卡上名乙" }), meta({ nameZh: { flags: ["printed_card_conflict"] } }))).toMatchObject({ type: "skip" });
    expect(planForQuestion(q("name_not_confirmed", opts), props({ nameZh: "舊名甲" }), meta({ nameZh: {} }))).toMatchObject({ type: "answer", answer: { option: "use_package_name" } });
    // 包內英文名已確認 → 唔帶 extra.name_en（server 會 400）
    const en = planForQuestion(q("name_not_confirmed", opts, { nameEn: { value: "OLD", status: "confirmed" } }), props({ nameZh: "卡上名乙", nameEn: "CHAN" }), meta({ nameZh: {}, nameEn: {} }));
    expect(en.type === "answer" && en.answer.extra).toBeUndefined();
    // 冇 enter_name 選項 → skip
    expect(planForQuestion(q("name_not_confirmed", ["use_package_name", "skip"]), props({ nameZh: "卡上名乙" }), meta({ nameZh: {} }))).toMatchObject({ type: "skip" });
  });
  it("hkid_not_confirmed：卡 hkid checksum 過＋high 同包內唔同 → enter_hkid；checksum 唔過／medium → skip", () => {
    const opts = ["use_package_hkid", "enter_hkid", "skip"];
    expect(planForQuestion(q("hkid_not_confirmed", opts), props({ hkid: "Z900001(2)" }), meta({ hkid: {} }))).toMatchObject({ type: "answer", answer: { option: "enter_hkid", value: "Z9000012" } });
    expect(planForQuestion(q("hkid_not_confirmed", opts), props({ hkid: "Z9000019" }), meta({ hkid: {} }))).toMatchObject({ type: "skip" });
    expect(planForQuestion(q("hkid_not_confirmed", opts), props({ hkid: "Z9000012" }), meta({ hkid: { confidence: "medium" } }))).toMatchObject({ type: "skip" });
    expect(planForQuestion(q("hkid_not_confirmed", opts), props({ hkid: "Z9000013" }), meta({ hkid: {} }))).toMatchObject({ type: "answer", answer: { option: "use_package_hkid" } });
  });
});

describe("C import 規則：身份證兩讀一致即 confirmed（入職表唔一致只係資訊）；Vision 字數少過 OCR 唔 confirmed", () => {
  const ph = { value: null, status: "unresolved", candidates: [], reasons: [] } as unknown as PhoneFinal;
  const exOf = (zh: string | null, en: string | null, formEn: string | null): DocExtract =>
    ({
      docId: "d1", pageCount: 5, pages: [], hkid: { value: "A1234563", level: "high", conf: 0.9, page: 3, evidence: "x" }, hkidValid: true,
      nameZh: zh ? { value: zh, level: "medium", conf: 0.5, page: 3, evidence: "x" } : null,
      nameEn: en ? { value: en, level: "medium", conf: 0.5, page: 3, evidence: "x" } : null,
      dob: null, sex: null, address: null, addressRecipient: null, phone: null,
      aux: { formHkid: null, permitHkid: null, formAddress: null, formNameZh: null, formNameEn: formEn ? { value: formEn, level: "low", conf: 0.5, page: 7, evidence: "x" } : null }, flags: [], rescuedRot: null,
    }) as unknown as DocExtract;
  const V = (zh: string | null, en: string | null): NameVision => ({ docId: "d1", zh, en, legible: "clear" });
  const run = (o: { local: [string | null, string | null]; formEn?: string | null; v1: NameVision; v2: NameVision }) => {
    const d: PersonDocIn = { docId: "d1", ex: exOf(o.local[0], o.local[1], o.formEn ?? null), fileNameZh: null, phone: ph, listZh: [], listEn: [], listTels: [] };
    return resolvePerson({ key: "k", docs: [d], idDocId: "d1", addressDocId: null, nameVision: o.v1, nameVision2: o.v2, addrVision: null });
  };
  it("卡兩讀一致（英文名 3 token）＋入職表 formNameEn 4 token 唔一致 → 照 confirmed（source id_card），唔出題", () => {
    const r = run({ local: ["測試甲", "CHAN TAI MAN"], formEn: "CHAN TAI MAN KEI", v1: V("測試甲", "CHAN TAI MAN"), v2: V("測試甲", "CHAN TAI MAN") });
    expect(r.nameZh).toMatchObject({ status: "confirmed", source: "id_card" });
    expect(r.nameEn).toMatchObject({ status: "confirmed", source: "id_card" });
    expect(r.hkid.status).toBe("confirmed");
  });
  it("Vision 字數少過身份證頁 OCR（中文 3→2 字／英文 3→2 token）→ review＋reason（可能漏尾字／續行）", () => {
    const r = run({ local: ["測試甲", "CHAN TAI MAN"], v1: V("測試", "CHAN TAI"), v2: V("測試", "CHAN TAI") });
    expect(r.nameZh).toMatchObject({ status: "review" });
    expect(r.nameZh.reasons).toContain("nameZh_vision_short");
    expect(r.nameEn).toMatchObject({ status: "review" });
    expect(r.nameEn.reasons).toContain("nameEn_vision_short");
  });
});

describe("D 自檢（23-auto-close-audit）", () => {
  it("--dry 固定 fixture：按題型可關閉數；靠卡為準修正 2；輸出冇姓名／號碼", async () => {
    const r = await runAutoClose(autoCloseArgs(["--dry"]));
    expect(r.summary).toMatchObject({ persons_with_questions: 10, questions_total: 10, closable_total: 5, closable_via_card_truth: 3, blocked_by_form_conflict: 1, blocked_by_unproven: 1, questions: { name_not_confirmed: 7, hkid_not_confirmed: 1, field_review: 2 }, closable: { name_not_confirmed: 3, hkid_not_confirmed: 1, field_review: 1 } });
    const d = dryData();
    expect(summarizeAutoClose(auditAutoClose(d.persons, d.proposals))).toEqual(r.summary);
    expect(JSON.stringify(r)).not.toMatch(/測試|Z900001/);
  });
});
