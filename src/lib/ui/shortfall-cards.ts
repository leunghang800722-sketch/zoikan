// P3-0.4：首頁／尚欠總覽 KPI 卡按權限顯示（純函數，server page 同 test 共用）。
// 「待審批」卡需要「審批:view」；「毛利進度」卡需要「毛利即時表:view」。
import type { Module } from "@/lib/rbac/matrix";

export interface ShortfallCardVisibility {
  showApprovals: boolean;
  showMargin: boolean;
}

export function shortfallCardVisibility(grants: Partial<Record<Module, boolean>>): ShortfallCardVisibility {
  return { showApprovals: !!grants["審批"], showMargin: !!grants["毛利即時表"] };
}
