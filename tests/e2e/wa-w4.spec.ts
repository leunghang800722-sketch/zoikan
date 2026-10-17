// W4：WhatsApp 替更（wa_cover）／取消（wa_cancel）題卡流程——兩人確定一鍵確認、兩個候選列要揀齊先可確認、
// 取消改為請假（揀碼）、題卡顯示「會取消 X 月 X 日 X 更」；手機 375px 無橫向捲動。
// 全部假資料：E2E替更甲／乙／丙、E2E替更測試盤、假群 e2e-wa4-g1@g.us（直接種 triage 題，唔經 LLM／WAHA）。
import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const G1 = "e2e-wa4-g1@g.us";
const LABEL = "E2E替更測試群";
const SITE_NAME = "E2E替更測試盤";
const BY = "e2e:wa-w4";
let siteId = "";
let tN = "";
let tA = "";
let gA = "";
let gB = "";
let gC = "";
let bossId = "";
let tomorrow = "";
let sentAt = new Date();

function hkTomorrow(): string {
  return new Date(Date.now() + 8 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const md = (iso: string): string => `${Number(iso.slice(5, 7))} 月 ${Number(iso.slice(8, 10))} 日`;

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

interface SeedOpts {
  intentKind: "cover" | "cancel";
  text: string;
  reasons: string[];
  workerId: string | null;
  workerCands?: string[];
  existing?: string[];
  cover?: { replaced_guard_id: string | null; replaced_candidate_ids: string[]; replaced_record_ids: string[] };
  options: unknown[];
  offset: number;
}
async function seedQuestion(mid: string, kind: string, o: SeedOpts) {
  const ym = tomorrow.slice(0, 7);
  const session =
    (await prisma.triageSession.findUnique({ where: { sourceType_sourceRef: { sourceType: "whatsapp", sourceRef: `${G1}:${ym}` } } })) ??
    (await prisma.triageSession.create({ data: { sourceType: "whatsapp", sourceRef: `${G1}:${ym}`, ownerUserId: bossId, createdBy: bossId, statsJson: {} } }));
  const group = await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: G1 } });
  const ts = new Date(sentAt.getTime() + o.offset * 1000);
  await prisma.whatsappMessage.create({ data: { session: "default", chatJid: G1, messageId: mid, senderJid: "85290000031@c.us", senderTelNorm: "90000031", senderGuardId: gA, ts, text: o.text, status: "routed", llmProvider: "fake" } });
  const intent = await prisma.whatsappIntent.create({ data: { messageId: mid, messageRevision: 1, idx: 0, kind: o.intentKind, workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, guardId: o.workerId, shiftTypeId: o.intentKind === "cover" ? tN : null, confidence: 0.85, resolution: { reasons: o.reasons, notes: [], candidates: {} }, routed: "triage" } });
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
        sender: { guard_id: gA, tel_tail4: "0031" },
        text: o.text,
        intent: { kind: o.intentKind, work_date: tomorrow, site_id: siteId, guard_id: o.workerId, shift_type_id: o.intentKind === "cover" ? tN : null, leave_code: null, confidence: 0.85 },
        src: { person_raw: "阿E", site_raw: null, date_raw: "聽日", shift_raw: o.intentKind === "cover" ? "夜" : null, leave_raw: null, replaced_raw: o.intentKind === "cover" ? "阿F" : null },
        reasons: o.reasons,
        notes: [],
        candidates: { guard_ids: o.workerCands ?? [], site_ids: [], dates: [], shift_type_ids: [], existing_record_ids: o.existing ?? [] },
        human: {},
        ...(o.cover ? { cover: o.cover } : {}),
        month: `${ym}-01`,
      },
      optionsJson: o.options as never,
    },
  });
  await prisma.whatsappIntent.update({ where: { id: intent.id }, data: { resultRef: q.id } });
  return { q };
}

async function noHScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
}
async function openDialog(page: Page) {
  await loginAs(page, "老闆");
  await page.goto("/triage");
  await page.getByTestId("triage-session-card").filter({ hasText: "WhatsApp 報更分流" }).getByRole("button", { name: "繼續答" }).click();
  const dlg = page.getByTestId("wa-triage-dialog");
  await expect(dlg).toBeVisible();
  return dlg;
}

const COVER_OPTS = [
  { id: "wa_cover_confirm", label: "確認替更（被替者該更取消，替更者入更）" },
  { id: "wa_cover_add_only", label: "只加替更者（唔改被替者）" },
  { id: "wa_manual", label: "人手處理（去排更頁）" },
  { id: "skip", label: "跳過，留返人手" },
];
const CANCEL_OPTS = [
  { id: "wa_cancel_apply", label: "取消該更／請假" },
  { id: "wa_cancel_to_leave", label: "改為請假（揀碼）", input: "leave_code" },
  { id: "wa_manual", label: "人手處理（去排更頁）" },
  { id: "skip", label: "跳過，留返人手" },
];

