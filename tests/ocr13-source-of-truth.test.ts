// WP-OCR-1.3（老闆指示）：來源優先——身份證號碼、出生日期、中英文姓名以身份證為準；住址以住址證明為準（冇先用入職表）。
// 入職表手寫值只做交叉核對（cross），差異唔阻塞、唔改值；每欄標示 source_of_truth。全部合成資料＋fake client。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { resetContinuationNonces, resetRefsCredits } from "@/lib/guards/ocr/continuation";
import { crossForOnboarding, tagSourceOfTruth } from "@/lib/guards/ocr/refs";
import { mergeDocFields } from "@/lib/guards/ocr/merge-docs";
import { CROSS_MSG_ADDRESS } from "@/lib/guards/ocr/review-state";
import type { FieldResult } from "@/lib/guards/ocr/normalize";
import type { OcrDocType, OcrFieldKey } from "@/lib/guards/ocr/config";
import { setVisionClientForTests, type VisionClient, type VisionRequest } from "@/lib/guards/ocr/vision-client";
import { POST as ocrRoute } from "@/app/api/guards/ocr/read/route";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const fr = (over: Partial<FieldResult> & Pick<FieldResult, "status" | "value">): FieldResult => ({ candidates: [], candidates_ranked: [], ...over });
const PROOF_ADDR = "新界火炭示範街99號虛構大廈15樓A室";
const FORM_ADDR = "新界火炭示範街98號虛構大廈15樓A室";

describe("crossForOnboarding：地址對住址證明（against address_proof，只做提示）", () => {
  it("match／differs／unreadable；唔會出現喺 id 側（id_cross 只有姓名／HKID／出生日期）", () => {
    const refs = { address: PROOF_ADDR };
    expect(crossForOnboarding(refs, { address: fr({ status: "confirmed", value: PROOF_ADDR }) }).form.address).toEqual({ against: "address_proof", result: "match" });
    expect(crossForOnboarding(refs, { address: fr({ status: "confirmed", value: "新界火炭示範街98號虛構大廈15樓A室" }) }).form.address).toEqual({ against: "address_proof", result: "differs" });
    expect(crossForOnboarding(refs, { address: fr({ status: "review", value: PROOF_ADDR, reason: "reads_differ" }) }).form.address!.result).toBe("unreadable");
    expect(crossForOnboarding(refs, { address: fr({ status: "missing", value: "" }) }).form.address!.result).toBe("unreadable");
    expect(crossForOnboarding(refs, { address: fr({ status: "confirmed", value: PROOF_ADDR, arbiter: "agree_a" }) }).form.address!.result).toBe("unreadable");
    expect(crossForOnboarding(refs, { address: fr({ status: "confirmed", value: FORM_ADDR }) }).id).toEqual({});
    // 冇住址證明 refs＝冇地址 cross
    expect(crossForOnboarding({}, { address: fr({ status: "confirmed", value: FORM_ADDR }) }).form.address).toBeUndefined();
  });
  it("地址 cross 地址大小寫／逗號空白唔同都當 match（canon）", () => {
    const o = crossForOnboarding({ address: "Flat A, 15/F, Demo Building" }, { address: fr({ status: "confirmed", value: "flat a 15/f demo building" }) });
    expect(o.form.address!.result).toBe("match");
  });
  it("CROSS_MSG_ADDRESS：differs 係『已以住址證明為準』", () => {
    expect(CROSS_MSG_ADDRESS.differs).toBe("入職表手寫地址同住址證明唔同，已以住址證明為準");
    expect(CROSS_MSG_ADDRESS.match).toContain("✓");
  });
});

