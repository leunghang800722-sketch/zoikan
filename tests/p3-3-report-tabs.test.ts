// P3-3.4：報表 tab 按 grants 顯示（`reports/layout.tsx` 用同一份 REPORT_TABS＋getViewGrants）。
import { describe, expect, it } from "vitest";
import { REPORT_TABS } from "@/components/reports/ReportTabs";
import { MODULES, isGrantedByDefault, type Module, type RoleName } from "@/lib/rbac/matrix";

function visible(role: RoleName, over: Partial<Record<Module, boolean>> = {}) {
  const grants = { ...(Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(role, m, "view")])) as Record<Module, boolean>), ...over };
  return REPORT_TABS.filter((t) => grants[t.module]).map((t) => t.label);
}

describe("報表 tab（P3-3.4）", () => {
  it("五個 tab 次序固定；路徑不變", () => {
    expect(REPORT_TABS.map((t) => t.href)).toEqual(["/reports/monthly-close", "/reports/gross-margin", "/reports/payroll", "/reports/longterm-payroll", "/reports/ops-digest"]);
    expect(REPORT_TABS.map((t) => t.label)).toEqual(["月結總表", "毛利", "糧明細", "長工糧", "修正摘要"]);
  });

  it("出廠：老闆五個；會計五個；主管只見有權限嗰啲；雞頭／保安員冇", () => {
    expect(visible("老闆")).toHaveLength(5);
    expect(visible("會計")).toHaveLength(5);
    const sup = visible("主管");
    expect(sup).not.toContain("長工糧"); // 長工糧：主管硬性拒
    expect(sup).not.toContain("修正摘要"); // 修正摘要跟「月結總表」view：主管出廠關
    expect(visible("雞頭")).toEqual([]);
    expect(visible("安員")).toEqual([]);
  });

  it("修正摘要同月結總表同一個 module；老闆事後幫主管開月結總表 → 兩個 tab 一齊出", () => {
    const sup = visible("主管", { 月結總表: true });
    expect(sup).toContain("月結總表");
    expect(sup).toContain("修正摘要");
  });
});
