// WP-POSTORDER-PO-PAIRS（老闆 2026-09-27 再緊急）：連 longterm-pairs.csv
// （~3KB）操作員都傳唔到，但正式站已經有完整、冇截短嘅 `PostOrder.csv`。
// 呢個測試檔覆蓋三層：
//   1. `derivePostorderLongtermPostsFromPostorderGrid()`／
//      `derivePostorderLongtermPostsFromPostorderCsv()`（`postorder.ts`）
//      ——純函數合成單元測試。
//   2. `mergeLongtermPostCells()`（`plan.ts`）——Roster/pairs 路徑同
//      PostOrder 推出嘅組合合併策略。
//   3. `POST /api/guard-fix/postorder` 第四條路徑（淨係 `postorder_csv`）
//      integration test。
//   4. 真檔 skipIf：`data/2026-09/postorder-csv/PostOrder.csv`（gitignored，
//      冇呢個檔嘅環境自動 skip）。
//
// 鐵則：合成 fixture 用假人名。
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listPostorder, POST as uploadPostorder } from "@/app/api/guard-fix/postorder/route";
import { derivePostorderLongtermPostsFromPostorderCsv, parseLongtermPairsCsv, type PostorderLongtermPostCell } from "@/lib/guard-fix/postorder";
import { mergeLongtermPostCells, buildKnownGuardNames } from "@/lib/guard-fix/plan";
import { buildGuardMatchIndex, type SiteCandidate } from "@/lib/roster-upload/match";

// 「Total Shift」實測喺 col AM＝39（col A 起計，col H 起 31 個日期欄
// 1-8月...31-8月）——`AM_COLUMN` 喺 postorder.ts 硬編碼 39，合成 fixture
// 要跟呢個欄位置，唔可以隨便縮短（縮短會令 `gridNumber(grid, r, 39)`
// 讀唔到 Total Shift，見底下曾經失敗嘅版本）。
const POSTORDER_HEADER = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", ...Array.from({ length: 31 }, (_, i) => `${i + 1}-8月`), "Total Shift"].join(",");

function postorderRow(client: string, prop: string, price: string, totalShift: string): string {
  const dayCols = Array.from({ length: 31 }, () => "");
  return [client, "", prop, "Night", "900", price, "2230-0730", ...dayCols, totalShift].join(",");
}

describe("WP-POSTORDER-PO-PAIRS：derivePostorderLongtermPostsFromPostorderGrid()／...Csv()", () => {
  const knownNames = new Set(["甲蟲蟲", "乙屎蟲", "丙金蟲"]);

  it("#REF! 外判價＋已知名 → 計做一個 (盤,人) 組合", () => {
    const csv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "#REF!", "26")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toEqual([{ siteLabelRaw: "測試盤", siteLabelFallbackRaw: "測試", guardNameRaw: "甲蟲蟲", cellCount: 26 }]);
  });

  it("外判價＝#REF! 但 Total Shift＝0 → 都要保留呢個組合（cellCount:0）", () => {
    const csv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "#REF!", "0")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cellCount).toBe(0);
  });

  it("外判價係數字（唔係 #REF!）＋已知名，但唔喺 longtermEmploymentNames → 唔計（保守，避免一般客戶盤名尾段撞名）", () => {
    const csv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "545", "20")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toEqual([]);
  });

  it("外判價係數字＋已知名，而且喺 longtermEmploymentNames（DB 已經係 longterm_） → 計", () => {
    const csv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "545", "20")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames, new Set(["甲蟲蟲"]));
    expect(cells).toEqual([{ siteLabelRaw: "測試盤", siteLabelFallbackRaw: "測試", guardNameRaw: "甲蟲蟲", cellCount: 20 }]);
  });

  it("尾 token 唔係已知保安員姓名 → 唔計（一般客戶行）", () => {
    const csv = [POSTORDER_HEADER, postorderRow("某某有限公司", "測試", "#REF!", "10")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toEqual([]);
  });

  it("「客戶名稱」冇空格剝走人名之後淨番空字串 → 冧唔到盤名，保守跳過", () => {
    const csv = [POSTORDER_HEADER, postorderRow("甲蟲蟲", "測試", "#REF!", "10")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toEqual([]);
  });

  it("「長工雞頭費」行（介紹費行）唔會喺呢度計，避免同 parsePostorderReferralRowsFromGrid() 重複", () => {
    const csv = [POSTORDER_HEADER, "長工雞頭費 (甲蟲蟲),,,,,#REF!,,,0"].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toEqual([]);
  });

  it("同一 (盤,人) 出現多過一行 → cellCount 加埋", () => {
    const csv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "#REF!", "10"), postorderRow("測試盤 甲蟲蟲", "測試", "#REF!", "5")].join("\n");
    const cells = derivePostorderLongtermPostsFromPostorderCsv(csv, knownNames);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cellCount).toBe(15);
  });
});

