// 同一 hkid 多個檔 → 一個人嘅欄位合併規則（純函數）。
//  - 身份證資料（hkid／姓名／出生日期／性別）：取評級較好（check digit 通過、信心高）嗰份
//  - 地址：取住址證明日期較新嗰份；日期抽唔到而地址又唔同 → review
//  - 電話：取較新申請表嗰份；申請表日期手寫、唔抽 → 多個唔同電話一律 review（兩個值都留）
//  - 工號：MP＋U 全部掛落同一人
import { cmpAddress, normTel } from './compare';

export interface MergeDoc {
  docId: string;
  staffNo: string | null;
  grade: 'auto_ok' | 'review' | 'fail';
  hkidConf: number;
  id: { hkid: string | null; nameZh: string | null; nameEn: string | null; dob: string | null; sex: string | null };
  address: { value: string; date: string | null; level: string } | null;
  phone: { value: string; status: string } | null;
}

export interface Merged {
  idDocId: string;
  hkid: string | null;
  nameZh: string | null;
  nameEn: string | null;
  dob: string | null;
  sex: string | null;
  address: string | null;
  addressDocId: string | null;
  addresses: string[];
  phone: string | null;
  phones: string[];
  staffNos: string[];
  reasons: string[];
}

const RANK = { auto_ok: 0, review: 1, fail: 2 } as const;

export function mergeGroup(docs: MergeDoc[]): Merged {
  const reasons: string[] = [];
  const ids = [...docs].sort((a, b) => RANK[a.grade] - RANK[b.grade] || b.hkidConf - a.hkidConf);
  const idDoc = ids[0];
  // 個別欄位 id 文件冇，就由同一 hkid 嘅其他檔補
  const pickId = <K extends keyof MergeDoc['id']>(k: K): string | null => idDoc.id[k] ?? ids.find((d) => d.id[k])?.id[k] ?? null;

  const addrs = docs.filter((d) => d.address);
  let address: MergeDoc | null = null;
  if (addrs.length) {
    const dated = addrs.filter((d) => d.address!.date);
    if (dated.length === addrs.length) address = [...dated].sort((a, b) => b.address!.date!.localeCompare(a.address!.date!))[0];
    else {
      address = addrs[0];
      const anyDiff = addrs.some((d) => cmpAddress(d.address!.value, addrs[0].address!.value) === 'mismatch');
      if (addrs.length > 1 && anyDiff) reasons.push('address_dates_unknown_conflict');
    }
  }
  const phoneDocs = docs.filter((d) => d.phone && d.phone.value);
  const phones = [...new Set(phoneDocs.map((d) => normTel(d.phone!.value)).filter((x): x is string => !!x))];
  let phone: string | null = null;
  if (phones.length === 1) phone = phones[0];
  else if (phones.length > 1) reasons.push('phone_conflict_between_files');
  if (phoneDocs.some((d) => d.phone!.status === 'differs')) reasons.push('phone_differs_from_list');
  return {
    idDocId: idDoc.docId,
    hkid: pickId('hkid'),
    nameZh: pickId('nameZh'),
    nameEn: pickId('nameEn'),
    dob: pickId('dob'),
    sex: pickId('sex'),
    address: address?.address!.value ?? null,
    addressDocId: address?.docId ?? null,
    addresses: [...new Set(addrs.map((d) => d.address!.value))],
    phone,
    phones,
    staffNos: [...new Set(docs.map((d) => d.staffNo).filter((x): x is string => !!x))],
    reasons,
  };
}
