// WP-AI-OPS §28.2：每月修正摘要＋基線。全部合成資料（測試XX），唔讀 data/、
// 唔讀 .env、唔打外部 API（AI 摘要用 mock LlmClient）。
//
// audit_log 係 append-only、成個 vitest run 共用——所以用獨立年份（2019）嘅月份
// 同明確 created_at，避免同其他 test 檔案撞數。
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildOpsDigest, computeDigestWindow, summarizeOneClickRuns, type OpsDigest } from "@/lib/ops/digest";
import { digestToPromptJson, generateDigestSummary, OPS_DIGEST_SYSTEM_PROMPT } from "@/lib/ops/ai-summary";
import { GET as digestRoute } from "@/app/api/reports/ops-digest/route";
import { POST as aiRoute } from "@/app/api/reports/ops-digest/ai-summary/route";
import { setLlmClientForTests, type LlmClient, type LlmChatParams, type LlmChatResult } from "@/lib/ai/llm";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const FAKE_HKID = "Z999999(9)";
const FAKE_NAME = "測試安員甲";
const FAKE_TEL = "6100001";

/** 本機 shell／dotenv 可能帶 AI key——測試要自己控制「有冇設定 AI」，唔靠環境。 */
function clearAiEnv() {
  delete process.env.AI_LLM;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AI_HUB_API_KEY;
  delete process.env.AI_PROVIDER;
}

