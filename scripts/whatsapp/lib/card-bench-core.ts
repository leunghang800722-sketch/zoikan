// WA-8 B：工卡辨識基準測試核心（純函數＋可注入引擎；唔讀檔案、唔打網絡）。輸出只有計數／比例／token，唔含任何值。
import { CARD_STRATEGIES, readCardPhoto, type CardPhotoResult, type CardStrategy } from '@/lib/whatsapp/card-ocr';
import type { CardEngine, CardEngineName, EngineOutcome, EngineUsage } from '@/lib/whatsapp/card-engines';
import { normStaffNo } from '@/lib/whatsapp/card-parse';

export class BenchArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchArgError';
  }
}

/** truth CSV：`file,staff_nos`（staff_nos 以 | 分隔多張卡；空＝相入面冇工卡）。表頭可有可無。 */
export function parseTruthCsv(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t) continue;
    const [file, nos = ''] = t.split(',').map((x) => x.trim());
    if (!file) throw new BenchArgError(`truth 第 ${i + 1} 行冇檔名`);
    if (i === 0 && /^file/i.test(file)) continue;
    const set = new Set<string>();
    for (const n of nos.split('|').map((x) => x.trim()).filter(Boolean)) {
      const no = normStaffNo(n);
      if (!no) throw new BenchArgError(`truth 第 ${i + 1} 行工號格式唔啱`);
      set.add(no);
    }
    out.set(file, set);
  }
  return out;
}

export interface TruthRow {
  name: string;
  /** 工號欄原樣（可無） */
  staff_no: string | null;
}
const normRowName = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '');
const normRowNo = (s: string | null | undefined): string => (s ?? '').normalize('NFKC').toUpperCase().replace(/[\s\-:]/g, '');

/** truth CSV 擴展：`file,staff_nos,rows`——rows 以 | 分隔，每行 `姓名~工號`（工號可省略）。回 file → { nos, rows }。 */
export function parseTruthDetail(text: string): Map<string, { nos: Set<string>; rows: TruthRow[] }> {
  const out = new Map<string, { nos: Set<string>; rows: TruthRow[] }>();
  const nosByFile = parseTruthCsv(text.split(/\r?\n/).map((l) => l.split(',').slice(0, 2).join(',')).join('\n'));
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split(',').map((x) => x.trim());
    const file = cols[0]!;
    if (i === 0 && /^file/i.test(file)) continue;
    const rows: TruthRow[] = (cols[2] ?? '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [name, no] = x.split('~');
        return { name: (name ?? '').trim(), staff_no: no?.trim() || null };
      });
    out.set(file, { nos: nosByFile.get(file) ?? new Set(), rows });
  }
  return out;
}

/** 逐行配對：姓名（NFKC 去空白）相同，而且 truth 有工號時工號欄要相同。回 { matched, produced, truth }。 */
export function scoreRows(produced: ReadonlyArray<{ name: string | null; staff_no_raw: string | null }>, truth: readonly TruthRow[]): { matched: number; produced: number; truth: number } {
  const used = new Set<number>();
  let matched = 0;
  for (const p of produced) {
    const hit = truth.findIndex((t, i) => !used.has(i) && normRowName(t.name) === normRowName(p.name ?? '') && (t.staff_no === null || normRowNo(t.staff_no) === normRowNo(p.staff_no_raw)));
    if (hit >= 0) {
      used.add(hit);
      matched += 1;
    }
  }
  return { matched, produced: produced.length, truth: truth.length };
}

/** 多人表（truth 有 rows）嘅類別：全中＝exact；冇出任何行＝unreadable；有出錯行（未配到 truth）＝wrong；其餘（漏行）＝review。 */
export function scoreSheet(sc: { matched: number; produced: number; truth: number }, reviewRows = 0): 'exact' | 'review' | 'wrong' | 'unreadable' {
  if (sc.produced === 0 && reviewRows === 0) return 'unreadable';
  if (sc.produced > sc.matched) return 'wrong';
  return sc.matched === sc.truth && reviewRows === 0 ? 'exact' : 'review';
}

