// TR-1：分診卡「⋯ → 導入 OCR 重讀建議」——上載 proposals.json → dry run 計數 → 確認套用 → 題變 answered（source=ocr_reread）。
// 合成資料（虛構名／假 HKID／9100xxxx），375px。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const REF = "e2e-tr1";
const MOBILE = { width: 375, height: 812 };
const K = { name: "e2e-tr1-name", hkid: "e2e-tr1-hkid", fr: "e2e-tr1-fr" };

// 每次跑用唔同嘅假 HKID（Y + 6 位 + 檢查碼），測試 guard 唔會撞上次跑留低嘅資料
function mkHkid(six: string): string {
  const sum = 36 * 9 + 34 * 8 + six.split("").reduce((a, c, i) => a + Number(c) * (7 - i), 0);
  const r = (11 - (sum % 11)) % 11;
  return `Y${six}${r === 10 ? "A" : r}`;
}
const RUN = String(Date.now() % 1000);
// 中文名每次跑唔同（數字轉中文數字），避免撞上次跑留低嘅同名保安員（name_multi_candidate）
const CN = RUN.padStart(3, "0").replace(/\d/g, (d) => "〇一二三四五六七八九"[Number(d)]!);
const NAME = { name: `導入測試員${CN}壹`, hkid: `導入測試員${CN}貳`, fr: `導入測試員${CN}叁` };
const HK = { name: mkHkid(`77${RUN.padStart(3, "0")}1`), hkid: mkHkid(`77${RUN.padStart(3, "0")}2`), fr: mkHkid(`77${RUN.padStart(3, "0")}3`) };

const f = (value: string | null, status = "confirmed") => ({ value, status });
const IDX = (key: string) => (key.endsWith("name") ? 1 : key.endsWith("hkid") ? 2 : 3);
const personOf = (key: string, o: Record<string, unknown>) => ({
  key,
  hkid: f(HK.name),
  nameZh: f(NAME.name),
  nameEn: f("TEST ONE", "review"),
  dateOfBirth: f("1990-05-06"),
  sex: f("M"),
  phone: f(`9100${RUN.padStart(3, "0")}${IDX(key)}`),
  address: { ...f("測試道1號測試大廈1樓A室", "review"), source: "address_proof" },
  staffNumbers: [{ scheme: "ZQ", number: `ZQ${RUN}${IDX(key)}` }],
  rating: "auto_ok",
  reasons: [],
  conflicts: [],
  ...o,
});

async function cleanup() {
  const ss = await prisma.triageSession.findMany({ where: { sourceRef: REF }, select: { id: true } });
  await prisma.triageQuestion.deleteMany({ where: { sessionId: { in: ss.map((s) => s.id) } } });
  await prisma.triageSession.deleteMany({ where: { sourceRef: REF } });
}

async function seed(): Promise<string> {
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const s = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: REF, ownerUserId: boss.id, createdBy: boss.id } });
  const mk = (key: string, kind: string, sort: number, person: object, extra: object, options: string[]) =>
    prisma.triageQuestion.create({
      data: { sessionId: s.id, kind, groupKey: key, sort, title: kind, personKey: key, evidenceJson: { v: 1, person, reasons: [], candidate_guard_ids: [], ...extra } as never, optionsJson: options.map((id) => ({ id, label: id })) as never },
    });
  await mk(K.name, "name_not_confirmed", 1, personOf(K.name, { hkid: f(HK.name), nameZh: f(NAME.name, "review") }), {}, ["use_package_name", "skip"]);
  await mk(K.hkid, "hkid_not_confirmed", 2, personOf(K.hkid, { hkid: f(HK.hkid, "review"), nameZh: f(NAME.hkid), nameEn: f("TEST TWO") }), {}, ["use_package_hkid", "skip"]);
  await mk(K.fr, "field_review", 3, personOf(K.fr, { hkid: f(HK.fr), nameZh: f(NAME.fr) }), { review_fields: [{ field: "nameEn", check: "fill" }, { field: "address", check: "fill" }], guard_id: null }, ["apply_fields", "skip"]);
  return s.id;
}

const prop = (person_key: string, field: string, value: string, doc = "id_card") => ({ person_key, field, value, basis: "two_reads", doc, confidence: "medium" });
const FILE = {
  version: 1,
  proposals: [prop(K.name, "nameZh", NAME.name), prop(K.hkid, "hkid", HK.hkid), prop(K.fr, "nameEn", "TEST THREE"), prop(K.fr, "address", "測試道3號測試大廈3樓C室", "address_proof"), prop("e2e-tr1-nobody", "nameZh", "冇人")],
};

test.describe("TR-1 OCR 重讀建議導入", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });
  test.afterAll(async () => {
    await cleanup();
  });

  test("375px：⋯ → 上載 → dry 計數 → 確認套用 → 題 answered＋卡顯示 OCR 重讀自動答", async ({ page }) => {
    await cleanup();
    const sid = await seed();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
    await expect(card).toBeVisible();
    await card.getByTestId("triage-more").click();
    await card.getByTestId("triage-ocr-reread").click();
    const dlg = page.getByTestId("ocr-reread-dialog");
    await expect(dlg).toBeVisible();
    await dlg.getByTestId("ocr-reread-file").setInputFiles({ name: "proposals.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(FILE)) });
    // dry run：只計數，未寫入
    await expect(dlg.getByTestId("ocr-reread-counts")).toContainText("預覽（未寫入）");
    await expect(dlg.getByTestId("ocr-reread-applied")).toContainText("可自動答 3 題");
    await expect(dlg.getByTestId("ocr-reread-counts")).toContainText("冇對應未答題：1 條");
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "answered" } })).toBe(0);
    // 375px 冇橫向捲動
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dlg.getByTestId("ocr-reread-apply").click();
    await expect(dlg.getByTestId("ocr-reread-counts")).toContainText("已套用");
    await expect(dlg.getByTestId("ocr-reread-applied")).toContainText("已答 3 題");
    const qs = await prisma.triageQuestion.findMany({ where: { sessionId: sid } });
    expect(qs.every((q) => q.status === "answered" && (q.answerJson as { source?: string }).source === "ocr_reread")).toBe(true);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: HK.fr }, include: { addresses: true } });
    expect(g.nameEn).toBe("TEST THREE");
    expect(g.addresses.map((a) => a.address)).toContain("測試道3號測試大廈3樓C室");
    await dlg.getByTestId("ocr-reread-close").click();
    await expect(dlg).toHaveCount(0);
    // 卡：全答晒；顯示計數（顯示全部先見已處理晒嘅卡）
    await page.getByTestId("triage-show-all").click();
    await expect(page.getByTestId("triage-card-reread").first()).toContainText("OCR 重讀自動答 3 條");
  });

  test("壞檔／唔係 JSON：顯示錯誤，唔可套用", async ({ page }) => {
    await cleanup();
    await seed();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
    await card.getByTestId("triage-more").click();
    await card.getByTestId("triage-ocr-reread").click();
    const dlg = page.getByTestId("ocr-reread-dialog");
    await dlg.getByTestId("ocr-reread-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("{oops") });
    await expect(dlg).toContainText("唔係有效嘅 JSON 檔");
    await expect(dlg.getByTestId("ocr-reread-apply")).toBeDisabled();
    await dlg.getByTestId("ocr-reread-file").setInputFiles({ name: "y.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, proposals: [{ person_key: "k" }] })) });
    await expect(dlg).toContainText("建議檔格式唔啱");
    await expect(dlg.getByTestId("ocr-reread-apply")).toBeDisabled();
  });
});
