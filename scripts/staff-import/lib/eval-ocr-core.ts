// WP-OCR-5：OCR 準確度評估核心（純邏輯＋可注入 client／圖片準備，方便 vitest 用合成 fixture 測）。
// 鐵則：報表／console 淨係計數同百分比——唔印欄位值、唔印姓名、唔印圖片路徑；per-case 淨記 case id＋逐欄結果類別。
import path from 'node:path';
import { z } from 'zod';
import { OCR_CROP_FIELDS } from '@/lib/guards/ocr/field-crops';
import { confirmedRefsFromDocs, countCross, crossForOnboarding, type Refs } from '@/lib/guards/ocr/refs';
import { OCR_CROSS_FIELDS, OCR_DOC_FIELDS, OCR_DOC_TYPES, type OcrDocType, type OcrFieldKey } from '@/lib/guards/ocr/config';
import { normalizeField, type FieldResult, type FieldStatus } from '@/lib/guards/ocr/normalize';
import { normalizeHkAddress } from '@/lib/guards/ocr/hk-address';
import type { AlsLookup } from '@/lib/guards/ocr/als-client';
import { readDocument, readStageA, readStageB, type DocumentReadResult, type StageAResult } from '@/lib/guards/ocr/read';
import type { FieldBoxes } from '@/lib/guards/ocr/field-crops';
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
const fakeBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();
/** boxes：讀 A（stage a）回報嘅 field_boxes（欄位 → box 或 null）；冇寫＝用內置合理 box；寫 {} 或 null 欄＝該欄冇 box（測後備） */
const fakeSpec = z.object({ a: fakeRead.optional(), b: fakeRead.optional(), arbiter: fakeRead.optional(), boxes: z.record(z.string(), z.union([fakeBox, z.null()])).optional() }).strict();

