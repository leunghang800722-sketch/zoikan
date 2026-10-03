// 以有效 hkid 合併成「人」（同 04 一致）；揀身份證來源檔同地址來源檔。純函數。
import type { DocExtract } from './aggregate';
import type { Grade } from './crosscheck';

const RANK: Record<Grade, number> = { auto_ok: 0, review: 1, fail: 2 };

export interface PersonGroup {
  key: string; // hkid 或 doc:<docId>
  docIds: string[];
  idDocId: string | null;
  addressDocId: string | null;
}

export function groupPersons<T extends DocExtract>(docs: T[], gradeOf: (docId: string) => Grade): PersonGroup[] {
  const map = new Map<string, T[]>();
  const loose: T[] = [];
  for (const d of docs) {
    if (d.hkidValid && d.hkid) map.set(d.hkid.value, [...(map.get(d.hkid.value) ?? []), d]);
    else loose.push(d);
  }
  const mk = (key: string, list: T[]): PersonGroup => {
    const ids = [...list].sort((a, b) => RANK[gradeOf(a.docId)] - RANK[gradeOf(b.docId)] || (b.hkid?.conf ?? 0) - (a.hkid?.conf ?? 0));
    const withId = ids.find((d) => d.hkid) ?? ids[0];
    const addrs = list.filter((d) => d.address);
    const dated = addrs.filter((d) => d.address!.date);
    const addrDoc =
      dated.length === addrs.length && addrs.length
        ? [...dated].sort((a, b) => b.address!.date!.localeCompare(a.address!.date!))[0]
        : addrs[0] ?? null;
    return { key, docIds: list.map((d) => d.docId), idDocId: withId?.hkid ? withId.docId : null, addressDocId: addrDoc?.docId ?? null };
  };
  return [...[...map].map(([k, v]) => mk(k, v)), ...loose.map((d) => mk(`doc:${d.docId}`, [d]))];
}
