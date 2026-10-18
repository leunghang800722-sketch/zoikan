// TE-1：分診題卡 inline 顯示原文件欄位裁圖＋「⋯ → 上載覆核裁圖」（dry run → 套用）。
// 全部合成資料（虛構名／假 HKID／ImageMagick 畫嘅假裁圖，唔含任何真實內容），375px。
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";
import { buildZip, entryName } from "../lib/te1-images";
import { serverPersonKey } from "../../src/lib/guards/import/person-key";

test.describe.configure({ mode: "serial" });

const REF = "e2e-te1";
const MOBILE = { width: 375, height: 812 };
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";

function mkHkid(six: string): string {
  const sum = 36 * 9 + 34 * 8 + six.split("").reduce((a, c, i) => a + Number(c) * (7 - i), 0);
  const r = (11 - (sum % 11)) % 11;
  return `Y${six}${r === 10 ? "A" : r}`;
}
const RUN = String(Date.now() % 1000).padStart(3, "0");
const CN = RUN.replace(/\d/g, (d) => "〇一二三四五六七八九"[Number(d)]!);
const P = [
  { n: 1, name: `導入測試員${CN}壹`, hkid: mkHkid(`66${RUN}1`), no: `ZE${RUN}1` },
  { n: 2, name: `導入測試員${CN}貳`, hkid: mkHkid(`66${RUN}2`), no: `ZE${RUN}2` },
  { n: 3, name: "", hkid: mkHkid(`66${RUN}3`), no: `ZE${RUN}3` }, // TE-3：無證、冇姓名嘅人（hkid 係人手輸入嗰個）
];
const f = (value: string | null, status = "confirmed") => ({ value, status });
const personOf = (p: (typeof P)[number], over: Record<string, unknown> = {}) => ({
  key: `e2e-te1-${p.n}`,
  hkid: f(p.hkid),
  nameZh: f(p.name),
  nameEn: f(`TEST ${p.n}`, "review"),
  dateOfBirth: f("1990-05-06"),
  sex: f("M"),
  phone: f(`9100${RUN}${p.n}`),
  address: { ...f("測試道1號測試大廈1樓A室", "review"), source: "address_proof" },
  staffNumbers: [{ scheme: "ZE", number: p.no }],
  rating: "auto_ok",
  reasons: [],
  conflicts: [],
  ...over,
});
const keyOf = (p: (typeof P)[number]) => serverPersonKey({ key: `e2e-te1-${p.n}`, hkid: { value: p.n === 3 ? null : p.hkid }, staffNumbers: [{ number: p.no }] });

async function cleanup() {
  const ss = await prisma.triageSession.findMany({ where: { sourceRef: REF }, select: { id: true } });
  await prisma.triageEvidenceImage.deleteMany({ where: { sessionId: { in: ss.map((s) => s.id) } } });
  await prisma.triageQuestion.deleteMany({ where: { sessionId: { in: ss.map((s) => s.id) } } });
  await prisma.triageSession.deleteMany({ where: { sourceRef: REF } });
}

async function seed(): Promise<string> {
  const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
  const s = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: REF, ownerUserId: boss.id, createdBy: boss.id } });
  const mk = (p: (typeof P)[number], kind: string, sort: number, person: object, extra: object, options: string[]) =>
    prisma.triageQuestion.create({
      data: { sessionId: s.id, kind, groupKey: `e2e-te1-${p.n}`, sort, title: kind, personKey: keyOf(p), evidenceJson: { v: 1, person, reasons: [], candidate_guard_ids: [], ...extra } as never, optionsJson: options.map((id) => ({ id, label: id })) as never },
    });
  await mk(P[0]!, "name_not_confirmed", 1, personOf(P[0]!, { nameZh: f(P[0]!.name, "review") }), {}, ["use_package_name", "skip"]);
  await mk(P[1]!, "field_review", 2, personOf(P[1]!), { review_fields: [{ field: "nameEn", check: "fill" }, { field: "address", check: "fill" }], guard_id: null }, ["apply_fields", "skip"]);
  return s.id;
}

