// WP-STAFF-FIELDS：新欄正規化／驗證／多來源確認規則（純函數，無 PII 寫死）。
// 規則：兩個獨立來源正規化後逐字相同先 confirmed；讀數唔同一律 review（候選全留）；睇唔清／冇＝missing，唔估。
import { normalizeTelHk } from '@/lib/guards/identity';
import { HKICL_BANK_OPTIONS } from '@/lib/longterm-payroll/hkicl-bank-codes';
import { rankPool, type RankedCandidate, type RankInput } from '@/lib/guards/ocr/rank';
import type { ReadConfidence } from '@/lib/guards/ocr/field-read';
import { acctDigitsCheck } from './hkicl-digits';

export const TODAY = '2026-10-05';
export type Status = 'confirmed' | 'review' | 'missing';
export type SrcKind = 'typed_maxwell' | 'typed_uteam' | 'typed_pe' | 'printed_ref' | 'printed_ocr' | 'printed_read1' | 'printed_read2' | 'hand_read1' | 'hand_read2' | 'bank_copy_read1' | 'bank_copy_read2';
/** WP-OCR-4：confidence／alternatives 係 optional（舊呼叫照用）；alternatives 必須已經用同一個 norm 正規化，只用嚟喺 sources_disagree 時排序，唔影響確認規則。 */
export interface Cand { src: SrcKind; value: string; ref?: string; confidence?: ReadConfidence; alternatives?: string[] }
export interface FieldOut { value: string | null; status: Status; candidates: { value: string; sources: string[] }[]; sources: string[]; reasons: string[]; /** WP-OCR-4（additive）：sources_disagree 時按驗證排序嘅候選（≤4，與 path A 同一排序函數） */ candidates_ranked?: RankedCandidate[] }

