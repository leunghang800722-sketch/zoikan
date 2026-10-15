// WP-OCR-3：欄位級裁圖幾何（box sanity／padBox／鄰欄限制／最少 3%／後備）、continuation 簽名、兩段式讀（stage A／B）、
// POST /api/guards/ocr/read stage a／b、電話分格線候選、戶口位數、路徑 B 外擴。全部合成資料＋fake client，唔打外部 API。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { OCR_CROP_FIELDS, PAD_MIN_FRACTION, cropOutSize, padBox, planFieldCrops, sanitizeBox, sanitizeFieldBoxes, type NormBox } from "@/lib/guards/ocr/field-crops";
import { CONTINUATION_TTL_MS, signContinuation, verifyContinuation, resetContinuationNonces, type ContinuationPayload } from "@/lib/guards/ocr/continuation";
import { readStageA, readStageB, readDocument } from "@/lib/guards/ocr/read";
import { buildArbiterUserTextCrops, buildSystemPrompt, buildUserTextFieldCrops, buildUserTextFull } from "@/lib/guards/ocr/prompts";
import { ocrJsonSchema } from "@/lib/guards/ocr/claude-vision-client";
import { normalizeField, phoneGridlineCandidates } from "@/lib/guards/ocr/normalize";
import { reconcile } from "@/lib/guards/ocr/reconcile";
import { fieldReadSchema } from "@/lib/guards/ocr/field-read";
import { readTwoStage } from "@/lib/guards/ocr/two-stage";
import { setVisionClientForTests, type OcrProviderName, type VisionClient, type VisionRequest, type VisionResponse } from "@/lib/guards/ocr/vision-client";
import type { ReadClients } from "@/lib/guards/ocr/clients";
import { POST as ocrRoute } from "@/app/api/guards/ocr/read/route";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { main as evalMain, parseArgs as evalParseArgs } from "../scripts/staff-import/eval-ocr";
import { cropFields as nodeCropFields, prepareDocumentImages } from "../scripts/staff-import/lib/eval-ocr-images";
import { padAround, isLabelLine } from "../scripts/staff-import/lib/crop-pad";
import { locatePhoneBox } from "../scripts/staff-import/lib/phone-crop";
import { locateFormAddressBox } from "../scripts/staff-import/lib/form-address-crop";
import { acctDigitsReason, normAcct } from "../scripts/staff-import/lib/fields-ext";
import { HKICL_ACCT_DIGITS, acctDigitsCheck } from "../scripts/staff-import/lib/hkicl-digits";
import type { OcrLine } from "../scripts/staff-import/lib/ocr";

const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PHONE: NormBox = { x: 0.1, y: 0.3, w: 0.5, h: 0.05 };
const ADDR: NormBox = { x: 0.1, y: 0.4, w: 0.8, h: 0.08 };

describe("box sanity", () => {
  it("合格 box 保留；越界／面積／最小闊高／非數字 → null", () => {
    expect(sanitizeBox(PHONE)).toEqual(PHONE);
    expect(sanitizeBox({ x: -0.01, y: 0.1, w: 0.2, h: 0.1 })).toBeNull();
    expect(sanitizeBox({ x: 0.9, y: 0.1, w: 0.2, h: 0.1 })).toBeNull(); // x+w>1
    expect(sanitizeBox({ x: 0.1, y: 0.95, w: 0.2, h: 0.1 })).toBeNull(); // y+h>1
    expect(sanitizeBox({ x: 0, y: 0, w: 1, h: 0.7 })).toBeNull(); // 面積 70%
    expect(sanitizeBox({ x: 0, y: 0, w: 1, h: 0.6 })).not.toBeNull(); // 面積剛好 60%
    expect(sanitizeBox({ x: 0.1, y: 0.1, w: 0.05, h: 0.05 })).toBeNull(); // 面積 0.25% <0.3%
    expect(sanitizeBox({ x: 0.1, y: 0.1, w: 0.02, h: 0.5 })).toBeNull(); // w<3%
    expect(sanitizeBox({ x: 0.1, y: 0.1, w: 0.5, h: 0.01 })).toBeNull(); // h<1.5%
    expect(sanitizeBox({ x: "0.1", y: 0.1, w: 0.2, h: 0.1 })).toBeNull();
    expect(sanitizeBox({ x: NaN, y: 0.1, w: 0.2, h: 0.1 })).toBeNull();
    expect(sanitizeBox(null)).toBeNull();
    expect(sanitizeBox("x")).toBeNull();
  });
  it("sanitizeFieldBoxes：只保留指定欄位、逐欄 sanity", () => {
    const r = sanitizeFieldBoxes({ phone: PHONE, address: { x: 2, y: 0, w: 1, h: 1 }, hkid: ADDR }, ["phone", "address"]);
    expect(r).toEqual({ phone: PHONE });
    expect(sanitizeFieldBoxes(null, ["phone"])).toEqual({});
    expect(sanitizeFieldBoxes("bad", ["phone"])).toEqual({});
  });
});

