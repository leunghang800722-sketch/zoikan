// WP-AI3 第二輪 live 驗收：`buildSystemPrompt()` 要帶返「今日日期」＋
// 「今年」錨點（香港時間），等模型答「7 月」「8 月」呢類冇講年份嘅
// 問題有一個穩定依據，唔會時啱時錯。呢度用 injected `now` 斷言：(a)
// prompt 含 YYYY-MM-DD 格式嘅今日日期，(b) 含今年數字，(c) 唔同 `now`
// 產生唔同日期（證明真係逐 request 動態生成，唔係打包時嘅固定字串），
// (d) 有講「冇講年份就當今年」同「冇記錄要問係咪第個年份，唔准自己轉」
// 呢兩條規則嘅文字。
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

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

describe("WP-AI3 buildSystemPrompt() 今日日期／年份錨點", () => {
  it("含 YYYY-MM-DD 格式嘅今日日期（香港時間）", () => {
    const now = new Date("2026-09-12T03:00:00.000Z"); // UTC 03:00 = 香港時間 11:00，同一日
    const prompt = buildSystemPrompt(fakeSession, undefined, now);
    expect(prompt).toContain("2026-09-12");
  });

  it("含今年（香港時間嗰年）", () => {
    const now = new Date("2026-09-12T03:00:00.000Z");
    const prompt = buildSystemPrompt(fakeSession, undefined, now);
    expect(prompt).toContain("2026 年（今年）");
  });

  it("香港時區邊界：UTC 前一日深夜但已經踏入香港時間下一日，today 要用返香港嗰日（唔係 UTC 嗰日）", () => {
    // UTC 2026-09-11 16:30 = 香港時間 2026-09-12 00:30（UTC+8）
    const now = new Date("2026-09-11T16:30:00.000Z");
    const prompt = buildSystemPrompt(fakeSession, undefined, now);
    expect(prompt).toContain("2026-09-12");
    expect(prompt).not.toContain("2026-09-11");
  });

  it("唔同 now 產生唔同日期——證明係逐 request 動態生成，唔係打包時嘅固定字串", () => {
    const promptA = buildSystemPrompt(fakeSession, undefined, new Date("2026-01-15T00:00:00.000Z"));
    const promptB = buildSystemPrompt(fakeSession, undefined, new Date("2027-06-20T00:00:00.000Z"));
    expect(promptA).toContain("2026-01-15");
    expect(promptA).toContain("2026 年（今年）");
    expect(promptB).toContain("2027-06-20");
    expect(promptB).toContain("2027 年（今年）");
  });

  it("有講明「冇講年份就當今年」呢條規則", () => {
    const prompt = buildSystemPrompt(fakeSession, undefined, new Date("2026-09-12T00:00:00.000Z"));
    expect(prompt).toContain("冇講年份");
    expect(prompt).toContain("一律當");
    expect(prompt).toContain("今年");
  });

  it("有講明「冇記錄要講明邊年邊月＋問係咪第個年份，唔准自動轉年」呢條規則", () => {
    const prompt = buildSystemPrompt(fakeSession, undefined, new Date("2026-09-12T00:00:00.000Z"));
    expect(prompt).toContain("冇記錄");
    expect(prompt).toContain("係咪想問第個年份");
    expect(prompt).toContain("唔准自己靜靜雞轉去第個年份");
  });

  it("唔傳 now 都要用得（預設 new Date()，唔會拋錯）", () => {
    const prompt = buildSystemPrompt(fakeSession);
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
