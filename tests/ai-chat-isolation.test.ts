// 規劃裁定（推翻 WP-AI1 執行時嘅第一版判斷）：AI 助手要同畫面權限
// 一致——「你冇權見嘅報表，助手都唔答」。所以：
//   1. 主管出廠（「毛利即時表」○ 未開）問毛利 → `gross_margin` 工具
//      直接回無權訊息，唔會走去起報表；response 冇任何 revenue/profit
//      數字（連歸零嘅 key 都冇——連報表都冇起）。
//   2. 老闆開咗主管「毛利即時表:view」（但主管仍然冇「收客價:view」）
//      → 工具會起報表，見到更數/成本（出街價出廠有），但 revenue/profit
//      跟 field-group gate 歸零（呢層邏輯冧 WP-AI1 冧落嚟，冇變）。
//   3. 老闆/會計出廠齊晒兩個 module + 兩個 field-group view → 完全唔
//      歸零。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { setLlmClientForTests } from "@/lib/ai/llm";
import { FakeLlmClient } from "./fixtures/fake-llm";
import { POST as chatPost } from "@/app/api/ai/chat/route";

function chatRequest(cookie: string, message: string) {
  return new Request("http://test.local/api/ai/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

async function collectDoneEvent(res: Response): Promise<{ text: string; tools_used: string[] }> {
  const text = await res.text();
  const block = text.split("\n\n").find((b) => b.includes("event: done"));
  const dataLine = block!.split("\n").find((l) => l.startsWith("data: "))!;
  return JSON.parse(dataLine.slice("data: ".length));
}

async function setGranted(roleName: "主管" | "會計" | "老闆", mod: string, granted: boolean): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const permission = await prisma.permission.findFirstOrThrow({ where: { module: mod, action: "view" } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    create: { roleId: role.id, permissionId: permission.id, granted, createdBy: "test:ai-chat-isolation" },
    update: { granted },
  });
}

function grossMarginScript() {
  return new FakeLlmClient({
    toolCalls: [{ name: "gross_margin", args: { month: "2026-07" } }],
    replyText: (results) => results["gross_margin"]!,
  });
}

describe("規劃裁定：AI 助手同畫面權限一致（毛利即時表 module + 收客價/出街價 field gate）", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  afterEach(() => setLlmClientForTests(undefined));

  it("主管出廠（毛利即時表○未開）問毛利 → 工具回無權訊息，response 冇任何 revenue/profit 數字", async () => {
    setLlmClientForTests(grossMarginScript());
    const cookie = await sessionCookieForUser(fx.userIds["主管"]);
    const res = await chatPost(chatRequest(cookie, "呢個月毛利點呀？"));
    expect(res.status).toBe(200);
    const done = await collectDoneEvent(res);
    const payload = JSON.parse(done.text);
    expect(payload.error).toBe("permission_denied");
    expect(payload.message).toContain("毛利即時表");
    expect(payload.sites).toBeUndefined();
    expect(payload.totals).toBeUndefined();
  });

  it("老闆開咗主管「毛利即時表:view」但主管仍然冇「收客價:view」→ 有更數/成本，revenue/profit 歸零", async () => {
    await setGranted("主管", "毛利即時表", true);
    try {
      setLlmClientForTests(grossMarginScript());
      const cookie = await sessionCookieForUser(fx.userIds["主管"]);
      const res = await chatPost(chatRequest(cookie, "呢個月毛利點呀？"));
      expect(res.status).toBe(200);
      const done = await collectDoneEvent(res);
      const payload = JSON.parse(done.text);
      expect(payload.error).toBeUndefined();
      expect(payload.totals).toBeDefined();
      expect(typeof payload.totals.shifts).toBe("number"); // 更數：出街價出廠有，唔理會收客價
      expect(payload.totals.revenue).toBe(0); // 收客價冇 → 歸零
      expect(payload.totals.profit).toBe(0);
      for (const site of payload.sites) {
        expect(site.revenue).toBe(0);
        expect(site.profit).toBe(0);
      }
    } finally {
      await setGranted("主管", "毛利即時表", false); // 還原出廠設定
    }
  });

  it("老闆（毛利即時表 + 收客價 + 出街價出廠皆有）問毛利 → 完全唔歸零", async () => {
    setLlmClientForTests(grossMarginScript());
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await chatPost(chatRequest(cookie, "呢個月毛利點呀？"));
    expect(res.status).toBe(200);
    const done = await collectDoneEvent(res);
    const payload = JSON.parse(done.text);
    expect(payload.error).toBeUndefined();
    expect(payload.note).toBeUndefined();
  });

  it("會計（毛利即時表 + 收客價 + 出街價出廠皆有）問毛利 → 完全唔歸零", async () => {
    setLlmClientForTests(grossMarginScript());
    const cookie = await sessionCookieForUser(fx.userIds["會計"]);
    const res = await chatPost(chatRequest(cookie, "呢個月毛利點呀？"));
    const done = await collectDoneEvent(res);
    const payload = JSON.parse(done.text);
    expect(payload.error).toBeUndefined();
    expect(payload.note).toBeUndefined();
  });
});
