// WP-AI-DIAG（§37.3）：七個新唯讀診斷工具——權限 denied 路徑、PII 投影（假名 fixture）、結構（零寫入工具）。
// 假資料只用「測試甲／測試乙…」＋ 假工號 U9xxxx ＋ 假電話。
import { describe, it, expect, beforeAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility, type AiFieldVisibility } from "@/lib/ai/field-scrub";
import { writeAppErrorLog } from "@/lib/app-error-log";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";

const NEW_TOOLS = ["one_click_status", "triage_summary", "month_health", "ops_digest", "site_setup", "pricing_explain", "recent_app_errors"] as const;
const MONTH = "2026-09";
const MONTH_DATE = new Date(Date.UTC(2026, 8, 1));

async function sessionFor(fx: Wp2Fixture, role: RoleName): Promise<AuthedSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
  return {
    userId: user.id,
    tel: user.tel,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    baseRole: user.role.baseRole as RoleName,
    brokerId: user.brokerId,
    guardId: user.guardId,
    payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
    tokenVersion: user.tokenVersion,
    loggedInAt: new Date().toISOString(),
  };
}

async function runTool(fx: Wp2Fixture, role: RoleName, name: string, args: unknown, visOverride?: Partial<AiFieldVisibility>): Promise<{ raw: string; json: Record<string, unknown> }> {
  const session = await sessionFor(fx, role);
  const fieldVisibility = { ...(await computeFieldVisibility(session)), ...(visOverride ?? {}) };
  const tools = buildAiTools({ session, fieldVisibility });
  const tool = tools.find((t) => (t as { name?: string }).name === name);
  if (!tool) throw new Error(`tool ${name} 唔存在`);
  const raw = await (tool as { run: (a: unknown) => Promise<string> }).run(args);
  return { raw, json: JSON.parse(raw) };
}

async function setGranted(roleName: RoleName, mod: string, granted: boolean): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const permission = await prisma.permission.findFirstOrThrow({ where: { module: mod, action: "view" } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    create: { roleId: role.id, permissionId: permission.id, granted, createdBy: "test:ai-diag-tools" },
    update: { granted },
  });
}

const PII_NEEDLES = ["測試甲", "測試乙", "U9001", "U9002", "61234567", "61234568"];
function expectNoPii(raw: string) {
  for (const n of PII_NEEDLES) expect(raw, `輸出唔應該含 ${n}`).not.toContain(n);
  expect(raw).not.toMatch(/U9\d{3}/);
}

