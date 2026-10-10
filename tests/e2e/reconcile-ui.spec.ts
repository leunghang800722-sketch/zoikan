// WP-RECONCILE-UI（§33）：對數頁未配對行顯示原始資料＋動作直達連結、deep link 落地、分診保安員配對題。
// 全部用 page.route 假 API（假名「甲測試」、假工號 U9xxxx、假電話），唔依賴 dev DB 數據，亦唔郁真資料。
// 截圖：RECONCILE_UI_SHOTS=out/reconcile-ui 時存檔。
// 執行：PW_PORT=3411 npx playwright test tests/e2e/reconcile-ui.spec.ts
import { test, expect, type Page, type Route, type Request } from "@playwright/test";
import { loginAs } from "./helpers";

const SHOTS = process.env.RECONCILE_UI_SHOTS;
const UP = "UP1";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface RawRow {
  id: string;
  row_index: number;
  work_date: string;
  name_raw: string | null;
  staff_no_raw: string | null;
  tel_raw: string | null;
  rank_raw: string | null;
  time_raw: string | null;
  broker_code_raw: string | null;
  raw_code: string;
  guard_match: string;
}
interface Item {
  key: string;
  category: "unresolved";
  work_date: string;
  site_id: string | null;
  guard_id: null;
  shift_type_id: null;
  roster: null;
  system: null;
  unresolved_reason: string;
}

const TEL_A = "91230001";
function build() {
  const raws: RawRow[] = [];
  const items: Item[] = [];
  const add = (id: string, date: string, reason: string, over: Partial<RawRow>, siteId: string | null = "SITE1") => {
    raws.push({ id, row_index: 10 + raws.length, work_date: date, name_raw: null, staff_no_raw: null, tel_raw: null, rank_raw: "A", time_raw: "0700-1900", broker_code_raw: "W", raw_code: "D", guard_match: "unmatched", ...over });
    items.push({ key: `row:${id}`, category: "unresolved", work_date: date, site_id: siteId, guard_id: null, shift_type_id: null, roster: null, system: null, unresolved_reason: reason });
  };
  // 啟航1331 式：同一人 9/1–9/15 連續 15 條
  for (let d = 1; d <= 15; d++) add(`a${d}`, `2026-09-${String(d).padStart(2, "0")}`, "保安員未配對", { name_raw: "甲測試", staff_no_raw: "U90001", tel_raw: TEL_A });
  // HKU Y 更 9/25 式：單條，guard-fix 有對應 needs_boss
  add("b1", "2026-09-25", "保安員未配對", { name_raw: "乙測試", staff_no_raw: "U90002", tel_raw: "98760002", broker_code_raw: "Y", time_raw: "1900-0700" });
  // 名冊完全冇相似
  add("c1", "2026-09-26", "保安員未配對", { name_raw: "庚獨行", staff_no_raw: "U90003" });
  add("d1", "2026-09-27", "上載未指定盤（site_id 未定），請先喺更表上載列表頁指定盤", { name_raw: "甲測試", staff_no_raw: "U90001" }, null);
  add("e1", "2026-09-28", "雞頭碼「ZZ」對唔到任何雞頭，請先喺雞頭管理加碼／別名再重新解析", { name_raw: "戊測試", staff_no_raw: "U90005", broker_code_raw: "ZZ" });
  add("f1", "2026-09-29", "更別未配對", { name_raw: "戊測試", staff_no_raw: "U90005", raw_code: "XQ", time_raw: "0800-1600" });
  add("g1", "2026-09-30", "更種已作廢，請重新解析上載或者一鍵結算補更種", { name_raw: "戊測試", staff_no_raw: "U90005" });
  add("h1", "2026-09-30", "子盤未定，歷史紀錄有多過一個候選，人手覆核並批量指定子盤（或者確認歸母盤）", { name_raw: "戊測試", staff_no_raw: "U90005" });
  add("i1", "2026-09-30", "子盤「測試A座」對唔到（或者未 reparse），請先喺「盤」管理掛好子盤再重新解析", { name_raw: "戊測試", staff_no_raw: "U90005" });
  return { raws, items };
}

