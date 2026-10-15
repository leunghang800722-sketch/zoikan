// WP-OCR-5：OCR 準確度評估核心（純邏輯＋可注入 client／圖片準備，方便 vitest 用合成 fixture 測）。
// 鐵則：報表／console 淨係計數同百分比——唔印欄位值、唔印姓名、唔印圖片路徑；per-case 淨記 case id＋逐欄結果類別。
import path from 'node:path';
import { z } from 'zod';
import { OCR_DOC_FIELDS, OCR_DOC_TYPES, type OcrDocType, type OcrFieldKey } from '@/lib/guards/ocr/config';
import { normalizeField, type FieldResult, type FieldStatus } from '@/lib/guards/ocr/normalize';
import { readDocument, type DocumentReadResult } from '@/lib/guards/ocr/read';
import type { ReadClients } from '@/lib/guards/ocr/clients';
import type { VisionClient, VisionRequest, VisionResponse } from '@/lib/guards/ocr/vision-client';

/** 命令列參數錯誤：message 係固定說明（唔帶值），CLI 會原樣印出。 */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export const TRUTH_FIELDS = ['name_zh', 'name_en', 'hkid', 'dob', 'sex', 'phone', 'address', 'bank_account'] as const;
export type TruthField = (typeof TRUTH_FIELDS)[number];
/** 路徑 A 讀得到嘅欄位（bank_account 唔係 A 路徑嘅欄，truth 有都會略過並喺報表標明） */
const EVALUABLE = new Set<string>(['name_zh', 'name_en', 'hkid', 'dob', 'sex', 'phone', 'address']);

const fakeValue = z.union([z.string(), z.null(), z.object({ value: z.string().nullable(), confidence: z.enum(['high', 'medium', 'low']).optional(), reason: z.string().nullable().optional(), alternatives: z.array(z.string()).optional() }).strict()]);
const fakeRead = z.record(z.string(), fakeValue);
const fakeSpec = z.object({ a: fakeRead.optional(), b: fakeRead.optional(), arbiter: fakeRead.optional() }).strict();

