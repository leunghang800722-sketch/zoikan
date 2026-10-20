// W0：保留期 job、禁用發送類 API 字串掃描、migration 規矩＋AI 隔離、純函數（verify／schema／waha）、middleware CSRF 對 webhook 嘅影響、RBAC 矩陣。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { prisma, clearAll } from "./lib/db";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { runWhatsappRetention, whatsappRetentionJob } from "@/lib/jobs/whatsapp-retention";
import { JOBS } from "@/lib/jobs/registry";
import { isValidCron } from "@/lib/scheduler/cron";
import { computeHmacHex, safeEqualStr, verifyWebhook } from "@/lib/whatsapp/verify";
import { WebhookEnvelopeSchema, normalizeEvent, parseTimestamp, telFromJid, isGroupJid } from "@/lib/whatsapp/schema";
import { parseGroups, isGroupsShape } from "@/lib/whatsapp/waha";
import { ignoreReasonFor } from "@/lib/whatsapp/ingest";
import { middleware } from "@/middleware";
import { DEFAULT_MATRIX, MODULES, ROLE_NAMES } from "@/lib/rbac/matrix";

const ROOT = process.cwd();
const MIGRATION = path.join(ROOT, "prisma/migrations/20261018000000_wa_w0_whatsapp_infra/migration.sql");
const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("W0 保留期 job", () => {
  beforeEach(clearAll);
  it("90 日前嘅 text／text_history 置空＋redacted_at；90 日內、已 redacted 唔掂；只計數；冪等", async () => {
    const now = new Date("2026-10-17T03:00:00Z");
    const d = (days: number) => new Date(now.getTime() - days * 86400000);
    const mk = (id: string, days: number, extra: Record<string, unknown> = {}) => ({ session: "default", chatJid: "test-g1@g.us", messageId: id, senderJid: "x", ts: d(days), text: `原文-${id}`, textHistory: [{ revision: 1, text: "舊" }], status: "done" as const, parsedJson: { keep: true }, ...extra });
    await prisma.whatsappMessage.createMany({ data: [mk("old1", 91), mk("old2", 200), mk("new1", 89), mk("done0", 120, { redactedAt: d(10), text: "" })] });
    const r = await runWhatsappRetention(now);
    expect(r).toEqual({ status: "ok", summary: { redacted: 2, retention_days: 90 } });
    const rows = Object.fromEntries((await prisma.whatsappMessage.findMany()).map((m) => [m.messageId, m]));
    for (const id of ["old1", "old2"]) {
      expect(rows[id]).toMatchObject({ text: "", textHistory: [], parsedJson: null, status: "done" }); // W1：parsed_json 含 LLM 抽出嘅原話片段，一併清走（原本斷言為保留）
      expect(rows[id]!.redactedAt?.getTime()).toBe(now.getTime());
    }
    expect(rows["new1"]).toMatchObject({ text: "原文-new1", redactedAt: null, parsedJson: { keep: true } });
    expect(rows["done0"]!.redactedAt?.getTime()).toBe(d(10).getTime());
    const again = await runWhatsappRetention(now);
    expect(again).toEqual({ status: "skipped", summary: { redacted: 0, retention_days: 90 } });
  });

  it("已登記入 JOBS、每日 03:00、cron 合法", () => {
    expect(JOBS).toContain(whatsappRetentionJob);
    expect(whatsappRetentionJob.defaultSchedule).toBe("0 3 * * *");
    expect(isValidCron(whatsappRetentionJob.defaultSchedule)).toBe(true);
  });
});

