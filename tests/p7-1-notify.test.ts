// P7.1：通知——dedupe、PII guard、audience 讀取／已讀隔離、email 關閉唔拋錯、email 收件人過濾、API。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { createNotification, assertNoPii } from "@/lib/notify/create";
import { setMailTransportForTests } from "@/lib/notify/mailer";
import { GET as listRoute } from "@/app/api/notifications/route";
import { POST as readRoute } from "@/app/api/notifications/[id]/read/route";
import { POST as readAllRoute } from "@/app/api/notifications/read-all/route";
import { GET as notifyGet, PATCH as notifyPatch } from "@/app/api/users/[id]/notify/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const idp = (id: string) => ({ params: Promise.resolve({ id }) });

describe("P7.1 notifications", () => {
  let fx: Wp2Fixture;
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    sent.length = 0;
  });
  afterEach(() => setMailTransportForTests(null));

  it("dedupe：同 dedupe_key 只出一條", async () => {
    const a = await createNotification({ kind: "month_opened", title: "2026-11 已開好", body: "掛盤 3", audience: ["老闆"], dedupeKey: "k1" });
    const b = await createNotification({ kind: "month_opened", title: "2026-11 已開好", body: "掛盤 3", audience: ["老闆"], dedupeKey: "k1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await prisma.appNotification.count()).toBe(1);
  });

  it("PII guard：身份證／電郵／8 位電話拒絕；uuid、金額、月份通過", () => {
    expect(() => assertNoPii("A123456(7)")).toThrow();
    expect(() => assertNoPii("a@b.com")).toThrow();
    expect(() => assertNoPii("電話 91234567")).toThrow();
    expect(() => assertNoPii("run 12345678-1234-4234-8234-123456789012 月份 2026-11 價 1234.50 掛盤 3／配額 12")).not.toThrow();
  });

  it("email 關閉（冇 SMTP_URL）：建立通知唔拋錯、email_sent_at 保持 null", async () => {
    const prev = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { notifyEmail: "boss@example.test" } });
    const r = await createNotification({ kind: "month_opened", title: "t", body: "b", audience: ["老闆"], dedupeKey: "off1" });
    expect(r.created).toBe(true);
    expect(r.emailed).toBe(0);
    expect((await prisma.appNotification.findUniqueOrThrow({ where: { dedupeKey: "off1" } })).emailSentAt).toBeNull();
    if (prev !== undefined) process.env.SMTP_URL = prev;
  });

  it("email 收件人：role／user id audience、跳過冇電郵／已關該類／停用用戶；內容無 PII 且帶 APP_BASE_URL 連結", async () => {
    setMailTransportForTests({ sendMail: async (m) => void sent.push({ to: m.to, subject: m.subject, text: m.text }) });
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { notifyEmail: "boss@example.test" } });
    await prisma.user.update({ where: { id: fx.userIds["會計"] }, data: { notifyEmail: "acc@example.test", notifyPrefs: { month_opened: false } } });
    await prisma.user.update({ where: { id: fx.userIds["主管"] }, data: { notifyEmail: "sup@example.test" } });
    // 主管：用 user id audience；會計：role audience 但關咗呢類
    const r = await createNotification({ kind: "month_opened", title: "2026-11 已開好", body: "掛盤 3／配額 4", href: "/roster", audience: ["老闆", "會計", fx.userIds["主管"]], dedupeKey: "mail1" });
    expect(r.emailed).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual(["boss@example.test", "sup@example.test"]);
    expect(sent[0]!.subject).toContain("2026-11 已開好");
    expect(sent[0]!.text).toContain("https://zoikan.zeabur.app/roster");
    expect((await prisma.appNotification.findUniqueOrThrow({ where: { dedupeKey: "mail1" } })).emailSentAt).not.toBeNull();
    // 停用用戶唔寄
    sent.length = 0;
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { status: "inactive" } });
    await createNotification({ kind: "month_opened", title: "t2", body: "b2", audience: ["老闆"], dedupeKey: "mail2" });
    expect(sent).toHaveLength(0);
  });

  it("transport 寄失敗唔拋錯、唔寫 email_sent_at", async () => {
    setMailTransportForTests({ sendMail: async () => { throw new Error("smtp down"); } });
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { notifyEmail: "boss@example.test" } });
    const r = await createNotification({ kind: "month_opened", title: "t", body: "b", audience: ["老闆"], dedupeKey: "fail1" });
    expect(r.created).toBe(true);
    expect(r.emailed).toBe(0);
  });

  it("API：按 audience 隔離（會計睇唔到老闆專屬）、未讀數、已讀、read-all、別人嘅 id 404", async () => {
    const bossN = await createNotification({ kind: "month_ready_to_lock", title: "老闆專屬", body: "b", audience: ["老闆"], dedupeKey: "a1" });
    await createNotification({ kind: "month_opened", title: "三方", body: "b", audience: ["老闆", "會計"], dedupeKey: "a2" });
    await createNotification({ kind: "triage_reminder", title: "主管 user", body: "b", audience: [fx.userIds["主管"]], dedupeKey: "a3" });
    const boss = await sessionCookieForUser(fx.userIds["老闆"]);
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    const sup = await sessionCookieForUser(fx.userIds["主管"]);

    const bossList = await (await listRoute(req("http://t/api/notifications", boss))).json();
    expect(bossList.total).toBe(2);
    expect(bossList.unread).toBe(2);
    const accList = await (await listRoute(req("http://t/api/notifications", acc))).json();
    expect(accList.rows.map((r: { title: string }) => r.title)).toEqual(["三方"]);
    const supList = await (await listRoute(req("http://t/api/notifications", sup))).json();
    expect(supList.rows.map((r: { title: string }) => r.title)).toEqual(["主管 user"]);

    // 會計讀老闆專屬 → 404
    expect((await readRoute(req(`http://t/x`, acc, "POST"), idp(bossN.id!))).status).toBe(404);
    // 老闆已讀 → unread 減 1；重複已讀 200
    expect((await readRoute(req(`http://t/x`, boss, "POST"), idp(bossN.id!))).status).toBe(200);
    expect((await readRoute(req(`http://t/x`, boss, "POST"), idp(bossN.id!))).status).toBe(200);
    const after = await (await listRoute(req("http://t/api/notifications?unread=1", boss))).json();
    expect(after.total).toBe(1);
    expect(after.rows[0].title).toBe("三方");
    // 老闆已讀唔影響會計
    expect((await (await listRoute(req("http://t/api/notifications?unread=1", acc))).json()).total).toBe(1);
    const ra = await (await readAllRoute(req("http://t/x", boss, "POST"))).json();
    expect(ra.updated).toBe(1);
    expect((await (await listRoute(req("http://t/api/notifications?unread=1", boss))).json()).total).toBe(0);
    // 未登入 401
    expect((await listRoute(new Request("http://t/api/notifications"))).status).toBe(401);
  });

  it("通知電郵設定：本人改自己、老闆改所有人、別人 403；格式驗證；audit 只記已改（唔存電郵）；response 回傳本人 email", async () => {
    const acc = await sessionCookieForUser(fx.userIds["會計"]);
    const sup = await sessionCookieForUser(fx.userIds["主管"]);
    const boss = await sessionCookieForUser(fx.userIds["老闆"]);
    const accId = fx.userIds["會計"];
    expect((await notifyPatch(req("http://t/x", acc, "PATCH", { notify_email: "Acc@Example.test" }), idp(accId))).status).toBe(200);
    expect((await (await notifyGet(req("http://t/x", acc), idp(accId))).json()).notify_email).toBe("acc@example.test");
    expect((await notifyPatch(req("http://t/x", acc, "PATCH", { notify_email: "not-an-email" }), idp(accId))).status).toBe(400);
    expect((await notifyPatch(req("http://t/x", sup, "PATCH", { notify_email: "x@example.test" }), idp(accId))).status).toBe(403);
    expect((await notifyGet(req("http://t/x", sup), idp(accId))).status).toBe(403);
    expect((await notifyPatch(req("http://t/x", boss, "PATCH", { notify_prefs: { triage_reminder: false } }), idp(accId))).status).toBe(200);
    expect((await notifyPatch(req("http://t/x", boss, "PATCH", { notify_prefs: { bogus: false } }), idp(accId))).status).toBe(400);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: accId } });
    expect(u.notifyPrefs).toEqual({ triage_reminder: false });
    const audits = await prisma.auditLog.findMany({ where: { action: "notify_email_update", rowId: accId } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain("example.test");
    // 清除電郵
    await notifyPatch(req("http://t/x", acc, "PATCH", { notify_email: null }), idp(accId));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: accId } })).notifyEmail).toBeNull();
  });

  it("ai.users view 唔含 notify_email／notify_prefs", async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema='ai' AND table_name='users'`;
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain("notify_email");
    expect(names).not.toContain("notify_prefs");
  });
});
