// WP-MULTI（老闆 2026-09-19 拍板）：AI 隔離——電話／緊急聯絡人／地址
// 三張新表嘅 audit_log 行（before/after 有 tel／name／address）**一定
// 唔可以俾 AI 讀到**。做法（同 D 項要求一致）：
//   (1) `ai.*` schema 本身冇 `ai.guard_phones`／`ai.guard_emergency_
//       contacts`／`ai.guard_addresses` 三個 view——結構性連張表都接觸
//       唔到。
//   (2) `ai.audit_log` view 加 `WHERE table_name NOT IN (...)` 排除呢三
//       個 table_name（第二層 defense-in-depth，見
//       prisma/migrations/20260919154450_wp_multi_phones_contacts_addresses）。
// 呢個測試檔案同 tests/wp-pii-ai-audit-log-view-structural.test.ts／
// tests/ai-ro-connection.test.ts 一致手法：一半查 view 定義文字
// （structural，唔靠跑一條查詢睇個 row 冇嗰粒 key 呢種間接斷言），一半
// 用真 `zoikan_ai_ro` 連線實測（攻擊測試）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { prisma } from "./lib/db";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as phoneCreate } from "@/app/api/guards/[id]/phones/route";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";

const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";

function aiConnectionString(): string {
  const mainUrl = new URL(process.env.DATABASE_URL!);
  const url = new URL(mainUrl.toString());
  url.username = AI_RO_ROLE;
  url.password = TEST_AI_PASSWORD;
  return url.toString();
}

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

async function auditLogViewDef(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
  return rows[0]?.viewdef ?? "";
}

describe("WP-MULTI：AI 隔離——結構性測試", () => {
  it("ai schema 完全冇 guard_phones／guard_emergency_contacts／guard_addresses 呢三個 view（或者任何表）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has("guard_phones")).toBe(false);
    expect(names.has("guard_emergency_contacts")).toBe(false);
    expect(names.has("guard_addresses")).toBe(false);
  });

  it("ai.audit_log view 定義文字有 WHERE table_name NOT IN 排除呢三個 table_name", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toMatch(/table_name\s*(<>|!=|NOT IN)/i);
    expect(viewdef).toContain("guard_phones");
    expect(viewdef).toContain("guard_emergency_contacts");
    expect(viewdef).toContain("guard_addresses");
  });

  it("ai.audit_log 仍然保留返 WP-PII 嗰 scrub_json blocked_keys（呢個 migration 冇手多多改壞）", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toContain("hkid");
    expect(viewdef).toContain("bank_account_no");
  });
});

describe("WP-MULTI：AI 隔離——zoikan_ai_ro 真連線攻擊測試", () => {
  let aiClient: Client;
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    aiClient = new Client({ connectionString: aiConnectionString() });
    await aiClient.connect();
  });

  afterAll(async () => {
    await aiClient.end();
  });

  it("SELECT ai.guard_phones / ai.guard_emergency_contacts / ai.guard_addresses 全部 relation does not exist", async () => {
    await expect(aiClient.query("SELECT * FROM ai.guard_phones LIMIT 1")).rejects.toThrow(/does not exist/i);
    await expect(aiClient.query("SELECT * FROM ai.guard_emergency_contacts LIMIT 1")).rejects.toThrow(/does not exist/i);
    await expect(aiClient.query("SELECT * FROM ai.guard_addresses LIMIT 1")).rejects.toThrow(/does not exist/i);
  });

  it("SELECT public.guard_phones（試圖繞過 ai schema 直接querypublic）一樣 permission denied", async () => {
    await expect(aiClient.query("SELECT * FROM public.guard_phones LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("寫入一行電話 audit_log 之後，ai.audit_log SELECT * 一定睇唔到呢一行（table_name='guard_phones' 已經俾 WHERE 排除）", async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69700001", note: "呢段文字唔應該俾AI讀到" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    // public.audit_log 本身（用主連線）真係有呢一行——confirm 寫咗，唔係
    // 斷言方向錯咗（呢個一行本身係內部審計用，寫入本身係啱嘅）。
    const rawRow = await prisma.auditLog.findFirst({ where: { tableName: "guard_phones", rowId: created.id, action: "create" } });
    expect(rawRow).not.toBeNull();

    // 但 ai.audit_log（AI 助手 `recent_audit`/`sql_select` 用嗰個 view）
    // 一定搵唔到呢一行。
    const aiRows = await aiClient.query("SELECT * FROM ai.audit_log WHERE table_name = 'guard_phones'");
    expect(aiRows.rows.length).toBe(0);

    // 保險：query 埋另外兩個新 table_name，都要係 0 行。
    const aiRows2 = await aiClient.query("SELECT * FROM ai.audit_log WHERE table_name IN ('guard_emergency_contacts', 'guard_addresses')");
    expect(aiRows2.rows.length).toBe(0);
  });
});