describe("tagSourceOfTruth：每欄標示最終採用邊份文件（additive，唔改值）", () => {
  const f = (v: string) => fr({ status: "confirmed", value: v });
  it("身份證欄＝id_card；住址證明＝address_proof；入職表：姓名／HKID／出生日期＝id_card、電話＝onboarding_form、地址按有冇住址證明", () => {
    const id = { name_zh: f("測試甲"), hkid: f("Z900001(2)"), name_en: f("TEST ALPHA") };
    tagSourceOfTruth("id_card", id);
    expect(Object.values(id).map((x) => x.source_of_truth)).toEqual(["id_card", "id_card", "id_card"]);
    const ap = { address: f(PROOF_ADDR) };
    tagSourceOfTruth("address_proof", ap);
    expect(ap.address.source_of_truth).toBe("address_proof");
    const form = { phone: f("90001111"), name_zh: f("測試乙"), hkid: f("Z900002(0)"), dob: f("1991-01-01"), address: f(FORM_ADDR) };
    tagSourceOfTruth("onboarding_form", form, true);
    expect(form.phone.source_of_truth).toBe("onboarding_form");
    expect([form.name_zh, form.hkid, form.dob].map((x) => x.source_of_truth)).toEqual(["id_card", "id_card", "id_card"]);
    expect(form.address.source_of_truth).toBe("address_proof");
    expect(form.hkid.value).toBe("Z900002(0)"); // 只標示，唔改值
    tagSourceOfTruth("onboarding_form", form, false);
    expect(form.address.source_of_truth).toBe("onboarding_form");
  });
});

type Doc = { type: OcrDocType; fields: Partial<Record<OcrFieldKey, FieldResult & { cross?: { against: string; result: "match" | "differs" | "unreadable" } }>> };
const docs = (...ds: Doc[]) => new Map(ds.map((d) => [d.type, d]));

describe("mergeDocFields：手寫值絕不覆蓋證件／住址證明值", () => {
  const idDoc: Doc = {
    type: "id_card",
    fields: {
      name_zh: fr({ status: "confirmed", value: "測試甲", cross: { against: "onboarding_form", result: "differs" } } as never),
      hkid: fr({ status: "confirmed", value: "Z900001(2)", cross: { against: "onboarding_form", result: "differs" } } as never),
      dob: fr({ status: "confirmed", value: "1990-01-15" }),
      name_en: fr({ status: "confirmed", value: "TEST ALPHA" }),
    },
  };
  const formDoc: Doc = {
    type: "onboarding_form",
    fields: {
      phone: fr({ status: "confirmed", value: "90001111" }),
      name_zh: fr({ status: "confirmed", value: "測試乙" }),
      hkid: fr({ status: "confirmed", value: "Z900002(0)" }),
      dob: fr({ status: "confirmed", value: "1991-02-03" }),
      address: fr({ status: "confirmed", value: FORM_ADDR }),
    },
  };
  it("身份證 confirmed 值＋入職表 differs → 最終用身份證值；手寫值只入 formValue（唯讀）；cross 照帶", () => {
    const { picks } = mergeDocFields(docs(idDoc, formDoc));
    expect(picks.name_zh).toMatchObject({ doc: "id_card", cross: "differs", formValue: "測試乙" });
    expect(picks.name_zh!.result.value).toBe("測試甲");
    expect(picks.hkid!.result.value).toBe("Z900001(2)");
    expect(picks.hkid!.formValue).toBe("Z900002(0)");
    // 冇 cross（舊 server）→ 唔顯示手寫值，但絕對唔用手寫值
    const old = mergeDocFields(docs({ type: "id_card", fields: { hkid: fr({ status: "confirmed", value: "Z900001(2)" }) } }, formDoc));
    expect(old.picks.hkid!.result.value).toBe("Z900001(2)");
    expect(old.picks.hkid!.formValue).toBeUndefined();
    // 身份證冇讀到（missing）而入職表有值：欄位照身份證（missing），唔會借用手寫值
    const miss = mergeDocFields(docs({ type: "id_card", fields: { hkid: fr({ status: "missing", value: "" }) } }, formDoc));
    expect(miss.picks.hkid!.result.value).toBe("");
    expect(miss.picks.hkid!.doc).toBe("id_card");
    // 電話只有入職表
    expect(picks.phone).toMatchObject({ doc: "onboarding_form" });
  });
  it("住址證明有 confirmed 或 review 值 → 用佢；入職表地址 differs 只做 cross（伺服器算或者 client 用同一純函數補算）", () => {
    const proofC: Doc = { type: "address_proof", fields: { address: fr({ status: "confirmed", value: PROOF_ADDR }) } };
    const withServerCross = mergeDocFields(docs(idDoc, proofC, { ...formDoc, fields: { ...formDoc.fields, address: fr({ status: "confirmed", value: FORM_ADDR, cross: { against: "address_proof", result: "differs" } } as never) } }));
    expect(withServerCross.addrFrom).toBe("address_proof");
    expect(withServerCross.picks.address).toMatchObject({ doc: "address_proof", cross: "differs", formValue: FORM_ADDR });
    expect(withServerCross.picks.address!.result.value).toBe(PROOF_ADDR);
    // review 住址證明（伺服器冇 refs，冇 cross）→ client 補算
    const proofR: Doc = { type: "address_proof", fields: { address: fr({ status: "review", value: PROOF_ADDR, reason: "reads_differ", candidates: [PROOF_ADDR, "別個地址"] }) } };
    const m = mergeDocFields(docs(idDoc, proofR, formDoc));
    expect(m.addrFrom).toBe("address_proof");
    expect(m.picks.address!.result.value).toBe(PROOF_ADDR);
    expect(m.picks.address!.cross).toBe("differs");
    // 入職表地址相同 → match
    const same = mergeDocFields(docs(idDoc, proofR, { ...formDoc, fields: { ...formDoc.fields, address: fr({ status: "confirmed", value: PROOF_ADDR }) } }));
    expect(same.picks.address!.cross).toBe("match");
    // 入職表地址 review → unreadable（唔當一致）
    const rev = mergeDocFields(docs(idDoc, proofC, { ...formDoc, fields: { ...formDoc.fields, address: fr({ status: "review", value: PROOF_ADDR, reason: "reads_differ" }) } }));
    expect(rev.picks.address!.cross).toBe("unreadable");
  });
  it("冇住址證明（或讀唔到）先用入職表手寫地址；兩份都冇＝冇地址", () => {
    expect(mergeDocFields(docs(idDoc, formDoc)).picks.address).toMatchObject({ doc: "onboarding_form" });
    expect(mergeDocFields(docs(idDoc, formDoc)).addrFrom).toBe("onboarding_form");
    const proofMissing: Doc = { type: "address_proof", fields: { address: fr({ status: "missing", value: "" }) } };
    const m = mergeDocFields(docs(idDoc, proofMissing, formDoc));
    expect(m.addrFrom).toBe("onboarding_form");
    expect(m.picks.address!.result.value).toBe(FORM_ADDR);
    expect(mergeDocFields(docs(idDoc)).addrFrom).toBeNull();
    // 住址證明 missing 而且入職表地址都 missing → 用住址證明（missing），唔借用
    const both = mergeDocFields(docs(idDoc, proofMissing, { ...formDoc, fields: { address: fr({ status: "missing", value: "" }) } }));
    expect(both.addrFrom).toBe("address_proof");
  });
});

