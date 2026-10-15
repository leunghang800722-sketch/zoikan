// WP-OCR-5：OCR 準確度評估腳本（本機跑，規劃者用真檔；執行員只用合成 fixture）。
//   npx tsx scripts/staff-import/eval-ocr.ts --manifest <manifest.json> --out data/2026-10/ocr-eval/report.json [--flow legacy|two-stage] [--limit N] [--only-doc-type id_card|address_proof|onboarding_form] [--concurrency 2]
//   npx tsx scripts/staff-import/eval-ocr.ts --dry [--manifest tests/fixtures/ocr-eval/manifest.dry.json]   # fake client＋合成 fixture，唔打任何 API
// 真跑用同一條應用內路徑：同規格圖（1,600px 全圖＋2×2 放大格）→ getReadClients()（真 Claude／DeepSeek，key 由 .env 經 dotenv 載入；
// 指定其他 env 檔用 DOTENV_CONFIG_PATH）→ readDocument（reconcile／候選／仲裁）→ 逐欄對 truth（現有 normalize canon）。
// 輸出淨係計數同百分比：唔印欄位值、姓名、圖片路徑；--out JSON 只記 case id＋逐欄結果類別。
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OCR_DOC_TYPES, type OcrDocType } from '@/lib/guards/ocr/config';
import { getReadClients } from '@/lib/guards/ocr/clients';
import { ArgError, fakeClientsFor, type EvalFlow, parseManifest, resolveReportPath, runEval, summaryLines, type EvalDeps } from './lib/eval-ocr-core';
import { prepareDocumentImages } from './lib/eval-ocr-images';

interface Args {
  manifest: string | null;
  out: string | null;
  dry: boolean;
  limit: number | null;
  onlyDocType: OcrDocType | null;
  concurrency: number;
  flow: EvalFlow;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { manifest: null, out: null, dry: false, limit: null, onlyDocType: null, concurrency: 2, flow: 'two-stage' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new ArgError(`${k} 缺少參數值`);
      return x;
    };
    if (k === '--manifest') a.manifest = v();
    else if (k === '--out') a.out = v();
    else if (k === '--dry') a.dry = true;
    else if (k === '--limit') {
      const x = v();
      if (!/^\d+$/.test(x) || Number(x) < 1) throw new ArgError('--limit 必須係正整數');
      a.limit = Number(x);
    }
    else if (k === '--flow') {
      const f = v();
      if (f !== 'legacy' && f !== 'two-stage') throw new ArgError('--flow 必須係 legacy｜two-stage');
      a.flow = f;
    } else if (k === '--only-doc-type') {
      const t = v();
      if (!(OCR_DOC_TYPES as readonly string[]).includes(t)) throw new ArgError('--only-doc-type 必須係 id_card｜address_proof｜onboarding_form');
      a.onlyDocType = t as OcrDocType;
    } else if (k === '--concurrency') a.concurrency = Math.min(8, Math.max(1, Number.parseInt(v(), 10) || 2));
    else throw new ArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const manifestPath = path.resolve(args.manifest ?? (args.dry ? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ocr-eval/manifest.dry.json') : ''));
  if (!args.manifest && !args.dry) {
    console.error('需要 --manifest <path>（或者 --dry 用內置合成 manifest）');
    return 2;
  }
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf-8'));
  const parsed = parseManifest(raw);
  if (!parsed.ok) {
    console.error(`manifest 格式唔啱（${parsed.path}）`);
    return 2;
  }
  const outPath = args.out ? resolveReportPath(args.out, process.cwd()) : null;
  const deps: EvalDeps = {
    clientsFor: args.dry ? fakeClientsFor : (() => {
      const clients = getReadClients();
      return () => clients;
    })(),
    prepare: (p, page) => prepareDocumentImages(p, page ?? 1),
    baseDir: path.dirname(manifestPath),
    onlyDocType: args.onlyDocType,
    flow: args.flow,
  };
  console.log(`[eval-ocr] ${args.dry ? 'dry（fake client）' : 'live（真 client）'}｜flow ${args.flow}｜cases ${parsed.manifest.cases.length}｜concurrency ${args.concurrency}`);
  const report = await runEval({
    manifest: parsed.manifest,
    deps,
    mode: args.dry ? 'dry' : 'live',
    limit: args.limit,
    concurrency: args.concurrency,
    onProgress: (done, total, ok) => console.log(`[eval-ocr] ${done}/${total} ${ok ? 'ok' : 'failed'}`),
  });
  for (const l of summaryLines(report)) console.log(l);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log('[eval-ocr] 報表已寫入 --out');
  }
  return report.cases.failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(e instanceof ArgError ? `[eval-ocr] ${e.message}` : `[eval-ocr] error ${e instanceof Error ? e.name : typeof e}`);
    process.exit(1);
  });
}