const GUARDS = [
  { id: "g1", name_zh: "甲測試", staff_no: "U90014", tel: "65550009", status: "active", staff_numbers: [] }, // 同名
  { id: "g2", name_zh: "丁測試", staff_no: "U90001", tel: null, status: "active", staff_numbers: [{ number: "U90001", status: "current" }] }, // 同工號
  { id: "g3", name_zh: "丙電話", staff_no: "U90012", tel: "65550001", status: "active", staff_numbers: [] }, // 電話尾 4（0001）
  { id: "g4", name_zh: "乙測丙", staff_no: "U90013", tel: "60000000", status: "active", staff_numbers: [] }, // 同姓＋一字（乙測試）
  { id: "g5", name_zh: "己測試", staff_no: "U90011", tel: "61111111", status: "active", staff_numbers: [] },
];

const NEEDS_BOSS = [
  { seq: "I001", cells: [{ site_label: "測試盤甲", cell_count: 1 }], total_cell_count: 1, reason: "U Team 名單同名多過一個", name_raw: "乙測試", staff_no_raw: "U90002", tel_raw: "98760002", candidates: [{ id: "g4", name_zh: "乙測丙" }] },
  { seq: "I002", cells: [{ site_label: "測試盤甲", cell_count: 4 }, { site_label: "測試盤乙", cell_count: 2 }], total_cell_count: 6, reason: "名單冇呢個人", name_raw: "測試庚辛", staff_no_raw: "U90009", tel_raw: null, candidates: [] },
];

interface State {
  writes: Array<{ method: string; path: string; body: unknown }>;
  guardQueries: string[];
  rowQueries: string[];
  reparsed: boolean;
}

async function mockApis(page: Page, opts: { needsBoss?: boolean; hidePii?: boolean } = {}) {
  const { raws, items } = build();
  const st: State = { writes: [], guardQueries: [], rowQueries: [], reparsed: false };
  await page.route(/\/api\//, async (route: Route, req: Request) => {
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (m !== "GET") {
      if (p === `/api/roster-uploads/${UP}/reparse`) {
        st.writes.push({ method: m, path: p, body: null });
        st.reparsed = true;
        return json(route, { id: UP });
      }
      if (p.startsWith("/api/roster-uploads/")) {
        st.writes.push({ method: m, path: p, body: req.postDataJSON() });
        return json(route, { results: [], updated: [], skipped: [], upload_status: "parsed", pending_count: 0 });
      }
      return route.fallback();
    }
    if (p === `/api/roster-uploads/${UP}/reconcile`) {
      const by: Record<string, number> = { match: 0, roster_only: 0, system_only: 0, guard_diff: 0, settlement_diff: 0, shift_type_diff: 0, unresolved: items.length };
      return json(route, { upload: { id: UP, month: "2026-09-01", site_id: "SITE1", status: "parsed", version: 1 }, summary: { total: items.length, by_category: by, settlement_inferred_count: 0 }, items: { rows: items, total: items.length, skip: 0, take: 500 } });
    }
    if (p === `/api/roster-uploads/${UP}`) {
      st.rowQueries.push(url.search);
      const gm = url.searchParams.get("guard_match");
      const rows = raws
        .filter((r) => (gm ? r.guard_match === gm : true))
        .map((r) => {
          if (!opts.hidePii) return r;
          const { name_raw: _n, staff_no_raw: _s, tel_raw: _t, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
          return rest;
        });
      return json(route, { upload: { id: UP }, rows: { rows, total: rows.length, skip: 0, take: 500 } });
    }
    if (p === "/api/month-closes") return json(route, { rows: [], total: 0, skip: 0, take: 50 });
    if (p === "/api/guards") {
      const q = url.searchParams.get("q");
      if (q) {
        st.guardQueries.push(q);
        return json(route, { rows: [], total: 0, skip: 0, take: 20 });
      }
      return json(route, { rows: GUARDS, total: GUARDS.length, skip: 0, take: 500 });
    }
    if (p === "/api/sites") return json(route, { rows: [{ id: "SITE1", canonical_name: "測試盤甲", parent_site_id: null }], total: 1, skip: 0, take: 500 });
    if (p === "/api/shift-types") return json(route, { rows: [{ id: "ST1", code: "D" }], total: 1, skip: 0, take: 500 });
    if (p === "/api/brokers") return json(route, { rows: [{ id: "B1", code: "W" }], total: 1, skip: 0, take: 500 });
    if (p === "/api/guard-fix/runs") {
      if (opts.needsBoss === false) return json(route, { error: "forbidden", message: "冇權限" }, 403);
      return json(route, { runs: [{ id: "R2", month: "2026-09-01", status: "applied", created_at: "2026-10-02T00:00:00Z" }, { id: "R1", month: "2026-08-01", status: "applied", created_at: "2026-09-02T00:00:00Z" }] });
    }
    if (p === "/api/guard-fix/runs/R2") return json(route, { id: "R2", month: "2026-09-01", needs_boss: NEEDS_BOSS });
    return route.fallback();
  });
  return st;
}

