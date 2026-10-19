// TE-12：production 未答題差距自檢（純函數）——輸入＝老闆由 production 匯出嘅未答題清單（只含 person_key、staff_numbers、kind、review_fields，無值）
// ＋ package ＋ 重讀 proposals（含 summary.persons 逐人診斷），逐題分類：
//   auto_answerable（有建議可自動答）／proposal_not_auto（有建議但唔夠自動答）／wrong_field（有建議但唔係題目要嘅欄）／
//   no_proposal（冇建議，帶逐欄原因）／no_docs（人冇文件）／person_unmatched（包內搵唔到呢個人）／kind_unsupported（題型唔處理）。
// 輸出只有 person_key／題型／分類／原因碼，唔含任何值。
import { canonicalHkid, hkidCheckDigitValid } from './hkid';
import { cardTruth } from './auto-close-audit';
import type { PersonDiag, PkgPerson, ProposalFieldName, RereadProposal } from './triage-reread-core';

export interface OpenQuestion {
  person_key: string;
  staff_numbers: string[];
  kind: string;
  review_fields?: string[];
}

export type GapCategory = 'auto_answerable' | 'proposal_not_auto' | 'wrong_field' | 'no_proposal' | 'no_docs' | 'person_unmatched' | 'kind_unsupported';
export interface GapRow {
  person_key: string;
  kind: string;
  category: GapCategory;
  /** 原因碼（逐欄：<field>:<reason>）；唔含值 */
  reason: string;
}

const SUPPORTED = ['name_not_confirmed', 'hkid_not_confirmed', 'field_review'];
const FIELD_ALIAS: Record<string, ProposalFieldName> = { nameZh: 'nameZh', name_zh: 'nameZh', nameEn: 'nameEn', name_en: 'nameEn', hkid: 'hkid', dateOfBirth: 'dateOfBirth', dob: 'dateOfBirth', date_of_birth: 'dateOfBirth', phone: 'phone', address: 'address' };
const normNo = (s: string) => s.normalize('NFKC').toUpperCase().replace(/\s+/g, '');

export function requiredFields(q: OpenQuestion): ProposalFieldName[] | null {
  if (q.kind === 'name_not_confirmed') return ['nameZh'];
  if (q.kind === 'hkid_not_confirmed') return ['hkid'];
  if (q.kind === 'field_review') {
    const f = [...new Set((q.review_fields ?? []).map((x) => FIELD_ALIAS[x]).filter((x): x is ProposalFieldName => !!x))];
    return f.length ? f : null;
  }
  return null;
}

const describe = (p: RereadProposal): string => `${p.field}:${p.confidence}${(p.flags ?? []).length ? `+${(p.flags ?? []).join('+')}` : ''}`;

export function auditOpenGap(questions: readonly OpenQuestion[], persons: readonly PkgPerson[], proposals: readonly RereadProposal[], diags: readonly PersonDiag[]): GapRow[] {
  // 工號 → 包內 person key（package、proposals.match、診斷三處都索引）
  const byNo = new Map<string, Set<string>>();
  const add = (no: string, key: string) => {
    const k = normNo(no);
    if (k) (byNo.get(k) ?? byNo.set(k, new Set()).get(k)!).add(key);
  };
  const pkgBy = new Map(persons.map((p) => [p.key, p]));
  for (const p of persons) for (const n of p.staffNumbers) add(n.number, p.key);
  const propBy = new Map<string, Map<string, RereadProposal>>();
  for (const pr of proposals) {
    (propBy.get(pr.person_key) ?? propBy.set(pr.person_key, new Map()).get(pr.person_key)!).set(pr.field, pr);
    for (const n of pr.match.staff_numbers) add(n, pr.person_key);
  }
  const diagBy = new Map(diags.map((d) => [d.person_key, d]));
  for (const d of diags) for (const n of d.staff_numbers) add(n, d.person_key);

  const rows: GapRow[] = [];
  for (const q of questions) {
    const row = (category: GapCategory, reason: string): void => void rows.push({ person_key: q.person_key, kind: q.kind, category, reason });
    const need = requiredFields(q);
    if (!SUPPORTED.includes(q.kind)) {
      row('kind_unsupported', q.kind);
      continue;
    }
    if (!need) {
      row('kind_unsupported', 'no_review_fields');
      continue;
    }
    const keys = new Set<string>();
    for (const n of q.staff_numbers) for (const k of byNo.get(normNo(n)) ?? []) keys.add(k);
    if (keys.size === 0 && (pkgBy.has(q.person_key) || propBy.has(q.person_key) || diagBy.has(q.person_key))) keys.add(q.person_key);
    if (keys.size === 0) {
      row('person_unmatched', 'not_in_package');
      continue;
    }
    // 工號對到多個包內 key 時，揀有建議／診斷嘅（同一個人多個工號分散喺幾個 key 嘅少見情況）
    const mine = new Map<string, RereadProposal>();
    for (const k of keys) for (const [f, pr] of propBy.get(k) ?? []) if (!mine.has(f)) mine.set(f, pr);
    const diag = [...keys].map((k) => diagBy.get(k)).find(Boolean);
    const pkg = [...keys].map((k) => pkgBy.get(k)).find(Boolean);
    const have = need.filter((f) => mine.has(f));
    if (have.length === need.length) {
      const closable = need.every((f) => {
        const pr = mine.get(f)!;
        if (q.kind === 'field_review') return true; // 同 23：field_review 全部覆核欄都有建議就可 apply_fields
        if (f === 'nameZh') return cardTruth(pr) || (!!pkg?.nameZh.value && pr.value.replace(/\s+/g, '') === pkg.nameZh.value.replace(/\s+/g, ''));
        const want = canonicalHkid(pr.value);
        return !!want && (want === canonicalHkid(pkg?.hkid.value ?? null) || (hkidCheckDigitValid(want) && cardTruth(pr)));
      });
      if (closable) row('auto_answerable', need.map((f) => `${f}:ok`).join(','));
      else row('proposal_not_auto', need.map((f) => describe(mine.get(f)!)).join(','));
      continue;
    }
    if (mine.size > 0) {
      row('wrong_field', `has:${[...mine.keys()].sort().join('+')}|need:${need.join('+')}`);
      continue;
    }
    // 冇建議：逐欄原因（診斷）；全部 no_docs＝人冇文件
    const reasonOf = (f: ProposalFieldName): string => diag?.fields[f]?.reason ?? (diag ? 'not_diagnosed' : 'no_diag');
    if (need.every((f) => reasonOf(f) === 'no_docs')) row('no_docs', need.map((f) => `${f}:no_docs`).join(','));
    else row('no_proposal', need.map((f) => `${f}:${reasonOf(f)}`).join(','));
  }
  return rows;
}

export interface GapSummary {
  questions_total: number;
  by_category: Record<string, number>;
  by_kind: Record<string, Record<string, number>>;
  /** no_proposal 嘅逐欄原因分佈（<field>:<reason> → 題數） */
  no_proposal_reasons: Record<string, number>;
}
export function summarizeGap(rows: readonly GapRow[]): GapSummary {
  const s: GapSummary = { questions_total: rows.length, by_category: {}, by_kind: {}, no_proposal_reasons: {} };
  for (const r of rows) {
    s.by_category[r.category] = (s.by_category[r.category] ?? 0) + 1;
    const k = (s.by_kind[r.kind] ??= {});
    k[r.category] = (k[r.category] ?? 0) + 1;
    if (r.category === 'no_proposal') for (const x of r.reason.split(',')) s.no_proposal_reasons[x] = (s.no_proposal_reasons[x] ?? 0) + 1;
  }
  return s;
}
