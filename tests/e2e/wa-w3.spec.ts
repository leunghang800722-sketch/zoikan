// W3：WhatsApp 待批清單（/whatsapp/pending）——列出 source=whatsapp 的 pending_approval（群、發訊人、盤、日期、更、原話、⚠）、
// 一鍵批核多條（走現有 approve route）、退回要原因、全選唔包含 ⚠；排更格 tooltip（原話、⚠）；群組抽屜每日上限；手機 375px；RBAC。
// 全部假資料：E2E保安員甲／乙／丙、E2E自動寫入盤、假群 e2e-wa3-g1@g.us（直接種記錄，唔經 LLM／WAHA）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa3-g1@g.us";
const LABEL = "E2E自動寫入群";
const SITE_NAME = "E2E自動寫入盤";
const BY = "e2e:wa-w3";
let siteId = "";
let tN = "";
let gA = "";
let gB = "";
let gC = "";
let bossId = "";
let tomorrow = "";
let monthStr = "";

function hkTomorrow(): string {
  return new Date(Date.now() + 8 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const dayAfter = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

async function cleanup() {
  await prisma.whatsappIntent.deleteMany({ where: { message: { chatJid: G1 } } });
  await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
  await prisma.whatsappGroup.deleteMany({ where: { groupJid: G1 } });
  await prisma.shiftRecord.deleteMany({ where: { OR: [{ createdBy: BY }, { site: { canonicalName: SITE_NAME } }] } });
  await prisma.shiftType.deleteMany({ where: { createdBy: BY } });
  await prisma.guard.deleteMany({ where: { createdBy: BY } });
  await prisma.site.deleteMany({ where: { createdBy: BY } });
}

/** 種一條「已自動寫入、待批」記錄＋原訊息＋intent。 */
async function seedPending(mid: string, guardId: string, date: string, text: string, opts: { msgRevision?: number; recRevision?: number } = {}) {
  await prisma.whatsappMessage.create({
    data: { session: "default", chatJid: G1, messageId: mid, revision: opts.msgRevision ?? 1, senderJid: "85290000031@c.us", senderTelNorm: "90000031", senderGuardId: gA, ts: new Date(Date.now() - 3600_000), text, status: "routed", llmProvider: "fake" },
  });
  const rec = await prisma.shiftRecord.create({
    data: { workDate: new Date(`${date}T00:00:00Z`), siteId, shiftTypeId: tN, guardId, recordType: "shift", status: "pending_approval", source: "whatsapp", provenance: { message_id: mid, revision: opts.recRevision ?? 1, intent_idx: 0, sender_guard_id: gA }, createdBy: BY },
  });
  await prisma.whatsappIntent.create({
    data: { messageId: mid, messageRevision: opts.recRevision ?? 1, idx: 0, kind: "shift", workDate: new Date(`${date}T00:00:00Z`), siteId, guardId, shiftTypeId: tN, confidence: 0.9, resolution: { reasons: [], notes: [], auto_write: { result: "written", record_id: rec.id, status: "pending_approval" } }, routed: "auto_write", resultRef: rec.id },
  });
  return rec;
}

async function noHScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
}

test.beforeAll(async () => {
  await cleanup();
  bossId = (await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } })).id;
  tomorrow = hkTomorrow();
  monthStr = tomorrow.slice(0, 7);
  siteId = (await prisma.site.create({ data: { canonicalName: SITE_NAME, clientName: "E2E客戶", billingModel: "per_shift", createdBy: BY } })).id;
  tN = (await prisma.shiftType.create({ data: { siteId, code: "N", label: "夜更", createdBy: BY } })).id;
  gA = (await prisma.guard.create({ data: { nameZh: "E2E保安員甲", employmentType: "cash_casual", tel: "90000031", createdBy: BY } })).id;
  gB = (await prisma.guard.create({ data: { nameZh: "E2E保安員乙", employmentType: "cash_casual", tel: "90000032", createdBy: BY } })).id;
  gC = (await prisma.guard.create({ data: { nameZh: "E2E保安員丙", employmentType: "cash_casual", tel: "90000033", createdBy: BY } })).id;
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: LABEL, kind: "site", siteId, autoWrite: true, createdBy: bossId } });
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 待批清單", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("列出待批（原話、群、盤、日期、更、⚠）→ 全選唔包含 ⚠ → 一鍵批核 → confirmed；退回要原因", async ({ page }) => {
    const r1 = await seedPending("e2e-wa3-1", gB, tomorrow, "E2E原話：乙聽日夜更");
    const r2 = await seedPending("e2e-wa3-2", gC, dayAfter(tomorrow, 1), "E2E原話：丙後日夜更");
    const r3 = await seedPending("e2e-wa3-3", gA, dayAfter(tomorrow, 2), "E2E原話：甲大後日夜更（已改）", { msgRevision: 2, recRevision: 1 });
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/pending");
    const rows = page.getByTestId("wa-pending-row");
    await expect(rows).toHaveCount(3);
    await expect(page.getByTestId("wa-pending-list")).toContainText(LABEL);
    await expect(page.getByTestId("wa-pending-list")).toContainText(SITE_NAME);
    await expect(page.getByTestId("wa-pending-list")).toContainText("E2E原話：乙聽日夜更");
    await expect(page.getByTestId("wa-pending-warn")).toHaveCount(1);
    await expect(page.getByTestId("wa-pending-warn")).toContainText("原訊息已被發訊人修改");
    // 全選唔包含 ⚠
    await page.getByLabel("全選（唔包含有 ⚠ 嘅）").check();
    await expect(page.getByTestId("wa-pending-approve")).toContainText("批核已選（2）");
    await page.getByTestId("wa-pending-approve").click();
    await expect(rows).toHaveCount(1);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("confirmed");
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("confirmed");
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r3.id } })).status).toBe("pending_approval");
    // 退回：冇原因唔得
    await rows.first().getByRole("button", { name: "退回" }).click();
    await page.getByRole("button", { name: "確認退回" }).click();
    await expect(page.getByText("退回要寫原因")).toBeVisible();
    await page.getByLabel("退回原因").fill("E2E唔啱");
    await page.getByRole("button", { name: "確認退回" }).click();
    await expect(page.getByTestId("wa-pending-row")).toHaveCount(0);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r3.id } })).status).toBe("draft");
  });

  test("排更頁：格仔 tooltip 有群／原話；原訊息已修改 → ⚠ 橫幅", async ({ page }) => {
    await prisma.shiftRecord.deleteMany({ where: { siteId } });
    await prisma.whatsappIntent.deleteMany({ where: { message: { chatJid: G1 } } });
    await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
    await seedPending("e2e-wa3-4", gB, tomorrow, "E2E原話：乙聽日夜更");
    await seedPending("e2e-wa3-5", gC, tomorrow, "E2E原話：丙聽日夜更（已改）", { msgRevision: 2, recRevision: 1 });
    await loginAs(page, "老闆");
    await page.goto(`/roster/${siteId}/${monthStr}`);
    await expect(page.getByTestId("roster-wa-notice")).toContainText("2 格來自 WhatsApp");
    await expect(page.getByTestId("roster-wa-changed")).toContainText("1 格");
    const cells = page.locator('td[title*="來自 WhatsApp"]');
    await expect(cells).toHaveCount(2);
    await expect(page.locator(`td[title*="${LABEL}"][title*="E2E原話：乙聽日夜更"]`)).toHaveCount(1);
    await expect(page.locator('td[title*="⚠ 原訊息已被發訊人修改"]')).toHaveCount(1);
  });

  test("群組抽屜：每日自動寫入上限可改（0–1000）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    const card = page.getByTestId("wa-group-card").filter({ hasText: LABEL });
    await expect(async () => {
      await card.getByRole("button", { name: "綁定設定" }).click();
      await expect(page.getByTestId("wa-group-editor")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    const cap = page.getByLabel("每日自動寫入上限");
    await expect(cap).toHaveValue("50");
    await cap.fill("7");
    await page.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByTestId("wa-group-editor")).toHaveCount(0);
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } })).autoWriteDailyCap).toBe(7);
  });

  test("對照頁：顯示自動寫入結果統計同逐條結果", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/intents");
    await page.getByLabel("群組", { exact: true }).selectOption({ label: LABEL });
    await expect(page.getByTestId("wa-stat-auto-results")).toContainText("已寫");
    await expect(page.getByTestId("wa-intent-auto-result").first()).toContainText("已自動寫入");
  });

  test("手機 375px：待批清單無橫向捲動、批核掣可撳", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await prisma.shiftRecord.deleteMany({ where: { siteId } });
    await prisma.whatsappIntent.deleteMany({ where: { message: { chatJid: G1 } } });
    await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
    await seedPending("e2e-wa3-6", gB, tomorrow, "E2E原話：一條好長嘅訊息 ".repeat(8));
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/pending");
    await expect(page.getByTestId("wa-pending-row")).toHaveCount(1);
    await noHScroll(page);
    await page.getByLabel(/^揀 /).check();
    await expect(page.getByTestId("wa-pending-approve")).toBeEnabled();
    await noHScroll(page);
  });

  test("RBAC：雞頭 /api/whatsapp/pending、/records 403；未登入 401", async ({ page }) => {
    await loginAs(page, "雞頭A");
    expect((await page.request.get("/api/whatsapp/pending")).status()).toBe(403);
    expect((await page.request.get(`/api/whatsapp/records?site=${siteId}&month=${monthStr}`)).status()).toBe(403);
    await page.context().clearCookies();
    expect((await page.request.get("/api/whatsapp/pending")).status()).toBe(401);
  });
});
