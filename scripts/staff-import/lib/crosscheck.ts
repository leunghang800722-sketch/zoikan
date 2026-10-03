// 逐人交叉核對＋評級（純函數，輸入抽取結果＋參考行）。
import type { DocExtract } from './aggregate';
import { cmpAddress, cmpDate, cmpEn, cmpHkid, cmpTel, cmpZh, fieldStatus, normZh, type Cmp } from './compare';
import { canonicalHkid } from './hkid';
import { resolvePhone, type PhoneFinal, type VisionRead } from './phone';
import type { RefRow } from './refs';

export type Src = 'utem' | 'maxwell' | 'db';
export const FIELDS = ['hkid', 'nameZh', 'nameEn', 'dob', 'address', 'phone'] as const;
export type FieldName = (typeof FIELDS)[number];
export type Grade = 'auto_ok' | 'review' | 'fail';

export interface RefIndex {
  rows: RefRow[];
  byNo: Map<string, RefRow[]>;
  byHkid: Map<string, RefRow[]>;
  byZh: Map<string, RefRow[]>;
}

export function buildIndex(rows: RefRow[]): RefIndex {
  const idx: RefIndex = { rows, byNo: new Map(), byHkid: new Map(), byZh: new Map() };
  const add = (m: Map<string, RefRow[]>, k: string | null, r: RefRow) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  };
  for (const r of rows) {
    r.staffNos.forEach((n) => add(idx.byNo, n, r));
    add(idx.byHkid, r.hkid, r);
    add(idx.byZh, normZh(r.nameZh), r);
  }
  return idx;
}

export interface Resolved {
  row: RefRow | null;
  basis: 'staff_no' | 'hkid' | 'name' | 'none';
  ambiguous: boolean;
}

export function resolveRef(idx: RefIndex, staffNo: string | null, hkid: string | null, nameZh: string | null): Resolved {
  const tryMap = (m: Map<string, RefRow[]>, k: string | null, basis: Resolved['basis']): Resolved | null => {
    if (!k) return null;
    const a = m.get(k);
    if (!a?.length) return null;
    return { row: a[0], basis, ambiguous: a.length > 1 };
  };
  return (
    tryMap(idx.byNo, staffNo, 'staff_no') ??
    tryMap(idx.byHkid, hkid, 'hkid') ??
    tryMap(idx.byZh, normZh(nameZh), 'name') ?? { row: null, basis: 'none', ambiguous: false }
  );
}

export interface DocCheck {
  docId: string;
  staffNo: string | null;
  refs: Record<Src, { basis: Resolved['basis']; ref: string | null; ambiguous: boolean }>;
  cmp: Record<FieldName, Record<Src | 'file', Cmp | 'not_comparable'>>;
  status: Record<FieldName, Cmp | 'mixed'>;
  nameZhNear: boolean;
  present: Record<FieldName, boolean>;
  grade: Grade;
  reasons: string[];
  phoneFinal: PhoneFinal;
}