describe("padBox 幾何", () => {
  const W = 2000;
  const H = 3000;
  it("上下外擴 1.2×h、左右 0.6×h（h 夠大時冇被最少 3% 蓋過）", () => {
    // h = 0.1*3000 = 300px → 上下 360px、左右 180px；3% 圖邊 = 90px(高)／60px(闊)，細過比例
    const b: NormBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    const r = padBox(b, [b], W, H);
    expect(r).toEqual({ x: 800 - 180, y: 1200 - 360, w: 400 + 360, h: 300 + 720 });
  });
  it("最少 3% 圖邊：h 好細時上下 ≥3% 圖高、左右 ≥3% 圖闊", () => {
    const b: NormBox = { x: 0.4, y: 0.4, w: 0.2, h: 0.016 }; // h=48px → 1.2h=57.6 <3%*3000=90；0.6h=28.8 <3%*2000=60
    const r = padBox(b, [b], W, H);
    expect(r.y).toBe(Math.floor(1200 - 0.03 * H));
    expect(r.x).toBe(Math.floor(800 - 0.03 * W));
    expect(r.y + r.h).toBe(Math.ceil(1200 + 48 + 0.03 * H));
    expect(r.x + r.w).toBe(Math.ceil(800 + 400 + 0.03 * W));
    expect(PAD_MIN_FRACTION).toBe(0.03);
  });
  it("clamp 到圖內", () => {
    const b: NormBox = { x: 0, y: 0, w: 0.5, h: 0.05 };
    const r = padBox(b, [b], W, H);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    const c: NormBox = { x: 0.6, y: 0.95, w: 0.4, h: 0.05 };
    const r2 = padBox(c, [c], W, H);
    expect(r2.x + r2.w).toBe(W);
    expect(r2.y + r2.h).toBe(H);
  });
  it("鄰欄限制：越入鄰欄 box 唔超過其高度 20%", () => {
    // 電話 box 喺上、地址 box 喺下，中間只隔 0.01 → 無限制外擴會大幅越入對方
    const a: NormBox = { x: 0.1, y: 0.3, w: 0.5, h: 0.05 };
    const b: NormBox = { x: 0.1, y: 0.36, w: 0.8, h: 0.08 };
    const ra = padBox(a, [a, b], W, H);
    // 對方（b）頂 = 0.36*3000=1080px、高 240px → 最多越入 48px
    expect(ra.y + ra.h).toBeLessThanOrEqual(Math.ceil(1080 + 0.2 * 240));
    expect(ra.y + ra.h).toBeGreaterThan(0.35 * H); // 至少包住自己
    const rb = padBox(b, [a, b], W, H);
    // a 底 = 0.35*3000=1050px、高 150px → b 上緣最多高過 1050 − 30
    expect(rb.y).toBeGreaterThanOrEqual(Math.floor(1050 - 0.2 * 150));
    // 唔縮入自己
    expect(rb.y).toBeLessThanOrEqual(0.36 * H);
    expect(rb.y + rb.h).toBeGreaterThanOrEqual(0.44 * H);
  });
  it("鄰欄限制：左右鄰欄（同行）", () => {
    const l: NormBox = { x: 0.05, y: 0.4, w: 0.2, h: 0.05 };
    const m: NormBox = { x: 0.26, y: 0.4, w: 0.2, h: 0.05 };
    const r = padBox(m, [l, m], W, H);
    // l 右緣 = 0.25*2000 = 500px，高 150px → m 左緣 ≥ 500 − 30
    expect(r.x).toBeGreaterThanOrEqual(470);
    expect(r.x).toBeLessThanOrEqual(0.26 * W);
  });
  it("驗收 S1：同一行並排嘅電話／地址互為左右鄰欄，上下外擴仍係完整 1.2×h（唔被對方截停）", () => {
    const W1 = 1800;
    const H1 = 2400;
    const ph: NormBox = { x: 0.05, y: 0.3, w: 0.35, h: 0.04 };
    const ad: NormBox = { x: 0.41, y: 0.295, w: 0.5, h: 0.06 };
    for (const [b, hPx] of [[ph, 0.04 * H1], [ad, 0.06 * H1]] as const) {
      const r = padBox(b, [ph, ad], W1, H1);
      const padY = Math.max(1.2 * hPx, 0.03 * H1);
      expect(r.y).toBe(Math.floor(b.y * H1 - padY));
      expect(r.y + r.h).toBe(Math.ceil((b.y + b.h) * H1 + padY));
    }
    // 左右仍然唔越入對方 20% 以上
    const rp = padBox(ph, [ph, ad], W1, H1);
    expect(rp.x + rp.w).toBeLessThanOrEqual(Math.ceil(0.41 * W1 + 0.2 * 0.06 * H1));
    // 真正上下疊嘅（重疊 <20%）仍然受限
    const top: NormBox = { x: 0.1, y: 0.3, w: 0.5, h: 0.05 };
    const bot: NormBox = { x: 0.1, y: 0.36, w: 0.8, h: 0.08 };
    expect(padBox(top, [top, bot], W1, H1).y + padBox(top, [top, bot], W1, H1).h).toBeLessThanOrEqual(Math.ceil(0.36 * H1 + 0.2 * 0.08 * H1));
  });
  it("cropOutSize：長邊縮到 1,000；細過放大但最多 2×", () => {
    expect(cropOutSize(2000, 400)).toEqual({ w: 1000, h: 200 });
    expect(cropOutSize(300, 100)).toEqual({ w: 600, h: 200 }); // 2× 封頂（若無封頂會 3.33×）
    expect(cropOutSize(800, 200)).toEqual({ w: 1000, h: 250 });
    expect(cropOutSize(1, 1)).toEqual({ w: 2, h: 2 });
  });
  it("planFieldCrops：入職表兩欄都有效 → field_crops（每欄一張、長邊 ≤1,000、≤4 張）", () => {
    const p = planFieldCrops("onboarding_form", { phone: PHONE, address: ADDR }, 2400, 3200);
    expect(p.kind).toBe("field_crops");
    expect(p.crops.map((c) => c.field)).toEqual(["phone", "address"]);
    expect(p.crops.length).toBeLessThanOrEqual(4);
    for (const c of p.crops) {
      expect(Math.max(c.out.w, c.out.h)).toBeLessThanOrEqual(1000);
      expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(2400);
      expect(c.rect.y + c.rect.h).toBeLessThanOrEqual(3200);
    }
    // 完整包住原 box
    const r = p.crops[0]!.rect;
    expect(r.x).toBeLessThanOrEqual(PHONE.x * 2400);
    expect(r.y).toBeLessThanOrEqual(PHONE.y * 3200);
    expect(r.x + r.w).toBeGreaterThanOrEqual((PHONE.x + PHONE.w) * 2400 - 1);
    expect(r.y + r.h).toBeGreaterThanOrEqual((PHONE.y + PHONE.h) * 3200 - 1);
  });
  it("後備：冇 box／任何一欄冇有效 box／其他文件類型／未知類型 → tiles", () => {
    expect(planFieldCrops("onboarding_form", {}, 2400, 3200).kind).toBe("tiles");
    expect(planFieldCrops("onboarding_form", { phone: PHONE }, 2400, 3200).kind).toBe("tiles");
    expect(planFieldCrops("onboarding_form", { phone: PHONE, address: { x: 0, y: 0, w: 1, h: 1 } }, 2400, 3200).kind).toBe("tiles");
    expect(planFieldCrops("id_card", { phone: PHONE, address: ADDR }, 2400, 3200).kind).toBe("tiles");
    expect(OCR_CROP_FIELDS.id_card).toBeUndefined();
  });
});

describe("continuation", () => {
  const payload = (over: Partial<ContinuationPayload> = {}): ContinuationPayload => ({ type: "onboarding_form", uid: "u1", a: { phone: { value: "90001111" } }, boxes: { phone: PHONE }, provider: "claude", model: "fake", fb: null, usage: { promptTokens: 10, completionTokens: 5, calls: 1, truncated: 0 }, ...over });
  beforeEach(() => resetContinuationNonces());
  it("簽發→驗證 round-trip：還原 A 讀數、box、用量", () => {
    const t = signContinuation(payload(), SECRET, 1_000_000);
    const v = verifyContinuation(t, SECRET, "u1", 1_000_500);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.a).toEqual({ phone: { value: "90001111" } });
      expect(v.payload.boxes).toEqual({ phone: PHONE });
      expect(v.payload.usage.calls).toBe(1);
      expect(v.payload.type).toBe("onboarding_form");
    }
  });
  it("篡改 payload／簽名、錯 secret、別人 userId、過期、未來、重用 → 全部 ok:false", () => {
    const t = signContinuation(payload(), SECRET, 1_000_000);
    const [body, sig] = t.split(".") as [string, string];
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), a: { phone: { value: "99999999" } } })).toString("base64url");
    expect(verifyContinuation(`${tampered}.${sig}`, SECRET, "u1", 1_000_100).ok).toBe(false);
    expect(verifyContinuation(`${body}.${sig.slice(0, -2)}AA`, SECRET, "u1", 1_000_100).ok).toBe(false);
    expect(verifyContinuation(t, SECRET + "x", "u1", 1_000_100).ok).toBe(false);
    expect(verifyContinuation(t, SECRET, "u2", 1_000_100).ok).toBe(false);
    expect(verifyContinuation(t, SECRET, "u1", 1_000_000 + CONTINUATION_TTL_MS + 1).ok).toBe(false);
    expect(verifyContinuation(t, SECRET, "u1", 1_000_000 - 120_000).ok).toBe(false);
    expect(verifyContinuation("garbage", SECRET, "u1").ok).toBe(false);
    expect(verifyContinuation("a.b.c", SECRET, "u1").ok).toBe(false);
    expect(verifyContinuation("x".repeat(70_000), SECRET, "u1").ok).toBe(false);
    // 單次使用
    expect(verifyContinuation(t, SECRET, "u1", 1_000_100).ok).toBe(true);
    expect(verifyContinuation(t, SECRET, "u1", 1_000_200).ok).toBe(false);
  });
  it("驗證出嚟嘅 box 再 sanity（簽咗名都唔信）", () => {
    const t = signContinuation(payload({ boxes: { phone: { x: 0, y: 0, w: 1, h: 1 } } }), SECRET, 5);
    const v = verifyContinuation(t, SECRET, "u1", 10);
    expect(v.ok && v.payload.boxes).toEqual({});
  });
  it("短 secret → throw（唔簽）", () => {
    expect(() => signContinuation(payload(), "short")).toThrow();
  });
});

