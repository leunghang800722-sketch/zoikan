// WA-9 (0)：GET /api/whatsapp/messages/export——老闆專用、範圍 ≤62 日、上限 2,000、audit（只記範圍＋計數）、sender 不含完整電話。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as exportGet } from "@/app/api/whatsapp/messages/export/route";
import type { RoleName } from "@/lib/rbac/matrix";

const BASE = "http://test.local";
const G = "wa9-exp@g.us";
const req = (qs: string, cookie: string | null) => new Request(`${BASE}/api/whatsapp/messages/export${qs}`, { headers: cookie ? { cookie } : {} });

describe("WA-9 訊息匯出", () => {
  let fx: Wp2Fixture;
  const ck = {} as Record<RoleName, string>;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    for (const r of ["老闆", "主管", "會計", "雞頭", "安員"] as RoleName[]) ck[r] = await sessionCookieForUser(fx.userIds[r]);
    const g = await prisma.whatsappGroup.create({ data: { groupJid: G, label: "測試匯出群", kind: "multi_site", createdBy: "t" } });
    void g;
    const mk = (id: string, ts: string, over: Record<string, unknown> = {}) =>
      prisma.whatsappMessage.create({ data: { session: "default", chatJid: G, messageId: id, senderJid: "85290001234@c.us", senderTelNorm: "90001234", ts: new Date(ts), text: `1/10/2026 測試甲 測試乙 (${id})`, status: "ignored", ignoreReason: "filtered_out", filterScore: 20, filterReasons: ["too_short"], ...over } });
    await mk("e1", "2026-10-01T03:00:00Z");
    await mk("e2", "2026-10-02T03:00:00Z", { status: "routed", ignoreReason: null, filterReasons: [] });
    await mk("e3", "2026-09-01T03:00:00Z");
  });

  it("非老闆 403（主管／會計／雞頭／安員）；未登入 401", async () => {
    for (const r of ["主管", "會計", "雞頭", "安員"] as RoleName[]) expect((await exportGet(req("?from=2026-10-01&to=2026-10-31", ck[r]))).status, r).toBe(403);
    expect((await exportGet(req("?from=2026-10-01&to=2026-10-31", null))).status).toBe(401);
  });
  it("老闆：回陣列（含原文）、按範圍／status／group 篩；sender 唔含完整電話；欄位齊", async () => {
    const res = await exportGet(req("?from=2026-10-01&to=2026-10-31", ck["老闆"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-truncated")).toBeNull();
    const rows = (await res.json()) as { rows: Array<Record<string, unknown>>; truncated: boolean };
    expect(rows.truncated).toBe(false);
    expect(rows.rows.map((r) => (r.text as string).slice(-4))).toEqual(["(e1)", "(e2)"]);
    expect(rows.rows[0]).toMatchObject({ group_label: "測試匯出群", hk_date: "2026-10-01", status: "ignored", ignore_reason: "filtered_out", filter_reasons: ["too_short"], media_type: null, sender: "…1234" });
    expect(Object.keys(rows.rows[0]!).sort()).toEqual(["filter_reasons", "group_label", "hk_date", "id", "ignore_reason", "media_type", "sender", "status", "text", "ts"]);
    expect(JSON.stringify(rows)).not.toMatch(/90001234|85290001234/);
    const only = (await (await exportGet(req("?from=2026-10-01&to=2026-10-31&status=ignored", ck["老闆"]))).json()) as { rows: unknown[] };
    expect(only.rows).toHaveLength(1);
    expect(((await (await exportGet(req(`?from=2026-09-01&to=2026-10-31&group=${G}`, ck["老闆"]))).json()) as { rows: unknown[] }).rows).toHaveLength(3);
    expect(((await (await exportGet(req("?from=2026-09-01&to=2026-09-30", ck["老闆"]))).json()) as { rows: unknown[] }).rows).toHaveLength(1);
  });
  it("參數驗證：格式／to<from／status 唔啱／範圍超 62 日 → 400", async () => {
    for (const qs of ["", "?from=2026-10-01", "?from=x&to=y", "?from=2026-10-05&to=2026-10-01", "?from=2026-10-01&to=2026-10-31&status=weird", "?from=2026-08-01&to=2026-10-31"]) expect((await exportGet(req(qs, ck["老闆"]))).status, qs).toBe(400);
    expect((await exportGet(req("?from=2026-09-01&to=2026-11-01", ck["老闆"]))).status).toBe(200); // 剛好 62 日
  });
  it("audit：whatsapp_messages_export 只記範圍＋計數（唔記內容）", async () => {
    await exportGet(req("?from=2026-10-01&to=2026-10-31&status=ignored", ck["老闆"]));
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "whatsapp_messages_export" }, orderBy: { createdAt: "desc" } });
    expect(a.after).toEqual({ from: "2026-10-01", to: "2026-10-31", group: false, statuses: ["ignored"], count: 1, truncated: false });
    expect(JSON.stringify(a.after)).not.toContain("孫富榮");
  });
  it("上限 2,000 條：超出截斷＋x-truncated", async () => {
    await prisma.whatsappMessage.createMany({ data: Array.from({ length: 2001 }, (_, i) => ({ session: "default", chatJid: G, messageId: `bulk-${i}`, senderJid: "x@c.us", ts: new Date(Date.UTC(2026, 9, 10, 0, 0, 0, i)), text: "t", status: "ignored" as const })) });
    const res = await exportGet(req("?from=2026-10-10&to=2026-10-10", ck["老闆"]));
    expect(res.headers.get("x-truncated")).toBe("1");
    const big = (await res.json()) as { rows: unknown[]; truncated: boolean };
    expect(big.rows.length).toBe(2000);
    expect(big.truncated).toBe(true);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "whatsapp_messages_export" }, orderBy: { createdAt: "desc" } })).after).toMatchObject({ count: 2000, truncated: true });
  });
});
