// W0：/api/whatsapp/*——RBAC、群組同步（fake WAHA）、綁定 PATCH 驗證＋audit、訊息清單、health。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as groupsGet, PATCH as groupsPatch } from "@/app/api/whatsapp/groups/route";
import { POST as syncPost } from "@/app/api/whatsapp/groups/sync/route";
import { GET as messagesGet } from "@/app/api/whatsapp/messages/route";
import { GET as healthGet } from "@/app/api/whatsapp/health/route";
import type { RoleName } from "@/lib/rbac/matrix";

const BASE = "http://test.local";
function req(path: string, cookie: string | null, method = "GET", body?: unknown) {
  return new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("W0 WhatsApp API", () => {
  let fx: Wp2Fixture;
  const cookies = {} as Record<RoleName, string>;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    for (const r of ["老闆", "主管", "會計", "雞頭", "安員"] as RoleName[]) cookies[r] = await sessionCookieForUser(fx.userIds[r]);
    process.env.WAHA_BASE_URL = "http://waha.test:3000";
    process.env.WAHA_API_KEY = "fake-waha-key";
    process.env.WAHA_SESSION = "default";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WAHA_BASE_URL;
    delete process.env.WAHA_API_KEY;
    delete process.env.WAHA_SESSION;
  });

  async function seedGroup(over: Record<string, unknown> = {}) {
    return prisma.whatsappGroup.create({ data: { groupJid: "test-g1@g.us", label: "測試群一", createdBy: fx.userIds["老闆"], ...over } });
  }

  describe("RBAC", () => {
    it("老闆／會計／主管 GET groups/messages/health = 200；雞頭／安員 = 403；未登入 = 401", async () => {
      for (const r of ["老闆", "會計", "主管"] as RoleName[]) {
        expect((await groupsGet(req("/api/whatsapp/groups", cookies[r]))).status).toBe(200);
        expect((await messagesGet(req("/api/whatsapp/messages", cookies[r]))).status).toBe(200);
        expect((await healthGet(req("/api/whatsapp/health", cookies[r]))).status).toBe(200);
      }
      for (const r of ["雞頭", "安員"] as RoleName[]) {
        expect((await groupsGet(req("/api/whatsapp/groups", cookies[r]))).status).toBe(403);
        expect((await messagesGet(req("/api/whatsapp/messages", cookies[r]))).status).toBe(403);
        expect((await healthGet(req("/api/whatsapp/health", cookies[r]))).status).toBe(403);
        expect((await syncPost(req("/api/whatsapp/groups/sync", cookies[r], "POST"))).status).toBe(403);
      }
      expect((await groupsGet(req("/api/whatsapp/groups", null))).status).toBe(401);
    });

    it("PATCH／sync 淨係老闆；會計、主管 403（view only）", async () => {
      const g = await seedGroup();
      for (const r of ["會計", "主管"] as RoleName[]) {
        expect((await groupsPatch(req("/api/whatsapp/groups", cookies[r], "PATCH", { id: g.id, active: false }))).status).toBe(403);
        expect((await syncPost(req("/api/whatsapp/groups/sync", cookies[r], "POST"))).status).toBe(403);
      }
      expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).active).toBe(true);
    });

    it("can_update 與綁定選項只俾老闆；會計見到列表但冇 site_options", async () => {
      await seedGroup();
      const owner = (await (await groupsGet(req("/api/whatsapp/groups", cookies["老闆"]))).json()) as { can_update: boolean; site_options: unknown[]; broker_options: unknown[] };
      expect(owner.can_update).toBe(true);
      expect(owner.site_options.length).toBeGreaterThan(0);
      expect(owner.broker_options.length).toBeGreaterThan(0);
      const acc = (await (await groupsGet(req("/api/whatsapp/groups", cookies["會計"]))).json()) as { can_update: boolean; site_options: unknown[]; rows: unknown[] };
      expect(acc.can_update).toBe(false);
      expect(acc.site_options).toEqual([]);
      expect(acc.rows.length).toBe(1);
    });

    it("permission_denied 寫 audit", async () => {
      await groupsGet(req("/api/whatsapp/groups", cookies["雞頭"]));
      expect(await prisma.auditLog.count({ where: { action: "permission_denied" } })).toBeGreaterThan(0);
    });
  });

  describe("群組同步（fake WAHA）", () => {
    function fakeFetch(groups: unknown, init: { status?: number } = {}) {
      const f = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
        void url;
        void opts;
        return new Response(JSON.stringify(groups), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
      });
      vi.stubGlobal("fetch", f);
      return f;
    }

    it("新群 kind=ignored、auto 全關；帶 X-Api-Key；打 /api/default/groups；寫一條 sync audit", async () => {
      const f = fakeFetch([
        { id: "test-g1@g.us", name: "測試群一" },
        { id: { _serialized: "test-g2@g.us" }, subject: "測試群二" },
        { id: "85290000001@c.us", name: "私人（唔係群）" },
      ]);
      const res = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ total: 2, created: 2, relabelled: 0 });
      const rows = await prisma.whatsappGroup.findMany({ orderBy: { groupJid: "asc" } });
      expect(rows.map((r) => [r.groupJid, r.label, r.kind, r.autoWrite, r.autoConfirm, r.active])).toEqual([
        ["test-g1@g.us", "測試群一", "ignored", false, false, true],
        ["test-g2@g.us", "測試群二", "ignored", false, false, true],
      ]);
      const [url, opts] = f.mock.calls[0]!;
      expect(String(url)).toBe("http://waha.test:3000/api/default/groups");
      expect((opts as RequestInit).method).toBe("GET");
      expect(((opts as RequestInit).headers as Record<string, string>)["X-Api-Key"]).toBe("fake-waha-key");
      const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "whatsapp_group_sync" } });
      expect(a.tableName).toBe("whatsapp_groups");
      expect(a.after).toEqual({ total: 2, created: 2, relabelled: 0 });
    });

    it("重覆同步冪等：唔重建、唔覆蓋已綁定嘅 kind；群名變咗就更新 label", async () => {
      const g = await seedGroup({ kind: "office" });
      fakeFetch([{ id: "test-g1@g.us", name: "測試群一（改名）" }]);
      const res = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(await res.json()).toEqual({ total: 1, created: 0, relabelled: 1 });
      const after = await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } });
      expect(after).toMatchObject({ kind: "office", label: "測試群一（改名）" });
      const again = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(await again.json()).toEqual({ total: 1, created: 0, relabelled: 0 });
      expect(await prisma.whatsappGroup.count()).toBe(1);
    });

    it("N3：用戶手動改過群名（label_locked）→ 同步唔覆蓋；冇改過嘅照更新", async () => {
      const g = await seedGroup({ kind: "office" });
      const r = await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, label: "老闆自訂名" }));
      expect(r.status).toBe(200);
      expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).labelLocked).toBe(true);
      fakeFetch([{ id: "test-g1@g.us", name: "WAHA 新群名" }]);
      const res = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(await res.json()).toEqual({ total: 1, created: 0, relabelled: 0 });
      expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).label).toBe("老闆自訂名");
    });

    it("WAHA 未設定 → 503 waha_not_configured；WAHA 500／連唔到／格式錯 → 502，唔洩漏 URL／key", async () => {
      delete process.env.WAHA_BASE_URL;
      const r0 = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(r0.status).toBe(503);
      expect(((await r0.json()) as { error: string }).error).toBe("waha_not_configured");
      process.env.WAHA_BASE_URL = "http://waha.test:3000";
      fakeFetch({ error: "boom" }, { status: 500 });
      const r1 = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(r1.status).toBe(502);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED http://waha.test:3000 fake-waha-key"); }));
      const r2 = await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"));
      expect(r2.status).toBe(502);
      const txt = JSON.stringify(await r2.json());
      expect(txt).not.toContain("fake-waha-key");
      expect(txt).not.toContain("waha.test");
      fakeFetch({ not: "array" });
      expect((await syncPost(req("/api/whatsapp/groups/sync", cookies["老闆"], "POST"))).status).toBe(502);
      expect(await prisma.whatsappGroup.count()).toBe(0);
    });
  });

  describe("PATCH 綁定", () => {
    it("單盤群綁盤＋口語對照（含大寫 key）＋開自動寫入 → 儲存；audit before/after 白名單", async () => {
      const g = await seedGroup();
      const res = await groupsPatch(
        req("/api/whatsapp/groups", cookies["老闆"], "PATCH", {
          id: g.id,
          kind: "site",
          site_id: fx.site.id,
          shift_word_map: [{ word: "夜班", code: "N" }, { word: "OT", code: "OT" }],
          auto_write: true,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; site_id: string; shift_word_map: { word: string; code: string }[]; auto_write: boolean };
      expect(body).toMatchObject({ kind: "site", site_id: fx.site.id, auto_write: true });
      // jsonb 唔保證 key 次序，所以排序後比較
      expect([...body.shift_word_map].sort((a, b) => a.word.localeCompare(b.word))).toEqual([{ word: "OT", code: "OT" }, { word: "夜班", code: "N" }]);
      const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } });
      expect(row.shiftWordMap).toEqual({ 夜班: "N", OT: "OT" });
      const a = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "whatsapp_groups", action: "update", rowId: g.id } });
      expect(a.actorUserId).toBe(fx.userIds["老闆"]);
      expect(a.before).toMatchObject({ kind: "ignored", site_id: null });
      expect(a.after).toMatchObject({ kind: "site", site_id: fx.site.id, auto_write: true, group_jid: "test-g1@g.us" });
    });

    it("驗證：site 群冇盤、判頭群冇判頭、ignored／office 開自動、auto_confirm 冇 auto_write、盤／判頭唔存在、口語重覆、非法欄 → 400；未知 id → 404", async () => {
      const g = await seedGroup();
      const bad = async (body: Record<string, unknown>, status = 400) => expect((await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, ...body }))).status).toBe(status);
      await bad({ kind: "site" });
      await bad({ kind: "broker" });
      await bad({ auto_write: true }); // 仍然 ignored
      await bad({ kind: "office", auto_write: true });
      await bad({ kind: "multi_site", auto_confirm: true });
      await bad({ kind: "site", site_id: "no-such-site" });
      await bad({ kind: "broker", broker_id: "no-such-broker" });
      await bad({ shift_word_map: [{ word: "夜班", code: "N" }, { word: "夜班", code: "C" }] });
      await bad({ kind: "bogus" });
      await bad({ shift_word_map: [{ word: "", code: "N" }] });
      expect((await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: "nope", active: false }))).status).toBe(404);
      const row = await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } });
      expect(row).toMatchObject({ kind: "ignored", autoWrite: false, siteId: null });
      expect(await prisma.auditLog.count({ where: { tableName: "whatsapp_groups", action: "update", rowId: g.id } })).toBe(0); // audit_log append-only，唔跨 test 清，所以按 row 計
    });

    it("轉類型會清走唔相干嘅舊綁定；判頭群綁判頭", async () => {
      const g = await seedGroup({ kind: "site", siteId: fx.site.id });
      let res = await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, kind: "broker", broker_id: fx.brokerA.id }));
      expect(res.status).toBe(200);
      expect(await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ kind: "broker", siteId: null, brokerId: fx.brokerA.id });
      res = await groupsPatch(req("/api/whatsapp/groups", cookies["老闆"], "PATCH", { id: g.id, kind: "ignored" }));
      expect(res.status).toBe(200);
      expect(await prisma.whatsappGroup.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ kind: "ignored", siteId: null, brokerId: null });
    });

    it("GET 列表帶盤名／判頭代號／未處理數／最後訊息時間", async () => {
      const g = await seedGroup({ kind: "site", siteId: fx.site.id, lastMessageAt: new Date("2026-10-01T00:00:00Z") });
      await prisma.whatsappMessage.createMany({
        data: [
          { session: "default", chatJid: g.groupJid, messageId: "m1", senderJid: "x", ts: new Date(), text: "a", status: "received" },
          { session: "default", chatJid: g.groupJid, messageId: "m2", senderJid: "x", ts: new Date(), text: "b", status: "received" },
          { session: "default", chatJid: g.groupJid, messageId: "m3", senderJid: "x", ts: new Date(), text: "c", status: "done" },
        ],
      });
      const rows = ((await (await groupsGet(req("/api/whatsapp/groups", cookies["老闆"]))).json()) as { rows: Record<string, unknown>[] }).rows;
      expect(rows[0]).toMatchObject({ site_name: fx.site.name, unprocessed_count: 2, last_message_at: "2026-10-01T00:00:00.000Z", broker_code: null });
    });
  });

  describe("訊息清單", () => {
    async function seedMsgs(n: number, over: Record<string, unknown> = {}) {
      const g = await seedGroup();
      await prisma.whatsappMessage.createMany({
        data: Array.from({ length: n }, (_, i) => ({ session: "default", chatJid: g.groupJid, messageId: `msg-${i}-${Math.random()}`, senderJid: "85290000001@c.us", senderTelNorm: "90001234", ts: new Date(Date.now() - i * 1000), text: `原文${i}`, ...over })),
      });
      return g;
    }

    it("take 預設／上限 200；status 篩選；非法 status 400；group 篩選（id 或 jid）", async () => {
      const g = await seedMsgs(205);
      const all = (await (await messagesGet(req("/api/whatsapp/messages", cookies["老闆"]))).json()) as { rows: unknown[]; take: number };
      expect(all.rows.length).toBe(200);
      const few = (await (await messagesGet(req("/api/whatsapp/messages?take=5", cookies["老闆"]))).json()) as { rows: unknown[] };
      expect(few.rows.length).toBe(5);
      const huge = (await (await messagesGet(req("/api/whatsapp/messages?take=99999", cookies["老闆"]))).json()) as { rows: unknown[] };
      expect(huge.rows.length).toBe(200);
      expect(((await (await messagesGet(req("/api/whatsapp/messages?status=error", cookies["老闆"]))).json()) as { rows: unknown[] }).rows.length).toBe(0);
      expect((await messagesGet(req("/api/whatsapp/messages?status=bogus", cookies["老闆"]))).status).toBe(400);
      expect(((await (await messagesGet(req(`/api/whatsapp/messages?group=${g.id}&take=3`, cookies["老闆"]))).json()) as { rows: unknown[] }).rows.length).toBe(3);
      expect(((await (await messagesGet(req(`/api/whatsapp/messages?group=${encodeURIComponent("other@g.us")}`, cookies["老闆"]))).json()) as { rows: unknown[] }).rows.length).toBe(0);
    });

    it("唔回傳原文／message_id／完整電話；冇「安員:view」→ 電話尾 4 位；有 → 保安員姓名；編輯／撤回標示", async () => {
      const g = await seedGroup();
      const guard = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90001234", createdBy: "test" } });
      await prisma.whatsappMessage.create({ data: { session: "default", chatJid: g.groupJid, messageId: "false_x@g.us_ID_85290001234@c.us", senderJid: "85290001234@c.us", senderTelNorm: "90001234", senderGuardId: guard.id, ts: new Date(), text: "機密原文XYZ", revision: 2, editedAt: new Date(), revokedAt: new Date(), status: "revoked", filterScore: 55 } });
      const asOwner = await (await messagesGet(req("/api/whatsapp/messages", cookies["老闆"]))).text();
      expect(asOwner).not.toContain("機密原文XYZ");
      expect(asOwner).not.toContain("85290001234");
      expect(asOwner).not.toContain("90001234");
      expect(asOwner).not.toContain("message_id");
      const o = (JSON.parse(asOwner) as { rows: Record<string, unknown>[] }).rows[0]!;
      expect(o).toMatchObject({ sender: "測試甲", status: "revoked", edited: true, revoked: true, revision: 2, filter_score: 55, group_label: "測試群一", text_len: 7 });
      // 會計出廠有「安員:view」→ 見姓名；老闆收回該格後 → 淨係見電話尾 4 位
      const acc0 = (await (await messagesGet(req("/api/whatsapp/messages", cookies["會計"]))).json()) as { rows: Record<string, unknown>[] };
      expect(acc0.rows[0]!.sender).toBe("測試甲");
      await prisma.rolePermission.updateMany({ where: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: "會計" } })).id, permission: { module: "安員", action: "view" } }, data: { granted: false } });
      const asAcc = (await (await messagesGet(req("/api/whatsapp/messages", cookies["會計"]))).json()) as { rows: Record<string, unknown>[] };
      expect(asAcc.rows[0]!.sender).toBe("…1234");
    });
  });

  describe("health", () => {
    it("未設定 WAHA：waha_configured=false；積壓、24h 錯誤、最後收到時間", async () => {
      delete process.env.WAHA_BASE_URL;
      const g = await seedGroup();
      await prisma.whatsappMessage.createMany({
        data: [
          { session: "default", chatJid: g.groupJid, messageId: "h1", senderJid: "x", ts: new Date(), text: "a", status: "received" },
          { session: "default", chatJid: g.groupJid, messageId: "h2", senderJid: "x", ts: new Date(), text: "a", status: "error", error: "boom" },
        ],
      });
      const h = (await (await healthGet(req("/api/whatsapp/health", cookies["主管"]))).json()) as Record<string, unknown>;
      expect(h).toMatchObject({ waha_configured: false, waha_ok: false, waha_error: "not_configured", backlog: 1, errors_24h: 1, messages_24h: 2 });
      expect(typeof h.last_received_at).toBe("string");
    });

    it("WAHA 有回應：回 session 狀態；連唔到：waha_ok=false 且唔洩漏網址", async () => {
      vi.stubGlobal("fetch", vi.fn(async (u: string) => {
        expect(u).toBe("http://waha.test:3000/api/sessions/default");
        return new Response(JSON.stringify({ name: "default", status: "WORKING" }), { status: 200 });
      }));
      let h = (await (await healthGet(req("/api/whatsapp/health", cookies["老闆"]))).json()) as Record<string, unknown>;
      expect(h).toMatchObject({ waha_configured: true, waha_ok: true, waha_status: "WORKING", waha_error: null });
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("x"); }));
      const res = await healthGet(req("/api/whatsapp/health", cookies["老闆"]));
      h = (await res.json()) as Record<string, unknown>;
      expect(h).toMatchObject({ waha_ok: false, waha_error: "unreachable" });
      expect(JSON.stringify(h)).not.toContain("waha.test");
    });
  });
});
