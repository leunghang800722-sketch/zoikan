// W0：/whatsapp 頁——群組綁定流程、訊息清單（編輯／撤回標示、唔顯示原文）、health、RBAC、手機 375px。
// 全部假資料：假群 e2e-wa-g1@g.us、假電話尾號、假名「測試甲」。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa-g1@g.us";
const G2 = "e2e-wa-g2@g.us";

async function cleanup() {
  await prisma.whatsappMessage.deleteMany({ where: { chatJid: { in: [G1, G2] } } });
  await prisma.whatsappGroup.deleteMany({ where: { groupJid: { in: [G1, G2] } } });
}

async function seed() {
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  await prisma.whatsappGroup.createMany({
    data: [
      { groupJid: G1, label: "E2E測試群一", createdBy: boss.id, lastMessageAt: new Date() },
      { groupJid: G2, label: "E2E測試群二", createdBy: boss.id },
    ],
  });
  const now = Date.now();
  const mk = (id: string, over: Record<string, unknown> = {}) => ({ session: "default", chatJid: G1, messageId: `e2e-wa-${id}`, senderJid: "85290001234@c.us", senderTelNorm: "90001234", ts: new Date(now - Number(id) * 1000), text: `E2E機密原文${id}`, ...over });
  await prisma.whatsappMessage.createMany({
    data: [
      mk("1"),
      mk("2", { status: "revoked", revokedAt: new Date() }),
      mk("3", { revision: 2, editedAt: new Date() }),
      mk("4", { status: "ignored", ignoreReason: "stale" }),
      mk("5", { chatJid: G2, mediaType: "image" }),
    ],
  });
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 報更頁", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("老闆：群組綁定流程（揀單盤群→綁盤→口語對照→儲存）＋audit", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    await expect(page.getByRole("heading", { name: "WhatsApp 報更" })).toBeVisible();
    const card = page.getByTestId("wa-group-card").filter({ hasText: "E2E測試群一" });
    await expect(card).toBeVisible();
    await expect(card.getByText("略過", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await expect(ed).toBeVisible();
    await ed.getByLabel("群組類型").selectOption("site");
    const siteSel = ed.getByLabel("綁定盤口");
    await expect(siteSel).toBeVisible();
    const firstSite = await siteSel.locator("option").nth(1).textContent();
    await siteSel.selectOption({ index: 1 });
    await ed.getByRole("button", { name: "加一行對照" }).click();
    await ed.getByLabel("口語 1").fill("夜");
    await ed.getByLabel("更碼 1").fill("N");
    await ed.getByLabel(/^自動寫入/).check();
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已儲存群組綁定。")).toBeVisible();
    await expect(card.getByText("單盤群")).toBeVisible();
    await expect(card.getByText(`盤：${firstSite}`)).toBeVisible();
    await expect(card.getByText("自動寫入")).toBeVisible();
    const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } });
    expect(row).toMatchObject({ kind: "site", autoWrite: true, autoConfirm: false });
    expect(row.siteId).not.toBeNull();
    expect(row.shiftWordMap).toEqual({ 夜: "N" });
    const a = await prisma.auditLog.findFirst({ where: { tableName: "whatsapp_groups", action: "update", rowId: row.id } });
    expect(a).not.toBeNull();
  });

  test("單盤群唔揀盤 → 儲存被拒並顯示錯誤；改返略過清走綁定", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    const card = page.getByTestId("wa-group-card").filter({ hasText: "E2E測試群二" });
    await card.getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await ed.getByLabel("群組類型").selectOption("site");
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(ed.getByText(/單盤群要綁定盤口/)).toBeVisible();
    await ed.getByLabel("群組類型").selectOption("ignored");
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已儲存群組綁定。")).toBeVisible();
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G2 } })).kind).toBe("ignored");
  });

  test("訊息清單：編輯／撤回／略過標示、發訊人電話尾或姓名、唔顯示原文；狀態篩選；睇訊息按群篩", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    const list = page.getByTestId("wa-message-list");
    await expect(list.getByTestId("wa-message-row")).toHaveCount(5);
    await expect(list.getByText("已撤回")).toBeVisible();
    await expect(list.getByText("已編輯 r2")).toBeVisible();
    await expect(list.getByText("過期")).toBeVisible();
    await expect(list.getByText("媒體：image")).toBeVisible();
    await expect(list.getByText("…1234").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("E2E機密原文");
    await expect(page.locator("body")).not.toContainText("85290001234");
    await page.getByLabel("狀態篩選").selectOption("revoked");
    await expect(list.getByTestId("wa-message-row")).toHaveCount(1);
    await page.getByLabel("狀態篩選").selectOption("");
    await expect(list.getByTestId("wa-message-row")).toHaveCount(5);
    await page.getByTestId("wa-group-card").filter({ hasText: "E2E測試群二" }).getByRole("button", { name: "睇訊息" }).click();
    await expect(list.getByTestId("wa-message-row")).toHaveCount(1);
  });

  test("health 區：總開關、WAHA 未設定、積壓／錯誤數；「同步群組」WAHA 未設定 → 錯誤橫幅", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    const h = page.getByTestId("wa-health");
    await expect(h.getByText("已關")).toBeVisible();
    await expect(h.getByText("未設定")).toBeVisible();
    await expect(h.getByText("積壓（待處理）")).toBeVisible();
    await page.getByRole("button", { name: "同步群組" }).click();
    await expect(page.getByText(/WAHA 未設定/)).toBeVisible();
  });

  test("主管：可睇，但冇「同步群組」同「綁定設定」；雞頭：導覽冇連結、API 403", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/whatsapp");
    await expect(page.getByTestId("wa-group-card").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "同步群組" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "綁定設定" })).toHaveCount(0);
    await expect(page.locator('aside [data-testid="nav-/whatsapp"]')).toHaveCount(1);
    await page.context().clearCookies();
    await loginAs(page, "雞頭A");
    await page.goto("/");
    await expect(page.locator('aside [data-testid="nav-/whatsapp"]')).toHaveCount(0);
    const r = await page.request.get("/api/whatsapp/groups");
    expect(r.status()).toBe(403);
  });

  test("手機 375px：無橫向捲動；群組卡、訊息列、綁定抽屜都放得落", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    await expect(page.getByTestId("wa-group-card").first()).toBeVisible();
    await expect(page.getByTestId("wa-message-row").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId("wa-group-card").first().getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await expect(ed).toBeVisible();
    await ed.getByLabel("群組類型").selectOption("site");
    await ed.getByRole("button", { name: "加一行對照" }).click();
    const box = await ed.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
