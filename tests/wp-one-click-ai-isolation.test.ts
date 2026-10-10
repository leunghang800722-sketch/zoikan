// WP-ONE-CLICK Phase 1：AI 隔離——`month_close_runs`（`steps_json`／
// `report_json` 冇 PII，但係財務結算流程控制表，同「保安員配對修復」一致
// 粒度，唔開俾 AI 助手直接查）。做法同 WP-ROSTER-UPLOAD／WP-GUARD-FIX-UI
// 一致：
//   (1) `ai.*` schema 完全冇 `ai.month_close_runs` view——結構性接觸唔到。
//   (2) `ai.audit_log` view WHERE 子句排除呢個 table_name（第二層
//       defense-in-depth，見 prisma/migrations/
//       20260927150000_wp_one_click_month_close_runs）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { runOneClickMonthClose } from "@/lib/month-close/one-click";

const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";
const SEPT = new Date(Date.UTC(2026, 8, 1));

function aiConnectionString(): string {
  const mainUrl = new URL(process.env.DATABASE_URL!);
  const url = new URL(mainUrl.toString());
  url.username = AI_RO_ROLE;
  url.password = TEST_AI_PASSWORD;
  return url.toString();
}

async function auditLogViewDef(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
  return rows[0]?.viewdef ?? "";
}

describe("WP-ONE-CLICK：AI 隔離——結構性測試", () => {
  it("ai schema 完全冇 month_close_runs 呢個 view（或者任何表）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`);
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has("month_close_runs")).toBe(false);
  });

  it("ai.audit_log view 定義文字有 WHERE table_name NOT IN 排除 month_close_runs，同埋冇手多多改壞舊嘅排除清單", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toMatch(/table_name\s*(<>|!=|NOT IN)/i);
    expect(viewdef).toContain("month_close_runs");
    expect(viewdef).toContain("roster_uploads");
    expect(viewdef).toContain("guard_fix_runs");
    expect(viewdef).toContain("hkid");
  });

  it("SELECT ai.month_close_runs 撞唔到（唔存在）", async () => {
    await expect(prisma.$queryRawUnsafe("SELECT * FROM ai.month_close_runs LIMIT 1")).rejects.toThrow(/does not exist/i);
  });
});

describe("WP-ONE-CLICK：AI 隔離——zoikan_ai_ro 真連線攻擊測試", () => {
  let aiClient: Client;
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    aiClient = new Client({ connectionString: aiConnectionString() });
    await aiClient.connect();
  });

  afterAll(async () => {
    await aiClient.end();
  });

  it("SELECT ai.month_close_runs 一定 does not exist；public.month_close_runs 一定 permission denied", async () => {
    await expect(aiClient.query("SELECT * FROM ai.month_close_runs LIMIT 1")).rejects.toThrow(/does not exist/i);
    await expect(aiClient.query("SELECT * FROM public.month_close_runs LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("跑一次 one-click job 之後，ai.audit_log SELECT * 一定睇唔到 table_name='month_close_runs' 嗰啲行", async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    // 上月（8 月）鎖定，等 step0 唔會即刻停低。
    await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });

    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    await runOneClickMonthClose(run.id, SEPT, fx.userIds["老闆"], null);

    // public.audit_log 本身（主連線）真係有 month_close_runs 嘅 create/update 行——confirm 寫咗。
    const rawRows = await prisma.auditLog.findMany({ where: { tableName: "month_close_runs", rowId: run.id } });
    expect(rawRows.length).toBeGreaterThan(0);

    // ai.audit_log 一定搵唔到呢啲行。
    const aiRows = await aiClient.query("SELECT * FROM ai.audit_log WHERE table_name = 'month_close_runs'");
    expect(aiRows.rows.length).toBe(0);
  });
});
