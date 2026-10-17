// W5：口語對照 UI（下拉＋重覆驗證＋請假詞覆寫）、health 區最近告警、/whatsapp/metrics 指標頁、手機 375px、RBAC。
// 全部假資料：假群 e2e-wa5-g1@g.us、E2E運維盤W5（更別 A／N）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa5-g1@g.us";
const LABEL = "E2E運維群";
const SITE = "E2E運維盤W5";
const BY = "e2e:wa-w5";
const ALERT_KEY = "e2e-wa5:alert";

async function cleanup() {
  await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
  await prisma.whatsappGroup.deleteMany({ where: { groupJid: G1 } });
  await prisma.shiftType.deleteMany({ where: { createdBy: BY } });
  await prisma.site.deleteMany({ where: { createdBy: BY } });
  await prisma.appNotification.deleteMany({ where: { dedupeKey: ALERT_KEY } });
}

test.beforeAll(async () => {
  await cleanup();
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const site = await prisma.site.create({ data: { canonicalName: SITE, clientName: "E2E客戶W5", billingModel: "per_shift", createdBy: BY } });
  await prisma.shiftType.createMany({ data: [{ siteId: site.id, code: "A", label: "早更", createdBy: BY }, { siteId: site.id, code: "N", label: "夜更", createdBy: BY }] });
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: LABEL, createdBy: boss.id, lastMessageAt: new Date() } });
  const now = Date.now();
  await prisma.whatsappMessage.createMany({
    data: [
      { session: "default", chatJid: G1, messageId: "e2e-wa5-1", senderJid: "85290001234@c.us", ts: new Date(now - 3600_000), text: "E2E機密原文", status: "routed", llmProvider: "fake", llmTokensIn: 120, llmTokensOut: 30 },
      { session: "default", chatJid: G1, messageId: "e2e-wa5-2", senderJid: "85290001234@c.us", ts: new Date(now - 7200_000), text: "E2E機密原文", status: "error", error: "process_failed" },
    ],
  });
  await prisma.appNotification.create({ data: { kind: "whatsapp_health", title: "WhatsApp 橋接異常：e2e 測試告警", body: "WAHA session 狀態為 FAILED。", href: "/whatsapp", audience: ["老闆"], dedupeKey: ALERT_KEY } });
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 運維（W5）", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("口語對照：更碼下拉只出該盤更別；重覆詞即時提示＋儲存被擋；請假詞覆寫；儲存後 DB 正確", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    await page.getByTestId("wa-group-card").filter({ hasText: LABEL }).getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await ed.getByLabel("群組類型").selectOption("site");
    await ed.getByLabel("綁定盤口").selectOption({ label: SITE });
    const shiftMap = ed.getByTestId("wa-shift-wordmap");
    await shiftMap.getByRole("button", { name: "加一行" }).click();
    const opts = await shiftMap.getByLabel("口語 → 更碼對照代碼 1").locator("option").allTextContents();
    expect(opts).toEqual(["（揀）", "A", "N"]);
    await shiftMap.getByLabel("口語 → 更碼對照口語 1").fill("夜");
    await shiftMap.getByLabel("口語 → 更碼對照代碼 1").selectOption("N");
    // 重覆詞
    await shiftMap.getByRole("button", { name: "加一行" }).click();
    await shiftMap.getByLabel("口語 → 更碼對照口語 2").fill("夜");
    await shiftMap.getByLabel("口語 → 更碼對照代碼 2").selectOption("A");
    await expect(shiftMap.getByTestId("wa-wordmap-dup").first()).toBeVisible();
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(ed.getByText("口語詞重覆，請修正後再儲存")).toBeVisible();
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } })).kind).toBe("ignored");
    await shiftMap.getByRole("button", { name: "刪除口語 → 更碼對照 2" }).click();
    await expect(shiftMap.getByTestId("wa-wordmap-dup")).toHaveCount(0);
    // 請假詞覆寫
    const leaveMap = ed.getByTestId("wa-leave-wordmap");
    await expect(leaveMap.getByText(/內建：病假→SL/)).toBeVisible();
    await leaveMap.getByRole("button", { name: "加一行" }).click();
    await leaveMap.getByLabel("請假詞對照（可選，覆寫內建）口語 1").fill("病");
    expect(await leaveMap.getByLabel("請假詞對照（可選，覆寫內建）代碼 1").locator("option").allTextContents()).toEqual(["（揀）", "病假 SL", "年假 AL", "事假／無薪 NL", "例假 RD", "公假 SH"]);
    // 只填一半被擋
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(ed.getByText(/只填咗一半/)).toBeVisible();
    await leaveMap.getByLabel("請假詞對照（可選，覆寫內建）代碼 1").selectOption("AL");
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已儲存群組綁定。")).toBeVisible();
    const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } });
    expect(row).toMatchObject({ kind: "site", shiftWordMap: { 夜: "N" }, leaveWordMap: { 病: "AL" } });
    // 重開抽屜：值保留
    await page.getByTestId("wa-group-card").filter({ hasText: LABEL }).getByRole("button", { name: "綁定設定" }).click();
    const ed2 = page.getByTestId("wa-group-editor");
    await expect(ed2.getByTestId("wa-leave-wordmap").getByLabel("請假詞對照（可選，覆寫內建）口語 1")).toHaveValue("病");
    await expect(ed2.getByTestId("wa-leave-wordmap").getByLabel("請假詞對照（可選，覆寫內建）代碼 1")).toHaveValue("AL");
  });

  test("health 區顯示最近告警；有「指標」連結", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    await expect(page.getByTestId("wa-health-alerts")).toContainText("e2e 測試告警");
    await page.getByRole("link", { name: "指標" }).click();
    await expect(page).toHaveURL(/\/whatsapp\/metrics$/);
    await expect(page.getByRole("heading", { name: "WhatsApp 報更指標" })).toBeVisible();
  });

  test("指標頁：整體＋按群數字；7／30 日切換；唔顯示原文", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/metrics");
    const totals = page.getByTestId("wa-metrics-totals");
    await expect(totals).toBeVisible();
    const metric = (scope: ReturnType<typeof page.locator>, k: string) => scope.locator(`[data-metric="${k}"] dd`);
    expect(Number(await metric(totals, "received").textContent())).toBeGreaterThanOrEqual(2);
    const card = page.getByTestId("wa-metrics-group").filter({ hasText: LABEL });
    await expect(card).toBeVisible();
    await expect(metric(card, "received")).toHaveText("2");
    await expect(metric(card, "parsed")).toHaveText("1");
    await expect(metric(card, "llm_tokens_in")).toHaveText("120");
    await expect(metric(card, "llm_tokens_out")).toHaveText("30");
    await expect(metric(card, "errors")).toHaveText("1");
    await page.getByRole("button", { name: "近 30 日" }).click();
    await expect(page.getByRole("button", { name: "近 30 日" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/整體（近 30 日）/)).toBeVisible();
    expect(await page.content()).not.toContain("E2E機密原文");
  });

  test("手機 375px：指標頁同口語對照抽屜無橫向捲動", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/metrics");
    await expect(page.getByTestId("wa-metrics-group").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/whatsapp");
    await page.getByTestId("wa-group-card").filter({ hasText: LABEL }).getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await ed.getByTestId("wa-shift-wordmap").getByRole("button", { name: "加一行" }).click();
    await ed.getByTestId("wa-leave-wordmap").getByRole("button", { name: "加一行" }).click();
    const box = await ed.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    for (const t of ["wa-shift-wordmap", "wa-leave-wordmap"]) {
      const rows = ed.getByTestId(t).getByTestId("wa-wordmap-row");
      const rb = await rows.first().boundingBox();
      expect(rb!.x + rb!.width).toBeLessThanOrEqual(375);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("RBAC：主管可睇指標頁；雞頭 API 403", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/whatsapp/metrics");
    await expect(page.getByTestId("wa-metrics-totals")).toBeVisible();
    await page.context().clearCookies();
    await loginAs(page, "雞頭A");
    expect((await page.request.get("/api/whatsapp/metrics")).status()).toBe(403);
  });
});
