// WA-8 B：工卡辨識基準測試（離線、只讀、唔寫 DB）。
//   npx tsx scripts/whatsapp/card-ocr-bench.ts --dir <相片資料夾> --truth <truth.csv> [--engines tesseract,deepseek,haiku,qwen,claude] [--qwen-models qwen-vl-ocr,qwen3-vl-plus] [--strategies S1,S2,S3,S4,S5] [--out data/…/report.json]
//   npx tsx scripts/whatsapp/card-ocr-bench.ts --dry        # 合成 fixture＋fake 引擎，唔打任何 API／唔讀檔
// truth.csv：`file,staff_nos`（多張卡用 | 分隔；staff_nos 空＝相入面冇工卡）。
// key 由 .env（dotenv）／環境變數讀（CLAUDE_API_KEY／DEEPSEEK_API_KEY／QWEN_API_KEY…），唔寫入任何檔案／log。
// 輸出淨係計數、比例、token 用量：唔印工號、姓名、檔名、圖片路徑。上線前門檻：工號 exact ≥90%、confirmed-but-wrong 0。
import 'dotenv/config';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, CARD_ENGINE_NAMES, qwenModel, type CardEngine, type CardEngineName, type EngineOutcome } from '@/lib/whatsapp/card-engines';
import { CARD_STRATEGIES, type CardStrategy } from '@/lib/whatsapp/card-ocr';
import { BenchArgError, parseTruthDetail, runBench, summaryLines, type BenchInput } from './lib/card-bench-core';

interface Args {
  dir: string | null;
  truth: string | null;
  engines: CardEngineName[];
  qwenModels: string[];
  strategies: CardStrategy[];
  out: string | null;
  dry: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { dir: null, truth: null, engines: [...CARD_ENGINE_NAMES], qwenModels: [], strategies: Object.keys(CARD_STRATEGIES) as CardStrategy[], out: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new BenchArgError(`${k} 缺少參數值`);
      return x;
    };
    if (k === '--dir') a.dir = v();
    else if (k === '--truth') a.truth = v();
    else if (k === '--out') a.out = v();
    else if (k === '--dry') a.dry = true;
    else if (k === '--engines') {
      const xs = v().split(',').map((x) => x.trim()).filter(Boolean);
      const bad = xs.find((x) => !(CARD_ENGINE_NAMES as readonly string[]).includes(x));
      if (bad || xs.length === 0) throw new BenchArgError(`--engines 只接受 ${CARD_ENGINE_NAMES.join('｜')}`);
      a.engines = xs as CardEngineName[];
    } else if (k === '--qwen-models') {
      a.qwenModels = v().split(',').map((x) => x.trim()).filter((x) => /^[\w.-]{1,60}$/.test(x));
    } else if (k === '--strategies') {
      const xs = v().split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (xs.some((x) => !(x in CARD_STRATEGIES))) throw new BenchArgError(`--strategies 只接受 ${Object.keys(CARD_STRATEGIES).join('｜')}`);
      a.strategies = xs as CardStrategy[];
    } else throw new BenchArgError(`唔認得嘅參數 ${k}`);
  }
  return a;
}

/** --out 必須喺 data/ 之下（gitignored，唔會入 git）。 */
function resolveOut(out: string, cwd: string): string {
  const abs = path.resolve(cwd, out);
  if (!abs.startsWith(path.resolve(cwd, 'data') + path.sep)) throw new BenchArgError('out_not_under_data: --out 必須喺 data/ 之下');
  return abs;
}

