// 檔名解析／docId（純函數，無 PII 寫死）。
import { createHash } from 'node:crypto';

export interface DocMeta {
  docId: string;
  file: string;
  staffNo: string | null;
  fileName: string | null; // 檔名姓名
  tag: string | null; // 括號來源標記
  conforming: boolean;
}

export function docIdOf(file: string): string {
  return createHash('sha1').update(file.normalize('NFC')).digest('hex').slice(0, 12);
}

const NAME_RE = /^([A-Za-z]{1,3}\d{1,6})\s*(.+?)\s*(?:[(（]([^)）]*)[)）])?\s*$/;

export function parseDocFileName(file: string): DocMeta {
  const normalized = file.normalize('NFC');
  const base = normalized.replace(/\.(pdf|jpe?g|png)$/i, ''); // 資料夾名冇副檔名亦得
  const m = NAME_RE.exec(base);
  const docId = docIdOf(file);
  if (!m) return { docId, file, staffNo: null, fileName: null, tag: null, conforming: false };
  return {
    docId,
    file,
    staffNo: m[1].toUpperCase(),
    fileName: m[2].trim() || null,
    tag: m[3]?.trim() || null,
    conforming: true,
  };
}
