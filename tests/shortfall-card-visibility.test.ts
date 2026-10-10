// P3-0.4：首頁 KPI 卡按權限顯示——出廠矩陣下老闆／主管／會計各見幾多張卡。
import { describe, it, expect } from "vitest";
import { shortfallCardVisibility } from "@/lib/ui/shortfall-cards";
import { MODULES, isGrantedByDefault, type Module, type RoleName } from "@/lib/rbac/matrix";

function grantsOf(role: RoleName): Record<Module, boolean> {
  return Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(role, m, "view")])) as Record<Module, boolean>;
}

describe("shortfallCardVisibility", () => {
  it("老闆：待審批＋毛利進度都有（共 2 張可選卡）", () => {
    expect(shortfallCardVisibility(grantsOf("老闆"))).toEqual({ showApprovals: true, showMargin: true });
  });
  it("主管：出廠有「審批:view」、冇「毛利即時表:view」→ 只有待審批", () => {
    expect(shortfallCardVisibility(grantsOf("主管"))).toEqual({ showApprovals: true, showMargin: false });
  });
  it("會計：出廠「審批」係可選（預設關）、「毛利即時表」預設開 → 只有毛利進度", () => {
    expect(shortfallCardVisibility(grantsOf("會計"))).toEqual({ showApprovals: false, showMargin: true });
  });
  it("老闆開咗會計「審批」→ 會計見待審批", () => {
    expect(shortfallCardVisibility({ ...grantsOf("會計"), 審批: true })).toEqual({ showApprovals: true, showMargin: true });
  });
});
