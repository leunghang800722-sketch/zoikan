// P6.4 / H9：ai.audit_log 白名單式 view；ai_chat audit 唔存問題原文（長度＋hash）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as chatPOST } from "@/app/api/ai/chat/route";
import { aiQuery } from "@/lib/ai/db";
import { setLlmClientForTests } from "@/lib/ai/llm";

const WHITELIST = [
  "sites", "shift_types", "brokers", "broker_site_assignments", "guards", "shift_records",
  "daily_requirements", "quotas", "rate_cards", "referral_fee_rates", "special_items", "month_closes",
];
const MUST_NOT_APPEAR = [
  "ai_chat", "ai_feedback_chat", "guard_staff_numbers", "guard_ocr", "guard_import", "users", "roles", "role_permissions",
  "ai_action_requests", "some_future_table_with_pii", "guard_phones", "roster_uploads", "postorder_uploads",
];

describe("P6.4 / H9：ai.audit_log 白名單", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    setLlmClientForTests({ chat: async (p) => (p.onTextDelta?.("好"), { text: "好", toolsUsed: [], inputTokens: 1, outputTokens: 1 }) });
  });
  afterEach(() => setLlmClientForTests(undefined));

  it("view 定義用 IN 白名單（12 張業務表），冇黑名單漏網嘅表", async () => {
    const [{ viewdef }] = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
    expect(viewdef).toMatch(/table_name\s*=\s*ANY|table_name\s+IN/i);
    for (const t of WHITELIST) expect(viewdef).toContain(`'${t}'`);
    for (const t of ["ai_chat", "guard_staff_numbers", "guard_ocr", "guard_import", "ai_feedback_chat"]) {
      expect(viewdef).not.toContain(`'${t}'`);
    }
  });

  it("寫入白名單內外各種 table_name 嘅 audit：AI 只睇到白名單內嘅", async () => {
    const owner = fx.userIds["老闆"];
    for (const t of [...WHITELIST, ...MUST_NOT_APPEAR]) {
      await prisma.auditLog.create({ data: { actorUserId: owner, tableName: t, rowId: "p6-h9", action: "update", after: { marker: "p6-h9" } } });
    }
    const { rows } = await aiQuery(`SELECT DISTINCT table_name FROM ai.audit_log WHERE row_id = 'p6-h9'`);
    const seen = rows.map((r) => String((r as { table_name: string }).table_name)).sort();
    expect(seen).toEqual([...WHITELIST].sort());
  });

  it("ai_chat 問題原文唔入 audit：只存長度＋SHA-256 前 16 位", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const question = "測試保安員甲 嘅工號 T-A01 點解 7 月出糧少咗？";
    const res = await chatPOST(new Request("http://test.local/api/ai/chat", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: question }) }));
    expect(res.status).toBe(200);
    await res.text();
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "ai_chat", action: "ai_chat" }, orderBy: { createdAt: "desc" } });
    const after = row.after as Record<string, unknown>;
    expect(after.question).toBeUndefined();
    expect(after.question_length).toBe(question.length);
    expect(after.question_sha256_16).toBe(createHash("sha256").update(question).digest("hex").slice(0, 16));
    expect(JSON.stringify(row.after)).not.toContain("T-A01");
    // 同時 AI 隔離 view 睇唔到 ai_chat 呢行
    const { rows } = await aiQuery(`SELECT id FROM ai.audit_log WHERE table_name = 'ai_chat'`);
    expect(rows).toHaveLength(0);
  });
});
