// 逐人逐欄 status（confirmed／review／missing）——純函數。
// 規則由 Opus 5.5 抽樣驗收後定：姓名／地址要視覺讀數 clear 且有獨立佐證先 confirmed；
// 同人多檔值唔同、near-match、低信心蓋過高信心一律 review（兩個值都留）。
import type { DocExtract } from './aggregate';
import { cmpZh, enTokens, normTel, normZh } from './compare';
import { recipientMatches } from './aggregate';
import type { PhoneFinal } from './phone';
import { editDistance } from './text';

export type FieldStatus = 'confirmed' | 'review' | 'missing';
export type AddressSource = 'address_proof' | 'application_form';
export interface FormAddrVision {
  docId: string;
  page: number;
  address: string | null;
  legible: 'clear' | 'unsure' | 'illegible';
}
export interface FieldOut {
  /** 地址來源（淨 address 欄有） */
  source?: AddressSource | 'id_card';
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
  /** 第二讀數分欄 legibility（冇就 fallback legible）：英文 unsure 唔好連中文讀數都丟 */
  legibleZh?: 'clear' | 'unsure';
  legibleEn?: 'clear' | 'unsure';
}
export interface DobVision {
  docId: string;
  dob: string | null; // YYYY-MM-DD（視覺讀 DD-MM-YYYY 後轉換）
  sex: string | null; // M／F
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

/** 第二次盲讀（人手視覺，唔睇第一讀數／本機 OCR）。 */
export interface AddrVision2 {
  docId: string;
  page: number;
  recipient: string | null;
  address: string | null;
  legible: 'clear' | 'unsure';
}

export interface PersonDocIn {
  docId: string;
  ex: DocExtract;
  fileNameZh: string | null;
  phone: PhoneFinal;
  listZh: string[];
  listEn: string[];
  listTels: string[];
  listDob?: string[]; // 名單／DB 生日（ISO）
}

export interface PersonIn {
  key: string;
  docs: PersonDocIn[];
  idDocId: string | null; // 身份證來源檔
  addressDocId: string | null; // 地址來源檔
  nameVision: NameVision | null;
  /** 姓名第二讀數（另一模型盲讀 out/name-vision-2.json；null／冇＝未做，維持現狀） */
  nameVision2?: NameVision | null;
  addrVision: AddrVision | null;
  addrVision2?: AddrVision2 | null;
  dobVision?: DobVision | null;
  /** 冇住址證明嘅人：申請表地址第一讀數（本模型）、第二讀數（另一模型盲讀；null＝檔未存在） */
  formAddrVision?: FormAddrVision[];
  formAddrVision2?: FormAddrVision[] | null;
  /** 申請表頁數／定位唔到 label 嘅頁數 */
  formPages?: number;
  formNoLabel?: number;
  today?: string;
}

export type PersonFields = Record<'hkid' | 'nameZh' | 'nameEn' | 'dob' | 'sex' | 'phone' | 'address', FieldOut>;

const out = (status: FieldStatus, value: string | null, candidates: string[] = [], reasons: string[] = []): FieldOut => ({
  status,
  value,
  candidates: [...new Set(candidates.filter((c) => c && c !== value))],
  reasons,
});

export function normAddr(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9\p{Script=Han}]/gu, '');
}

export function enKey(s: string | null | undefined): string {
  return enTokens(s).sort().join(' ');
}

