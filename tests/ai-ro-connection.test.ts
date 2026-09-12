// WP-AI1 第 1 點：真 DB 攻擊測試——AI 助手嘅唯讀連線（`zoikan_ai_ro`）
// 一定唔可以寫入，亦一定睇唔到 public schema 任何嘢（包括 public.users）。
// 呢個 test file 用緊 tests/global-setup.ts 起嗰個臨時 embedded-postgres
// （同其他 *.test.ts 共用同一個 DB 實例，fileParallelism:false）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";

const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";

function aiConnectionString(): string {
  const mainUrl = new URL(process.env.DATABASE_URL!);
  const url = new URL(mainUrl.toString());
  url.username = AI_RO_ROLE;
  url.password = TEST_AI_PASSWORD;
  return url.toString();
}

describe("WP-AI1 §1：AI 唯讀連線真 DB 攻擊測試", () => {
  let aiClient: Client;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    aiClient = new Client({ connectionString: aiConnectionString() });
    await aiClient.connect();
  });

  afterAll(async () => {
    await aiClient.end();
  });

  it("角色建立幂等：再執行一次 ensureAiRole 唔會報錯", async () => {
    await expect(ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD })).resolves.toBeUndefined();
  });

  it("SELECT ai.sites 正常", async () => {
    const r = await aiClient.query("SELECT * FROM ai.sites LIMIT 1");
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("SELECT ai.shift_types / ai.brokers / ai.guards / ai.shift_records / ai.daily_requirements / ai.quotas / ai.rate_cards / ai.referral_fee_rates / ai.special_items / ai.month_closes / ai.broker_site_assignments / ai.audit_log / ai.users 全部 SELECT 得到", async () => {
    const views = [
      "ai.shift_types",
      "ai.brokers",
      "ai.guards",
      "ai.shift_records",
      "ai.daily_requirements",
      "ai.quotas",
      "ai.rate_cards",
      "ai.referral_fee_rates",
      "ai.special_items",
      "ai.month_closes",
      "ai.broker_site_assignments",
      "ai.audit_log",
      "ai.users",
    ];
    for (const v of views) {
      await expect(aiClient.query(`SELECT * FROM ${v} LIMIT 1`)).resolves.toBeDefined();
    }
  });

  it("ai.guards 冇 tel 欄", async () => {
    const r = await aiClient.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='ai' AND table_name='guards'",
    );
    const cols = r.rows.map((row) => row.column_name);
    expect(cols).not.toContain("tel");
  });

  it("ai.brokers 冇 bank_info 欄", async () => {
    const r = await aiClient.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='ai' AND table_name='brokers'",
    );
    const cols = r.rows.map((row) => row.column_name);
    expect(cols).not.toContain("bank_info");
  });

  it("ai.users 淨係 id/name/role_id/role_name/status，冇 tel/password_hash/otp_secret", async () => {
    const r = await aiClient.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='ai' AND table_name='users'",
    );
    const cols = r.rows.map((row) => row.column_name).sort();
    expect(cols).toEqual(["id", "name", "role_id", "role_name", "status"].sort());
  });

  it("UPDATE ai.sites 拒絕", async () => {
    await expect(aiClient.query("UPDATE ai.sites SET client_name = 'x'")).rejects.toThrow(/permission denied/i);
  });

  it("INSERT INTO ai.sites 拒絕", async () => {
    await expect(aiClient.query("INSERT INTO ai.sites DEFAULT VALUES")).rejects.toThrow(/permission denied/i);
  });

  it("DELETE FROM ai.sites 拒絕", async () => {
    await expect(aiClient.query("DELETE FROM ai.sites")).rejects.toThrow(/permission denied/i);
  });

  it("CREATE TABLE ai.foo 拒絕（read-only transaction）", async () => {
    await expect(aiClient.query("CREATE TABLE ai.foo (id int)")).rejects.toThrow(/read-only transaction/i);
  });

  it("SELECT ... FOR UPDATE 拒絕", async () => {
    await expect(aiClient.query("SELECT * FROM ai.sites FOR UPDATE")).rejects.toThrow(/permission denied/i);
  });

  it("SET ROLE postgres 拒絕", async () => {
    await expect(aiClient.query("SET ROLE postgres")).rejects.toThrow(/permission denied/i);
  });

  it("RESET ROLE 之後再 UPDATE 都拒絕（RESET ROLE 冇提升返權限）", async () => {
    await aiClient.query("RESET ROLE"); // 呢個本身係 no-op（本來就冇 SET ROLE 過），唔會報錯
    await expect(aiClient.query("UPDATE ai.sites SET client_name = 'x'")).rejects.toThrow(/permission denied/i);
  });

  it("存取 public.users 拒絕", async () => {
    await expect(aiClient.query("SELECT * FROM public.users LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("存取 public.sites 拒絕（唯讀角色淨係有 ai schema 權，冇 public）", async () => {
    await expect(aiClient.query("SELECT * FROM public.sites LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("default_transaction_read_only 係 on", async () => {
    const r = await aiClient.query("SELECT current_setting('transaction_read_only') AS v");
    expect(r.rows[0]!.v).toBe("on");
  });

  it("search_path 係 ai", async () => {
    const r = await aiClient.query("SHOW search_path");
    expect(r.rows[0]!.search_path).toBe("ai");
  });
});