export function crosscheck(
  ex: DocExtract,
  staffNo: string | null,
  fileNameZh: string | null,
  idxs: Record<Src, RefIndex>,
  phoneIn: { vision: VisionRead[]; hasCrop: boolean } = { vision: [], hasCrop: false },
): DocCheck {
  const hkid = ex.hkid ? canonicalHkid(ex.hkid.value) : null;
  const zh = ex.nameZh?.value ?? fileNameZh;
  const refs = {} as DocCheck['refs'];
  const cmp = {} as DocCheck['cmp'];
  for (const f of FIELDS) cmp[f] = { utem: 'no_reference', maxwell: 'no_reference', db: 'no_reference', file: 'no_reference' };
  let near = false;
  const reasons: string[] = [];

  for (const src of ['utem', 'maxwell', 'db'] as Src[]) {
    const res = resolveRef(idxs[src], staffNo, hkid, zh);
    refs[src] = { basis: res.basis, ref: res.row?.ref ?? null, ambiguous: res.ambiguous };
    const r = res.row;
    if (!r) continue;
    if (res.ambiguous) reasons.push(`ref_ambiguous_${src}`);
    // 用嚟搵行嘅欄位唔可以再拎嚟比對（循環）
    cmp.hkid[src] = res.basis === 'hkid' ? 'no_reference' : cmpHkid(hkid, r.hkid);
    const z = cmpZh(ex.nameZh?.value ?? null, r.nameZh);
    cmp.nameZh[src] = res.basis === 'name' ? 'no_reference' : z.near ? 'no_reference' : z.r; // 差一字（簡繁／OCR）當軟訊號，唔計互證／mismatch
    if (res.basis !== 'name') near ||= z.near;
    cmp.nameEn[src] = cmpEn(ex.nameEn?.value ?? null, r.nameEn);
    cmp.dob[src] = cmpDate(ex.dob?.value ?? null, r.dob);
    if (ex.address) {
      const rs = r.addresses.map((a) => cmpAddress(ex.address!.value, a));
      cmp.address[src] = rs.includes('match') ? 'match' : rs.includes('mismatch') ? 'mismatch' : rs.includes('not_comparable') ? 'not_comparable' : 'no_reference';
    }
  }
  // 電話：視覺讀數（clear）先算數；對各來源所有電話
  const listTels = (['utem', 'maxwell', 'db'] as Src[]).flatMap((src) => {
    const res = refs[src].ref ? resolveRef(idxs[src], staffNo, hkid, zh).row : null;
    return res?.tels ?? [];
  });
  const phoneFinal = resolvePhone(phoneIn.vision, ex.phone && !ex.phone.note ? ex.phone.value : null, listTels, phoneIn.hasCrop);
  if (phoneFinal.value) {
    for (const src of ['utem', 'maxwell', 'db'] as Src[]) {
      const row = refs[src].ref ? resolveRef(idxs[src], staffNo, hkid, zh).row : null;
      if (!row) continue;
      const rs = row.tels.map((t) => cmpTel(phoneFinal.value, t));
      cmp.phone[src] = rs.includes('match') ? 'match' : rs.includes('mismatch') ? 'mismatch' : 'no_reference';
    }
  }
  // 檔名姓名都係人手打嘅參考
  const fz = ex.nameZh && fileNameZh ? cmpZh(ex.nameZh.value, fileNameZh) : null;
  cmp.nameZh.file = fz ? (fz.near ? 'no_reference' : fz.r) : 'no_reference';
  near ||= !!fz?.near;

  const status = {} as DocCheck['status'];
  for (const f of FIELDS) status[f] = fieldStatus(Object.values(cmp[f]));
  const present: DocCheck['present'] = {
    hkid: !!ex.hkid,
    nameZh: !!ex.nameZh,
    nameEn: !!ex.nameEn,
    dob: !!ex.dob,
    address: !!ex.address,
    phone: !!phoneFinal.value,
  };

  // ---- 評級
  const hkidOk = ex.hkidValid;
  const idComplete = hkidOk && (present.nameZh || present.nameEn) && present.dob;
  const agree = FIELDS.filter((f) => status[f] === 'match').length;
  const bad = FIELDS.filter((f) => status[f] === 'mismatch' || status[f] === 'mixed');
  if (!present.hkid) reasons.push('hkid_missing');
  else if (!hkidOk) reasons.push('hkid_check_digit_fail');
  if (!present.nameZh && !present.nameEn) reasons.push('name_missing');
  if (!present.dob) reasons.push('dob_missing');
  if (!present.address) reasons.push(ex.flags.includes('address_declaration_only') ? 'address_unresolved_declaration' : 'address_unresolved');
  if (phoneFinal.status === 'unresolved') reasons.push('phone_unresolved', `phone_unresolved_${phoneFinal.reason}`);
  else if (phoneFinal.status === 'differs') reasons.push('phone_differs_from_list');
  else reasons.push('phone_confirmed_ok');
  if (ex.flags.includes('address_recipient_mismatch')) reasons.push('address_recipient_mismatch');
  if (ex.flags.includes('no_id_page')) reasons.push('no_id_page');
  if (ex.hkid?.note) reasons.push(`hkid_${ex.hkid.note}`);
  if (ex.flags.some((f) => f.startsWith('hkid_conflict'))) reasons.push('hkid_conflict_other_page');
  if (ex.flags.includes('id_hkid_multiple')) reasons.push('id_hkid_multiple');
  for (const f of bad) if (f !== 'phone') reasons.push(`mismatch_${f}`);
  if (agree === 0 && present.hkid) reasons.push('no_cross_reference');
  if (near) reasons.push('nameZh_near_match');

  let grade: Grade;
  const hkidBad = status.hkid === 'mismatch' || status.hkid === 'mixed';
  if (!present.hkid || !hkidOk || hkidBad || bad.length >= 2) grade = 'fail';
  else {
    const hkidFixed = ex.hkid?.note === 'repaired' || ex.hkid?.note === 'corrected_by_corroboration';
    const clean =
      idComplete &&
      present.address &&
      present.phone &&
      agree >= 2 &&
      bad.length === 0 &&
      phoneFinal.status !== 'differs' &&
      !ex.flags.includes('address_recipient_mismatch') &&
      !(hkidFixed && status.hkid !== 'match') &&
      !((ex.flags.includes('id_hkid_multiple') || ex.flags.some((f) => f.startsWith('hkid_conflict'))) && status.hkid !== 'match');
    grade = clean ? 'auto_ok' : 'review';
  }
  return { docId: ex.docId, staffNo, refs, cmp, status, nameZhNear: near, present, grade, reasons: [...new Set(reasons)].filter((r) => r !== 'phone_confirmed_ok'), phoneFinal };
}
