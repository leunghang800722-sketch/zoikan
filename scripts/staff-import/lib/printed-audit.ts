// TE-8：printed HKID 自檢（純函數）——對每個人所有「非身份證頁」OCR 行，比較舊規則（行內 loose 搜尋＋checksum，第一個候選）
// 同新規則（token 邊界＋label 優先＋無 label 要括號 check digit；跨頁多值＝衝突）。輸出只有布林／計數／key，唔含號碼值。
import { findHkidCandidates, findHkidTokens, hkidCheckDigitValid, HKID_LABEL_SRC } from './hkid';
import { scanPageHkids } from './extract';
import { readingOrder, type OcrLine } from './ocr';

export interface AuditPage {
  docId: string;
  page: number;
  lines: OcrLine[];
}
export interface AuditPerson {
  key: string;
  pages: AuditPage[];
}
export interface AuditRow {
  key: string;
  docIds: string[];
  /** 舊規則有候選 */
  oldFound: boolean;
  /** 舊規則第一個候選係嵌喺較長英數 token 內（證書／牌照序號類） */
  oldEmbedded: boolean;
  /** 舊規則第一個候選所在行（或緊貼上一行）冇身份證 label */
  oldNoLabel: boolean;
  /** 新規則有候選（跨頁一致先算） */
  newFound: boolean;
  /** 新規則跨頁出現多個唔同值 → printed 來源跳過 */
  multi: boolean;
  /** 新舊選擇唔同（舊有而新冇／新舊值唔同／新有而舊冇） */
  changed: boolean;
  /** 新規則候選來自 label 行 */
  newLabelled: boolean;
}

const RE_LABEL = new RegExp(HKID_LABEL_SRC, 'i');
const RE_LABEL_TAIL = new RegExp(`${HKID_LABEL_SRC}\\s*[:：]?\\s*$`, 'i');
const RE_PERMIT_NO = /PERMIT\s*NO|許可證編號/i;

export function auditOne(p: AuditPerson): AuditRow {
  let old: { value: string; text: string; prev: string | null } | null = null;
  const values = new Set<string>();
  let labelled = false;
  for (const pg of p.pages) {
    const rows = readingOrder(pg.lines.filter((l) => l.t.trim()));
    if (!old) {
      for (const [i, l] of rows.entries()) {
        if (RE_PERMIT_NO.test(l.t)) continue;
        const c = findHkidCandidates(l.t.normalize('NFKC')).find((x) => hkidCheckDigitValid(x));
        if (c) {
          old = { value: c, text: l.t, prev: i > 0 ? rows[i - 1]!.t : null };
          break;
        }
      }
    }
    for (const f of scanPageHkids(pg.page, pg.lines)) {
      values.add(f.value);
      if (f.flags?.includes('hkid_labelled')) labelled = true;
    }
  }
  const multi = values.size > 1;
  const newValue = values.size === 1 ? [...values][0]! : null;
  const embedded = !!old && !findHkidTokens(old.text).some((t) => t.value === old!.value);
  const noLabel = !!old && !RE_LABEL.test(old.text.normalize('NFKC')) && !(old.prev && RE_LABEL_TAIL.test(old.prev.normalize('NFKC')));
  return {
    key: p.key,
    docIds: [...new Set(p.pages.map((x) => x.docId))],
    oldFound: !!old,
    oldEmbedded: embedded,
    oldNoLabel: noLabel,
    newFound: newValue !== null,
    multi,
    changed: (old?.value ?? null) !== newValue,
    newLabelled: labelled && newValue !== null,
  };
}

export interface AuditSummary {
  persons: number;
  old_found: number;
  old_embedded: number;
  old_no_label: number;
  new_found: number;
  new_labelled: number;
  multi_conflict: number;
  changed: number;
}
export function summarizeAudit(rows: readonly AuditRow[]): AuditSummary {
  const c = (f: (r: AuditRow) => boolean) => rows.filter(f).length;
  return { persons: rows.length, old_found: c((r) => r.oldFound), old_embedded: c((r) => r.oldEmbedded), old_no_label: c((r) => r.oldFound && r.oldNoLabel), new_found: c((r) => r.newFound), new_labelled: c((r) => r.newLabelled), multi_conflict: c((r) => r.multi), changed: c((r) => r.changed) };
}
/** 受影響＝舊候選嵌喺長 token／新舊選擇唔同／多值衝突（俾規劃者重出 zip）。 */
export const isAffected = (r: AuditRow): boolean => r.oldEmbedded || r.changed || r.multi;
