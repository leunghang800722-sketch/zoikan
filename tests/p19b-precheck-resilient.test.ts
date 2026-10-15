// P19b.2（N7）：離職者平均工資檢查出錯只記 warning，唔令一鍵結算 precheck 失敗。
import { describe, it, expect, vi, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";

vi.mock("@/lib/longterm-payroll/leaver-adw-pending", () => ({
  listLeaverAdwPending: vi.fn(async () => {
    throw new Error("模擬失敗");
  }),
}));

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("precheck 容錯", () => {
  it("listLeaverAdwPending 擲錯 → warning，不 halt、不 throw", async () => {
    const { stepPrecheck } = await import("@/lib/month-close/one-click");
    const r = await stepPrecheck(new Date(Date.UTC(2026, 7, 1)), "test", null);
    expect(r.halt).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("離職者平均工資待確認檢查失敗"))).toBe(true);
  });
});
