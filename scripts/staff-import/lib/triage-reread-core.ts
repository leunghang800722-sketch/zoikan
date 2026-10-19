// TR-1：舊分流題 OCR 重讀——核心邏輯（純函數＋可注入 client／圖片準備，方便 vitest 用合成 fixture 測）。
// 流程同應用內 client 一樣：印刷文件（身份證 → 住址證明）stage A → refs → 入職表 stage A（注入 refs）→ 欄位級裁圖 → stage B；
// 然後 mergeDocFields 得最終欄（來源規則：身份證／住址證明為準）→ 保守建議規則。
// 鐵則：欄位值只喺記憶體同 --out 檔（data/ 下）；console／summary 淨計數，唔印值、姓名、路徑、docId。
import { createHash } from 'node:crypto';
import { OCR_CROP_FIELDS } from '@/lib/guards/ocr/field-crops';
import { confirmedRefsFromDocs, crossForOnboarding, type Refs } from '@/lib/guards/ocr/refs';
import { mergeDocFields } from '@/lib/guards/ocr/merge-docs';
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from '@/lib/guards/ocr/config';
import { normalizeField, type FieldResult } from '@/lib/guards/ocr/normalize';
import { readStageA, readStageB, type DocumentReadResult } from '@/lib/guards/ocr/read';
import type { ReadClients } from '@/lib/guards/ocr/clients';
import type { PreparedImages } from './eval-ocr-core';

export type ProposalFieldName = 'nameZh' | 'nameEn' | 'hkid' | 'dateOfBirth' | 'phone' | 'address';
export type Basis = 'two_reads' | 'arbiter';
export interface RereadProposal {
  person_key: string;
  field: ProposalFieldName;
  value: string;
  basis: Basis;
  doc: OcrDocType;
  confidence: 'high' | 'medium' | 'low';
  /** TE-4：嵌入身份證副本／印刷佐證旗標 */
  flags?: ('printed_card_conflict' | 'embedded_card' | 'printed_corroborated' | 'printed_only' | 'card_name_conflict' | 'form_differs' | 'form_conflict' | 'card_unverified')[];
  /** 配對提示：伺服器題目 personKey 係 HMAC（身份證 → 工號集合 → 包內 key），server 用呢兩項推返同一個 key（只用嚟砌 key，唔寫入） */
  match: { hkid: string | null; staff_numbers: string[] };
}

/** 仲裁同意讀 A（agree_a）：仲裁只收讀 A 嘅候選，唔係獨立證據。保守＝唔收（要改寬鬆只改呢個常數）。 */
export const ACCEPT_ARBITER_AGREE_A = false;

type LF = { value: string | null; status: 'confirmed' | 'review' | 'missing' };
export interface PkgPerson {
  key: string;
  hkid: LF;
  nameZh: LF;
  nameEn: LF;
  dateOfBirth: LF;
  phone: LF;
  address: LF;
  staffNumbers: { scheme?: string; number: string }[];
  reasons?: string[];
  /** TE-7：導入評級（fail＝抽取失敗人） */
  rating?: string;
}

const FIELD_MAP: { field: ProposalFieldName; ocr: OcrFieldKey; pkg: keyof Pick<PkgPerson, 'hkid' | 'nameZh' | 'nameEn' | 'dateOfBirth' | 'phone' | 'address'>; doc: OcrDocType }[] = [
  { field: 'nameZh', ocr: 'name_zh', pkg: 'nameZh', doc: 'id_card' },
  { field: 'nameEn', ocr: 'name_en', pkg: 'nameEn', doc: 'id_card' },
  { field: 'hkid', ocr: 'hkid', pkg: 'hkid', doc: 'id_card' },
  { field: 'dateOfBirth', ocr: 'dob', pkg: 'dateOfBirth', doc: 'id_card' },
  { field: 'phone', ocr: 'phone', pkg: 'phone', doc: 'onboarding_form' },
  { field: 'address', ocr: 'address', pkg: 'address', doc: 'address_proof' },
];

/** 舊 crosscheck 對打字名單（Maxwell／Uteam／DB）嘅唔一致理由碼（06-build-package 寫入 package.reasons）。 */
const TYPED_LIST_REASONS: Record<ProposalFieldName, readonly string[]> = {
  nameZh: ['mismatch_nameZh', 'nameZh_near_match'],
  nameEn: ['mismatch_nameEn'],
  hkid: ['mismatch_hkid'],
  dateOfBirth: ['mismatch_dob'],
  phone: ['phone_differs_from_list'],
  address: ['mismatch_address'],
};