describe("W0 鐵律：src/lib/whatsapp／webhook／api/whatsapp 冇任何發送類 API", () => {
  const FORBIDDEN = /sendText|sendSeen|startTyping|presence|sendImage/i;
  const dirs = ["src/lib/whatsapp", "src/app/api/webhooks/whatsapp", "src/app/api/whatsapp", "src/app/(app)/whatsapp"].map((d) => path.join(ROOT, d));
  it("掃描全部檔案（含註解）不得出現禁用字串", () => {
    const files = dirs.flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(8);
    const hits = files.filter((f) => FORBIDDEN.test(fs.readFileSync(f, "utf-8"))).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
  it("WAHA client 只用 GET", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/whatsapp/waha.ts"), "utf-8");
    const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
    expect(methods).toEqual(["GET"]);
    expect(src).not.toMatch(/\.(post|put|patch|delete)\(/i);
  });
  it("webhook route 唔經 session／RBAC（獨立保護）", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/app/api/webhooks/whatsapp/route.ts"), "utf-8");
    expect(src).not.toMatch(/requirePermission|requireSession|getSessionFromRequest/);
  });
});

describe("W0 migration 規矩＋AI 隔離", () => {
  const sql = fs.readFileSync(MIGRATION, "utf-8");
  it("只加（冇 gen_random_uuid／RAISE／DROP／DELETE／TRUNCATE／ALTER … DROP）、冇寫死 id、新表唔入 ai schema", () => {
    expect(sql).not.toMatch(/gen_random_uuid/i);
    expect(sql).not.toMatch(/\bRAISE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    for (const t of ["whatsapp_groups", "whatsapp_messages", "whatsapp_intents"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`));
      expect(sql).not.toMatch(new RegExp(`\\bai\\.${t}\\b`));
    }
  });
  it("W0.2 migration：只加兩個欄、冪等", async () => {
    const sql2 = fs.readFileSync(path.join(ROOT, "prisma/migrations/20261018010000_wa_w0_2_pending_edit_label_lock/migration.sql"), "utf-8");
    expect(sql2).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|gen_random_uuid|\bRAISE\b/i);
    expect(sql2).toMatch(/ADD COLUMN IF NOT EXISTS "pending_edit"/);
    expect(sql2).toMatch(/ADD COLUMN IF NOT EXISTS "label_locked"/);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql2);
      await client.query(sql2);
    } finally {
      await client.end();
    }
  });
  it("重跑一次冪等（表同 view 正常）", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
      await client.query(sql);
    } finally {
      await client.end();
    }
    expect(await prisma.whatsappGroup.count()).toBeGreaterThanOrEqual(0);
  });
  it("ai schema 冇三表；ai.audit_log 排除三表，舊排除項唔走樣", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`);
    for (const t of ["whatsapp_groups", "whatsapp_messages", "whatsapp_intents"]) expect(rows.map((r) => r.table_name)).not.toContain(t);
    const [{ viewdef }] = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
    for (const t of ["whatsapp_groups", "whatsapp_messages", "whatsapp_intents", "month_close_auto_changes", "triage_sessions", "triage_questions", "roster_uploads", "guard_fix_runs", "longterm_payroll_runs"]) expect(viewdef).toContain(`'${t}'`);
    for (const k of ["hkid", "bank_account_no", "password_hash"]) expect(viewdef).toContain(k);
  });
  describe("zoikan_ai_ro 真連線", () => {
    let aiClient: Client;
    beforeAll(async () => {
      await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
      const url = new URL(process.env.DATABASE_URL!);
      url.username = AI_RO_ROLE;
      url.password = TEST_AI_PASSWORD;
      aiClient = new Client({ connectionString: url.toString() });
      await aiClient.connect();
    });
    afterAll(async () => {
      await aiClient.end();
    });
    it("讀 public.whatsapp_* 都 permission denied；ai.whatsapp_* 唔存在；寫 audit 嘅 whatsapp_groups 行睇唔到", async () => {
      for (const t of ["whatsapp_groups", "whatsapp_messages", "whatsapp_intents"]) {
        await expect(aiClient.query(`SELECT * FROM public.${t} LIMIT 1`)).rejects.toThrow(/permission denied/i);
        await expect(aiClient.query(`SELECT * FROM ai.${t} LIMIT 1`)).rejects.toThrow(/does not exist/i);
      }
      const admin = await prisma.user.findFirstOrThrow();
      await prisma.auditLog.create({ data: { actorUserId: admin.id, tableName: "whatsapp_groups", rowId: "ai-iso-probe", action: "update", before: {}, after: { kind: "site" } } });
      const r = await aiClient.query(`SELECT count(*)::int AS n FROM ai.audit_log WHERE table_name LIKE 'whatsapp%'`);
      expect(r.rows[0].n).toBe(0);
    });
  });
});

describe("W0 純函數", () => {
  it("verifyWebhook：對／錯／缺 key／缺 secret／算法", () => {
    const raw = Buffer.from('{"a":1}');
    const base = { rawBody: raw, algoHeader: "sha512", hookHeader: "S", hmacKey: "K", headerSecret: "S", hmacHeader: computeHmacHex(raw, "K") };
    expect(verifyWebhook(base)).toEqual({ ok: true });
    expect(verifyWebhook({ ...base, hmacHeader: base.hmacHeader.toUpperCase() })).toEqual({ ok: true }); // hex 大小寫唔敏感
    expect(verifyWebhook({ ...base, hmacHeader: null })).toMatchObject({ ok: false, reason: "bad_hmac" });
    expect(verifyWebhook({ ...base, hookHeader: "x" })).toMatchObject({ ok: false, reason: "bad_header" });
    expect(verifyWebhook({ ...base, hmacKey: "" })).toMatchObject({ ok: false, reason: "no_key" });
    expect(verifyWebhook({ ...base, headerSecret: "" })).toMatchObject({ ok: false, reason: "no_secret" });
    expect(verifyWebhook({ ...base, algoHeader: "sha256" })).toMatchObject({ ok: false, reason: "bad_algo" });
    expect(verifyWebhook({ ...base, rawBody: Buffer.from('{"a":2}') })).toMatchObject({ ok: false, reason: "bad_hmac" });
    expect(safeEqualStr("a", "a")).toBe(true);
    expect(safeEqualStr("a", "ab")).toBe(false);
  });

  it("schema／normalize：時間戳、jid、媒體、edited／revoked 目標 id", () => {
    expect(parseTimestamp(1760000000)?.getTime()).toBe(1760000000000);
    expect(parseTimestamp(1760000000000)?.getTime()).toBe(1760000000000);
    expect(parseTimestamp("1760000000")?.getTime()).toBe(1760000000000);
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(-5)).toBeNull();
    expect(telFromJid("85290000001@c.us")).toBe("90000001");
    expect(telFromJid("8613800138000@s.whatsapp.net")).toBe("+8613800138000");
    expect(telFromJid("1234567890@lid")).toBeNull();
    expect(isGroupJid("a@g.us")).toBe(true);
    expect(isGroupJid("a@c.us")).toBe(false);
    const env = WebhookEnvelopeSchema.parse({ event: "message.edited", payload: { id: "e1", editedMessageId: "orig", from: "g@g.us", body: "new", _data: { key: { participant: "85290000001@c.us" } } } });
    const ev = normalizeEvent("edited", env)!;
    expect(ev).toMatchObject({ messageId: "orig", chatJid: "g@g.us", senderJid: "85290000001@c.us", text: "new", fromMe: false });
    expect(WebhookEnvelopeSchema.safeParse({ event: "message", payload: { fromMe: "x" } }).success).toBe(false);
    expect(normalizeEvent("message", WebhookEnvelopeSchema.parse({ event: "message", payload: { from: "g@g.us" } }))).toBeNull();
  });

  it("ignoreReasonFor：優先次序 not_group > from_me > stale > future_ts", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const g = { chatJid: "g@g.us", fromMe: false };
    expect(ignoreReasonFor(g, now, now)).toBeNull();
    expect(ignoreReasonFor({ chatJid: "x@c.us", fromMe: true }, new Date(0), now)).toBe("not_group");
    expect(ignoreReasonFor({ ...g, fromMe: true }, new Date(0), now)).toBe("from_me");
    expect(ignoreReasonFor(g, null, now)).toBe("no_timestamp");
    expect(ignoreReasonFor(g, new Date(now.getTime() - 72 * 3600e3 - 1), now)).toBe("stale");
    expect(ignoreReasonFor(g, new Date(now.getTime() - 72 * 3600e3), now)).toBeNull();
    expect(ignoreReasonFor(g, new Date(now.getTime() + 10 * 60e3 + 1), now)).toBe("future_ts");
    expect(ignoreReasonFor(g, new Date(now.getTime() + 10 * 60e3), now)).toBeNull();
  });

  it("parseGroups：容忍 id 字串／{_serialized}、subject、{groups:[]}；過濾非群、去重；唔取成員", () => {
    expect(parseGroups([{ id: "a@g.us", name: "甲", participants: [{ id: "85290000001@c.us" }] }, { id: { _serialized: "b@g.us" }, subject: "乙" }, { id: "c@c.us", name: "非群" }, { id: "a@g.us", name: "重覆" }, null, 5])).toEqual([
      { jid: "a@g.us", name: "甲" },
      { jid: "b@g.us", name: "乙" },
    ]);
    expect(parseGroups({ groups: [{ id: "z@g.us" }] })).toEqual([{ jid: "z@g.us", name: "" }]);
    expect(parseGroups("nope")).toEqual([]);
    // WA-6：以 jid 為 key 嘅 object map（value 內 subject／name；id 可缺；非群 key 過濾）
    expect(parseGroups({ "x@g.us": { subject: "甲群" }, "y@g.us": { name: "乙群", id: "y@g.us" }, "z@g.us": {}, "p@c.us": { subject: "私" } })).toEqual([
      { jid: "x@g.us", name: "甲群" },
      { jid: "y@g.us", name: "乙群" },
      { jid: "z@g.us", name: "" },
    ]);
    expect(parseGroups({})).toEqual([]);
    expect(parseGroups({ not: "array" })).toEqual([]);
    expect(isGroupsShape({})).toBe(true);
    expect(isGroupsShape({ "x@g.us": {} })).toBe(true);
    expect(isGroupsShape({ not: "array" })).toBe(false);
  });
});

describe("W0 middleware（CSRF）對 webhook 嘅影響", () => {
  it("server-to-server POST（冇 Sec-Fetch-Site／Origin）放行；瀏覽器跨站 POST 照被擋；matcher 涵蓋 /api/*", () => {
    const ok = middleware(new NextRequest("http://test.local/api/webhooks/whatsapp", { method: "POST", headers: { "x-webhook-hmac": "x" } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    const cross = middleware(new NextRequest("http://test.local/api/webhooks/whatsapp", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(cross.status).toBe(403);
  });
});

describe("W0 RBAC 矩陣", () => {
  it("module「WhatsApp 報更」已登記；老闆 view＋update；會計／主管 view only；雞頭／安員全部硬性拒", () => {
    expect(MODULES).toContain("WhatsApp 報更");
    const m = "WhatsApp 報更" as const;
    expect(DEFAULT_MATRIX["老闆"][m]).toMatchObject({ view: "grant", update: "grant" });
    for (const r of ["會計", "主管"] as const) {
      expect(DEFAULT_MATRIX[r][m].view).toBe("grant");
      expect(DEFAULT_MATRIX[r][m].update).toBe("deny");
      expect(DEFAULT_MATRIX[r][m].create).toBe("deny");
    }
    for (const r of ["雞頭", "安員"] as const) for (const a of Object.values(DEFAULT_MATRIX[r][m])) expect(a).toBe("deny");
    expect(ROLE_NAMES.length).toBe(5);
  });
});