// ---------- 路由：source_of_truth ＋ 地址 cross ----------
type Spec = Record<string, unknown>;
const obj = (value: string) => ({ value, confidence: "high", reason: null, alternatives: [] });
function fake(answers: { id?: { a?: Spec; b?: Spec }; proof?: { a?: Spec; b?: Spec }; form?: { a?: Spec; b?: Spec } }, calls: VisionRequest[] = []): VisionClient {
  return {
    model: "fake-claude",
    provider: "claude",
    async complete(req) {
      calls.push(req);
      const isB = req.userText.includes("overlapping") || req.userText.includes("tight crops");
      const f = req.fields ?? [];
      const doc = f.includes("phone") ? answers.form : f.includes("name_en") ? answers.id : answers.proof;
      return { text: JSON.stringify((isB ? doc?.b : doc?.a) ?? {}), promptTokens: 1, completionTokens: 1 };
    },
  };
}
const BOX = (y: number) => ({ x: 0.1, y, w: 0.4, h: 0.04 });
const idA = { name_zh: obj("測試甲"), name_en: obj("TEST ALPHA"), hkid: obj("Z900001(2)"), dob: obj("15-01-1990"), sex: obj("M") };
const proofA = { address: obj(PROOF_ADDR) };
const formRead = { phone: obj("90001111"), address: obj(FORM_ADDR), name_zh: obj("測試乙"), hkid: obj("Z900002(0)"), dob: obj("03-02-1991") };
const formA = { ...formRead, field_boxes: { phone: BOX(0.5), address: { x: 0.1, y: 0.6, w: 0.8, h: 0.08 }, name_zh: BOX(0.1), hkid: BOX(0.18), dob: BOX(0.26) } };
const T4 = [IMG, IMG, IMG, IMG];

