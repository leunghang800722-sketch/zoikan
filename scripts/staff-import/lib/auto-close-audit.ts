// TE-11：「讀啱晒就唔應該出題」自檢（純函數）——對 package 人員＋重讀 proposals，統計按 B 規則（證件為準自動答）可自動關閉嘅題數（按題型）。
// 題型由包內欄位狀態推（同 generator 規則一致）：nameZh review→name_not_confirmed；hkid review→hkid_not_confirmed；其餘 review 欄→field_review。
// 輸出只有計數／personKey，唔含任何值。C（下次導入唔出題）要重新導入先見到，唔喺呢度模擬。
import { canonicalHkid, hkidCheckDigitValid } from './hkid';
import type { PkgPerson, RereadProposal } from './triage-reread-core';

export interface AutoCloseRow {
  key: string;
  kinds: { kind: 'name_not_confirmed' | 'hkid_not_confirmed' | 'field_review'; closable: boolean; via: 'use_package' | 'card_truth' | 'apply_fields' | null; blockedByFormConflict?: boolean; blockedByUnproven?: boolean }[];
}

const cardTruth = (p: RereadProposal | undefined): boolean => !!p && p.confidence === 'high' && p.basis === 'two_reads' && p.doc === 'id_card' && !(p.flags ?? []).some((f) => f === 'printed_card_conflict' || f === 'card_name_conflict');
/** 身份證兩讀一致本來可靠卡為準修正，但入職表完全唔相似（form_conflict）而被降級留人 */
const formConflictBlocked = (p: RereadProposal): boolean => p.doc === 'id_card' && p.basis === 'two_reads' && (p.flags ?? []).includes('form_conflict');
/** 中文差 1 字而冇硬證據：medium＋form_differs（TE-11.3） */
const unprovenBlocked = (p: RereadProposal): boolean => p.doc === 'id_card' && p.basis === 'two_reads' && p.confidence === 'medium' && (p.flags ?? []).includes('form_differs') && !(p.flags ?? []).includes('form_conflict');
const REVIEW_FIELD_PROPOSALS = ['nameEn', 'dateOfBirth', 'phone', 'address'] as const;

export function auditAutoClose(persons: readonly PkgPerson[], proposals: readonly RereadProposal[]): AutoCloseRow[] {
  const by = new Map<string, Map<string, RereadProposal>>();
  for (const pr of proposals) (by.get(pr.person_key) ?? by.set(pr.person_key, new Map()).get(pr.person_key)!).set(pr.field, pr);
  const rows: AutoCloseRow[] = [];
  for (const p of persons) {
    const mine = by.get(p.key) ?? new Map<string, RereadProposal>();
    const kinds: AutoCloseRow['kinds'] = [];
    if (p.nameZh.status === 'review') {
      const pr = mine.get('nameZh');
      const same = !!pr && !!p.nameZh.value && pr.value.replace(/\s+/g, '') === p.nameZh.value.replace(/\s+/g, '');
      kinds.push({ kind: 'name_not_confirmed', closable: !!pr && (same || cardTruth(pr)), via: !pr ? null : same ? 'use_package' : cardTruth(pr) ? 'card_truth' : null, ...(!!pr && !same && formConflictBlocked(pr) ? { blockedByFormConflict: true } : {}), ...(!!pr && !same && unprovenBlocked(pr) ? { blockedByUnproven: true } : {}) });
    }
    if (p.hkid.status === 'review') {
      const pr = mine.get('hkid');
      const want = canonicalHkid(pr?.value ?? null);
      const same = !!want && want === canonicalHkid(p.hkid.value);
      kinds.push({ kind: 'hkid_not_confirmed', closable: !!pr && !!want && (same || (hkidCheckDigitValid(want) && cardTruth(pr))), via: !pr ? null : same ? 'use_package' : cardTruth(pr) ? 'card_truth' : null, ...(!!pr && !same && formConflictBlocked(pr) ? { blockedByFormConflict: true } : {}) });
    }
    const reviewFields = REVIEW_FIELD_PROPOSALS.filter((f) => ({ nameEn: p.nameEn, dateOfBirth: p.dateOfBirth, phone: p.phone, address: p.address })[f].status === 'review');
    if (reviewFields.length > 0) {
      const all = reviewFields.every((f) => mine.has(f));
      kinds.push({ kind: 'field_review', closable: all, via: all ? 'apply_fields' : null });
    }
    if (kinds.length) rows.push({ key: p.key, kinds });
  }
  return rows;
}

export interface AutoCloseSummary {
  /** TE-11.3：靠卡修正但中文差 1 字而冇硬證據（medium＋form_differs）而留人嘅題數 */
  blocked_by_unproven: number;
  /** TE-11.2：靠卡為準修正本來可自動關閉，但入職表姓名／出生日期完全唔相似（form_conflict，疑錯人卡）而留人嘅題數 */
  blocked_by_form_conflict: number;
  persons_with_questions: number;
  questions: Record<string, number>;
  closable: Record<string, number>;
  closable_via_card_truth: number;
  closable_total: number;
  questions_total: number;
}
export function summarizeAutoClose(rows: readonly AutoCloseRow[]): AutoCloseSummary {
  const s: AutoCloseSummary = { blocked_by_unproven: rows.reduce((a, r) => a + r.kinds.filter((k) => k.blockedByUnproven).length, 0), blocked_by_form_conflict: rows.reduce((a, r) => a + r.kinds.filter((k) => k.blockedByFormConflict).length, 0), persons_with_questions: rows.length, questions: {}, closable: {}, closable_via_card_truth: 0, closable_total: 0, questions_total: 0 };
  for (const r of rows) {
    for (const k of r.kinds) {
      s.questions[k.kind] = (s.questions[k.kind] ?? 0) + 1;
      s.questions_total += 1;
      if (k.closable) {
        s.closable[k.kind] = (s.closable[k.kind] ?? 0) + 1;
        s.closable_total += 1;
        if (k.via === 'card_truth') s.closable_via_card_truth += 1;
      }
    }
  }
  return s;
}