describe("WP-AI-DIAG 診斷工具", () => {
  let fx: Wp2Fixture;
  let runId: string;
  let guardMatchQuestionId: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();

    // 一鍵結算 run：10 步中其中幾步＋auto summary（含 postorder_dependency）＋needs_human 原文
    const run = await prisma.monthCloseRun.create({
      data: {
        month: MONTH_DATE,
        status: "done",
        startedById: fx.userIds["老闆"],
        finishedAt: new Date(),
        currentStep: "report",
        stepsJson: [
          { key: "precheck", label: "前置檢查", status: "done", startedAt: null, finishedAt: null, numbers: { uploads: 3 }, warnings: [], needsHuman: [] },
          { key: "auto_pricing", label: "自動歸屬／定價", status: "done", startedAt: null, finishedAt: null, numbers: { cards_created: 2, unpriced: 18, revenue: 123456, guardWageSnapshot: 777 }, warnings: ["測試盤WP2 有 18 更未定價"], needsHuman: ["測試盤WP2 要人手揀價"] },
        ],
        reportJson: {
          auto: {
            summary: { cardsCreated: 2, unpricedRecords: 18, postorderDependency: { pricing: { total: 100, unpriced: 18, withoutPostorder: 80 } } },
            review: [
              { kind: "month_close_pricing", text: "測試盤WP2 N 18 更未定價", confidence: "unknown", questionId: null },
              { kind: "month_close_guard_match", text: "測試盤WP2 3 格未配對：測試甲 U9001 61234567", confidence: "propose", questionId: null },
            ],
            undone: false,
          },
          unpriced: { count: 18 },
          lockPrecondition: { currentMonthAlreadyLocked: false, readyToLock: false },
        },
      },
    });
    runId = run.id;

    // 分診 session＋題目（故意把假名／假工號／假電話放入 evidence、summary、候選）
    const session = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: runId, ownerUserId: fx.userIds["老闆"], createdBy: fx.userIds["老闆"], statsJson: {} } });
    const guardMatch = await prisma.triageQuestion.create({
      data: {
        sessionId: session.id,
        kind: "month_close_guard_match",
        groupKey: "gm-1",
        title: "測試甲 U9001 配對",
        sort: 1,
        evidenceJson: {
          v: 1,
          mc: true,
          runId,
          month: MONTH,
          kind: "month_close_guard_match",
          summary: "測試盤WP2 共 3 格嘅保安員未配對：測試甲 U9001 61234567",
          suggestion: "測試乙 U9002",
          confidence: "propose",
          action: { type: "guard_match", identity: { staffNoNorm: "U9001", nameRaw: "測試甲", telRaw: "61234567" }, siteLabel: "測試盤WP2", cellCount: 3 },
          candidates: [{ id: "c1", label: "測試乙 U9002 61234568", refId: "g-x", evidence: "電話 61234568" }],
          prefillCandidateId: "c1",
        },
        optionsJson: [{ id: "mc_accept", label: "測試甲 U9001" }, { id: "mc_pick", label: "測試乙" }, { id: "skip", label: "跳過" }],
      },
    });
    guardMatchQuestionId = guardMatch.id;
    await prisma.triageQuestion.create({
      data: {
        sessionId: session.id,
        kind: "month_close_pricing",
        groupKey: "pr-1",
        title: "未定價 N",
        sort: 2,
        evidenceJson: {
          v: 1,
          mc: true,
          runId,
          month: MONTH,
          kind: "month_close_pricing",
          summary: "18 更未定出街價，價目表、歷史、Postorder 都冇依據",
          suggestion: null,
          confidence: "unknown",
          action: { type: "pricing", group: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, ot: false }, needClient: false, needPayout: true, count: 18 },
          candidates: [],
          prefillCandidateId: null,
        },
        optionsJson: [],
      },
    });
    await prisma.triageQuestion.create({
      data: { sessionId: session.id, kind: "month_close_site_alias", groupKey: "sa-1", title: "盤名似", sort: 3, status: "answered", evidenceJson: { v: 1, mc: true, runId, month: MONTH, kind: "month_close_site_alias", summary: "更表盤名「某盤」似現有盤", suggestion: null, confidence: "propose", action: { type: "site_alias", uploadId: "u1", siteNameRaw: "某盤" }, candidates: [], prefillCandidateId: null }, optionsJson: [] },
    });

    // 未定價更次（9 月）＋上載＋預設雞頭
    await prisma.shiftRecord.create({
      data: { workDate: new Date(Date.UTC(2026, 8, 5)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, createdBy: "test:ai-diag" },
    });
    await prisma.site.update({ where: { id: fx.site.id }, data: { defaultSettlementBrokerId: fx.brokerA.id } });
    await prisma.rosterUpload.create({
      data: { month: MONTH_DATE, siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: "a".repeat(64), fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed", parseSummary: { shift_count: 5, unmatched_count: 2 } },
    });
    await writeAppErrorLog({ status: 500, errorCode: "internal_error", errorName: "TypeError", message: "boom 91234567", method: "POST", route: "/api/foo" });
  });

  it("buildAiTools：7 個新工具齊，全部工具名都喺已知唯讀清單（零寫入工具）", async () => {
    const session = await sessionFor(fx, "老闆");
    const tools = buildAiTools({ session, fieldVisibility: await computeFieldVisibility(session) });
    const names = tools.map((t) => (t as { name: string }).name);
    for (const n of NEW_TOOLS) expect(names).toContain(n);
    const READ_ONLY = new Set([
      "describe_system", "list_sites", "site_overview", "roster", "broker_stats", "rate_cards", "explain_rate_card", "guard_lookup", "shift_history",
      "gross_margin", "monthly_close", "shortfall", "recent_audit", "sql_select", "list_feedback", ...NEW_TOOLS,
    ]);
    for (const n of names) expect(READ_ONLY.has(n), `未知工具 ${n}`).toBe(true);
    expect(names.some((n) => /^(create|update|delete|set|write|insert|apply|void|run_|execute)/.test(n))).toBe(false);
  });

  describe("權限 denied 路徑", () => {
    const CASES: Array<[string, string, unknown]> = [
      ["one_click_status", "一鍵結算", { month: MONTH }],
      ["triage_summary", "導入分診", { month: MONTH }],
      ["month_health", "月結總表", { month: MONTH }],
      ["ops_digest", "月結總表", { month: MONTH }],
      ["site_setup", "盤", { site: "測試盤WP2" }],
      ["pricing_explain", "出街價", { site: "測試盤WP2", shift_type: "N", month: MONTH }],
      ["recent_app_errors", "操作紀錄", {}],
    ];

    it.each(CASES)("%s：雞頭 → permission_denied", async (name, _mod, args) => {
      const { json } = await runTool(fx, "雞頭", name, args);
      expect(json.error).toBe("permission_denied");
    });

    it.each(CASES)("%s：主管被關咗「%s」view → permission_denied", async (name, mod, args) => {
      await setGranted("主管", mod, false);
      const { json } = await runTool(fx, "主管", name, args);
      expect(json.error).toBe("permission_denied");
      await setGranted("主管", mod, true);
      const after = await runTool(fx, "主管", name, args);
      expect(after.json.error).not.toBe("permission_denied");
    });
  });

  it("one_click_status：10 步狀態／summary 數字／needs_human／auto summary（含 postorder_dependency）", async () => {
    const { json } = await runTool(fx, "老闆", "one_click_status", { month: MONTH });
    const run = json.run as { id: string; status: string; steps: Array<{ key: string; numbers: Record<string, number>; needs_human: string[]; warnings: string[] }>; auto_summary: Record<string, unknown> };
    expect(run.id).toBe(runId);
    expect(run.status).toBe("done");
    const ap = run.steps.find((s) => s.key === "auto_pricing")!;
    expect(ap.numbers.unpriced).toBe(18);
    expect(ap.needs_human[0]).toContain("人手揀價");
    expect(ap.warnings[0]).toContain("18 更未定價");
    expect(run.auto_summary.postorderDependency).toBeTruthy();
  });

  it("one_click_status：guard_match review 出固定句，冇假名／工號／電話（expectNoPii）", async () => {
    const { raw, json } = await runTool(fx, "老闆", "one_click_status", { month: MONTH });
    expectNoPii(raw);
    const review = (json.run as { auto_review: Array<{ kind: string; text: string }> }).auto_review;
    expect(review.find((r) => r.kind === "month_close_guard_match")!.text).toContain("保安員配對要核實");
    expect(review.find((r) => r.kind === "month_close_pricing")!.text).toContain("18 更未定價");
  });

  it("one_click_status：steps numbers 按查閱權遮收客價／出街價類欄位", async () => {
    const full = await runTool(fx, "主管", "one_click_status", { month: MONTH }, { clientRateVisible: true, settlementVisible: true });
    const stepsFull = (full.json.run as { steps: Array<{ key: string; numbers: Record<string, unknown> }> }).steps;
    expect(stepsFull.find((s) => s.key === "auto_pricing")!.numbers).toMatchObject({ revenue: 123456, guardWageSnapshot: 777 });
    const hidden = await runTool(fx, "主管", "one_click_status", { month: MONTH }, { clientRateVisible: false, settlementVisible: false });
    const n = (hidden.json.run as { steps: Array<{ key: string; numbers: Record<string, unknown> }> }).steps.find((s) => s.key === "auto_pricing")!.numbers;
    expect("revenue" in n).toBe(false);
    expect("guardWageSnapshot" in n).toBe(false);
    expect(n.unpriced).toBe(18);
  });

  it("month_health：冇「更表:view」→ permission_denied（同 route 一致）", async () => {
    await setGranted("主管", "更表", false);
    const { json } = await runTool(fx, "主管", "month_health", { month: MONTH });
    expect(json.error).toBe("permission_denied");
    await setGranted("主管", "更表", true);
    const ok = await runTool(fx, "主管", "month_health", { month: MONTH });
    expect(ok.json.error).toBeUndefined();
  });

  it("one_click_status：冇 run 嘅月份 → run: null", async () => {
    const { json } = await runTool(fx, "老闆", "one_click_status", { month: "2026-11" });
    expect(json.run).toBeNull();
  });

  it("triage_summary：計數對；每題欄位齊；輸出冇任何假名／假工號／假電話（PII 投影）", async () => {
    const { raw, json } = await runTool(fx, "老闆", "triage_summary", { month: MONTH });
    expectNoPii(raw);
    expect(json.total).toBe(3);
    expect(json.by_kind).toEqual({ month_close_guard_match: 1, month_close_pricing: 1, month_close_site_alias: 1 });
    expect(json.by_status).toEqual({ open: 2, answered: 1 });
    expect(json.by_confidence).toEqual({ propose: 2, unknown: 1 });
    const qs = json.questions as Array<{ id: string; kind: string; status: string; confidence: string; site: string | null; shift_type: string | null; broker_display: string | null; summary: string }>;
    const pricing = qs.find((q) => q.kind === "month_close_pricing")!;
    expect(pricing).toMatchObject({ status: "open", confidence: "unknown", site: "測試盤WP2", shift_type: "N", broker_display: "測試雞頭A" });
    const gm = qs.find((q) => q.id === guardMatchQuestionId)! as (typeof qs)[number] & { options: string[]; candidates: string[] };
    expect(gm.options).toEqual(["mc_accept", "mc_pick"]);
    expect(gm.summary).toContain("3 格保安員配對要核實");
    expect(pricing).toMatchObject({ has_suggestion: false }); // unknown＝冇預填建議（P8.2）
    for (const q of qs) expect(Object.keys(q).sort()).toEqual(["broker_display", "candidates", "confidence", "has_suggestion", "id", "kind", "options", "shift_type", "site", "status", "summary"]);
    // options／candidates 只 id：candidates 嚟自 evidence（c1），options 唔含 skip
    expect(gm.candidates).toEqual(["c1"]);
    for (const q of qs) expect((q as unknown as { options: string[] }).options).not.toContain("skip");
  });

  it("triage_summary：非老闆（主管）只見自己 owner 嗰批 → 冇題", async () => {
    const { json } = await runTool(fx, "主管", "triage_summary", { month: MONTH });
    expect(json.total).toBe(0);
  });

  it("month_health：出體檢結果；未定價 finding 帶「盤×更種×雞頭」明細；冇保安員資料", async () => {
    const { raw, json } = await runTool(fx, "老闆", "month_health", { month: MONTH });
    expectNoPii(raw);
    expect(raw).not.toContain("測試保安員");
    const findings = json.findings as Array<{ code: string; count: number; detail: Array<Record<string, unknown>> | null }>;
    const unpriced = findings.find((f) => f.code === "unpriced_payout");
    expect(unpriced).toBeTruthy();
    expect(unpriced!.count).toBeGreaterThan(0);
    expect(Object.keys(unpriced!.detail![0]!).every((k) => ["site_name", "shift_type_code", "broker_display", "category", "count"].includes(k))).toBe(true);
    for (const f of findings.filter((x) => !["unpriced_payout", "unpriced_client", "no_settlement", "ot_unpriced"].includes(x.code))) expect(f.detail).toBeNull();
  });

  it("ops_digest：照出摘要，冇人名", async () => {
    const { raw, json } = await runTool(fx, "老闆", "ops_digest", { month: MONTH });
    expect(json.month).toBeTruthy();
    expectNoPii(raw);
    expect(raw).not.toContain("測試保安員");
  });

  it("site_setup：更種／預設雞頭顯示名／上載狀態／價卡有冇客價出街價", async () => {
    const { json } = await runTool(fx, "老闆", "site_setup", { site: "測試盤WP2", month: MONTH });
    expect((json.site as { name: string }).name).toBe("測試盤WP2");
    expect((json.shift_types as Array<{ code: string }>).map((s) => s.code)).toContain("N");
    expect(json.default_settlement_broker).toMatchObject({ display: "測試雞頭A" });
    expect(json.uploads).toMatchObject({ count: 1 });
    expect(((json.uploads as { items: Array<{ status: string; unmatched_count: number }> }).items[0])).toMatchObject({ status: "parsed", unmatched_count: 2 });
    const cards = json.effective_rate_cards as Array<{ has_client_rate: boolean | null; has_payout_rate: boolean | null }>;
    expect(cards.length).toBeGreaterThan(0);
    expect(typeof cards[0]!.has_client_rate).toBe("boolean");
    // 回傳冇任何金額數字欄
    expect(JSON.stringify(json)).not.toMatch(/"(client_rate|guard_wage|broker_fee|payout_rate)"/);
  });

  it("site_setup：fieldVisibility 關咗客價／出街價 → has_* 為 null（歸零）", async () => {
    const { json } = await runTool(fx, "老闆", "site_setup", { site: "測試盤WP2", month: MONTH }, { clientRateVisible: false, settlementVisible: false });
    for (const c of json.effective_rate_cards as Array<{ has_client_rate: unknown; has_payout_rate: unknown }>) {
      expect(c.has_client_rate).toBeNull();
      expect(c.has_payout_rate).toBeNull();
    }
  });

  it("site_setup：冇「更表上載」view → uploads withheld；搵唔到盤 → not_found", async () => {
    await setGranted("主管", "更表上載", false);
    const { json } = await runTool(fx, "主管", "site_setup", { site: "測試盤WP2", month: MONTH });
    expect(json.uploads).toEqual({ withheld: true });
    await setGranted("主管", "更表上載", true);
    const nf = await runTool(fx, "老闆", "site_setup", { site: "唔存在嘅盤XYZ" });
    expect(nf.json.error).toBe("not_found");
  });

  it("pricing_explain：未定價更次＋價卡＋原因；金額跟 fieldVisibility 歸零", async () => {
    const { json } = await runTool(fx, "老闆", "pricing_explain", { site: "測試盤WP2", shift_type: "N", month: MONTH });
    expect(json.shifts_total).toBe(1);
    expect(json.unpriced_records_at_least).toBe(1);
    expect((json.unpriced_by_category as Record<string, number>).payout_unpriced).toBe(1);
    expect((json.unpriced_groups as Array<{ category: string }>).map((g) => g.category)).toContain("payout_unpriced");
    expect((json.why as string[]).length).toBeGreaterThan(0);
    const hidden = await runTool(fx, "老闆", "pricing_explain", { site: "測試盤WP2", shift_type: "N", month: MONTH }, { clientRateVisible: false, settlementVisible: false });
    for (const c of hidden.json.rate_cards as Array<Record<string, unknown>>) {
      expect("client_rate" in c).toBe(false);
      expect("payout_rate" in c).toBe(false);
    }
    const bad = await runTool(fx, "老闆", "pricing_explain", { site: "測試盤WP2", shift_type: "ZZ", month: MONTH });
    expect(bad.json.error).toBe("shift_type_not_found");
  });

  it("recent_app_errors：老闆見到已遮罩紀錄（冇原始數字）", async () => {
    const { raw, json } = await runTool(fx, "老闆", "recent_app_errors", { limit: 5 });
    expect(json.count).toBeGreaterThanOrEqual(1);
    expect(raw).not.toContain("91234567");
    expect(raw).toContain("[num]");
  });
});
