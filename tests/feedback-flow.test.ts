// P2.5「現場反映」開會模式——session／summarize／submit／reports API
// 整合測試：權限（雞頭/保安員 403；老闆/主管/會計 200）、長度校驗、每日
// 3 份上限、reports 讀取權限（作者本人睇自己、老闆全睇、主管睇他人
// 403）、unread-count（老闆）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { FakeLlmClient, fakeLlmReplying } from "./fixtures/fake-llm";
import { POST as sessionOpenPost } from "@/app/api/feedback/session/route";
import { POST as sessionChatPost } from "@/app/api/feedback/session/chat/route";
import { POST as sessionSummarizePost } from "@/app/api/feedback/session/summarize/route";
import { POST as sessionSubmitPost } from "@/app/api/feedback/session/submit/route";
import { POST as sessionAbandonPost } from "@/app/api/feedback/session/abandon/route";
import { GET as reportsGet } from "@/app/api/feedback/reports/route";
import { GET as reportGet, PATCH as reportPatch } from "@/app/api/feedback/reports/[id]/route";
import { GET as unreadCountGet } from "@/app/api/feedback/unread-count/route";
import { MAX_REPORTS_PER_DAY, MAX_FIELD_LEN } from "@/lib/feedback/report";

function req(url: string, cookie: string, body?: unknown, method = "POST") {
  return new Request(`http://test.local${url}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<{ status: number; events: Array<{ event: string; data: unknown }> }> {
  const status = res.status;
  if (!res.body) return { status, events: [] };
  const text = await res.text();
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (eventLine && dataLine) events.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
  }
  return { status, events };
}

const SAMPLE_FIELDS = {
  title: "更表編輯器手機版撳格太細",
  current_problem: "喺手機打開更表編輯器，格仔太細，成日撳錯人。",
  desired_change: "想格仔大啲，或者可以放大顯示。",
  reason: "而家排更成日出錯，要重做，浪費時間。",
  related: "所有盤，手機瀏覽器",
  open_questions: "",
};

describe("P2.5：/api/feedback/** 權限＋流程", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  beforeEach(() => {
    setLlmClientForTests(fakeLlmReplying("多謝你講咁清楚，仲有幾條想問……"));
  });
  afterEach(() => {
    setLlmClientForTests(undefined);
  });

  it("雞頭／保安員 → POST /api/feedback/session 403（硬性，同 助手 module 一致）", async () => {
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const guardCookie = await sessionCookieForUser(fx.userIds["安員"]);
    const resBroker = await sessionOpenPost(req("/api/feedback/session", brokerCookie, {}));
    const resGuard = await sessionOpenPost(req("/api/feedback/session", guardCookie, {}));
    expect(resBroker.status).toBe(403);
    expect(resGuard.status).toBe(403);
  });

  it("老闆／主管／會計 → 開 session 成功，一個用戶同時最多一個 draft（重覆開攞返同一個 id）", async () => {
    for (const role of ["老闆", "主管", "會計"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res1 = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { id: string; status: string };
      expect(body1.status).toBe("draft");

      const res2 = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
      const body2 = (await res2.json()) as { id: string };
      expect(body2.id).toBe(body1.id); // 續用同一個 draft

      await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: body1.id }));
    }
  });

  it("開會 chat：兩輪之後 summarize 出返固定範本 fields（reporter/footer 伺服器填）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    const { id: sessionId } = (await openRes.json()) as { id: string };

    setLlmClientForTests(fakeLlmReplying("明白，仲有咩想補充？"));
    const chat1 = await sessionChatPost(req("/api/feedback/session/chat", cookie, { session_id: sessionId, message: "更表編輯器手機版撳格好細" }));
    expect(chat1.status).toBe(200);
    const { events: e1 } = await readSse(chat1);
    expect(e1.find((e) => e.event === "done")).toBeTruthy();

    const chat2 = await sessionChatPost(req("/api/feedback/session/chat", cookie, { session_id: sessionId, message: "全部盤都係咁，成日撳錯人" }));
    expect(chat2.status).toBe(200);

    setLlmClientForTests(
      new FakeLlmClient({
        replyText: JSON.stringify({
          title: SAMPLE_FIELDS.title,
          current_problem: SAMPLE_FIELDS.current_problem,
          desired_change: SAMPLE_FIELDS.desired_change,
          reason: SAMPLE_FIELDS.reason,
          related: SAMPLE_FIELDS.related,
          open_questions: "",
        }),
      }),
    );
    const summarizeRes = await sessionSummarizePost(req("/api/feedback/session/summarize", cookie, { session_id: sessionId }));
    expect(summarizeRes.status).toBe(200);
    const summarized = (await summarizeRes.json()) as { fields: Record<string, string>; summary_md: string };
    expect(summarized.fields.title).toBe(SAMPLE_FIELDS.title);
    expect(summarized.fields.footer).toContain("未評估技術可行性");
    expect(summarized.fields.reporter).toContain("主管");
    expect(summarized.summary_md).toContain(SAMPLE_FIELDS.title);

    await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: sessionId }));
  });

  it("submit：長度驗證——單一欄超過上限 → 400", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    const { id: sessionId } = (await openRes.json()) as { id: string };

    const tooLong = "a".repeat(MAX_FIELD_LEN + 1);
    const res = await sessionSubmitPost(
      req("/api/feedback/session/submit", cookie, { session_id: sessionId, fields: { ...SAMPLE_FIELDS, title: tooLong } }),
    );
    expect(res.status).toBe(400);

    await sessionAbandonPost(req("/api/feedback/session/abandon", cookie, { session_id: sessionId }));
  });

  it(`submit：每人每日上限 ${MAX_REPORTS_PER_DAY} 份，第 ${MAX_REPORTS_PER_DAY + 1} 份 → 429`, async () => {
    // 呢個測試要開 MAX_REPORTS_PER_DAY+1 個 session——用「老闆」（呢個
    // describe block 入面淨係喺角色迴圈嗰條 test 開過一次 session）唔係
    // 「會計」（之前兩條 test 已經開咗 2 次），避免同 P2.5 Opus 驗收
    // 應修④嘅「每人每日最多開 5 個 session」上限撞埋一齊，令呢條測試
    // 提早俾 `feedback_session_limit` 429 擋住，測試唔到真正想斷言嘅
    // 「送出份數上限」429。
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    for (let i = 0; i < MAX_REPORTS_PER_DAY; i++) {
      const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
      const { id: sessionId } = (await openRes.json()) as { id: string };
      const submitRes = await sessionSubmitPost(req("/api/feedback/session/submit", cookie, { session_id: sessionId, fields: SAMPLE_FIELDS }));
      expect(submitRes.status).toBe(200);
    }
    const openRes = await sessionOpenPost(req("/api/feedback/session", cookie, {}));
    const { id: sessionId } = (await openRes.json()) as { id: string };
    const overLimitRes = await sessionSubmitPost(req("/api/feedback/session/submit", cookie, { session_id: sessionId, fields: SAMPLE_FIELDS }));
    expect(overLimitRes.status).toBe(429);
  });

  it("雞頭／保安員 → submit 403", async () => {
    for (const role of ["雞頭", "安員"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res = await sessionSubmitPost(req("/api/feedback/session/submit", cookie, { session_id: "whatever", fields: SAMPLE_FIELDS }));
      expect(res.status).toBe(403);
    }
  });
});

describe("P2.5：/api/feedback/reports 讀取權限", () => {
  let fx: Wp2Fixture;
  let reportId: string;
  let authorUserId: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    authorUserId = fx.userIds["會計"];
    const report = await prisma.feedbackReport.create({
      data: {
        sessionId: (
          await prisma.feedbackSession.create({ data: { userId: authorUserId, status: "submitted", messages: [] } })
        ).id,
        userId: authorUserId,
        roleName: "會計",
        title: "測試意見",
        summaryMd: "# 測試意見\n\n內容",
        fields: { title: "測試意見" },
        transcriptExcerpt: [],
        status: "new",
      },
    });
    reportId = report.id;
  });

  it("作者本人 → 200 睇到自己嗰份", async () => {
    const cookie = await sessionCookieForUser(authorUserId);
    const res = await reportGet(req(`/api/feedback/reports/${reportId}`, cookie, undefined, "GET"), { params: Promise.resolve({ id: reportId }) });
    expect(res.status).toBe(200);
  });

  it("老闆 → 200 全睇", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await reportGet(req(`/api/feedback/reports/${reportId}`, cookie, undefined, "GET"), { params: Promise.resolve({ id: reportId }) });
    expect(res.status).toBe(200);
  });

  it("主管（唔係作者）→ 404（唔可以由 403／404 分辨呢個 id 存唔存在，見 P2.5 Opus 驗收應修③）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await reportGet(req(`/api/feedback/reports/${reportId}`, cookie, undefined, "GET"), { params: Promise.resolve({ id: reportId }) });
    expect(res.status).toBe(404);
  });

  it("主管打一個根本唔存在嘅 id → 一樣係 404（同上面「唔係作者」個 case 分唔出嚟，唔洩露 id 存在與否）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await reportGet(req(`/api/feedback/reports/no-such-id-00000000`, cookie, undefined, "GET"), {
      params: Promise.resolve({ id: "no-such-id-00000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("作者本人打一個根本唔存在嘅 id → 404", async () => {
    const cookie = await sessionCookieForUser(authorUserId);
    const res = await reportGet(req(`/api/feedback/reports/no-such-id-11111111`, cookie, undefined, "GET"), {
      params: Promise.resolve({ id: "no-such-id-11111111" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/feedback/reports（清單）：主管唔係老闆 → 403", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await reportsGet(req("/api/feedback/reports", cookie, undefined, "GET"));
    expect(res.status).toBe(403);
  });

  it("GET /api/feedback/reports（清單）：老闆 → 200，見到呢份", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await reportsGet(req("/api/feedback/reports", cookie, undefined, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.some((r) => r.id === reportId)).toBe(true);
  });

  it("PATCH：主管唔係老闆 → 403；老闆改狀態 → 200，audit 有一行 update", async () => {
    const supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const forbidRes = await reportPatch(req(`/api/feedback/reports/${reportId}`, supervisorCookie, { status: "read" }, "PATCH"), {
      params: Promise.resolve({ id: reportId }),
    });
    expect(forbidRes.status).toBe(403);

    const ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const okRes = await reportPatch(req(`/api/feedback/reports/${reportId}`, ownerCookie, { status: "forwarded", review_note: "已經同 Eric 講" }, "PATCH"), {
      params: Promise.resolve({ id: reportId }),
    });
    expect(okRes.status).toBe(200);
    const after = await prisma.feedbackReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(after.status).toBe("forwarded");
    expect(after.reviewNote).toBe("已經同 Eric 講");

    const auditRow = await prisma.auditLog.findFirst({
      where: { tableName: "feedback_reports", rowId: reportId, action: "update" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
  });

  it("GET /api/feedback/unread-count：老闆 → 200；主管 → 403", async () => {
    const ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const okRes = await unreadCountGet(req("/api/feedback/unread-count", ownerCookie, undefined, "GET"));
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { count: number };
    expect(typeof body.count).toBe("number");

    const supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const forbidRes = await unreadCountGet(req("/api/feedback/unread-count", supervisorCookie, undefined, "GET"));
    expect(forbidRes.status).toBe(403);
  });
});