export const manifestSchema = z
  .object({
    cases: z.array(
      z
        .object({
          id: z.string().min(1).max(80),
          docs: z.array(z.object({ type: z.enum(OCR_DOC_TYPES), image: z.string().min(1), page: z.number().int().min(1).optional() }).strict()).min(1).max(3),
          truth: z.object(Object.fromEntries(TRUTH_FIELDS.map((k) => [k, z.string().optional()])) as Record<TruthField, z.ZodOptional<z.ZodString>>).strict(),
          /** 只喺 --dry 用：每種文件嘅 fake 回應覆蓋（冇寫＝按 truth 完美回應） */
          fake: z.object({ id_card: fakeSpec.optional(), address_proof: fakeSpec.optional(), onboarding_form: fakeSpec.optional() }).strict().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type EvalCase = Manifest['cases'][number];

/** 解析 manifest；失敗只回欄位路徑（唔回值）。 */
export function parseManifest(raw: unknown): { ok: true; manifest: Manifest } | { ok: false; path: string } {
  const r = manifestSchema.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, path: r.error.issues[0]?.path.join('.') || 'manifest' };
}

// ---------- 逐欄比較 ----------
export type Outcome = 'exact' | 'review_contains_truth' | 'wrong' | 'missing';

export interface FieldEval {
  doc: OcrDocType;
  field: OcrFieldKey;
  outcome: Outcome;
  status: FieldStatus;
  /** 預填值（value）正規化後等於 truth */
  valueCorrect: boolean;
  /** review 欄嘅候選數（confirmed／missing＝0） */
  candidateCount: number;
}

/**
 * exact＝confirmed 且值等於 truth；review_contains_truth＝review 且 truth 喺候選（含預填值）入面；
 * wrong＝confirmed 但值錯（最危險），或 review 但候選都唔含 truth；missing＝讀唔到。比較用現有 normalize canon。
 */
export function classifyField(field: OcrFieldKey, truth: string, r: FieldResult, doc: OcrDocType, now: Date = new Date()): FieldEval {
  const t = normalizeField(field, truth, now).canon;
  const canon = (v: string) => normalizeField(field, v, now).canon;
  const valueCorrect = r.status !== 'missing' && r.value !== '' && canon(r.value) === t;
  const cands = r.status === 'review' ? (r.candidates_ranked?.length ? r.candidates_ranked.map((c) => c.value) : r.candidates) : [];
  let outcome: Outcome;
  if (r.status === 'missing') outcome = 'missing';
  else if (r.status === 'confirmed') outcome = valueCorrect ? 'exact' : 'wrong';
  else outcome = valueCorrect || cands.some((c) => canon(c) === t) ? 'review_contains_truth' : 'wrong';
  return { doc, field, outcome, status: r.status, valueCorrect, candidateCount: r.status === 'review' ? cands.length : 0 };
}

// ---------- 彙總 ----------
export interface Tally {
  n: number;
  exact: number;
  review_contains_truth: number;
  wrong: number;
  missing: number;
  /** wrong 當中「confirmed 但值錯」 */
  confirmed_wrong: number;
  review_total: number;
  /** review 欄預填值已經啱（只需撳確認） */
  review_value_correct: number;
  candidate_sum: number;
}
const emptyTally = (): Tally => ({ n: 0, exact: 0, review_contains_truth: 0, wrong: 0, missing: 0, confirmed_wrong: 0, review_total: 0, review_value_correct: 0, candidate_sum: 0 });

function addTo(t: Tally, e: FieldEval): void {
  t.n += 1;
  t[e.outcome] += 1;
  if (e.outcome === 'wrong' && e.status === 'confirmed') t.confirmed_wrong += 1;
  if (e.status === 'review') {
    t.review_total += 1;
    t.candidate_sum += e.candidateCount;
    if (e.valueCorrect) t.review_value_correct += 1;
  }
}

const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

export interface TallyView extends Tally {
  pct: { exact: number; review_contains_truth: number; wrong: number; missing: number };
  /** review 欄佔已評估欄位 % */
  review_rate_pct: number;
  /** review 欄平均候選數 */
  avg_candidates: number;
  /** 估算人手改字次數＝wrong＋missing */
  manual_edits_estimate: number;
  /** 估算撳候選次數＝review 欄入面 truth 在候選但預填值唔啱 */
  chip_taps_estimate: number;
}
function view(t: Tally): TallyView {
  return {
    ...t,
    pct: { exact: pct(t.exact, t.n), review_contains_truth: pct(t.review_contains_truth, t.n), wrong: pct(t.wrong, t.n), missing: pct(t.missing, t.n) },
    review_rate_pct: pct(t.review_total, t.n),
    avg_candidates: t.review_total ? Math.round((t.candidate_sum / t.review_total) * 100) / 100 : 0,
    manual_edits_estimate: t.wrong + t.missing,
    chip_taps_estimate: t.review_contains_truth - t.review_value_correct,
  };
}

export interface UsageSum {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  arbiter_calls: number;
  by_provider: Record<'claude' | 'deepseek', { calls: number; prompt_tokens: number; completion_tokens: number }>;
}
const emptyUsage = (): UsageSum => ({ calls: 0, prompt_tokens: 0, completion_tokens: 0, arbiter_calls: 0, by_provider: { claude: { calls: 0, prompt_tokens: 0, completion_tokens: 0 }, deepseek: { calls: 0, prompt_tokens: 0, completion_tokens: 0 } } });
function addUsage(u: UsageSum, r: DocumentReadResult): void {
  u.calls += r.usage.calls;
  u.prompt_tokens += r.usage.promptTokens;
  u.completion_tokens += r.usage.completionTokens;
  if (r.arbiter.called) u.arbiter_calls += 1;
  for (const p of ['claude', 'deepseek'] as const) {
    u.by_provider[p].calls += r.usage_by_provider[p].calls;
    u.by_provider[p].prompt_tokens += r.usage_by_provider[p].promptTokens;
    u.by_provider[p].completion_tokens += r.usage_by_provider[p].completionTokens;
  }
}

export interface CaseOutcome {
  id: string;
  ok: boolean;
  /** 失敗類別（固定字串，唔帶內容） */
  error?: string;
  fields: FieldEval[];
  usage: UsageSum;
  /** truth 有但路徑 A 唔讀嘅欄（例如 bank_account）／該文件類型唔包含嘅欄 */
  skipped_truth_fields: string[];
}

export interface EvalReport {
  generated_at: string;
  mode: 'dry' | 'live';
  options: { limit: number | null; only_doc_type: OcrDocType | null; concurrency: number };
  cases: { total: number; ok: number; failed: number };
  overall: TallyView;
  by_field: Record<string, TallyView>;
  by_doc_field: Record<string, TallyView>;
  usage: UsageSum;
  /** 逐 case：淨 id＋逐欄結果類別（doc.field → outcome），冇值 */
  per_case: { id: string; ok: boolean; error?: string; outcomes: Record<string, Outcome> }[];
  notes: string[];
}

export function buildReport(outcomes: readonly CaseOutcome[], meta: { mode: 'dry' | 'live'; limit: number | null; onlyDocType: OcrDocType | null; concurrency: number; now?: Date }): EvalReport {
  const overall = emptyTally();
  const byField = new Map<string, Tally>();
  const byDocField = new Map<string, Tally>();
  const usage = emptyUsage();
  const skipped = new Set<string>();
  for (const c of outcomes) {
    if (c.ok) {
      for (const e of c.fields) {
        addTo(overall, e);
        addTo(byField.get(e.field) ?? byField.set(e.field, emptyTally()).get(e.field)!, e);
        const k = `${e.doc}.${e.field}`;
        addTo(byDocField.get(k) ?? byDocField.set(k, emptyTally()).get(k)!, e);
      }
    }
    const u = c.usage;
    usage.calls += u.calls;
    usage.prompt_tokens += u.prompt_tokens;
    usage.completion_tokens += u.completion_tokens;
    usage.arbiter_calls += u.arbiter_calls;
    for (const p of ['claude', 'deepseek'] as const) for (const m of ['calls', 'prompt_tokens', 'completion_tokens'] as const) usage.by_provider[p][m] += u.by_provider[p][m];
    for (const s of c.skipped_truth_fields) skipped.add(s);
  }
  const sorted = <T,>(m: Map<string, T>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const viewAll = (m: Map<string, Tally>) => Object.fromEntries(Object.entries(sorted(m)).map(([k, v]) => [k, view(v)]));
  const failed = outcomes.filter((c) => !c.ok).length;
  const notes: string[] = [];
  if (skipped.size) notes.push(`truth 有但冇比較嘅欄（路徑 A 唔讀，或者該文件類型唔包含）：${[...skipped].sort().join('、')}`);
  if (failed) notes.push(`${failed} 個 case 重試後仍失敗，唔計入逐欄統計`);
  return {
    generated_at: (meta.now ?? new Date()).toISOString(),
    mode: meta.mode,
    options: { limit: meta.limit, only_doc_type: meta.onlyDocType, concurrency: meta.concurrency },
    cases: { total: outcomes.length, ok: outcomes.length - failed, failed },
    overall: view(overall),
    by_field: viewAll(byField),
    by_doc_field: viewAll(byDocField),
    usage,
    per_case: outcomes.map((c) => ({ id: c.id, ok: c.ok, ...(c.error ? { error: c.error } : {}), outcomes: Object.fromEntries(c.fields.map((e) => [`${e.doc}.${e.field}`, e.outcome])) })),
    notes,
  };
}

/** console 摘要：淨計數／百分比，無值無姓名。 */
export function summaryLines(r: EvalReport): string[] {
  const o = r.overall;
  const lines = [
    `cases ${r.cases.ok}/${r.cases.total} ok（失敗 ${r.cases.failed}）｜已評估欄位 ${o.n}`,
    `exact ${o.exact} (${o.pct.exact}%)｜review_contains_truth ${o.review_contains_truth} (${o.pct.review_contains_truth}%)｜wrong ${o.wrong} (${o.pct.wrong}%)，其中 confirmed 但錯 ${o.confirmed_wrong}｜missing ${o.missing} (${o.pct.missing}%)`,
    `review 率 ${o.review_rate_pct}%｜平均候選數 ${o.avg_candidates}｜估算人手改字 ${o.manual_edits_estimate} 次｜估算撳候選 ${o.chip_taps_estimate} 次`,
    `呼叫 ${r.usage.calls}（仲裁 ${r.usage.arbiter_calls} 份文件）｜tokens in ${r.usage.prompt_tokens} / out ${r.usage.completion_tokens}｜claude ${r.usage.by_provider.claude.calls} 次、deepseek ${r.usage.by_provider.deepseek.calls} 次`,
  ];
  for (const [k, v] of Object.entries(r.by_field)) lines.push(`  ${k}: n=${v.n} exact ${v.pct.exact}% review_has_truth ${v.pct.review_contains_truth}% wrong ${v.pct.wrong}% missing ${v.pct.missing}%`);
  for (const n of r.notes) lines.push(`註：${n}`);
  return lines;
}

// ---------- 單 case ----------
export interface PreparedImages {
  full: string;
  tiles: readonly string[];
}
export interface EvalDeps {
  /** 每份文件砌 client（live＝同一組真 client；dry＝按 case.fake 砌） */
  clientsFor(c: EvalCase, doc: OcrDocType): ReadClients;
  prepare(imagePath: string, page: number | undefined): Promise<PreparedImages>;
  baseDir: string;
  onlyDocType: OcrDocType | null;
  now?: Date;
}

export async function evalCase(c: EvalCase, deps: EvalDeps): Promise<CaseOutcome> {
  const usage = emptyUsage();
  const fields: FieldEval[] = [];
  const skipped = new Set<string>();
  const now = deps.now ?? new Date();
  const docs = c.docs.filter((d) => !deps.onlyDocType || d.type === deps.onlyDocType);
  for (const [k, v] of Object.entries(c.truth)) if (v && !EVALUABLE.has(k)) skipped.add(k);
  for (const d of docs) {
    const abs = path.isAbsolute(d.image) ? d.image : path.resolve(deps.baseDir, d.image);
    const images = await deps.prepare(abs, d.page);
    const r = await readDocument(deps.clientsFor(c, d.type), d.type, images, now);
    addUsage(usage, r);
    for (const f of OCR_DOC_FIELDS[d.type]) {
      const truth = c.truth[f as TruthField];
      const res = r.fields[f];
      if (!truth || !res) continue;
      fields.push(classifyField(f, truth, res, d.type, now));
    }
  }
  for (const k of EVALUABLE) {
    const t = c.truth[k as TruthField];
    if (t && !docs.some((d) => OCR_DOC_FIELDS[d.type].includes(k as OcrFieldKey))) skipped.add(k);
  }
  return { id: c.id, ok: true, fields, usage, skipped_truth_fields: [...skipped] };
}

/** 跑一個 case；失敗重試 1 次；仍失敗＝ok:false（淨記錯誤類別）。 */
export async function evalCaseWithRetry(c: EvalCase, deps: EvalDeps): Promise<CaseOutcome> {
  let last = 'error';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await evalCase(c, deps);
    } catch (e) {
      const x = e as { name?: string; status?: number | null; reason?: string | null; message?: string };
      last = x.reason ? `${x.name ?? 'Error'}:${x.reason}` : x.status ? `${x.name ?? 'Error'}:${x.status}` : /^image_tool|^path_not|^not_png/.test(x.message ?? '') ? (x.message as string) : (x.name ?? 'Error');
    }
  }
  return { id: c.id, ok: false, error: last, fields: [], usage: emptyUsage(), skipped_truth_fields: [] };
}

/** 固定並行度嘅 worker pool（保持結果次序）。 */
export async function runPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, worker));
  return out;
}