type Spec = Record<string, unknown>;
/** fake client：按 prompt 分辨讀 A（含 field_boxes 要求）／讀 B（tight crops｜overlapping）／仲裁。 */
function fake(provider: OcrProviderName, answers: { a?: Spec; b?: Spec; arbiter?: Spec; rawA?: string }, calls: VisionRequest[]): VisionClient {
  return {
    model: `fake-${provider}`,
    provider,
    async complete(req) {
      calls.push(req);
      const isArb = req.system.includes("tie-breaker");
      const isB = !isArb && (req.userText.includes("overlapping") || req.userText.includes("tight crops"));
      const spec = isArb ? answers.arbiter : isB ? answers.b : answers.a;
      return { text: !isArb && !isB && answers.rawA !== undefined ? answers.rawA : JSON.stringify(spec ?? {}), promptTokens: 100, completionTokens: 10 } satisfies VisionResponse;
    },
  };
}
const obj = (value: string, confidence: "high" | "medium" | "low" = "high", extra: Spec = {}) => ({ value, confidence, reason: confidence === "high" ? null : "blurry", alternatives: [], ...extra });
const ADDR_TXT = "新界火炭示範街99號虛構大廈15樓A室";
function clientsOf(answers: Parameters<typeof fake>[1]) {
  const calls: VisionRequest[] = [];
  const clients: ReadClients = { a: fake("claude", answers, calls), b: fake("deepseek", answers, calls), arbiter: fake("claude", answers, calls) };
  return { clients, calls };
}

describe("readStageA／readStageB", () => {
  it("stage A：入職表要求 field_boxes（prompt＋boxFields）；回已 sanity 嘅 box；用量只計讀 A", async () => {
    const { clients, calls } = clientsOf({ a: { phone: obj("90001111"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: { x: 5, y: 0, w: 1, h: 1 } } } });
    const a = await readStageA(clients, "onboarding_form", IMG);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.boxFields).toEqual(["phone", "address"]);
    expect(calls[0]!.system).toContain('"field_boxes"');
    expect(calls[0]!.userText).toBe(buildUserTextFull("onboarding_form", { boxes: true }));
    expect(a.field_boxes).toEqual({ phone: PHONE }); // address 不合格被丟
    expect(a.a_fields_raw?.phone?.value).toBe("90001111");
    expect(a.usage).toEqual({ promptTokens: 100, completionTokens: 10, calls: 1, truncated: 0 });
    expect(a.parse_ok).toBe(true);
    expect(a.provider).toBe("claude");
  });
  it("stage A：身份證（冇裁圖設計）唔要求 box，prompt 同舊版一樣", async () => {
    const { clients, calls } = clientsOf({ a: { name_zh: obj("測試甲") } });
    const a = await readStageA(clients, "id_card", IMG);
    expect(calls[0]!.boxFields).toBeUndefined();
    expect(calls[0]!.system).toBe(buildSystemPrompt("id_card"));
    expect(calls[0]!.userText).toBe(buildUserTextFull("id_card"));
    expect(a.field_boxes).toEqual({});
  });
  it("stage A：讀 A 解析失敗＋退回 DeepSeek → 冇 box；Claude 失敗退回亦冇 box", async () => {
    const calls: VisionRequest[] = [];
    const ds = fake("deepseek", { a: { phone: obj("90001111"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: ADDR } } }, calls);
    const claudeBad = fake("claude", { rawA: "壞 {" }, calls);
    const a = await readStageA({ a: claudeBad, b: ds, fallbackA: ds }, "onboarding_form", IMG);
    expect(a.fallback_reason).toBe("parse");
    expect(a.provider).toBe("deepseek");
    expect(a.field_boxes).toEqual({});
    expect(a.usage.calls).toBe(1);
    // 解析失敗而冇後備 → box 空、a_fields_raw null
    const solo = await readStageA(clientsOf({ rawA: "壞" }).clients, "onboarding_form", IMG);
    expect(solo.a_fields_raw).toBeNull();
    expect(solo.field_boxes).toEqual({});
  });
  it("stage B（field_crops）：prompt 講明邊張係邊欄、只抄該欄；reconcile＋images_b_kind／field_boxes_used；用量只計讀 B", async () => {
    const { clients, calls } = clientsOf({ a: { phone: obj("90001111"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: ADDR } }, b: { phone: obj("90001111"), address: obj(ADDR_TXT) } });
    const a = await readStageA(clients, "onboarding_form", IMG);
    calls.length = 0;
    const crops = [IMG + "P", IMG + "A"];
    const r = await readStageB(clients, "onboarding_form", a, { kind: "field_crops", images: crops, fieldOf: ["phone", "address"], full: IMG });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.images).toEqual(crops);
    expect(calls[0]!.userText).toBe(buildUserTextFieldCrops("onboarding_form", ["phone", "address"]));
    expect(calls[0]!.userText).toMatch(/Image 1 is the phone number field/);
    expect(calls[0]!.userText).toMatch(/Image 2 is the address field/);
    expect(calls[0]!.userText).toMatch(/ONLY/);
    expect(r.images_b_kind).toBe("field_crops");
    expect(r.field_boxes_used).toBe(true);
    expect(r.fields.phone).toMatchObject({ status: "confirmed", value: "90001111" });
    expect(r.fields.address).toMatchObject({ status: "confirmed" });
    expect(r.usage.calls).toBe(1);
    expect(r.provider_used).toEqual({ a: "claude", b: "deepseek" });
  });
  it("stage B（field_crops）仲裁：用全圖＋分歧欄對應裁圖", async () => {
    const { clients, calls } = clientsOf({
      a: { phone: obj("90001111", "low"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: ADDR } },
      b: { phone: obj("90001112", "low"), address: obj(ADDR_TXT) },
      arbiter: { phone: obj("90001111", "medium") },
    });
    const a = await readStageA(clients, "onboarding_form", IMG);
    calls.length = 0;
    const r = await readStageB(clients, "onboarding_form", a, { kind: "field_crops", images: [IMG + "P", IMG + "A"], fieldOf: ["phone", "address"], full: IMG + "F" });
    const arb = calls.find((c) => c.system.includes("tie-breaker"))!;
    expect(arb.images).toEqual([IMG + "F", IMG + "P"]); // 全圖＋電話裁圖（地址冇分歧）
    expect(arb.userText).toBe(buildArbiterUserTextCrops("onboarding_form", { phone: ["90001111", "90001112"] }, ["phone"]));
    expect(r.fields.phone).toMatchObject({ status: "confirmed", value: "90001111", arbiter: "agree_a" });
    expect(r.arbiter).toEqual({ called: true, fields: 1 });
    expect(r.usage.calls).toBe(2); // B＋仲裁（不含 A）
  });
  it("stage B（tiles）＝後備：用 2×2 格 prompt；冇 full 就唔仲裁", async () => {
    const { clients, calls } = clientsOf({ a: { phone: obj("90001111", "low"), address: obj(ADDR_TXT) }, b: { phone: obj("90001112", "low"), address: obj(ADDR_TXT) } });
    const a = await readStageA(clients, "onboarding_form", IMG);
    calls.length = 0;
    const r = await readStageB(clients, "onboarding_form", a, { kind: "tiles", images: [IMG, IMG, IMG, IMG] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userText).toMatch(/overlapping enlarged crops/);
    expect(r.images_b_kind).toBe("tiles");
    expect(r.field_boxes_used).toBe(false);
    expect(r.fields.phone!.status).toBe("review");
    expect(r.arbiter.called).toBe(false);
  });
  it("legacy readDocument 行為不變：A 冇 box 要求、images_b_kind=tiles、兩次呼叫", async () => {
    const { clients, calls } = clientsOf({ a: { phone: obj("90001111"), address: obj(ADDR_TXT) }, b: { phone: obj("90001111"), address: obj(ADDR_TXT) } });
    const r = await readDocument(clients, "onboarding_form", { full: IMG, tiles: [IMG, IMG, IMG, IMG] });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.boxFields === undefined)).toBe(true);
    expect(r.images_b_kind).toBe("tiles");
    expect(r.field_boxes_used).toBe(false);
    expect(r.usage.calls).toBe(2);
  });
  it("Claude schema：stage A 加 field_boxes（required、可 null）；電話欄加 digit_count；其他不變", () => {
    const s = ocrJsonSchema(["phone", "address"], ["phone", "address"]);
    expect(s.required).toEqual(["phone", "address", "field_boxes"]);
    const fb = s.properties.field_boxes as { properties: Record<string, { anyOf: { type: string }[] }>; required: string[] };
    expect(fb.required).toEqual(["phone", "address"]);
    expect(fb.properties.phone!.anyOf.map((x) => x.type)).toEqual(["null", "object"]);
    const ph = s.properties.phone as { required: string[] };
    expect(ph.required).toEqual(["value", "confidence", "reason", "alternatives", "digit_count"]);
    expect((s.properties.address as { required: string[] }).required).toEqual(["value", "confidence", "reason", "alternatives"]);
    expect(ocrJsonSchema(["hkid"]).required).toEqual(["hkid"]);
  });
  it("digit_count 解析（模型自報）：整數保留，亂值丟棄", () => {
    expect(fieldReadSchema.parse({ value: "9", digit_count: 8 })).toMatchObject({ digit_count: 8 });
    expect(fieldReadSchema.parse({ value: "9", digit_count: "x" })).toEqual({ value: "9" });
    expect(fieldReadSchema.parse({ value: "9", digit_count: null })).toEqual({ value: "9" });
  });
  it("prompt：有電話欄先加分格線防呆；身份證 prompt 不變", () => {
    const p = buildSystemPrompt("onboarding_form");
    expect(p).toMatch(/NOT the digit 1/);
    expect(p).toMatch(/exactly 8 digits/);
    expect(p).toMatch(/digit_count/);
    expect(p).toMatch(/number of printed boxes/);
    expect(buildSystemPrompt("id_card")).not.toMatch(/grid lines/);
    expect(buildSystemPrompt("address_proof")).not.toMatch(/grid lines/);
  });
});