/** 姓名第二讀數比對：卡面係乜字就乜字（唔做繁簡／異體正規化），淨忽略空白。 */
export function exactZh(s: string | null | undefined): string {
  return (s ?? '').normalize('NFC').replace(/\s+/g, '');
}
/** 英文名第二讀數比對：忽略大小寫、逗號、連續空白（次序要一致）。 */
export function exactEn(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').toUpperCase().replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim();
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

  // ---- dob：本機 OCR＋裁圖視覺兩個獨立讀數一致先 confirmed（名單生日只做加強／衝突檢查）；兩讀數唔同、年齡不合理、多檔唔同＝review
  const dv = p.dobVision ?? null;
  const dobLocal = p.docs.map((d) => d.ex.dob?.value ?? null);
  const dobMine = ex.dob?.value ?? dobLocal.find(Boolean) ?? null;
  const dobList = [...new Set(p.docs.flatMap((d) => d.listDob ?? []))];
  const dob = resolveDob(dobMine, dobLocal, dobList, dv, p.today ?? '2026-10-03');
  const sexLocal = p.docs.map((d) => d.ex.sex?.value ?? null);
  const sexMine = ex.sex?.value ?? sexLocal.find(Boolean) ?? null;
  const sex = resolveSex(sexMine, sexLocal, dv);

  // ---- nameZh
  const zhLocal = p.docs.map((d) => d.ex.nameZh?.value).filter((v): v is string => !!v);
  const zhFiles = p.docs.map((d) => d.fileNameZh).filter((v): v is string => !!v);
  const zhList = p.docs.flatMap((d) => d.listZh);
  const eqZh = (a: string | null, b: string | null) => cmpZh(a, b).r === 'match';
  const zhMine = ex.nameZh?.value ?? zhLocal[0] ?? null;
  let nameZh: FieldOut;
  const zhReasons: string[] = [];
  if (zhLocal.length > 1 && !same(zhLocal.map(normZh))) zhReasons.push('nameZh_differs_between_files');
  // 姓名一律以身份證副本為準（老闆 2026-10-04）：同檔名／名單差一字只係資訊，唔阻 confirmed
  const nearInfo = p.docs.some((d) => d.ex.nameZh && [...zhFiles, ...d.listZh].some((f) => cmpZh(d.ex.nameZh!.value, f).near));
  const v = p.nameVision;
  const v2zh = p.nameVision2 && (p.nameVision2.legibleZh ?? p.nameVision2.legible) === 'clear' ? p.nameVision2.zh : null;
  const v2en = p.nameVision2 && (p.nameVision2.legibleEn ?? p.nameVision2.legible) === 'clear' ? p.nameVision2.en : null;
  const info = nearInfo ? ['name_differs_from_filename_or_list'] : [];
  if (v && v.legible === 'clear' && v.zh) {
    const indep = zhFiles.some((f) => eqZh(v.zh, f)) || zhList.some((f) => eqZh(v.zh, f)); // 檔名／名單（獨立於本機 OCR）
    const viaLocal = zhLocal.some((f) => eqZh(v.zh, f));
    // 只靠本機 OCR 佐證、而檔名／名單差一字（near）→ 證據互相矛盾，唔准 confirmed
    const corroborated = indep || (viaLocal && !nearInfo);
    // 新規則：第一視覺 clear＋第二讀 clear＋逐字相同（卡面兩個獨立讀數）
    const twoReads = !!v2zh && exactZh(v2zh) === exactZh(v.zh);
    if ((corroborated || twoReads) && !zhReasons.includes('nameZh_differs_between_files')) {
      nameZh = out('confirmed', v.zh, zhLocal, info);
      nameZh.source = 'id_card';
    } else nameZh = out('review', v.zh, [...zhLocal, ...zhFiles, ...(v2zh && !twoReads ? [v2zh] : [])], [...zhReasons, ...info, corroborated || twoReads ? '' : v2zh ? 'nameZh_reads_disagree' : 'nameZh_vision_uncorroborated'].filter(Boolean));
  } else if (zhMine) nameZh = out('review', zhMine, zhLocal, [...zhReasons, ...info, v ? 'nameZh_vision_unsure' : 'nameZh_not_vision_read']);
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
    const twoReads = !!v2en && exactEn(v2en) === exactEn(v.en);
    if ((corroborated || twoReads) && !enReasons.includes('nameEn_differs_between_files')) {
      nameEn = out('confirmed', v.en.toUpperCase(), enLocal);
      nameEn.source = 'id_card';
    } else nameEn = out('review', v.en.toUpperCase(), [...enLocal, ...(v2en && !twoReads ? [v2en.toUpperCase()] : [])], [...enReasons, corroborated || twoReads ? '' : v2en ? 'nameEn_reads_disagree' : 'nameEn_vision_uncorroborated'].filter(Boolean));
  } else if (enLocal.length) {
    const longest = [...enLocal].sort((a, b) => enTokens(b).length - enTokens(a).length)[0];
    nameEn = out('review', longest, enLocal, [...enReasons, v ? 'nameEn_vision_unsure' : 'nameEn_not_vision_read']);
  } else nameEn = out('missing', null);

  // ---- phone
  const phone = resolvePersonPhone(p.docs.map((d) => d.phone));

  // ---- address
  let address = resolveAddress(p, idDoc, nameZh.value, nameEn.value);
  if (address.status === 'missing') address = resolveFormAddress(p, address);
  else address.source = 'address_proof';

  // 同一張卡 hkid 或姓名係 review（卡面質素差）→ dob／sex 就算兩讀數一致都要再加一個獨立佐證（名單生日 或 申請表視覺讀數）
  const weakName = (f: FieldOut) => f.status === 'review' && f.reasons.some((r) => /vision_unsure|vision_uncorroborated|reads_disagree|differs_between_files|not_vision_read/.test(r));
  const cardWeak = hkid.status !== 'confirmed' || weakName(nameZh) || weakName(nameEn);
  if (cardWeak) {
    if (dob.status === 'confirmed' && !(dob.value && dobList.includes(dob.value))) {
      dob.status = 'review';
      dob.reasons.push('card_weak_needs_extra_corroboration');
    }
    if (sex.status === 'confirmed') {
      sex.status = 'review';
      sex.reasons.push('card_weak_needs_extra_corroboration');
    }
  }
  if (nameEn.status === 'missing') nameEn.reasons.push(nameEnMissingReason(p, idDoc, v));
  return { hkid, nameZh, nameEn, dob, sex, phone, address };
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
    // 地址 confirmed 必須兩個獨立讀數一致：(第一視覺＝本機 OCR) 或 (第一視覺＝第二盲讀，兩者都 clear)；正規化後逐字比對，唔做模糊匹配
    const v2 = p.addrVision2 && p.addrVision2.legible === 'clear' && p.addrVision2.address ? p.addrVision2 : null;
    const sameAsRead2 = !!v2 && normAddr(v2.address) === normAddr(av.address);
    const corroborated = sameAsLocal || sameAsRead2;
    const cands = [local?.value, ...allLocal, v2 && !sameAsRead2 ? v2.address : null, v2 && sameAsRead2 ? v2.address : null].filter((x): x is string => !!x);
    if (recOk && (sameAsLocal || av.complete) && corroborated && !reasons.includes('address_differs_between_files')) return out('confirmed', av.address, cands);
    const rs = [...reasons];
    if (!recOk) rs.push('address_recipient_not_matched');
    if (!(sameAsLocal || av.complete)) rs.push('address_incomplete');
    if (!corroborated) rs.push(v2 ? 'address_reads_disagree' : 'address_single_read');
    return out('review', av.address, cands, rs);
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

