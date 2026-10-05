// WP-STAFF-FIELDS：每種裁圖要讀嘅欄（視覺讀數詞彙）。第一讀數 first-read.json／盲讀 second-read.json 都用同一套。
import type { CropKind } from './fields-locate';

export const READ_FIELDS: Record<string, string[]> = {
  form_join: ['join'],
  form_personal: ['permit_no', 'exp_a', 'exp_b', 'exp_c', 'exp_d', 'staff_no'],
  form_emergency_wilson: ['em1_name', 'em1_rel', 'em1_tel', 'em2_name', 'em2_rel', 'em2_tel'],
  form_emergency_maxwell: ['em1_name', 'em1_rel', 'em1_tel', 'qas_issue', 'permit_no', 'exp_a', 'exp_b', 'staff_no', 'join'],
  form_permits: ['qas_issue', 'qas_expiry', 'green_no', 'green_expiry'],
  permit_card: ['permit_no', 'a_to', 'b_to', 'c_to', 'd_to'],
  bank_page: ['bank_name', 'acct', 'holder'],
};
/** 手寫（要第二次盲讀）定印刷。 */
export const HANDWRITTEN: Record<string, boolean> = { form_join: true, form_personal: true, form_emergency_wilson: true, form_emergency_maxwell: true, form_permits: true, permit_card: false, bank_page: false };

export function specKey(kind: CropKind, how: string): string {
  if (kind === 'form_emergency') return how.startsWith('maxwell') ? 'form_emergency_maxwell' : 'form_emergency_wilson';
  return kind;
}