// ---------- --dry：fake clients ----------
function respond(spec: Record<string, unknown>): string {
  return JSON.stringify(spec);
}

/** dry：按 case.truth 完美回應（仲裁亦預設讀啱），case.fake 可逐欄覆蓋讀 A／讀 B／仲裁（支援舊字串同新 object 格式）。 */
export function fakeClientsFor(c: EvalCase, doc: OcrDocType): ReadClients {
  const std: Record<string, unknown> = {};
  for (const f of OCR_DOC_FIELDS[doc]) std[f] = c.truth[f as TruthField] ?? null;
  const spec = c.fake?.[doc];
  const mk = (provider: 'claude' | 'deepseek', model: string, over: Record<string, unknown> | undefined): VisionClient => ({
    model,
    provider,
    async complete(req: VisionRequest): Promise<VisionResponse> {
      const base: Record<string, unknown> = {};
      for (const f of req.fields ?? Object.keys(std)) base[f] = f in std ? std[f] : null;
      const merged = { ...base, ...(over ?? {}) };
      const out: Record<string, unknown> = {};
      for (const f of req.fields ?? Object.keys(merged)) out[f] = merged[f] ?? null;
      return { text: respond(out), promptTokens: 100, completionTokens: 20, truncated: false };
    },
  });
  return { a: mk('claude', 'fake-a', spec?.a), b: mk('deepseek', 'fake-b', spec?.b), arbiter: mk('claude', 'fake-arbiter', spec?.arbiter) };
}

export interface RunEvalOptions {
  manifest: Manifest;
  deps: EvalDeps;
  mode: 'dry' | 'live';
  limit: number | null;
  concurrency: number;
  onProgress?: (done: number, total: number, ok: boolean) => void;
}

export async function runEval(o: RunEvalOptions): Promise<EvalReport> {
  const cases = o.limit ? o.manifest.cases.slice(0, o.limit) : o.manifest.cases;
  let done = 0;
  const outcomes = await runPool(cases, o.concurrency, async (c) => {
    const r = await evalCaseWithRetry(c, o.deps);
    done += 1;
    o.onProgress?.(done, cases.length, r.ok);
    return r;
  });
  return buildReport(outcomes, { mode: o.mode, limit: o.limit, onlyDocType: o.deps.onlyDocType, concurrency: o.concurrency });
}

/** `--out` 必須喺 `<cwd>/data/` 之下（報表含 case id／逐欄結果，唔入 git）。 */
export function resolveReportPath(out: string, cwd: string): string {
  const abs = path.resolve(cwd, out);
  const dataDir = path.resolve(cwd, 'data') + path.sep;
  if (!abs.startsWith(dataDir)) throw new ArgError('out_not_under_data: --out 必須喺 data/ 之下');
  return abs;
}