export function ageOk(dob: string, today: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  const t = new Date(today + 'T00:00:00Z');
  let age = t.getUTCFullYear() - y;
  if (t.getUTCMonth() < mo - 1 || (t.getUTCMonth() === mo - 1 && t.getUTCDate() < d)) age--;
  return age >= 18 && age <= 80;
}

export function resolveDob(mine: string | null, local: (string | null)[], list: string[], v: DobVision | null, today: string): FieldOut {
  const locals = [...new Set(local.filter((x): x is string => !!x))];
  const vis = v && v.legible === 'clear' ? v.dob : null;
  if (!mine && !vis) return out('missing', null);
  const value = vis ?? mine!;
  const reasons: string[] = [];
  if (locals.length > 1) reasons.push('dob_differs_between_files');
  if (!ageOk(value, today)) reasons.push('dob_implausible');
  if (vis && mine && vis !== mine) reasons.push('dob_vision_differs_from_ocr');
  if (list.length && !list.includes(value)) reasons.push('dob_differs_from_list');
  const corroborated = !!vis && locals.includes(vis) && locals.length === 1; // 兩個獨立讀數（本機 OCR＋裁圖視覺）一致，冇例外
  if (!vis) reasons.push(v ? 'dob_vision_unsure' : 'dob_not_vision_read');
  else if (!corroborated) reasons.push('dob_uncorroborated');
  if (reasons.length) return out('review', value, [...locals, ...list, ...(vis ? [vis] : [])], reasons);
  return out('confirmed', value);
}

