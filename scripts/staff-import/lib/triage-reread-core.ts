// TR-1：舊分流題 OCR 重讀——核心邏輯（純函數＋可注入 client／圖片準備，方便 vitest 用合成 fixture 測）。
// 流程同應用內 client 一樣：印刷文件（身份證 → 住址證明）stage A → refs → 入職表 stage A（注入 refs）→ 欄位級裁圖 → stage B；
// 然後 mergeDocFields 得最終欄（來源規則：身份證／住址證明為準）→ 保守建議規則。
// 鐵則：欄位值只喺記憶體同 --out 檔（data/ 下）；console／summary 淨計數，唔印值、姓名、路徑、docId。
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
  confidence: 'high' | 'medium';
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

export type SkipReason = 'not_review' | 'no_read' | 'wrong_source' | 'not_confirmed' | 'arbiter_agree_a' | 'invalid_format' | 'cross_differs' | 'typed_list_disagrees';

/** 需要覆核嘅欄＝package 該欄 status=review（nameZh／hkid 亦然）。 */
export function needsReread(p: PkgPerson): boolean {
  return FIELD_MAP.some((m) => p[m.pkg].status === 'review');
}

export interface ProposeOutcome {
  proposals: RereadProposal[];
  /** 唔建議嘅原因計數（只計 package 為 review 嘅欄） */
  skipped: Partial<Record<SkipReason, number>>;
}

type Pick_ = { doc: OcrDocType; result: Pick<FieldResult, 'status' | 'value' | 'arbiter'>; cross?: 'match' | 'differs' | 'unreadable' };

/**
 * 保守建議規則（純函數）。picks＝mergeDocFields 嘅最終欄。
 *  - 只對 package 狀態為 review 嘅欄出建議；
 *  - 來源：姓名／身份證號／出生日期＝身份證；地址＝住址證明（唔收入職表手寫地址）；電話＝入職表；
 *  - 最終欄 status 必須 confirmed（兩讀一致，或仲裁同意；arbiter=agree_a 唔收）且格式 valid（HKID check digit、電話 8 位、日期曆法…）；
 *  - 入職表 vs 身份證交叉核對 differs → 唔建議；
 *  - package.reasons 顯示舊 crosscheck 對打字名單有唔一致 → 唔建議（留人手）。
 */
export function proposeFromPicks(p: PkgPerson, picks: Partial<Record<OcrFieldKey, Pick_>>, now: Date = new Date()): ProposeOutcome {
  const out: ProposeOutcome = { proposals: [], skipped: {} };
  const skip = (r: SkipReason) => {
    out.skipped[r] = (out.skipped[r] ?? 0) + 1;
  };
  for (const m of FIELD_MAP) {
    if (p[m.pkg].status !== 'review') continue;
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
    if (pick.cross === 'differs') {
      skip('cross_differs');
      continue;
    }
    if ((p.reasons ?? []).some((x) => TYPED_LIST_REASONS[m.field].includes(x))) {
      skip('typed_list_disagrees');
      continue;
    }
    // 值：hkid／dob／電話／姓名用 canon（同 server 校驗一致）；地址用最終讀數原文（canon 會歸一標點）
    const value = m.field === 'address' ? r.value.trim() : n.canon;
    out.proposals.push({ person_key: p.key, field: m.field, value, basis: r.arbiter ? 'arbiter' : 'two_reads', doc: pick.doc, confidence: pick.cross === 'match' ? 'high' : 'medium', match: { hkid: p.hkid.value?.trim() || null, staff_numbers: p.staffNumbers.map((n) => n.number) } });
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
  pages: ExtractPage[];
  address?: { page: number } | null;
}
export interface DocPage {
  type: OcrDocType;
  docId: string;
  page: number;
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
export interface RereadDeps {
  /** 每種文件砌 client（真跑＝同一組真 client；dry＝fake） */
  clientsFor(type: OcrDocType): ReadClients;
  /** 揀咗嘅一頁 → 圖片（真跑：prepareDocumentImages 經 docId/page 解析來源檔；dry：固定假圖） */
  prepare(d: DocPage): Promise<PreparedImages>;
  now?: Date;
}

/** 同 client 流程一樣次序讀一個人嘅 ≤3 份文件，回 mergeDocFields 嘅最終欄＋交叉核對。 */
export async function readPerson(docs: readonly DocPage[], deps: RereadDeps): Promise<{ picks: Partial<Record<OcrFieldKey, Pick_>>; calls: number }> {
  const now = deps.now ?? new Date();
  const ordered = [...docs.filter((d) => !OCR_CROP_FIELDS[d.type]), ...docs.filter((d) => OCR_CROP_FIELDS[d.type])];
  const printed: DocumentReadResult[] = [];
  const byType = new Map<OcrDocType, DocumentReadResult>();
  let calls = 0;
  for (const d of ordered) {
    const images = await deps.prepare(d);
    const isForm = !!OCR_CROP_FIELDS[d.type];
    const refs: Refs | null = isForm ? confirmedRefsFromDocs(printed) : null;
    const clients = deps.clientsFor(d.type);
    const a = await readStageA(clients, d.type, images.full, refs);
    const crops = images.cropFields ? await images.cropFields(d.type, a.field_boxes) : null;
    const r = await readStageB(clients, d.type, a, crops ? { kind: 'field_crops', images: crops.images, fieldOf: crops.fieldOf, full: images.full } : { kind: 'tiles', images: images.tiles, full: images.full }, now);
    calls += a.usage.calls + r.usage.calls;
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
  return { picks, calls };
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
  ocr_calls: number;
}

export function emptySummary(now: Date = new Date()): RereadSummary {
  return { generated_at: now.toISOString(), persons_in_package: 0, persons_needing_reread: 0, persons_no_docs: 0, persons_processed: 0, persons_failed: 0, persons_with_proposals: 0, proposals_total: 0, proposals_by_field: {}, proposals_by_basis: {}, not_proposed_reasons: {}, ocr_calls: 0 };
}

export function addOutcome(s: RereadSummary, o: ProposeOutcome): void {
  if (o.proposals.length > 0) s.persons_with_proposals += 1;
  for (const p of o.proposals) {
    s.proposals_total += 1;
    s.proposals_by_field[p.field] = (s.proposals_by_field[p.field] ?? 0) + 1;
    s.proposals_by_basis[p.basis] = (s.proposals_by_basis[p.basis] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(o.skipped)) s.not_proposed_reasons[k] = (s.not_proposed_reasons[k] ?? 0) + (v ?? 0);
}

export function summaryLines(s: RereadSummary): string[] {
  return [
    `package 人數 ${s.persons_in_package}｜需重讀 ${s.persons_needing_reread}｜冇文件 ${s.persons_no_docs}｜已讀 ${s.persons_processed}｜失敗 ${s.persons_failed}`,
    `有建議嘅人 ${s.persons_with_proposals}｜建議共 ${s.proposals_total}｜OCR 呼叫 ${s.ocr_calls}`,
    `每欄建議：${JSON.stringify(s.proposals_by_field)}｜依據：${JSON.stringify(s.proposals_by_basis)}`,
    `唔建議原因：${JSON.stringify(s.not_proposed_reasons)}`,
  ];
}
