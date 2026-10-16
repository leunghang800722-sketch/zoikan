// WP-OCR-1.4：證件欄讀唔到／待覆核時，入職表手寫值做唯讀參考（唔自動填、來源仍係證件）；一撳「用呢個值填入」＝人手改值，關鍵欄仍要「對過證件」。
// 辨識 API 用 page.route 攔截回合成 JSON（唔打任何 AI）。
import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { loginAs } from "./helpers";

const ID_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/id-card.png");
const FORM_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/form.png");
const PROOF_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/address-proof.png");
const BOXES = {
  phone: { x: 0.1, y: 0.5, w: 0.5, h: 0.05 },
  address: { x: 0.1, y: 0.6, w: 0.8, h: 0.08 },
  name_zh: { x: 0.1, y: 0.1, w: 0.4, h: 0.04 },
  hkid: { x: 0.1, y: 0.18, w: 0.4, h: 0.04 },
  dob: { x: 0.1, y: 0.26, w: 0.4, h: 0.04 },
};
const fld = (value: string, extra: Record<string, unknown> = {}) => ({ status: "confirmed", value, candidates: [], candidates_ranked: [], ...extra });
const missing = { status: "missing", value: "", candidates: [], candidates_ranked: [], reason: "unclear" };
// 身份證：HKID 讀唔到（missing）、中文姓名待覆核（review，預填 測試甲）、出生日期 confirmed
const idFields = {
  name_zh: { status: "review", value: "測試甲", candidates: ["測試甲", "測試乙"], candidates_ranked: [], reason: "reads_differ" },
  name_en: fld("TEST ALPHA"),
  hkid: missing,
  dob: fld("1990-01-15"),
  sex: fld("M"),
};
const proofAddr = { status: "review", value: "新界火炭示範街99號虛構大廈15樓A室", candidates: ["新界火炭示範街99號虛構大廈15樓A室"], candidates_ranked: [], reason: "reads_differ" };
const FORM_ADDR = "新界火炭示範街98號虛構大廈15樓A室";
const formFields = { phone: fld("90001111"), address: fld(FORM_ADDR), name_zh: fld("測試丙"), hkid: fld("Z900001(2)"), dob: fld("1990-01-15") };

async function install(page: Page) {
  await page.route("**/api/guards/ocr/read", async (route: Route) => {
    const body = route.request().postDataJSON() as { stage?: string; documents: { type: string }[] };
    const json = (o: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    const base = { model: "fake", ms: 10, usage: { prompt_tokens: 1, completion_tokens: 1, calls: 1 } };
    if (body.stage === "a" && body.documents[0]!.type !== "onboarding_form") {
      // 無 confirmed 欄位 refs：刻意唔回 refs_token（身份證 HKID 讀唔到）→ 入職表冇 cross
      return json({ stage: "a", ...base, documents: body.documents.map((d) => ({ type: d.type, final: true, fields: d.type === "id_card" ? idFields : { address: proofAddr }, images_b_kind: "tiles", field_boxes_used: false, arbiter: { called: false, fields: 0 } })) });
    }
    if (body.stage === "a") return json({ stage: "a", ...base, documents: [{ type: "onboarding_form", field_boxes: BOXES, continuation: "fake-continuation" }] });
    return json({ ...base, documents: [{ type: "onboarding_form", fields: formFields, images_b_kind: "field_crops", field_boxes_used: true, arbiter: { called: false, fields: 0 } }] });
  });
}

async function toReview(page: Page) {
  await install(page);
  await loginAs(page, "老闆");
  const res = await page.goto("/guards/new-from-docs");
  test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
  await page.getByTestId("ocr-file-id_card").setInputFiles(ID_IMG);
  await page.getByTestId("ocr-file-address_proof").setInputFiles(PROOF_IMG);
  await page.getByTestId("ocr-file-onboarding_form").setInputFiles(FORM_IMG);
  await expect(page.getByAltText("入職表預覽")).toBeVisible();
  await page.getByTestId("ocr-read").click();
  await expect(page.getByTestId("ocr-step-review")).toBeVisible();
}

test.describe("證件欄讀唔到／待覆核：入職表手寫值做唯讀參考", () => {
  test("顯示參考但唔自動填；一撳填入後關鍵欄仍要『對過證件』；地址（住址證明待覆核）同樣", async ({ page }) => {
    await toReview(page);
    // HKID（身份證 missing）：欄位仍然空、來源仍係證件；顯示手寫參考
    await expect(page.getByLabel("身份證號")).toHaveValue("");
    await expect(page.getByTestId("ocr-form-ref-hkid")).toContainText("入職表手寫（參考）：Z900001(2)");
    // 中文姓名（身份證 review）：預填值唔變，手寫值只做參考
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
    await expect(page.getByTestId("ocr-form-ref-name_zh")).toContainText("測試丙");
    // 出生日期 confirmed、冇 cross（冇 refs）→ 唔顯示參考
    await expect(page.getByTestId("ocr-form-ref-dob")).toHaveCount(0);
    // 地址：用住址證明（review）值，手寫地址做參考
    await expect(page.getByLabel("地址")).toHaveValue("新界火炭示範街99號虛構大廈15樓A室");
    await expect(page.getByTestId("ocr-form-ref-address")).toContainText(FORM_ADDR);
    // 一撳填入 HKID＝人手改值：值入咗，但關鍵欄仍然未確認（要撳『對過證件，啱』）
    await page.getByTestId("ocr-use-form-hkid").click();
    await expect(page.getByLabel("身份證號")).toHaveValue("Z900001(2)");
    await expect(page.getByTestId("ocr-field-hkid")).toHaveAttribute("data-ack", "0");
    await expect(page.getByTestId("ocr-use-form-hkid")).toHaveCount(0); // 已經等於參考值，唔再出掣
    await expect(page.getByTestId("ocr-ack-hkid")).toHaveText("對過證件，啱");
    await expect(page.getByTestId("ocr-to-preview")).toBeDisabled();
    // 姓名：填入後同樣要重新對過證件
    await page.getByTestId("ocr-use-form-name_zh").click();
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試丙");
    await expect(page.getByTestId("ocr-field-name_zh")).toHaveAttribute("data-ack", "0");
    // 地址填入：非關鍵欄，沿用現有規則（改值後有值即算確認）
    await page.getByTestId("ocr-use-form-address").click();
    await expect(page.getByLabel("地址")).toHaveValue(FORM_ADDR);
    for (const k of ["name_zh", "hkid", "dob"]) await page.getByTestId(`ocr-ack-${k}`).click();
    await expect(page.getByTestId("ocr-to-preview")).toBeEnabled();
  });

  test.describe("手機 375px", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test("參考行同『用呢個值填入』掣喺 375 闊內，冇橫向捲動", async ({ page }) => {
      await toReview(page);
      for (const k of ["hkid", "name_zh", "address"]) {
        const row = page.getByTestId(`ocr-form-ref-${k}`);
        await expect(row).toBeVisible();
        const b = await row.boundingBox();
        expect(b!.x).toBeGreaterThanOrEqual(0);
        expect(b!.x + b!.width).toBeLessThanOrEqual(375);
        const btn = await page.getByTestId(`ocr-use-form-${k}`).boundingBox();
        expect(btn!.x + btn!.width).toBeLessThanOrEqual(375);
      }
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.iw);
    });
  });
});
