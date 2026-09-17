// P2.5「現場反映」開會模式——`list_feedback` 工具：淨係老闆掛載、內容
// 過電話 pattern scrub。
import { describe, it, expect, beforeAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildAiTools } from "@/lib/ai/tools";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { AiToolContext } from "@/lib/ai/tools/common";

function sessionFor(role: "老闆" | "主管" | "會計", userId: string): AuthedSession {
  return {
    userId,
    tel: "90000000",
    name: "測試",
    roleId: "role-1",
    roleName: role,
    baseRole: role,
    brokerId: null,
    guardId: null,
    payoutApprovalLimit: null,
    tokenVersion: 1,
    loggedInAt: new Date().toISOString(),
  };
}

describe("P2.5：list_feedback 工具", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();

    const session = await prisma.feedbackSession.create({ data: { userId: fx.userIds["會計"], status: "submitted", messages: [] } });
    await prisma.feedbackReport.create({
      data: {
        sessionId: session.id,
        userId: fx.userIds["會計"],
        roleName: "會計",
        title: "測試意見（有電話 91234567）",
        summaryMd: "# 標題\n\n聯絡電話 91234567，唔該幫手。",
        fields: { title: "測試" },
        transcriptExcerpt: [],
        status: "new",
      },
    });
  });

  it("主管 session：buildAiTools() 冇 list_feedback（唔掛載）", () => {
    const ctx: AiToolContext = {
      session: sessionFor("主管", fx.userIds["主管"]),
      fieldVisibility: { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true },
    };
    const tools = buildAiTools(ctx);
    expect(tools.map((t) => (t as unknown as { name: string }).name)).not.toContain("list_feedback");
  });

  it("老闆 session：list_feedback 查到，電話已經被 scrub 走", async () => {
    const ctx: AiToolContext = {
      session: sessionFor("老闆", fx.userIds["老闆"]),
      fieldVisibility: { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true },
    };
    const tools = buildAiTools(ctx);
    const tool = tools.find((t) => (t as unknown as { name: string }).name === "list_feedback") as unknown as {
      run: (args: unknown) => Promise<string>;
    };
    expect(tool).toBeTruthy();
    const raw = await tool.run({});
    const parsed = JSON.parse(raw) as { count: number; reports: Array<{ title: string; summary: string }> };
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    const found = parsed.reports.find((r) => r.title.includes("測試意見"));
    expect(found).toBeTruthy();
    expect(found!.title).not.toContain("91234567");
    expect(found!.summary).not.toContain("91234567");
    expect(found!.title).toContain("[已隱藏電話]");
  });

  it("defense-in-depth：即使人為擺一個 baseRole!='老闆' 嘅 ctx 直接 call `.run()`，都會拒絕（唔靠掛載邏輯單一防線）", async () => {
    const ctx: AiToolContext = {
      session: sessionFor("會計", fx.userIds["會計"]),
      fieldVisibility: { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true },
    };
    // 呢度刻意唔經 buildAiTools()（本身已經唔會幫會計掛載），直接 import
    // 個 builder 出嚟模擬「萬一邊度改壞咗令呢個工具都被掛載」嘅情景。
    const { createListFeedbackTool } = await import("@/lib/feedback/ai-tools/list-feedback");
    const tool = createListFeedbackTool(ctx) as unknown as { run: (args: unknown) => Promise<string> };
    const raw = await tool.run({});
    const parsed = JSON.parse(raw) as { error?: string };
    expect(parsed.error).toBe("permission_denied");
  });
});
