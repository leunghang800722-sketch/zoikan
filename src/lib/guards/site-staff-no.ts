// EMP-P1：更表／匯出跟「盤」嘅 staff_scheme 顯示工號（推翻舊「一律印 U」）。
//   - 盤未設定 scheme（null）或者 U：照舊印 `guards.staff_no`（現用 U，冇現用就最近取消嗰個）——7 月盤全部未設，所以 gate:export 對數 0 差異；
//   - 盤 scheme = MP（或其他）：印該人嗰個 scheme 嘅現用卡；冇現用就最近取消嗰張；完全冇該 scheme 嘅卡就留空（唔會借 U 號充數）。
import type { Prisma, PrismaClient } from "@prisma/client";
import { pickRepresentativeStaffNumberRow } from "./staff-numbers";

type Db = PrismaClient | Prisma.TransactionClient;

export interface SiteStaffNoResolver {
  /** 預載一批 guard 嘅該 scheme 卡（可重複 call，已載過嘅唔重查）。 */
  prefetch(guardIds: readonly string[]): Promise<void>;
  /** 該 guard 喺呢個盤應該顯示嘅工號。 */
  of(guard: { id: string; staffNo: string | null }): string;
}

export function createSiteStaffNoResolver(db: Db, siteScheme: string | null | undefined): SiteStaffNoResolver {
  const scheme = siteScheme?.trim().toUpperCase() || null;
  const useCards = !!scheme && scheme !== "U";
  const loaded = new Set<string>();
  const byGuard = new Map<string, string>();
  return {
    async prefetch(guardIds) {
      if (!useCards) return;
      const todo = [...new Set(guardIds)].filter((g) => !loaded.has(g));
      if (todo.length === 0) return;
      const rows = await db.guardStaffNumber.findMany({ where: { guardId: { in: todo }, scheme: scheme! } });
      const by = new Map<string, typeof rows>();
      for (const r of rows) by.set(r.guardId, [...(by.get(r.guardId) ?? []), r]);
      for (const g of todo) {
        loaded.add(g);
        const rep = pickRepresentativeStaffNumberRow(by.get(g) ?? [], scheme!);
        if (rep) byGuard.set(g, rep.number);
      }
    },
    of(guard) {
      return useCards ? (byGuard.get(guard.id) ?? "") : (guard.staffNo ?? "");
    },
  };
}