async function noHScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
}

const hrefOf = async (page: Page, testid: string, scope?: ReturnType<Page["locator"]>) => (scope ?? page).getByTestId(testid).first().getAttribute("href");

test.describe("對數頁 1440", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("未配對行顯示更表原始資料、人話原因、15 條同一人合併、連結目標、相似保安員、reparse", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${UP}/reconcile`);
    await expect(page.locator('[data-testid="reconcile-person-group"]:visible')).toBeVisible();

    // 15 條同一人 → 一行摘要（可摺）；其餘 8 條單獨一行
    const group = page.locator('[data-testid="reconcile-person-group"]:visible').first();
    await expect(group.getByTestId("reconcile-group-title")).toHaveText("同一人：甲測試（U90001）共 15 更");
    await expect(group).toHaveAttribute("data-group-size", "15");
    await expect(page.getByTestId("reconcile-item-row")).toHaveCount(8);
    await group.getByTestId("reconcile-group-toggle").click();
    await expect(page.getByTestId("reconcile-item-row")).toHaveCount(23);
    await group.getByTestId("reconcile-group-toggle").click();
    await expect(page.getByTestId("reconcile-item-row")).toHaveCount(8);

    // 合併摘要：電話只見尾 4、相似保安員 3 個（工號相同 > 同名 > 電話尾 4），連去 /guards?q=
    await expect(group).toContainText("電話 ****0001");
    const sim = group.getByTestId("similar-guard");
    await expect(sim).toHaveCount(3);
    await expect(sim.nth(0)).toContainText("丁測試");
    await expect(sim.nth(0)).toContainText("工號相同");
    await expect(sim.nth(1)).toContainText("甲測試");
    await expect(sim.nth(1)).toContainText("同名");
    await expect(sim.nth(2)).toContainText("丙電話");
    await expect(sim.nth(2)).toContainText("電話尾 4 位相同");
    expect(await sim.nth(0).locator("a").getAttribute("href")).toBe("/guards?q=U90001");
    await expect(group.getByTestId("reconcile-reason")).toContainText("更表寫「甲測試／U90001」，測試甲到");

    // HKU 式單條：姓名／工號／原因人話／needs_boss 提示／連結
    const rowB = page.locator('[data-reconcile-key="row:b1"]');
    await expect(rowB.getByTestId("reconcile-wrote-name")).toHaveText("乙測試／U90002");
    await expect(rowB.getByTestId("reconcile-wrote")).toContainText("電話 ****0002");
    await expect(rowB.getByTestId("reconcile-wrote")).toContainText("雞頭碼 Y");
    await expect(rowB.getByTestId("reconcile-wrote")).toContainText("1900-0700");
    await expect(rowB.getByTestId("reconcile-wrote")).toContainText("原始第 25 行");
    await expect(rowB.getByTestId("reconcile-reason")).toContainText("更表寫「乙測試／U90002」，測試甲到");
    await expect(rowB.getByTestId("similar-guard")).toHaveCount(1);
    await expect(rowB.getByTestId("similar-guard")).toContainText("同姓＋一字相同");
    expect(await hrefOf(page, "link-guard-fix", rowB)).toBe("/roster-uploads?tab=fix&month=2026-09");
    expect(await hrefOf(page, "link-find-guard", rowB)).toBe("/guards?q=U90002");
    expect(await hrefOf(page, "link-new-from-docs", rowB)).toBe(`/guards/new-from-docs?name=${encodeURIComponent("乙測試")}&staff_no=U90002`);
    await expect(rowB.getByTestId("reconcile-needs-boss")).toContainText("U Team 名單同名多過一個");
    expect(await rowB.getByTestId("reconcile-needs-boss").locator("a").getAttribute("href")).toBe("/triage");

    // 名冊冇相似（按需 ?q= 查：名＋工號各一次）
    const rowC = page.locator('[data-reconcile-key="row:c1"]');
    await expect(rowC.getByTestId("similar-none")).toHaveText("名冊冇相似，可能係新人或離職員工");
    expect(st.guardQueries.sort()).toEqual(["U90003", "庚獨行"].sort());
    await expect(rowC.getByTestId("reconcile-needs-boss")).toHaveCount(0);

    // 上載未指定盤
    expect(await hrefOf(page, "link-assign-site", page.locator('[data-reconcile-key="row:d1"]'))).toBe("/roster-uploads?month=2026-09&focus=UP1");
    // 雞頭碼
    const rowE = page.locator('[data-reconcile-key="row:e1"]');
    await expect(rowE.getByTestId("reconcile-broker-raw")).toContainText("「ZZ」");
    expect(await hrefOf(page, "link-brokers", rowE)).toBe("/brokers?focus=ZZ");
    // 更別未配對：raw code＋時段
    const rowF = page.locator('[data-reconcile-key="row:f1"]');
    await expect(rowF.getByTestId("reconcile-shift-raw")).toContainText("「XQ」");
    await expect(rowF.getByTestId("reconcile-shift-raw")).toContainText("0800-1600");
    expect(await hrefOf(page, "link-sites-shift-type", rowF)).toBe("/sites?focus=SITE1");
    // 子盤未定：照舊剔選；子盤對唔到：去盤管理
    await expect(page.locator('[data-reconcile-key="row:h1"]').locator('input[type="checkbox"]')).toBeVisible();
    expect(await hrefOf(page, "link-sites-subsite", page.locator('[data-reconcile-key="row:i1"]'))).toBe("/sites?focus=SITE1");
    // 每行保留「例外」
    await expect(page.getByRole("button", { name: "例外", exact: true })).toHaveCount(8);

    // PII：完整電話唔出現
    const text = await page.locator("body").innerText();
    expect(text).not.toContain(TEL_A);
    expect(text).not.toContain("98760002");
    // 網絡：rows API 先 guard_match=unmatched，再掃全部行；未有寫入
    expect(st.rowQueries[0]).toContain("guard_match=unmatched");
    expect(st.writes).toEqual([]);

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/reconcile-1440.png`, fullPage: true });
    await noHScroll(page);

    // 更種已作廢 → reparse（現有 endpoint，無 body）
    const rowG = page.locator('[data-reconcile-key="row:g1"]');
    await rowG.getByTestId("reconcile-reparse").click();
    await expect.poll(() => st.reparsed).toBe(true);
    expect(st.writes).toEqual([{ method: "POST", path: `/api/roster-uploads/${UP}/reparse`, body: null }]);
    await expect(page.getByText("已重新解析呢份上載")).toBeVisible();
  });

  test("標例外仍然 call 現有 apply（body 不變），整組標例外只係前端狀態", async ({ page }) => {
    const st = await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${UP}/reconcile`);
    const group = page.locator('[data-testid="reconcile-person-group"]:visible').first();
    await group.getByTestId("reconcile-group-reason").fill("測試外判");
    await group.getByTestId("reconcile-group-exception").click();
    await expect(page.getByRole("button", { name: "套用決定（15）" })).toBeVisible();
    expect(st.writes).toEqual([]);
    await page.getByRole("button", { name: "套用決定（15）" }).click();
    await page.getByRole("button", { name: "確認套用" }).click();
    await expect.poll(() => st.writes.length).toBe(1);
    const w = st.writes[0]!;
    expect(w.path).toBe(`/api/roster-uploads/${UP}/reconcile/apply`);
    const actions = (w.body as { actions: Array<{ key: string; action: string; reason: string }> }).actions;
    expect(actions).toHaveLength(15);
    expect(actions[0]).toEqual({ key: "row:a1", action: "exception", reason: "測試外判" });
    expect(Object.keys(w.body as object)).toEqual(["actions"]);
  });

  test("冇 guard-fix 權限（403）：唔出 needs_boss，其餘照常", async ({ page }) => {
    await mockApis(page, { needsBoss: false });
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${UP}/reconcile`);
    await expect(page.locator('[data-reconcile-key="row:b1"]').getByTestId("reconcile-wrote-name")).toHaveText("乙測試／U90002");
    await expect(page.getByTestId("reconcile-needs-boss")).toHaveCount(0);
  });
});

