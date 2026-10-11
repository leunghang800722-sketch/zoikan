// P8：自動化第二批——待答題批量接受（對話框／5 秒撤銷零請求／確認 body）、已生成檔案頁（列表／下載確認／權限）、
// 證件到期 30 日篩選（/guards?expiring=30）、自動排程頁新 job。假資料；排程器喺 e2e 關閉（SCHEDULER_ENABLED=0）。
import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";
import { prisma, TEST_TEL } from "./db-helpers";

test.describe.configure({ mode: "serial" });

const MONTH = "2031-02";
const MONTH_DATE = new Date(Date.UTC(2031, 1, 1));
const SESSION_REF = "e2e-p8-batch";

function mcEvidence(label: string) {
  return {
    v: 1,
    mc: true,
    runId: "e2e-run",
    month: `${MONTH}-01`,
    kind: "month_close_settlement",
    summary: `${label}：5 更冇結算雞頭`,
    suggestion: "歸 TK",
    confidence: "propose",
    action: { type: "settlement", siteId: "s", guardId: "g", count: 5 },
    candidates: [{ id: "c0", label: "TK", refId: "b" }],
    prefillCandidateId: "c0",
  };
}

async function cleanupBatch() {
  const sessions = await prisma.triageSession.findMany({ where: { sourceRef: SESSION_REF }, select: { id: true } });
  await prisma.triageQuestion.deleteMany({ where: { sessionId: { in: sessions.map((s) => s.id) } } });
  await prisma.triageSession.deleteMany({ where: { sourceRef: SESSION_REF } });
}