describe("POST /api/guards/ocr/read：source_of_truth／地址 cross／差異唔改值", () => {
  let owner: string;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  beforeEach(async () => {
    await clearAll();
    resetContinuationNonces();
    resetRefsCredits();
    const fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => {
    setVisionClientForTests(null);
    vi.restoreAllMocks();
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
  });
  const post = (body: unknown) => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify(body) }));
  const answers = { id: { a: idA, b: idA }, proof: { a: proofA, b: proofA }, form: { a: formA, b: formRead } };
  const crops = { kind: "field_crops", images: [IMG, IMG, IMG, IMG, IMG], field_of: ["phone", "address", "name_zh", "hkid", "dob"] };

  it("stage a 印刷文件：每欄 source_of_truth；入職表 stage b：差異欄 cross 照回傳、值唔變、姓名／HKID／出生日期標 id_card、地址（有住址證明 confirmed）標 address_proof＋cross", async () => {
    setVisionClientForTests(fake(answers));
    const a1 = await (await post({ stage: "a", documents: [{ type: "id_card", full: IMG, tiles: T4 }, { type: "address_proof", full: IMG, tiles: T4 }] })).json();
    const byType = Object.fromEntries(a1.documents.map((d: { type: string }) => [d.type, d]));
    for (const f of Object.values(byType.id_card.fields) as { source_of_truth: string }[]) expect(f.source_of_truth).toBe("id_card");
    expect(byType.address_proof.fields.address.source_of_truth).toBe("address_proof");
    expect(byType.id_card.fields.hkid.value).toBe("Z900001(2)");
    const a2 = await (await post({ stage: "a", refs_token: a1.refs_token, documents: [{ type: "onboarding_form", full: IMG }] })).json();
    const b = await (await post({ stage: "b", refs_token: a1.refs_token, documents: [{ type: "onboarding_form", continuation: a2.documents[0].continuation, full: IMG, images_b: crops }] })).json();
    const f = b.documents[0].fields;
    expect(f.hkid).toMatchObject({ value: "Z900002(0)", source_of_truth: "id_card", cross: { against: "id_card", result: "differs" } });
    expect(f.name_zh.source_of_truth).toBe("id_card");
    expect(f.dob.source_of_truth).toBe("id_card");
    expect(f.phone.source_of_truth).toBe("onboarding_form");
    expect(f.address).toMatchObject({ source_of_truth: "address_proof", cross: { against: "address_proof", result: "differs" } });
    // id_cross 只有三個證件欄（唔含地址）
    expect(Object.keys(b.id_cross).sort()).toEqual(["dob", "hkid", "name_zh"]);
    expect(b.id_cross.hkid).toEqual({ against: "onboarding_form", result: "differs" });
  });

  it("冇 refs（冇住址證明）：入職表地址標 onboarding_form，冇地址 cross；舊單次流程同一請求有住址證明＝標 address_proof", async () => {
    setVisionClientForTests(fake(answers));
    const a2 = await (await post({ stage: "a", documents: [{ type: "onboarding_form", full: IMG }] })).json();
    const b = await (await post({ stage: "b", documents: [{ type: "onboarding_form", continuation: a2.documents[0].continuation, full: IMG, images_b: crops }] })).json();
    expect(b.documents[0].fields.address.source_of_truth).toBe("onboarding_form");
    expect(b.documents[0].fields.address.cross).toBeUndefined();
    expect(b.documents[0].fields.hkid.source_of_truth).toBe("id_card");
    const legacy = await (await post({ documents: [{ type: "address_proof", full: IMG, tiles: T4 }, { type: "onboarding_form", full: IMG, tiles: T4 }] })).json();
    const l = Object.fromEntries(legacy.documents.map((d: { type: string }) => [d.type, d]));
    expect(l.address_proof.fields.address.source_of_truth).toBe("address_proof");
    expect(l.onboarding_form.fields.address.source_of_truth).toBe("address_proof");
    expect(l.onboarding_form.fields.phone.source_of_truth).toBe("onboarding_form");
  });
});
