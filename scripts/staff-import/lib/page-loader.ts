// 共用：由 package／person-fields／extract／OCR jsonl 載入每個人嘅頁（含 OCR 行）。keep(kinds)＝揀邊啲頁。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ArgError } from './eval-ocr-core';
import { buildStaffNoIndex, docIdsForPerson, type ExtRow, type ExtractRow, type PkgPerson } from './triage-reread-core';
import type { OcrLine, OcrPage } from './ocr';

export interface LoadArgs {
  package: string | null;
  personFields: string | null;
  extract: string | null;
  ocrDir: string | null;
}
export interface LoadedPerson {
  person: PkgPerson;
  pages: { docId: string; page: number; lines: OcrLine[] }[];
}

export async function loadPeoplePages(args: LoadArgs, keep: (kinds: string[]) => boolean): Promise<LoadedPerson[]> {
  for (const k of ['package', 'personFields', 'extract'] as const) if (!args[k]) throw new ArgError('需要 --package --person-fields --extract（或者 --dry）');
  const J = async <T>(p: string) => JSON.parse(await readFile(path.resolve(p), 'utf-8')) as T;
  const pkg = await J<{ persons: PkgPerson[] }>(args.package!);
  const ext = await J<ExtRow[]>(args.personFields!);
  const extract = await J<ExtractRow[]>(args.extract!);
  const extractBy = new Map(extract.map((e) => [e.docId, e]));
  const idx = buildStaffNoIndex(ext);
  const ocrDir = path.resolve(args.ocrDir ?? path.join(path.dirname(path.resolve(args.extract!)), 'ocr'));
  const ocr2Dir = path.join(path.dirname(ocrDir), 'ocr2');
  const linesOf = async (docId: string, page: number): Promise<OcrLine[] | null> => {
    try {
      const rot = extractBy.get(docId)?.rescuedRot ?? null;
      if (rot !== null) {
        const rows = (await readFile(path.join(ocr2Dir, `${docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: number; rot: number; lines: OcrLine[] });
        return rows.find((r) => r.page === page && r.rot === rot)?.lines ?? null;
      }
      const rows = (await readFile(path.join(ocrDir, `${docId}.jsonl`), 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage);
      return rows.find((r) => r.page === page && !r.alt)?.lines ?? null;
    } catch {
      return null;
    }
  };
  const out: LoadedPerson[] = [];
  for (const p of pkg.persons) {
    const pages: LoadedPerson['pages'] = [];
    for (const docId of docIdsForPerson(p, idx)) {
      for (const pg of extractBy.get(docId)?.pages ?? []) {
        if (!keep(pg.kinds)) continue;
        const lines = await linesOf(docId, pg.page);
        if (lines) pages.push({ docId, page: pg.page, lines });
      }
    }
    out.push({ person: p, pages });
  }
  return out;
}
