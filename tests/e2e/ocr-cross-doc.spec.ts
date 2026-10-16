// WP-OCR-1：證件新增保安員——先讀印刷證件（取 refs_token）→ 入職表 stage a／stage b 都帶 refs_token → 交叉核對顯示（一致 ✓／唔一致 ⚠／手寫讀唔到）；
// OCR-1.3：差異只係中度提示（以證件／住址證明為準），唔加鎖；手機 375px。辨識 API 用 page.route 攔截回合成 JSON（唔打任何 AI）；上載嘅係 tests/fixtures/ocr-eval/ 合成圖。
import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { loginAs } from "./helpers";

const ID_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/id-card.png");
const FORM_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/form.png");
const PROOF_IMG = path.resolve(__dirname, "../fixtures/ocr-eval/address-proof.png");
const PROOF_ADDR = "新界火炭示範街99號虛構大廈15樓A室";
const FORM_ADDR = "新界火炭示範街98號虛構大廈15樓A室";
const BOXES = {
  phone: { x: 0.1, y: 0.5, w: 0.5, h: 0.05 },
  address: { x: 0.1, y: 0.6, w: 0.8, h: 0.08 },
  name_zh: { x: 0.1, y: 0.1, w: 0.4, h: 0.04 },
  hkid: { x: 0.1, y: 0.18, w: 0.4, h: 0.04 },
  dob: { x: 0.1, y: 0.26, w: 0.4, h: 0.04 },
};
const fld = (value: string, extra: Record<string, unknown> = {}) => ({ status: "confirmed", value, candidates: [], candidates_ranked: [], ...extra });
const idFields = { name_zh: fld("測試甲"), name_en: fld("TEST ALPHA"), hkid: fld("Z900001(2)"), dob: fld("1990-01-15"), sex: fld("M") };
const formFields = (hkid: string, withProof = false) => ({
  phone: fld("90001111"),
  address: withProof ? fld(FORM_ADDR, { cross: { against: "address_proof", result: "differs" } }) : fld(PROOF_ADDR),
  name_zh: fld("測試甲", { cross: { against: "id_card", result: "match" } }),
  hkid: fld(hkid, { cross: { against: "id_card", result: hkid === "Z900001(2)" ? "match" : "differs" } }),
  dob: { status: "missing", value: "", candidates: [], candidates_ranked: [], reason: "unclear", cross: { against: "id_card", result: "unreadable" } },
});

interface Req {
  stage: string;
  refs_token?: string;
  documents: { type: string; tiles?: string[]; continuation?: string; images_b?: { kind: string; images: string[]; field_of?: string[] } }[];
}

async function install(page: Page, log: Req[], opts: { refsToken: string | null; formHkid: string; withProof?: boolean }) {
  await page.route("**/api/guards/ocr/read", async (route: Route) => {
    const body = route.request().postDataJSON() as Req;
    log.push(body);
    const json = (status: number, o: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(o) });
    const base = { model: "fake", ms: 10, usage: { prompt_tokens: 1, completion_tokens: 1, calls: 1 } };
    if (body.stage === "a" && body.documents[0]!.type !== "onboarding_form") {
      return json(200, {
        stage: "a",
        ...base,
        ...(opts.refsToken ? { refs_token: opts.refsToken } : {}),
        documents: body.documents.map((d) => ({ type: d.type, final: true, fields: d.type === "id_card" ? idFields : { address: fld(PROOF_ADDR) }, images_b_kind: "tiles", field_boxes_used: false, arbiter: { called: false, fields: 0 } })),
      });
    }
    if (body.stage === "a") return json(200, { stage: "a", ...base, documents: [{ type: "onboarding_form", field_boxes: BOXES, continuation: "fake-continuation" }] });
    if (body.stage === "b") {
      const hasRefs = !!body.refs_token;
      return json(200, {
        ...base,
        documents: [{ type: "onboarding_form", fields: hasRefs ? formFields(opts.formHkid, !!opts.withProof) : { phone: fld("90001111"), address: fld("新界火炭示範街99號虛構大廈15樓A室"), name_zh: fld("測試甲"), hkid: fld(opts.formHkid), dob: fld("1990-01-15") }, images_b_kind: body.documents[0]!.images_b!.kind, field_boxes_used: true, arbiter: { called: false, fields: 0 } }],
        ...(hasRefs
          ? { id_cross: { name_zh: { against: "onboarding_form", result: "match" }, hkid: { against: "onboarding_form", result: opts.formHkid === "Z900001(2)" ? "match" : "differs" }, dob: { against: "onboarding_form", result: "unreadable" } } }
          : {}),
      });
    }
    return json(400, { error: "bad_request", message: "unexpected" });
  });
}