/** ImageMagick 畫真 JPEG（-strip，可解碼）：一格灰塊白底，唔含任何真實內容。 */
function realJpeg(dir: string, name: string, w: number, h: number, shade: number): Uint8Array {
  const out = path.join(dir, name);
  execFileSync(MAGICK, ["-size", `${w}x${h}`, "xc:white", "-fill", `rgb(${shade},${shade},${shade})`, "-draw", `rectangle 6,6 ${w - 6},${h - 6}`, "-strip", "-quality", "80", out]);
  return new Uint8Array(readFileSync(out));
}

test.describe("TE-1 覆核證據裁圖", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });
  test.afterAll(async () => {
    await cleanup();
  });

  test("375px：⋯ → 上載覆核裁圖 → dry 計數 → 套用 → 題卡 inline 顯示（來源標籤、第二張摺埋）→ 點擊放大 → 答題即刪", async ({ page }) => {
    await cleanup();
    const sid = await seed();
    const dir = mkdtempSync(path.join(os.tmpdir(), "te1e2e-"));
    try {
      const nameImg = realJpeg(dir, "n.jpg", 240, 60, 40);
      const enImg = realJpeg(dir, "e.jpg", 240, 60, 70);
      const enForm = realJpeg(dir, "f.jpg", 240, 60, 100);
      const addrImg = realJpeg(dir, "a.jpg", 240, 80, 90);
      const m1 = { hkid: P[0]!.hkid, staff_numbers: [P[0]!.no] };
      const m2 = { hkid: P[1]!.hkid, staff_numbers: [P[1]!.no] };
      const items = [
        { bytes: nameImg, field: "name_zh", doc_kind: "id_card", priority: 1, match: m1 },
        { bytes: enImg, field: "name_en", doc_kind: "id_card", priority: 1, match: m2 },
        { bytes: enForm, field: "name_en", doc_kind: "onboarding_form", priority: 2, match: m2 },
        { bytes: addrImg, field: "address", doc_kind: "address_proof", priority: 1, match: m2 },
        { bytes: realJpeg(dir, "x.jpg", 100, 40, 10), field: "phone", doc_kind: "onboarding_form", priority: 1, match: m2 }, // 題目唔需要 phone → skipped_not_needed
      ];
      const entries: Record<string, Uint8Array | string> = {};
      const manifest = items.map((it) => {
        const file = entryName(it.bytes);
        entries[file] = it.bytes;
        return { file, field: it.field, doc_kind: it.doc_kind, priority: it.priority, match: it.match };
      });
      entries["manifest.json"] = JSON.stringify({ version: 1, items: manifest });
      const zip = await buildZip(entries);

      await page.setViewportSize(MOBILE);
      await loginAs(page, "老闆");
      await page.goto("/triage");
      const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
      await card.getByTestId("triage-more").click();
      await card.getByTestId("triage-evidence-upload").click();
      const dlg = page.getByTestId("evidence-upload-dialog");
      await expect(dlg).toBeVisible();
      await dlg.getByTestId("evidence-upload-file").setInputFiles({ name: "裁圖.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
      await expect(dlg.getByTestId("evidence-upload-counts")).toContainText("預覽（未寫入）");
      await expect(dlg.getByTestId("evidence-upload-counts")).toContainText("檔內共 5 張 · 配對到 2 題");
      await expect(dlg.getByTestId("evidence-upload-accepted")).toContainText("可儲存 4 張");
      await expect(dlg.getByTestId("evidence-upload-counts")).toContainText("題目唔需要呢個欄：1 張");
      expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid } })).toBe(0); // dry 唔寫
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await dlg.getByTestId("evidence-upload-apply").click();
      await expect(dlg.getByTestId("evidence-upload-counts")).toContainText("已套用");
      await expect(dlg.getByTestId("evidence-upload-accepted")).toContainText("已儲存 4 張");
      expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid } })).toBe(4);
      await dlg.getByTestId("evidence-upload-close").click();
      await expect(dlg).toHaveCount(0);

      // 題卡：第一題 name_not_confirmed → 中文姓名圖（身份證副本）
      await card.getByRole("button", { name: /繼續答/ }).click();
      const sec = page.getByTestId("evidence-section");
      await expect(sec).toBeVisible();
      await expect(sec.getByTestId("evidence-source")).toHaveText("身份證副本");
      const img = sec.getByTestId("evidence-img").first();
      await expect(img).toBeVisible();
      expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true); // 真係載入到（解密後 JPEG）
      expect(await img.getAttribute("src")).toMatch(/^\/api\/triage\/evidence-images\/[0-9a-f-]{36}$/);
      expect(await img.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true); // 375px 唔爆框
      // 點擊放大 → overlay → Esc 關
      await img.click();
      await expect(page.getByTestId("evidence-overlay")).toBeVisible();
      await expect(page.getByTestId("evidence-img-zoomed")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("evidence-overlay")).toHaveCount(0);
      await img.click();
      await page.getByTestId("evidence-close").click();
      await expect(page.getByTestId("evidence-overlay")).toHaveCount(0);

      // 答題即刪：用導入包嘅姓名 → 預覽 → 確認
      await page.getByRole("radio").first().check();
      await page.getByTestId("triage-preview").click();
      await page.getByTestId("triage-confirm").click();
      await expect.poll(() => prisma.triageEvidenceImage.count({ where: { sessionId: sid, field: "name_zh" } }), { timeout: 15_000 }).toBe(0);
      expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid } })).toBe(3); // 第二個人嘅圖仍在

      // 重要題答晒 → 閘：繼續做補充資料（field_review 屬補充層）
      await page.getByTestId("triage-continue-supp").click();
      // 第二題 field_review：揀「逐欄核對」→ 每欄輸入框上方有圖；英文名優先來源＝身份證副本、入職表摺埋
      await page.getByRole("radio").first().check();
      const enBlock = page.locator('[data-testid="evidence-block"][data-field="name_en"]');
      await expect(enBlock).toBeVisible();
      await expect(enBlock.getByTestId("evidence-source")).toHaveText("身份證副本");
      const more = enBlock.getByTestId("evidence-more");
      await expect(more).toHaveCount(1);
      await expect(more.locator("summary")).toContainText("亦見入職表手寫");
      expect(await more.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false); // 摺埋
      await more.locator("summary").click();
      await expect(more.getByTestId("evidence-img")).toBeVisible();
      const addrBlock = page.locator('[data-testid="evidence-block"][data-field="address"]');
      await expect(addrBlock.getByTestId("evidence-source")).toHaveText("住址證明");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("壞 zip／冇 match 嘅 manifest：顯示錯誤，唔可儲存；圖片 API 對非法 id 404、未登入 401", async ({ page, request }) => {
    await cleanup();
    const sid = await seed();
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
    await card.getByTestId("triage-more").click();
    await card.getByTestId("triage-evidence-upload").click();
    const dlg = page.getByTestId("evidence-upload-dialog");
    await dlg.getByTestId("evidence-upload-file").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
    await expect(dlg).toContainText("zip 檔案格式唔啱或超出限制");
    await expect(dlg.getByTestId("evidence-upload-apply")).toBeDisabled();
    const bytes = new Uint8Array(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 2, 3, 0xff, 0xd9]));
    const file = entryName(bytes);
    const noMatch = await buildZip({ [file]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [{ file, field: "name_zh", doc_kind: "id_card", priority: 1 }] }) });
    await dlg.getByTestId("evidence-upload-file").setInputFiles({ name: "y.zip", mimeType: "application/zip", buffer: Buffer.from(noMatch) });
    await expect(dlg).toContainText("manifest 格式唔啱");
    await expect(dlg.getByTestId("evidence-upload-apply")).toBeDisabled();
    expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid } })).toBe(0);
    const anon = await request.get("/api/triage/evidence-images/00000000-0000-4000-8000-000000000000");
    expect(anon.status()).toBe(401);
    const res = await page.request.get("/api/triage/evidence-images/00000000-0000-4000-8000-000000000000");
    expect(res.status()).toBe(404);
  });

  test("TE-3 375px：無證冇姓名 → 揀輸入身份證號 → 一鍵「確認寫入」自動預覽 → 同一張卡展開姓名輸入＋姓名裁圖 → 填中文姓名自動重預覽 → 一鍵寫入建檔；答咗身份證號／姓名圖即刪", async ({ page }) => {
    await cleanup();
    const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
    const ses = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: REF, ownerUserId: boss.id, createdBy: boss.id } });
    const p3 = P[2]!;
    const person = personOf(p3, { hkid: f(null, "missing"), nameZh: f(null, "missing"), nameEn: f(null, "missing"), rating: "fail" });
    await prisma.triageQuestion.create({
      data: {
        sessionId: ses.id,
        kind: "no_id_card",
        groupKey: "e2e-te1-3",
        sort: 1,
        title: "no_id_card",
        personKey: keyOf(p3),
        evidenceJson: { v: 1, person, reasons: [], candidate_guard_ids: [] } as never,
        optionsJson: [{ id: "enter_hkid", label: "輸入身份證號", input: "hkid" }, { id: "skip", label: "skip" }] as never,
      },
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "te3e2e-"));
    try {
      const m = { staff_numbers: [p3.no] };
      const items = [
        { bytes: realJpeg(dir, "h.jpg", 240, 60, 30), field: "hkid", doc_kind: "id_card", priority: 1, match: m },
        { bytes: realJpeg(dir, "z.jpg", 240, 60, 60), field: "name_zh", doc_kind: "id_card", priority: 1, match: m },
        { bytes: realJpeg(dir, "e.jpg", 240, 60, 90), field: "name_en", doc_kind: "id_card", priority: 1, match: m },
        { bytes: realJpeg(dir, "d.jpg", 240, 60, 120), field: "dob", doc_kind: "id_card", priority: 1, match: m }, // TE-3：唔需要 dob → skipped_not_needed
      ];
      const entries: Record<string, Uint8Array | string> = {};
      const manifest = items.map((it) => {
        const file = entryName(it.bytes);
        entries[file] = it.bytes;
        return { file, field: it.field, doc_kind: it.doc_kind, priority: it.priority, match: it.match };
      });
      entries["manifest.json"] = JSON.stringify({ version: 1, items: manifest });
      const zip = await buildZip(entries);
      await page.setViewportSize(MOBILE);
      await loginAs(page, "老闆");
      await page.goto("/triage");
      const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
      await card.getByTestId("triage-more").click();
      await card.getByTestId("triage-evidence-upload").click();
      const dlg = page.getByTestId("evidence-upload-dialog");
      await dlg.getByTestId("evidence-upload-file").setInputFiles({ name: "裁圖.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
      await expect(dlg.getByTestId("evidence-upload-accepted")).toContainText("可儲存 3 張");
      await dlg.getByTestId("evidence-upload-apply").click();
      await expect(dlg.getByTestId("evidence-upload-accepted")).toContainText("已儲存 3 張");
      await dlg.getByTestId("evidence-upload-close").click();

      await card.getByRole("button", { name: /繼續答/ }).click();
      // 題卡頂：只見身份證號裁圖（姓名圖喺需要補嗰陣先喺輸入框旁出現）
      const sec = page.getByTestId("evidence-section");
      await expect(sec.getByTestId("evidence-img")).toHaveCount(1);
      await page.getByRole("radio").first().check();
      await page.getByPlaceholder("例：A123456(3)").fill(p3.hkid);
      // 一鍵：直接撳「確認寫入」（冇預覽過）→ 自動預覽 → 見到要補姓名
      await page.getByTestId("triage-confirm").click();
      const need = page.getByTestId("triage-needs-fields");
      await expect(need).toBeVisible();
      await expect(need.getByTestId("evidence-img")).toHaveCount(2); // 中文姓名圖＋英文姓名圖
      await expect(page.getByTestId("triage-reason-text")).toContainText("姓名");
      expect(await prisma.guard.count({ where: { hkid: p3.hkid } })).toBe(0); // 未寫
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // 填中文姓名 → 自動重新預覽（reason 消失）→ 一鍵寫入
      await page.getByTestId("triage-extra-name_zh").fill(`補名測試員${CN}`);
      await expect(page.getByTestId("triage-reason-text")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByTestId("triage-extra-name_zh")).toBeVisible(); // 補完仍見輸入框
      await page.getByTestId("triage-confirm").click();
      await expect.poll(() => prisma.guard.count({ where: { hkid: p3.hkid } }), { timeout: 15_000 }).toBe(1);
      const g = await prisma.guard.findFirstOrThrow({ where: { hkid: p3.hkid }, select: { nameZh: true } });
      expect(g.nameZh).toBe(`補名測試員${CN}`);
      await expect.poll(() => prisma.triageEvidenceImage.count({ where: { sessionId: ses.id } }), { timeout: 15_000 }).toBe(0); // hkid＋姓名圖答咗即刪
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TE-5 375px：補姓名後同名現有保安員 → 候選卡 → 「係同一人，連結並補資料」→ 自動重預覽 → 一撳寫入（連去該位，唔建新人）", async ({ page }) => {
    await cleanup();
    const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
    const ses = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: REF, ownerUserId: boss.id, createdBy: boss.id } });
    const p4 = { n: 4, name: "", hkid: mkHkid(`66${RUN}4`), no: `ZE${RUN}4` };
    const NM = `同名測試員${CN}`;
    const existing = await prisma.guard.create({ data: { nameZh: NM, employmentType: "cash_casual", createdBy: "e2e" } });
    const person = personOf(p4, { hkid: f(null, "missing"), nameZh: f(null, "missing"), nameEn: f(null, "missing"), dateOfBirth: f(null, "missing"), rating: "fail" });
    await prisma.triageQuestion.create({
      data: {
        sessionId: ses.id,
        kind: "no_id_card",
        groupKey: "e2e-te1-4",
        sort: 1,
        title: "no_id_card",
        personKey: serverPersonKey({ key: "e2e-te1-4", hkid: { value: null }, staffNumbers: [{ number: p4.no }] }),
        evidenceJson: { v: 1, person, reasons: [], candidate_guard_ids: [] } as never,
        optionsJson: [{ id: "enter_hkid", label: "輸入身份證號", input: "hkid" }, { id: "skip", label: "skip" }] as never,
      },
    });
    await page.setViewportSize(MOBILE);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    const card = page.getByTestId("triage-session-card").filter({ hasText: "保安員證件資料導入" }).first();
    await card.getByRole("button", { name: /繼續答/ }).click();
    await page.getByRole("radio").first().check();
    await page.getByPlaceholder("例：A123456(3)").fill(p4.hkid);
    await page.getByTestId("triage-confirm").click(); // 一鍵：自動預覽 → 要補姓名
    await expect(page.getByTestId("triage-needs-fields")).toBeVisible();
    await page.getByTestId("triage-extra-name_zh").fill(NM); // 補同名 → 自動重預覽 → 同名候選
    const dec = page.getByTestId("triage-needs-decision");
    await expect(dec).toBeVisible({ timeout: 10_000 });
    await expect(dec.getByTestId("triage-decision-candidate")).toHaveCount(1);
    await expect(dec.getByTestId("triage-decision-candidate")).toContainText("冇身份證號");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await prisma.guard.count({ where: { hkid: p4.hkid } })).toBe(0);
    await dec.getByTestId("triage-decision-link").click();
    await expect(page.getByTestId("triage-decision-chosen")).toBeVisible({ timeout: 10_000 }); // 自動重預覽完成
    await page.getByTestId("triage-confirm").click();
    await expect.poll(() => prisma.guard.findUniqueOrThrow({ where: { id: existing.id }, select: { hkid: true } }).then((g) => g.hkid), { timeout: 15_000 }).toBe(p4.hkid);
    expect(await prisma.guard.count({ where: { nameZh: NM } })).toBe(1); // 連去舊嗰位，冇建新人
  });
});
