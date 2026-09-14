// 老闆正式站 feedback（2026-09-14）：追問「有邊幾個盤」被當新話題答全公司
// 盤名單。system prompt 要有明確嘅「追問承接上文」規則。呢度斷言規則文字
// 存在（規則內容本身靠正式站實測驗收）。
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

describe("buildSystemPrompt() 追問承接上文規則", () => {
  it("含「追問要承接上文」規則：省略主語當同一對象／同一月份，唔准跳去全公司", () => {
    const prompt = buildSystemPrompt(fakeSession);
    expect(prompt).toContain("追問要承接上文");
    expect(prompt).toContain("有邊幾個盤");
    expect(prompt).toContain("唔准跳去全公司");
    expect(prompt).toContain("講返承接咗邊個對象同邊個月");
  });
});