async function toReview(page: Page, withProof = false) {
  await loginAs(page, "老闆");
  const res = await page.goto("/guards/new-from-docs");
  test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
  await page.getByTestId("ocr-file-id_card").setInputFiles(ID_IMG);
  await expect(page.getByTestId("ocr-read")).toBeEnabled();
  if (withProof) await page.getByTestId("ocr-file-address_proof").setInputFiles(PROOF_IMG);
  await page.getByTestId("ocr-file-onboarding_form").setInputFiles(FORM_IMG);
  await expect(page.getByAltText("入職表預覽")).toBeVisible();
  await page.getByTestId("ocr-read").click();
  await expect(page.getByTestId("ocr-step-review")).toBeVisible();
}

test.describe("OCR 跨文件上下文＋交叉核對", () => {
  test("全流程：身份證先讀 → 入職表 stage a／b 帶 refs_token；手寫 HKID 唔一致只顯示提示，最終值仍係身份證", async ({ page }) => {
    const log: Req[] = [];
    await install(page, log, { refsToken: "fake-refs-token", formHkid: "Z900002(0)" });
    await toReview(page);
    expect(log.map((l) => l.stage)).toEqual(["a", "a", "b"]);
    expect(log[0]!.documents.map((d) => d.type)).toEqual(["id_card"]);
    expect(log[0]!.refs_token).toBeUndefined();
    expect(log[1]!.documents.map((d) => d.type)).toEqual(["onboarding_form"]);
    expect(log[1]!.refs_token).toBe("fake-refs-token"); // 入職表讀 A 收到 refs
    expect(log[2]!.refs_token).toBe("fake-refs-token");
    // 5 張欄位級裁圖（電話、地址、姓名、HKID、出生日期）
    expect(log[2]!.documents[0]!.images_b!.kind).toBe("field_crops");
    expect(log[2]!.documents[0]!.images_b!.field_of).toEqual(["phone", "address", "name_zh", "hkid", "dob"]);
    expect(log[2]!.documents[0]!.images_b!.images).toHaveLength(5);
    // 身份證值唔被入職表覆蓋
    await expect(page.getByLabel("身份證號")).toHaveValue("Z900001(2)");
    // 交叉核對顯示
    await expect(page.getByTestId("ocr-cross-name_zh")).toHaveAttribute("data-result", "match");
    await expect(page.getByTestId("ocr-cross-name_zh")).toContainText("✓");
    await expect(page.getByTestId("ocr-cross-hkid")).toHaveAttribute("data-result", "differs");
    await expect(page.getByTestId("ocr-form-value-hkid")).toContainText("Z900002(0)");
    await expect(page.getByTestId("ocr-cross-dob")).toHaveAttribute("data-result", "unreadable");
    await expect(page.getByTestId("ocr-cross-dob")).toContainText("手寫讀唔到");
    // OCR-1.3：differs 只係中度提示（warning），唔改值、唔額外加鎖；關鍵欄照原本規則逐個撳『對過證件，啱』
    await expect(page.getByTestId("ocr-cross-hkid")).toContainText("入職表手寫同證件唔同，已以證件為準");
    await expect(page.getByTestId("ocr-cross-hkid")).not.toContainText("⚠");
    await expect(page.getByTestId("ocr-ack-hkid")).toHaveText("對過證件，啱");
    await expect(page.getByTestId("ocr-to-preview")).toBeDisabled(); // 同其他關鍵欄一樣，要逐個確認
    for (const k of ["name_zh", "hkid", "dob"]) await page.getByTestId(`ocr-ack-${k}`).click();
    await expect(page.getByTestId("ocr-problems")).toHaveCount(0);
    await expect(page.getByTestId("ocr-to-preview")).toBeEnabled();
    await expect(page.getByLabel("身份證號")).toHaveValue("Z900001(2)"); // 最終仍然係身份證值
  });

  test("OCR-1.3：有住址證明 → 地址用住址證明值；入職表手寫地址唔同只顯示提示『已以住址證明為準』（唔阻提交）", async ({ page }) => {
    const log: Req[] = [];
    await install(page, log, { refsToken: "fake-refs-token", formHkid: "Z900001(2)", withProof: true });
    await toReview(page, true);
    expect(log[0]!.documents.map((d) => d.type)).toEqual(["id_card", "address_proof"]);
    await expect(page.getByLabel("地址")).toHaveValue(PROOF_ADDR);
    await expect(page.getByTestId("ocr-cross-address")).toHaveAttribute("data-result", "differs");
    await expect(page.getByTestId("ocr-cross-address")).toContainText("已以住址證明為準");
    await expect(page.getByTestId("ocr-form-value-address")).toContainText(FORM_ADDR);
    for (const k of ["name_zh", "hkid", "dob"]) await page.getByTestId(`ocr-ack-${k}`).click();
    await expect(page.getByTestId("ocr-to-preview")).toBeEnabled();
  });

  test("一致：顯示『同身份證一致 ✓』，仍然要逐個關鍵欄撳『對過證件，啱』", async ({ page }) => {
    const log: Req[] = [];
    await install(page, log, { refsToken: "fake-refs-token", formHkid: "Z900001(2)" });
    await toReview(page);
    await expect(page.getByTestId("ocr-cross-hkid")).toHaveAttribute("data-result", "match");
    await expect(page.getByTestId("ocr-cross-hkid")).toContainText("同身份證一致 ✓");
    await expect(page.getByTestId("ocr-ack-hkid")).toHaveText("對過證件，啱");
    await expect(page.getByTestId("ocr-to-preview")).toBeDisabled();
  });

  test("舊 server（冇 refs_token／冇 cross）：入職表 stage a／b 唔帶 refs_token，畫面冇交叉核對行", async ({ page }) => {
    const log: Req[] = [];
    await install(page, log, { refsToken: null, formHkid: "Z900001(2)" });
    await toReview(page);
    expect(log.map((l) => l.stage)).toEqual(["a", "a", "b"]);
    expect(log[1]!.refs_token).toBeUndefined();
    expect(log[2]!.refs_token).toBeUndefined();
    await expect(page.getByTestId("ocr-cross-hkid")).toHaveCount(0);
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
  });

  test.describe("手機 375px", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test("交叉核對提示行（含地址）、手寫值、ack 掣喺 375 闊內，冇橫向捲動", async ({ page }) => {
      const log: Req[] = [];
      await install(page, log, { refsToken: "fake-refs-token", formHkid: "Z900002(0)", withProof: true });
      await toReview(page, true);
      for (const k of ["name_zh", "hkid", "dob", "address"]) {
        const el = page.getByTestId(`ocr-cross-${k}`);
        await expect(el).toBeVisible();
        const box = await el.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      }
      const ack = await page.getByTestId("ocr-ack-hkid").boundingBox();
      expect(ack!.x + ack!.width).toBeLessThanOrEqual(375);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.iw);
    });
  });
});
