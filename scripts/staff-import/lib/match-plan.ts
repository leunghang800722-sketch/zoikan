// §26.2.4 對齊決策（純函數）：link／create／conflict／needs_review。
// WP-STAFF-IMPORT B3：配對決策本體已搬去 src/lib/guards/import/match.ts（伺服器導入同本 script 共用，
// 唔再有兩套）；呢度保留 Stage A 嘅「分群組＋出 PlanEntry」包裝，輸出同之前一致。
import { normTel, normZh } from './compare';
import { editDistance } from './text';
import { buildDbIndex, decideMatch, type Action, type DbGuard, type DbIndex } from '@/lib/guards/import/match';

export { buildDbIndex };
export type { Action, DbGuard, DbIndex };

export interface PlanInput {
  docId: string;
  staffNos: string[]; // 一個人可以有幾個工號（MP 舊號＋U 新號）
  hkid: string | null; // canonical，check digit 啱先傳入
  hkidValid: boolean;
  nameZh: string | null;
  phone: string | null;
  grade: 'auto_ok' | 'review' | 'fail';
  gradeReasons: string[];
}

export interface PlanEntry {
  docId: string; // 主檔
  docIds: string[]; // 同一個人嘅全部檔（重複／MP＋U 兩個檔）
  staffNos: string[];
  action: Action;
  guardId: string | null;
  candidates: string[];
  basis: string[];
  reasons: string[]; // 理由碼
  grade: PlanInput['grade'];
  autoApply: boolean;
  /** 多檔合併後嘅欄位（04 填；含 PII，只留 data/） */
  merged?: import('./merge').Merged;
  mergeReasons?: string[];
}

const RANK = { auto_ok: 0, review: 1, fail: 2 } as const;

export interface PersonGroup {
  key: string;
  primary: PlanInput;
  docIds: string[];
  staffNos: string[];
  reasons: string[]; // 群組層面嘅衝突理由
}

/**
 * 同一個 hkid 嘅檔合併成一個「人」（同一個人可以有 MP 舊檔＋U 新檔，或重複掃描）。
 * 冇有效 hkid 嘅檔各自獨立一個 entry（進 needs_review）。
 * 群組層面衝突：同 hkid 但中文名差異大、同一工號掛喺唔同 hkid、同一電話掛喺唔同人。
 */
export function groupPersons(inputs: PlanInput[]): PersonGroup[] {
  const map = new Map<string, PlanInput[]>();
  const groups: PersonGroup[] = [];
  for (const i of inputs) {
    if (i.hkidValid && i.hkid) map.set(i.hkid, [...(map.get(i.hkid) ?? []), i]);
    else groups.push({ key: `doc:${i.docId}`, primary: i, docIds: [i.docId], staffNos: i.staffNos, reasons: [] });
  }
  for (const [hkid, list] of map) {
    const sorted = [...list].sort((a, b) => RANK[a.grade] - RANK[b.grade] || Number(!!b.phone) - Number(!!a.phone));
    const reasons: string[] = [];
    const names = list.map((x) => normZh(x.nameZh)).filter((x): x is string => !!x);
    for (const n of names) if (names.some((m) => editDistance(n, m) > 1 && Math.min(n.length, m.length) >= 2)) reasons.push('group_name_differs');
    groups.push({
      key: hkid,
      primary: sorted[0],
      docIds: list.map((x) => x.docId),
      staffNos: [...new Set(list.flatMap((x) => x.staffNos))],
      reasons: [...new Set(reasons)],
    });
  }
  // 跨群組：同一工號／電話出現喺唔同人
  const noOwner = new Map<string, Set<string>>();
  const telOwner = new Map<string, Set<string>>();
  for (const g of groups) {
    g.staffNos.forEach((n) => noOwner.set(n, (noOwner.get(n) ?? new Set()).add(g.key)));
    const t = normTel(g.primary.phone);
    if (t) telOwner.set(t, (telOwner.get(t) ?? new Set()).add(g.key));
  }
  for (const g of groups) {
    if (g.staffNos.some((n) => (noOwner.get(n)?.size ?? 0) > 1)) g.reasons.push('staffno_shared_by_persons');
    const t = normTel(g.primary.phone);
    if (t && (telOwner.get(t)?.size ?? 0) > 1) g.reasons.push('dup_tel_across_persons');
  }
  return groups;
}

export function planAll(inputs: PlanInput[], db: DbIndex): PlanEntry[] {
  return groupPersons(inputs).map((g) => decide({ ...g.primary, staffNos: g.staffNos }, db, g));
}

export function decide(i: PlanInput, db: DbIndex, group: PersonGroup | null = null): PlanEntry {
  const d = decideMatch(
    { staffNos: i.staffNos, hkid: i.hkid, hkidValid: i.hkidValid, nameZh: i.nameZh, phone: i.phone, grade: i.grade, gradeReasons: i.gradeReasons },
    db,
    group?.reasons ?? [],
  );
  return {
    docId: i.docId,
    docIds: group?.docIds ?? [i.docId],
    staffNos: i.staffNos,
    action: d.action,
    guardId: d.guardId,
    candidates: d.candidates,
    basis: d.basis,
    reasons: d.reasons,
    grade: i.grade,
    autoApply: d.action !== 'conflict' && d.action !== 'needs_review' && i.grade === 'auto_ok',
  };
}
