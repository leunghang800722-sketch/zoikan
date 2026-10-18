// 逐頁結果 → 逐人結果（純函數）。
import {
  classifyPage,
  RE_NOT_ADDRESS_DOC,
  RE_PO_BOX,
  extractAddress,
  extractForm,
  extractIdCard,
  embeddedCardLines,
  extractPermit,
  scanPageHkids,
  type AddressResult,
  type Classified,
  type Field,
  type FormResult,
  type IdCardResult,
} from './extract';
import { hkidCheckDigitValid } from './hkid';
import { cmpZh } from './compare';
import { editDistance } from './text';

export { editDistance };
import type { OcrPage } from './ocr';

export interface DocExtract {
  docId: string;
  pageCount: number;
  pages: Classified[];
  hkid: Field | null;
  hkidValid: boolean;
  nameZh: Field | null;
  nameEn: Field | null;
  dob: Field | null;
  sex: Field | null;
  address: Field | null;
  addressRecipient: string | null;
  phone: Field | null;
  aux: {
    formHkid: Field | null;
    permitHkid: Field | null;
    printedHkid: Field | null;
    formAddress: Field | null;
    formNameZh: Field | null;
    formNameEn: Field | null;
  };
  flags: string[];
  /** hkid 係由旋轉／300dpi 重做頁救返嚟（rot 度數） */
  rescuedRot: number | null;
}

function nameTokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .toUpperCase()
    .replace(/\b(MR|MS|MRS|MISS|DR)\b\.?/g, '')
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 2)
    .sort();
}

export function recipientMatches(recipient: string | null, nameEn: string | null, nameZh: string | null = null): boolean | null {
  if (recipient && /[\u4e00-\u9fff]/.test(recipient)) {
    if (!nameZh) return null;
    const r = recipient.replace(/(先生|小姐|女士|\s)/g, '');
    return r === nameZh || (r.length >= 2 && nameZh.includes(r)) || (nameZh.length >= 2 && r.includes(nameZh));
  }
  if (!recipient || !nameEn) return null;
  // 收件人名可能冇空格（OCR 黐埋）：用純字母比對
  const flat = recipient.toUpperCase().replace(/[^A-Z]/g, '');
  const parts = nameTokens(nameEn).filter((t) => t.length >= 2);
  if (flat.length >= 6 && parts.length >= 2 && parts.every((t) => flat.includes(t))) return true;
  const a = nameTokens(recipient);
  const b = nameTokens(nameEn);
  if (!a.length || !b.length) return null;
  const setB = new Set(b);
  return a.every((t) => setB.has(t)) || b.every((t) => new Set(a).has(t));
}

function bestBy<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bs = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bs) {
      bs = s;
      best = it;
    }
  }
  return best;
}

/** 頁面層面嘅住址候選（正規化文字）——02 用嚟搵「喺多個檔重複出現」嘅公司／範本地址。 */
export function addressCandidates(pages: OcrPage[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    if (p.alt) continue;
    if (!classifyPage(p).kinds.includes('address_proof')) continue;
    const a = extractAddress(p.page, p.lines);
    if (a.address) out.push(a.address.value.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, ''));
  }
  return [...new Set(out)];
}

