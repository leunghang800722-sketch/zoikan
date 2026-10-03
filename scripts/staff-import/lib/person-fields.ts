// 逐人逐欄 status（confirmed／review／missing）——純函數。
// 規則由 Opus 5.5 抽樣驗收後定：姓名／地址要視覺讀數 clear 且有獨立佐證先 confirmed；
// 同人多檔值唔同、near-match、低信心蓋過高信心一律 review（兩個值都留）。
import type { DocExtract } from './aggregate';
import { cmpZh, enTokens, normTel, normZh } from './compare';
import { recipientMatches } from './aggregate';
import type { PhoneFinal } from './phone';
import { editDistance } from './text';

export type FieldStatus = 'confirmed' | 'review' | 'missing';
export interface FieldOut {
  status: FieldStatus;
  value: string | null;
  candidates: string[]; // 其他值（review 時兩個值都留）
  reasons: string[];
}

export interface NameVision {
  docId: string;
  zh: string | null;
  en: string | null;
  legible: 'clear' | 'unsure';
}
export interface AddrVision {
  docId: string;
  page: number;
  recipient: string | null;
  address: string | null;
  legible: 'clear' | 'unsure' | 'illegible';
  /** 視覺讀數見到完整地區行 */
  complete: boolean;
}

export interface PersonDocIn {
  docId: string;
  ex: DocExtract;
  fileNameZh: string | null;
  phone: PhoneFinal;
  listZh: string[];
  listEn: string[];
  listTels: string[];
}

export interface PersonIn {
  key: string;
  docs: PersonDocIn[];
  idDocId: string | null; // 身份證來源檔
  addressDocId: string | null; // 地址來源檔
  nameVision: NameVision | null;
  addrVision: AddrVision | null;
}

export type PersonFields = Record<'hkid' | 'nameZh' | 'nameEn' | 'dob' | 'sex' | 'phone' | 'address', FieldOut>;

const out = (status: FieldStatus, value: string | null, candidates: string[] = [], reasons: string[] = []): FieldOut => ({
  status,
  value,
  candidates: [...new Set(candidates.filter((c) => c && c !== value))],
  reasons,
});

export function normAddr(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9一-鿿]/g, '');
}

export function enKey(s: string | null | undefined): string {
  return enTokens(s).sort().join(' ');
}

const same = (vals: (string | null | undefined)[]) => new Set(vals.filter(Boolean)).size <= 1;

export function resolvePerson(p: PersonIn): PersonFields {
  const idDoc = p.docs.find((d) => d.docId === p.idDocId) ?? p.docs.find((d) => d.ex.hkid) ?? p.docs[0];
  const ex = idDoc.ex;

  // ---- hkid
  let hkid: FieldOut;
  if (!ex.hkid) hkid = out('missing', null);
  else {
    const reasons: string[] = [];
    if (!ex.hkidValid) reasons.push('check_digit_fail');
    if (ex.hkid.note === 'repaired' || ex.hkid.note === 'corrected_by_corroboration') reasons.push(`hkid_${ex.hkid.note}`);
    if (ex.flags.some((f) => f.startsWith('hkid_conflict'))) reasons.push('hkid_conflict_other_page');
    if (ex.flags.includes('id_hkid_multiple')) reasons.push('id_hkid_multiple');
    hkid = out(reasons.length ? 'review' : 'confirmed', ex.hkid.value, [], reasons);
  }

  // ---- dob／sex：以身份證為準，多檔唔同＝review
  const simple = (k: 'dob' | 'sex'): FieldOut => {
    const vals = p.docs.map((d) => d.ex[k]?.value ?? null);
    const mine = ex[k]?.value ?? vals.find(Boolean) ?? null;
    if (!mine) return out('missing', null);
    return same(vals) ? out('confirmed', mine) : out('review', mine, vals.filter((v): v is string => !!v), [`${k}_differs_between_files`]);
  };

  // ---- nameZh
  const zhLocal = p.docs.map((d) => d.ex.nameZh?.value).filter((v): v is string => !!v);
  const zhFiles = p.docs.map((d) => d.fileNameZh).filter((v): v is string => !!v);
  const zhList = p.docs.flatMap((d) => d.listZh);
  const eqZh = (a: string | null, b: string | null) => cmpZh(a, b).r === 'match';
  const zhMine = ex.nameZh?.value ?? zhLocal[0] ?? null;
  let nameZh: FieldOut;
  const zhReasons: string[] = [];
  if (zhLocal.length > 1 && !same(zhLocal.map(normZh))) zhReasons.push('nameZh_differs_between_files');
  if (p.docs.some((d) => d.ex.nameZh && [...zhFiles, ...d.listZh].some((f) => cmpZh(d.ex.nameZh!.value, f).near))) zhReasons.push('nameZh_near_match');
  const v = p.nameVision;
  if (v && v.legible === 'clear' && v.zh) {
    const indep = zhFiles.some((f) => eqZh(v.zh, f)) || zhList.some((f) => eqZh(v.zh, f)); // 檔名／名單（獨立於本機 OCR）
    const viaLocal = zhLocal.some((f) => eqZh(v.zh, f));
    // 只靠本機 OCR 佐證、而檔名／名單差一字（near）→ 證據互相矛盾，唔准 confirmed
    const corroborated = indep || (viaLocal && !zhReasons.includes('nameZh_near_match'));
    if (corroborated && !zhReasons.includes('nameZh_differs_between_files')) nameZh = out('confirmed', v.zh, zhLocal, []);
    else nameZh = out('review', v.zh, [...zhLocal, ...zhFiles], [...zhReasons, corroborated ? '' : 'nameZh_vision_uncorroborated'].filter(Boolean));
  } else if (zhMine) nameZh = out('review', zhMine, zhLocal, [...zhReasons, v ? 'nameZh_vision_unsure' : 'nameZh_not_vision_read']);
  else nameZh = out('missing', null);

  // ---- nameEn
  const enLocal = p.docs.map((d) => d.ex.nameEn?.value).filter((x): x is string => !!x);
  const enList = p.docs.flatMap((d) => d.listEn);
  const enReasons: string[] = [];
  if (enLocal.length > 1 && new Set(enLocal.map(enKey)).size > 1) {
    // 一個係另一個嘅子集＝斷行少尾段：取較長，但標 review
    enReasons.push('nameEn_differs_between_files');
  }
  if (p.docs.some((d) => d.ex.nameEn?.flags?.includes('nameEn_single_segment'))) enReasons.push('nameEn_single_segment');
  let nameEn: FieldOut;
  if (v && v.legible === 'clear' && v.en) {
    const k = enKey(v.en);
    const corroborated = enLocal.some((x) => enKey(x) === k) || enList.some((x) => enKey(x) === k);
    nameEn = corroborated && !enReasons.includes('nameEn_differs_between_files')
      ? out('confirmed', v.en.toUpperCase(), enLocal)
      : out('review', v.en.toUpperCase(), enLocal, [...enReasons, corroborated ? '' : 'nameEn_vision_uncorroborated'].filter(Boolean));
  } else if (enLocal.length) {
    const longest = [...enLocal].sort((a, b) => enTokens(b).length - enTokens(a).length)[0];
    nameEn = out('review', longest, enLocal, [...enReasons, v ? 'nameEn_vision_unsure' : 'nameEn_not_vision_read']);
  } else nameEn = out('missing', null);

  // ---- phone
  const phone = resolvePersonPhone(p.docs.map((d) => d.phone));

  // ---- address
  const address = resolveAddress(p, idDoc, nameZh.value, nameEn.value);

  return { hkid, nameZh, nameEn, dob: simple('dob'), sex: simple('sex'), phone, address };
}

