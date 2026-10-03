// Stage A step 2：逐頁分類＋抽欄位 → out/extract.json。
// 用法：tsx 02-classify-extract.ts [--limit N]（只做頭 N 個已 OCR 嘅檔，樣本迭代用）
// Console 淨印統計（唔印姓名／號碼／地址）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { aggregateDoc, type DocExtract } from './lib/aggregate';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';

const OUT = path.join(process.cwd(), 'data/2026-10/staff-import');

function pct(n: number, d: number) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const index = JSON.parse(await fs.readFile(path.join(OUT, 'index.json'), 'utf8')) as DocMeta[];
  const results: (DocExtract & { staffNo: string | null })[] = [];
  let n = 0;
  for (const m of index) {
    if (n >= limit) break;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(OUT, 'ocr', `${m.docId}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    const pages = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
    try {
      const alt = (await fs.readFile(path.join(OUT, 'ocr2', `${m.docId}.jsonl`), 'utf8')).split('\n').filter(Boolean);
      for (const l of alt) {
        const o = JSON.parse(l) as { page: number; rot: number; lines: OcrPage['lines'] };
        pages.push({ page: o.page, lines: o.lines, alt: true, rot: o.rot });
      }
    } catch {
      /* 冇重做 */
    }
    const fnZh = m.fileName && /[\u4e00-\u9fff]/.test(m.fileName) ? m.fileName.replace(/[^\u4e00-\u9fff]/g, '') : null;
    results.push({ ...aggregateDoc(m.docId, pages, { fileNameZh: fnZh }), staffNo: m.staffNo });
    n++;
  }
  await fs.mkdir(path.join(OUT, 'out'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'out/extract.json'), JSON.stringify(results, null, 1));

  const kindCount: Record<string, number> = {};
  const primCount: Record<string, number> = {};
  let pages = 0;
  for (const r of results) {
    for (const p of r.pages) {
      pages++;
      primCount[p.primary] = (primCount[p.primary] ?? 0) + 1;
      for (const k of p.kinds) kindCount[k] = (kindCount[k] ?? 0) + 1;
    }
  }
  const N = results.length;
  const fieldStat = (k: 'hkid' | 'nameZh' | 'nameEn' | 'dob' | 'sex' | 'address' | 'phone') => {
    const have = results.filter((r) => r[k]);
    const lv = { high: 0, medium: 0, low: 0 };
    have.forEach((r) => lv[r[k]!.level]++);
    return `${have.length}/${N} (${pct(have.length, N)}) high=${lv.high} med=${lv.medium} low=${lv.low}`;
  };
  console.log(`docs=${N} pages=${pages}`);
  console.log('pages primary:', JSON.stringify(primCount));
  console.log('pages any-label:', JSON.stringify(kindCount));
  for (const k of ['hkid', 'nameZh', 'nameEn', 'dob', 'sex', 'address', 'phone'] as const) console.log(`field ${k}: ${fieldStat(k)}`);
  const withHkid = results.filter((r) => r.hkid);
  console.log(`hkid check digit valid: ${withHkid.filter((r) => r.hkidValid).length}/${withHkid.length}`);
  const flagCount: Record<string, number> = {};
  results.forEach((r) => r.flags.forEach((f) => (flagCount[f] = (flagCount[f] ?? 0) + 1)));
  console.log('flags:', JSON.stringify(flagCount));
  console.log(`hkid rescued by rotate/300dpi: ${results.filter((r) => r.rescuedRot !== null).length} (rot0=${results.filter((r) => r.rescuedRot === 0).length})`);
}

main();
