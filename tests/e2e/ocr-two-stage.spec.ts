// WP-OCR-3：證件新增保安員——兩段式讀（stage a 定位欄位 → 瀏覽器欄位級裁圖 → stage b）、box 缺失走後備 2×2 格、
// stage b 失敗退回舊單次流程（用戶無感）、手機 375px。辨識 API 用 page.route 攔截回合成 JSON（唔打任何 AI）；
// 上載嘅係 tests/fixtures/ocr-eval/ 合成圖。
import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { loginAs } from "./helpers";

const ID_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/id-card.png");
const FORM_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/form.png");
const PHONE_BOX = { x: 0.1, y: 0.2, w: 0.5, h: 0.05 };
const ADDR_BOX = { x: 0.1, y: 0.35, w: 0.8, h: 0.08 };

/** JPEG data URL → [w,h]（讀 SOF marker）。 */
function jpegSize(dataUrl: string): [number, number] {
  const buf = Buffer.from(dataUrl.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error("bad jpeg");
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error("no SOF");
}

interface ReqLog {
  stage: string;
  body: { documents: { type: string; continuation?: string; full?: string; tiles?: string[]; images_b?: { kind: string; images: string[]; field_of?: string[] } }[] };
}

const idFields = {
  name_zh: { status: "confirmed", value: "測試甲", candidates: [], candidates_ranked: [] },
  name_en: { status: "confirmed", value: "TEST ALPHA", candidates: [], candidates_ranked: [] },
  hkid: { status: "confirmed", value: "Z900001(2)", candidates: [], candidates_ranked: [] },
  dob: { status: "confirmed", value: "1990-01-15", candidates: [], candidates_ranked: [] },
  sex: { status: "confirmed", value: "M", candidates: [], candidates_ranked: [] },
};
const formFields = {
  phone: { status: "confirmed", value: "90001111", candidates: [], candidates_ranked: [] },
  address: { status: "confirmed", value: "新界火炭示範街99號虛構大廈15樓A室", candidates: [], candidates_ranked: [] },
};

interface Mode {
  boxes: "ok" | "none";
  stageB: "ok" | "fail400";
}

async function install(page: Page, log: ReqLog[], mode: Mode) {
  await page.route("**/api/guards/ocr/read", async (route: Route) => {
    const body = route.request().postDataJSON() as { stage?: string; documents: ReqLog["body"]["documents"] };
    log.push({ stage: body.stage ?? "legacy", body });
    const json = (status: number, o: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    if (body.stage === "a") {
      return json(200, {
        stage: "a",
        model: "fake",
        ms: 10,
        usage: { prompt_tokens: 1, completion_tokens: 1, calls: body.documents.length },
        // 驗收 S3：身份證／住址證明由伺服器直接讀完（final:true）；入職表出 box＋continuation
        documents: body.documents.map((d) =>
          d.type === "onboarding_form"
            ? { type: d.type, field_boxes: mode.boxes === "ok" ? { phone: PHONE_BOX, address: ADDR_BOX } : {}, continuation: `fake-continuation-${d.type}` }
            : { type: d.type, final: true, fields: idFields, images_b_kind: "tiles", field_boxes_used: false, arbiter: { called: false, fields: 0 } },
        ),
      });
    }
    if (body.stage === "b") {
      if (mode.stageB === "fail400") return json(400, { error: "bad_request", message: "辨識憑證無效或者已過期，請重新辨識" });
      return json(200, {
        model: "fake",
        ms: 20,
        usage: { prompt_tokens: 1, completion_tokens: 1, calls: body.documents.length },
        documents: body.documents.map((d) => ({ type: d.type, fields: d.type === "id_card" ? idFields : formFields, images_b_kind: d.images_b!.kind, field_boxes_used: d.images_b!.kind === "field_crops", arbiter: { called: false, fields: 0 } })),
      });
    }
    // 舊單次流程
    return json(200, {
      model: "fake",
      ms: 30,
      usage: { prompt_tokens: 1, completion_tokens: 1, calls: body.documents.length * 2 },
      documents: body.documents.map((d) => ({ type: d.type, fields: d.type === "id_card" ? idFields : formFields, images_b_kind: "tiles", field_boxes_used: false, arbiter: { called: false, fields: 0 } })),
    });
  });
}

async function toReview(page: Page) {
  await loginAs(page, "老闆");
  const res = await page.goto("/guards/new-from-docs");
  test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
  await page.getByTestId("ocr-file-id_card").setInputFiles(ID_IMG);
  await expect(page.getByTestId("ocr-read")).toBeEnabled();
  await page.getByTestId("ocr-file-onboarding_form").setInputFiles(FORM_IMG);
  await expect(page.getByAltText("入職表預覽")).toBeVisible();
  await page.getByTestId("ocr-read").click();
  await expect(page.getByTestId("ocr-step-review")).toBeVisible();
}

test.describe("OCR 兩段式讀（欄位級裁圖）", () => {
  test("stage a → 欄位級裁圖（電話、地址各一張 ≤1,000px）→ stage b；身份證仍用 2×2 格；UI 顯示『欄位級』", async ({ page }) => {
    const log: ReqLog[] = [];
    await install(page, log, { boxes: "ok", stageB: "ok" });
    await toReview(page);
    expect(log.map((l) => l.stage)).toEqual(["a", "b"]);
    // stage a：入職表淨傳全圖；身份證連 2×2 格（伺服器直接讀完）
    for (const d of log[0]!.body.documents) {
      expect(d.full).toMatch(/^data:image\/jpeg;base64,/);
      if (d.type === "onboarding_form") expect(d.tiles).toBeUndefined();
      else expect(d.tiles).toHaveLength(4);
    }
    const b = log[1]!.body.documents;
    expect(b.map((d) => d.type)).toEqual(["onboarding_form"]); // 身份證唔打 stage b
    const form = b.find((d) => d.type === "onboarding_form")!;
    expect(form.continuation).toBe("fake-continuation-onboarding_form");
    expect(form.full).toMatch(/^data:image\/jpeg;base64,/);
    expect(form.images_b!.kind).toBe("field_crops");
    expect(form.images_b!.field_of).toEqual(["phone", "address"]);
    expect(form.images_b!.images).toHaveLength(2);
    for (const u of form.images_b!.images) {
      const [w, h] = jpegSize(u);
      expect(Math.max(w, h)).toBeLessThanOrEqual(1000);
      expect(Math.max(w, h)).toBeGreaterThan(50);
    }
    // 欄位格係闊扁形（電話 box 闊 > 高），唔係 2×2 格嘅 0.6×0.6 近正方形
    const [pw, ph] = jpegSize(form.images_b!.images[0]!);
    expect(pw).toBeGreaterThan(ph);
    await expect(page.getByTestId("ocr-b-kind")).toHaveAttribute("data-kind", "field_crops");
    await expect(page.getByTestId("ocr-b-kind")).toHaveText("放大圖：欄位級");
    // 結果照樣填入表單
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
  });

  test("讀 A 冇回報 box → 後備 2×2 格（UI 顯示『後備格』）", async ({ page }) => {
    const log: ReqLog[] = [];
    await install(page, log, { boxes: "none", stageB: "ok" });
    await toReview(page);
    expect(log.map((l) => l.stage)).toEqual(["a", "b"]);
    const form = log[1]!.body.documents.find((d) => d.type === "onboarding_form")!;
    expect(form.images_b!.kind).toBe("tiles");
    expect(form.images_b!.images).toHaveLength(4);
    await expect(page.getByTestId("ocr-b-kind")).toHaveText("放大圖：後備格");
  });

  test("stage b 失敗（400）→ 自動退回舊單次流程，用戶無感，照樣出結果", async ({ page }) => {
    const log: ReqLog[] = [];
    await install(page, log, { boxes: "ok", stageB: "fail400" });
    await toReview(page);
    expect(log.map((l) => l.stage)).toEqual(["a", "b", "legacy"]);
    // 舊流程 body：full＋tiles（每份 4 格），冇 stage
    for (const d of log[2]!.body.documents) expect(d.tiles).toHaveLength(4);
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
    await expect(page.getByTestId("ocr-b-kind")).toHaveText("放大圖：後備格");
    await expect(page.getByTestId("ocr-step-review")).toBeVisible();
  });

  test("stage a 回 429／503 → 唔退回舊流程，直接顯示錯誤（驗收 N2）", async ({ page }) => {
    const log: ReqLog[] = [];
    await page.route("**/api/guards/ocr/read", async (route: Route) => {
      const body = route.request().postDataJSON() as { stage?: string; documents: ReqLog["body"]["documents"] };
      log.push({ stage: body.stage ?? "legacy", body });
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ocr_unavailable", message: "證件辨識暫時用唔到，請改為全部自己輸入，或者遲啲再試" }) });
    });
    await loginAs(page, "老闆");
    const res = await page.goto("/guards/new-from-docs");
    test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
    await page.getByTestId("ocr-file-id_card").setInputFiles(ID_IMG);
    await expect(page.getByTestId("ocr-read")).toBeEnabled();
    await page.getByTestId("ocr-read").click();
    await expect(page.getByText("證件辨識暫時用唔到")).toBeVisible();
    expect(log.map((l) => l.stage)).toEqual(["a"]); // 冇再打舊流程
  });

  test.describe("手機 375px", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test("兩段式流程喺 375 闊內跑通、冇橫向捲動、放大圖標示可見", async ({ page }) => {
      const log: ReqLog[] = [];
      await install(page, log, { boxes: "ok", stageB: "ok" });
      await toReview(page);
      expect(log.map((l) => l.stage)).toEqual(["a", "b"]);
      const label = page.getByTestId("ocr-b-kind");
      await expect(label).toBeVisible();
      const box = await label.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.iw);
    });
  });
});
