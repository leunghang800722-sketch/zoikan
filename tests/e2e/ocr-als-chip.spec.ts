// WP-OCR-2：地址欄 ALS（政府地址庫）候選 chip 同形近字建議 chip。辨識 API 用 page.route 攔截回合成 JSON（ALS 由伺服器查，e2e 唔打任何外部服務）；
// 上載嘅係 tests/fixtures/ocr-eval/ 合成圖。
import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { loginAs } from "./helpers";

const ID = path.resolve(__dirname, "../fixtures/ocr-eval/id-card.png");
const ADDR = path.resolve(__dirname, "../fixtures/ocr-eval/address-proof.png");

const mk = (value: string) => ({ status: "confirmed", value, candidates: [], candidates_ranked: [] });

function body(withAls: boolean, merged = false) {
  const addr = merged
    ? {
        status: "review",
        value: "九龍青山道999號15樓A室",
        candidates: ["九龍青山道999號15樓A室", "九龍青山道999號16樓A室"],
        candidates_ranked: [
          { value: "九龍青山道999號15樓A室", sources: ["a", "als"], score: 100, reason: "valid", als_score: 90 },
          { value: "九龍青山道999號16樓A室", sources: ["b"], score: 100, reason: "valid" },
        ],
        reason: "reads_differ",
      }
    : withAls
    ? {
        status: "review",
        value: "九龍青山道999號15樓A室",
        candidates: ["九龍青山道999號15樓A室", "九龍青山道999號16樓A室", "深水埗區青山道999號15樓A室"],
        candidates_ranked: [
          { value: "九龍青山道999號15樓A室", sources: ["a"], score: 100, reason: "valid" },
          { value: "九龍青山道999號16樓A室", sources: ["b"], score: 100, reason: "valid" },
          { value: "深水埗區青山道999號15樓A室", sources: ["als"], score: 100, reason: "valid", als_score: 90 },
        ],
        reason: "reads_differ",
      }
    : {
        status: "review",
        value: "九龍柴灣村 5座",
        candidates: ["九龍柴灣村 5座", "九龍柴灣邨 5座"],
        candidates_ranked: [
          { value: "九龍柴灣村 5座", sources: ["a", "b"], score: 105, reason: "valid" },
          { value: "九龍柴灣邨 5座", sources: ["hk_address"], score: 105, reason: "valid" },
        ],
        reason: "address_variant_suggested",
      };
  return {
    model: "fake",
    ms: 100,
    usage: { prompt_tokens: 1, completion_tokens: 1, calls: 3 },
    documents: [
      { type: "id_card", arbiter: { called: false, fields: 0 }, fields: { name_zh: mk("測試甲"), name_en: mk("TEST ALPHA"), hkid: mk("Z900001(2)"), dob: mk("1990-01-15"), sex: mk("M") } },
      { type: "address_proof", arbiter: { called: false, fields: 0 }, als: withAls ? { called: true, candidate: true, failed: false } : { called: false, candidate: false, failed: false }, fields: { address: addr } },
    ],
  };
}

async function toReview(page: Page, withAls: boolean, merged = false) {
  await page.route("**/api/guards/ocr/read", (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body(withAls, merged)) }));
  await loginAs(page, "老闆");
  const res = await page.goto("/guards/new-from-docs");
  test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
  await page.getByTestId("ocr-file-id_card").setInputFiles(ID);
  await page.getByTestId("ocr-file-address_proof").setInputFiles(ADDR);
  await expect(page.getByTestId("ocr-read")).toBeEnabled();
  await page.getByTestId("ocr-read").click();
  await expect(page.getByTestId("ocr-step-review")).toBeVisible();
}

test.describe("地址候選：ALS／形近字建議", () => {
  test("ALS 候選 chip 有細字「政府地址庫」，其他 chip 冇；撳一下套用；預填仍然係原讀數", async ({ page }) => {
    await toReview(page, true);
    const chips = page.getByTestId("ocr-chips-address");
    await expect(chips).toBeVisible();
    await expect(chips.locator("button")).toHaveCount(3);
    await expect(page.getByLabel("地址")).toHaveValue("九龍青山道999號15樓A室");
    await expect(page.getByTestId("ocr-chip-als-address")).toHaveCount(1);
    await expect(page.getByTestId("ocr-chip-address-2")).toContainText("政府地址庫");
    await expect(page.getByTestId("ocr-chip-address-0")).not.toContainText("政府地址庫");
    await page.getByTestId("ocr-chip-address-2").click();
    await expect(page.getByLabel("地址")).toHaveValue("深水埗區青山道999號15樓A室");
  });

  test("N4：ALS 值同某個讀數合併 → chip 顯示「讀數＋政府地址庫」", async ({ page }) => {
    await toReview(page, true, true);
    await expect(page.getByTestId("ocr-chip-address-0")).toContainText("讀數＋政府地址庫");
    await expect(page.getByTestId("ocr-chip-address-1")).not.toContainText("政府地址庫");
  });

  test("形近字建議：原文同建議只差 1 字 → 高亮分歧字；冇 ALS 標示", async ({ page }) => {
    await toReview(page, false);
    await expect(page.getByTestId("ocr-chips-address").locator("button")).toHaveCount(2);
    await expect(page.getByTestId("ocr-chip-address-0").locator("mark[data-diff]")).toHaveText("村");
    await expect(page.getByTestId("ocr-chip-address-1").locator("mark[data-diff]")).toHaveText("邨");
    await expect(page.getByTestId("ocr-chip-als-address")).toHaveCount(0);
    await page.getByTestId("ocr-chip-address-1").click();
    await expect(page.getByLabel("地址")).toHaveValue("九龍柴灣邨 5座");
  });

  test.describe("手機 375px", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test("ALS chip 喺 375 闊內、冇橫向捲動", async ({ page }) => {
      await toReview(page, true);
      await page.getByTestId("ocr-chips-address").scrollIntoViewIfNeeded();
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.iw);
      for (let i = 0; i < 3; i++) {
        const box = await page.getByTestId(`ocr-chip-address-${i}`).boundingBox();
        expect(box).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      }
    });
  });
});
