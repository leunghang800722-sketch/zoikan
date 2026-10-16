// W1：GET /api/whatsapp/intents、/api/whatsapp/stats——RBAC、原話／姓名遮罩、篩選、對照（✓／✗／—）、統計、群組 filter_threshold。
// 全部假資料（測試保安員甲／乙、假群、假電話尾）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as intentsGet } from "@/app/api/whatsapp/intents/route";
import { GET as statsGet } from "@/app/api/whatsapp/stats/route";
import { PATCH as groupsPatch, GET as groupsGet } from "@/app/api/whatsapp/groups/route";
import { compareOne } from "@/lib/whatsapp/compare";
import type { RoleName } from "@/lib/rbac/matrix";

const BASE = "http://test.local";
const G = "w1-api-g1@g.us";
function req(path: string, cookie: string | null, method = "GET", body?: unknown) {
  return new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const Q = "from=2026-10-16&to=2026-10-16";

describe("W1 intents／stats API", () => {
  let fx: Wp2Fixture;
  const cookies = {} as Record<RoleName, string>;
  let tN: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    for (const r of ["老闆", "主管", "會計", "雞頭", "安員"] as RoleName[]) cookies[r] = await sessionCookieForUser(fx.userIds[r]);
    tN = fx.shiftType.id;
    await prisma.whatsappGroup.create({ data: { groupJid: G, label: "W1API群", kind: "site", siteId: fx.site.id, createdBy: fx.userIds["老闆"] } });
    const mk = (id: string, text: string, off: number) =>
      prisma.whatsappMessage.create({ data: { session: "default", chatJid: G, messageId: id, senderJid: "85290000011@c.us", senderTelNorm: "90000011", senderGuardId: fx.guardA.id, ts: new Date(Date.UTC(2026, 9, 16, 5, 0, off)), text, status: "routed", llmProvider: "fake" } });
    await mk("a1", "機密原話一 聽日夜更", 0);
    await mk("a2", "機密原話二 聽日請病假", 1);
    await mk("a3", "機密原話三 聽日夜更", 2);
    await mk("a4", "機密原話四", 3);
    await prisma.whatsappMessage.create({ data: { session: "default", chatJid: G, messageId: "a5", senderJid: "x@c.us", ts: new Date(Date.UTC(2026, 9, 16, 5, 0, 9)), text: "收到", status: "ignored", ignoreReason: "filtered_out" } });
    await prisma.whatsappMessage.create({ data: { session: "default", chatJid: G, messageId: "a6", senderJid: "x@c.us", ts: new Date(Date.UTC(2026, 9, 16, 5, 0, 10)), text: "", status: "ignored", ignoreReason: "group_unbound" } });
    const d = new Date("2026-10-17T00:00:00Z");
    const intent = (messageId: string, over: Record<string, unknown>) => prisma.whatsappIntent.create({ data: { messageId, messageRevision: 1, idx: 0, kind: "shift", workDate: d, siteId: fx.site.id, guardId: fx.guardA.id, shiftTypeId: tN, confidence: 0.9, resolution: { reasons: [], notes: [], candidates: {}, group_auto_write: false }, routed: "auto_write", ...over } as never });
    await intent("a1", {}); // 實際排更有 → 一致
    await intent("a2", { kind: "leave", shiftTypeId: null, leaveCode: "SL" }); // 實際係更 → 唔一致
    await intent("a3", { guardId: fx.guardB.id, resolution: { reasons: ["conflict_other_shift"], notes: [], candidates: { guard_ids: ["x", "y"] } }, routed: "triage" }); // 未排 → —
    await intent("a4", { kind: "question_only", guardId: null, workDate: null, shiftTypeId: null, routed: "ignored", resolution: { reasons: ["question_only"], notes: [] } });
    await prisma.shiftRecord.create({ data: { workDate: d, siteId: fx.site.id, shiftTypeId: tN, guardId: fx.guardA.id, recordType: "shift", status: "confirmed", createdBy: "test:w1api" } });
  });

  it("RBAC：老闆／會計／主管 200；雞頭／安員 403；未登入 401", async () => {
    for (const r of ["老闆", "會計", "主管"] as RoleName[]) {
      expect((await intentsGet(req(`/api/whatsapp/intents?${Q}`, cookies[r]))).status).toBe(200);
      expect((await statsGet(req(`/api/whatsapp/stats?${Q}`, cookies[r]))).status).toBe(200);
    }
    for (const r of ["雞頭", "安員"] as RoleName[]) {
      expect((await intentsGet(req(`/api/whatsapp/intents?${Q}`, cookies[r]))).status).toBe(403);
      expect((await statsGet(req(`/api/whatsapp/stats?${Q}`, cookies[r]))).status).toBe(403);
    }
    expect((await intentsGet(req(`/api/whatsapp/intents?${Q}`, null))).status).toBe(401);
    expect((await statsGet(req(`/api/whatsapp/stats?${Q}`, null))).status).toBe(401);
  });

  it("intents：欄位、原話／姓名（有權限）、對照 ✓／✗／—、不適用", async () => {
    const res = await intentsGet(req(`/api/whatsapp/intents?${Q}`, cookies["老闆"]));
    const body = (await res.json()) as { rows: Array<Record<string, unknown>>; total: number; can_see_text: boolean };
    expect(body.total).toBe(4);
    expect(body.can_see_text).toBe(true);
    const by = (t: string) => body.rows.find((r) => String(r.text).includes(t))!;
    expect(by("原話一")).toMatchObject({ kind: "shift", work_date: "2026-10-17", shift_code: "N", guard_name: "測試保安員甲", routed: "auto_write", compare: "match", sender: "測試保安員甲", group_label: "W1API群", has_guard: true });
    expect(by("原話二")).toMatchObject({ kind: "leave", leave_code: "SL", compare: "mismatch", actual: ["shift:N"] });
    expect(by("原話三")).toMatchObject({ routed: "triage", compare: "none", reasons: ["conflict_other_shift"], candidate_counts: { guard_ids: 2 } });
    expect(by("原話四")).toMatchObject({ kind: "question_only", compare: null });
    expect(JSON.stringify(body)).not.toMatch(/group_jid|85290000011|message_id|w1-api-g1/);
  });

  it("原話／姓名只俾有「安員」view 權者：撤走會計 安員:view → text／guard_name 變 null", async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "會計" } });
    const perm = await prisma.permission.findFirstOrThrow({ where: { module: "安員", action: "view" } });
    await prisma.rolePermission.update({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }, data: { granted: false } });
    const body = (await (await intentsGet(req(`/api/whatsapp/intents?${Q}`, cookies["會計"]))).json()) as { rows: Array<Record<string, unknown>>; can_see_text: boolean };
    expect(body.can_see_text).toBe(false);
    for (const r of body.rows) {
      expect(r.text).toBeNull();
      expect(r.guard_name).toBeNull();
      expect(r.guard_id).toBeNull();
      expect(String(r.sender)).toBe("…0011");
    }
    expect(JSON.stringify(body)).not.toContain("機密原話");
  });

  it("篩選：routed／group／日期範圍；非法參數 400", async () => {
    const get = async (qs: string) => (await (await intentsGet(req(`/api/whatsapp/intents?${qs}`, cookies["老闆"]))).json()) as { rows: unknown[]; total: number };
    expect((await get(`${Q}&routed=triage`)).total).toBe(1);
    expect((await get(`${Q}&routed=auto_write`)).total).toBe(2);
    expect((await get(`${Q}&routed=ignored`)).total).toBe(1);
    const g = await prisma.whatsappGroup.findFirstOrThrow({ where: { groupJid: G } });
    expect((await get(`${Q}&group=${g.id}`)).total).toBe(4);
    expect((await get(`${Q}&group=other-g@g.us`)).total).toBe(0);
    expect((await get("from=2026-10-01&to=2026-10-15")).total).toBe(0);
    expect((await get("from=2026-10-17&to=2026-10-17")).total).toBe(0);
    expect((await intentsGet(req(`/api/whatsapp/intents?${Q}&routed=bogus`, cookies["老闆"]))).status).toBe(400);
    expect((await intentsGet(req("/api/whatsapp/intents?from=2026-13-40", cookies["老闆"]))).status).toBe(400);
    expect((await intentsGet(req("/api/whatsapp/intents?from=2026-10-20&to=2026-10-10", cookies["老闆"]))).status).toBe(400);
  });

  it("被取代／撤回嘅 intent 標示且唔計入統計", async () => {
    await prisma.whatsappIntent.create({ data: { messageId: "a1", messageRevision: 1, idx: 1, kind: "shift", routed: "triage", supersededByRevision: 2, resolution: {} } });
    await prisma.whatsappIntent.create({ data: { messageId: "a3", messageRevision: 1, idx: 1, kind: "shift", routed: "triage", revokedAt: new Date(), resolution: {} } });
    const body = (await (await intentsGet(req(`/api/whatsapp/intents?${Q}`, cookies["老闆"]))).json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.filter((r) => r.superseded).length).toBe(1);
    expect(body.rows.filter((r) => r.revoked).length).toBe(1);
    const s = (await (await statsGet(req(`/api/whatsapp/stats?${Q}`, cookies["老闆"]))).json()) as Record<string, number>;
    expect(s.triage).toBe(1);
  });

  it("stats：收 N／過濾 M／解析 K／A／T／I／一致率", async () => {
    const s = (await (await statsGet(req(`/api/whatsapp/stats?${Q}`, cookies["老闆"]))).json()) as Record<string, number | null>;
    expect(s).toMatchObject({ from: "2026-10-16", to: "2026-10-16", received: 6, filtered: 2, parsed: 4, auto_write: 2, triage: 1, ignored: 1, intents: 4, compared: 2, consistent: 1, inconsistent: 1, not_scheduled: 1, consistency_rate: 0.5, auto_write_compared: 2, auto_write_consistent: 1, auto_write_consistency_rate: 0.5, errors: 0, pending: 0 });
  });

  it("stats：私訊／本機發出唔計收；冇資料 → 率 null；group 篩選", async () => {
    await prisma.whatsappMessage.create({ data: { session: "default", chatJid: "private:abcd", messageId: "pv1", senderJid: "private:x", ts: new Date(Date.UTC(2026, 9, 16, 6, 0, 0)), status: "ignored", ignoreReason: "not_group" } });
    const s = (await (await statsGet(req(`/api/whatsapp/stats?${Q}`, cookies["老闆"]))).json()) as Record<string, number | null>;
    expect(s.received).toBe(6);
    const empty = (await (await statsGet(req("/api/whatsapp/stats?from=2026-01-01&to=2026-01-02", cookies["老闆"]))).json()) as Record<string, number | null>;
    expect(empty).toMatchObject({ received: 0, consistency_rate: null, auto_write_consistency_rate: null });
    const none = (await (await statsGet(req(`/api/whatsapp/stats?${Q}&group=nope@g.us`, cookies["老闆"]))).json()) as Record<string, number | null>;
    expect(none.received).toBe(0);
  });

  it("compareOne 純函數：OFF≈RD、OT 唔計、cover 唔對照", () => {
    const base = { id: "i", guardId: "g", workDate: "2026-10-17", shiftTypeId: "t1", leaveCode: null };
    expect(compareOne({ ...base, kind: "leave", leaveCode: "RD" }, [{ recordType: "leave", shiftTypeId: "t1", leaveCode: "OFF" }]).status).toBe("match");
    expect(compareOne({ ...base, kind: "shift" }, [{ recordType: "ot", shiftTypeId: "t1", leaveCode: null }]).status).toBe("none");
    expect(compareOne({ ...base, kind: "cover" }, []).status).toBeNull();
    expect(compareOne({ ...base, kind: "shift", guardId: null }, []).status).toBeNull();
  });

  it("群組 filter_threshold：PATCH 0–100／null；越界 400；DTO 回傳", async () => {
    const g = await prisma.whatsappGroup.findFirstOrThrow({ where: { groupJid: G } });
    const ok = await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, filter_threshold: 55 }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { filter_threshold: number }).filter_threshold).toBe(55);
    expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).filterThreshold).toBe(55);
    expect((await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, filter_threshold: 101 }))).status).toBe(400);
    expect((await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, filter_threshold: -1 }))).status).toBe(400);
    const cleared = await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, filter_threshold: null }));
    expect(((await cleared.json()) as { filter_threshold: number | null }).filter_threshold).toBeNull();
    const list = (await (await groupsGet(req("/api/whatsapp/groups", cookies["老闆"]))).json()) as { rows: Array<{ filter_threshold: number | null }> };
    expect(list.rows[0]!.filter_threshold).toBeNull();
  });
});