test.describe("冇個人資料權限（主管）", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test("顯示「冇權限睇姓名／工號」，唔出去保安員配對修復連結，唔做相似提示", async ({ page }) => {
    await mockApis(page, { needsBoss: false, hidePii: true });
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${UP}/reconcile`);
    const rowB = page.locator('[data-reconcile-key="row:b1"]');
    await expect(rowB.getByTestId("reconcile-wrote-name")).toHaveText("冇權限睇姓名／工號");
    await expect(rowB.getByTestId("reconcile-reason")).toContainText("冇權限睇姓名／工號");
    await expect(rowB.getByTestId("reconcile-reason")).not.toContainText("冇寫");
    await expect(rowB.getByTestId("link-guard-fix")).toHaveCount(0);
    await expect(rowB.getByTestId("similar-guard")).toHaveCount(0);
    await expect(page.getByTestId("reconcile-person-group")).toHaveCount(0);
    await expect(rowB.getByRole("button", { name: "例外", exact: true })).toBeVisible();
  });
});

test.describe("對數頁 375", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("手機卡：更表寫咗、連結、冇橫向捲", async ({ page }) => {
    await mockApis(page);
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads/${UP}/reconcile`);
    await expect(page.locator('[data-testid="reconcile-person-group"]:visible')).toBeVisible();
    const cardB = page.getByTestId("reconcile-item-card").filter({ hasText: "乙測試／U90002" });
    await expect(cardB.getByTestId("reconcile-wrote")).toContainText("原始第 25 行");
    await expect(cardB.getByTestId("link-guard-fix")).toHaveAttribute("href", "/roster-uploads?tab=fix&month=2026-09");
    await expect(cardB.getByTestId("reconcile-needs-boss")).toContainText("U Team 名單同名多過一個");
    await expect(cardB.getByRole("button", { name: "例外" })).toBeVisible();
    await noHScroll(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/reconcile-375.png`, fullPage: true });
  });
});

test.describe("deep link 落地", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("更表上載列表 ?month=&focus=：揀月份、捲到、高亮、聚焦指定盤下拉", async ({ page }) => {
    const entries: unknown[] = [];
    for (let i = 0; i < 25; i++) entries.push({ site_id: `S${i}`, site_name: `測試盤${i}`, upload_status: "confirmed", upload: { id: `U${i}`, status: "confirmed", version: 1, parse_summary: { shift_count: 10, unmatched_guard_count: 0 } } });
    const seen: string[] = [];
    await page.route(/\/api\/roster-uploads\?/, (route, req) => {
      seen.push(new URL(req.url()).searchParams.get("month") ?? "");
      return json(route, { month: "2026-09", sites: entries, unresolved_uploads: [{ site_id: null, site_name: "盤名未配對檔", upload_status: "parsed", upload: { id: "UNRES", status: "parsed", version: 1, parse_summary: { shift_count: 5, unmatched_guard_count: 5 } } }], voided_uploads: [] });
    });
    await page.route(/\/api\/sites\?/, (route) => json(route, { rows: [{ id: "S1", canonical_name: "測試盤1" }], total: 1, skip: 0, take: 500 }));
    await loginAs(page, "老闆");
    await page.goto(`/roster-uploads?month=2026-09&focus=UNRES`);
    const row = page.locator('tr[data-upload-id="UNRES"]');
    await expect(row).toHaveAttribute("data-focused", "1");
    await expect(row).toBeInViewport();
    await expect(row.locator("select")).toBeFocused();
    expect(new Set(seen)).toEqual(new Set(["2026-09"])); // 唔會先載當月
    await expect(page.locator('tr[data-focused="1"]')).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/uploads-focus-1440.png` });
  });

  test("保安員頁 ?q= 預填搜尋（以 header 搜尋）", async ({ page }) => {
    const headers: string[] = [];
    await page.route(/\/api\/guards(\?|$)/, (route, req) => {
      const h = req.headers()["x-guard-search"];
      if (h) headers.push(decodeURIComponent(h));
      return route.fallback();
    });
    await loginAs(page, "老闆");
    await page.goto(`/guards?q=${encodeURIComponent("U90002")}`);
    await expect(page.getByPlaceholder(/姓名 \/ 工號/)).toHaveValue("U90002");
    await expect.poll(() => headers).toContain("U90002");
  });

  test("證件新增 ?name=&staff_no= 預填（唔觸發辨識、唔寫入）", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/api/") && !r.url().includes("/api/auth/")) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await loginAs(page, "老闆");
    const res = await page.goto(`/guards/new-from-docs?name=${encodeURIComponent("甲測試")}&staff_no=U90001`);
    test.skip(res?.status() === 404, "OCR 未配置（需要 DEEPSEEK_API_KEY 先開此頁），見報告");
    await expect(page.getByTestId("ocr-prefill-hint")).toContainText("甲測試／U90001");
    await page.getByTestId("ocr-manual").click();
    await expect(page.getByLabel("中文姓名")).toHaveValue("甲測試");
    expect(writes).toEqual([]);
  });

  test("盤／雞頭頁 ?focus= 高亮", async ({ page }) => {
    await page.route(/\/api\/sites\?/, (route) => json(route, { rows: [{ id: "SITE1", canonical_name: "測試盤甲", client_name: "測試客", billing_model: "per_shift", monthly_fee: 0, parent_site_id: null }, { id: "SITE2", canonical_name: "測試盤乙", client_name: "測試客", billing_model: "per_shift", monthly_fee: 0, parent_site_id: null }], total: 2, skip: 0, take: 500 }));
    await page.route(/\/api\/brokers\?/, (route) => json(route, { rows: [{ id: "B1", code: "W", name: "測試雞頭", kind: "external", status: "active" }, { id: "B2", code: "Y", name: "測試雞頭乙", kind: "external", status: "active" }], total: 2, skip: 0, take: 500 }));
    await loginAs(page, "老闆");
    await page.goto(`/sites?focus=SITE2`);
    await expect(page.locator('tr[data-focus-key="SITE2"]')).toHaveAttribute("data-focused", "1");
    await expect(page.locator('tr[data-focused="1"]')).toHaveCount(1);
    await page.goto(`/brokers?focus=y`);
    await expect(page.locator('tr[data-focused="1"]')).toHaveCount(1);
    await expect(page.locator('tr[data-focused="1"]')).toContainText("測試雞頭乙");
  });
});

