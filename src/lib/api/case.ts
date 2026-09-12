// snake_case（wire format，API 契約統一之後嘅 request body 一律用呢個）
// <-> camelCase（Prisma model 欄位名）淺層轉換——淨係轉頂層 key，唔會
// 遞歸行入 JSON blob 欄位（`bank_info`／`provenance`）嘅內部結構，因為
// 嗰啲係「值」唔係我哋自己定義嘅 schema 欄位。
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function snakeToCamelShallow<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[snakeToCamel(k)] = v;
  }
  return out;
}
