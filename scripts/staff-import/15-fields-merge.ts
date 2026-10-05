// WP-STAFF-FIELDS：合併 打字名單／Payroll Editor／申請表與牌照頁讀數 → person-fields-ext.json ＋ summary.json。
// 輸入（全部本機 data/）：out/person-fields.json、index.json、typed-sources.json、read-tasks.json、
//   first-read.json、second-read.json（可選，未有就當未做）、ocr/*.jsonl。console 只印計數。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalHkid } from './lib/hkid';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { FIELDS_OUT } from './lib/fields-render';
import {
  bankByCode, bankCodeFromName, expiryInRange, issueInRange, joinInRange, normAcct, normDate, normPermitNo, normTelHkStrict, normZh,
  permitMatchesHkid, resolveField, sameNameTokens, normText, type Cand, type FieldOut, type SrcKind, TODAY,
} from './lib/fields-ext';
import { normalizeTelHk } from '@/lib/guards/identity';
import { OUT } from './lib/render';

type ReadMap = Record<string, { legible: string; fields: Record<string, string | null>; unsure?: string[] }>;
interface Task { id: string; person: number; file: string; spec: string; fields: string[]; handwritten: boolean }
interface Typed {
  maxwell: { ref: string; staffNo: string | null; nameEn: string | null; nameZh: string | null; hkid: string | null; join: string | null; payee: string | null; bankCode: string | null; acct: string | null; sppNo: string | null; sppA: string | null; sppB: string | null; qas: string | null; green: string | null; emergency: (string | null)[] }[];
  uteam: { ref: string; staffNo: string | null; join: string | null; hkid: string | null; nameZh: string | null; nameEn: string | null; emergency: (string | null)[]; bankCode: string | null; acct: string | null }[];
  parttime?: { ref: string; staffNo: string | null; hkid: string | null; firstStamp: string | null; lastStamp: string | null }[];
  payrollEditor: { month: string; bankCode: string | null; acct: string; name: string }[];
}
interface Person {
  key: string; keyKind: 'hkid' | 'staffNo' | 'internal'; hasDocs: boolean; idx: number | null; docIds: string[]; staffNos: string[];
  hkid: string | null; names: string[]; mx: Typed['maxwell']; ut: Typed['uteam']; pe: { acct: string; code: string | null; name: string; months: string[]; how: string }[];
  fields: Record<string, unknown>; flags: string[];
}
const J = async <T>(p: string, dflt?: T): Promise<T> => { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch (e) { if (dflt !== undefined) return dflt; throw e; } };
const cleanNo = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, '') || null;