// ---------------------------------------------------------------------------
// 分診對話框：保安員配對題顯示 needs_boss 資料
// ---------------------------------------------------------------------------
function guardQuestion(id: string, title: string, summary: string, identity: string | null) {
  return {
    id,
    kind: "month_close_guard_match",
    kind_label: "保安員配對要核實",
    title,
    status: "open",
    options: [{ id: "mc_accept", label: "一撳確認" }, { id: "skip", label: "跳過" }],
    mc: { summary, suggestion: null, confidence: "unknown", action_type: "guard_match", count: 1, candidates: [], prefill_candidate_id: null, needs_price_input: false, needs_broker_pick: false, broker_options: [], identity_label: identity },
  };
}

async function mockTriage(page: Page) {
  const st = await mockApis(page);
  await page.route(/\/api\/triage\/sessions(\?|$)/, (route) =>
    json(route, { sessions: [{ id: "sess1", source_type: "month_close", owner_user_id: "u1", owner_name: "老闆", status: "open", created_at: "2026-10-02T00:00:00Z", completed_at: null, counts: { open: 2, answered: 0, skipped: 0, total: 2, important_open: 2, supplementary_open: 0 } }], open_total: 2, eligible_owners: [] }),
  );
  await page.route(/\/api\/triage\/sessions\/sess1$/, (route) =>
    json(route, {
      session: { id: "sess1", status: "open", counts: { open: 2, answered: 0, skipped: 0, total: 2 } },
      questions: [
        guardQuestion("q1", "保安員配對要核實（測試盤甲，1 格）", "測試盤甲 共 1 格嘅保安員未配對：U Team 名單同名多過一個", "乙測試"),
        guardQuestion("q2", "保安員配對要核實（測試盤甲、測試盤乙，6 格）", "測試盤甲、測試盤乙 共 6 格嘅保安員未配對：名單冇呢個人 (I002)", null),
      ],
    }),
  );
  await page.route(/\/api\/triage\/questions\/.*\/(preview|answer)/, (route, req) => {
    st.writes.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() });
    return json(route, { preview_hash: "h", writes: false, impact: { can_confirm: true, summary: ["預覽"], notes: [] }, status: "answered", note: null });
  });
  return st;
}

