// P13.1：GET /api/triage/sessions/:id 分頁（take／cursor／tier，additive）。
// 無 take＝舊行為一字不變；counts 唔受分頁影響；權限不變；月結 session 同樣分頁。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { seedGuardImportQuestions } from "./lib/triage-seed";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";

const get = (id: string, qs: string, cookie: string) => sessionRoute(new Request(`http://localhost/api/triage/sessions/${id}${qs}`, { headers: { cookie } }), { params: Promise.resolve({ id }) });

describe("P13.1 triage session 分頁", () => {
  let fx: Wp2Fixture;
  let sid: string;
  let cookie: string;
  const REF = "p13-paging";

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const owner = fx.userIds["老闆"];
    cookie = await sessionCookieForUser(owner);
    const s = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: REF, ownerUserId: owner, createdBy: owner } });
    sid = s.id;
    // 刻意令補充題 sort 同重要題交錯（頭 3 條係補充題），驗證 tier 過濾
    const rows = seedGuardImportQuestions(40, 12).map((q, i) => ({ ...q, sessionId: sid, sort: i < 12 ? i + 100 : i - 12 }));
    for (const r of rows) await prisma.triageQuestion.create({ data: { sessionId: r.sessionId, kind: r.kind, groupKey: r.groupKey, sort: r.sort, title: r.title, evidenceJson: r.evidenceJson as never, optionsJson: r.optionsJson as never } });
  });
  afterEach(async () => {
    await prisma.triageQuestion.deleteMany({ where: { sessionId: sid } });
    await prisma.triageSession.deleteMany({ where: { id: sid } });
  });

  it("無 take：全部一次過、冇 next_cursor（舊行為）", async () => {
    const res = await get(sid, "?status=open", cookie);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.questions).toHaveLength(40);
    expect("next_cursor" in j).toBe(false);
    expect(j.session.counts).toMatchObject({ open: 40, important_open: 12, supplementary_open: 28 });
  });

  it("take=5：頭 5 題＋next_cursor；逐頁行到尾，次序同無 take 一致；counts 不變", async () => {
    const all = (await (await get(sid, "?status=open", cookie)).json()).questions.map((q: { id: string }) => q.id);
    const got: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const j: { questions: { id: string }[]; next_cursor: string | null; session: { counts: { open: number; total: number } } } = await (await get(sid, `?status=open&take=5${cursor ? `&cursor=${cursor}` : ""}`, cookie)).json();
      expect(j.session.counts.open).toBe(40);
      expect(j.session.counts.total).toBe(40);
      expect(j.questions.length).toBeLessThanOrEqual(5);
      got.push(...j.questions.map((q) => q.id));
      pages++;
      if (!j.next_cursor) break;
      expect(j.next_cursor).toBe(j.questions[j.questions.length - 1]!.id);
      cursor = j.next_cursor;
    }
    expect(pages).toBe(8);
    expect(got).toEqual(all);
  });

  it("剛好滿頁：最後一頁 next_cursor 為 null（take=40）", async () => {
    const j = await (await get(sid, "?status=open&take=40", cookie)).json();
    expect(j.questions).toHaveLength(40);
    expect(j.next_cursor).toBeNull();
  });

  it("take 超過 50 夾到 50；take=0 淨攞 counts；非法 take／tier／cursor 400", async () => {
    const big = await (await get(sid, "?take=999", cookie)).json();
    expect(big.questions).toHaveLength(40);
    const zero = await (await get(sid, "?status=open&take=0", cookie)).json();
    expect(zero.questions).toEqual([]);
    expect(zero.next_cursor).toBeNull();
    expect(zero.session.counts.open).toBe(40);
    expect((await get(sid, "?take=-1", cookie)).status).toBe(400);
    expect((await get(sid, "?take=abc", cookie)).status).toBe(400);
    expect((await get(sid, "?tier=zzz", cookie)).status).toBe(400);
    expect((await get(sid, "?take=5&cursor=not-a-real-id", cookie)).status).toBe(400);
  });

  it("tier=important／supplementary：只回該層，分頁照行", async () => {
    const imp = await (await get(sid, "?status=open&take=5&tier=important", cookie)).json();
    expect(imp.questions.every((q: { kind: string }) => q.kind === "name_not_confirmed")).toBe(true);
    expect(imp.questions).toHaveLength(5);
    const imp2 = await (await get(sid, `?status=open&take=50&tier=important&cursor=${imp.next_cursor}`, cookie)).json();
    expect(imp2.questions).toHaveLength(7);
    expect(imp2.next_cursor).toBeNull();
    const sup = await (await get(sid, "?status=open&take=50&tier=supplementary", cookie)).json();
    expect(sup.questions).toHaveLength(28);
    expect(sup.questions.every((q: { kind: string }) => q.kind === "field_review")).toBe(true);
  });

  it("答咗嘅題 cursor 仍然有效（cursor 題狀態變咗都續得）", async () => {
    const first = await (await get(sid, "?status=open&take=3", cookie)).json();
    const last = first.questions[2].id as string;
    await prisma.triageQuestion.update({ where: { id: last }, data: { status: "answered" } });
    const next = await get(sid, `?status=open&take=3&cursor=${last}`, cookie);
    expect(next.status).toBe(200);
    const j = await next.json();
    expect(j.questions).toHaveLength(3);
    expect(j.session.counts.open).toBe(39);
  });

  it("權限不變：非擁有人（會計）403；未登入 401；cursor 唔可以借其他 session 嘅題", async () => {
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    expect((await get(sid, "?take=5", acc)).status).toBe(403);
    expect((await get(sid, "?take=5", "")).status).toBe(401);
    const other = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: `${REF}-2`, ownerUserId: fx.userIds["老闆"], createdBy: "t" } });
    const oq = await prisma.triageQuestion.create({ data: { sessionId: other.id, kind: "name_not_confirmed", groupKey: "o1", sort: 1, title: "x", evidenceJson: {}, optionsJson: [] } });
    expect((await get(sid, `?take=5&cursor=${oq.id}`, cookie)).status).toBe(400);
    await prisma.triageQuestion.deleteMany({ where: { sessionId: other.id } });
    await prisma.triageSession.delete({ where: { id: other.id } });
  });

  it("首頁 5 題體積細過 40 KB（無 take 嗰份大好多）", async () => {
    const small = (await (await get(sid, "?status=open&take=5&tier=important", cookie)).text()).length;
    const full = (await (await get(sid, "?status=open", cookie)).text()).length;
    expect(small).toBeLessThan(40_000);
    expect(full).toBeGreaterThan(small * 4);
  });

  it("月結 session（mcQuestionViews）同樣分頁，只對該頁行計 DTO", async () => {
    const owner = fx.userIds["老闆"];
    const ms = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: "p13-mc", ownerUserId: owner, createdBy: owner } });
    const ev = { v: 1, mc: true, runId: "r", month: "2031-02-01", kind: "month_close_settlement", summary: "5 更冇結算雞頭", suggestion: "歸 TK", confidence: "propose", action: { type: "settlement", siteId: "s", guardId: "g", count: 5 }, candidates: [{ id: "c0", label: "TK", refId: "b" }], prefillCandidateId: "c0" };
    for (let i = 1; i <= 7; i++) await prisma.triageQuestion.create({ data: { sessionId: ms.id, kind: "month_close_settlement", groupKey: `m${i}`, sort: i, title: `月結題${i}`, evidenceJson: ev as never, optionsJson: [{ id: "mc_accept", label: "確認" }] as never } });
    const p1 = await (await get(ms.id, "?take=5", cookie)).json();
    expect(p1.questions).toHaveLength(5);
    expect(p1.questions[0].mc.summary).toBe("5 更冇結算雞頭");
    const p2 = await (await get(ms.id, `?take=5&cursor=${p1.next_cursor}`, cookie)).json();
    expect(p2.questions).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    const none = await (await get(ms.id, "", cookie)).json();
    expect(none.questions).toHaveLength(7);
    await prisma.triageQuestion.deleteMany({ where: { sessionId: ms.id } });
    await prisma.triageSession.delete({ where: { id: ms.id } });
  });
});