describe("WP-POSTORDER-PO-PAIRS：buildKnownGuardNames()", () => {
  it("由 guards（name_zh＋name_aliases）建兩個 name set，NFKC 正規化，longterm 淨係 employment_type 開頭 longterm_ 嗰啲", () => {
    const { all, longterm } = buildKnownGuardNames([
      { nameZh: "甲蟲蟲", nameAliases: ["蟲蟲甲"], employmentType: "longterm_autopay" },
      { nameZh: "乙屎蟲", nameAliases: [], employmentType: "cash_casual" },
    ]);
    expect(all.has("甲蟲蟲")).toBe(true);
    expect(all.has("蟲蟲甲")).toBe(true);
    expect(all.has("乙屎蟲")).toBe(true);
    expect(longterm.has("甲蟲蟲")).toBe(true);
    expect(longterm.has("蟲蟲甲")).toBe(true);
    expect(longterm.has("乙屎蟲")).toBe(false);
  });
});

describe("WP-POSTORDER-PO-PAIRS：mergeLongtermPostCells()（plan.ts）", () => {
  const guardIndex = buildGuardMatchIndex({
    guards: [
      { id: "g-1", nameZh: "甲蟲蟲", tel: null, staffNo: null, staffNoMw: null },
      { id: "g-2", nameZh: "乙屎蟲", tel: null, staffNo: null, staffNoMw: null },
    ],
    staffNumbers: [],
    phones: [],
  });
  const siteCandidates: SiteCandidate[] = [
    { id: "s-1", canonicalName: "測試盤", aliases: [] },
    { id: "s-2", canonicalName: "另一盤", aliases: [] },
  ];

  function cell(siteLabelRaw: string, guardNameRaw: string, cellCount: number, siteLabelFallbackRaw: string | null = null): PostorderLongtermPostCell {
    return { siteLabelRaw, siteLabelFallbackRaw, guardNameRaw, cellCount };
  }

  it("primary（Roster/pairs）有嘅 pair，secondary（PostOrder 推）冇 → 保留 primary", () => {
    const merged = mergeLongtermPostCells([cell("測試盤", "甲蟲蟲", 26)], [], guardIndex, siteCandidates);
    expect(merged).toEqual([cell("測試盤", "甲蟲蟲", 26)]);
  });

  it("secondary 先有嘅 pair，primary 冇 → union 埋落去", () => {
    const merged = mergeLongtermPostCells([], [cell("另一盤", "乙屎蟲", 10)], guardIndex, siteCandidates);
    expect(merged).toEqual([cell("另一盤", "乙屎蟲", 10)]);
  });

  it("同一 (盤,人) 兩邊都有，cell_count 唔一致 → 取較大值（唔加埋）", () => {
    const merged = mergeLongtermPostCells([cell("測試盤", "甲蟲蟲", 26)], [cell("測試盤", "甲蟲蟲", 20)], guardIndex, siteCandidates);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.cellCount).toBe(26);

    const merged2 = mergeLongtermPostCells([cell("測試盤", "甲蟲蟲", 15)], [cell("測試盤", "甲蟲蟲", 26)], guardIndex, siteCandidates);
    expect(merged2).toHaveLength(1);
    expect(merged2[0]!.cellCount).toBe(26);
  });

  it("兩邊 raw 文字唔同，但都撞中同一個 guardId／siteId → 當同一組合合併（唔靠 raw 文字相等）", () => {
    // Roster 路徑「客戶名稱」剝名 vs PostOrder 路徑剝名，措辭可以有出入
    // （例如 zone 代號），但兩邊都撞中同一個 site/guard 就應該合併。
    const merged = mergeLongtermPostCells([cell("測試盤 IC", "甲蟲蟲", 26, "測試盤")], [cell("測試盤", "甲蟲蟲", 26)], guardIndex, siteCandidates);
    expect(merged).toHaveLength(1);
  });

  it("兩邊都撞唔中 guard／site → 跌返用 raw 文字做 key，唔會屈估併埋唔同組合", () => {
    const merged = mergeLongtermPostCells([cell("未知盤A", "未知人A", 5)], [cell("未知盤B", "未知人B", 3)], guardIndex, siteCandidates);
    expect(merged).toHaveLength(2);
  });
});