describe("電話分格線（9–10 位）", () => {
  it("phoneGridlineCandidates：唯一解／雙解／多解或無解／非 9–10 位", () => {
    expect(phoneGridlineCandidates("912345678")).toEqual(["92345678"]); // 剔走唯一嘅 1
    expect(phoneGridlineCandidates("190001111")).toEqual(["90001111"]); // 剔頭先得首位 2–9；剔其他 1 都以 1 開頭
    expect(phoneGridlineCandidates("912314567")).toEqual(["91234567", "92314567"]); // 雙解，排序確定
    expect(phoneGridlineCandidates("9123145678")).toEqual(["92345678"]); // 10 位剔兩個 1
    expect(phoneGridlineCandidates("911213141")).toEqual([]); // 3 個不同解＝太不確定
    expect(phoneGridlineCandidates("100000000")).toEqual([]); // 剔 1 後首位 0
    expect(phoneGridlineCandidates("92345678")).toEqual([]); // 8 位唔處理
    expect(phoneGridlineCandidates("92345678901")).toEqual([]);
  });
  it("normalizeField phone：9 位有解 → invalid＋phone_gridline_suspect＋extra；冇解 → phone_not_hk；8 位照舊", () => {
    expect(normalizeField("phone", "9123 4567 8")).toMatchObject({ valid: false, reason: "phone_gridline_suspect", extra: ["92345678"], canon: "912345678" });
    expect(normalizeField("phone", "100000000")).toMatchObject({ valid: false, reason: "phone_not_hk" });
    expect(normalizeField("phone", "9234 5678")).toEqual({ canon: "92345678", display: "92345678", valid: true });
  });
  it("reconcile：兩讀同樣 9 位 → review（唔 confirmed），預填＝剔走 1 嘅 8 位，候選含原值", () => {
    const r = reconcile("phone", "912345678", "912345678");
    expect(r.status).toBe("review");
    expect(r.reason).toBe("phone_gridline_suspect");
    expect(r.value).toBe("92345678");
    expect(r.candidates).toContain("912345678");
    expect(r.candidates_ranked[0]).toMatchObject({ value: "92345678", reason: "valid" });
    expect(r.candidates_ranked[0]!.sources).toEqual(["a_grid", "b_grid"]);
  });
  it("reconcile：A 9 位、B 剛好係剔走 1 嘅 8 位 → review reads_differ，候選排第一（兩源一致加權），仍唔自動確認", () => {
    const r = reconcile("phone", "912345678", "92345678");
    expect(r.status).toBe("review");
    expect(r.reason).toBe("reads_differ");
    expect(r.value).toBe("92345678");
    expect(r.candidates_ranked[0]!.sources).toEqual(["b", "a_grid"]);
  });
  it("reconcile：雙解 → 兩個都入候選（≤4 總數）", () => {
    const r = reconcile("phone", "912314567", "912314567");
    expect(r.candidates_ranked.map((c) => c.value).slice(0, 2).sort()).toEqual(["91234567", "92314567"]);
    expect(r.status).toBe("review");
  });
  it("非電話欄唔受影響", () => {
    expect(normalizeField("name_zh", "測試甲").extra).toBeUndefined();
  });
});

describe("戶口號碼位數（HKICL 表，驗收 S2：表暫時清空）", () => {
  it("表空＝所有銀行 unknown_bank，唔判錯（函數保留，待戶口格式正規化後再填）", () => {
    expect(Object.keys(HKICL_ACCT_DIGITS)).toEqual([]);
    for (const code of ["004", "012", "024", "999", null]) for (const d of ["123456789", "1234567890", "123456789012"]) expect(acctDigitsCheck(d, code)).toBe("unknown_bank");
  });
  it("acctDigitsReason 全部 null；normAcct 本身行為不變", () => {
    expect(acctDigitsReason("0123456789", "004")).toBeNull();
    expect(acctDigitsReason("012345678", "012")).toBeNull();
    expect(acctDigitsReason("abc", "004")).toBeNull();
    expect(normAcct("012-345678-9")).toBe("0123456789");
    expect(normAcct("12345")).toBeNull();
  });
});

