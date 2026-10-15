// WP-GUARD-OCR §29：模型輸出嘅正規化＋格式驗證。純函數。
// 兩次獨立讀「正規化後逐字相同」＋格式驗證通過先 confirmed；其餘 review／missing。
import { canonicalHkid, formatHkid, hkidCheckDigitValid, normalizeTelHk } from "@/lib/guards/identity";
import type { OcrFieldKey } from "./config";
import { normalizeHkAddress, type AddressEdit } from "./hk-address";
import type { RankedCandidate } from "./rank";

export type FieldStatus = "confirmed" | "review" | "missing";

/** 模型答「睇唔清」嘅各種寫法（含 null／空字串）。 */
export function isUnclear(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const s = raw.normalize("NFKC").trim().toLowerCase();
  return s === "" || s === "unclear" || s === "null" || s === "n/a" || s === "none" || s === "-" || s === "?" || /^[?？\s_.\-]+$/.test(s) || s.includes("unclear");
}

function cleanText(raw: string): string {
  // 去控制字元、折疊空白；唔做任何內容改寫
  return raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

function validCalendar(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 解析出生日期 → ISO（YYYY-MM-DD）；唔識或者曆法唔合 → null。香港慣例 DD-MM-YYYY。 */
export function parseDob(raw: string): string | null {
  const s = cleanText(raw).toUpperCase();
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (m) return validCalendar(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${pad(+m[2]!)}-${pad(+m[3]!)}` : null;
  m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})$/);
  if (m) return validCalendar(+m[3]!, +m[2]!, +m[1]!) ? `${m[3]}-${pad(+m[2]!)}-${pad(+m[1]!)}` : null;
  m = s.match(/^(\d{1,2})[\s\-/.]*([A-Z]{3,4})[\s\-/.,]*(\d{4})$/);
  if (m && MONTHS[m[2]!]) return validCalendar(+m[3]!, MONTHS[m[2]!]!, +m[1]!) ? `${m[3]}-${pad(MONTHS[m[2]!]!)}-${pad(+m[1]!)}` : null;
  return null;
}

/** 出生年份合理範圍：現時 16–90 歲（保安員）。 */
function dobPlausible(iso: string, now: Date = new Date()): boolean {
  const y = Number(iso.slice(0, 4));
  const age = now.getUTCFullYear() - y;
  return age >= 16 && age <= 90;
}

/** 簡體專用字（同繁體唔同形）——部分清單，淨係做「疑似簡體」警示（reason simplified_chars）；唔係完整判斷。 */
const SIMPLIFIED_ONLY = new Set(
  "陈张刘黄吴严谢叶华国伟马郑邓冯萧罗蒋韩许杨陆龙赵钱孙闫贺顾师齐汤贾钟庞龚丽艳红绿蓝阳阴阵际难鸿鸣鹏鹤鲁鲍鲜鸡鱼麦齿龄龟见观规觉视览亲计认讯记讲设访证评识诚诗话该详语误说请诸读课谁调谈谊谋谓谦谨负财货贤质购贯贵贸费资赏赖赞趋跃践踪轩软轮轻载轿辉输辈辑边辽达迁运这连迟进远违选递逻遗邮邻酿释针钉钓钢钻铁铃铜银铭链销锐锋锦键锻镇长门闪闭问闯间闲闷闹阅队阶陕险随隐雏雾霁静页顶项顺须顿预领频题颜额风飞饭饮饰饱馆驱驶驻驾骄验骑鸟鸭".split(""),
);
// 清單只放「簡體專用」字；繁簡同形嘅字（李、王、林、梁、何、蔡、麻、紫…）唔入清單
function hasSimplifiedOnly(s: string): boolean {
  for (const ch of s) if (SIMPLIFIED_ONLY.has(ch)) return true;
  return false;
}

export interface Normalized {
  /** 比較用 canonical */
  canon: string;
  /** 顯示／填入表單用 */
  display: string;
  /** 格式驗證通過（hkid check digit、日期曆法＋年份、香港電話、含中文字…） */
  valid: boolean;
  /** valid=false 嘅原因碼（唔含值） */
  reason?: string;
  /** WP-OCR-3：額外候選（電話 9–10 位剔走疑似分格線 1 後嘅 8 位解，≤2）；只入候選池，唔自動確認 */
  extra?: string[];
  /** WP-OCR-2（地址）：形近字糾錯建議（只喺命中屋邨／街道／地區表而原文寫法唔同時有）；唔自動套用 */
  suggested?: string;
  edits?: AddressEdit[];
  /** WP-OCR-2（地址）：唔做形近字歸一嘅 canon（候選排序去重用） */
  strict?: string;
}

/**
 * WP-OCR-3：電話分格線防呆。9 位剔走一個「1」、10 位剔走兩個「1」，得出首位 2–9 嘅 8 位數；
 * 解唯一或者最多 2 個（多於 2 個＝太不確定，唔出候選）。回傳去重後嘅解（已按字串排序，確定性）。
 */
export function phoneGridlineCandidates(digits: string): string[] {
  if (!/^\d{9,10}$/.test(digits)) return [];
  const drop = digits.length - 8;
  const ones: number[] = [];
  for (let i = 0; i < digits.length; i++) if (digits[i] === "1") ones.push(i);
  const out = new Set<string>();
  const pick = (from: number, left: number, removed: number[]) => {
    if (left === 0) {
      const s = digits.split("").filter((_, i) => !removed.includes(i)).join("");
      if (/^[2-9]\d{7}$/.test(s)) out.add(s);
      return;
    }
    for (let k = from; k < ones.length; k++) pick(k + 1, left - 1, [...removed, ones[k]!]);
  };
  pick(0, drop, []);
  const list = [...out].sort();
  return list.length >= 1 && list.length <= 2 ? list : [];
}

export function normalizeField(key: OcrFieldKey, raw: string, now: Date = new Date()): Normalized {
  const t = cleanText(raw);
  switch (key) {
    case "hkid": {
      const c = canonicalHkid(t);
      if (!c) return { canon: t.toUpperCase().replace(/[\s()（）]/g, ""), display: t, valid: false, reason: "hkid_format" };
      return hkidCheckDigitValid(c) ? { canon: c, display: formatHkid(c), valid: true } : { canon: c, display: formatHkid(c), valid: false, reason: "hkid_check_digit" };
    }
    case "dob": {
      const iso = parseDob(t);
      if (!iso) return { canon: t.toUpperCase(), display: t, valid: false, reason: "dob_calendar" };
      return dobPlausible(iso, now) ? { canon: iso, display: iso, valid: true } : { canon: iso, display: iso, valid: false, reason: "dob_year_implausible" };
    }
    case "sex": {
      const u = t.toUpperCase();
      const s = u === "M" || u === "MALE" || t === "男" ? "M" : u === "F" || u === "FEMALE" || t === "女" ? "F" : null;
      return s ? { canon: s, display: s, valid: true } : { canon: u, display: t, valid: false, reason: "sex_format" };
    }
    case "phone": {
      const n = normalizeTelHk(t);
      if (!n) return { canon: t.replace(/\D/g, ""), display: t, valid: false, reason: "phone_format" };
      if (/^[2-9]\d{7}$/.test(n)) return { canon: n, display: n, valid: true };
      const grid = phoneGridlineCandidates(n);
      return grid.length ? { canon: n, display: n, valid: false, reason: "phone_gridline_suspect", extra: grid } : { canon: n, display: n, valid: false, reason: "phone_not_hk" };
    }
    case "name_zh": {
      const c = t.replace(/\s+/g, "").replace(/[·・•‧]/g, "·"); // 間隔號統一（· ・ • ‧）
      // 每個字都要係中文字（容許間隔號 ·），任何 ?／□／*／英數佔位 → review
      const allCjk = c.length > 0 && /^[\p{Script=Han}·]+$/u.test(c) && /\p{Script=Han}/u.test(c);
      const ok0 = allCjk && c.length >= 2 && c.length <= 12;
      if (ok0 && hasSimplifiedOnly(c)) return { canon: c, display: c, valid: false, reason: "simplified_chars" };
      return { canon: c, display: c, valid: ok0, ...(ok0 ? {} : { reason: "name_zh_format" }) };
    }
    case "name_en": {
      const c = t.toUpperCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
      const ok = /^[A-Z][A-Z'’.\- ]*[A-Z.]$/.test(c) && c.length >= 3 && c.length <= 80;
      return { canon: c, display: c, valid: ok, ...(ok ? {} : { reason: "name_en_format" }) };
    }
    case "address": {
      // WP-OCR-2：canon 由 normalizeHkAddress（形近字／全半形／空白標點／單位詞歸一）；原讀數保留喺 display；
      // 形近字糾錯只出 suggested／edits（唔改原文）。逗號／空白差異忽略，數字之間嘅 / - 同 號／樓／室／座 保留。
      const r = normalizeHkAddress(t);
      const ok = r.canon.length >= 6 && r.canon.length <= 200;
      return { canon: r.canon, display: t, valid: ok, strict: r.strict, ...(ok ? {} : { reason: "address_format" }), ...(r.edits.length ? { suggested: r.suggested, edits: r.edits } : {}) };
    }
  }
}

/** WP-OCR-1：入職表手寫值 vs 身份證印刷值交叉核對結果。 */
export type CrossResult = "match" | "differs" | "unreadable";
export interface CrossInfo {
  /** 對照嘅係邊份文件（身份證欄：onboarding_form；入職表欄：id_card） */
  against: "id_card" | "onboarding_form";
  result: CrossResult;
}

/**
 * WP-OCR-1：入職表（手寫）值 vs 身份證（印刷、已核實）值。用現有 canon 比較（HKID 全字、dob 比 ISO 日期、中文姓名全字）。
 * unreadable＝任何一邊睇唔清／空，或者手寫值本身格式唔成立（讀唔穿，唔當「唔一致」）；differs＝手寫值格式成立但同身份證唔同。
 */
export function crossCheck(formValue: string | null | undefined, idValue: string | null | undefined, field: OcrFieldKey, now: Date = new Date()): CrossResult {
  if (isUnclear(formValue) || isUnclear(idValue)) return "unreadable";
  const nf = normalizeField(field, formValue!, now);
  const ni = normalizeField(field, idValue!, now);
  if (nf.canon === ni.canon) return nf.canon === "" ? "unreadable" : "match";
  return nf.valid && ni.valid ? "differs" : "unreadable";
}

export interface FieldResult {
  status: FieldStatus;
  /** confirmed＝確認值；review＝預填（候選排序最高分；同分讀 A 優先）；missing＝"" */
  value: string;
  /** review：候選值（按排序，去重，≤4）。confirmed／missing 為空（舊欄位，保留向後相容） */
  candidates: string[];
  /** WP-OCR-4（additive）：排序候選＋來源＋分數＋驗證結果；confirmed／missing 為空陣列 */
  candidates_ranked: RankedCandidate[];
  /** 原因碼（無值）：reads_differ｜one_read_unclear｜invalid_format 類｜unclear */
  reason?: string;
  /** WP-OCR-4（additive）：第三讀仲裁嘅結果類別（淨標籤）：agree_a／agree_b＝仲裁同其中一讀一致且 valid（confirmed）；independent＝仲裁讀到第三個值；unclear＝仲裁睇唔清 */
  arbiter?: "agree_a" | "agree_b" | "independent" | "unclear";
  /** WP-OCR-1（additive）：同另一份文件嘅交叉核對（只有兩段式下伺服器有 refs 先有） */
  cross?: CrossInfo;
}
