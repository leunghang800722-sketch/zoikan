// §26.2.4 對齊決策（純函數）：link／create／conflict／needs_review。
import { normTel, normZh } from './compare';
import { editDistance } from './text';

export type Action = 'link' | 'create' | 'conflict' | 'needs_review';

export interface DbGuard {
  id: string;
  nameZh: string | null;
  hkid: string | null; // canonical
  tels: string[];
  staffNos: string[];
}

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
}

export interface DbIndex {
  byHkid: Map<string, DbGuard[]>;
  byNo: Map<string, DbGuard[]>;
  byTel: Map<string, DbGuard[]>;
  byZh: Map<string, DbGuard[]>;
}

export function buildDbIndex(gs: DbGuard[]): DbIndex {
  const idx: DbIndex = { byHkid: new Map(), byNo: new Map(), byTel: new Map(), byZh: new Map() };
  const add = (m: Map<string, DbGuard[]>, k: string | null, g: DbGuard) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    if (!a.includes(g)) a.push(g);
    m.set(k, a);
  };
  for (const g of gs) {
    add(idx.byHkid, g.hkid, g);
    g.staffNos.forEach((n) => add(idx.byNo, n.toUpperCase(), g));
    g.tels.forEach((t) => add(idx.byTel, normTel(t), g));
    add(idx.byZh, normZh(g.nameZh), g);
  }
  return idx;
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
  const reasons: string[] = [];
  const basis: string[] = [];
  const candidates = new Set<string>();
  const entry = (action: Action, guardId: string | null): PlanEntry => ({
    docId: i.docId,
    docIds: group?.docIds ?? [i.docId],
    staffNos: i.staffNos,
    action,
    guardId,
    candidates: [...candidates],
    basis,
    reasons: [...new Set(reasons)],
    grade: i.grade,
    autoApply: action !== 'conflict' && action !== 'needs_review' && i.grade === 'auto_ok',
  });

  const tel = normTel(i.phone);
  if (group?.reasons.length) {
    reasons.push(...group.reasons);
    return entry('conflict', null);
  }

  if (i.grade === 'fail' || !i.hkid || !i.hkidValid) {
    reasons.push('extract_fail', ...i.gradeReasons.slice(0, 5));
    // 即使 fail，工號對到嘅 guard 都列為候選方便人手處理
    i.staffNos.forEach((n) => db.byNo.get(n)?.forEach((g) => candidates.add(g.id)));
    return entry('needs_review', null);
  }

  const gHkid = db.byHkid.get(i.hkid) ?? [];
  const gNo = [...new Map(i.staffNos.flatMap((n) => db.byNo.get(n) ?? []).map((g) => [g.id, g])).values()];
  const gTel = tel ? db.byTel.get(tel) ?? [] : [];
  [...gHkid, ...gNo, ...gTel].forEach((g) => candidates.add(g.id));

  if (gHkid.length > 1) {
    reasons.push('hkid_multi_guard');
    return entry('conflict', null);
  }
  if (gNo.length > 1) {
    reasons.push('staffno_multi_guard');
    return entry('conflict', null);
  }
  if (gHkid[0] && gNo[0] && gHkid[0].id !== gNo[0].id) {
    reasons.push('hkid_vs_staffno_differ');
    return entry('conflict', null);
  }
  const g = gHkid[0] ?? gNo[0] ?? null;
  if (g) {
    if (g.hkid && g.hkid !== i.hkid) {
      reasons.push('guard_hkid_differs');
      return entry('conflict', g.id);
    }
    if (gTel.length && !gTel.some((t) => t.id === g.id)) {
      reasons.push('tel_belongs_to_other_guard');
      return entry('conflict', g.id);
    }
    if (gHkid[0]) basis.push('hkid');
    if (gNo[0]) basis.push('staff_no');
    if (gTel.some((t) => t.id === g.id)) basis.push('tel');
    if (i.nameZh && g.nameZh && normZh(i.nameZh) !== normZh(g.nameZh)) reasons.push('name_differs_from_guard');
    if (!gHkid[0] && !gNo[0]) return entry('needs_review', null);
    return entry('link', g.id);
  }
  // 冇 hkid／工號對應——試電話
  if (gTel.length === 1) {
    const t = gTel[0];
    if (t.hkid && t.hkid !== i.hkid) {
      reasons.push('tel_guard_has_other_hkid');
      return entry('conflict', t.id);
    }
    const nameSame = !!i.nameZh && !!t.nameZh && normZh(i.nameZh) === normZh(t.nameZh);
    if (nameSame) {
      basis.push('tel', 'name');
      return entry('link', t.id);
    }
    reasons.push('tel_only_candidate');
    return entry('needs_review', null);
  }
  if (gTel.length > 1) {
    reasons.push('tel_multi_guard');
    return entry('conflict', null);
  }
  // 淨姓名
  const gName = i.nameZh ? db.byZh.get(normZh(i.nameZh) ?? '') ?? [] : [];
  gName.forEach((x) => candidates.add(x.id));
  if (gName.length) {
    reasons.push(gName.length === 1 ? 'name_only_candidate' : 'name_multi_candidate');
    return entry('needs_review', null);
  }
  basis.push('no_existing_guard');
  return entry('create', null);
}