const L = (t: string, x: number, y: number, h = 0.01, w = 0.1): OcrLine => ({ t, c: 0.9, x, y, w, h });
describe("路徑 B 外擴（按 label 行高比例＋唔越過下一個 label 行＋pad 參數）", () => {
  it("padAround：預設外擴 max(比例×行高, 0.03)；barrier 限制上下左右", () => {
    const base = { x0: 0.4, x1: 0.6, y0: 0.5, y1: 0.52 };
    const free = padAround(base, 0.1, []);
    // 行高 0.1 → 上下 0.12、左右 0.06
    expect(free.y1).toBeCloseTo(0.64, 6);
    expect(free.y0).toBeCloseTo(0.38, 6);
    expect(free.x0).toBeCloseTo(0.34, 6);
    expect(free.x1).toBeCloseTo(0.66, 6);
    const small = padAround(base, 0.005, []); // 比例細過 0.03 → 用 0.03
    expect(small.y1).toBeCloseTo(0.55, 6);
    expect(small.x0).toBeCloseTo(0.37, 6);
    const lim = padAround(base, 0.1, [L("下一行", 0.1, 0.45), L("上一行", 0.1, 0.58), L("右邊欄", 0.62, 0.5)]);
    expect(lim.y0).toBeCloseTo(0.462, 6); // 下一行頂 0.46 + 0.002
    expect(lim.y1).toBeCloseTo(0.578, 6); // 上一行底 0.58 − 0.002
    expect(lim.x1).toBeCloseTo(0.618, 6); // 同行右邊 label 左緣 0.62 − 0.002
    expect(lim.x0).toBeLessThanOrEqual(0.4);
  });
  it("padAround：pad 參數可覆蓋；同行 barrier 唔影響上下", () => {
    const base = { x0: 0.4, x1: 0.6, y0: 0.5, y1: 0.52 };
    const p = padAround(base, 0.01, [], { vertical: 3, horizontal: 1, min: 0.05 });
    expect(p.y1).toBeCloseTo(0.57, 6);
    expect(p.x0).toBeCloseTo(0.35, 6);
    const same = padAround(base, 0.01, [L("同行", 0.1, 0.5, 0.02)]);
    expect(same.y0).toBeCloseTo(0.47, 6);
  });
  it("isLabelLine：數字行（電話／身份證號）唔當 label", () => {
    expect(isLabelLine(L("手提電話：", 0.1, 0.1))).toBe(true);
    expect(isLabelLine(L("Phone No.", 0.1, 0.1))).toBe(true);
    expect(isLabelLine(L("91234567", 0.1, 0.1))).toBe(false);
    expect(isLabelLine(L("", 0.1, 0.1))).toBe(false);
  });
  it("範本 A 電話：外擴比以前闊（≥0.03），但唔越過上下 label 行", () => {
    const loc = locatePhoneBox([L("手提電話：", 0.48, 0.56), L("關係： 電話：", 0.48, 0.54), L("通訊地址", 0.13, 0.59)]);
    expect(loc!.box.y1).toBeLessThan(0.59);
    expect(loc!.box.y0).toBeGreaterThan(0.545);
    const open = locatePhoneBox([L("手提電話：", 0.48, 0.56)]);
    expect(open!.box.y1 - open!.box.y0).toBeGreaterThanOrEqual(0.06); // label 行 0.01 + 上下各 ≥0.03
    expect(open!.box.x0).toBeCloseTo(0.45, 6);
    // pad 參數由 caller 調
    const wide = locatePhoneBox([L("手提電話：", 0.48, 0.56)], { min: 0.05 });
    expect(wide!.box.y1 - wide!.box.y0).toBeGreaterThan(open!.box.y1 - open!.box.y0);
  });
  it("範本 B 電話：右邊唔越過同行嘅『住所電話』；下面唔越過『地址：』", () => {
    const loc = locatePhoneBox([L("聯絡電話", 0.06, 0.66), L("Phone No.：", 0.06, 0.65), L("住所電話", 0.39, 0.66), L("地址：", 0.06, 0.62)]);
    expect(loc!.box.x1).toBeLessThan(0.39);
    expect(loc!.box.y0).toBeGreaterThan(0.62);
  });
  it("申請表地址：variant b 外擴較闊；上面唔越過上一個 label 行", () => {
    const lines = [L("居港年期", 0.13, 0.62), L("住址：", 0.13, 0.595), L("通訊地址（如與上述不同請提供）：", 0.13, 0.575)];
    const a = locateFormAddressBox(lines, "a");
    const b = locateFormAddressBox(lines, "b");
    expect(a!.box.y1).toBeLessThan(0.62);
    expect(b!.box.y1).toBeLessThan(0.62);
    expect(a!.box.y0).toBeGreaterThan(0.575);
    const open = [L("住址：", 0.13, 0.595), L("通訊地址", 0.13, 0.3)];
    expect(locateFormAddressBox(open, "b")!.box.y1 - locateFormAddressBox(open, "a")!.box.y1).toBeCloseTo(0.012, 6);
  });
});