export type SkipReason = 'not_review' | 'no_read' | 'wrong_source' | 'not_confirmed' | 'arbiter_agree_a' | 'invalid_format' | 'typed_list_disagrees';

/** 需要覆核嘅欄＝package 該欄 status=review（nameZh／hkid 亦然）。 */
export function needsReread(p: PkgPerson): boolean {
  return FIELD_MAP.some((m) => p[m.pkg].status === 'review');
}

export interface ProposeOutcome {
  proposals: RereadProposal[];
  /** 唔建議嘅原因計數（只計 package 為 review 嘅欄） */
  skipped: Partial<Record<SkipReason, number>>;
  /** TR-2：每欄每原因計數（只計 package 為 review 嘅欄） */
  skippedByField: Partial<Record<ProposalFieldName, Partial<Record<SkipReason, number>>>>;
}

/**
 * TE-11.1（老闆：證件為準，入職表差異只係中等警告、唔阻擋）：身份證頁（id_card／嵌入卡）欄位兩讀一致（basis two_reads；
 * 格式 valid 已經喺 normalizeField 驗過：hkid checksum、dob 曆法）→ high，唔需要入職表交叉一致或印刷佐證；入職表唔一致只帶 flag form_differs（資訊）。
 * 仲有仲裁（arbiter）介入嘅身份證欄、以及非身份證來源（電話／地址）照舊：交叉核對一致先 high，否則 medium。
 */
function confidenceOf(pick: Pick_, basis: Basis): 'high' | 'medium' {
  if (pick.doc === 'id_card' && basis === 'two_reads') return 'high';
  return pick.cross === 'match' ? 'high' : 'medium';
}

type Pick_ = { doc: OcrDocType; result: Pick<FieldResult, 'status' | 'value' | 'arbiter'>; cross?: 'match' | 'differs' | 'unreadable' };

/**
 * 保守建議規則（純函數）。picks＝mergeDocFields 嘅最終欄。
 *  - 只對 package 狀態為 review 嘅欄出建議；
 *  - 來源：姓名／身份證號／出生日期＝身份證；地址＝住址證明（唔收入職表手寫地址）；電話＝入職表；
 *  - 最終欄 status 必須 confirmed（兩讀一致，或仲裁同意；arbiter=agree_a 唔收）且格式 valid（HKID check digit、電話 8 位、日期曆法…）；
 *  - TR-2（老闆 2026-10-17）：身份證號／出生日期／中英文姓名以身份證副本為準、住址以住址證明為準——入職表手寫同印刷文件唔一致唔阻擋（只係 confidence 標 medium）；
 *  - package.reasons 顯示舊 crosscheck 對打字名單有唔一致 → 唔建議（留人手；打字名單係辦公室資料，唔一致係真警號）。
 */
export function proposeFromPicks(p: PkgPerson, picks: Partial<Record<OcrFieldKey, Pick_>>, now: Date = new Date(), opts: { embedded?: boolean } = {}): ProposeOutcome {
  const out: ProposeOutcome = { proposals: [], skipped: {}, skippedByField: {} };
  for (const m of FIELD_MAP) {
    // TE-4：嵌入身份證副本係證件為準——身份證欄（hkid／姓名／出生日期）missing 都出建議；其餘欄照舊只對 review
    const cardField = opts.embedded && m.doc === 'id_card';
    if (p[m.pkg].status !== 'review' && !(cardField && p[m.pkg].status === 'missing')) continue;
    const skip = (r: SkipReason) => {
      out.skipped[r] = (out.skipped[r] ?? 0) + 1;
      const f = (out.skippedByField[m.field] ??= {});
      f[r] = (f[r] ?? 0) + 1;
    };
    const pick = picks[m.ocr];
    if (!pick || pick.result.status === 'missing') {
      skip('no_read');
      continue;
    }
    if (pick.doc !== m.doc) {
      skip('wrong_source');
      continue;
    }
    const r = pick.result;
    if (r.status !== 'confirmed') {
      skip('not_confirmed');
      continue;
    }
    if (r.arbiter === 'agree_a' && !ACCEPT_ARBITER_AGREE_A) {
      skip('arbiter_agree_a');
      continue;
    }
    const n = normalizeField(m.ocr, r.value, now);
    if (!n.valid || !n.canon) {
      skip('invalid_format');
      continue;
    }
    if ((p.reasons ?? []).some((x) => TYPED_LIST_REASONS[m.field].includes(x))) {
      skip('typed_list_disagrees');
      continue;
    }
    // 值：hkid／dob／電話／姓名用 canon（同 server 校驗一致）；地址用最終讀數原文（canon 會歸一標點）
    const value = m.field === 'address' ? r.value.trim() : n.canon;
    out.proposals.push({ person_key: p.key, field: m.field, value, basis: r.arbiter ? 'arbiter' : 'two_reads', doc: pick.doc, confidence: confidenceOf(pick, r.arbiter ? 'arbiter' : 'two_reads'), ...(pick.doc === 'id_card' && pick.cross === 'differs' ? { flags: ['form_differs' as const] } : {}), match: { hkid: p.hkid.value?.trim() || null, staff_numbers: p.staffNumbers.map((n) => n.number) } });
  }
  return out;
}

