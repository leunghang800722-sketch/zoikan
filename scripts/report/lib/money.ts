import type { Prisma } from "@prisma/client";

// Prisma Decimal -> number（報表輸出用；資料庫層一路都係 Decimal，呢度先轉）
export function n(v: Prisma.Decimal | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v.toString());
}

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