describe("兩段式 client 流程（readTwoStage）", () => {
  const doc = { type: "onboarding_form" as const, full: IMG + "F", tiles: [IMG + "1", IMG + "2", IMG + "3", IMG + "4"], sourceW: 2400, sourceH: 3200 };
  const aRes = (boxes: unknown) => ({ ok: true as const, data: { ms: 10, usage: { prompt_tokens: 1, completion_tokens: 2, calls: 1 }, documents: [{ type: "onboarding_form", field_boxes: boxes, continuation: "tok" }] } });
  const bRes = { ok: true as const, data: { ms: 20, usage: { prompt_tokens: 3, completion_tokens: 4, calls: 2 }, documents: [{ type: "onboarding_form" }] } };

  it("有效 box → 欄位級裁圖（field_of 次序＝plan）、stage b 帶 continuation＋full；ms／usage 加埋", async () => {
    const bodies: unknown[] = [];
    const out = await readTwoStage(
      [doc],
      {
        post: async (body) => {
          bodies.push(body);
          return ((body as { stage: string }).stage === "a" ? aRes({ phone: PHONE, address: ADDR }) : bRes) as never;
        },
        crop: (_d, plan) => plan.crops.map((c) => `${IMG}-${c.field}`),
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.kinds).toEqual({ onboarding_form: "field_crops" });
      expect(out.data.ms).toBe(30);
      expect(out.data.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, calls: 3 });
    }
    expect(bodies[0]).toEqual({ stage: "a", documents: [{ type: "onboarding_form", full: IMG + "F" }] });
    expect(bodies[1]).toEqual({ stage: "b", documents: [{ type: "onboarding_form", continuation: "tok", full: IMG + "F", images_b: { kind: "field_crops", images: [`${IMG}-phone`, `${IMG}-address`], field_of: ["phone", "address"] } }] });
  });
  it("冇 box／box 不合格 → 後備 2×2 tiles", async () => {
    for (const boxes of [{}, { phone: PHONE }, { phone: PHONE, address: { x: 0, y: 0, w: 1, h: 1 } }, null]) {
      const bodies: unknown[] = [];
      const out = await readTwoStage([doc], { post: async (body) => { bodies.push(body); return ((body as { stage: string }).stage === "a" ? aRes(boxes) : bRes) as never; }, crop: () => { throw new Error("不應該裁圖"); } });
      expect(out.ok && out.kinds).toEqual({ onboarding_form: "tiles" });
      expect((bodies[1] as { documents: { images_b: { kind: string; images: string[] } }[] }).documents[0]!.images_b).toMatchObject({ kind: "tiles", images: doc.tiles });
    }
  });
  it("stage a／b 失敗（網絡 0／400／503）或者拋錯 → ok:false，caller 退回舊流程", async () => {
    const fail = (status: number) => ({ ok: false as const, status, message: "x" });
    expect((await readTwoStage([doc], { post: async () => fail(0) as never, crop: () => [] })).ok).toBe(false);
    expect((await readTwoStage([doc], { post: async (b) => ((b as { stage: string }).stage === "a" ? aRes({ phone: PHONE, address: ADDR }) : fail(400)) as never, crop: (_d, p) => p.crops.map(() => IMG) })).ok).toBe(false);
    expect((await readTwoStage([doc], { post: async () => { throw new Error("net"); }, crop: () => [] })).ok).toBe(false);
    expect((await readTwoStage([doc], { post: async (b) => ((b as { stage: string }).stage === "a" ? aRes({ phone: PHONE, address: ADDR }) : bRes) as never, crop: () => { throw new Error("canvas"); } })).ok).toBe(false);
  });
  it("stage a 回應缺 continuation → ok:false", async () => {
    const bad = { ok: true as const, data: { ms: 1, usage: { prompt_tokens: 0, completion_tokens: 0, calls: 0 }, documents: [{ type: "onboarding_form", field_boxes: {} }] } };
    expect((await readTwoStage([doc], { post: async () => bad as never, crop: () => [] })).ok).toBe(false);
  });
});

describe("readTwoStage：混合文件＋429／503 唔退回（驗收 S3／N2）", () => {
  const doc = { type: "onboarding_form" as const, full: IMG + "F", tiles: [IMG, IMG, IMG, IMG], sourceW: 2400, sourceH: 3200 };
  const idDoc = { type: "id_card" as const, full: IMG + "I", tiles: [IMG + "1", IMG + "2", IMG + "3", IMG + "4"], sourceW: 0, sourceH: 0 };
  const finalId = { type: "id_card", final: true, fields: { hkid: { status: "confirmed", value: "x" } }, images_b_kind: "tiles" };
  const formA = { type: "onboarding_form", field_boxes: { phone: PHONE, address: ADDR }, continuation: "tok" };
  const ok = (documents: unknown[]) => ({ ok: true as const, data: { model: "m", ms: 10, usage: { prompt_tokens: 1, completion_tokens: 1, calls: 3 }, documents } });
  it("身份證 final:true 唔打 stage b；入職表照 a→裁→b；documents 按上載次序合併", async () => {
    const bodies: { stage: string; documents: { type: string; tiles?: unknown[] }[] }[] = [];
    const out = await readTwoStage([idDoc, doc], {
      post: async (body) => {
        const b = body as (typeof bodies)[number];
        bodies.push(b);
        if (b.stage === "a") return ok([finalId, formA]) as never;
        return { ok: true, data: { ms: 5, usage: { prompt_tokens: 1, completion_tokens: 1, calls: 1 }, documents: [{ type: "onboarding_form", fields: {}, images_b_kind: "field_crops" }] } } as never;
      },
      crop: (_d, p) => p.crops.map(() => IMG),
    });
    expect(out.ok).toBe(true);
    expect(bodies.map((b) => b.stage)).toEqual(["a", "b"]);
    expect(bodies[0]!.documents.find((d) => d.type === "id_card")!.tiles).toHaveLength(4);
    expect(bodies[0]!.documents.find((d) => d.type === "onboarding_form")!.tiles).toBeUndefined();
    expect(bodies[1]!.documents.map((d) => d.type)).toEqual(["onboarding_form"]);
    if (out.ok) {
      expect(out.data.documents.map((d) => d.type)).toEqual(["id_card", "onboarding_form"]);
      expect(out.data.usage.calls).toBe(4);
    }
  });
  it("只有身份證：完全唔打 stage b", async () => {
    const stages: string[] = [];
    const out = await readTwoStage([idDoc], { post: async (body) => { stages.push((body as { stage: string }).stage); return ok([finalId]) as never; }, crop: () => [] });
    expect(stages).toEqual(["a"]);
    expect(out.ok && out.data.documents).toHaveLength(1);
  });
  it("伺服器對非入職表冇回 final → ok:false（退回舊流程）", async () => {
    expect((await readTwoStage([idDoc], { post: async () => ok([{ type: "id_card", continuation: "x" }]) as never, crop: () => [] })).ok).toBe(false);
  });
  it("stage a／b 收到 429／503 → fatal（唔退回）；400／網絡 0 → 普通失敗（退回）", async () => {
    for (const st of [429, 503]) {
      const a = await readTwoStage([doc], { post: async () => ({ ok: false, status: st, message: "m" }) as never, crop: () => [] });
      expect(a).toMatchObject({ ok: false, fatal: { status: st, message: "m" } });
      const b = await readTwoStage([doc], { post: async (body) => ((body as { stage: string }).stage === "a" ? ok([formA]) : { ok: false, status: st, message: "mb" }) as never, crop: (_d, p) => p.crops.map(() => IMG) });
      expect(b).toMatchObject({ ok: false, fatal: { status: st, message: "mb" } });
    }
    for (const st of [400, 0, 500]) {
      const a = await readTwoStage([doc], { post: async () => ({ ok: false, status: st, message: "m" }) as never, crop: () => [] });
      expect(a.ok).toBe(false);
      expect((a as { fatal?: unknown }).fatal).toBeUndefined();
    }
  });
});