function req(url: string, cookie: string, method = "GET", body?: unknown): Request {
  return new Request(url, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

function sys(userId: string): AuthedSession {
  return { userId, tel: "", name: "", roleId: "", roleName: "老闆", baseRole: "老闆", brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString() };
}

async function audit(tableName: string, action: string, createdAt: Date, before: unknown, after: unknown, rowId = "row-" + Math.random().toString(36).slice(2)) {
  await prisma.auditLog.create({
    data: {
      tableName,
      action,
      rowId,
      createdAt,
      before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

describe("ops-digest 純函數", () => {
  it("computeDigestWindow：首份上載起計到鎖月；冇上載由下月 1 號起；最長 60 日；作廢上載唔計", () => {
    const w1 = computeDigestWindow(d("2019-03-01"), [{ voidedAt: null, status: "parsed", uploadedAt: d("2019-04-02") }, { voidedAt: null, status: "parsed", uploadedAt: d("2019-04-05") }], d("2019-04-12"), d("2019-09-01"));
    expect(w1).toEqual({ from: "2019-04-02T00:00:00.000Z", to: "2019-04-12T00:00:00.000Z", basis: "first_upload_to_lock" });
    const w2 = computeDigestWindow(d("2019-03-01"), [], null, d("2019-04-10"));
    expect(w2).toEqual({ from: "2019-04-01T00:00:00.000Z", to: "2019-04-10T00:00:00.000Z", basis: "month_end_to_now" });
    const w3 = computeDigestWindow(d("2019-03-01"), [{ voidedAt: d("2019-04-03"), status: "voided", uploadedAt: d("2019-04-02") }], null, d("2020-01-01"));
    expect(w3.from).toBe("2019-04-01T00:00:00.000Z");
    expect(w3.to).toBe("2019-05-31T00:00:00.000Z"); // from + 60 日
  });

  it("summarizeOneClickRuns：次數、成功／失敗、平均／最長耗時、每次 needs_human 數", () => {
    const r = summarizeOneClickRuns([
      { status: "done", startedAt: d("2019-04-03"), finishedAt: new Date(d("2019-04-03").getTime() + 20_000), stepsJson: [{ needsHuman: ["a", "b"] }, { needs_human: ["c"] }] },
      { status: "failed", startedAt: d("2019-04-02"), finishedAt: new Date(d("2019-04-02").getTime() + 10_000), stepsJson: [{ needsHuman: [] }] },
    ]);
    expect(r).toEqual({ runs: 2, doneRuns: 1, failedRuns: 1, avgDurationSec: 15, maxDurationSec: 20, needsHumanPerRun: [0, 3] });
  });
});

describe("buildOpsDigest（DB）", () => {
  let fx: Wp2Fixture;
  let digest: OpsDigest;
  let guardId: string;
  const createdStaffLists: string[] = [];

  // clearAll() 唔清 staff_list_uploads／month_close_runs——自己清返，免污染後面嘅測試檔（例如一鍵結算）。
  afterAll(async () => {
    await clearAll();
    await prisma.staffListUpload.deleteMany({ where: { id: { in: createdStaffLists } } });
    await prisma.monthCloseRun.deleteMany({ where: { month: { gte: d("2019-01-01"), lte: d("2019-12-01") } } });
  });

  beforeAll(async () => {
    clearAiEnv();
    await clearAll();
    fx = await seedWp2Fixture();
    const boss = fx.userIds["老闆"];
    const guard = await prisma.guard.create({ data: { staffNo: "T-DG1", nameZh: FAKE_NAME, tel: FAKE_TEL, hkid: FAKE_HKID, employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "t" } });
    guardId = guard.id;
    const MAR = d("2019-03-01");
    const FEB = d("2019-02-01");
    const JAN = d("2019-01-01");

    // 上載：3 月 3 份（v1、v2 重傳、作廢），2 月 1 份
    const mkUpload = (month: Date, over: Partial<Prisma.RosterUploadUncheckedCreateInput>) =>
      prisma.rosterUpload.create({
        data: { month, siteId: fx.site.id, siteNameRaw: fx.site.name, uploaderUserId: boss, fileName: "f.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array([1]), fileSize: 1, ...over },
      });
    const upA = await mkUpload(MAR, { version: 1, status: "superseded", uploadedAt: d("2019-04-02") });
    const upB = await mkUpload(MAR, { version: 2, status: "parsed", uploadedAt: d("2019-04-05") });
    await mkUpload(MAR, { version: 1, status: "voided", voidedAt: d("2019-04-06"), uploadedAt: d("2019-04-04") });
    await mkUpload(FEB, { version: 1, status: "confirmed", uploadedAt: d("2019-03-03") });

    // 鎖月：3 月鎖喺 4/12、2 月鎖喺 3/20、1 月鎖喺 2/10（令各月視窗唔重疊）
    const mcMar = await prisma.monthClose.create({ data: { month: MAR, lockedAt: d("2019-04-12"), lockedBy: boss, createdBy: "t" } });
    await prisma.monthClose.create({ data: { month: FEB, lockedAt: d("2019-03-20"), lockedBy: boss, createdBy: "t" } });
    await prisma.monthClose.create({ data: { month: JAN, lockedAt: d("2019-02-10"), lockedBy: boss, createdBy: "t" } });
    await audit("month_closes", "lock_month", d("2019-04-12"), null, { id: mcMar.id }, mcMar.id);

    // 視窗內 audit（3 月視窗 4/2–4/12）
    for (let i = 0; i < 2; i++) await audit("rate_cards", "create", d("2019-04-03"), null, { id: `rc${i}`, copied_from: "prev-card" });
    await audit("rate_cards", "create", d("2019-04-03"), null, { id: "rc-manual" });
    await audit("rate_cards", "update", d("2019-04-04"), { id: "rc-manual" }, { id: "rc-manual" });
    await audit("rate_cards", "create", d("2019-03-15"), null, { id: "rc-outside-window" }); // 視窗外，唔計
    for (let i = 0; i < 2; i++) await audit("guards", "update", d("2019-04-06"), { id: guardId, hkid: null, name_zh: FAKE_NAME, tel: FAKE_TEL }, { id: guardId, hkid: FAKE_HKID, name_zh: FAKE_NAME, tel: FAKE_TEL });
    await audit("guards", "update", d("2019-04-07"), { id: guardId, name_aliases: [] }, { id: guardId, name_aliases: ["花名"] });
    await audit("guard_import", "guard_import_apply", d("2019-04-08"), null, { persons: 10, outcomes: {}, guards_created: 3, guards_updated: 2, phones_added: 0, field_conflicts: 1, review_decisions: 4 });
    await audit("guard_match_overrides", "create", d("2019-04-09"), null, { id: "mo1", guardId, reason: "x" });
    // 2 月視窗（3/3–3/20）：一張複製價卡 → 3 月 streak 2；1 月視窗（2/1–2/10）冇 → streak 停喺 2
    await audit("rate_cards", "create", d("2019-03-10"), null, { id: "rc-feb", copied_from: "x" });

    // 月份類 audit（work_date 2019-03）
    const base = { site_id: fx.site.id, settlement_broker_id: fx.brokerA.id, work_date: "2019-03-05T00:00:00.000Z", guard_wage_snapshot: 700 };
    for (let i = 0; i < 3; i++) await audit("shift_records", "update", d("2019-04-08"), base, { ...base, guard_wage_snapshot: 800 + i });
    await audit("shift_records", "create", d("2019-04-08"), null, base);
    await audit("shift_records", "void", d("2019-04-08"), base, { ...base, void_reason: "manual" });
    await audit("shift_records", "create", d("2019-04-09"), null, { ...base, source: "roster_upload" });
    await audit("shift_records", "void", d("2019-04-09"), base, { ...base, void_reason: "roster_reconcile:apply_roster" });
    await audit("shift_records", "update", d("2019-04-09"), base, { ...base, settlement_broker_id: "other-broker", updated_at: "x" }); // 只改結算單位 → auto resync
    await audit("shift_records", "reprice_month", d("2019-04-09"), null, { scanned: 5 }, "reprice:2019-03");
    await audit("shift_records", "update", d("2019-04-09"), { ...base, work_date: "2019-04-05T00:00:00.000Z" }, { ...base, work_date: "2019-04-05T00:00:00.000Z", guard_wage_snapshot: 1 }); // 4 月更，唔計入 3 月
    await audit("special_items", "create", d("2019-04-09"), null, { id: "s1", month: "2019-03-01T00:00:00.000Z" });
    await audit("special_items", "create", d("2019-04-09"), null, { id: "s2", month: "2019-03-01T00:00:00.000Z" });
    await audit("special_items", "void", d("2019-04-09"), { id: "s2", month: "2019-03-01T00:00:00.000Z" }, { id: "s2", month: "2019-03-01T00:00:00.000Z" });

    // guard-fix run（3 月）
    const staffList = await prisma.staffListUpload.create({ data: { uploaderId: boss, fileName: "n.xlsx", fileSha256: "0".repeat(64), fileBytes: new Uint8Array([1]), fileSize: 1, rowCount: 0 } });
    createdStaffLists.push(staffList.id);
    await prisma.guardFixRun.create({
      data: {
        month: MAR,
        staffListUploadId: staffList.id,
        createdById: boss,
        status: "applied",
        planJson: { actions: { link: [{ addAlias: "甲" }, { addAlias: null }, { addAlias: "乙" }] } },
        summaryJson: {},
        resultJson: { diffs: { link: { create: ["a", "b", "c"], skip: ["x"] }, create: { create: ["d"], skip: [] }, createMinimal: { create: ["e", "f"], skip: ["y", "z"] } } },
      },
    });

    // 對數決定（掛 3 月上載）
    for (const [i, action] of ["keep_system", "keep_system", "exception"].entries()) {
      await prisma.rosterReconcileDecision.create({ data: { uploadId: upB.id, reconcileKey: `k${i}`, category: "guard_diff", action, decidedBy: boss } });
    }

    // 一鍵結算 runs
    await prisma.monthCloseRun.create({ data: { month: MAR, status: "failed", startedById: boss, startedAt: d("2019-04-10"), finishedAt: new Date(d("2019-04-10").getTime() + 10_000), stepsJson: [{ needsHuman: ["a"] }] } });
    await prisma.monthCloseRun.create({ data: { month: MAR, status: "done", startedById: boss, startedAt: d("2019-04-11"), finishedAt: new Date(d("2019-04-11").getTime() + 20_000), stepsJson: [{ needsHuman: ["a", "b"] }, { needsHuman: ["c"] }] } });

    // 上載 rows：3 name_only、2 unmatched、1 ambiguous（掛 active 上載 B）
    const mkRow = (rowIndex: number, over: Partial<Prisma.RosterUploadRowUncheckedCreateInput>) =>
      prisma.rosterUploadRow.create({ data: { uploadId: upB.id, rowIndex, workDate: d("2019-03-05"), rawCode: "N", codeKind: "shift", ...over } });
    for (let i = 0; i < 3; i++) await mkRow(i + 1, { guardId, guardMatch: "by_name", matchBasis: "name_only" });
    for (let i = 0; i < 2; i++) await mkRow(10 + i, { guardMatch: "unmatched" });
    await mkRow(20, { guardMatch: "ambiguous" });
    void upA;

    digest = await buildOpsDigest(MAR, sys(boss), d("2019-09-01"));
  });

  const count = (k: string) => digest.categories.find((c) => c.key === k)!;

  it("視窗：首份未作廢上載（4/2）到鎖月（4/12）", () => {
    expect(digest.window).toEqual({ from: "2019-04-02T00:00:00.000Z", to: "2019-04-12T00:00:00.000Z", basis: "first_upload_to_lock" });
    expect(digest.month).toBe("2019-03");
    expect(digest.prevMonth).toBe("2019-02");
  });

  it("guard-fix：link／create／最簡新建／跳過；別名新增（plan 3 個 link 有 2 個帶別名＋audit 1）", () => {
    expect(count("guard_fix_link").count).toBe(3);
    expect(count("guard_fix_create").count).toBe(1);
    expect(count("guard_fix_create_minimal").count).toBe(2);
    expect(count("guard_fix_skipped").count).toBe(3);
    expect(count("alias_added").count).toBe(3);
  });

  it("對數決定逐 action；配對 override；價卡（視窗外唔計）", () => {
    expect(count("reconcile_keep_system").count).toBe(2);
    expect(count("reconcile_exception").count).toBe(1);
    expect(count("match_override_added").count).toBe(1);
    expect(count("rate_card_copied").count).toBe(2);
    expect(count("rate_card_manual_created").count).toBe(1);
    expect(count("rate_card_updated").count).toBe(1);
  });

  it("更次修正按 work_date 月份：人手改／新增／取消、對數寫入、系統重配、reprice；特殊項", () => {
    expect(count("shift_manual_update").count).toBe(3);
    expect(count("shift_manual_create").count).toBe(1);
    expect(count("shift_manual_void").count).toBe(1);
    expect(count("reconcile_apply_write").count).toBe(2);
    expect(count("shift_auto_resync").count).toBe(1);
    expect(count("reprice").count).toBe(1);
    expect(count("special_item_create").count).toBe(2);
    expect(count("special_item_void").count).toBe(1);
    expect(digest.correctionTotal).toBe(3 + 1 + 1 + 2);
  });

  it("安員身份欄、批量導入、鎖月", () => {
    expect(count("identity_hkid").count).toBe(2);
    expect(count("identity_name").count).toBe(0);
    expect(count("import_apply_runs").count).toBe(1);
    expect(count("import_guards_created").count).toBe(3);
    expect(count("import_guards_updated").count).toBe(2);
    expect(count("import_field_conflicts").count).toBe(1);
    expect(count("import_review_decisions").count).toBe(4);
    expect(count("month_lock").count).toBe(1);
    expect(count("month_unlock").count).toBe(0);
  });

  it("基線：一鍵結算、name_only／unmatched／ambiguous、上載檔、月尾到鎖月日數", () => {
    const b = digest.baseline;
    expect(b.oneClick).toMatchObject({ runs: 2, doneRuns: 1, failedRuns: 1, avgDurationSec: 15, maxDurationSec: 20, needsHumanPerRun: [1, 3] });
    expect(b.nameOnlyCells).toBe(3);
    expect(b.unmatchedCells).toBe(2);
    expect(b.ambiguousCells).toBe(1);
    expect(b.uploads).toEqual({ files: 3, reuploads: 1, voided: 1, superseded: 1 });
    expect(b.daysMonthEndToLock).toBe(11); // 4/1 → 4/12
    expect(digest.prevBaseline.uploads.files).toBe(1);
  });

  it("重複：連續 ≥2 個月出現（價卡複製：3 月 2、2 月 1、1 月 0 → streak 2）；top 盤／雞頭代號", () => {
    expect(count("rate_card_copied").prevCount).toBe(1);
    expect(count("rate_card_copied").streak).toBe(2);
    expect(digest.repeats.map((r) => r.key)).toContain("rate_card_copied");
    expect(digest.repeats.map((r) => r.key)).not.toContain("shift_manual_update");
    expect(digest.topSites[0]).toEqual({ siteName: fx.site.name, count: 7 });
    expect(digest.topBrokers[0]).toMatchObject({ count: 7 });
  });

  it("輸出冇人名／工號／hkid／電話", () => {
    const json = JSON.stringify(digest);
    for (const secret of [FAKE_NAME, "T-DG1", FAKE_TEL, FAKE_HKID, "花名"]) expect(json).not.toContain(secret);
  });

  it("加多 30 條視窗內 audit 再計，類別數字跟住升", async () => {
    const before = await prisma.auditLog.count();
    for (let i = 0; i < 30; i++) await audit("rate_cards", "update", d("2019-04-05"), { id: "q" }, { id: "q" });
    expect(await prisma.auditLog.count()).toBe(before + 30);
    const again = await buildOpsDigest(d("2019-03-01"), sys(fx.userIds["老闆"]), d("2019-09-01"));
    expect(again.categories.find((c) => c.key === "rate_card_updated")!.count).toBe(31);
  });

  describe("GET /api/reports/ops-digest", () => {
    it("老闆／會計 200（snake_case，冇 PII）；主管（預設關）／雞頭／安員 403", async () => {
      const url = "http://test.local/api/reports/ops-digest?month=2019-03";
      const bossRes = await digestRoute(req(url, await sessionCookieForUser(fx.userIds["老闆"])));
      expect(bossRes.status).toBe(200);
      const json = (await bossRes.json()) as Record<string, unknown>;
      expect(json.prev_month).toBe("2019-02");
      expect(json).toHaveProperty("group_totals");
      expect(json).toHaveProperty("top_sites");
      expect(json.ai_available).toBe(false);
      const text = JSON.stringify(json);
      for (const secret of [FAKE_NAME, "T-DG1", FAKE_TEL, FAKE_HKID]) expect(text).not.toContain(secret);
      expect((await digestRoute(req(url, await sessionCookieForUser(fx.userIds["會計"])))).status).toBe(200);
      for (const role of ["主管", "雞頭", "安員"] as const) {
        expect((await digestRoute(req(url, await sessionCookieForUser(fx.userIds[role])))).status).toBe(403);
      }
    });
  });
});

describe("AI 摘要（mock provider，唔打外部 API）", () => {
  let fx: Wp2Fixture;
  const saved = { ...process.env };
  const captured: LlmChatParams[] = [];
  const mockClient: LlmClient = {
    async chat(params: LlmChatParams): Promise<LlmChatResult> {
      captured.push(params);
      return { text: "本月修正集中喺價卡，建議補價卡。", toolsUsed: [], inputTokens: 5, outputTokens: 9 };
    },
  };

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });
  afterEach(() => {
    setLlmClientForTests(undefined);
    process.env = { ...saved };
    captured.length = 0;
  });

  function setAi(on: boolean) {
    clearAiEnv();
    if (on) process.env.AI_PROVIDER = "fake";
  }

  it("未設定 AI：ai_available=false，POST 404", async () => {
    setAi(false);
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await digestRoute(req("http://test.local/api/reports/ops-digest?month=2018-03", cookie));
    expect(((await res.json()) as { ai_available: boolean }).ai_available).toBe(false);
    const post = await aiRoute(req("http://test.local/api/reports/ops-digest/ai-summary", cookie, "POST", { month: "2018-03" }));
    expect(post.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("已設定 AI：只將 PII-free digest JSON 交 provider（冇工具）；回文字；寫 audit 計額度", async () => {
    setAi(true);
    setLlmClientForTests(mockClient);
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const g = await prisma.guard.create({ data: { staffNo: "T-AI1", nameZh: "測試安員AI", tel: "6100999", hkid: "Z888888(8)", employmentType: "cash_casual", createdBy: "t" } });
    await audit("guards", "update", d("2018-04-03"), { id: g.id, hkid: null }, { id: g.id, hkid: "Z888888(8)" });
    expect(((await (await digestRoute(req("http://test.local/api/reports/ops-digest?month=2018-03", cookie))).json()) as { ai_available: boolean }).ai_available).toBe(true);

    const before = await prisma.auditLog.count({ where: { tableName: "ai_chat", actorUserId: fx.userIds["老闆"] } });
    const res = await aiRoute(req("http://test.local/api/reports/ops-digest/ai-summary", cookie, "POST", { month: "2018-03" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; month: string };
    expect(json.text).toContain("價卡");
    expect(json.month).toBe("2018-03");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tools).toEqual([]);
    expect(captured[0]!.systemPrompt).toContain("唔准自己編數字");
    for (const secret of ["測試安員AI", "T-AI1", "6100999", "Z888888(8)"]) expect(captured[0]!.userMessage).not.toContain(secret);
    expect(captured[0]!.userMessage).toContain('"prev_month":"2018-02"');
    expect(await prisma.auditLog.count({ where: { tableName: "ai_chat", actorUserId: fx.userIds["老闆"] } })).toBe(before + 1);
  });

  it("每日上限：用晒就 429，唔叫 provider", async () => {
    setAi(true);
    setLlmClientForTests(mockClient);
    process.env.AI_DAILY_LIMIT = "1";
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    const first = await aiRoute(req("http://test.local/api/reports/ops-digest/ai-summary", cookie, "POST", { month: "2018-03" }));
    expect(first.status).toBe(200);
    const second = await aiRoute(req("http://test.local/api/reports/ops-digest/ai-summary", cookie, "POST", { month: "2018-03" }));
    expect(second.status).toBe(429);
    expect(captured).toHaveLength(1);
  });

  it("權限：雞頭 403；模型輸出含 DML 樣式 → 被 output guard 換走", async () => {
    setAi(true);
    setLlmClientForTests({ chat: async () => ({ text: "請執行 INSERT INTO guards 再改", toolsUsed: [], inputTokens: 1, outputTokens: 1 }) });
    const brokerRes = await aiRoute(req("http://test.local/api/reports/ops-digest/ai-summary", await sessionCookieForUser(fx.userIds["雞頭"]), "POST", { month: "2018-03" }));
    expect(brokerRes.status).toBe(403);
    const digest = await buildOpsDigest(d("2018-03-01"), sys(fx.userIds["老闆"]), d("2018-06-01"));
    const r = await generateDigestSummary(digest);
    expect(r.guardTriggered).toBe(true);
    expect(r.text).not.toContain("INSERT");
  });

  it("prompt 規則：唔准編數字、淨係引用 JSON", () => {
    expect(OPS_DIGEST_SYSTEM_PROMPT).toContain("絕對唔准自己編數字");
    expect(digestToPromptJson({ month: "2018-03", prevMonth: "2018-02" } as unknown as OpsDigest)).toBe('{"month":"2018-03","prev_month":"2018-02"}');
  });
});
