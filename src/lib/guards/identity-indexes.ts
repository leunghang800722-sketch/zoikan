// WP-STAFF-IMPORT：身份證／電話唯一 index 嘅保養＋診斷（淨係數字，唔印值）。
//   - guards_hkid_key：partial unique (hkid) WHERE hkid IS NOT NULL
//   - guard_phones_tel_key：unique (tel)
// migration 發現重複就唔建；呢度冪等補建（冇重複先建），有重複就回報組數並保持現狀。
import type { PrismaClient } from "@prisma/client";

export interface IdentityIndexStatus {
  dupHkidGroups: number;
  dupTelGroups: number;
  hkidIndexPresent: boolean;
  telIndexPresent: boolean;
  /** 正規化後（去非數字、去 852 前綴）同一 guard 多行同一號碼嘅組數——raw 值唔同（例 +852／8 位）所以
   * `guard_phones_tel_key` 唔會擋；要人手整理。 */
  dupTelSameGuardNormalizedGroups: number;
  /** 正規化後跨 guard 同一號碼嘅組數——raw unique index 唔識擋（寫法唔同），靠 app 層 telLookupVariants 擋新增。 */
  dupTelCrossGuardNormalizedGroups: number;
}

export async function identityIndexStatus(prisma: PrismaClient): Promise<IdentityIndexStatus> {
  const NORM = `SELECT guard_id, CASE WHEN length(d) = 11 AND d LIKE '852%' THEN substr(d, 4) ELSE d END AS n FROM (SELECT guard_id, regexp_replace(tel, '\\D', '', 'g') AS d FROM guard_phones) a`;
  const [h, t, idx, sameG, crossG] = await Promise.all([
    prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM guards WHERE hkid IS NOT NULL GROUP BY hkid HAVING count(*) > 1) x`),
    prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM guard_phones GROUP BY tel HAVING count(*) > 1) x`),
    prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE indexname IN ('guards_hkid_key','guard_phones_tel_key')`),
    prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM (${NORM}) b GROUP BY guard_id, n HAVING count(*) > 1) x`),
    prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM (${NORM}) b GROUP BY n HAVING count(DISTINCT guard_id) > 1) x`),
  ]);
  const names = new Set(idx.map((r) => r.indexname));
  return { dupHkidGroups: h[0]!.n, dupTelGroups: t[0]!.n, hkidIndexPresent: names.has("guards_hkid_key"), telIndexPresent: names.has("guard_phones_tel_key"), dupTelSameGuardNormalizedGroups: sameG[0]!.n, dupTelCrossGuardNormalizedGroups: crossG[0]!.n };
}

/** 冪等：冇重複就 CREATE UNIQUE INDEX IF NOT EXISTS；有重複保持現狀。回傳之後嘅狀態。 */
export async function ensureIdentityIndexes(prisma: PrismaClient): Promise<IdentityIndexStatus & { created: string[] }> {
  const before = await identityIndexStatus(prisma);
  const created: string[] = [];
  if (before.dupHkidGroups === 0 && !before.hkidIndexPresent) {
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "guards_hkid_key" ON "guards"("hkid") WHERE "hkid" IS NOT NULL`);
    created.push("guards_hkid_key");
  }
  if (before.dupTelGroups === 0 && !before.telIndexPresent) {
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "guard_phones_tel_key" ON "guard_phones"("tel")`);
    created.push("guard_phones_tel_key");
  }
  return { ...(await identityIndexStatus(prisma)), created };
}