describe("POST /api/guards/ocr/read：stage a／stage b", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let other: string;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  beforeEach(async () => {
    await clearAll();
    resetContinuationNonces();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    other = await sessionCookieForUser(fx.userIds["會計"]);
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => {
    setVisionClientForTests(null);
    vi.restoreAllMocks();
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
  });
  const post = (body: unknown, cookie = owner) => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  const formAnswers = (aOver: Spec = {}, bOver: Spec = {}, extra: Partial<Parameters<typeof fake>[1]> = {}) => ({
    a: { phone: obj("90001111"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: ADDR }, ...aOver },
    b: { phone: obj("90001111"), address: obj(ADDR_TXT), ...bOver },
    ...extra,
  });
  async function stageA(answers: Parameters<typeof fake>[1], calls: VisionRequest[] = []) {
    setVisionClientForTests(fake("claude", answers, calls));
    const res = await post({ stage: "a", documents: [{ type: "onboarding_form", full: IMG }] });
    return { res, j: await res.json() };
  }
  const bBody = (continuation: string, images_b: unknown, full: string | null = IMG) => ({ stage: "b", documents: [{ type: "onboarding_form", continuation, ...(full ? { full } : {}), images_b }] });
  const crops = { kind: "field_crops", images: [IMG, IMG], field_of: ["phone", "address"] };

  it("stage a：回 field_boxes＋continuation（簽名 token），用量只計讀 A（1 次呼叫）", async () => {
    const calls: VisionRequest[] = [];
    const { res, j } = await stageA(formAnswers(), calls);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(j.stage).toBe("a");
    expect(j.usage.calls).toBe(1);
    expect(j.documents[0].field_boxes).toEqual({ phone: PHONE, address: ADDR });
    expect(typeof j.documents[0].continuation).toBe("string");
    expect(j.documents[0].continuation.split(".")).toHaveLength(2);
    expect(j.documents[0].fields).toBeUndefined();
  });
  it("驗收 S3：stage a 混合三種文件——身份證／住址證明連 tiles 直接讀完（final:true、冇 continuation），入職表出 box＋continuation", async () => {
    const calls: VisionRequest[] = [];
    setVisionClientForTests(fake("claude", { ...formAnswers(), a: { phone: obj("90001111"), address: obj(ADDR_TXT), field_boxes: { phone: PHONE, address: ADDR }, hkid: obj("Z900001(2)"), name_zh: obj("測試甲"), name_en: obj("TEST ALPHA"), dob: obj("15-01-1990"), sex: obj("M") }, b: { phone: obj("90001111"), address: obj(ADDR_TXT), hkid: obj("Z900001(2)"), name_zh: obj("測試甲"), name_en: obj("TEST ALPHA"), dob: obj("15-01-1990"), sex: obj("M") } }, calls));
    const t = [IMG, IMG, IMG, IMG];
    const res = await post({ stage: "a", documents: [{ type: "id_card", full: IMG, tiles: t }, { type: "address_proof", full: IMG, tiles: t }, { type: "onboarding_form", full: IMG }] });
    expect(res.status).toBe(200);
    const j = await res.json();
    const by = Object.fromEntries(j.documents.map((d: { type: string }) => [d.type, d]));
    expect(by.id_card.final).toBe(true);
    expect(by.id_card.continuation).toBeUndefined();
    expect(by.id_card.fields.hkid).toMatchObject({ status: "confirmed", value: "Z900001(2)" });
    expect(by.id_card.images_b_kind).toBe("tiles");
    expect(by.address_proof.final).toBe(true);
    expect(by.onboarding_form.final).toBeUndefined();
    expect(typeof by.onboarding_form.continuation).toBe("string");
    expect(by.onboarding_form.field_boxes).toEqual({ phone: PHONE, address: ADDR });
    expect(calls).toHaveLength(2 + 2 + 1); // id_card A＋B、address_proof A＋B、入職表 A
    expect(j.usage.calls).toBe(5);
    // 非入職表冇 tiles → 400（quota 前驗）
    expect((await post({ stage: "a", documents: [{ type: "id_card", full: IMG }] })).status).toBe(400);
  });
  it("stage a 唔需要 tiles（有傳都接受）；格式錯 → 400", async () => {
    setVisionClientForTests(fake("claude", formAnswers(), []));
    expect((await post({ stage: "a", documents: [{ type: "onboarding_form", full: IMG, tiles: [IMG] }] })).status).toBe(200);
    expect((await post({ stage: "a", documents: [{ type: "onboarding_form" }] })).status).toBe(400);
    expect((await post({ stage: "z", documents: [] })).status).toBe(400);
    expect((await post({ stage: "a", documents: [{ type: "onboarding_form", full: IMG }, { type: "onboarding_form", full: IMG }] })).status).toBe(400);
  });
  it("stage a → stage b（欄位級裁圖）：同舊格式 fields＋images_b_kind／field_boxes_used；confirmed 兩讀一致", async () => {
    const calls: VisionRequest[] = [];
    const { j } = await stageA(formAnswers(), calls);
    const res = await post(bBody(j.documents[0].continuation, crops));
    expect(res.status).toBe(200);
    const jb = await res.json();
    const d = jb.documents[0];
    expect(d.images_b_kind).toBe("field_crops");
    expect(d.field_boxes_used).toBe(true);
    expect(d.fields.phone).toMatchObject({ status: "confirmed", value: "90001111" });
    expect(d.fields.address).toMatchObject({ status: "confirmed" });
    expect(jb.usage.calls).toBe(1); // stage b 只計讀 B
    expect(calls).toHaveLength(2);
    expect(calls[1]!.userText).toMatch(/Image 1 is the phone number field/);
  });
  it("stage b（tiles 後備）：images_b_kind=tiles", async () => {
    const { j } = await stageA(formAnswers({ field_boxes: {} }));
    expect(j.documents[0].field_boxes).toEqual({});
    const res = await post(bBody(j.documents[0].continuation, { kind: "tiles", images: [IMG, IMG, IMG, IMG] }));
    const jb = await res.json();
    expect(res.status).toBe(200);
    expect(jb.documents[0].images_b_kind).toBe("tiles");
    expect(jb.documents[0].field_boxes_used).toBe(false);
  });
  it("stage b：篡改／重用／別人／過期 continuation → 400 固定字串", async () => {
    const { j } = await stageA(formAnswers());
    const tok: string = j.documents[0].continuation;
    const MSG = "辨識憑證無效或者已過期，請重新辨識";
    const tampered = `${tok.slice(0, 10)}${tok[10] === "A" ? "B" : "A"}${tok.slice(11)}`;
    const r1 = await post(bBody(tampered, crops));
    expect(r1.status).toBe(400);
    expect((await r1.json()).message).toBe(MSG);
    expect((await post(bBody(tok, crops), other)).status).toBe(400); // 別人
    expect((await post(bBody(tok, crops))).status).toBe(200); // 正常
    const reuse = await post(bBody(tok, crops));
    expect(reuse.status).toBe(400); // 重用
    expect((await reuse.json()).message).toBe(MSG);
    // 過期
    const { j: j2 } = await stageA(formAnswers());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const exp = await post(bBody(j2.documents[0].continuation, crops));
    vi.useRealTimers();
    expect(exp.status).toBe(400);
    expect((await exp.json()).message).toBe(MSG);
  });
  it("stage b：field_crops 嘅 field_of 必須正好係該文件類型嘅裁圖欄位；type 要同 continuation 一致", async () => {
    const { j } = await stageA(formAnswers());
    const tok = j.documents[0].continuation;
    expect((await post(bBody(tok, { kind: "field_crops", images: [IMG], field_of: ["phone"] }))).status).toBe(400);
    const { j: j2 } = await stageA(formAnswers());
    expect((await post(bBody(j2.documents[0].continuation, { kind: "field_crops", images: [IMG, IMG], field_of: ["phone", "phone"] }))).status).toBe(400);
    const { j: j3 } = await stageA(formAnswers());
    expect((await post({ stage: "b", documents: [{ type: "address_proof", continuation: j3.documents[0].continuation, full: IMG, images_b: { kind: "tiles", images: [IMG] } }] })).status).toBe(400);
  });
  it("stage b：圖太多／格式錯 → 400；冇權限 → 403", async () => {
    const { j } = await stageA(formAnswers());
    const tok = j.documents[0].continuation;
    expect((await post(bBody(tok, { kind: "tiles", images: [IMG, IMG, IMG, IMG, IMG] }))).status).toBe(400);
    expect((await post(bBody(tok, { kind: "weird", images: [IMG] }))).status).toBe(400);
    expect((await post(bBody("x".repeat(70_000), crops))).status).toBe(400);
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await post(bBody(tok, crops), broker)).status).toBe(403);
  });
  it("stage b 仲裁用全圖＋分歧欄裁圖；冇 full 就唔仲裁", async () => {
    const answers = formAnswers({ phone: obj("90001111", "low") }, { phone: obj("90001112", "low") }, { arbiter: { phone: obj("90001111", "medium") } });
    const calls: VisionRequest[] = [];
    const { j } = await stageA(answers, calls);
    const jb = await (await post(bBody(j.documents[0].continuation, { kind: "field_crops", images: [IMG + "P", IMG + "A"], field_of: ["phone", "address"] }, IMG + "F"))).json();
    expect(jb.documents[0].fields.phone).toMatchObject({ status: "confirmed", value: "90001111", arbiter: "agree_a" });
    expect(jb.documents[0].arbiter).toEqual({ called: true, fields: 1 });
    expect(calls.at(-1)!.images).toEqual([IMG + "F", IMG + "P"]);
    const { j: j2 } = await stageA(answers);
    const jn = await (await post(bBody(j2.documents[0].continuation, crops, null))).json();
    expect(jn.documents[0].arbiter).toEqual({ called: false, fields: 0 });
    expect(jn.documents[0].fields.phone.status).toBe("review");
  });
  it("舊單次流程（冇 stage）不變：tiles 必填、回 fields；新增 images_b_kind=tiles", async () => {
    setVisionClientForTests(fake("claude", formAnswers(), []));
    const res = await post({ documents: [{ type: "onboarding_form", full: IMG, tiles: [IMG, IMG, IMG, IMG] }] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.documents[0].fields.phone.status).toBe("confirmed");
    expect(j.documents[0].images_b_kind).toBe("tiles");
    expect(j.usage.calls).toBe(2);
    expect((await post({ documents: [{ type: "onboarding_form", full: IMG }] })).status).toBe(400);
  });
  it("audit：stage a／b 都只記計數（field_crops_docs／fallback_tiles_docs），冇值、冇 box 座標、冇 continuation、冇圖", async () => {
    const t0 = new Date();
    const { j } = await stageA(formAnswers());
    const tok: string = j.documents[0].continuation;
    await post(bBody(tok, crops));
    const { j: j2 } = await stageA(formAnswers({ field_boxes: {} }));
    await post(bBody(j2.documents[0].continuation, { kind: "tiles", images: [IMG, IMG, IMG, IMG] }));
    const rows = await prisma.auditLog.findMany({ where: { action: "guard_ocr_read", actorUserId: fx.userIds["老闆"], createdAt: { gte: t0 } }, orderBy: { createdAt: "asc" } });
    const afters = rows.map((r) => r.after as Record<string, unknown>);
    expect(afters.map((a) => a.stage)).toEqual(["a", "b", "a", "b"]);
    expect(afters[1]).toMatchObject({ field_crops_docs: 1, fallback_tiles_docs: 0 });
    expect(afters[3]).toMatchObject({ field_crops_docs: 0, fallback_tiles_docs: 1 });
    expect((afters[0]!.documents as { boxes: number }[])[0]!.boxes).toBe(2);
    expect((afters[2]!.documents as { boxes: number }[])[0]!.boxes).toBe(0);
    const all = JSON.stringify(rows);
    for (const v of ["90001111", "新界火炭", "base64", "/9j/", tok.slice(0, 20), "0.08", '"x":']) expect(all).not.toContain(v);
  });
  it("未配置任何供應商 → 404（stage a）", async () => {
    setVisionClientForTests(null);
    const res = await post({ stage: "a", documents: [{ type: "onboarding_form", full: IMG }] });
    expect(res.status).toBe(404); // 未配置
  });
});

