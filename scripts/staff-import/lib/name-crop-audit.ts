// TE-10：中文名裁圖潛在切字自檢（純函數）——有身份證頁嘅人入面，身份證頁 OCR 中文名行字數少過包內中文名字數＝裁圖若跟 OCR 行 box 會切走尾字。
// 輸出只有計數／分佈／key，唔含姓名值。
import { cjkChars } from './triage-evidence-core';
import { extractIdCard } from './extract';
import type { OcrLine } from './ocr';

export interface NameAuditPerson {
  key: string;
  /** 包內中文姓名（只喺記憶體比字數） */
  nameZh: string | null;
  /** 身份證頁（classic）OCR 行 */
  idPages: { docId: string; page: number; lines: OcrLine[] }[];
}
export interface NameAuditRow {
  key: string;
  hasIdPage: boolean;
  /** 有包內中文名而且 OCR 讀到中文名行 */
  compared: boolean;
  /** 包內字數 − OCR 行字數（>0＝潛在切字） */
  deficit: number;
}

export function auditName(p: NameAuditPerson): NameAuditRow {
  const exp = p.nameZh ? cjkChars(p.nameZh).length : 0;
  let best: number | null = null;
  for (const pg of p.idPages) {
    const r = extractIdCard(pg.page, pg.lines);
    const zh = (r.nameLines ?? []).filter((l) => /[一-鿿]/.test(l.t));
    if (zh.length === 0) continue;
    const n = Math.max(...zh.map((l) => cjkChars(l.t).length));
    best = best === null ? n : Math.max(best, n);
  }
  return { key: p.key, hasIdPage: p.idPages.length > 0, compared: exp > 0 && best !== null, deficit: exp > 0 && best !== null ? exp - best : 0 };
}

export interface NameAuditSummary {
  persons: number;
  with_id_page: number;
  compared: number;
  /** OCR 中文名行字數少過包內字數嘅人數（潛在切字） */
  short: number;
  /** 少 1 字／2 字／3 字或以上 */
  deficit_1: number;
  deficit_2: number;
  deficit_3plus: number;
}
export function summarizeNameAudit(rows: readonly NameAuditRow[]): NameAuditSummary {
  const short = rows.filter((r) => r.compared && r.deficit > 0);
  return {
    persons: rows.length,
    with_id_page: rows.filter((r) => r.hasIdPage).length,
    compared: rows.filter((r) => r.compared).length,
    short: short.length,
    deficit_1: short.filter((r) => r.deficit === 1).length,
    deficit_2: short.filter((r) => r.deficit === 2).length,
    deficit_3plus: short.filter((r) => r.deficit >= 3).length,
  };
}