function reqJson(url: string, cookie: string, method = "GET"): Request {
  return new Request(url, { method, headers: { cookie } });
}

function reqPostorderCsvOnly(url: string, cookie: string, postorderCsv: string, month: string): Request {
  const form = new FormData();
  form.set("postorder_csv", new File([postorderCsv], "PostOrder.csv", { type: "text/csv" }));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

interface PostorderUploadDTO {
  id: string;
  parse_summary: {
    longterm_post_pair_count: number;
    longterm_cell_count: number;
    referral_row_count: number;
    missing_sheets: string[];
    parse_error: string | null;
    longterm_pairs_from_postorder?: number;
    longterm_cells_from_postorder?: number;
  } | null;
}

describe("WP-POSTORDER-PO-PAIRS：POST /api/guard-fix/postorder 淨係 postorder_csv 路徑", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    // 加一個名字啱 trailingChineseName（2-4 個中文字）範圍嘅保安員，等
    // derivePostorderLongtermPostsFromPostorderCsv() 撞得中（wp2 fixture
    // 自己嗰兩個「測試保安員甲/乙」5 個字，尾 4 字撞唔中本名）。
    await prisma.guard.create({
      data: { staffNo: "T-C01", nameZh: "甲蟲蟲", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, tel: "6100099", createdBy: "test-fixture:wp-postorder-po-pairs" },
    });
  });

  it("淨係帶 postorder_csv（冇 roster_csv／longterm_pairs_csv）→ 201，missing_sheets 記低 Roster，parse_summary 有 longterm_pairs_from_postorder 提示", async () => {
    const postorderCsv = [POSTORDER_HEADER, postorderRow("測試盤 甲蟲蟲", "測試", "#REF!", "26")].join("\n");
    const res = await uploadPostorder(reqPostorderCsvOnly("http://test.local/api/guard-fix/postorder", ownerCookie, postorderCsv, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO; parse_ok: boolean };
    expect(body.parse_ok).toBe(true);
    expect(body.upload.parse_summary?.missing_sheets).toEqual(["Roster"]);
    // 呢條路徑本身唔存 (盤,人) 組合（要等「計算修復計劃」先合併），
    // 但摘要應該提示「PostOrder 推到 1 個組合、26 格」。
    expect(body.upload.parse_summary?.longterm_post_pair_count).toBe(0);
    expect(body.upload.parse_summary?.longterm_pairs_from_postorder).toBe(1);
    expect(body.upload.parse_summary?.longterm_cells_from_postorder).toBe(26);

    const row = await prisma.postorderUpload.findUnique({ where: { id: body.upload.id } });
    expect(row?.postorderCsvBytes).toBeTruthy();
    expect(row?.rosterCsvBytes).toBeNull();
    expect(row?.longtermPairsCsvBytes).toBeNull();

    const getRes = await listPostorder(reqJson("http://test.local/api/guard-fix/postorder?month=2026-08-01", ownerCookie));
    const getBody = (await getRes.json()) as { current: PostorderUploadDTO | null };
    expect(getBody.current?.id).toBe(body.upload.id);
  });

  it("postorder_csv 推唔到任何組合（冇已知名撞中）→ parse_ok 仍然 true，longterm_pairs_from_postorder 係 0", async () => {
    const postorderCsv = [POSTORDER_HEADER, postorderRow("某某有限公司", "測試", "#REF!", "10")].join("\n");
    const res = await uploadPostorder(reqPostorderCsvOnly("http://test.local/api/guard-fix/postorder", ownerCookie, postorderCsv, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO; parse_ok: boolean };
    expect(body.parse_ok).toBe(true);
    expect(body.upload.parse_summary?.longterm_pairs_from_postorder).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 真檔比對（skipIf）：`data/2026-09/postorder-csv/PostOrder.csv`（gitignored，
// 冇呢個檔嘅環境自動 skip）——單靠呢份完整 PostOrder.csv（唔靠 Roster），
// knownNames 由 `longterm-pairs.csv`（Roster 真值）嘅 guard_name 攞（同
// dev DB 保安員名效果一致，唔使起 DB）。目標：覆蓋 59/60 組（只差「OT」
// 呢個泛用代號嘅 1-2 格，同 docs/api.md A 段落講嘅 matchSite 剩低 2 格
// OT 落差一致，向來留返人手覆核）。
// ---------------------------------------------------------------------------
const REAL_POSTORDER_CSV = path.resolve(__dirname, "../data/2026-09/postorder-csv/PostOrder.csv");
const REAL_PAIRS_CSV = path.resolve(__dirname, "../data/2026-09/postorder-csv/longterm-pairs.csv");
const hasRealFiles = existsSync(REAL_POSTORDER_CSV) && existsSync(REAL_PAIRS_CSV);

describe.skipIf(!hasRealFiles)("WP-POSTORDER-PO-PAIRS：真檔 PostOrder.csv 單獨推(盤,人)組合（data/ gitignored，冇呢個檔嘅環境自動 skip）", () => {
  it("單靠 PostOrder.csv（knownNames 由 longterm-pairs.csv 嘅真值攞）→ 覆蓋 ≥58/60 組，唔會屈估多過真值嘅組合", async () => {
    const postorderCsv = await readFile(REAL_POSTORDER_CSV, "utf-8");
    const pairsCsvText = await readFile(REAL_PAIRS_CSV, "utf-8");
    const truth = parseLongtermPairsCsv(pairsCsvText);
    expect(truth.parseError).toBeNull();

    const knownNames = new Set(truth.cells.map((c) => c.guardNameRaw));
    const derived = derivePostorderLongtermPostsFromPostorderCsv(postorderCsv, knownNames, knownNames);

    const truthKeys = new Set(truth.cells.map((c) => `${c.siteLabelRaw}\u0000${c.guardNameRaw}`));
    const derivedKeys = new Set(derived.map((c) => `${c.siteLabelRaw}\u0000${c.guardNameRaw}`));
    const matched = [...derivedKeys].filter((k) => truthKeys.has(k));

    console.log(
      `[wp-postorder-po-pairs] 真值 ${truth.cells.length} 組／${truth.cells.reduce((s, c) => s + c.cellCount, 0)} 格；` +
        `單靠 PostOrder.csv 推到 ${derived.length} 組／${derived.reduce((s, c) => s + c.cellCount, 0)} 格；` +
        `逐(盤,人) key 撞中真值 ${matched.length} 組`,
    );

    // 唔靠 Roster 都應該覆蓋到接近全部組合（實測 58/60，只差「OT」呢個
    // 泛用代號嘅 2 組——見 postorder.ts 檔頭規則同 docs/api.md A 段落）。
    expect(matched.length).toBeGreaterThanOrEqual(58);
    expect(derived.length).toBeGreaterThanOrEqual(58);
  });
});