// ---------- docs 揀頁 ----------
export interface ExtractPage {
  page: number;
  kinds: string[];
  primary?: string;
}
export interface ExtractRow {
  docId: string;
  /** 旋轉救援頁嘅度數（OCR 座標係旋轉後嘅頁） */
  rescuedRot?: number | null;
  /** TE-3：導入抽取嘅其他來源 HKID（下次導入先有） */
  aux?: { printedHkid?: { value: string } | null; permitHkid?: { value: string } | null; formNameEn?: { value: string } | null } | null;
  /** TE-11.2：導入抽取嘅身份證中文名（打字名單佐證時同卡讀數比） */
  nameZh?: { value: string } | null;
  pages: ExtractPage[];
  address?: { page: number } | null;
}
export interface DocPage {
  type: OcrDocType;
  docId: string;
  page: number;
  /** TE-4：呢個 id_card「頁」其實係頁面入面夾住嘅嵌入式身份證副本（轉正裁出嚟）；rot＝要順時針轉幾多度頁面先令卡正向 */
  embedded?: { rot: 0 | 90 | 180 | 270; box: { x0: number; y0: number; x1: number; y1: number }; stage: 'first' | 'second' };
}

const KIND_OF: Record<OcrDocType, string> = { id_card: 'id_card', address_proof: 'address_proof', onboarding_form: 'application_form' };

/** 每種文件揀 1 頁（身份證／住址證明／入職表）。住址證明優先用 extract.address.page（且該頁確係 address_proof），否則第一個 address_proof 頁。 */
export function pickDocPages(docIds: readonly string[], extractBy: ReadonlyMap<string, ExtractRow>): DocPage[] {
  const out: DocPage[] = [];
  for (const type of ['id_card', 'address_proof', 'onboarding_form'] as const) {
    let found: DocPage | null = null;
    for (const docId of docIds) {
      const e = extractBy.get(docId);
      if (!e) continue;
      const has = (pg: number) => e.pages.some((x) => x.page === pg && x.kinds.includes(KIND_OF[type]));
      let page: number | null = null;
      if (type === 'address_proof' && e.address && has(e.address.page)) page = e.address.page;
      else {
        const cands = e.pages.filter((x) => x.kinds.includes(KIND_OF[type]));
        page = (cands.find((x) => x.primary === KIND_OF[type]) ?? cands[0])?.page ?? null;
      }
      if (page !== null) {
        found = { type, docId, page };
        break;
      }
    }
    if (found) out.push(found);
  }
  return out;
}

const normNo = (s: string) => s.normalize('NFKC').toUpperCase().replace(/\s+/g, '');

