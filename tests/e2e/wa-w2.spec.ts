// W2：WhatsApp 分診題卡流程——原話＋群名＋時間＋發訊人、候選一鍵揀 → 預覽 → 確認寫入 pending_approval →
// 排更頁見「來自 WhatsApp」；取消舊記錄（以 WhatsApp 為準）；對照頁連結深連結入題；手機 375px 無橫向捲動；RBAC。
// 全部假資料：E2E保安員甲／乙、E2E分流測試盤、假群 e2e-wa2-g1@g.us（直接種 triage 題，唔經 LLM／WAHA）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa2-g1@g.us";
const LABEL = "E2E分流測試群";
const SITE_NAME = "E2E分流測試盤";
const BY = "e2e:wa-w2";
let siteId = "";
let tN = "";
let tA = "";
let gA = "";
let gB = "";
let bossId = "";
let tomorrow = "";
let monthStr = "";
let sentAt = new Date();

/** 香港「聽日」（YYYY-MM-DD）。 */
function hkTomorrow(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function cleanup() {
  await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } } });
  await prisma.triageSession.deleteMany({ where: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } });
  await prisma.whatsappIntent.deleteMany({ where: { message: { chatJid: G1 } } });
  await prisma.whatsappMessage.deleteMany({ where: { chatJid: G1 } });
  await prisma.whatsappGroup.deleteMany({ where: { groupJid: G1 } });
  await prisma.shiftRecord.deleteMany({ where: { OR: [{ createdBy: BY }, { site: { canonicalName: SITE_NAME } }] } });
  await prisma.shiftType.deleteMany({ where: { createdBy: BY } });
  await prisma.guard.deleteMany({ where: { createdBy: BY } });
  await prisma.site.deleteMany({ where: { createdBy: BY } });
}

async function seedQuestion(mid: string, kind: string, over: { reasons: string[]; guardIds?: string[]; text: string; guardId?: string | null; options: unknown[]; existing?: string[]; shiftTypeId?: string | null; offset?: number }) {
  const ym = tomorrow.slice(0, 7);
  const session =
    (await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "whatsapp", sourceRef: `${G1}:${ym}` } } })) ??
    (await prisma.triageSession.create({ data: { sourceType: "whatsapp", sourceRef: `${G1}:${ym}`, ownerUserId: bossId, createdBy: bossId, statsJson: {} } }));
  const group = await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } });
  const ts = new Date(sentAt.getTime() + (over.offset ?? 0) * 1000);
  await prisma.whatsappMessage.create({ data: { session: "default", chatJid: G1, messageId: mid, senderJid: "85290000021@c.us", senderTelNorm: "90000021", senderGuardId: gA, ts, text: over.text, status: "routed", llmProvider: "fake" } });
  const intent = await prisma.whatsappIntent.create({ data: { messageId: mid, messageRevision: 1, idx: 0, kind: "shift", workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, guardId: over.guardId ?? null, shiftTypeId: over.shiftTypeId ?? tN, confidence: 0.85, resolution: { reasons: over.reasons, notes: [], candidates: {} }, routed: "triage" } });
  const q = await prisma.triageQuestion.create({
    data: {
      sessionId: session.id,
      kind,
      groupKey: `${mid}:1:0`,
      sort: Math.floor(ts.getTime() / 60000),
      title: `${LABEL}｜e2e`,
      evidenceJson: {
        v: 1,
        wa: true,
        round: 1,
        message: { message_id: mid, revision: 1, idx: 0, intent_id: intent.id },
        group: { id: group.id, label: LABEL, kind: "site" },
        sent_at: ts.toISOString(),
        sender: { guard_id: gA, tel_tail4: "0021" },
        text: over.text,
        intent: { kind: "shift", work_date: tomorrow, site_id: siteId, guard_id: over.guardId ?? null, shift_type_id: over.shiftTypeId ?? tN, leave_code: null, confidence: 0.85 },
        src: { person_raw: "阿E", site_raw: null, date_raw: "聽日", shift_raw: "夜", leave_raw: null, replaced_raw: null },
        reasons: over.reasons,
        notes: [],
        candidates: { guard_ids: over.guardIds ?? [], site_ids: [], dates: [], shift_type_ids: [], existing_record_ids: over.existing ?? [] },
        human: {},
        month: `${ym}-01`,
      },
      optionsJson: over.options as never,
    },
  });
  await prisma.whatsappIntent.update({ where: { id: intent.id }, data: { resultRef: q.id } });
  return { q, session, intent };
}