export type EngineCategory = 'exact' | 'review' | 'wrong' | 'unreadable';
const eq = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** 單引擎一張相 → 類別。low confidence 當 review（上線時會出題）；truth 冇卡而引擎回空＝exact（正確拒絕）。 */
export function scoreEngine(out: EngineOutcome, truth: ReadonlySet<string>): EngineCategory {
  if (!out.ok) return 'unreadable';
  const read = new Set(out.cards.flatMap((c) => (c.staff_no ? [c.staff_no] : [])));
  const lowAll = out.cards.length > 0 && out.cards.every((c) => c.confidence === 'low');
  if (truth.size === 0) return read.size === 0 ? 'exact' : lowAll ? 'review' : 'wrong';
  if (read.size === 0) return 'unreadable';
  if (lowAll) return 'review';
  return eq(read, truth) ? 'exact' : 'wrong';
}

export type StrategyCategory = 'exact' | 'review' | 'confirmed_wrong' | 'unreadable';
export function scoreStrategy(r: CardPhotoResult, truth: ReadonlySet<string>): StrategyCategory {
  const confirmed = new Set(r.cards.filter((c) => c.status === 'confirmed' && c.staff_no).map((c) => c.staff_no!));
  if (truth.size === 0) {
    if (r.kind === 'not_card') return 'exact';
    return confirmed.size > 0 ? 'confirmed_wrong' : 'review';
  }
  if ([...confirmed].some((n) => !truth.has(n))) return 'confirmed_wrong';
  if (r.kind === 'unreadable' || r.cards.length === 0) return 'unreadable';
  const hasReview = r.cards.some((c) => c.status === 'review');
  return !hasReview && eq(confirmed, truth) ? 'exact' : 'review';
}