// ---------- 正規化 ----------
/** 日期：接受 yyyy-mm-dd／yyyy.m.d／d-m-yy(yy)（香港寫法 日-月-年）；回傳 ISO 或 null（曆法不合）。 */
export function normDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').trim().replace(/[年月/.\s,，、_]+/g, '-').replace(/日/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const parts = s.split('-').filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  let y: number, m: number, d: number;
  if (parts[0].length === 4) [y, m, d] = parts.map(Number);
  else {
    [d, m, y] = parts.map(Number);
    if (parts[2].length === 2) y += 2000;
    else if (parts[2].length !== 4) return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export const expiryInRange = (iso: string) => iso >= '2015-01-01' && iso <= '2040-12-31';
export const joinInRange = (iso: string) => iso >= '1990-01-01' && iso <= TODAY;
export const issueInRange = (iso: string) => iso >= '2000-01-01' && iso <= TODAY;

/** 許可證號碼：<字母1–2>-<6位>-<1位檢查碼>[-<3位序號>]（打字名單常欠序號；牌照卡有），輸出帶連字符大寫。格式由牌照頁實物歸納（見 README）。 */
export function normPermitNo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').toUpperCase().replace(/[\s_.–—−]/g, '').replace(/-/g, '');
  const m = /^([A-Z]{1,2})(\d{6})([0-9A])(\d{3})?$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? `-${m[4]}` : ''}` : null;
}
/** 牌照號碼前段應等於身份證號（字母＋6 位＋檢查碼）——一致性檢查，唔當額外確認。 */
export const permitMatchesHkid = (permit: string, hkidCanon: string | null) => !!hkidCanon && permit.replace(/-/g, '').slice(0, hkidCanon.length) === hkidCanon;

export const digitsOnly = (raw: string | null | undefined) => (raw ?? '').normalize('NFKC').replace(/\D/g, '');
export function normAcct(raw: string | null | undefined): string | null {
  const d = digitsOnly(raw);
  return d.length >= 6 && d.length <= 20 ? d : null;
}
/** WP-OCR-3：戶口號碼位數按 HKICL 銀行代號核對。唔啱 → 'acct_digits_mismatch'（用作 resolveField 嘅 validate，令該欄 review，唔改值）；表外銀行／冇代號／本身唔合格式 → null。 */
export function acctDigitsReason(raw: string | null | undefined, bankCode: string | null | undefined): 'acct_digits_mismatch' | null {
  const d = normAcct(raw);
  return d && acctDigitsCheck(d, bankCode) === 'mismatch' ? 'acct_digits_mismatch' : null;
}
/** resolveField 用嘅 validate 工廠：`resolveField(cands, { validate: acctValidate(bankCode) })`。 */
export const acctValidate = (bankCode: string | null | undefined) => (v: string): string | null => acctDigitsReason(v, bankCode);
/** 香港電話：8 位、首位 2–9；其餘（內地等）回 null 並由 caller 記 tel_not_hk_format。 */
export function normTelHkStrict(raw: string | null | undefined): string | null {
  const n = normalizeTelHk(raw);
  return n && /^[2-9]\d{7}$/.test(n) ? n : null;
}
export const normText = (raw: string | null | undefined) => (raw ?? '').normalize('NFKC').toUpperCase().replace(/[\s,.，。、·-]+/g, ' ').trim();
export const normZh = (raw: string | null | undefined) => (raw ?? '').normalize('NFKC').replace(/[\s,.，。、·]+/g, '');
export function nameTokens(raw: string | null | undefined): string[] {
  return normText(raw).split(' ').filter((t) => t && !/^(MR|MS|MRS|MISS)$/.test(t)).sort();
}
export const sameNameTokens = (a: string | null | undefined, b: string | null | undefined) => {
  const x = nameTokens(a), y = nameTokens(b);
  return x.length >= 2 && x.length === y.length && x.every((t, i) => t === y[i]);
};
export function bankByCode(code: string | null | undefined) {
  const c = (code ?? '').trim().padStart(3, '0');
  return HKICL_BANK_OPTIONS.find((b) => b.code === c) ?? null;
}
const BANK_ALIASES: [RegExp, string][] = [[/匯豐|HSBC|HONGKONG AND SHANGHAI/i, '004'], [/中銀|中國銀行|BANK OF CHINA|BOC/i, '012'], [/恒生|恆生|HANG SENG/i, '024'], [/渣打|STANDARD CHARTERED/i, '003'], [/東亞|EAST ASIA|BEA/i, '015'], [/創興|CHONG HING/i, '041'], [/大新|DAH SING/i, '040'], [/星展|DBS/i, '016'], [/交通|COMMUNICATIONS/i, '027']];
export function bankCodeFromName(name: string | null | undefined): string | null {
  const hits = new Set(BANK_ALIASES.filter(([re]) => re.test(name ?? '')).map(([, c]) => c));
  return hits.size === 1 ? [...hits][0] : null;
}

// ---------- 確認規則 ----------
const TYPED: SrcKind[] = ['typed_maxwell', 'typed_uteam', 'typed_pe'];
const HAND: SrcKind[] = ['hand_read1', 'hand_read2'];
/** 獨立證據類別：打字名單（算一個）、本機 OCR、視覺第一讀、第二（盲）讀。 */
function evidenceClass(s: SrcKind): string {
  if (TYPED.includes(s)) return 'typed';
  // WP-OCR-1：同一文件包嘅印刷身份證抽取值——獨立於打字名單同手寫讀數嘅證據類別
  if (s === 'printed_ref') return 'printed_ref';
  if (s === 'printed_ocr') return 'ocr';
  if (s === 'printed_read1' || s === 'hand_read1' || s === 'bank_copy_read1') return 'read1';
  return 'read2';
}

export interface ResolveOpts {
  /** 呢欄驗證失敗嘅原因（例如日期範圍）；null＝通過 */
  validate?: (v: string) => string | null;
}

/** sources_disagree 嘅排序候選：值＋alternatives 入池，validate 通過＝100、唔通過＝30；同分 confidence high 優先，再按輸入次序。 */
export function rankDisagreement(cands: Cand[], validate?: (v: string) => string | null): RankedCandidate[] {
  const inputs: RankInput[] = [
    ...cands.map((c) => ({ value: c.value, source: c.src, ...(c.confidence ? { confidence: c.confidence } : {}) })),
    ...cands.flatMap((c) => (c.alternatives ?? []).map((v) => ({ value: v, source: `${c.src}_alt` }))),
  ];
  return rankPool(inputs, (v) => {
    const bad = validate?.(v) ?? null;
    return { canon: v, display: v, base: bad ? 30 : 100, reason: bad ?? 'valid' };
  });
}
/**
 * cands：已正規化嘅候選。邏輯：
 * - 冇候選 → missing
 * - 多於一個唔同值 → review（候選全留，reason disagree）
 * - 單一值：獨立證據類別 ≥2 → confirmed；
 *   淨係打字名單 → confirmed＋typed_list_only；
 *   淨係手寫第一讀 → review＋handwritten_form_only＋second_read_pending；
 *   淨係印刷單一讀 → review＋printed_single_read
 */
export function resolveField(cands: Cand[], opts: ResolveOpts = {}): FieldOut {
  if (!cands.length) return { value: null, status: 'missing', candidates: [], sources: [], reasons: [] };
  const byVal = new Map<string, Cand[]>();
  for (const c of cands) byVal.set(c.value, [...(byVal.get(c.value) ?? []), c]);
  const candidates = [...byVal.entries()].map(([value, cs]) => ({ value, sources: [...new Set(cs.map((c) => c.src))] }));
  const allSrc = [...new Set(cands.map((c) => c.src))];
  if (byVal.size > 1) return { value: null, status: 'review', candidates, sources: allSrc, reasons: ['sources_disagree'], candidates_ranked: rankDisagreement(cands, opts.validate) };
  const [value, cs] = [...byVal.entries()][0];
  const classes = new Set(cs.map((c) => evidenceClass(c.src)));
  const reasons: string[] = [];
  const bad = opts.validate?.(value) ?? null;
  const onlyHand = cs.every((c) => HAND.includes(c.src));
  const hasTyped = classes.has('typed');
  if (bad) return { value: null, status: 'review', candidates, sources: allSrc, reasons: [bad] };
  if (cs.some((c) => HAND.includes(c.src)) && !hasTyped && !cs.some((c) => c.src.startsWith('printed'))) reasons.push('handwritten_form_only');
  if (classes.size >= 2) return { value, status: 'confirmed', candidates, sources: allSrc, reasons };
  if (hasTyped) return { value, status: 'confirmed', candidates, sources: allSrc, reasons: [...reasons, 'typed_list_only'] };
  if (onlyHand) return { value, status: 'review', candidates, sources: allSrc, reasons: [...reasons, 'second_read_pending'] };
  return { value, status: 'review', candidates, sources: allSrc, reasons: [...reasons, 'single_read'] };
}

/** 兩個手寫值（read1／read2）+ 其他來源 → Cand；hand 讀數留空表示「欄位空白」，唔當候選。 */
export const fromRead = (src: SrcKind, norm: string | null, raw?: string | null): Cand[] => (norm ? [{ src, value: norm, ref: raw ?? undefined }] : []);

// ---------- Opus 核對後新增規則 ----------
export function splitPermit(no: string): { prefix: string; serial: string | null } {
  const parts = no.split('-');
  return { prefix: parts.slice(0, 3).join('-'), serial: parts[3] ?? null };
}
/** 卡底控制編號（字母＋7 位，冇連字符）唔係牌照號碼。 */
export const isCardControlNo = (raw: string | null | undefined) => /^[A-Z]\d{7}$/.test((raw ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, ''));
export const isPureHand = (sources: string[]) => sources.length > 0 && sources.every((s) => s === 'hand_read1' || s === 'hand_read2');
/** 日 ≤12 且日≠月 → 日／月可對調 */
export const dateAmbiguous = (iso: string) => { const m = Number(iso.slice(5, 7)); const d = Number(iso.slice(8, 10)); return d <= 12 && d !== m; };

/** 純手寫來源嘅降級：unverified＝handwritten_unverified（無論兩讀一致）；date＝日月歧義。 */
export function applyHandRules(f: FieldOut, o: { date?: boolean; unverified?: boolean }): FieldOut {
  if (f.status === 'missing' || !isPureHand(f.sources)) return f;
  const reasons = [...f.reasons];
  let status = f.status;
  if (o.unverified) { if (!reasons.includes('handwritten_unverified')) reasons.push('handwritten_unverified'); status = 'review'; }
  else if (o.date && f.value && f.status === 'confirmed' && dateAmbiguous(f.value)) { reasons.push('handwritten_date_ambiguous'); status = 'review'; }
  return { ...f, status, reasons };
}
export const acctEq = (a: string | null, b: string | null, code: string | null) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const c = (code ?? '').padStart(3, '0');
  return !!code && ((a.startsWith(c) && a.slice(3) === b) || (b.startsWith(c) && b.slice(3) === a));
};

/** 銀行副本 vs Payroll Editor 戶口：去銀行代號前綴後逐位相同＝eq；副本欠 3 位分行碼而尾段相同＝nobranch；其餘 no。 */
export function acctAgreeKind(copy: string, pe: string, code: string | null): 'eq' | 'nobranch' | 'no' {
  const c = (code ?? '').padStart(3, '0');
  const strip = (x: string) => (code && x.startsWith(c) && x.length > 3 ? x.slice(3) : x);
  if (copy === pe || strip(copy) === strip(pe) || strip(copy) === pe || copy === strip(pe)) return 'eq';
  const [a, b] = [strip(copy), strip(pe)];
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length === 3 && short.length >= 6 && long.endsWith(short)) return 'nobranch';
  return 'no';
}
