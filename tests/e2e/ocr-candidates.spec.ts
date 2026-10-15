// WP-OCR-4：證件新增保安員——review 欄候選 chip（一撳套用）、字級分歧高亮、關鍵欄仍要「對過證件」、舊格式回應相容、手機 375px。
// 辨識 API 用 page.route 攔截回合成 JSON（唔打任何 AI）；上載嘅係 tests/fixtures/ocr-eval/ 合成圖。
import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { loginAs } from "./helpers";

const IMG = path.resolve(__dirname, "../fixtures/ocr-eval/id-card.png");
const ranked = (...vals: string[]) => vals.map((value, i) => ({ value, sources: [i === 0 ? "a" : "b"], score: 100 - i, reason: "valid" }));

function body(over: { newFormat: boolean }) {
  const confirmed = { status: "confirmed", value: "", candidates: [], candidates_ranked: [] };
  const mk = (value: string) => ({ ...confirmed, value });
  const review = (value: string, vals: string[], reason = "reads_differ") =>
    over.newFormat ? { status: "review", value, candidates: vals, candidates_ranked: ranked(...vals), reason } : { status: "review", value, candidates: vals, reason };
  return {
    model: "fake",
    ms: 100,
    usage: { prompt_tokens: 1, completion_tokens: 1, calls: 3 },
    documents: [
      {
        type: "id_card",
        arbiter: { called: true, fields: 1 },
        fields: {
          name_zh: review("測試申", ["測試申", "測試甲", "測試由"]),
          name_en: mk("TEST ALPHA"),
          hkid: review("Z900001(2)", ["Z900001(2)", "Z900001(3)"]),
          dob: mk("1990-01-15"),
          sex: mk("M"),
        },
      },
    ],
  };
}

async function toReview(page: Page, newFormat: boolean) {
  await page.route("**/api/guards/ocr/read", (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body({ newFormat })) }));
  await loginAs(page, "老闆");
  const res = await page.goto("/guards/new-from-docs");
  test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁）");
  await page.getByTestId("ocr-file-id_card").setInputFiles(IMG);
  await expect(page.getByTestId("ocr-read")).toBeEnabled();
  await page.getByTestId("ocr-read").click();
  await expect(page.getByTestId("ocr-step-review")).toBeVisible();
}

test.describe("OCR 候選 chip", () => {
  test("撳候選 chip 套用；分歧字高亮；關鍵欄套用後仍要撳「對過證件，啱」", async ({ page }) => {
    await toReview(page, true);
    const chips = page.getByTestId("ocr-chips-name_zh");
    await expect(chips).toBeVisible();
    // 候選 3 個，第一個（最高分）已預填
    await expect(chips.locator("button")).toHaveCount(3);
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試申");
    await expect(page.getByTestId("ocr-chip-name_zh-0")).toHaveAttribute("aria-pressed", "true");
    // 中文姓名候選只差 1 字 → 高亮分歧字
    await expect(page.getByTestId("ocr-chip-name_zh-1").locator("mark[data-diff]")).toHaveText("甲");
    // 撳第 2 個候選 → 套用
    await page.getByTestId("ocr-chip-name_zh-1").click();
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
    await expect(page.getByTestId("ocr-chip-name_zh-1")).toHaveAttribute("aria-pressed", "true");
    // ackAfterEdit 規則不變：關鍵欄套用後仍未確認
    await expect(page.getByTestId("ocr-field-name_zh")).toHaveAttribute("data-ack", "0");
    await page.getByTestId("ocr-ack-name_zh").click();
    await expect(page.getByTestId("ocr-field-name_zh")).toHaveAttribute("data-ack", "1");
    // 身份證號候選：非中文欄冇高亮
    await expect(page.getByTestId("ocr-chips-hkid").locator("mark")).toHaveCount(0);
    await page.getByTestId("ocr-chip-hkid-1").click();
    await expect(page.getByLabel("身份證號")).toHaveValue("Z900001(3)");
    await expect(page.getByTestId("ocr-field-hkid")).toHaveAttribute("data-ack", "0");
  });

  test("舊格式回應（冇 candidates_ranked）照樣出 chip", async ({ page }) => {
    await toReview(page, false);
    await expect(page.getByTestId("ocr-chips-name_zh").locator("button")).toHaveCount(3);
    await page.getByTestId("ocr-chip-name_zh-2").click();
    await expect(page.getByLabel("中文姓名")).toHaveValue("測試由");
  });

  test.describe("手機 375px", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    test("chip 喺 375 闊內、冇橫向捲動、可撳", async ({ page }) => {
      await toReview(page, true);
      const chips = page.getByTestId("ocr-chips-name_zh");
      await chips.scrollIntoViewIfNeeded();
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(w.sw).toBeLessThanOrEqual(w.iw);
      for (let i = 0; i < 3; i++) {
        const box = await page.getByTestId(`ocr-chip-name_zh-${i}`).boundingBox();
        expect(box).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
        expect(box!.height).toBeGreaterThanOrEqual(24);
      }
      await page.getByTestId("ocr-chip-name_zh-1").click();
      await expect(page.getByLabel("中文姓名")).toHaveValue("測試甲");
    });
  });
});
