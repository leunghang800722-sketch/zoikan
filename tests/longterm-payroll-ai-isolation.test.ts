// WP-LTPAY（Opus 5.5 驗收 2026-09-27）：AI 隔離——長工糧六張表（薪金／MPF／
// 平均工資／假期結餘，最嚴 PII）：
//   (1) `ai.*` schema 冇對應 view；`zoikan_ai_ro` 讀 public 表 permission denied。
//   (2) `ai.audit_log` 排除呢六個 table_name（原本冇排除——合約 audit 嘅
//       before/after 有月薪，AI 讀得到；migration
//       20260927190000_wp_ltpay_ai_audit_log_exclude 修正）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { prisma, clearAll } from "./lib/db";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";

const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";
const TABLES = ["guard_longterm_contracts", "guard_leave_balances", "guard_avg_wages", "longterm_payroll_runs", "longterm_payroll_lines", "longterm_payroll_inputs"];

function aiConnectionString(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = AI_RO_ROLE;
  url.password = TEST_AI_PASSWORD;
  return url.toString();
}

describe("WP-LTPAY：AI 隔離（zoikan_ai_ro 真連線）", () => {
  let aiClient: Client;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    aiClient = new Client({ connectionString: aiConnectionString() });
    await aiClient.connect();
  });

  afterAll(async () => {
    await aiClient.end();
    await clearAll();
  });

  it("六張新表：ai.* 唔存在、public.* permission denied", async () => {
    for (const t of TABLES) {
      await expect(aiClient.query(`SELECT * FROM ai.${t} LIMIT 1`)).rejects.toThrow(/does not exist/i);
      await expect(aiClient.query(`SELECT * FROM public.${t} LIMIT 1`)).rejects.toThrow(/permission denied/i);
    }
  });

  it("寫咗合約／人手輸入／重算之後，ai.audit_log 睇唔到呢六個 table_name 嘅行（主連線 public.audit_log 有）", async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-AI隔離", employmentType: "longterm_autopay", hireDate: new Date("2024-01-01"), createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: guard.id, monthlySalary: 15500, effectiveFrom: new Date("2024-01-01"), effectiveTo: null, source: "manual", createdBy: user.id } });
    await prisma.auditLog.create({ data: { actorUserId: user.id, tableName: "guard_longterm_contracts", rowId: guard.id, action: "create", after: { monthlySalary: 15500 } } });
    await recomputeLongtermPayroll(new Date(Date.UTC(2026, 7, 1)), user.id, null);

    const raw = await prisma.auditLog.count({ where: { tableName: { in: TABLES } } });
    expect(raw).toBeGreaterThan(0);
    const ai = await aiClient.query(`SELECT count(*)::int AS n FROM ai.audit_log WHERE table_name = ANY($1)`, [TABLES]);
    expect(ai.rows[0].n).toBe(0);
  });
});