test.describe("P8 自動化第二批", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });
  test.afterAll(async () => {
    await cleanupBatch();
    await prisma.generatedFile.deleteMany({ where: { month: MONTH_DATE } });
    await prisma.monthClose.deleteMany({ where: { month: MONTH_DATE } });
    await prisma.guard.deleteMany({ where: { nameZh: { startsWith: "測試到期E2E" } } });
    // run-now 試跑會寫通知（主管／老闆）：清走，免得其他 spec 見到側欄「首頁」未讀 badge（連結名變「首頁 1」）
    await prisma.appNotification.deleteMany({ where: { kind: { in: ["permit_expiry_weekly", "month_files_ready", "one_click_auto", "ops_digest_ready"] } } });
  });

  test("待答題批量接受：對話框列清單、可取消剔、5 秒撤銷零請求、確認後 body 正確、結果摘要", async ({ page }) => {
    await cleanupBatch();
    const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
    const session = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: SESSION_REF, ownerUserId: boss.id, createdBy: boss.id } });
    const mk = (n: number, withSuggestion: boolean, confidence: "propose" | "unknown" = "propose") =>
      prisma.triageQuestion.create({
        data: {
          sessionId: session.id,
          kind: "month_close_settlement",
          groupKey: `e2e-${n}`,
          sort: n,
          title: `測試批量盤${n}`,
          evidenceJson: (withSuggestion ? { ...mcEvidence(`測試批量盤${n}`), confidence } : { ...mcEvidence(`測試批量盤${n}`), suggestion: null, confidence: "unknown", prefillCandidateId: null }) as never,
          optionsJson: (withSuggestion ? [{ id: "mc_accept", label: "一撳確認" }, { id: "skip", label: "跳過" }] : [{ id: "skip", label: "跳過" }]) as never,
        },
      });
    const q1 = await mk(1, true);
    const q2 = await mk(2, true);
    const q3 = await mk(3, true, "unknown"); // 有預填但把握低：列出，但預設唔剔
    await mk(4, false); // 冇建議：唔列入

    const posts: string[] = [];
    await page.route("**/api/triage/questions/batch-accept", async (route) => {
      const r = route.request();
      if (r.method() !== "POST") return route.continue();
      posts.push(r.postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batch_id: "b-1", results: [{ id: q1.id, status: "answered", reason: null }], counts: { answered: 1, skipped: 0, error: 0 } }) });
    });

    await loginAs(page, "老闆");
    await page.goto("/triage");
    const open = page.getByTestId("batch-accept-open");
    await expect(open).toBeVisible();
    await expect(open).toContainText("批量接受建議（3 題）");
    await open.click();
    const dialog = page.getByTestId("batch-accept-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("batch-accept-item")).toHaveCount(3);
    await expect(dialog).toContainText("測試批量盤1");
    await expect(dialog).not.toContainText("測試批量盤4");
    await expect(page.getByRole("checkbox", { name: "接受 測試批量盤3" })).not.toBeChecked(); // 把握低預設唔剔
    await expect(dialog.getByTestId("batch-accept-confirm")).toContainText("確認接受 2 題");
    await expect(dialog).toContainText("送出之後唔可以一鍵撤銷");

    // 1) 撤銷：零請求
    await dialog.getByTestId("batch-accept-confirm").click();
    await expect(page.getByTestId("batch-accept-undo-bar")).toBeVisible();
    await page.getByTestId("batch-accept-undo-bar").getByTestId("undo-bar-undo").click();
    await expect(page.getByTestId("batch-accept-undo-bar")).toHaveCount(0);
    await page.waitForTimeout(6000);
    expect(posts).toHaveLength(0);
    expect(await prisma.triageQuestion.count({ where: { sessionId: session.id, status: "answered" } })).toBe(0);

    // 2) 取消剔第 2 題，確認 → 5 秒後送出
    await page.getByTestId("batch-accept-open").click();
    await page.getByRole("checkbox", { name: "接受 測試批量盤2" }).uncheck();
    await expect(page.getByTestId("batch-accept-confirm")).toContainText("確認接受 1 題");
    await page.getByTestId("batch-accept-confirm").click();
    await expect(page.getByTestId("batch-accept-undo-bar")).toBeVisible();
    await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
    expect(JSON.parse(posts[0]!)).toEqual({ question_ids: [q1.id] });
    await expect(page.getByTestId("batch-accept-summary")).toHaveText("已答 1、跳過 0、失敗 0");
    void q2;
    void q3;
  });

  test("已生成檔案頁：列表、autopay 下載先確認、權限（雞頭見唔到）", async ({ page }) => {
    await prisma.generatedFile.deleteMany({ where: { month: MONTH_DATE } });
    const content = new Uint8Array(Buffer.from("PK-e2e-fake-xlsx"));
    const mkFile = (kind: string, filename: string) =>
      prisma.generatedFile.create({ data: { month: MONTH_DATE, kind, filename, content, size: content.length, sha256: "0".repeat(64), generatedBy: "job:after_lock_exports", sourceLockedAt: new Date() } });
    await mkFile("payroll_detail", `payroll-${MONTH}.xlsx`);
    await mkFile("longterm_autopay", `longterm-autopay-BOCHK-PayrollEditor-${MONTH}.xlsx`);
    const boss = await prisma.user.findFirstOrThrow({ where: { tel: TEST_TEL["老闆"] } });
    await prisma.monthClose.upsert({ where: { month: MONTH_DATE }, create: { month: MONTH_DATE, lockedAt: new Date(), lockedBy: boss.id, createdBy: "e2e" }, update: { lockedAt: new Date() } });

    await loginAs(page, "老闆");
    // 月結頁已鎖：有「已生成檔案」連結
    await page.goto(`/month-close?month=${MONTH}`);
    await page.getByTestId("month-close-files-link").click();
    await page.waitForURL(/\/month-close\/files\?month=2031-02/);
    const rows = page.getByTestId("generated-file-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator('[data-kind="longterm_autopay"]')).toContainText("入銀行前要人覆核");

    // 糧明細：直接下載
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-kind="payroll_detail"]').getByTestId("generated-file-download").click()]);
    expect(dl.suggestedFilename()).toBe(`payroll-${MONTH}.xlsx`);
    // autopay：先彈確認；取消 → 冇下載
    await page.locator('[data-kind="longterm_autopay"]').getByTestId("generated-file-download").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("入銀行前請先人手覆核");
    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    // 確認 → 下載
    await page.locator('[data-kind="longterm_autopay"]').getByTestId("generated-file-download").click();
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByTestId("confirm-dialog-ok").click()]);
    expect(dl2.suggestedFilename()).toBe(`longterm-autopay-BOCHK-PayrollEditor-${MONTH}.xlsx`);
    // 直接打 autopay 下載 URL 唔帶 confirm_locked → 400
    const fileId = (await prisma.generatedFile.findFirstOrThrow({ where: { month: MONTH_DATE, kind: "longterm_autopay" } })).id;
    const direct = await page.request.get(`/api/files/${fileId}`);
    expect(direct.status()).toBe(400);

    // 雞頭：API 403、頁面見到錯誤
    await page.context().clearCookies();
    await loginAs(page, "雞頭A");
    await page.goto(`/month-close/files?month=${MONTH}`);
    await expect(page.getByTestId("generated-file-row")).toHaveCount(0);
    expect((await page.request.get(`/api/files?month=${MONTH}`)).status()).toBe(403);
    expect((await page.request.get(`/api/files/${fileId}`)).status()).toBe(403);
  });

  test("保安員頁 /guards?expiring=30：預設篩選 30 日內到期", async ({ page }) => {
    await prisma.guard.deleteMany({ where: { nameZh: { startsWith: "測試到期E2E" } } });
    const day = (n: number) => new Date(new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime() + n * 86400000);
    await prisma.guard.create({ data: { nameZh: "測試到期E2E近", employmentType: "cash_casual", safetyCardExpiry: day(10), createdBy: "e2e" } });
    await prisma.guard.create({ data: { nameZh: "測試到期E2E遠", employmentType: "cash_casual", safetyCardExpiry: day(60), createdBy: "e2e" } });
    await loginAs(page, "老闆");
    await page.goto("/guards?expiring=30");
    await expect(page.getByTestId("guards-expiring-toggle")).toBeChecked();
    await expect(page.getByText("牌照／平安卡／QAS 30 日內到期", { exact: true })).toBeVisible();
    await expect(page.getByText("測試到期E2E近").first()).toBeVisible();
    await expect(page.getByText("測試到期E2E遠")).toHaveCount(0);
    // 取消後再剔＝90 日（舊行為）：兩個都見到
    await page.getByTestId("guards-expiring-toggle").uncheck();
    await expect(page.getByText("牌照／平安卡／QAS 90 日內到期", { exact: true })).toBeVisible();
    await page.getByTestId("guards-expiring-toggle").check();
    await expect(page.getByText("測試到期E2E遠").first()).toBeVisible();
  });

  test("自動排程頁：新增 4 個 job 都列出；證件到期週報可立即試跑（唯讀）", async ({ page }) => {
    await loginAs(page, "老闆");
    await page.goto("/settings/jobs");
    for (const k of ["auto_one_click", "after_lock_exports", "permit_expiry_weekly", "lock_ops_digest"]) await expect(page.getByTestId(`job-${k}`)).toBeVisible();
    await page.getByTestId("job-permit_expiry_weekly-run-now").click();
    await expect(page.getByText(/證件到期週報：試跑/)).toBeVisible();
    await expect.poll(() => prisma.jobRun.count({ where: { jobKey: "permit_expiry_weekly", trigger: "manual" } })).toBeGreaterThan(0);
  });

  test("用戶頁：系統排程帳號（inactive）預設唔列；就算列出亦冇編輯／恢復／重設掣", async ({ page }) => {
    const role = await prisma.role.findFirstOrThrow({ where: { baseRole: "老闆" } });
    await prisma.user.upsert({ where: { tel: "00000000" }, create: { name: "系統排程", tel: "00000000", passwordHash: "!system-account-no-login", roleId: role.id, status: "inactive" }, update: {} });
    await loginAs(page, "老闆");
    await page.goto("/users");
    await expect(page.getByTestId("user-row").first()).toBeVisible();
    const row = page.getByTestId("user-row").filter({ hasText: "系統排程" });
    // /api/users 預設只列 active，系統帳號唔出現；若將來列出，只可有「系統」標記、冇任何掣
    if ((await row.count()) > 0) {
      await expect(row.getByTestId("user-system-badge")).toBeVisible();
      await expect(row.getByRole("button")).toHaveCount(0);
    }
    expect((await page.request.get("/api/users?include_inactive=1")).status()).toBe(200);
    const sys = await prisma.user.findFirstOrThrow({ where: { tel: "00000000" } });
    expect((await page.request.post(`/api/users/${sys.id}/unvoid`)).status()).toBe(403);
    expect((await page.request.post(`/api/users/${sys.id}/reset-password`)).status()).toBe(403);
  });
});