export interface ExtRow {
  key?: string;
  docIds?: string[];
  staffNos?: string[];
}
/** 工號 → docIds（person-fields-ext 嘅 key／staffNos 都當工號索引） */
export function buildStaffNoIndex(rows: readonly ExtRow[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (no: string, ids: string[]) => {
    const k = normNo(no);
    if (!k) return;
    m.set(k, [...new Set([...(m.get(k) ?? []), ...ids])]);
  };
  for (const r of rows) {
    const ids = r.docIds ?? [];
    if (!ids.length) continue;
    if (r.key) add(r.key, ids);
    for (const s of r.staffNos ?? []) add(s, ids);
  }
  return m;
}

export function docIdsForPerson(p: PkgPerson, idx: ReadonlyMap<string, string[]>): string[] {
  return [...new Set(p.staffNumbers.flatMap((n) => idx.get(normNo(n.number)) ?? []))];
}

// ---------- 讀 ----------
/** TR-2：讀數快取（每 docId＋doc type＋page 一份 stage 結果；真跑落 data/ 下 JSON，測試用記憶體實作） */
export interface DocCache {
  /** refsHash＝入職表注入嘅 refs 指紋（印刷文件＝'none'）；docId／管線版本／refsHash 任一唔對＝miss */
  get(d: DocPage, refsHash: string): Promise<DocumentReadResult | null>;
  set(d: DocPage, r: DocumentReadResult, refsHash: string): Promise<void>;
}

/** TR-2.2：讀數管線版本（改 prompt／model／讀取流程時要手動遞增，令舊快取失效） */
export const OCR_PIPELINE_VERSION = 'ocr-2026-10-tr2.1';

/** refs 指紋：key 排序後 JSON 嘅 sha256 前 16 位；冇 refs＝'none' */
export function refsHashOf(refs: Refs | null): string {
  if (!refs || Object.keys(refs).length === 0) return 'none';
  const sorted = Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

export interface RereadDeps {
  /** TR-2：可選快取；命中就唔準備圖、唔打 API */
  cache?: DocCache;
  /** 每種文件砌 client（真跑＝同一組真 client；dry＝fake） */
  clientsFor(type: OcrDocType): ReadClients;
  /** 揀咗嘅一頁 → 圖片（真跑：prepareDocumentImages 經 docId/page 解析來源檔；dry：固定假圖） */
  prepare(d: DocPage): Promise<PreparedImages>;
  now?: Date;
}

/** 同 client 流程一樣次序讀一個人嘅 ≤3 份文件，回 mergeDocFields 嘅最終欄＋交叉核對。 */
export async function readPerson(docs: readonly DocPage[], deps: RereadDeps): Promise<{ picks: Partial<Record<OcrFieldKey, Pick_>>; calls: number; cacheHits: number; /** TE-11.2：入職表讀數（只供卡 vs 入職表分級，唔寫任何地方） */ formReads: Partial<Record<OcrFieldKey, string>> }> {
  const now = deps.now ?? new Date();
  const ordered = [...docs.filter((d) => !OCR_CROP_FIELDS[d.type]), ...docs.filter((d) => OCR_CROP_FIELDS[d.type])];
  const printed: DocumentReadResult[] = [];
  const byType = new Map<OcrDocType, DocumentReadResult>();
  let calls = 0;
  let cacheHits = 0;
  for (const d of ordered) {
    const isForm = !!OCR_CROP_FIELDS[d.type];
    const refs: Refs | null = isForm ? confirmedRefsFromDocs(printed) : null;
    let r: DocumentReadResult | null = deps.cache ? await deps.cache.get(d, refsHashOf(refs)) : null;
    if (r) cacheHits += 1;
    else {
      const images = await deps.prepare(d);
      const clients = deps.clientsFor(d.type);
      const a = await readStageA(clients, d.type, images.full, refs);
      const crops = images.cropFields ? await images.cropFields(d.type, a.field_boxes) : null;
      r = await readStageB(clients, d.type, a, crops ? { kind: 'field_crops', images: crops.images, fieldOf: crops.fieldOf, full: images.full } : { kind: 'tiles', images: images.tiles, full: images.full }, now);
      calls += a.usage.calls + r.usage.calls;
      // 先存（未加 cross）：cross 每次按 refs 重算
      if (deps.cache) await deps.cache.set(d, r, refsHashOf(refs));
    }
    if (isForm && refs && Object.keys(refs).length > 0) {
      const x = crossForOnboarding(refs, r.fields, now);
      for (const [k, v] of Object.entries(x.form)) r.fields[k as OcrFieldKey]!.cross = v;
    }
    if (!isForm) printed.push(r);
    byType.set(d.type, r);
  }
  const merged = mergeDocFields(byType, now);
  const picks: Partial<Record<OcrFieldKey, Pick_>> = {};
  for (const [k, v] of Object.entries(merged.picks) as [OcrFieldKey, NonNullable<(typeof merged.picks)[OcrFieldKey]>][]) {
    // 只收文件類型嘅抽取欄（OCR_DOC_FIELDS 之外嘅唔會出現）
    if (!OCR_DOC_FIELDS[v.doc].includes(k)) continue;
    picks[k] = { doc: v.doc, result: v.result, ...(v.cross ? { cross: v.cross } : {}) };
  }
  const formReads: Partial<Record<OcrFieldKey, string>> = {};
  const formRes = byType.get('onboarding_form');
  if (formRes) for (const [k, v] of Object.entries(formRes.fields) as [OcrFieldKey, { status: string; value: string }][]) if (v && v.status !== 'missing' && v.value) formReads[k] = v.value;
  return { picks, calls, cacheHits, formReads };
}

// ---------- 彙總（淨計數） ----------
export interface RereadSummary {
  generated_at: string;
  persons_in_package: number;
  persons_needing_reread: number;
  persons_no_docs: number;
  persons_processed: number;
  persons_failed: number;
  persons_with_proposals: number;
  proposals_total: number;
  proposals_by_field: Record<string, number>;
  proposals_by_basis: Record<string, number>;
  not_proposed_reasons: Record<string, number>;
  /** TR-2：每欄每原因計數 */
  skipped_by_field: Record<string, Record<string, number>>;
  ocr_calls: number;
  /** TR-2：讀數快取命中份數（文件） */
  cache_hits: number;
  /** TE-4：搵到嵌入身份證副本嘅人數（其中二階段局部 OCR 搵到）／二階段掃描頁數 */
  embedded_cards_found: number;
  embedded_second_stage_found: number;
  second_stage_pages: number;
  /** TE-4：印刷佐證一致／同卡唔一致（printed_card_conflict）／冇卡淨印刷（review） */
  card_printed_corroborated: number;
  card_printed_conflict: number;
  printed_only_review: number;
  /** TE-4：confidence=low（留人手）嘅建議條數 */
  proposals_low_confidence: number;
  /** TE-4.1：卡上姓名／cross／打字名單同包內唔一致 → 該人卡建議降 low */
  card_name_conflict: number;
  /** TE-11.2：入職表同卡分級計數（人數）：輕微差異（high＋form_differs）／完全唔相似（medium＋form_conflict，留人）／入職表冇名而冇名單佐證（medium＋card_unverified，留人） */
  form_differs: number;
  form_conflict: number;
  card_unverified: number;
}

export function emptySummary(now: Date = new Date()): RereadSummary {
  return { generated_at: now.toISOString(), persons_in_package: 0, persons_needing_reread: 0, persons_no_docs: 0, persons_processed: 0, persons_failed: 0, persons_with_proposals: 0, proposals_total: 0, proposals_by_field: {}, proposals_by_basis: {}, not_proposed_reasons: {}, skipped_by_field: {}, ocr_calls: 0, cache_hits: 0, embedded_cards_found: 0, embedded_second_stage_found: 0, second_stage_pages: 0, card_printed_corroborated: 0, card_printed_conflict: 0, printed_only_review: 0, proposals_low_confidence: 0, card_name_conflict: 0, form_differs: 0, form_conflict: 0, card_unverified: 0 };
}

export function addOutcome(s: RereadSummary, o: ProposeOutcome): void {
  if (o.proposals.length > 0) s.persons_with_proposals += 1;
  for (const p of o.proposals) {
    s.proposals_total += 1;
    s.proposals_by_field[p.field] = (s.proposals_by_field[p.field] ?? 0) + 1;
    s.proposals_by_basis[p.basis] = (s.proposals_by_basis[p.basis] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(o.skipped)) s.not_proposed_reasons[k] = (s.not_proposed_reasons[k] ?? 0) + (v ?? 0);
  for (const [f, rs] of Object.entries(o.skippedByField)) {
    const t = (s.skipped_by_field[f] ??= {});
    for (const [k, v] of Object.entries(rs ?? {})) t[k] = (t[k] ?? 0) + (v ?? 0);
  }
}

export function summaryLines(s: RereadSummary): string[] {
  return [
    `package 人數 ${s.persons_in_package}｜需重讀 ${s.persons_needing_reread}｜冇文件 ${s.persons_no_docs}｜已讀 ${s.persons_processed}｜失敗 ${s.persons_failed}`,
    `有建議嘅人 ${s.persons_with_proposals}｜建議共 ${s.proposals_total}｜OCR 呼叫 ${s.ocr_calls}`,
    `每欄建議：${JSON.stringify(s.proposals_by_field)}｜依據：${JSON.stringify(s.proposals_by_basis)}`,
    `唔建議原因：${JSON.stringify(s.not_proposed_reasons)}`,
    `每欄唔建議原因：${JSON.stringify(s.skipped_by_field)}｜讀數快取命中 ${s.cache_hits}`,
    `嵌入身份證副本 ${s.embedded_cards_found}（二階段 ${s.embedded_second_stage_found}／二階段掃描頁 ${s.second_stage_pages}）｜印刷佐證一致 ${s.card_printed_corroborated}｜印刷同卡唔一致 ${s.card_printed_conflict}｜淨印刷待覆核 ${s.printed_only_review}｜low 信心建議 ${s.proposals_low_confidence}｜卡姓名／核對唔一致 ${s.card_name_conflict}｜入職表輕微差異 ${s.form_differs}｜入職表完全唔相似 ${s.form_conflict}｜入職表冇名而冇名單佐證 ${s.card_unverified}`,
  ];
}
