// WP-AI-DIAG（§37.4）：system prompt 要有「先用診斷工具」＋ actions 區塊格式 ＋「鎖月唔准建議寫入」規則。
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

const session: AuthedSession = {
  userId: "u", tel: "90000000", name: "測試老闆", roleId: "r", roleName: "老闆", baseRole: "老闆", brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 1, loggedInAt: new Date().toISOString(),
};

describe("buildSystemPrompt() 診斷＋建議動作", () => {
  const p = buildSystemPrompt(session);
  it("要求診斷時先用診斷工具", () => {
    expect(p).toContain("先用診斷工具查");
  });
  it("講明 actions 區塊格式同六種 type、最多 5 張", () => {
    expect(p).toContain("```actions");
    for (const t of ["open_page", "triage_answer", "site_set_default_broker", "roster_reparse", "one_click_run", "backfill_from_postorder"]) expect(p).toContain(t);
    expect(p).toContain("最多 5 張");
  });
  it("鎖月月份唔准建議寫入動作", () => {
    expect(p).toContain("已鎖月");
    expect(p).toContain("唔准建議任何寫入動作");
  });
  it("卡只係建議、模型冇執行能力", () => {
    expect(p).toContain("只係建議");
  });
  it("原有鐵律仍在（純讀、標準回覆）", () => {
    expect(p).toContain("純讀助手");
    expect(p).toContain("呢類改動請聯絡 Eric（老闆）");
  });
});
