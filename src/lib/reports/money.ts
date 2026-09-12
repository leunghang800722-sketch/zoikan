// 報表用嘅細 helper——同 scripts/report/lib/money.ts 概念一致，但呢度係
// src/ 嘅版本（俾 API route／頁面同 scripts/report/*.ts thin wrapper
// 共用，見 P1-執行計劃.md §4 WP4「搬 scripts/report/monthly-close.ts 邏輯
// 入 src/lib/reports/」）。刻意冇由 scripts/ import（依賴方向要單向：
// scripts → src，唔可以 src → scripts）。
import type { Prisma } from "@prisma/client";

export function n(v: Prisma.Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v.toString());
}

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function monthStart(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
}

export function monthRange(month: Date): { start: Date; end: Date } {
  const start = monthStart(month);
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  return { start, end };
}

/** "2026-07" 或 "2026-07-01" 或完整 ISO 都接受，統一轉做月首 Date（UTC）。 */
export function parseMonthParam(raw: string | null): Date | null {
  if (!raw) return null;
  const iso = raw.length <= 7 ? `${raw}-01` : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return monthStart(d);
}

export function monthLabel(month: Date): string {
  return month.toISOString().slice(0, 7);
}
