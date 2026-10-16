// W1：/whatsapp/intents dry-run 對照頁——統計卡、解析結果、routed 判定、原因碼、對照 ✓／✗／—、篩選、RBAC、手機 375px。
// 全部假資料：E2E 保安員甲／乙、假盤、假群 e2e-wa1-g1@g.us；訊息時間用「而家 −1 小時」（預設範圍＝最近 14 日）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa1-g1@g.us";
const LABEL = "E2E解析測試群";
const SITE_NAME = "E2E解析測試盤";
let siteId = "";
let guardA = "";
let guardB = "";

async function cleanup() {
  await prisma.whatsappIntent.deleteMany({ where: { message: { chatJid: G1 } } });
  await prisma.shiftRecord.deleteMany({ where: { createdBy: "e2e:wa-w1" } });
  await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
  await prisma.whatsappGroup.deleteMany({ where: { groupJid: G1 } });
  await prisma.shiftType.deleteMany({ where: { createdBy: "e2e:wa-w1" } });
  await prisma.guard.deleteMany({ where: { createdBy: "e2e:wa-w1" } });
  await prisma.site.deleteMany({ where: { createdBy: "e2e:wa-w1" } });
}

test.beforeAll(async () => {
  await cleanup();
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const site = await prisma.site.create({ data: { canonicalName: SITE_NAME, clientName: "E2E客戶", billingModel: "per_shift", createdBy: "e2e:wa-w1" } });
  siteId = site.id;
  const tN = await prisma.shiftType.create({ data: { siteId, code: "N", label: "夜更", createdBy: "e2e:wa-w1" } });
  guardA = (await prisma.guard.create({ data: { nameZh: "E2E保安員甲", employmentType: "cash_casual", tel: "90000021", createdBy: "e2e:wa-w1" } })).id;
  guardB = (await prisma.guard.create({ data: { nameZh: "E2E保安員乙", employmentType: "cash_casual", tel: "90000022", createdBy: "e2e:wa-w1" } })).id;
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: LABEL, kind: "site", siteId, createdBy: boss.id } });
  const base = Date.now() - 3600_000;
  const msg = (id: string, text: string, off: number, extra: Record<string, unknown> = {}) =>
    prisma.whatsappMessage.create({ data: { session: "default", chatJid: G1, messageId: id, senderJid: "85290000021@c.us", senderTelNorm: "90000021", senderGuardId: guardA, ts: new Date(base + off * 1000), text, status: "routed", llmProvider: "fake", ...extra } });
  await msg("e2e-wa1-1", "E2E機密原話：聽日夜更", 0);
  await msg("e2e-wa1-2", "E2E機密原話：聽日請病假", 1);
  await msg("e2e-wa1-3", "E2E機密原話：測試乙聽日夜更", 2, { revision: 2, editedAt: new Date() });
  await msg("e2e-wa1-4", "E2E機密原話：邊個返聽日？", 3);
  await msg("e2e-wa1-5", "收到", 4, { status: "ignored", ignoreReason: "filtered_out", llmProvider: null });
  const d = new Date(Date.UTC(2026, 11, 1));
  const intent = (messageId: string, over: Record<string, unknown>) =>
    prisma.whatsappIntent.create({ data: { messageId, messageRevision: 1, idx: 0, kind: "shift", workDate: d, siteId, guardId: guardA, shiftTypeId: tN.id, confidence: 0.9, resolution: { reasons: [], notes: ["group_auto_write_off"], candidates: {}, group_auto_write: false }, routed: "auto_write", ...over } as never });
  await intent("e2e-wa1-1", {});
  await intent("e2e-wa1-2", { kind: "leave", shiftTypeId: null, leaveCode: "SL" });
  await intent("e2e-wa1-3", { guardId: guardB, routed: "triage", resolution: { reasons: ["conflict_other_shift", "person_ambiguous"], notes: [], candidates: { guard_ids: ["a", "b"] } }, sourceChanged: true });
  await intent("e2e-wa1-4", { kind: "question_only", guardId: null, workDate: null, shiftTypeId: null, routed: "ignored", resolution: { reasons: ["question_only"], notes: [] } });
  await intent("e2e-wa1-3", { messageRevision: 1, idx: 1, supersededByRevision: 2, routed: "triage", resolution: { reasons: ["date_ambiguous"], notes: [] } });
  // 實際排更：測試甲 12/1 夜更 → intent 1 一致；intent 2（請假）唔一致；測試乙冇排 → 未有
  await prisma.shiftRecord.create({ data: { workDate: d, siteId, shiftTypeId: tN.id, guardId: guardA, recordType: "shift", status: "confirmed", createdBy: "e2e:wa-w1" } });
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 解析對照頁", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("老闆：統計卡、解析結果、判定、原因、對照、原話；按群篩選", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/intents");
    await expect(page.getByRole("heading", { name: "WhatsApp 解析對照（dry-run）" })).toBeVisible();
    await page.getByLabel("群組", { exact: true }).selectOption({ label: LABEL });
    const list = page.getByTestId("wa-intent-list");
    await expect(list.getByTestId("wa-intent-row")).toHaveCount(5);
    // 統計（只睇本群）：收 5、過濾 1、解析 4、建議自動 2、分流 2（連被取代嗰條計入？—— 被取代唔計）→ 分流 1、忽略 1
    const stats = page.getByTestId("wa-intent-stats");
    await expect(stats.getByTestId("wa-stat-received")).toContainText("5");
    await expect(stats.getByTestId("wa-stat-filtered")).toContainText("1");
    await expect(stats.getByTestId("wa-stat-parsed")).toContainText("4");
    await expect(stats.getByTestId("wa-stat-auto_write")).toContainText("2");
    await expect(stats.getByTestId("wa-stat-triage")).toContainText("1");
    await expect(stats.getByTestId("wa-stat-ignored")).toContainText("1");
    await expect(stats.getByTestId("wa-stat-consistency")).toContainText("50%");
    await expect(stats.getByTestId("wa-stat-consistency")).toContainText("1／2");
    // 第一條（最新訊息先）：question_only
    const rows = list.getByTestId("wa-intent-row");
    const q = rows.filter({ hasText: "邊個返聽日" });
    await expect(q).toContainText("查詢");
    await expect(q).toContainText("純查詢");
    await expect(q.getByTestId("wa-intent-compare")).toContainText("不適用");
    const ok = rows.filter({ hasText: "E2E機密原話：聽日夜更" }).first();
    await expect(ok).toContainText("建議自動寫入");
    await expect(ok).toContainText("E2E保安員甲");
    await expect(ok).toContainText("2026-12-01");
    await expect(ok).toContainText(SITE_NAME);
    await expect(ok.getByTestId("wa-intent-compare")).toContainText("✓ 一致");
    await expect(ok).toContainText("群組未開自動寫入");
    const leave = rows.filter({ hasText: "聽日請病假" });
    await expect(leave).toContainText("SL");
    await expect(leave.getByTestId("wa-intent-compare")).toContainText("✗ 唔一致");
    await expect(leave).toContainText("實際：shift:N");
    const tri = rows.filter({ hasText: "同日已有其他更" });
    await expect(tri).toContainText("同日已有其他更");
    await expect(tri).toContainText("人名對到多個保安員");
    await expect(tri.getByTestId("wa-intent-compare")).toContainText("— 未有排更");
    await expect(tri).toContainText("原訊息已修改");
    await expect(rows.filter({ hasText: "已被編輯後版本取代" })).toHaveCount(1);
  });

  test("判定篩選、日期範圍篩選", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/intents");
    await page.getByLabel("群組", { exact: true }).selectOption({ label: LABEL });
    const rows = page.getByTestId("wa-intent-row");
    await expect(rows).toHaveCount(5);
    await page.getByLabel("判定").selectOption("auto_write");
    await expect(rows).toHaveCount(2);
    await page.getByLabel("判定").selectOption("ignored");
    await expect(rows).toHaveCount(1);
    await page.getByLabel("判定").selectOption("");
    await page.getByLabel("由").fill("2020-01-01");
    await page.getByLabel("至").fill("2020-01-02");
    await expect(page.getByText("未有解析結果")).toBeVisible();
    await expect(page.getByTestId("wa-stat-received")).toContainText("0");
  });

  test("/whatsapp 頁有連結去對照頁；主管可睇；雞頭 API 403", async ({ page }) => {
    await loginAs(page, "主管");
    await page.goto("/whatsapp");
    await page.getByRole("link", { name: "解析對照（dry-run）" }).click();
    await expect(page).toHaveURL(/\/whatsapp\/intents$/);
    await expect(page.getByTestId("wa-intent-stats")).toBeVisible();
    await expect(page.locator('aside [data-testid="nav-/whatsapp"]')).toHaveCount(1);
    await page.context().clearCookies();
    await loginAs(page, "雞頭A");
    const r1 = await page.request.get("/api/whatsapp/intents");
    expect(r1.status()).toBe(403);
    const r2 = await page.request.get("/api/whatsapp/stats");
    expect(r2.status()).toBe(403);
  });

  test("群組綁定抽屜有過濾閾值欄，儲存後落庫", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/whatsapp");
    const card = page.getByTestId("wa-group-card").filter({ hasText: LABEL });
    await card.getByRole("button", { name: "綁定設定" }).click();
    const ed = page.getByTestId("wa-group-editor");
    await ed.getByLabel("過濾閾值").fill("55");
    await ed.getByRole("button", { name: "儲存" }).click();
    await expect(page.getByText("已儲存群組綁定。")).toBeVisible();
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } })).filterThreshold).toBe(55);
    await prisma.whatsappGroup.update({ where: { groupJid: G1 }, data: { filterThreshold: null } });
  });

  test("手機 375px：無橫向捲動；統計卡、解析卡、篩選都放得落", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/intents");
    await page.getByLabel("群組", { exact: true }).selectOption({ label: LABEL });
    await expect(page.getByTestId("wa-intent-row").first()).toBeVisible();
    await expect(page.getByTestId("wa-stat-received")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.getByTestId("wa-intent-row").first().boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await page.getByLabel("判定").selectOption("triage");
    await expect(page.getByTestId("wa-intent-row")).toHaveCount(2); // 現行 1 條＋被編輯取代嗰條
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