export const manifestSchema = z
  .object({
    cases: z.array(
      z
        .object({
          id: z.string().min(1).max(80),
          docs: z.array(z.object({ type: z.enum(OCR_DOC_TYPES), image: z.string().min(1), page: z.number().int().min(1).optional() }).strict()).min(1).max(3),
          truth: z.object(Object.fromEntries(TRUTH_FIELDS.map((k) => [k, z.string().optional()])) as Record<TruthField, z.ZodOptional<z.ZodString>>).strict(),
          /** OCR-6.1：獨立來源電話（打字名單／已存電話）——入職表電話 confirmed 要三讀一致且同佢相同；冇寫＝冇獨立來源（電話只會 review） */
          list: z.object({ phone: z.string().optional() }).strict().optional(),
          /** OCR-6.1：truth 值嘅來源（診斷用）：phone＝'list' 表示真值嚟自名單而唔係表上手寫 */
          truth_source: z.object({ phone: z.enum(['list', 'form']).optional() }).strict().optional(),
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
export type EvalFlow = 'legacy' | 'two-stage';
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
  /** WP-OCR-2：review 欄嘅 truth 只喺 ALS 候選（冇任何讀數支持）先出現 */
  truthFromAls?: boolean;
  /** OCR-6.1：電話 confirmed_wrong 逐類（診斷；唔帶值） */
  phoneWrongKind?: PhoneWrongKind;
}

export type PhoneWrongKind = 'unanimous_wrong' | 'arbiter_anchored' | 'truth_from_list_differs' | 'other';
const PHONE_WRONG_KINDS: readonly PhoneWrongKind[] = ['unanimous_wrong', 'arbiter_anchored', 'truth_from_list_differs', 'other'];

/**
 * OCR-6.1：電話 confirmed_wrong 分類（純函數，只比較正規化值，唔輸出值）：
 *   truth_from_list_differs＝真值嚟自名單（truth_source.phone='list'）而 OCR 手寫值唔同；
 *   unanimous_wrong＝a、b、仲裁（有就計）三讀一致但係錯；
 *   arbiter_anchored＝仲裁同其中一讀一致、另一讀唔同（a==arbiter!=b 或 b==arbiter!=a）；其餘 other。
 */
export function classifyPhoneWrong(reads: { a: string | null; b: string | null; arbiter: string | null } | undefined, truthCanon: string, ocrCanon: string, truthSource: 'list' | 'form' | undefined): PhoneWrongKind {
  if (truthSource === 'list' && ocrCanon !== truthCanon) return 'truth_from_list_differs';
  if (!reads) return 'other';
  const { a, b, arbiter } = reads;
  if (a !== null && a === b && (arbiter === null || arbiter === a)) return 'unanimous_wrong';
  if (arbiter !== null && ((a === arbiter && a !== b) || (b === arbiter && b !== a))) return 'arbiter_anchored';
  return 'other';
}

/**
 * exact＝confirmed 且值等於 truth；review_contains_truth＝review 且 truth 喺候選（含預填值）入面；
 * wrong＝confirmed 但值錯（最危險），或 review 但候選都唔含 truth；missing＝讀唔到。比較用現有 normalize canon。
 */
export function classifyField(field: OcrFieldKey, truth: string, r: FieldResult, doc: OcrDocType, now: Date = new Date()): FieldEval {
  // OCR-5.3：地址比較忽略標點／空白／大小寫（只比字母數字），避免打字真值同讀數因逗號／空格計錯
  const loose = (s: string) => (field === 'address' ? s.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase() : s);
  const t = loose(normalizeField(field, truth, now).canon);
  const canon = (v: string) => loose(normalizeField(field, v, now).canon);
  const valueCorrect = r.status !== 'missing' && r.value !== '' && canon(r.value) === t;
  const cands = r.status === 'review' ? (r.candidates_ranked?.length ? r.candidates_ranked.map((c) => c.value) : r.candidates) : [];
  // WP-OCR-2：地址 exact（confirmed 且啱）用 strict 比較（形近／簡繁字唔同當錯）；review_contains_truth 仍用 canon
  const strictOf = (v: string) => (field === 'address' ? loose(normalizeField(field, v, now).strict ?? canon(v)) : canon(v));
  const exactCorrect = r.status !== 'missing' && r.value !== '' && strictOf(r.value) === strictOf(truth);
  let outcome: Outcome;
  if (r.status === 'missing') outcome = 'missing';
  else if (r.status === 'confirmed') outcome = exactCorrect ? 'exact' : 'wrong';
  else outcome = valueCorrect || cands.some((c) => canon(c) === t) ? 'review_contains_truth' : 'wrong';
  const truthFromAls = r.status === 'review' && field === 'address' && (r.candidates_ranked ?? []).some((c) => canon(c.value) === t && c.sources.length > 0 && c.sources.every((x) => x === 'als'));
  return { doc, field, outcome, status: r.status, valueCorrect, candidateCount: r.status === 'review' ? cands.length : 0, ...(truthFromAls ? { truthFromAls: true } : {}) };
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

function addStageAUsage(u: UsageSum, a: StageAResult): void {
  u.calls += a.usage.calls;
  u.prompt_tokens += a.usage.promptTokens;
  u.completion_tokens += a.usage.completionTokens;
  const p = u.by_provider[a.provider];
  p.calls += a.usage.calls;
  p.prompt_tokens += a.usage.promptTokens;
  p.completion_tokens += a.usage.completionTokens;
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
  /** WP-OCR-3：兩段式下，用欄位級裁圖嘅文件數／本應欄位級但退回 2×2 格嘅文件數（legacy 流程＝0／0） */
  field_crops_docs?: number;
  fallback_tiles_docs?: number;
  /** WP-OCR-1：注入咗 refs 嘅入職表文件數；入職表 name_zh／hkid／dob 對身份證嘅交叉核對計數（淨計數） */
  refs_injected_docs?: number;
  cross?: CrossCounts;
  /** WP-OCR-2：ALS 淨計數（查過／出咗候選／查失敗）；truth 只來自 ALS 候選嘅欄數 */
  als_called_docs?: number;
  als_candidate_docs?: number;
  als_failed?: number;
  als_truth_from_candidate?: number;
}

export interface CrossCounts {
  match: number;
  differs: number;
  unreadable: number;
}

export interface EvalReport {
  generated_at: string;
  mode: 'dry' | 'live';
  options: { limit: number | null; only_doc_type: OcrDocType | null; concurrency: number };
  cases: { total: number; ok: number; failed: number };
  overall: TallyView;
  /** WP-OCR-1：入職表交叉核對欄（name_zh／hkid／dob）嘅獨立統計，不計入 overall／by_field */
  cross_fields: TallyView;
  by_field: Record<string, TallyView & { breakdown?: Record<PhoneWrongKind, number> }>;
  by_doc_field: Record<string, TallyView>;
  usage: UsageSum;
  /** WP-OCR-3：流程＋欄位級裁圖計數（淨計數） */
  flow: EvalFlow;
  field_crops_docs: number;
  fallback_tiles_docs: number;
  /** WP-OCR-1：refs 注入文件數／是否用 --no-refs／交叉核對計數（淨計數） */
  refs_injected_docs: number;
  refs_enabled: boolean;
  cross: CrossCounts;
  /** WP-OCR-2：ALS（政府地址庫）計數（淨計數）：開關／查過嘅文件／出咗候選嘅文件／查失敗／review_contains_truth 入面「真值來自 ALS 候選」 */
  als_enabled: boolean;
  als_called_docs: number;
  als_candidate_docs: number;
  als_failed: number;
  als_truth_from_candidate: number;
  /** 逐 case：淨 id＋逐欄結果類別（doc.field → outcome），冇值 */
  per_case: { id: string; ok: boolean; error?: string; outcomes: Record<string, Outcome> }[];
  notes: string[];
}

export function buildReport(outcomes: readonly CaseOutcome[], meta: { mode: 'dry' | 'live'; limit: number | null; onlyDocType: OcrDocType | null; concurrency: number; flow?: EvalFlow; refs?: boolean; als?: boolean; now?: Date }): EvalReport {
  const overall = emptyTally();
  const crossFields = emptyTally();
  // WP-OCR-1：入職表 name_zh／hkid／dob 係交叉核對欄，唔計入 overall／by_field（令樣本數同 OCR-5 基線可比），另出 cross_fields
  const isCrossField = (e: FieldEval) => e.doc === 'onboarding_form' && (OCR_CROSS_FIELDS as readonly string[]).includes(e.field);
  const byField = new Map<string, Tally>();
  const phoneBreakdown: Record<PhoneWrongKind, number> = { unanimous_wrong: 0, arbiter_anchored: 0, truth_from_list_differs: 0, other: 0 };
  const byDocField = new Map<string, Tally>();
  const usage = emptyUsage();
  const skipped = new Set<string>();
  for (const c of outcomes) {
    if (c.ok) {
      for (const e of c.fields) {
        const k = `${e.doc}.${e.field}`;
        addTo(byDocField.get(k) ?? byDocField.set(k, emptyTally()).get(k)!, e);
        if (isCrossField(e)) {
          addTo(crossFields, e);
          continue;
        }
        addTo(overall, e);
        if (e.field === 'phone' && e.phoneWrongKind) phoneBreakdown[e.phoneWrongKind] += 1;
        addTo(byField.get(e.field) ?? byField.set(e.field, emptyTally()).get(e.field)!, e);
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
    cross_fields: view(crossFields),
    by_field: (() => {
      const v = viewAll(byField) as EvalReport['by_field'];
      // OCR-6.1：by_field.phone.breakdown——confirmed_wrong 逐類計數（淨計數）
      if (v.phone) v.phone = { ...v.phone, breakdown: phoneBreakdown };
      return v;
    })(),
    by_doc_field: viewAll(byDocField),
    usage,
    flow: meta.flow ?? 'two-stage',
    field_crops_docs: outcomes.reduce((n, c) => n + (c.field_crops_docs ?? 0), 0),
    fallback_tiles_docs: outcomes.reduce((n, c) => n + (c.fallback_tiles_docs ?? 0), 0),
    refs_injected_docs: outcomes.reduce((n, c) => n + (c.refs_injected_docs ?? 0), 0),
    refs_enabled: meta.refs !== false && (meta.flow ?? 'two-stage') === 'two-stage',
    cross: outcomes.reduce<CrossCounts>((a, c) => ({ match: a.match + (c.cross?.match ?? 0), differs: a.differs + (c.cross?.differs ?? 0), unreadable: a.unreadable + (c.cross?.unreadable ?? 0) }), { match: 0, differs: 0, unreadable: 0 }),
    als_enabled: meta.als !== false,
    als_called_docs: outcomes.reduce((n, c) => n + (c.als_called_docs ?? 0), 0),
    als_candidate_docs: outcomes.reduce((n, c) => n + (c.als_candidate_docs ?? 0), 0),
    als_failed: outcomes.reduce((n, c) => n + (c.als_failed ?? 0), 0),
    als_truth_from_candidate: outcomes.reduce((n, c) => n + (c.als_truth_from_candidate ?? 0), 0),
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
    `流程 ${r.flow}｜欄位級裁圖文件 ${r.field_crops_docs}｜後備 2×2 格文件 ${r.fallback_tiles_docs}`,
    `交叉核對欄（入職表 name_zh/hkid/dob，不計入總體）：n=${r.cross_fields.n} exact ${r.cross_fields.exact}｜wrong ${r.cross_fields.wrong}｜missing ${r.cross_fields.missing}`,
    `跨文件 refs：${r.refs_enabled ? '開' : '關'}｜注入 refs 入職表文件 ${r.refs_injected_docs}｜cross match ${r.cross.match} / differs ${r.cross.differs} / unreadable ${r.cross.unreadable}`,
    `ALS 政府地址庫：${r.als_enabled ? '開' : '關'}｜查過文件 ${r.als_called_docs}｜出候選文件 ${r.als_candidate_docs}｜失敗 ${r.als_failed}｜review_contains_truth 入面真值來自 ALS 候選 ${r.als_truth_from_candidate}`,
    `呼叫 ${r.usage.calls}（仲裁 ${r.usage.arbiter_calls} 份文件）｜tokens in ${r.usage.prompt_tokens} / out ${r.usage.completion_tokens}｜claude ${r.usage.by_provider.claude.calls} 次、deepseek ${r.usage.by_provider.deepseek.calls} 次`,
  ];
  for (const [k, v] of Object.entries(r.by_field)) {
    lines.push(`  ${k}: n=${v.n} exact ${v.pct.exact}% review_has_truth ${v.pct.review_contains_truth}% wrong ${v.pct.wrong}% missing ${v.pct.missing}%`);
    if (k === 'phone' && v.breakdown) lines.push(`    phone confirmed_wrong ${v.confirmed_wrong}：${PHONE_WRONG_KINDS.map((x) => `${x} ${v.breakdown![x]}`).join('｜')}`);
  }
  for (const n of r.notes) lines.push(`註：${n}`);
  return lines;
}

// ---------- 單 case ----------
export interface FieldCropImages {
  images: string[];
  fieldOf: OcrFieldKey[];
}
export interface PreparedImages {
  full: string;
  tiles: readonly string[];
  /** WP-OCR-3：按讀 A 回報嘅 boxes 由來源圖裁欄位級圖（幾何來自 field-crops.ts）；冇有效 box／冇裁圖設計＝null */
  cropFields?: (type: OcrDocType, boxes: FieldBoxes) => Promise<FieldCropImages | null>;
}
export interface EvalDeps {
  /** 每份文件砌 client（live＝同一組真 client；dry＝按 case.fake 砌） */
  clientsFor(c: EvalCase, doc: OcrDocType): ReadClients;
  prepare(imagePath: string, page: number | undefined): Promise<PreparedImages>;
  baseDir: string;
  onlyDocType: OcrDocType | null;
  /** WP-OCR-3：legacy＝舊單次流程；two-stage（預設）＝讀 A 定位 → 欄位級裁圖 → 讀 B */
  flow?: EvalFlow;
  /** WP-OCR-1：false（--no-refs）＝入職表讀 A 唔注入 refs（亦就冇 cross），方便前後對比；預設 true（只對 two-stage 生效） */
  refs?: boolean;
  /** WP-OCR-2：false（--no-als）＝唔查 ALS（亦唔會有 als 候選） */
  als?: boolean;
  /** OCR-6.1：電話仲裁盲讀（預設 true＝同 app 一樣）；false（--no-phone-blind）＝舊行為（仲裁見到兩讀候選值），俾前後對照 */
  phoneBlind?: boolean;
  now?: Date;
}

export async function evalCase(c: EvalCase, deps: EvalDeps): Promise<CaseOutcome> {
  const usage = emptyUsage();
  const fields: FieldEval[] = [];
  const skipped = new Set<string>();
  const now = deps.now ?? new Date();
  const docs = c.docs.filter((d) => !deps.onlyDocType || d.type === deps.onlyDocType);
  for (const [k, v] of Object.entries(c.truth)) if (v && !EVALUABLE.has(k)) skipped.add(k);
  let fieldCropsDocs = 0;
  let fallbackTilesDocs = 0;
  let refsInjectedDocs = 0;
  const cross: CrossCounts = { match: 0, differs: 0, unreadable: 0 };
  const alsN = { called: 0, candidate: 0, failed: 0, truth: 0 };
  const twoStage = (deps.flow ?? 'two-stage') === 'two-stage';
  // WP-OCR-1：two-stage 次序同 client 一樣——先印刷文件（身份證／住址證明），再入職表（讀 A 注入印刷證件 confirmed 欄位值）
  const ordered = twoStage ? [...docs.filter((d) => !OCR_CROP_FIELDS[d.type]), ...docs.filter((d) => OCR_CROP_FIELDS[d.type])] : docs;
  const printedResults: DocumentReadResult[] = [];
  for (const d of ordered) {
    const abs = path.isAbsolute(d.image) ? d.image : path.resolve(deps.baseDir, d.image);
    const images = await deps.prepare(abs, d.page);
    const clients0 = deps.clientsFor(c, d.type);
    // WP-OCR-2：--no-als＝剔走 clients.als（live／dry 一樣；唔需要、亦唔會設 GUARD_OCR_ALS）
    const clients: ReadClients = deps.als === false ? { ...clients0, als: undefined } : clients0;
    let r: DocumentReadResult;
    const readOpts = { independentPhones: c.list?.phone ? [c.list.phone] : [], phoneBlind: deps.phoneBlind !== false, collectReads: true };
    if (!twoStage) {
      r = await readDocument(clients, d.type, images, now, readOpts);
    } else {
      const isForm = !!OCR_CROP_FIELDS[d.type];
      const refs: Refs | null = isForm && deps.refs !== false ? confirmedRefsFromDocs(printedResults) : null;
      const a = await readStageA(clients, d.type, images.full, refs);
      const crops = images.cropFields ? await images.cropFields(d.type, a.field_boxes) : null;
      r = await readStageB(clients, d.type, a, crops ? { kind: 'field_crops', images: crops.images, fieldOf: crops.fieldOf, full: images.full } : { kind: 'tiles', images: images.tiles, full: images.full }, now, readOpts);
      addStageAUsage(usage, a);
      if (r.images_b_kind === 'field_crops') fieldCropsDocs += 1;
      else if (OCR_CROP_FIELDS[d.type]) fallbackTilesDocs += 1;
      if (a.refs_injected > 0) refsInjectedDocs += 1;
      if (isForm && refs && Object.keys(refs).length > 0) {
        const x = crossForOnboarding(refs, r.fields, now);
        for (const [k, v] of Object.entries(x.form)) r.fields[k as OcrFieldKey]!.cross = v;
        const n = countCross(x);
        cross.match += n.match;
        cross.differs += n.differs;
        cross.unreadable += n.unreadable;
      }
      if (!isForm) printedResults.push(r);
    }
    addUsage(usage, r);
    if (r.als.called) alsN.called += 1;
    if (r.als.candidate) alsN.candidate += 1;
    if (r.als.failed) alsN.failed += 1;
    for (const f of OCR_DOC_FIELDS[d.type]) {
      const truth = c.truth[f as TruthField];
      const res = r.fields[f];
      if (!truth || !res) continue;
      const fe = classifyField(f, truth, res, d.type, now);
      if (f === 'phone' && fe.outcome === 'wrong' && fe.status === 'confirmed') {
        fe.phoneWrongKind = classifyPhoneWrong(r.phone_reads, normalizeField('phone', truth, now).canon, normalizeField('phone', res.value, now).canon, c.truth_source?.phone);
      }
      if (fe.truthFromAls) alsN.truth += 1;
      fields.push(fe);
    }
  }
  for (const k of EVALUABLE) {
    const t = c.truth[k as TruthField];
    if (t && !docs.some((d) => OCR_DOC_FIELDS[d.type].includes(k as OcrFieldKey))) skipped.add(k);
  }
  return { id: c.id, ok: true, fields, usage, skipped_truth_fields: [...skipped], field_crops_docs: fieldCropsDocs, fallback_tiles_docs: fallbackTilesDocs, refs_injected_docs: refsInjectedDocs, cross, als_called_docs: alsN.called, als_candidate_docs: alsN.candidate, als_failed: alsN.failed, als_truth_from_candidate: alsN.truth };
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
  return { id: c.id, ok: false, error: last, fields: [], usage: emptyUsage(), skipped_truth_fields: [], field_crops_docs: 0, fallback_tiles_docs: 0, refs_injected_docs: 0, cross: { match: 0, differs: 0, unreadable: 0 } };
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

/** dry 內置 box（0–1，合理大小、互不重疊）：電話、地址各一個欄位格 */
const DEFAULT_FAKE_BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
  phone: { x: 0.08, y: 0.3, w: 0.5, h: 0.05 },
  address: { x: 0.08, y: 0.4, w: 0.8, h: 0.08 },
  // WP-OCR-1：姓名／HKID／出生日期（互不重疊）
  name_zh: { x: 0.08, y: 0.1, w: 0.4, h: 0.04 },
  hkid: { x: 0.08, y: 0.16, w: 0.4, h: 0.04 },
  dob: { x: 0.08, y: 0.22, w: 0.4, h: 0.04 },
};

/**
 * WP-OCR-2 --dry 用 fake ALS：照收到嘅 q（已冇樓層室號）回一個「標準化」結果（Score 90）——
 * 成分由 normalizeHkAddress(q).parts 抽，再由 compose 拼返（本地 floor／unit 由 lookupAlsCandidate 補）。冇打網絡。
 */
export const fakeAls: AlsLookup = async (q) => {
  const p = normalizeHkAddress(q).parts;
  return [{ score: 90, ...(p.district ? { district: p.district } : {}), ...(p.street ? { street: p.street } : {}), ...(p.number ? { number: p.number } : {}), ...(p.estate ? { estate: p.estate } : {}), ...(p.block ? { block: p.block } : {}), ...(p.building ? { building: p.building } : {}) }];
};

/** dry：按 case.truth 完美回應（仲裁亦預設讀啱），case.fake 可逐欄覆蓋讀 A／讀 B／仲裁（支援舊字串同新 object 格式）。 */
export function fakeClientsFor(c: EvalCase, doc: OcrDocType): ReadClients {
  const std: Record<string, unknown> = {};
  for (const f of OCR_DOC_FIELDS[doc]) std[f] = c.truth[f as TruthField] ?? null;
  const spec = c.fake?.[doc];
  const mk = (provider: 'claude' | 'deepseek', model: string, over: Record<string, unknown> | undefined, boxes?: Record<string, unknown>): VisionClient => ({
    model,
    provider,
    async complete(req: VisionRequest): Promise<VisionResponse> {
      const base: Record<string, unknown> = {};
      for (const f of req.fields ?? Object.keys(std)) base[f] = f in std ? std[f] : null;
      const merged = { ...base, ...(over ?? {}) };
      const out: Record<string, unknown> = {};
      for (const f of req.fields ?? Object.keys(merged)) out[f] = merged[f] ?? null;
      // WP-OCR-3：讀 A 要求 field_boxes 時回報（boxes 來自 case.fake；冇寫就用內置合理 box；null 欄＝冇 box）
      if (req.boxFields) out.field_boxes = Object.fromEntries(req.boxFields.map((f) => [f, boxes ? (boxes[f] ?? null) : (DEFAULT_FAKE_BOXES[f] ?? null)]));
      return { text: respond(out), promptTokens: 100, completionTokens: 20, truncated: false };
    },
  });
  return { a: mk('claude', 'fake-a', spec?.a, spec?.boxes ?? undefined), b: mk('deepseek', 'fake-b', spec?.b), arbiter: mk('claude', 'fake-arbiter', spec?.arbiter), als: fakeAls };
}

export interface RunEvalOptions {
  manifest: Manifest;
  deps: EvalDeps;
  mode: 'dry' | 'live';
  limit: number | null;
  concurrency: number;
  flow?: EvalFlow;
  refs?: boolean;
  als?: boolean;
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
  return buildReport(outcomes, { mode: o.mode, limit: o.limit, onlyDocType: o.deps.onlyDocType, concurrency: o.concurrency, flow: o.deps.flow ?? o.flow ?? 'two-stage', refs: o.deps.refs ?? o.refs, als: o.deps.als ?? o.als });
}

/** `--out` 必須喺 `<cwd>/data/` 之下（報表含 case id／逐欄結果，唔入 git）。 */
export function resolveReportPath(out: string, cwd: string): string {
  const abs = path.resolve(cwd, out);
  const dataDir = path.resolve(cwd, 'data') + path.sep;
  if (!abs.startsWith(dataDir)) throw new ArgError('out_not_under_data: --out 必須喺 data/ 之下');
  return abs;
}