export function aggregateDoc(
  docId: string,
  pages: OcrPage[],
  hints: { fileNameZh?: string | null; denyAddr?: Set<string> } = {},
): DocExtract {
  const classified = pages.map(classifyPage);
  const ids: IdCardResult[] = [];
  const idAlt = new Map<IdCardResult, number>(); // 候選頁嘅旋轉度數
  const addrs: AddressResult[] = [];
  const forms: FormResult[] = [];
  const permitHkids: Field[] = [];
  const printedAll: Field[] = [];
  const flagsTmp: string[] = [];
  pages.forEach((p, i) => {
    const kinds = classified[i].kinds;
    if (kinds.includes('id_card')) {
      // TE-2：夾喺牌照頁等嘅細身份證副本——抽取只對卡區行做（避免掃到整頁其他資料）
      const r = extractIdCard(p.page, classified[i].embeddedCard ? (embeddedCardLines(p.lines) ?? p.lines) : p.lines);
      ids.push(r);
      if (p.alt) idAlt.set(r, p.rot ?? 0);
    }
    if (kinds.includes('address_proof')) {
      const a = extractAddress(p.page, p.lines);
      const key = a.address?.value.toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fff]/g, '');
      if (a.address && key && hints.denyAddr?.has(key)) flagsTmp.push('address_company_template');
      else if (a.address) addrs.push(a);
    }
    if (kinds.includes('application_form')) forms.push(extractForm(p.page, p.lines));
    if (kinds.includes('sia_permit')) {
      const r = extractPermit(p.page, p.lines);
      if (r.hkid) permitHkids.push(r.hkid);
    }
    // TE-3：每頁（包括 other／certificate）每行「行內任何位置」搵印刷 HKID，check digit 通過先收；身份證卡頁本身已由 extractIdCard 處理
    if (!p.alt && !kinds.includes('id_card')) printedAll.push(...scanPageHkids(p.page, p.lines));
  });

  const flags: string[] = [...new Set(flagsTmp)];
  // 一個檔可能夾住家人／擔保人嘅身份證：逐張卡打分，揀「屬於呢個人」嗰張，所有欄位跟同一張卡
  const formHkidPre = bestBy(forms.map((f) => f.hkid).filter((f): f is Field => !!f), (f) => (hkidCheckDigitValid(f.value) ? 10 : 0) + f.conf);
  const permitHkidPre = bestBy(permitHkids, (f) => f.conf);
  const own = new Set([formHkidPre, permitHkidPre].filter((f): f is Field => !!f && hkidCheckDigitValid(f.value)).map((f) => f.value));
  const cardScore = (r: IdCardResult): number => {
    let sc = 0;
    if (r.hkid && hkidCheckDigitValid(r.hkid.value)) sc += 5;
    if (r.hkid && own.has(r.hkid.value)) sc += 10; // 許可證／申請表都係本人嘅
    if (r.nameZh && hints.fileNameZh) {
      const c = cmpZh(r.nameZh.value, hints.fileNameZh);
      if (c.r === 'match') sc += 20;
      else if (c.near) sc += 8;
    }
    if (r.dob) sc += 1;
    return sc + (r.hkid?.conf ?? 0);
  };
  const card = bestBy(ids, cardScore);
  const validHkids = new Set(ids.map((r) => r.hkid).filter((f): f is Field => !!f && hkidCheckDigitValid(f.value)).map((f) => f.value));
  if (validHkids.size > 1) flags.push('id_hkid_multiple');
  const hkid = card?.hkid ?? null;
  let hkidFinal = hkid;
  // 同一張卡缺嘅欄，只可以由同一個 hkid 嘅其他卡補
  const sameCards = ids.filter((r) => r === card || (r.hkid && hkid && r.hkid.value === hkid.value));
  const pick = <K extends 'nameZh' | 'nameEn' | 'dob' | 'sex'>(k: K): Field | null =>
    card?.[k] ?? bestBy(sameCards.map((r) => r[k]).filter((f): f is Field => !!f), (f) => f.conf);
  const nameZh = pick('nameZh');
  const nameEn = pick('nameEn');
  const dob = pick('dob');
  const sex = pick('sex');
  if (!ids.length) flags.push('no_id_page');

  // 住址證明補漏：寄俾本人（收件人對得上身份證姓名）嘅銀行結單／警方牌照信／稅務通知／水費單等，
  // 頁面可能被分類做 bank／sia_permit／other。只喺冇正式住址證明頁時先用；信箱地址、僱主稅表、法定聲明排除。
  if (!addrs.length) {
    pages.forEach((p, i) => {
      const kinds = classified[i].kinds;
      if (p.alt || kinds.includes('application_form') || kinds.includes('id_card') || kinds.includes('address_declaration') || kinds.includes('address_proof')) return;
      const text = p.lines.map((l) => l.t).join('\n');
      if (RE_NOT_ADDRESS_DOC.test(text)) return;
      const a = extractAddress(p.page, p.lines);
      if (!a.address || !a.recipient || RE_PO_BOX.test(a.address.evidence)) return;
      if (recipientMatches(a.recipient, nameEn?.value ?? null, nameZh?.value ?? null) !== true) return;
      a.address.flags = [...(a.address.flags ?? []), 'mailed_candidate'];
      addrs.push(a);
    });
  }

  // 地址
  const addrPick = bestBy(addrs, (a) => {
    const m = recipientMatches(a.recipient, nameEn?.value ?? null, nameZh?.value ?? null);
    return (m ? 100 : 0) + (a.recipient ? 10 : 0) + a.address!.evidence.split('|').length * 3 + a.address!.conf;
  });
  let address = addrPick?.address ?? null;
  const recipient = addrPick?.recipient ?? null;
  if (address && (nameEn || nameZh)) {
    const m = recipientMatches(recipient, nameEn?.value ?? null, nameZh?.value ?? null);
    if (m === true) address = { ...address, level: 'high', note: 'recipient_match' };
    else if (m === false) {
      address = { ...address, level: 'low', note: 'recipient_mismatch' };
      flags.push('address_recipient_mismatch');
    }
  }
  if (!addrs.length) flags.push(classified.some((c) => c.kinds.includes('address_declaration')) ? 'address_declaration_only' : 'no_address_page');

  // 電話
  const phones = forms.map((f) => f.phone).filter((f): f is Field => !!f);
  const phone = bestBy(phones, (f) => f.conf);
  if (!forms.length) flags.push('no_form_page');

  const formHkid = bestBy(forms.map((f) => f.hkid).filter((f): f is Field => !!f), (f) => (hkidCheckDigitValid(f.value) ? 10 : 0) + f.conf);
  const permitHkid = bestBy(permitHkids, (f) => f.conf);
  // TE-3：身份證頁冇讀到 HKID 時，後備來源優先次序 permit > printed > form（只收 check digit 通過；印刷來源多於一個唯一值＝可能夾家人，唔用）
  const printedVals = new Set(printedAll.map((f) => f.value));
  const printedHkid = printedVals.size === 1 ? bestBy(printedAll, (f) => f.conf) : null;
  if (printedVals.size > 1) flags.push('hkid_printed_multiple');
  if (!hkidFinal) {
    const alt = ([['permit', permitHkid], ['printed', printedHkid], ['form', formHkid]] as const).find(([, f]) => f && hkidCheckDigitValid(f.value));
    if (alt) {
      hkidFinal = { ...alt[1]!, level: 'low', note: `secondary_source_${alt[0]}` };
      flags.push('hkid_from_secondary');
    }
  }
  if (hkidFinal) {
    // 身份證頁讀出嚟 check digit 唔啱（或靠修補）時，若許可證／申請表有 check digit 啱而且只差 ≤2 字，視為 OCR 錯字，採用佢（保留 note）
    const needFix = !hkidCheckDigitValid(hkidFinal.value) || hkidFinal.note === 'repaired';
    if (needFix) {
      for (const f of [permitHkid, formHkid]) {
        if (f && hkidCheckDigitValid(f.value) && editDistance(f.value, hkidFinal.value) <= 2) {
          hkidFinal = { ...hkidFinal, value: f.value, level: 'medium', note: 'corrected_by_corroboration' };
          flags.push('hkid_corrected');
          break;
        }
      }
    }
    for (const [k, f] of [['form', formHkid], ['permit', permitHkid]] as const) {
      if (f && hkidCheckDigitValid(f.value) && f.value !== hkidFinal.value) flags.push(`hkid_conflict_${k}`);
    }
  }

  return {
    docId,
    pageCount: pages.filter((p) => !p.alt).length,
    pages: classified.filter((_, i) => !pages[i].alt),
    hkid: hkidFinal,
    hkidValid: !!hkidFinal && hkidCheckDigitValid(hkidFinal.value),
    nameZh,
    nameEn,
    dob,
    sex,
    address,
    addressRecipient: recipient,
    phone,
    aux: {
      formHkid,
      permitHkid,
      printedHkid,
      formAddress: bestBy(forms.map((f) => f.address).filter((f): f is Field => !!f), (f) => f.conf),
      formNameZh: bestBy(forms.map((f) => f.nameZh).filter((f): f is Field => !!f), (f) => f.conf),
      formNameEn: bestBy(forms.map((f) => f.nameEn).filter((f): f is Field => !!f), (f) => f.conf),
    },
    flags,
    rescuedRot: card && idAlt.has(card) && !ids.some((r) => !idAlt.has(r) && r.hkid && hkidCheckDigitValid(r.hkid.value)) ? idAlt.get(card)! : null,
  };
}
