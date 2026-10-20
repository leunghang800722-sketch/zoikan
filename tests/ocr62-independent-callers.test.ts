// OCR-6.2：OCR-6.1 嘅電話獨立來源接駁。stage b 伺服器端用身份證 HKID 配對已有保安員嘅 tel＋guard_phones；冇配對就 review（phone_no_independent_source）。
// 全部合成資料＋fake client。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { resetContinuationNonces, resetRefsCredits } from "@/lib/guards/ocr/continuation";
import { storedPhonesForHkid } from "@/lib/guards/ocr/stored-phones";
import { stripListPhoneCandidates } from "@/lib/guards/ocr/strip-list";
import { setVisionClientForTests, type VisionClient } from "@/lib/guards/ocr/vision-client";
import { POST as ocrRoute } from "@/app/api/guards/ocr/read/route";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const obj = (value: string) => ({ value, confidence: "high", reason: null, alternatives: [] });
const BOX = (y: number) => ({ x: 0.1, y, w: 0.4, h: 0.04 });
const T4 = [IMG, IMG, IMG, IMG];
const idA = { name_zh: obj("測試甲"), name_en: obj("TEST ALPHA"), hkid: obj("Z900001(2)"), dob: obj("15-01-1990"), sex: obj("M") };
function fake(phone: string): VisionClient {
  const formRead = { phone: obj(phone), address: obj("新界火炭示範街98號虛構大廈15樓A室"), name_zh: obj("測試乙"), hkid: obj("Z900001(2)"), dob: obj("15-01-1990") };
  const formA = { ...formRead, field_boxes: { phone: BOX(0.5), address: { x: 0.1, y: 0.6, w: 0.8, h: 0.08 }, name_zh: BOX(0.1), hkid: BOX(0.18), dob: BOX(0.26) } };
  return {
    model: "fake-claude",
    provider: "claude",
    async complete(req) {
      const f = req.fields ?? [];
      const isB = req.userText.includes("overlapping") || req.userText.includes("tight crops");
      const spec = f.includes("phone") ? (isB ? formRead : formA) : idA;
      return { text: JSON.stringify(spec), promptTokens: 1, completionTokens: 1 };
    },
  };
}
const crops = { kind: "field_crops", images: [IMG, IMG, IMG, IMG, IMG], field_of: ["phone", "address", "name_zh", "hkid", "dob"] };

describe("storedPhonesForHkid", () => {
  beforeEach(clearAll);
  it("HKID 配對（容許括號大小寫）→ tel＋guard_phones 去重；冇配對／冇 HKID → []", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "cash_casual", hkid: "Z900001(2)".replace(/[()]/g, "").toUpperCase(), tel: "90001111" } });
    await prisma.guardPhone.create({ data: { guardId: g.id, tel: "90001112" } });
    await prisma.guardPhone.create({ data: { guardId: g.id, tel: "90001111" } });
    expect((await storedPhonesForHkid("z900001(2)")).sort()).toEqual(["90001111", "90001112"]);
    expect(await storedPhonesForHkid("Z900009(0)")).toEqual([]);
    expect(await storedPhonesForHkid(null)).toEqual([]);
    expect(await storedPhonesForHkid("")).toEqual([]);
  });
});

describe("stripListPhoneCandidates：phone_differs_from_list 唔經 endpoint 洩露已存電話", () => {
  it("candidates 只剩同 OCR 值同號碼嗰啲；其他 reason 唔郁", () => {
    const r = { fields: { phone: { status: "review", value: "90001111", reason: "phone_differs_from_list", candidates: ["90001111", "90002222"], candidates_ranked: [{ value: "90001111" }, { value: "9000 2222" }] } } } as never;
    stripListPhoneCandidates(r);
    const p = (r as { fields: { phone: { candidates: string[]; candidates_ranked: { value: string }[] } } }).fields.phone;
    expect(p.candidates).toEqual(["90001111"]);
    expect(p.candidates_ranked.map((x) => x.value)).toEqual(["90001111"]);
  });
});

describe("POST /api/guards/ocr/read stage b：獨立來源接駁", () => {
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
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
  });
  const post = (body: unknown) => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify(body) }));
  async function flow(extra: Record<string, unknown> = {}) {
    const a1 = await (await post({ stage: "a", documents: [{ type: "id_card", full: IMG, tiles: T4 }] })).json();
    const a2 = await (await post({ stage: "a", refs_token: a1.refs_token, documents: [{ type: "onboarding_form", full: IMG }] })).json();
    const b = await (await post({ stage: "b", refs_token: a1.refs_token, ...extra, documents: [{ type: "onboarding_form", continuation: a2.documents[0].continuation, full: IMG, images_b: crops }] })).json();
    if (!b.documents) throw new Error(JSON.stringify(b));
    return b.documents[0].fields.phone as { status: string; value: string; reason?: string; candidates?: string[] };
  }

  it("HKID 配對到已有保安員、tel 一致 → confirmed（new-from-docs 有獨立來源）", async () => {
    setVisionClientForTests(fake("90001111"));
    await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "cash_casual", hkid: "Z9000012", tel: "9000 1111" } });
    expect(await flow()).toMatchObject({ status: "confirmed", value: "90001111" });
  });
  it("guard_phones 裏面嘅電話都算獨立來源", async () => {
    setVisionClientForTests(fake("90001113"));
    const g = await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "cash_casual", hkid: "Z9000012", tel: "90001111" } });
    await prisma.guardPhone.create({ data: { guardId: g.id, tel: "90001113" } });
    expect(await flow()).toMatchObject({ status: "confirmed", value: "90001113" });
  });
  it("冇配對到保安員 → review＋phone_no_independent_source（預填 OCR 值）", async () => {
    setVisionClientForTests(fake("90001111"));
    expect(await flow()).toMatchObject({ status: "review", value: "90001111", reason: "phone_no_independent_source" });
  });
  it("配對到但電話唔同 → review＋phone_differs_from_list，回應唔洩露已存電話", async () => {
    setVisionClientForTests(fake("90001111"));
    await prisma.guard.create({ data: { nameZh: "測試丙", employmentType: "cash_casual", hkid: "Z9000012", tel: "90007777" } });
    const p = await flow();
    expect(p).toMatchObject({ status: "review", value: "90001111", reason: "phone_differs_from_list" });
    expect(JSON.stringify(p)).not.toContain("90007777");
  });
  it("client 傳 independent_phones（舊流程）照用；冇傳＋冇配對＝review", async () => {
    setVisionClientForTests(fake("90001111"));
    expect(await flow({ independent_phones: ["90001111"] })).toMatchObject({ status: "confirmed" });
  });
});
