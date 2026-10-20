// OCR-6.2：入職表電話 confirmed 需要獨立來源（OCR-6.1）。new-from-docs 流程：身份證 confirmed 嘅 HKID 配對到系統內已有保安員 →
// 用佢嘅 `guards.tel`＋`guard_phones` 做獨立來源（伺服器端查，client 唔經手）。冇配對到 → 空陣列（電話只會 review：phone_no_independent_source）。
// 只用 HKID 配對（身份證號係強識別）；姓名配對太弱（同名唔同人），唔用。
import { prisma } from "@/lib/db";
import { canonicalHkid } from "@/lib/guards/identity";

export async function storedPhonesForHkid(hkid: string | null | undefined): Promise<string[]> {
  const canon = hkid ? canonicalHkid(hkid) : null;
  if (!canon) return [];
  // OCR-6.3：兩邊都 canonical（舊資料可能帶括號／空白／小寫）
  const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM guards WHERE upper(regexp_replace(hkid, '[^A-Za-z0-9]', '', 'g')) = ${canon} LIMIT 1`;
  if (ids.length === 0) return [];
  const g = await prisma.guard.findUnique({ where: { id: ids[0].id }, select: { tel: true, phones: { select: { tel: true } } } });
  if (!g) return [];
  return [...new Set([g.tel, ...g.phones.map((p) => p.tel)].filter((t): t is string => !!t && t.trim().length > 0))].slice(0, 8);
}
