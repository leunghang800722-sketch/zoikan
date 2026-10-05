// WP-STAFF-FIELDS 第一階段：逐人裁圖（申請表欄位帶／牌照頁／銀行證明頁）→ data/2026-10/staff-fields/crops/。
// 用法：tsx 13-fields-crops.ts [--limit N] [--offset K]（斷點續跑：已有裁圖清單嘅人跳過）。log 只印 docId／計數。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { FIELDS_OUT, cropBox, renderPage } from './lib/fields-render';
import { contentBox, isPermitCard, detectTemplate, isContinuation, locateContinuationCrops, locateFormCrops, type CropKind, type FormTemplate } from './lib/fields-locate';
import { OUT } from './lib/render';

export interface CropRec {
  id: string; // <docId>-p<page>-<kind>
  docId: string;
  page: number;
  kind: CropKind;
  file: string; // 相對 FIELDS_OUT
  how: string;
}
export interface PersonCrops {
  key: string;
  idx: number; // 匿名序號（sheet 檔名用）
  templates: Record<string, FormTemplate>;
  crops: CropRec[];
  missing: { docId: string; kind: string; reason: string }[];
}
const J = async <T>(p: string) => JSON.parse(await fs.readFile(p, 'utf8')) as T;

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : undefined; };
  const limit = arg('--limit') ?? 1e9;
  const offset = arg('--offset') ?? 0;
  const persons = await J<{ key: string; docIds: string[] }[]>(path.join(OUT, 'out/person-fields.json'));
  const index = new Map((await J<DocMeta[]>(path.join(OUT, 'index.json'))).map((m) => [m.docId, m]));
  const ex = new Map((await J<{ docId: string; pages: { page: number; kinds: string[]; primary: string }[] }[]>(path.join(OUT, 'out/extract.json'))).map((e) => [e.docId, e]));
  const mi = process.argv.indexOf('--manifest');
  const manPath = path.join(FIELDS_OUT, mi >= 0 ? `crops-manifest-${process.argv[mi + 1]}.json` : 'crops-manifest.json');
  let man: PersonCrops[] = [];
  try { man = await J<PersonCrops[]>(manPath); } catch { /* 新開 */ }
  const redo = process.argv.includes('--redo-missing'); // 只補裁上次 label 定位失敗嘅人（新 id 先出）
  const existing = new Set<string>();
  const redoKeys = new Set<string>();
  if (redo) {
    for (const f of (await fs.readdir(FIELDS_OUT)).filter((x) => /^crops-manifest.*\.json$/.test(x) && x !== path.basename(manPath))) {
      for (const pr of await J<PersonCrops[]>(path.join(FIELDS_OUT, f))) {
        pr.crops.forEach((c) => existing.add(c.id));
        if (pr.missing.some((m) => /form_labels_not_located|emergency_label_not_located/.test(m.reason))) redoKeys.add(pr.key);
      }
    }
  }
  const done = new Set(man.map((m) => m.key));
  for (let i = offset; i < Math.min(persons.length, offset + limit); i++) {
    const p = persons[i];
    if (done.has(p.key) || (redo && !redoKeys.has(p.key))) continue;
    const rec: PersonCrops = { key: p.key, idx: i, templates: {}, crops: [], missing: [] };
    for (const docId of p.docIds) {
      const m = index.get(docId); const e = ex.get(docId);
      if (!m || !e) continue;
      const ocr = (await fs.readFile(path.join(OUT, 'ocr', `${docId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage).filter((o) => !o.alt);
      const pageLines = (n: number) => ocr.find((o) => o.page === n)?.lines ?? [];
      const emit = async (page: number, kind: CropKind, box: Parameters<typeof cropBox>[1], how: string, scale?: number) => {
        const img = await renderPage(m, page, 300);
        const id = `${docId}-p${page}-${kind}`;
        if (existing.has(id)) return;
        const file = await cropBox(img, box, `crops/${id}.png`, { scale });
        rec.crops.push({ id, docId, page, kind, file, how });
      };
      const formPages = e.pages.filter((x) => x.kinds.includes('application_form')).map((x) => x.page);
      let sawEmergency = false;
      let sawContinuation = false;
      for (const pg of formPages) {
        const lines = pageLines(pg);
        const tpl = detectTemplate(lines);
        rec.templates[`${docId}-p${pg}`] = tpl;
        const boxes = locateFormCrops(lines, tpl);
        if (!boxes.length) rec.missing.push({ docId, kind: `form_p${pg}`, reason: 'form_labels_not_located' });
        for (const b of boxes) { await emit(pg, b.kind, b.box, b.how); if (b.kind === 'form_emergency') sawEmergency = true; }
        // 續頁：同檔 pg+1.. 內有「兩位緊急聯絡人／其他牌照」
        if (tpl !== 'maxwell') {
          for (const nx of e.pages.map((x) => x.page).filter((n) => n > pg && n <= pg + 2)) {
            const nl = pageLines(nx);
            if (!isContinuation(nl)) continue;
            sawContinuation = true;
            const cb = locateContinuationCrops(nl);
            for (const b of cb) { await emit(nx, b.kind, b.box, b.how); if (b.kind === 'form_emergency') sawEmergency = true; }
            break;
          }
        }
      }
      if (formPages.length && !sawEmergency) rec.missing.push({ docId, kind: 'form_emergency', reason: sawContinuation ? 'template_without_emergency_section' : 'emergency_label_not_located' });
      for (const pg of e.pages) {
        if (pg.kinds.includes('sia_permit')) {
          const pl = pageLines(pg.page);
          const cb = contentBox(pl);
          if (cb && isPermitCard(pl)) await emit(pg.page, 'permit_card', cb, 'content_bbox', 70);
          else rec.missing.push({ docId, kind: `permit_p${pg.page}`, reason: 'sia_permit_kind_but_not_permit_card' });
        }
        if (pg.kinds.includes('bank') && !pg.kinds.includes('application_form')) {
          const cb = contentBox(pageLines(pg.page));
          if (cb) await emit(pg.page, 'bank_page', cb, 'content_bbox', 70);
        }
      }
    }
    man.push(rec);
    console.log(`#${i} docs=${p.docIds.length} crops=${rec.crops.length} missing=${rec.missing.length}`);
    await fs.writeFile(manPath, JSON.stringify(man));
  }
}
main();