async function main() {
  const pf = await J<{ key: string; docIds: string[]; fields: { nameEn: { value: string | null; candidates: string[] }; nameZh: { value: string | null } } }[]>(path.join(OUT, 'out/person-fields.json'));
  const index = new Map((await J<DocMeta[]>(path.join(OUT, 'index.json'))).map((m) => [m.docId, m]));
  const typed = await J<Typed>(path.join(FIELDS_OUT, 'typed-sources.json'));
  const tasks = await J<Task[]>(path.join(FIELDS_OUT, 'read-tasks.json'), []);
  // 讀數檔：first-read.json（總檔）＋ first-read-b*.json（分批，各自落盤）；second-read 同理
  const loadReads = async (prefix: string): Promise<ReadMap> => {
    const names = (await fs.readdir(FIELDS_OUT)).filter((f) => f === `${prefix}.json` || new RegExp(`^${prefix}-b.*\\.json$`).test(f)).sort();
    const m: ReadMap = {};
    for (const n of names) Object.assign(m, await J<ReadMap>(path.join(FIELDS_OUT, n)));
    return m;
  };
  const first = await loadReads('first-read');
  const second = await loadReads('second-read');
  const ocr2 = await J<Record<string, { nos: string[]; to: string[] }>>(path.join(FIELDS_OUT, 'permit-ocr2.json'), {});
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const summaryFlags: Record<string, number> = {};
  const bump = (k: string) => (summaryFlags[k] = (summaryFlags[k] ?? 0) + 1);

  // ---- 人 ----
  const persons: Person[] = pf.map((p, i) => ({
    key: p.key, keyKind: 'hkid', hasDocs: true, idx: i, docIds: p.docIds, staffNos: [...new Set(p.docIds.map((d) => cleanNo(index.get(d)?.staffNo)).filter((x): x is string => !!x))],
    hkid: canonicalHkid(p.key), names: [p.fields.nameEn.value, ...p.fields.nameEn.candidates].filter((x): x is string => !!x), mx: [], ut: [], pe: [], fields: {}, flags: [],
  }));
  const byHkid = new Map(persons.filter((p) => p.hkid).map((p) => [p.hkid!, p]));
  const byStaff = new Map<string, Person[]>();
  persons.forEach((p) => p.staffNos.forEach((s) => byStaff.set(s, [...(byStaff.get(s) ?? []), p])));
  const link = (hkid: string | null, staffNo: string | null): Person | null => {
    const h = canonicalHkid(hkid ?? '');
    if (h && byHkid.has(h)) return byHkid.get(h)!;
    const s = cleanNo(staffNo);
    const c = s ? byStaff.get(s) : undefined;
    return c && c.length === 1 ? c[0] : null;
  };
  const mxOnly: Person[] = [];
  for (const r of typed.maxwell) {
    const p = link(r.hkid, r.staffNo);
    if (p) { p.mx.push(r); continue; }
    if (!r.hkid && !r.nameEn && !r.nameZh) { bump('maxwell_empty_rows_skipped'); continue; }
    const h = canonicalHkid(r.hkid ?? '');
    const np: Person = { key: h ?? cleanNo(r.staffNo) ?? `mxrow:${r.ref.split(':').slice(1).join(':')}`, keyKind: h ? 'hkid' : r.staffNo ? 'staffNo' : 'internal', hasDocs: false, idx: null, docIds: [], staffNos: [cleanNo(r.staffNo)].filter((x): x is string => !!x), hkid: h, names: [r.nameEn].filter((x): x is string => !!x), mx: [r], ut: [], pe: [], fields: {}, flags: ['typed_list_only_person'] };
    mxOnly.push(np);
    if (h) byHkid.set(h, np);
    np.staffNos.forEach((s) => byStaff.set(s, [...(byStaff.get(s) ?? []), np]));
  }
  persons.push(...mxOnly);
  for (const r of typed.uteam) { const p = link(r.hkid, r.staffNo); if (p) p.ut.push(r); }
  for (const p of persons) {
    for (const r of p.mx) if (r.nameEn) p.names.push(r.nameEn);
    for (const r of p.mx) if (r.payee) p.names.push(r.payee);
    for (const r of p.ut) if (r.nameEn) p.names.push(r.nameEn);
  }

  const ptLinked: Record<string, string[]> = {};
  let ptUnlinked = 0;
  for (const r of typed.parttime ?? []) {
    const p = link(r.hkid, r.staffNo);
    if (!p) { ptUnlinked++; continue; }
    const sn = cleanNo(r.staffNo);
    if (sn && !p.staffNos.includes(sn)) (ptLinked[p.key] ??= []).push(sn);
  }
  summaryFlags.parttime_rows_unlinked = ptUnlinked;
  summaryFlags.parttime_extra_staffno_persons = Object.keys(ptLinked).length;

  // ---- Payroll Editor 對人 ----
  const peAccts = new Map<string, { acct: string; code: string | null; name: string; months: string[] }>();
  for (const r of typed.payrollEditor) {
    const k = normAcct(r.acct)!;
    const e = peAccts.get(k) ?? { acct: k, code: r.bankCode, name: r.name, months: [] };
    e.months.push(r.month);
    peAccts.set(k, e);
  }
  const peOnly: Person[] = [];
  for (const e of peAccts.values()) {
    const hard = persons.filter((p) => [...p.mx, ...p.ut].some((r) => normAcct(r.acct) === e.acct) && p.names.some((n) => sameNameTokens(n, e.name)));
    if (hard.length === 1) { hard[0].pe.push({ ...e, how: 'hard_key' }); bump('pe_matched_hard'); continue; }
    if (hard.length > 1) { persons.filter((p) => hard.includes(p)).forEach((p) => p.flags.push('pe_multi_hard_match')); }
    const nameMatches = persons.filter((p) => p.names.some((n) => sameNameTokens(n, e.name)));
    if (nameMatches.length === 1) { nameMatches[0].pe.push({ ...e, how: 'name_only' }); bump('pe_matched_name_only'); continue; }
    const np: Person = { key: `pe:${e.code ?? 'xxx'}:${e.acct.slice(-4)}`, keyKind: 'internal', hasDocs: false, idx: null, docIds: [], staffNos: [], hkid: null, names: [e.name], mx: [], ut: [], pe: [{ ...e, how: nameMatches.length ? 'name_ambiguous' : 'no_identity' }], fields: {}, flags: ['payroll_editor_only_person'] };
    peOnly.push(np);
    bump(nameMatches.length ? 'pe_name_ambiguous' : 'pe_no_identity');
  }
  persons.push(...peOnly);

  // ---- 讀數 → 候選 ----
  const permitOcr = new Map<string, { no: string | null; nos: string[]; to: Set<string> }>();
  async function ocrOfPermit(docId: string, page: number) {
    const k = `${docId}-p${page}`;
    if (permitOcr.has(k)) return permitOcr.get(k)!;
    const pages = (await fs.readFile(path.join(OUT, 'ocr', `${docId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage).filter((o) => !o.alt);
    const lines = pages.find((o) => o.page === page)?.lines ?? [];
    const txt = lines.map((l) => l.t).join(' ');
    const nos: string[] = [];
    for (const m of txt.matchAll(/[A-Z]{1,2}\s*-?\s*\d{6}\s*-?\s*[0-9A]\s*-?\s*\d{3}/g)) { const n = normPermitNo(m[0]); if (n && !nos.includes(n)) nos.push(n); }
    const no = nos[0] ?? null;
    const to = new Set<string>();
    for (const l of lines) { const m = /^\s*(20\d{2}-\d{2}-\d{2})\s*$/.exec(l.t); if (m) to.add(m[1]); }
    const v = { no, nos, to };
    permitOcr.set(k, v);
    return v;
  }
  // 整頁 OCR ∪ 裁圖四向重跑 OCR（兩者都係本機 Apple Vision，同屬「本機 OCR」一個證據類別）
  async function ocrFor(tid: string, docId: string, page: number) {
    const a = await ocrOfPermit(docId, page);
    const b = ocr2[tid];
    return { nos: [...new Set([...a.nos, ...(b?.nos ?? []).filter((x) => x.length > 0)])], to: new Set([...a.to, ...(b?.to ?? [])]), no: a.no };
  }
  const dates = (v: string | null | undefined) => normDate(v ?? null);
  for (const p of persons) {
    const C: Record<string, Cand[]> = {};
    const add = (f: string, src: SrcKind, v: string | null | undefined, ref?: string) => { if (v) (C[f] ??= []).push({ src, value: v, ref }); };
    const hireBy = new Map<string, Cand[]>();
    const addHire = (sn: string | null, src: SrcKind, v: string | null) => { if (v) hireBy.set(sn ?? '?', [...(hireBy.get(sn ?? '?') ?? []), { src, value: v }]); };
    const emContacts: { src: SrcKind; slot: number; name: string | null; rel: string | null; tel: string | null; telRaw: string | null }[] = [];
    // 打字名單
    for (const r of p.mx) {
      const pn = normPermitNo(r.sppNo);
      if (r.sppNo && !pn) p.flags.push('typed_permit_no_format');
      add('siaPermitNo', 'typed_maxwell', pn);
      add('siaPermitAExpiry', 'typed_maxwell', dates(r.sppA)); add('siaPermitBExpiry', 'typed_maxwell', dates(r.sppB));
      const q = dates(r.qas);
      if (q) add(q <= TODAY ? 'qasIssueDate' : 'qasExpiryDate', 'typed_maxwell', q);
      add('safetyCardExpiry', 'typed_maxwell', dates(r.green));
      addHire(cleanNo(r.staffNo), 'typed_maxwell', dates(r.join));
      const [en, er, et] = r.emergency;
      if (en || et) emContacts.push({ src: 'typed_maxwell', slot: 9, name: en, rel: er, tel: normalizeTelHk(et), telRaw: et });
    }
    for (const r of p.ut) {
      addHire(cleanNo(r.staffNo), 'typed_uteam', dates(r.join));
      const [en, er, et] = r.emergency;
      if (en || et) emContacts.push({ src: 'typed_uteam', slot: 9, name: en, rel: er, tel: normalizeTelHk(et), telRaw: et });
    }
    // 視覺讀數＋OCR
    const staffForm: string[] = [];
    for (const docId of p.docIds) {
      for (const t of tasks.filter((x) => x.id.startsWith(`${docId}-`))) {
        const reads: [SrcKind, ReadMap[string] | undefined][] = [[t.handwritten ? 'hand_read1' : 'printed_read1', first[t.id]], [t.handwritten ? 'hand_read2' : 'printed_read2', second[t.id]]];
        if (t.spec === 'permit_card') {
          const o = await ocrFor(t.id, docId, Number(/-p(\d+)-/.exec(t.id)![1]));
          for (const n of o.nos) add('siaPermitNo', 'printed_ocr', n);
          for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry']) o.to.forEach((d) => { (C[`${f}__ocrset`] ??= []).push({ src: 'printed_ocr', value: d }); });
        }
        for (const [src, rd] of reads) {
          if (!rd || rd.legible === 'illegible') continue;
          const f: Record<string, string | null> = { ...rd.fields };
          for (const u of rd.unsure ?? []) { f[u] = null; p.flags.push('some_fields_unsure'); } // 欄位級睇唔清：唔入候選
          const unsure = rd.legible === 'unsure';
          if (unsure) { p.flags.push('some_reads_unsure'); continue; } // 睇唔清唔入候選（唔估）
          const pn = f.permit_no ? normPermitNo(f.permit_no) : null;
          if (f.permit_no && !pn) p.flags.push('permit_no_read_format_invalid');
          add('siaPermitNo', src, pn);
          add('siaPermitAExpiry', src, dates(f.exp_a ?? f.a_to)); add('siaPermitBExpiry', src, dates(f.exp_b ?? f.b_to));
          add('siaPermitCExpiry', src, dates(f.exp_c ?? f.c_to)); add('siaPermitDExpiry', src, dates(f.exp_d ?? f.d_to));
          add('qasIssueDate', src, dates(f.qas_issue)); add('qasExpiryDate', src, dates(f.qas_expiry));
          add('safetyCardNo', src, f.green_no ? f.green_no.toUpperCase().replace(/\s+/g, '') : null); add('safetyCardExpiry', src, dates(f.green_expiry));
          addHire(cleanNo(index.get(docId)?.staffNo), src, dates(f.join));
          if (f.staff_no) staffForm.push(cleanNo(f.staff_no)!);
          for (const s of [1, 2]) {
            const nm = f[`em${s}_name`], tl = f[`em${s}_tel`], rl = f[`em${s}_rel`];
            if (nm || tl) emContacts.push({ src, slot: s, name: nm ?? null, rel: rl ?? null, tel: normalizeTelHk(tl), telRaw: tl ?? null });
          }
        }
      }
    }
    // OCR 日期集合：只當 A／B 到期日嘅額外獨立證據（讀數值喺 OCR 嘅「to」日期集合入面）
    for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry']) {
      const set = (C[`${f}__ocrset`] ?? []).map((c) => c.value);
      delete C[`${f}__ocrset`];
      for (const c of [...(C[f] ?? [])]) if ((c.src === 'printed_read1' || c.src === 'printed_read2') && set.includes(c.value)) add(f, 'printed_ocr', c.value);
    }
    {
      // (1) 前段相同、其一欠序號 → 補成較長嗰個（flag）；(2) 有身份證號時，前段唔等於身份證號嘅候選剔走（有對得上先剔，flag）
      let cs = C.siaPermitNo ?? [];
      const longer = cs.map((c) => c.value).filter((v) => v.length > 12);
      for (const c of cs) if (c.value.length <= 12) { const f = longer.find((x) => x.startsWith(c.value)); if (f) { c.value = f; p.flags.push('permit_no_serial_filled'); } }
      if (p.hkid && cs.some((c) => permitMatchesHkid(c.value, p.hkid))) {
        const kept = cs.filter((c) => permitMatchesHkid(c.value, p.hkid));
        if (kept.length < cs.length) p.flags.push('permit_no_candidates_discarded_not_matching_hkid');
        cs = kept;
      }
      C.siaPermitNo = cs;
    }
    const F = p.fields;
    if (ptLinked[p.key]) F.extraStaffNosFromParttimeList = ptLinked[p.key];
    F.siaPermitNo = resolveField(C.siaPermitNo ?? [], { validate: (v) => (p.hkid && !permitMatchesHkid(v, p.hkid) ? 'permit_no_not_matching_hkid' : null) });
    for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry', 'siaPermitCExpiry', 'siaPermitDExpiry', 'safetyCardExpiry', 'qasExpiryDate']) F[f] = resolveField(C[f] ?? [], { validate: (v) => (expiryInRange(v) ? null : 'date_out_of_range') });
    F.qasIssueDate = resolveField(C.qasIssueDate ?? [], { validate: (v) => (issueInRange(v) ? null : 'date_out_of_range') });
    {
      // 入職日期掛喺每個工號行（老闆 2026-09-19：全部保留）：逐工號 resolve；人層面取最早，來源註明
      const rows = [...hireBy.entries()].map(([sn, cs]) => ({ staffNo: sn, field: resolveField(cs, { validate: (v) => (joinInRange(v) ? null : 'date_out_of_range') }) }));
      F.staffNumbers = rows.map((r) => ({ staffNo: r.staffNo, hireDate: r.field }));
      const vals = rows.flatMap((r) => r.field.candidates.map((c) => ({ v: c.value, src: c.sources })));
      const earliest = vals.length ? vals.reduce((a, b) => (b.v < a.v ? b : a)) : null;
      const anyReview = rows.some((r) => r.field.status === 'review');
      F.hireDate = !earliest ? { value: null, status: 'missing', candidates: [], sources: [], reasons: [] } : { value: earliest.v, status: anyReview ? 'review' : 'confirmed', candidates: vals.map((x) => ({ value: x.v, sources: x.src })), sources: [...new Set(vals.flatMap((x) => x.src))], reasons: [...(rows.length > 1 ? ['earliest_of_staff_numbers'] : []), ...(anyReview ? ['same_staff_no_sources_disagree'] : []), ...rows.flatMap((r) => r.field.reasons.filter((x) => x === 'typed_list_only'))] } satisfies FieldOut;
    }
    F.safetyCardNo = resolveField(C.safetyCardNo ?? []);
    {
      const ex = ['siaPermitAExpiry', 'siaPermitBExpiry', 'siaPermitCExpiry', 'siaPermitDExpiry'] as const;
      const letters = ex.map((f, i) => ((F[f] as FieldOut).value ? 'ABCD'[i] : '')).join('');
      const states = ex.map((f) => (F[f] as FieldOut)).filter((x) => x.value || x.status === 'review');
      F.siaPermitTypes = { value: letters || null, status: !states.length ? 'missing' : states.every((x) => x.status === 'confirmed') ? 'confirmed' : 'review', candidates: [], sources: [], reasons: ['derived_from_expiry_fields'] } satisfies FieldOut;
    }
    // 緊急聯絡人：以電話或中文名相同歸同一人
    const groups: typeof emContacts[] = [];
    for (const c of emContacts) {
      const g = groups.find((gr) => gr.some((x) => (c.tel && x.tel && c.tel === x.tel) || (c.name && x.name && normZh(c.name) === normZh(x.name))));
      if (g) g.push(c); else groups.push([c]);
    }
    groups.sort((a, b) => Math.min(...a.map((x) => x.slot)) - Math.min(...b.map((x) => x.slot)));
    if (groups.length > 2) p.flags.push('emergency_more_than_two');
    [0, 1].forEach((i) => {
      const g = groups[i] ?? [];
      const mk = (pick: (c: (typeof emContacts)[number]) => string | null, norm: (s: string) => string | null, validate?: (v: string) => string | null) =>
        resolveField(g.flatMap((c) => { const raw = pick(c); const n = raw ? norm(raw) : null; return n ? [{ src: c.src, value: n }] : []; }), { validate });
      F[`emergency${i + 1}Name`] = mk((c) => c.name, (s) => normZh(s) || null);
      F[`emergency${i + 1}Relationship`] = mk((c) => c.rel, (s) => normZh(s) || null);
      F[`emergency${i + 1}Tel`] = mk((c) => c.telRaw, (s) => normalizeTelHk(s), (v) => (normTelHkStrict(v) ? null : 'tel_not_hk_format'));
    });
    if (!groups[1] && p.mx.length && !p.docIds.length) { /* 淨打字名單：單一聯絡人欄 */ }
    // 員工編號對檔名
    const uniq = [...new Set(staffForm)];
    F.staffNoCheck = !p.docIds.length ? null : !uniq.length ? { status: 'form_blank_or_unread', formValues: [], fileStaffNos: p.staffNos } : uniq.every((s) => p.staffNos.includes(s)) ? { status: 'match', formValues: uniq, fileStaffNos: p.staffNos } : { status: 'mismatch', formValues: uniq, fileStaffNos: p.staffNos };
    // 銀行（Payroll Editor 為主）
    const bankCopy = p.docIds.flatMap((d) => tasks.filter((t) => t.id.startsWith(`${d}-`) && t.spec === 'bank_page')).map((t) => ({ id: t.id, r1: first[t.id], r2: second[t.id] }));
    const copyAccts = bankCopy.flatMap((b) => [b.r1, b.r2]).filter((r) => r && r.legible === 'clear').map((r) => normAcct(r!.fields.acct)).filter((x): x is string => !!x);
    const peUnique = [...new Map(p.pe.map((e) => [e.acct, e])).values()];
    if (peUnique.length > 1) p.flags.push('pe_multiple_accounts');
    const e = peUnique[0];
    const mxAcct = p.mx.map((r) => normAcct(r.acct)).find(Boolean) ?? null;
    const utAcct = p.ut.map((r) => normAcct(r.acct)).find(Boolean) ?? null;
    const bankOut = (value: string | null, status: FieldOut['status'], reasons: string[], sources: string[], candidates: FieldOut['candidates'] = []): FieldOut => ({ value, status, candidates, sources, reasons });
    if (e) {
      const hard = e.how === 'hard_key';
      const reasons: string[] = hard ? [] : [e.how === 'name_only' ? 'bank_identity_name_only' : e.how === 'name_ambiguous' ? 'bank_identity_name_ambiguous' : 'bank_identity_unknown'];
      const src = ['typed_pe', ...(hard && (mxAcct === e.acct) ? ['typed_maxwell'] : []), ...(hard && (utAcct === e.acct) ? ['typed_uteam'] : [])];
      if (copyAccts.length) reasons.push(copyAccts.every((a) => a === e.acct) ? 'bank_copy_agrees' : 'bank_copy_disagrees');
      if (mxAcct && mxAcct !== e.acct) reasons.push('maxwell_acct_differs');
      const ok = hard && !reasons.some((r) => r.endsWith('disagrees') || r.endsWith('differs'));
      const code = e.code ? e.code.padStart(3, '0') : null;
      const cands = (v: string) => [{ value: v, sources: src }];
      F.bankAccountNo = bankOut(e.acct, ok ? 'confirmed' : 'review', reasons, src, cands(e.acct));
      F.bankCode = bankOut(code, ok && code && bankByCode(code) ? 'confirmed' : 'review', [...reasons, ...(code && !bankByCode(code) ? ['bank_code_not_in_hkicl_table'] : [])], src, code ? cands(code) : []);
      const bn = code ? bankByCode(code) : null;
      F.bankName = bankOut(bn ? bn.nameZhShort : null, bn && ok ? 'confirmed' : 'review', [...reasons, 'bank_name_derived_from_code'], src);
      const payeeOk = !p.mx.some((r) => r.payee && !sameNameTokens(r.payee, e.name));
      F.bankPayeeName = bankOut(e.name, ok && payeeOk ? 'confirmed' : 'review', [...reasons, ...(payeeOk ? [] : ['maxwell_payee_differs'])], src, cands(e.name));
      F.bankMonths = e.months;
    } else if (copyAccts.length) {
      const first1 = bankCopy.map((b) => b.r1).find((r) => r && r.legible === 'clear');
      const nm = first1?.fields.bank_name ?? null;
      for (const f of ['bankAccountNo', 'bankCode', 'bankName', 'bankPayeeName']) F[f] = bankOut(f === 'bankAccountNo' ? copyAccts[0] : f === 'bankCode' ? bankCodeFromName(nm) : f === 'bankName' ? nm : first1?.fields.holder ?? null, 'review', ['bank_copy_only'], ['bank_copy_read1']);
    } else {
      for (const f of ['bankAccountNo', 'bankCode', 'bankName', 'bankPayeeName']) F[f] = bankOut(null, 'missing', [], []);
    }
  }

  // ---- 印刷牌照卡：本機 OCR vs 視覺第一讀 一致率 ----
  const agree = { permitNo: { both: 0, same: 0 }, toDates: { both: 0, same: 0 } };
  for (const t of tasks.filter((x) => x.spec === 'permit_card')) {
    const rd = first[t.id];
    if (!rd || rd.legible === 'illegible') continue;
    const m = /^(.+)-p(\d+)-permit_card$/.exec(t.id)!;
    const o = await ocrFor(t.id, m[1], Number(m[2]));
    const vn = rd.fields.permit_no && !(rd.unsure ?? []).includes('permit_no') ? normPermitNo(rd.fields.permit_no) : null;
    if (vn && o.nos.length) { agree.permitNo.both++; if (o.nos.includes(vn)) agree.permitNo.same++; }
    for (const k of ['a_to', 'b_to', 'c_to', 'd_to']) {
      const dv = rd.fields[k] && !(rd.unsure ?? []).includes(k) ? normDate(rd.fields[k]) : null;
      if (dv && o.to.size) { agree.toDates.both++; if (o.to.has(dv)) agree.toDates.same++; }
    }
  }
  summaryFlags.ocr_vs_vision_permitNo_both = agree.permitNo.both; summaryFlags.ocr_vs_vision_permitNo_same = agree.permitNo.same;
  summaryFlags.ocr_vs_vision_toDates_both = agree.toDates.both; summaryFlags.ocr_vs_vision_toDates_same = agree.toDates.same;

  // ---- 輸出 ----
  const out = persons.map((p) => ({ key: p.key, keyKind: p.keyKind, hasDocs: p.hasDocs, docIds: p.docIds, staffNos: p.staffNos, typedSources: { maxwell: p.mx.length, uteam: p.ut.length, payrollEditor: p.pe.length }, flags: [...new Set(p.flags)], fields: p.fields }));
  await fs.writeFile(path.join(FIELDS_OUT, 'person-fields-ext.json'), JSON.stringify(out, null, 1));
  // summary（只有計數）
  const groupsOf = (pred: (p: Person) => boolean) => out.filter((_, i) => pred(persons[i]));
  const fieldNames = [...new Set(out.flatMap((o) => Object.keys(o.fields)))].filter((f) => out.some((o) => (o.fields[f] as FieldOut | null)?.status));
  const stat = (arr: typeof out) => Object.fromEntries(fieldNames.map((f) => {
    const c = { confirmed: 0, review: 0, missing: 0 } as Record<string, number>;
    arr.forEach((o) => { const s = (o.fields[f] as FieldOut | undefined)?.status; if (s) c[s]++; });
    return [f, c];
  }));
  const srcDist: Record<string, Record<string, number>> = {};
  fieldNames.forEach((f) => { srcDist[f] = {}; out.forEach((o) => ((o.fields[f] as FieldOut)?.sources ?? []).forEach((s) => (srcDist[f][s] = (srcDist[f][s] ?? 0) + 1))); });
  const cropMissingReasons: Record<string, number> = {};
  {
    const last = new Map<string, { missing: { reason: string }[] }>();
    for (const f of (await fs.readdir(FIELDS_OUT)).filter((x) => /^crops-manifest.*\.json$/.test(x)).sort()) for (const pr of await J<{ key: string; missing: { reason: string }[] }[]>(path.join(FIELDS_OUT, f))) last.set(pr.key, pr);
    for (const pr of last.values()) for (const m of pr.missing) cropMissingReasons[m.reason] = (cropMissingReasons[m.reason] ?? 0) + 1;
  }
  const summary = {
    persons: { total: out.length, withDocs: groupsOf((p) => p.hasDocs).length, typedListOnly: groupsOf((p) => p.flags.includes('typed_list_only_person')).length, payrollEditorOnly: groupsOf((p) => p.flags.includes('payroll_editor_only_person')).length },
    fieldStatus: { allPersons: stat(out), withDocs: stat(groupsOf((p) => p.hasDocs)), typedListOnly: stat(groupsOf((p) => p.flags.includes('typed_list_only_person'))), payrollEditorOnly: stat(groupsOf((p) => p.flags.includes('payroll_editor_only_person'))) },
    cropMissingReasons,
    readQueue: { handwritten: tasks.filter((t) => t.handwritten).length, printed: 0, note: '印刷頁（牌照卡、銀行副本）以 本機OCR＝視覺讀數 確認，唔入第二讀數隊列' },
    sourceDistribution: srcDist,
    matching: summaryFlags,
    readUnits: { tasks: tasks.length, firstRead: Object.keys(first).length, secondRead: Object.keys(second).length },
    personFlags: out.reduce<Record<string, number>>((a, o) => { o.flags.forEach((f) => (a[f] = (a[f] ?? 0) + 1)); return a; }, {}),
    staffNoCheck: out.reduce<Record<string, number>>((a, o) => { const s = (o.fields.staffNoCheck as { status: string } | null)?.status; if (s) a[s] = (a[s] ?? 0) + 1; return a; }, {}),
  };
  await fs.writeFile(path.join(FIELDS_OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  void taskById; void normText;
  console.log(`persons=${out.length} withDocs=${summary.persons.withDocs} typedOnly=${summary.persons.typedListOnly} peOnly=${summary.persons.payrollEditorOnly}`);
}
main();
