// WP-ONE-CLICK-AUTO：新表 month_close_auto_changes 嘅 AI 隔離＋migration 規矩（只加新、冪等、冇
// gen_random_uuid()／RAISE、新表唔入 ai schema、ai.audit_log 排除清單跟足，舊排除項唔走樣）。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { prisma } from "./lib/db";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";

const MIGRATION = path.resolve(process.cwd(), "prisma/migrations/20261008120000_wp_one_click_auto/migration.sql");
const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";

describe("WP-ONE-CLICK-AUTO：migration 規矩", () => {
  const sql = fs.readFileSync(MIGRATION, "utf-8");
  it("冇 gen_random_uuid()／RAISE／DROP／DELETE，淨係新增（CREATE ... IF NOT EXISTS／CREATE OR REPLACE VIEW）", () => {
    expect(sql).not.toMatch(/gen_random_uuid/i);
    expect(sql).not.toMatch(/\bRAISE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "month_close_auto_changes"/);
    expect(sql).not.toMatch(/\bai\.month_close_auto_changes\b/);
  });

  it("重跑一次冪等（唔報錯，表同 view 仍然正常）", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
      await client.query(sql);
      // P6.4：重跑舊 migration 會把 ai.audit_log 退回舊（黑名單）定義——跟住補跑後來嘅
      // 白名單 migration，令共用測試庫回到正式定義，唔污染同一 run 入面其他測試。
      await client.query(fs.readFileSync(path.resolve(process.cwd(), "prisma/migrations/20261011120000_p6_ai_audit_log_whitelist/migration.sql"), "utf8"));
    } finally {
      await client.end();
    }
    const n = await prisma.monthCloseAutoChange.count();
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe("WP-ONE-CLICK-AUTO：AI 隔離", () => {
  it("ai schema 冇 month_close_auto_changes；ai.audit_log 排除佢，舊排除項（triage／month_close_runs／roster_uploads）唔走樣", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`);
    expect(rows.map((r) => r.table_name)).not.toContain("month_close_auto_changes");
    const [{ viewdef }] = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
    for (const t of ["month_close_auto_changes", "month_close_runs", "triage_sessions", "triage_questions", "roster_uploads", "guard_fix_runs", "guard_identity_conflicts", "longterm_payroll_runs"]) expect(viewdef).toContain(`'${t}'`);
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
    it("讀 public.month_close_auto_changes／triage_questions 都 permission denied", async () => {
      await expect(aiClient.query("SELECT * FROM public.month_close_auto_changes LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(aiClient.query("SELECT * FROM public.triage_questions LIMIT 1")).rejects.toThrow(/permission denied/i);
      await expect(aiClient.query("SELECT * FROM ai.month_close_auto_changes LIMIT 1")).rejects.toThrow(/does not exist/i);
    });
  });
});