const MAGICK = process.env.MAGICK_BIN || "/opt/homebrew/bin/magick";
const hasMagick = fs.existsSync(MAGICK);
const FIX = path.resolve(__dirname, "fixtures/ocr-eval");
const dimsOfDataUrl = (u: string): [number, number] => {
  const out = execFileSync(MAGICK, ["jpg:-", "-format", "%w %h", "info:"], { input: Buffer.from(u.replace(/^data:image\/jpeg;base64,/, ""), "base64") }).toString().trim().split(" ");
  return [Number(out[0]), Number(out[1])];
};

describe("評估腳本 --flow（兩段式／legacy）＋ Node 裁圖幾何", () => {
  it("parseArgs：預設 two-stage；--flow legacy；非法值拋錯", () => {
    expect(evalParseArgs([])).toMatchObject({ flow: "two-stage" });
    expect(evalParseArgs(["--flow", "legacy"])).toMatchObject({ flow: "legacy" });
    expect(() => evalParseArgs(["--flow", "x"])).toThrow("--flow");
  });
  it.skipIf(!hasMagick)("cropFields（Node）：矩形／輸出尺寸同 planFieldCrops 完全一致；冇有效 box → null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr3-img-"));
    try {
      const img = path.join(dir, "big.png");
      execFileSync(MAGICK, ["-size", "1800x2400", "xc:white", img]);
      const prep = await prepareDocumentImages(img, 1);
      const boxes = { phone: PHONE, address: ADDR };
      const plan = planFieldCrops("onboarding_form", boxes, 1800, 2400);
      expect(plan.kind).toBe("field_crops");
      const r = await prep.cropFields("onboarding_form", boxes);
      expect(r!.fieldOf).toEqual(["phone", "address"]);
      r!.images.forEach((u, i) => {
        const [w, h] = dimsOfDataUrl(u);
        expect([w, h]).toEqual([plan.crops[i]!.out.w, plan.crops[i]!.out.h]);
        expect(Math.max(w, h)).toBeLessThanOrEqual(1000);
        expect(u.length).toBeLessThanOrEqual(900_000);
      });
      expect(await prep.cropFields("onboarding_form", { phone: PHONE })).toBeNull();
      expect(await prep.cropFields("id_card", boxes)).toBeNull();
      expect(await nodeCropFields(Buffer.alloc(0), "id_card", {}).catch(() => "err")).toBe("err"); // 非 PNG 拋錯而唔係靜靜過
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(!hasMagick)("--dry 帶 box manifest：兩段式 field_crops_docs／fallback_tiles_docs 計數；legacy 全 0；console 冇值", async () => {
    const run = async (extra: string[]) => {
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
      try {
        expect(await evalMain(["--dry", "--manifest", path.join(FIX, "manifest.dry-crops.json"), ...extra])).toBe(0);
      } finally {
        spy.mockRestore();
      }
      return logs.join("\n");
    };
    const two = await run([]);
    expect(two).toContain("流程 two-stage｜欄位級裁圖文件 1｜後備 2×2 格文件 2");
    expect(two).toContain("cases 4/4 ok");
    expect(two).toContain("呼叫 8"); // 4 份文件 × (A＋B)
    const legacy = await run(["--flow", "legacy"]);
    expect(legacy).toContain("流程 legacy｜欄位級裁圖文件 0｜後備 2×2 格文件 0");
    for (const v of ["測試甲", "Z900001", "90001111", "示範街", "crop-0", "form.png", "0.1"]) {
      expect(two).not.toContain(v);
      expect(legacy).not.toContain(v);
    }
  });
});