async function noHScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
}

test.beforeAll(async () => {
  await cleanup();
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  bossId = boss.id;
  tomorrow = hkTomorrow();
  monthStr = tomorrow.slice(0, 7);
  sentAt = new Date(Date.now() - 3600_000);
  const site = await prisma.site.create({ data: { canonicalName: SITE_NAME, clientName: "E2E客戶", billingModel: "per_shift", createdBy: BY } });
  siteId = site.id;
  tN = (await prisma.shiftType.create({ data: { siteId, code: "N", label: "夜更", createdBy: BY } })).id;
  tA = (await prisma.shiftType.create({ data: { siteId, code: "A", label: "早更", createdBy: BY } })).id;
  gA = (await prisma.guard.create({ data: { nameZh: "E2E保安員甲", employmentType: "cash_casual", tel: "90000021", createdBy: BY } })).id;
  gB = (await prisma.guard.create({ data: { nameZh: "E2E保安員乙", employmentType: "cash_casual", tel: "90000022", createdBy: BY } })).id;
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: LABEL, kind: "site", siteId, createdBy: bossId } });
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 分診題卡", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("老闆：揀候選保安員 → 預覽 → 確認寫入 → 排更頁見「來自 WhatsApp」", async ({ page }) => {
    const personOpts = [
      { id: "wa_pick_guard", label: "揀呢位", guard_id: gA },
      { id: "wa_pick_guard", label: "揀呢位", guard_id: gB },
      { id: "wa_pick_guard", label: "搜尋其他保安員", input: "guard_search" },
      { id: "skip", label: "跳過，留返人手" },
    ];
    const { q } = await seedQuestion("e2e-wa2-1", "wa_person_ambiguous", { reasons: ["person_ambiguous"], guardIds: [gA, gB], text: "E2E原話：阿E聽日夜更", options: personOpts });
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "WhatsApp 報更分流" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("wa-triage-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("wa-original-text")).toHaveText("E2E原話：阿E聽日夜更");
    await expect(dlg.getByTestId("wa-original")).toContainText(LABEL);
    await expect(dlg.getByTestId("wa-original")).toContainText("E2E保安員甲"); // 發訊人
    await expect(dlg.getByTestId("wa-reasons")).toContainText("人名對到多位保安員");
    await expect(dlg.getByTestId(`wa-opt-guard-${gA}`)).toContainText("E2E保安員甲");
    await expect(dlg.getByTestId(`wa-opt-guard-${gB}`)).toContainText("E2E保安員乙");
    await expect(dlg.getByTestId("wa-confirm")).toBeDisabled();
    await dlg.getByTestId(`wa-opt-guard-${gB}`).click();
    await expect(dlg.getByTestId("wa-remember-alias")).toContainText("阿E");
    await dlg.getByTestId("wa-preview").click();
    await expect(dlg.getByTestId("wa-impact")).toContainText("待批核");
    await expect(dlg.getByTestId("wa-impact")).toContainText("E2E保安員乙");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp", guardId: gB } })).toBe(0); // 預覽唔寫
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-notice")).toContainText("入更");
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: gB, source: "whatsapp" } });
    expect(rec).toMatchObject({ status: "pending_approval", shiftTypeId: tN, siteId });
    expect(rec.workDate.toISOString().slice(0, 10)).toBe(tomorrow);
    expect(rec.provenance).toMatchObject({ message_id: "e2e-wa2-1", revision: 1, intent_idx: 0, triage_question_id: q.id });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
    // 排更頁
    await page.goto(`/roster/${siteId}/${monthStr}`);
    await expect(page.getByTestId("roster-wa-notice")).toContainText("1 格來自 WhatsApp");
    await expect(page.locator('td[title*="來自 WhatsApp"]')).toHaveCount(1);
  });

  test("撞更：「以 WhatsApp 為準（取消舊）」→ 舊記錄取消、新記錄待批核", async ({ page }) => {
    const old = await prisma.shiftRecord.create({ data: { workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, shiftTypeId: tA, guardId: gA, recordType: "shift", status: "confirmed", createdBy: BY } });
    await seedQuestion("e2e-wa2-2", "wa_shift_conflict", {
      reasons: ["conflict_other_shift"],
      guardId: gA,
      text: "E2E原話：測試甲聽日夜更",
      existing: [old.id],
      offset: 5,
      options: [
        { id: "wa_use_whatsapp", label: "以 WhatsApp 為準（取消舊記錄）" },
        { id: "wa_keep_old", label: "保留舊記錄（唔入更）" },
        { id: "wa_manual", label: "人手改（去排更頁）" },
        { id: "skip", label: "跳過，留返人手" },
      ],
    });
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await page.getByTestId("triage-session-card").filter({ hasText: "WhatsApp 報更分流" }).getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("wa-triage-dialog");
    await expect(dlg.getByTestId("wa-existing")).toContainText("A 更");
    await expect(dlg.getByTestId("wa-reasons")).toContainText("當日已經有另一更");
    await dlg.getByTestId("wa-opt-wa_use_whatsapp").click();
    await dlg.getByTestId("wa-preview").click();
    await expect(dlg.getByTestId("wa-impact")).toContainText("取消 1 條舊記錄");
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("cancelled");
    expect(await prisma.shiftRecord.count({ where: { guardId: gA, shiftTypeId: tN, source: "whatsapp", status: "pending_approval" } })).toBe(1);
  });

  test("對照頁：routed=triage 有「去答分診題」連結 → 深連結打開並聚焦該題", async ({ page }) => {
    const { q } = await seedQuestion("e2e-wa2-3", "wa_unparsed", {
      reasons: ["unclear"],
      text: "E2E原話：聽日乜乜乜",
      offset: 10,
      options: [
        { id: "wa_manual", label: "人手入更（去排更頁）" },
        { id: "wa_ignore", label: "忽略（唔入更）" },
        { id: "skip", label: "跳過，留返人手" },
      ],
    });
    await loginAs(page, "老闆");
    await page.goto("/whatsapp/intents");
    await page.getByLabel("群組", { exact: true }).selectOption({ label: LABEL });
    const link = page.getByTestId("wa-intent-triage-link").first();
    await expect(link).toContainText("去答分診題");
    await link.click();
    const dlg = page.getByTestId("wa-triage-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("wa-original-text")).toHaveText("E2E原話：聽日乜乜乜");
    expect(await dlg.getByRole("button", { name: /^跳過/ }).count()).toBe(1);
    // 忽略 → 答完
    await dlg.getByTestId("wa-opt-wa_ignore").click();
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
  });

  test("手機 375px：題卡全寬、無橫向捲動、候選可撳", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await seedQuestion("e2e-wa2-4", "wa_person_ambiguous", {
      reasons: ["person_ambiguous"],
      guardIds: [gA, gB],
      text: "E2E原話：一條好長嘅訊息 ".repeat(8),
      offset: 20,
      options: [
        { id: "wa_pick_guard", label: "揀呢位", guard_id: gA },
        { id: "wa_pick_guard", label: "揀呢位", guard_id: gB },
        { id: "wa_pick_guard", label: "搜尋其他保安員", input: "guard_search" },
        { id: "skip", label: "跳過，留返人手" },
      ],
    });
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await noHScroll(page);
    await page.getByTestId("triage-session-card").filter({ hasText: "WhatsApp 報更分流" }).getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("wa-triage-dialog");
    await expect(dlg.getByTestId("wa-original-text")).toBeVisible();
    await noHScroll(page);
    const box = await dlg.locator("div.relative").first().boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await dlg.getByTestId(`wa-opt-guard-${gA}`).click();
    await expect(dlg.getByTestId("wa-preview")).toBeEnabled();
    await noHScroll(page);
  });

  test("RBAC：雞頭冇「導入分診」→ /api/triage/sessions 403", async ({ page }) => {
    await loginAs(page, "雞頭A");
    const res = await page.request.get("/api/triage/sessions");
    expect(res.status()).toBe(403);
  });
});
