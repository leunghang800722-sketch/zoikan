// WP-AI2：`friendlyAiError()`（`src/lib/ui/ai-chat-client.ts`）純函數——
// 側欄 AI 助手 HTTP 錯誤 → 友善文字對照（任務指示 §2：429/503 要指定
// 字眼）。
import { describe, it, expect } from "vitest";
import { friendlyAiError } from "@/lib/ui/ai-chat-client";

describe("WP-AI2 friendlyAiError——助手前端錯誤文字", () => {
  it("429 → 帶「今日已達提問上限」", () => {
    expect(friendlyAiError(429)).toContain("今日已達提問上限");
  });

  it("503 → 帶「助手暫時未連接到 AI 服務」", () => {
    expect(friendlyAiError(503)).toContain("助手暫時未連接到 AI 服務");
  });

  it("401/403 都有非空嘅友善文字", () => {
    expect(friendlyAiError(401).length).toBeGreaterThan(0);
    expect(friendlyAiError(403).length).toBeGreaterThan(0);
  });

  it("未知狀態碼：有後端 message 就用返佢", () => {
    expect(friendlyAiError(500, "自訂錯誤文字")).toBe("自訂錯誤文字");
  });

  it("未知狀態碼：冇後端 message 就用通用 fallback", () => {
    expect(friendlyAiError(500)).toBe("發生錯誤，請稍後再試");
  });
});