const isLandline = (t: string) => /^[23]/.test(t);

export function resolvePersonPhone(phones: PhoneFinal[]): FieldOut {
  const withVal = phones.filter((p) => p.value);
  if (!withVal.length) return out('missing', null, [], [phones.find((p) => p.reason)?.reason ? `phone_unresolved_${phones.find((p) => p.reason)!.reason}` : 'phone_unresolved']);
  let vals = [...new Set(withVal.map((p) => normTel(p.value)!))];
  const list = new Set(phones.flatMap((p) => p.listValues));
  // 住宅電話（2／3 字頭）同手提唔算衝突，取手提
  if (vals.some((x) => !isLandline(x))) vals = vals.filter((x) => !isLandline(x));
  if (vals.length === 1) {
    const v = vals[0];
    const confirmed = withVal.some((p) => normTel(p.value) === v && p.status === 'confirmed') || list.has(v);
    const differs = withVal.some((p) => normTel(p.value) === v && p.status === 'differs') && !list.has(v);
    return differs
      ? out('review', v, [...list], ['phone_differs_from_list'])
      : confirmed
        ? out('confirmed', v)
        : out('review', v, [], ['phone_vision_only']);
  }
  // 多個值：差一位數而其中一個同名單一致 → 取名單一致嗰個
  const inList = vals.filter((x) => list.has(x));
  if (inList.length === 1 && vals.every((x) => x === inList[0] || editDistance(x, inList[0]) <= 1)) return out('confirmed', inList[0], vals, []);
  return out('review', null, vals, ['phone_conflict_between_files']);
}

function resolveAddress(p: PersonIn, idDoc: PersonDocIn, zh: string | null, en: string | null): FieldOut {
  const addrDoc = p.docs.find((d) => d.docId === p.addressDocId) ?? p.docs.find((d) => d.ex.address);
  const local = addrDoc?.ex.address ?? null;
  const reasons: string[] = [];
  const allLocal = p.docs.map((d) => d.ex.address?.value).filter((x): x is string => !!x);
  if (allLocal.length > 1 && new Set(allLocal.map(normAddr)).size > 1) reasons.push('address_differs_between_files');
  if (local?.flags?.includes('address_truncated')) reasons.push('address_truncated');
  const av = p.addrVision;
  void idDoc;
  if (av && av.legible === 'clear' && av.address) {
    const recOk = recipientOk(av.recipient, zh, en);
    const sameAsLocal = !!local && normAddr(local.value) === normAddr(av.address);
    if (recOk && (sameAsLocal || av.complete) && !reasons.includes('address_differs_between_files')) return out('confirmed', av.address, local ? [local.value] : []);
    return out('review', av.address, local ? [local.value] : [], [...reasons, recOk ? '' : 'address_recipient_not_matched', sameAsLocal || av.complete ? '' : 'address_incomplete'].filter(Boolean));
  }
  if (local) return out('review', local.value, allLocal, [...reasons, av ? 'address_vision_unsure' : 'address_not_vision_read']);
  const decl = p.docs.some((d) => d.ex.flags.includes('address_declaration_only'));
  return out('missing', null, [], [decl ? 'address_unresolved_declaration' : 'address_unresolved']);
}

export function recipientOk(recipient: string | null, zh: string | null, en: string | null): boolean {
  if (!recipient) return false;
  if (/[一-鿿]/.test(recipient)) {
    const r = recipient.replace(/(先生|小姐|女士|\s)/g, '');
    return !!zh && cmpZh(r, zh).r === 'match';
  }
  return recipientMatches(recipient, en, zh) === true;
}