export interface TokenTally {
  photos: number;
  prompt: number;
  completion: number;
}
export interface EngineReport {
  engine: string;
  skipped?: string;
  photos: number;
  exact: number;
  review: number;
  wrong: number;
  unreadable: number;
  avg_prompt_tokens: number;
  avg_completion_tokens: number;
  /** 每張相預估成本（USD）：用實測 usage × env 單價；冇設單價＝null */
  est_usd_per_photo: number | null;
  /** WA-9：引擎失敗類別分佈（refusal／max_tokens／api_error_<status>…，固定碼，唔含內容）——診斷「引擎答 0/4」係失敗定係讀到空 */
  failures: Record<string, number>;
  /** 引擎有回應但冇讀到任何卡，而 truth 有卡嘅張數 */
  empty_but_truth_has_cards: number;
  /** WA-9 多人表逐行：recall＝配到嘅 truth 行／truth 總行；precision＝配到嘅行／引擎出嘅行；冇 truth rows＝null */
  row_recall: number | null;
  row_precision: number | null;
}
export interface StrategyReport {
  strategy: string;
  photos: number;
  exact: number;
  review: number;
  confirmed_wrong: number;
  unreadable: number;
  arbiter_triggered: number;
  arbiter_rate: number;
  avg_prompt_tokens: number;
  avg_completion_tokens: number;
  /** 按 provider／model 嘅 token 合計 */
  tokens_by_model: Record<string, { prompt: number; completion: number }>;
  /** 每張相預估成本（USD）：實測 usage × env 單價（WA_CARD_PRICE_USD_PER_MTOK）；冇設＝null */
  est_usd_per_photo: number | null;
  /** WA-9 多人表逐行（只計 confirmed 行；review 行另計）：recall／precision／review 行數；冇 truth rows＝null */
  row_recall: number | null;
  row_precision: number | null;
  rows_review: number;
}
export interface BenchReport {
  photos: number;
  engines: EngineReport[];
  strategies: StrategyReport[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export interface BenchInput {
  /** 相片 id（唔含路徑／值）→ bytes 由 loadPhoto 提供 */
  photos: ReadonlyArray<{ id: string; truth: ReadonlySet<string>; /** 多人表逐行 truth（可選） */ rows?: readonly TruthRow[] }>;
  engines: ReadonlyArray<{ key: string; engine: CardEngine }>;
  strategies: readonly CardStrategy[];
  load: (id: string) => Promise<Buffer>;
  /** 每百萬 token 單價（USD），按引擎名；冇＝唔估成本 */
  prices?: Record<string, { in: number; out: number }>;
}

export async function runBench(inp: BenchInput): Promise<BenchReport> {
  // 每個引擎每張相只跑一次（快取），策略用快取引擎重組
  const cache = new Map<string, Map<string, EngineOutcome>>();
  const unavailable = new Set<string>();
  const engineOut = async (key: string, engine: CardEngine, id: string, bytes: Buffer): Promise<EngineOutcome> => {
    const m = cache.get(key) ?? cache.set(key, new Map()).get(key)!;
    const hit = m.get(id);
    if (hit) return hit;
    const out = await engine.read(bytes);
    if (!out.ok && out.error === 'unavailable') unavailable.add(key);
    m.set(id, out);
    return out;
  };
  const cached = (key: string, engine: CardEngine, id: string, bytes: Buffer): CardEngine => ({ name: engine.name, model: engine.model, read: () => engineOut(key, engine, id, bytes) });

  const engineReports: EngineReport[] = [];
  for (const { key, engine } of inp.engines) {
    const rep: EngineReport = { engine: key, photos: 0, exact: 0, review: 0, wrong: 0, unreadable: 0, avg_prompt_tokens: 0, avg_completion_tokens: 0, est_usd_per_photo: null, failures: {}, empty_but_truth_has_cards: 0, row_recall: null, row_precision: null };
    let p = 0;
    let c = 0;
    const rowAcc = { matched: 0, produced: 0, truth: 0 };
    for (const ph of inp.photos) {
      const out = await engineOut(key, engine, ph.id, await inp.load(ph.id));
      if (!out.ok && out.error === 'unavailable') {
        rep.skipped = '引擎不可用（冇 key／冇 binary），已跳過';
        break;
      }
      rep.photos += 1;
      const engSheet = ph.rows && ph.rows.length > 0 ? scoreRows(out.ok ? (out.rows ?? []).map((r) => ({ name: r.name_zh, staff_no_raw: r.staff_no_raw })) : [], ph.rows) : null;
      rep[engSheet ? scoreSheet(engSheet) : scoreEngine(out, ph.truth)] += 1;
      if (!out.ok) {
        const k = out.reason ?? out.error;
        rep.failures[k] = (rep.failures[k] ?? 0) + 1;
      } else if (out.cards.length === 0 && ph.truth.size > 0) rep.empty_but_truth_has_cards += 1;
      if (ph.rows && ph.rows.length > 0) {
        const sc = scoreRows(out.ok ? (out.rows ?? []).map((r) => ({ name: r.name_zh, staff_no_raw: r.staff_no_raw })) : [], ph.rows);
        rowAcc.matched += sc.matched;
        rowAcc.produced += sc.produced;
        rowAcc.truth += sc.truth;
      }
      p += out.usage?.promptTokens ?? 0;
      c += out.usage?.completionTokens ?? 0;
    }
    if (rowAcc.truth > 0) {
      rep.row_recall = r2(rowAcc.matched / rowAcc.truth);
      rep.row_precision = rowAcc.produced > 0 ? r2(rowAcc.matched / rowAcc.produced) : 0;
    }
    rep.avg_prompt_tokens = rep.photos ? r2(p / rep.photos) : 0;
    rep.avg_completion_tokens = rep.photos ? r2(c / rep.photos) : 0;
    const ep = inp.prices?.[inp.engines.find((e) => e.key === key)!.engine.name];
    rep.est_usd_per_photo = ep && rep.photos ? Math.round(((p * ep.in + c * ep.out) / 1e6 / rep.photos) * 1e7) / 1e7 : null;
    engineReports.push(rep);
  }

  const byName = new Map<CardEngineName, { key: string; engine: CardEngine }>();
  for (const e of inp.engines) if (!byName.has(e.engine.name) && !unavailable.has(e.key)) byName.set(e.engine.name, e);
  const strategyReports: StrategyReport[] = [];
  for (const s of inp.strategies) {
    const def = CARD_STRATEGIES[s];
    const need = [...def.primary, def.arbiter] as CardEngineName[];
    const rep: StrategyReport = { strategy: s, photos: 0, exact: 0, review: 0, confirmed_wrong: 0, unreadable: 0, arbiter_triggered: 0, arbiter_rate: 0, avg_prompt_tokens: 0, avg_completion_tokens: 0, tokens_by_model: {}, est_usd_per_photo: null, row_recall: null, row_precision: null, rows_review: 0 };
    const fbd = 'fallback' in def ? (def.fallback as { for: CardEngineName; use: CardEngineName }) : null;
    // 有後備引擎：主引擎缺但後備在 → 唔算缺
    const missing = need.filter((n) => !byName.has(n) && !(fbd && n === fbd.for && byName.has(fbd.use)));
    if (missing.length > 0) {
      strategyReports.push({ ...rep, strategy: `${s}（跳過：缺 ${missing.join('+')}）` });
      continue;
    }
    let p = 0;
    let c = 0;
    const rowAcc = { matched: 0, produced: 0, truth: 0 };
    for (const ph of inp.photos) {
      const bytes = await inp.load(ph.id);
      const engines: Partial<Record<CardEngineName, CardEngine>> = {};
      for (const n of need) {
        const e = byName.get(n)!;
        engines[n] = cached(e.key, e.engine, ph.id, bytes);
      }
      const r = await readCardPhoto(bytes, { strategy: s, engines });
      rep.photos += 1;
      if (ph.rows && ph.rows.length > 0) {
        const confirmed = r.cards.filter((x) => x.status === 'confirmed');
        const sc = scoreRows(confirmed.map((x) => ({ name: x.name_zh, staff_no_raw: x.staff_no ?? x.wilson_staff_no_raw ?? null })), ph.rows);
        const cat = scoreSheet(sc, r.cards.length - confirmed.length);
        rep[cat === 'wrong' ? 'confirmed_wrong' : cat] += 1;
        rowAcc.matched += sc.matched;
        rowAcc.produced += sc.produced;
        rowAcc.truth += sc.truth;
        rep.rows_review += r.cards.length - confirmed.length;
      } else rep[scoreStrategy(r, ph.truth)] += 1;
      if (r.arbiter_used) rep.arbiter_triggered += 1;
      for (const u of r.usage as EngineUsage[]) {
        p += u.promptTokens;
        c += u.completionTokens;
        const k = `${u.engine}:${u.model}`;
        const t = (rep.tokens_by_model[k] ??= { prompt: 0, completion: 0 });
        t.prompt += u.promptTokens;
        t.completion += u.completionTokens;
      }
    }
    if (rowAcc.truth > 0) {
      rep.row_recall = r2(rowAcc.matched / rowAcc.truth);
      rep.row_precision = rowAcc.produced > 0 ? r2(rowAcc.matched / rowAcc.produced) : 0;
    }
    rep.arbiter_rate = rep.photos ? r2(rep.arbiter_triggered / rep.photos) : 0;
    rep.avg_prompt_tokens = rep.photos ? r2(p / rep.photos) : 0;
    rep.avg_completion_tokens = rep.photos ? r2(c / rep.photos) : 0;
    if (inp.prices) {
      let usd = 0;
      for (const [k, t] of Object.entries(rep.tokens_by_model)) {
        const pr = inp.prices[k.split(':')[0]!];
        if (pr) usd += (t.prompt * pr.in + t.completion * pr.out) / 1e6;
      }
      rep.est_usd_per_photo = Object.keys(inp.prices).length && rep.photos ? Math.round((usd / rep.photos) * 1e7) / 1e7 : null;
    }
    strategyReports.push(rep);
  }
  return { photos: inp.photos.length, engines: engineReports, strategies: strategyReports };
}

export function summaryLines(r: BenchReport): string[] {
  const out = [`[card-bench] 相片 ${r.photos} 張`];
  for (const e of r.engines) {
    out.push(e.skipped ? `[card-bench] 引擎 ${e.engine}：${e.skipped}` : `[card-bench] 引擎 ${e.engine}：exact ${e.exact}｜review ${e.review}｜wrong ${e.wrong}｜unreadable ${e.unreadable}｜每張 prompt ${e.avg_prompt_tokens}／completion ${e.avg_completion_tokens} tokens${e.est_usd_per_photo === null ? '' : `｜預估 US$${e.est_usd_per_photo}／張`}${Object.keys(e.failures).length ? `｜失敗 ${Object.entries(e.failures).map(([k, n]) => `${k}×${n}`).join(',')}` : ''}${e.empty_but_truth_has_cards ? `｜讀到空 ${e.empty_but_truth_has_cards}` : ''}${e.row_recall === null ? '' : `｜逐行 recall ${e.row_recall}／precision ${e.row_precision}`}`);
  }
  for (const s of r.strategies) {
    out.push(`[card-bench] 策略 ${s.strategy}：exact ${s.exact}｜review ${s.review}｜confirmed_wrong ${s.confirmed_wrong}｜unreadable ${s.unreadable}｜仲裁觸發 ${(s.arbiter_rate * 100).toFixed(0)}%｜每張 prompt ${s.avg_prompt_tokens}／completion ${s.avg_completion_tokens} tokens${s.est_usd_per_photo === null ? '' : `｜預估 US$${s.est_usd_per_photo}／張`}${s.row_recall === null ? '' : `｜逐行 recall ${s.row_recall}／precision ${s.row_precision}／review ${s.rows_review}`}`);
  }
  return out;
}