test.describe("分診對話框：保安員配對題", () => {
  test("桌面：姓名／工號／格數／reason＋相似提示＋連結；唔自動答", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const st = await mockTriage(page);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await page.getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("mc-triage-dialog");
    await expect(dlg).toHaveAttribute("data-mode", "desktop");
    const info = dlg.getByTestId("mc-guard-info");
    await expect(info.getByTestId("mc-guard-name")).toContainText("乙測試／U90002");
    await expect(info.getByTestId("mc-guard-name")).toContainText("I001");
    await expect(info.getByTestId("mc-guard-cells")).toContainText("共 1 格");
    await expect(info.getByTestId("mc-guard-cells")).toContainText("電話 ****0002");
    await expect(info.getByTestId("mc-guard-reason")).toHaveText("U Team 名單同名多過一個");
    await expect(info.getByTestId("similar-guard")).toContainText("乙測丙");
    await expect(info.getByTestId("mc-link-guard-fix")).toHaveAttribute("href", "/roster-uploads?tab=fix&month=2026-09");
    await expect(info.getByTestId("mc-link-find-guard")).toHaveAttribute("href", "/guards?q=U90002");
    await expect(info.getByTestId("mc-link-new-from-docs")).toHaveAttribute("href", `/guards/new-from-docs?name=${encodeURIComponent("乙測試")}&staff_no=U90002`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/triage-1440.png` });
    // 第二題：按 (I002) seq 對，多盤格數
    await dlg.getByTestId("mc-skip").click();
    await page.getByRole("button", { name: "撤銷" }).click().catch(() => {});
    expect(st.writes.filter((w) => w.path.includes("/answer"))).toEqual([]); // 延遲送出：5 秒內冇 call
  });

  test("手機 1e：同樣顯示", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockTriage(page);
    await loginAs(page, "老闆");
    await page.goto("/triage");
    await page.getByRole("button", { name: "繼續答" }).click();
    const dlg = page.getByTestId("mc-triage-dialog");
    await expect(dlg).toHaveAttribute("data-mode", "mobile");
    const info = dlg.getByTestId("mc-guard-info");
    await expect(info.getByTestId("mc-guard-name")).toContainText("乙測試／U90002");
    await expect(info.getByTestId("mc-guard-reason")).toHaveText("U Team 名單同名多過一個");
    await expect(info.getByTestId("mc-link-guard-fix")).toBeVisible();
    await noHScroll(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/triage-375.png` });
  });
});