test.beforeAll(async () => {
  await cleanup();
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: "90000001" } });
  bossId = boss.id;
  tomorrow = hkTomorrow();
  sentAt = new Date(Date.now() - 3600_000);
  const site = await prisma.site.create({ data: { canonicalName: SITE_NAME, clientName: "E2E客戶", billingModel: "per_shift", createdBy: BY } });
  siteId = site.id;
  tN = (await prisma.shiftType.create({ data: { siteId, code: "N", label: "夜更", createdBy: BY } })).id;
  tA = (await prisma.shiftType.create({ data: { siteId, code: "A", label: "早更", createdBy: BY } })).id;
  gA = (await prisma.guard.create({ data: { nameZh: "E2E替更甲", employmentType: "cash_casual", tel: "90000031", createdBy: BY } })).id;
  gB = (await prisma.guard.create({ data: { nameZh: "E2E替更乙", employmentType: "cash_casual", tel: "90000032", createdBy: BY } })).id;
  gC = (await prisma.guard.create({ data: { nameZh: "E2E替更丙", employmentType: "cash_casual", tel: "90000033", createdBy: BY } })).id;
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: LABEL, kind: "site", siteId, createdBy: bossId } });
});
test.afterAll(async () => {
  await cleanup();
});

test.describe("WhatsApp 替更／取消題卡", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test("替更：兩人確定 → 題卡顯示會取消被替者該更 → 預覽 → 確認：被替者取消＋替更者待批核", async ({ page }) => {
    const recB = await prisma.shiftRecord.create({ data: { workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, shiftTypeId: tN, guardId: gB, recordType: "shift", status: "confirmed", createdBy: BY } });
    const { q } = await seedQuestion("e2e-wa4-1", "wa_cover", {
      intentKind: "cover",
      text: "E2E原話：甲頂乙聽日夜更",
      reasons: [],
      workerId: gC,
      cover: { replaced_guard_id: gB, replaced_candidate_ids: [], replaced_record_ids: [recB.id] },
      options: COVER_OPTS,
      offset: 0,
    });
    const dlg = await openDialog(page);
    await expect(dlg.getByTestId("wa-original-text")).toHaveText("E2E原話：甲頂乙聽日夜更");
    await expect(dlg.getByTestId("wa-cover-worker-fixed")).toContainText("E2E替更丙");
    await expect(dlg.getByTestId("wa-cover-replaced-fixed")).toContainText("E2E替更乙");
    await expect(dlg.getByTestId("wa-cancel-preview")).toContainText(`會取消 E2E替更乙 ${md(tomorrow)} N 更`);
    await expect(dlg.getByTestId("wa-confirm")).toBeDisabled();
    await dlg.getByTestId("wa-opt-wa_cover_confirm").click();
    await dlg.getByTestId("wa-preview").click();
    await expect(dlg.getByTestId("wa-impact")).toContainText("E2E替更丙");
    await expect(dlg.getByTestId("wa-impact")).toContainText("會取消");
    expect(await prisma.shiftRecord.count({ where: { source: "whatsapp" } })).toBe(0); // 預覽唔寫
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("cancelled");
    const rec = await prisma.shiftRecord.findFirstOrThrow({ where: { guardId: gC, source: "whatsapp" } });
    expect(rec).toMatchObject({ status: "pending_approval", shiftTypeId: tN, siteId, recordType: "shift" });
    expect(rec.provenance).toMatchObject({ message_id: "e2e-wa4-1", triage_question_id: q.id, cover: { replaced_guard_id: gB } });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
  });

  test("替更：兩人都唔確定 → 同一題兩個候選列，揀齊先可確認", async ({ page }) => {
    await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } } });
    await prisma.shiftRecord.deleteMany({ where: { source: "whatsapp", guardId: gC } });
    const recA = await prisma.shiftRecord.create({ data: { workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, shiftTypeId: tN, guardId: gA, recordType: "shift", status: "confirmed", createdBy: BY } });
    const { q } = await seedQuestion("e2e-wa4-2", "wa_cover", {
      intentKind: "cover",
      text: "E2E原話：阿E頂阿F聽日夜更",
      reasons: ["person_ambiguous"],
      workerId: null,
      workerCands: [gB, gC],
      cover: { replaced_guard_id: null, replaced_candidate_ids: [gA, gC], replaced_record_ids: [] },
      options: COVER_OPTS,
      offset: 10,
    });
    const dlg = await openDialog(page);
    await expect(dlg.getByTestId("wa-cover-worker")).toContainText("E2E替更乙");
    await expect(dlg.getByTestId("wa-cover-replaced")).toContainText("E2E替更甲");
    await dlg.getByTestId("wa-opt-wa_cover_confirm").click();
    await expect(dlg.getByTestId("wa-preview")).toBeDisabled();
    await dlg.getByTestId(`wa-cover-worker-${gB}`).click();
    await expect(dlg.getByTestId("wa-preview")).toBeDisabled(); // 仲欠被替者
    await dlg.getByTestId(`wa-cover-replaced-${gA}`).click();
    await expect(dlg.getByTestId("wa-preview")).toBeEnabled();
    await dlg.getByTestId("wa-preview").click();
    await expect(dlg.getByTestId("wa-impact")).toContainText("E2E替更乙");
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: recA.id } })).status).toBe("cancelled");
    expect(await prisma.shiftRecord.count({ where: { guardId: gB, source: "whatsapp", status: "pending_approval" } })).toBe(1);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
  });

  test("取消：題卡顯示會取消嘅更 → 改為請假（揀 AL）→ 取消該更＋請假待批核", async ({ page }) => {
    await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } } });
    await prisma.shiftRecord.deleteMany({ where: { source: "whatsapp" } });
    await prisma.shiftRecord.deleteMany({ where: { guardId: gA } });
    const rec = await prisma.shiftRecord.create({ data: { workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, shiftTypeId: tA, guardId: gA, recordType: "shift", status: "pending_approval", createdBy: BY } });
    const { q } = await seedQuestion("e2e-wa4-3", "wa_cancel", { intentKind: "cancel", text: "E2E原話：聽日唔返", reasons: [], workerId: gA, existing: [rec.id], options: CANCEL_OPTS, offset: 20 });
    const dlg = await openDialog(page);
    await expect(dlg.getByTestId("wa-cancel-preview")).toContainText(`會取消 ${md(tomorrow)} A 更`);
    await expect(dlg.getByTestId("wa-existing")).toContainText("A 更");
    await dlg.getByTestId("wa-opt-wa_cancel_to_leave").click();
    await dlg.getByTestId("wa-leave-code").selectOption("AL");
    await dlg.getByTestId("wa-preview").click();
    await expect(dlg.getByTestId("wa-impact")).toContainText("改為請假 AL");
    await dlg.getByTestId("wa-confirm").click();
    await expect(dlg.getByTestId("wa-triage-empty")).toBeVisible();
    const live = await prisma.shiftRecord.findMany({ where: { guardId: gA, workDate: new Date(`${tomorrow}T00:00:00Z`), status: { not: "cancelled" } } });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ recordType: "leave", leaveCode: "AL", status: "pending_approval", source: "whatsapp" });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
  });

  test("手機 375px：替更題卡（兩個候選列）同取消題卡全寬、無橫向捲動", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } } });
    await seedQuestion("e2e-wa4-4", "wa_cover", {
      intentKind: "cover",
      text: "E2E原話：一條好長嘅替更訊息 ".repeat(8),
      reasons: ["person_ambiguous"],
      workerId: null,
      workerCands: [gB, gC],
      cover: { replaced_guard_id: null, replaced_candidate_ids: [gA, gC], replaced_record_ids: [] },
      options: COVER_OPTS,
      offset: 30,
    });
    const dlg = await openDialog(page);
    await noHScroll(page);
    await expect(dlg.getByTestId("wa-cover-panel")).toBeVisible();
    const box = await dlg.locator("div.relative").first().boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await dlg.getByTestId("wa-opt-wa_cover_confirm").click();
    await dlg.getByTestId(`wa-cover-worker-${gB}`).click();
    await dlg.getByTestId(`wa-cover-replaced-${gA}`).click();
    await expect(dlg.getByTestId("wa-preview")).toBeEnabled();
    await noHScroll(page);
    // 取消題
    await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: "whatsapp", sourceRef: { startsWith: `${G1}:` } } } });
    const rec = await prisma.shiftRecord.create({ data: { workDate: new Date(`${tomorrow}T00:00:00Z`), siteId, shiftTypeId: tN, guardId: gC, recordType: "shift", status: "confirmed", createdBy: BY } });
    await seedQuestion("e2e-wa4-5", "wa_cancel", { intentKind: "cancel", text: "E2E原話：聽日唔返 ".repeat(10), reasons: [], workerId: gC, existing: [rec.id], options: CANCEL_OPTS, offset: 40 });
    await page.goto("/triage");
    await page.getByTestId("triage-session-card").filter({ hasText: "WhatsApp 報更分流" }).getByRole("button", { name: "繼續答" }).click();
    const dlg2 = page.getByTestId("wa-triage-dialog");
    await expect(dlg2.getByTestId("wa-cancel-preview")).toBeVisible();
    await dlg2.getByTestId("wa-opt-wa_cancel_to_leave").click();
    await expect(dlg2.getByTestId("wa-leave-code")).toBeVisible();
    await noHScroll(page);
  });
});