// ---- --dry：合成 fixture（假引擎，固定輸出）----
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
function fakeEngine(name: CardEngineName, script: Record<string, EngineOutcome>): CardEngine {
  return { name, model: `fake-${name}`, read: async (b) => script[b.toString('utf8')] ?? { ok: true, is_card: false, cards: [], usage: null } };
}
const card = (no: string | null, conf: 'high' | 'medium' | 'low' = 'high') => ({ is_card: true, staff_no: no, name_zh: null, name_en: null, confidence: conf });
const ok = (engine: CardEngineName, nos: string[], p = 300, c = 40): EngineOutcome => ({ ok: true, is_card: nos.length > 0, cards: nos.map((n) => card(n)), usage: engine === 'tesseract' ? null : { engine, model: `fake-${engine}`, promptTokens: p, completionTokens: c } });
export function dryFixture(): BenchInput {
  const photos = [
    { id: 'p1', truth: new Set(['U12345']) },
    { id: 'p2', truth: new Set(['MP1234']) },
    { id: 'p3', truth: new Set<string>() },
    { id: 'p4', truth: new Set(['U22222', 'MG3333']) },
  ];
  const scripts: Record<CardEngineName, Record<string, EngineOutcome>> = {
    tesseract: { p1: ok('tesseract', ['U12345']), p2: ok('tesseract', ['MP1235']), p3: ok('tesseract', []), p4: ok('tesseract', ['U22222']) },
    deepseek: { p1: ok('deepseek', ['U12345']), p2: ok('deepseek', ['MP1234']), p3: ok('deepseek', []), p4: ok('deepseek', ['U22222', 'MG3333']) },
    haiku: { p1: ok('haiku', ['U12345']), p2: ok('haiku', ['MP1234']), p3: ok('haiku', []), p4: ok('haiku', ['U22222', 'MG3333']) },
    qwen: { p1: ok('qwen', ['U12345']), p2: ok('qwen', ['MP1234']), p3: ok('qwen', []), p4: ok('qwen', ['U22222', 'MG3333']) },
    claude: { p1: ok('claude', ['U12345'], 900, 60), p2: ok('claude', ['MP1234'], 900, 60), p3: ok('claude', [], 900, 60), p4: ok('claude', ['U22222', 'MG3333'], 900, 60) },
  };
  return {
    photos,
    engines: CARD_ENGINE_NAMES.map((n) => ({ key: n, engine: fakeEngine(n, scripts[n]) })),
    strategies: Object.keys(CARD_STRATEGIES) as CardStrategy[],
    load: async (id) => Buffer.from(id, 'utf8'),
  };
}

export async function run(args: Args, cwd: string = process.cwd()): Promise<{ lines: string[]; report: Awaited<ReturnType<typeof runBench>> }> {
  let input: BenchInput;
  if (args.dry) {
    input = { ...dryFixture(), strategies: args.strategies };
  } else {
    if (!args.dir || !args.truth) throw new BenchArgError('要 --dir 同 --truth（或者 --dry）');
    const truth = parseTruthDetail(await readFile(path.resolve(cwd, args.truth), 'utf-8'));
    const dir = path.resolve(cwd, args.dir);
    const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f) && truth.has(f));
    if (files.length === 0) throw new BenchArgError('冇任何相片同 truth 對得上（檔名要一致）');
    const ids = files.map((_, i) => `photo${i + 1}`); // 輸出同 cache key 用匿名序號，唔用檔名
    const byId = new Map(ids.map((id, i) => [id, files[i]!]));
    const wantQwen = args.engines.includes('qwen');
    const engines: Array<{ key: string; engine: CardEngine }> = [];
    for (const n of args.engines) {
      if (n === 'qwen') {
        const models = args.qwenModels.length ? args.qwenModels : [qwenModel()];
        models.forEach((m, i) => engines.push({ key: i === 0 ? 'qwen' : `qwen:${m}`, engine: createEngine('qwen', { qwenModel: m }) }));
      } else engines.push({ key: n, engine: createEngine(n) });
    }
    void wantQwen;
    input = {
      photos: ids.map((id, i) => ({ id, truth: truth.get(files[i]!)!.nos, rows: truth.get(files[i]!)!.rows })),
      engines,
      strategies: args.strategies,
      load: async (id) => readFile(path.join(dir, byId.get(id)!)),
    };
  }
  const { waCardPrices } = await import('@/lib/whatsapp/card-prices');
  const prices = waCardPrices();
  const report = await runBench({ ...input, ...(Object.keys(prices).length ? { prices } : {}) });
  const lines = summaryLines(report);
  if (args.out) {
    const p = resolveOut(args.out, cwd);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2));
    lines.push('[card-bench] 報表已寫入 --out（淨計數）');
  }
  return { lines, report };
}

void JPEG;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(parseArgs(process.argv.slice(2)))
    .then((r) => {
      for (const l of r.lines) console.log(l);
    })
    .catch((e) => {
      console.error(e instanceof BenchArgError ? `[card-bench] ${e.message}` : '[card-bench] 失敗');
      process.exit(e instanceof BenchArgError ? 2 : 1);
    });
}