export function resolveSex(mine: string | null, local: (string | null)[], v: DobVision | null): FieldOut {
  const locals = [...new Set(local.filter((x): x is string => !!x))];
  const vis = v && v.legible === 'clear' ? v.sex : null;
  if (!mine && !vis) return out('missing', null);
  const value = vis ?? mine!;
  const reasons: string[] = [];
  if (locals.length > 1) reasons.push('sex_differs_between_files');
  if (vis && mine && vis !== mine) reasons.push('sex_vision_differs_from_ocr');
  if (!vis) reasons.push(v ? 'sex_vision_unsure' : 'sex_not_vision_read');
  else if (!locals.includes(vis)) reasons.push('sex_uncorroborated');
  return reasons.length ? out("review", value, [...locals, ...(vis ? [vis] : [])], reasons) : out('confirmed', value);
}

/** nameEn missing 必須有原因碼。 */
export function nameEnMissingReason(p: PersonIn, idDoc: PersonDocIn, v: NameVision | null): string {
  if (!p.idDocId || !idDoc.ex.hkid) return 'nameEn_missing_no_id_page';
  if (v && v.legible !== 'clear') return 'nameEn_missing_crop_unreadable';
  if (v && !v.en) return 'nameEn_missing_not_printed_or_cut';
  return 'nameEn_missing_other';
}

/**
 * 冇住址證明嘅人（老闆 2026-10-03）：地址用申請表所填。
 * confirmed ＝ 第一讀數＋第二讀數（另一模型盲讀）都 clear 且 normAddr 後逐字一致；
 * 同人多份申請表地址唔同 → review（form_address_differs_between_forms）；第二讀數檔未存在 → review（address_single_read）。
 */
export function resolveFormAddress(p: PersonIn, base: FieldOut): FieldOut {
  const first = (p.formAddrVision ?? []).filter((v) => v.legible === 'clear' && v.address);
  const src: AddressSource = 'application_form';
  if (!first.length) {
    const why = !p.formPages ? 'form_address_no_form' : (p.formAddrVision ?? []).length ? 'form_address_unreadable' : p.formNoLabel ? 'form_address_no_label' : 'form_address_not_read';
    return { ...base, reasons: [...base.reasons, why] };
  }
  const distinct = [...new Set(first.map((v) => normAddr(v.address)))];
  const cands = [...new Set(first.map((v) => v.address!))];
  if (distinct.length > 1) return { status: 'review', value: first[0].address, candidates: cands.slice(1), reasons: [...base.reasons, 'form_address_differs_between_forms'], source: src };
  const v1 = first[0];
  const seconds = p.formAddrVision2;
  if (!seconds) return { status: 'review', value: v1.address, candidates: [], reasons: [...base.reasons, 'address_single_read'], source: src };
  // 每份有第一讀數嘅申請表，都要有對應 clear 第二讀數且一致
  const reasons = [...base.reasons];
  const cand2: string[] = [];
  let ok = true;
  for (const f of first) {
    const s2 = seconds.find((x) => x.docId === f.docId && x.page === f.page);
    if (!s2 || s2.legible !== 'clear' || !s2.address) {
      ok = false;
      reasons.push('address_single_read');
      break;
    }
    if (normAddr(s2.address) !== normAddr(f.address)) {
      ok = false;
      cand2.push(s2.address);
      reasons.push('address_reads_disagree');
      break;
    }
  }
  return ok
    ? { status: 'confirmed', value: v1.address, candidates: [], reasons: [], source: src }
    : { status: 'review', value: v1.address, candidates: cand2, reasons: [...new Set(reasons)], source: src };
}
