// WP-AI3：`toOpenAiTool()`（`src/lib/ai/providers/deepseek.ts`）將
// `betaZodTool()` 造嘅 14 個真工具逐個轉做 OpenAI `tools:[{type:"function"}]`
// 形狀——唔使自己再用 zod-to-json-schema 轉一次（`betaZodTool()` 內部已經
// 用 zod v4 `z.toJSONSchema()` 轉咗，掛喺 `input_schema`，呢個轉換函數
// 淨係搬個 key），呢度斷言全部 14 個工具都轉換成功、`parameters` 冇
// `$schema`、strict object 嘅 `additionalProperties:false` 冇跌.
//
// 建 `AiToolContext` 唔使真 DB——`buildAiTools()` 淨係 call 逐個
// `betaZodTool({...})` 建構工具物件（zod schema 呢一步係 sync、純
// function），真正查 DB 淨係喺 `.run()` 入面，呢度完全唔會 call 到。
import { describe, it, expect } from "vitest";
import { buildAiTools } from "@/lib/ai/tools";
import { toOpenAiTool } from "@/lib/ai/providers/deepseek";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { AiToolContext } from "@/lib/ai/tools/common";

const fakeSession: AuthedSession = {
  userId: "test-user",
  tel: "90000000",
  name: "測試老闆",
  roleId: "role-1",
  roleName: "老闆",
  baseRole: "老闆",
  brokerId: null,
  guardId: null,
  payoutApprovalLimit: null,
  tokenVersion: 1,
  loggedInAt: new Date().toISOString(),
};

const ctx: AiToolContext = {
  session: fakeSession,
  fieldVisibility: { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true },
};

describe("WP-AI3：betaZodTool → OpenAI function tool 轉換（15 個工具，老闆 session）", () => {
  const tools = buildAiTools(ctx);

  // P2.5：`fakeSession.baseRole === "老闆"`，`buildAiTools()` 而家會多掛
  // 一個 `list_feedback`（14 個原有工具 + 1，見 src/lib/ai/tools/index.ts）
  // ——同 docs/ai-assistant.md 工具表一致（15 = 14 舊 + list_feedback）。
  it("`buildAiTools()` 老闆 session 出返 15 個工具（14 舊 + list_feedback）", () => {
    expect(tools).toHaveLength(15);
  });

  it.each(tools.map((t) => [(t as unknown as { name: string }).name, t] as const))(
    "工具「%s」轉換做 OpenAI function tool 成功、schema 形狀正確",
    (name, tool) => {
      const openAiTool = toOpenAiTool(tool);

      expect(openAiTool.type).toBe("function");
      expect(openAiTool.function.name).toBe(name);
      expect(typeof openAiTool.function.description).toBe("string");
      expect(openAiTool.function.description!.length).toBeGreaterThan(0);

      const params = openAiTool.function.parameters as Record<string, unknown>;
      expect(params).toBeDefined();
      expect(params.type).toBe("object");
      // 全部 14 個工具嘅 inputSchema 都用 `.strict()`（tests/ai-structural-
      // guard.test.ts 冇強制呢一點，但呢度直接斷言，防止日後新工具漏咗
      // `.strict()` 令 additionalProperties 變返 true）。
      expect(params.additionalProperties).toBe(false);
      // OpenAI/DeepSeek 唔需要 JSON Schema 嘅 `$schema` meta key，
      // `toOpenAiTool()` 要剝走。
      expect(params).not.toHaveProperty("$schema");
    },
  );

  it("全部工具名一定唯一（唔會撞名，DeepSeek 用工具名做 dispatch key）", () => {
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(new Set(names).size).toBe(names.length);
  });
});
