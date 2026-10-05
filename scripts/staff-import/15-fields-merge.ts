// WP-STAFF-FIELDS：合併 打字名單／Payroll Editor／申請表與牌照頁讀數 → person-fields-ext.json ＋ summary.json。
// 輸入（全部本機 data/）：out/person-fields.json、index.json、typed-sources.json、read-tasks.json、
//   first-read.json、second-read.json（可選，未有就當未做）、ocr/*.jsonl。console 只印計數。
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalHkid } from './lib/hkid';
import type { DocMeta } from './lib/doc-index';
import type { OcrPage } from './lib/ocr';
import { FIELDS_OUT } from './lib/fields-render';
import {
  bankByCode, bankCodeFromName, expiryInRange, issueInRange, joinInRange, normAcct, normDate, normPermitNo, normTelHkStrict, normZh,
  applyHandRules, isPureHand, acctAgreeKind, isCardControlNo, permitMatchesHkid, resolveField, sameNameTokens, normText, splitPermit, type Cand, type FieldOut, type SrcKind, TODAY,
} from './lib/fields-ext';
import { normalizeTelHk } from '@/lib/guards/identity';
import { OUT } from './lib/render';

type ReadMap = Record<string, { legible: string; fields: Record<string, string | null>; unsure?: string[] }>;
interface Task { id: string; person: number; file: string; spec: string; fields: string[]; handwritten: boolean }
type Mx = Typed['maxwell'][number] & { weak?: boolean };
type Ut = Typed['uteam'][number] & { weak?: boolean };
interface EmItem { src: SrcKind; name: string | null; rel: string | null; tel: string | null }
interface EmUnit { typed: boolean; weak: boolean; items: EmItem[] }
interface Typed {
  maxwell: { ref: string; staffNo: string | null; nameEn: string | null; nameZh: string | null; hkid: string | null; join: string | null; payee: string | null; bankCode: string | null; acct: string | null; sppNo: string | null; sppA: string | null; sppB: string | null; qas: string | null; green: string | null; emergency: (string | null)[] }[];
  uteam: { ref: string; staffNo: string | null; join: string | null; hkid: string | null; nameZh: string | null; nameEn: string | null; emergency: (string | null)[]; bankCode: string | null; acct: string | null }[];
  parttime?: { ref: string; staffNo: string | null; hkid: string | null; firstStamp: string | null; lastStamp: string | null }[];
  payrollEditor: { month: string; bankCode: string | null; acct: string; name: string }[];
}
interface Person {
  key: string; keyKind: 'hkid' | 'staffNo' | 'internal'; hasDocs: boolean; idx: number | null; docIds: string[]; staffNos: string[];
  hkid: string | null; nameZh: string | null; names: string[]; weakFields: Set<string>; mx: Mx[]; ut: Ut[]; pe: { acct: string; code: string | null; name: string; months: string[]; how: string }[];
  fields: Record<string, unknown>; flags: string[];
}
const J = async <T>(p: string, dflt?: T): Promise<T> => { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch (e) { if (dflt !== undefined) return dflt; throw e; } };
const cleanNo = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, '') || null;

async function main() {
  const pf = await J<{ key: string; docIds: string[]; fields: { nameEn: { value: string | null; candidates: string[] }; nameZh: { value: string | null } } }[]>(path.join(OUT, 'out/person-fields.json'));
  const index = new Map((await J<DocMeta[]>(path.join(OUT, 'index.json'))).map((m) => [m.docId, m]));
  const typed = await J<Typed>(path.join(FIELDS_OUT, 'typed-sources.json'));
  const STAFF_NO_OK = /^[A-Z]{1,4}\d{2,7}$/;
  const okNo = (s: string | null) => !!s && STAFF_NO_OK.test(s.replace(/\s+/g, '').toUpperCase());
  const droppedRows = typed.maxwell.filter((r) => !okNo(r.staffNo)).length + typed.uteam.filter((r) => !okNo(r.staffNo)).length;
  typed.maxwell = typed.maxwell.filter((r) => okNo(r.staffNo));
  typed.uteam = typed.uteam.filter((r) => okNo(r.staffNo));
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
  // Opus 牌照卡獨立視覺讀（verify/agent-*/permit-read.json，key＝裁圖 id，格式同 ReadMap）→ 併入 permit_card 嘅 printed_read2
  let opusPermitUnits = 0;
  {
    const vdir = path.join(FIELDS_OUT, 'verify');
    const permitIds = new Set(tasks.filter((t) => t.spec === 'permit_card').map((t) => t.id));
    for (const d of (await fs.readdir(vdir).catch(() => [] as string[])).filter((x) => /^agent-\d+$/.test(x))) {
      const m = await J<ReadMap>(path.join(vdir, d, 'permit-read.json'), {});
      for (const [id, rd] of Object.entries(m)) if (permitIds.has(id) && !second[id] && rd?.fields) { second[id] = rd; opusPermitUnits++; }
    }
  }
  const ocr2 = await J<Record<string, { nos: string[]; to: string[] }>>(path.join(FIELDS_OUT, 'permit-ocr2.json'), {});
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const summaryFlags: Record<string, number> = {};
  summaryFlags.opus_permit_reads_merged = opusPermitUnits;
  summaryFlags.typed_rows_dropped_bad_staffno_in_merge = droppedRows;
  const bump = (k: string) => (summaryFlags[k] = (summaryFlags[k] ?? 0) + 1);

  // ---- 人 ----
  const persons: Person[] = pf.map((p, i) => {
    const isDoc = p.key.startsWith('doc:');
    return {
      key: p.key, keyKind: isDoc ? 'internal' : 'hkid', hasDocs: true, idx: i, docIds: p.docIds, staffNos: [...new Set(p.docIds.map((d) => cleanNo(index.get(d)?.staffNo)).filter((x): x is string => !!x))],
      hkid: isDoc ? null : canonicalHkid(p.key), nameZh: p.fields.nameZh.value ?? null, names: [p.fields.nameEn.value, ...p.fields.nameEn.candidates].filter((x): x is string => !!x), mx: [], ut: [], pe: [], fields: {}, flags: [], weakFields: new Set<string>(),
    };
  });
  const byHkid = new Map(persons.filter((p) => p.hkid).map((p) => [p.hkid!, p]));
  const byStaff = new Map<string, Person[]>();
  persons.forEach((p) => p.staffNos.forEach((s) => byStaff.set(s, [...(byStaff.get(s) ?? []), p])));
  // M5：檔名工號被多個人共用
  const sharedStaff = new Set<string>();
  for (const [s, ps] of byStaff) if (ps.length > 1) {
    sharedStaff.add(s);
    for (const a of ps) {
      a.flags.push('filename_staff_no_shared');
      for (const b of ps) if (a !== b && (!a.hkid || !b.hkid || (a.nameZh && b.nameZh && normZh(a.nameZh) === normZh(b.nameZh)) || a.names.some((n) => b.names.some((m) => sameNameTokens(n, m))))) a.flags.push(`possible_duplicate_of:${b.key}`);
    }
  }
  // M4：用工號連人嘅規則
  const link = (hkid: string | null, staffNo: string | null, nameZh: string | null): { p: Person; weak: boolean } | null => {
    const h = canonicalHkid(hkid ?? '');
    if (h && byHkid.has(h)) return { p: byHkid.get(h)!, weak: false };
    const s = cleanNo(staffNo);
    const c = s ? byStaff.get(s) : undefined;
    if (!c || c.length !== 1) return null;
    const p = c[0];
    if (h && p.hkid && h !== p.hkid) { p.flags.push('typed_row_hkid_conflict'); bump('typed_row_hkid_conflict'); return null; }
    const sameName = !!nameZh && !!p.nameZh && normZh(nameZh) === normZh(p.nameZh);
    return { p, weak: !sameName };
  };
  const mxOnly: Person[] = [];
  for (const r0 of typed.maxwell) {
    const r: Mx = { ...r0 };
    const l = link(r.hkid, r.staffNo, r.nameZh);
    if (l) { if (l.weak) { r.weak = true; l.p.flags.push('linked_by_staff_no_only'); } l.p.mx.push(r); continue; }
    if (!r.hkid && !r.nameEn && !r.nameZh) { bump('maxwell_empty_rows_skipped'); continue; }
    const h = canonicalHkid(r.hkid ?? '');
    const np: Person = { key: h ?? cleanNo(r.staffNo) ?? `mxrow:${r.ref.split(':').slice(1).join(':')}`, keyKind: h ? 'hkid' : r.staffNo ? 'staffNo' : 'internal', hasDocs: false, idx: null, docIds: [], staffNos: [cleanNo(r.staffNo)].filter((x): x is string => !!x), hkid: h, nameZh: r.nameZh, names: [r.nameEn].filter((x): x is string => !!x), mx: [r], ut: [], pe: [], fields: {}, flags: ['typed_list_only_person'], weakFields: new Set<string>() };
    mxOnly.push(np);
    if (h) byHkid.set(h, np);
    np.staffNos.forEach((s) => byStaff.set(s, [...(byStaff.get(s) ?? []), np]));
  }
  persons.push(...mxOnly);
  for (const r0 of typed.uteam) {
    const r: Ut = { ...r0 };
    const l = link(r.hkid, r.staffNo, r.nameZh);
    if (!l) continue;
    if (l.weak) { r.weak = true; l.p.flags.push('linked_by_staff_no_only'); }
    l.p.ut.push(r);
  }
  for (const p of persons) {
    for (const r of p.mx) if (!r.weak) { if (r.nameEn) p.names.push(r.nameEn); if (r.payee) p.names.push(r.payee); }
    for (const r of p.ut) if (!r.weak && r.nameEn) p.names.push(r.nameEn);
  }

  const ptLinked: Record<string, string[]> = {};
  let ptUnlinked = 0;
  for (const r of typed.parttime ?? []) {
    const l = link(r.hkid, r.staffNo, null);
    if (!l) { ptUnlinked++; continue; }
    const sn = cleanNo(r.staffNo);
    if (sn && !l.p.staffNos.includes(sn)) (ptLinked[l.p.key] ??= []).push(sn);
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
  const usedKeys = new Set(persons.map((p) => p.key));
  for (const e of peAccts.values()) {
    const hard = persons.filter((p) => [...p.mx, ...p.ut].some((r) => !r.weak && normAcct(r.acct) === e.acct) && p.names.some((n) => sameNameTokens(n, e.name)));
    if (hard.length === 1) { hard[0].pe.push({ ...e, how: 'hard_key' }); bump('pe_matched_hard'); continue; }
    if (hard.length > 1) { persons.filter((p) => hard.includes(p)).forEach((p) => p.flags.push('pe_multi_hard_match')); }
    const nameMatches = persons.filter((p) => p.names.some((n) => sameNameTokens(n, e.name)));
    if (nameMatches.length === 1) { nameMatches[0].pe.push({ ...e, how: 'name_only' }); bump('pe_matched_name_only'); continue; }
    let key = `pe:${e.code ?? 'xxx'}:${e.acct.slice(-4)}`;
    if (usedKeys.has(key)) { key = `pe:${e.code ?? 'xxx'}:${createHash('sha256').update(e.acct).digest('hex').slice(0, 10)}`; bump('pe_key_collision_resolved'); }
    usedKeys.add(key);
    const np: Person = { key, keyKind: 'internal', hasDocs: false, idx: null, docIds: [], staffNos: [], hkid: null, nameZh: null, names: [e.name], mx: [], ut: [], pe: [{ ...e, how: nameMatches.length ? 'name_ambiguous' : 'no_identity' }], fields: {}, flags: ['payroll_editor_only_person'], weakFields: new Set<string>() };
    peOnly.push(np);
    bump(nameMatches.length ? 'pe_name_ambiguous' : 'pe_no_identity');
  }
  persons.push(...peOnly);
  { // key 保證唯一
    const seen = new Set<string>();
    for (const p of persons) { let k = p.key; let n = 2; while (seen.has(k)) k = `${p.key}#${n++}`; if (k !== p.key) { p.key = k; p.keyKind = 'internal'; bump('key_collision_suffixed'); } seen.add(k); }
  }

  // ---- 讀數 → 候選 ----
  const permitOcr = new Map<string, { no: string | null; nos: string[]; to: Set<string> }>();
  async function ocrOfPermit(docId: string, page: number) {
    const k = `${docId}-p${page}`;
    if (permitOcr.has(k)) return permitOcr.get(k)!;
    const pages = (await fs.readFile(path.join(OUT, 'ocr', `${docId}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as OcrPage).filter((o) => !o.alt);
    const lines = pages.find((o) => o.page === page)?.lines ?? [];
    const txt = lines.map((l) => l.t).join(' ');
    const nos: string[] = [];
    for (const m of txt.matchAll(/[A-Z]{1,2}\s?-?\s?\d{6}\s?-?\s?[0-9A](?:\s?-\s?\d{3}(?!\d))?/g)) { const n = normPermitNo(m[0]); if (n && !nos.includes(n)) nos.push(n); }
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
  const telN = (raw: string | null | undefined) => normalizeTelHk(raw);

  for (const p of persons) {
    const C: Record<string, Cand[]> = {};
    const add = (f: string, src: SrcKind, v: string | null | undefined, weak = false) => { if (v) { (C[f] ??= []).push({ src, value: v }); if (weak) p.weakFields.add(f); } };
    const hireBy = new Map<string, Cand[]>();
    const hireWeak = new Set<string>();
    const addHire = (sn: string | null, src: SrcKind, v: string | null, weak = false) => { const k = sn ?? '?'; if (v) { hireBy.set(k, [...(hireBy.get(k) ?? []), { src, value: v }]); if (weak) hireWeak.add(k); } };
    const units: EmUnit[] = [];
    const permitC: { src: SrcKind; prefix: string; serial: string | null; full: string }[] = [];
    const addPermit = (src: SrcKind, no: string | null, weak = false) => { if (!no) return; const sp = splitPermit(no); permitC.push({ src, ...sp, full: no }); if (weak) p.weakFields.add('siaPermitNo'); };
    // 打字名單
    for (const r of p.mx) {
      const w = !!r.weak;
      const pn = normPermitNo(r.sppNo);
      if (r.sppNo && !pn) p.flags.push('typed_permit_no_format');
      addPermit('typed_maxwell', pn, w);
      add('siaPermitAExpiry', 'typed_maxwell', dates(r.sppA), w); add('siaPermitBExpiry', 'typed_maxwell', dates(r.sppB), w);
      const q = dates(r.qas);
      if (q) add(q <= TODAY ? 'qasIssueDate' : 'qasExpiryDate', 'typed_maxwell', q, w);
      add('safetyCardExpiry', 'typed_maxwell', dates(r.green), w);
      addHire(cleanNo(r.staffNo), 'typed_maxwell', dates(r.join), w);
      const [en, er, et] = r.emergency;
      if (en || et) units.push({ typed: true, weak: w, items: [{ src: 'typed_maxwell', name: en, rel: er, tel: et }] });
    }
    for (const r of p.ut) {
      const w = !!r.weak;
      addHire(cleanNo(r.staffNo), 'typed_uteam', dates(r.join), w);
      const [en, er, et] = r.emergency;
      if (en || et) units.push({ typed: true, weak: w, items: [{ src: 'typed_uteam', name: en, rel: er, tel: et }] });
    }
    // 視覺讀數＋OCR
    const staffForm: string[] = [];
    for (const docId of p.docIds) {
      for (const t of tasks.filter((x) => x.id.startsWith(`${docId}-`))) {
        const reads: [SrcKind, ReadMap[string] | undefined][] = [[t.handwritten ? 'hand_read1' : 'printed_read1', first[t.id]], [t.handwritten ? 'hand_read2' : 'printed_read2', second[t.id]]];
        if (t.spec === 'permit_card') {
          const o = await ocrFor(t.id, docId, Number(/-p(\d+)-/.exec(t.id)![1]));
          for (const n of o.nos) addPermit('printed_ocr', n);
          for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry']) o.to.forEach((d) => { (C[`${f}__ocrset`] ??= []).push({ src: 'printed_ocr', value: d }); });
        }
        const handUnits: EmUnit[] = [{ typed: false, weak: false, items: [] }, { typed: false, weak: false, items: [] }];
        for (const [src, rd] of reads) {
          if (!rd || rd.legible === 'illegible') continue;
          const f: Record<string, string | null> = { ...rd.fields };
          for (const u of rd.unsure ?? []) { f[u] = null; p.flags.push('some_fields_unsure'); } // 欄位級睇唔清：唔入候選
          if (rd.legible === 'unsure') { p.flags.push('some_reads_unsure'); continue; } // 睇唔清唔入候選（唔估）
          if (f.permit_no && src.startsWith('hand') && isCardControlNo(f.permit_no)) { p.flags.push('permit_no_is_card_control_no'); f.permit_no = null; }
          const pn = f.permit_no ? normPermitNo(f.permit_no) : null;
          if (f.permit_no && !pn) p.flags.push('permit_no_read_format_invalid');
          addPermit(src, pn);
          add('siaPermitAExpiry', src, dates(f.exp_a ?? f.a_to)); add('siaPermitBExpiry', src, dates(f.exp_b ?? f.b_to));
          add('siaPermitCExpiry', src, dates(f.exp_c ?? f.c_to)); add('siaPermitDExpiry', src, dates(f.exp_d ?? f.d_to));
          add('qasIssueDate', src, dates(f.qas_issue)); add('qasExpiryDate', src, dates(f.qas_expiry));
          add('safetyCardNo', src, f.green_no ? f.green_no.toUpperCase().replace(/\s+/g, '') : null); add('safetyCardExpiry', src, dates(f.green_expiry));
          addHire(cleanNo(index.get(docId)?.staffNo), src, dates(f.join));
          if (f.staff_no) staffForm.push(cleanNo(f.staff_no)!);
          [1, 2].forEach((s) => {
            const nm = f[`em${s}_name`], tl = f[`em${s}_tel`], rl = f[`em${s}_rel`];
            if (nm || tl) handUnits[s - 1].items.push({ src, name: nm ?? null, rel: rl ?? null, tel: tl ?? null });
          });
        }
        units.push(...handUnits.filter((u) => u.items.length));
      }
    }
    for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry']) {
      const set = (C[`${f}__ocrset`] ?? []).map((c) => c.value);
      delete C[`${f}__ocrset`];
      for (const c of [...(C[f] ?? [])]) if ((c.src === 'printed_read1' || c.src === 'printed_read2') && set.includes(c.value)) add(f, 'printed_ocr', c.value);
    }

    const F = p.fields;
    if (ptLinked[p.key]) F.extraStaffNosFromParttimeList = ptLinked[p.key];
    const weakDemote = (name: string, f: FieldOut): FieldOut => (p.weakFields.has(name) && f.status !== 'missing' ? { ...f, status: 'review', reasons: [...new Set([...f.reasons, 'linked_by_staff_no_only'])] } : f);

    // B1：牌照號碼＝前段（＝身份證號）＋序號，分開判斷
    {
      let cs = permitC;
      if (p.hkid && cs.some((c) => permitMatchesHkid(c.prefix, p.hkid))) {
        const kept = cs.filter((c) => permitMatchesHkid(c.prefix, p.hkid));
        if (kept.length < cs.length) p.flags.push('permit_no_candidates_discarded_not_matching_hkid');
        cs = kept;
      }
      const pre = resolveField(cs.map((c) => ({ src: c.src, value: c.prefix })), { validate: (v) => (p.hkid && !permitMatchesHkid(v, p.hkid) ? 'permit_no_not_matching_hkid' : null) });
      const grp = new Map<string, Set<string>>();
      cs.forEach((c) => { grp.set(c.full, new Set([...(grp.get(c.full) ?? []), c.src])); });
      const candidates = [...grp.entries()].map(([value, srcs]) => ({ value, sources: [...srcs] }));
      let out: FieldOut = { ...pre, candidates };
      if (pre.value && pre.status !== 'missing') {
        const cls = (s: SrcKind) => (s === 'printed_ocr' ? 'ocr' : s === 'printed_read1' ? 'read1' : s === 'printed_read2' ? 'read2' : null);
        const printed = new Map<string, Set<string>>();
        cs.filter((c) => c.serial && cls(c.src)).forEach((c) => printed.set(c.serial!, new Set([...(printed.get(c.serial!) ?? []), cls(c.src)!])));
        const anySerial = cs.some((c) => c.serial);
        const agreed = [...printed.entries()].filter(([, v]) => v.size >= 2);
        const typedSerials = new Set(cs.filter((c) => c.src === 'typed_maxwell' && c.serial).map((c) => c.serial!));
        if (agreed.length === 1 && printed.size === 1) out = { ...out, value: `${pre.value}-${agreed[0][0]}` };
        else if (typedSerials.size === 1 && [...printed.keys()].every((k) => typedSerials.has(k))) out = { ...out, value: `${pre.value}-${[...typedSerials][0]}`, reasons: [...pre.reasons, 'permit_serial_from_typed_list'] };
        else if (!anySerial) out = { ...out, reasons: [...pre.reasons, 'permit_no_without_serial'] };
        else out = { ...out, value: null, status: 'review', reasons: [...pre.reasons, 'permit_serial_unverified'] };
      }
      F.siaPermitNo = applyHandRules(weakDemote('siaPermitNo', out), { unverified: true });
    }
    for (const f of ['siaPermitAExpiry', 'siaPermitBExpiry', 'siaPermitCExpiry', 'siaPermitDExpiry', 'safetyCardExpiry', 'qasExpiryDate']) F[f] = applyHandRules(weakDemote(f, resolveField(C[f] ?? [], { validate: (v) => (expiryInRange(v) ? null : 'date_out_of_range') })), { unverified: true });
    F.qasIssueDate = applyHandRules(weakDemote('qasIssueDate', resolveField(C.qasIssueDate ?? [], { validate: (v) => (issueInRange(v) ? null : 'date_out_of_range') })), { unverified: true });
    F.safetyCardNo = applyHandRules(weakDemote('safetyCardNo', resolveField(C.safetyCardNo ?? [])), { unverified: true });
    {
      // 入職日期掛喺每個工號行（老闆 2026-09-19）：逐工號 resolve；人層面取最早，來源註明
      const isHandOnly = (cs: Cand[]) => cs.every((c) => c.src === 'hand_read1' || c.src === 'hand_read2');
      for (const [k, cs] of [...hireBy.entries()]) {
        if (hireBy.size > 1 && isHandOnly(cs)) {
          const tgt = [...hireBy.entries()].find(([k2, c2]) => k2 !== k && !isHandOnly(c2) && cs.every((c) => c2.some((x) => x.value === c.value)));
          if (tgt) { hireBy.set(tgt[0], [...tgt[1], ...cs]); hireBy.delete(k); }
        }
      }
      const rows = [...hireBy.entries()].map(([sn, cs]) => {
        let fld = applyHandRules(applyHandRules(resolveField(cs, { validate: (v) => (joinInRange(v) ? null : 'date_out_of_range') }), { date: true }), { unverified: true });
        const extra: string[] = [];
        if (hireWeak.has(sn)) extra.push('linked_by_staff_no_only');
        if (sharedStaff.has(sn)) extra.push('filename_staff_no_shared');
        if (extra.length && fld.status !== 'missing') fld = { ...fld, status: 'review', reasons: [...new Set([...fld.reasons, ...extra])] };
        return { staffNo: sn, field: fld };
      });
      F.staffNumbers = rows.map((r) => ({ staffNo: r.staffNo, hireDate: r.field }));
      const vals = rows.flatMap((r) => r.field.candidates.map((c) => ({ v: c.value, src: c.sources })));
      const earliest = vals.length ? vals.reduce((a, b) => (b.v < a.v ? b : a)) : null;
      const rowReview = rows.filter((r) => r.field.status === 'review');
      const mapReason = (x: string) => (x === 'sources_disagree' ? 'staff_no_row_sources_disagree' : x);
      const earliestHand = !!earliest && isPureHand(earliest.src);
      F.hireDate = !earliest ? { value: null, status: 'missing', candidates: [], sources: [], reasons: [] } : { value: earliest.v, status: rowReview.length || earliestHand ? 'review' : 'confirmed', candidates: vals.map((x) => ({ value: x.v, sources: x.src })), sources: [...new Set(vals.flatMap((x) => x.src))], reasons: [...new Set([...(earliestHand ? ['handwritten_unverified'] : []), ...(rows.length > 1 ? ['earliest_of_staff_numbers'] : []), ...rowReview.flatMap((r) => r.field.reasons.map(mapReason)), ...rows.flatMap((r) => r.field.reasons.filter((x) => x === 'typed_list_only'))])] } satisfies FieldOut;
    }
    {
      const ex = ['siaPermitAExpiry', 'siaPermitBExpiry', 'siaPermitCExpiry', 'siaPermitDExpiry'] as const;
      const letters = ex.map((f, i) => ((F[f] as FieldOut).value ? 'ABCD'[i] : '')).join('');
      const states = ex.map((f) => (F[f] as FieldOut)).filter((x) => x.value || x.status === 'review');
      F.siaPermitTypes = { value: letters || null, status: !states.length ? 'missing' : states.every((x) => x.status === 'confirmed') ? 'confirmed' : 'review', candidates: [], sources: [], reasons: ['derived_from_expiry_fields'] } satisfies FieldOut;
    }
    // M1：緊急聯絡人陣列（多值全部保留，上限 4）
    {
      const nz = (s: string | null | undefined) => normZh(s ?? '');
      const unitTels = (u: EmUnit) => new Set(u.items.map((i) => telN(i.tel)).filter((x): x is string => !!x));
      const unitNames = (u: EmUnit) => new Set(u.items.map((i) => nz(i.name)).filter(Boolean));
      const inter = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));
      const same = (a: EmUnit, b: EmUnit) => {
        const ta = unitTels(a), tb = unitTels(b);
        if (inter(ta, tb)) return true;
        if (a.items.every((i) => i.src === 'typed_maxwell') && b.items.every((i) => i.src === 'typed_maxwell') && inter(unitNames(a), unitNames(b))) return true; // 同一份 Maxwell 名單兩個分頁嘅同名聯絡人：合併，電話唔同 → 電話欄 review
        return inter(unitNames(a), unitNames(b)) && !(ta.size && tb.size);
      };
      const clusters: EmUnit[][] = [];
      for (const u of [...units.filter((x) => x.typed), ...units.filter((x) => !x.typed)]) {
        const c = clusters.find((cl) => cl.some((m) => same(m, u)));
        if (c) c.push(u); else clusters.push([u]);
      }
      if (clusters.length > 4) { p.flags.push('emergency_more_than_four'); bump('emergency_more_than_four'); }
      F.emergencyContacts = clusters.slice(0, 4).map((cl) => {
        const items = cl.flatMap((u) => u.items);
        const mk = (pick: (i: EmItem) => string | null, norm: (s: string) => string | null, validate?: (v: string) => string | null) =>
          resolveField(items.flatMap((i) => { const raw = pick(i); const n = raw ? norm(raw) : null; return n ? [{ src: i.src, value: n }] : []; }), { validate });
        let name = mk((i) => i.name, (s) => normZh(s) || null);
        let relationship = mk((i) => i.rel, (s) => normZh(s) || null);
        let tel = mk((i) => i.tel, (s) => telN(s), (v) => (normTelHkStrict(v) ? null : 'tel_not_hk_format'));
        if (cl.some((u) => u.weak)) {
          const dem = (f: FieldOut): FieldOut => (f.status === 'missing' ? f : { ...f, status: 'review', reasons: [...new Set([...f.reasons, 'linked_by_staff_no_only'])] });
          name = dem(name); relationship = dem(relationship); tel = dem(tel);
        }
        return { name, relationship, tel, sources: [...new Set(items.map((i) => i.src))] };
      });
    }
    // 員工編號對檔名
    const uniq = [...new Set(staffForm)];
    F.staffNoCheck = !p.docIds.length ? null : !uniq.length ? { status: 'form_blank_or_unread', formValues: [], fileStaffNos: p.staffNos } : uniq.every((s) => p.staffNos.includes(s)) ? { status: 'match', formValues: uniq, fileStaffNos: p.staffNos } : { status: 'mismatch', formValues: uniq, fileStaffNos: p.staffNos };
    if ((F.staffNoCheck as { status: string } | null)?.status === 'mismatch') {
      for (const v of uniq.filter((x) => !p.staffNos.includes(x))) for (const o of byStaff.get(v) ?? []) if (o !== p) p.flags.push(`staff_no_form_belongs_to_other_person:${o.key}`);
    }
    // 銀行（Payroll Editor 為主）
    const bankCopy = p.docIds.flatMap((d) => tasks.filter((t) => t.id.startsWith(`${d}-`) && t.spec === 'bank_page')).map((t) => ({ id: t.id, r1: first[t.id], r2: second[t.id] }));
    const copyAccts = bankCopy.flatMap((b) => [b.r1, b.r2]).filter((r) => r && r.legible === 'clear' && !(r.unsure ?? []).includes('acct')).map((r) => normAcct(r!.fields.acct)).filter((x): x is string => !!x);
    const peUnique = [...new Map(p.pe.map((e) => [e.acct, e])).values()];
    const e = peUnique[0];
    const mxAcct = p.mx.filter((r) => !r.weak).map((r) => normAcct(r.acct)).find(Boolean) ?? null;
    const utAcct = p.ut.filter((r) => !r.weak).map((r) => normAcct(r.acct)).find(Boolean) ?? null;
    const bankOut = (value: string | null, status: FieldOut['status'], reasons: string[], sources: string[], candidates: FieldOut['candidates'] = []): FieldOut => ({ value, status, candidates, sources, reasons });
    if (peUnique.length > 1) {
      p.flags.push('pe_multiple_accounts');
      for (const f of ['bankAccountNo', 'bankCode', 'bankName', 'bankPayeeName']) F[f] = bankOut(null, 'review', ['pe_multiple_accounts'], ['typed_pe'], peUnique.map((x) => ({ value: f === 'bankAccountNo' ? x.acct : f === 'bankCode' ? (x.code ?? '') : x.name, sources: ['typed_pe'] })));
    } else if (e) {
      const hard = e.how === 'hard_key';
      const reasons: string[] = hard ? [] : [e.how === 'name_only' ? 'bank_identity_name_only' : e.how === 'name_ambiguous' ? 'bank_identity_name_ambiguous' : 'bank_identity_unknown'];
      const src = ['typed_pe', ...(hard && (mxAcct === e.acct) ? ['typed_maxwell'] : []), ...(hard && (utAcct === e.acct) ? ['typed_uteam'] : [])];
      if (copyAccts.length) {
        const kinds = copyAccts.map((a) => acctAgreeKind(a, e.acct, e.code));
        reasons.push(kinds.every((k) => k !== 'no') ? (kinds.some((k) => k === 'nobranch') ? 'bank_copy_agrees_without_branch' : 'bank_copy_agrees') : 'bank_copy_disagrees');
      }
      if (mxAcct && mxAcct !== e.acct) reasons.push('maxwell_acct_differs');
      const ok = hard && !reasons.some((r) => r.endsWith('disagrees') || r.endsWith('differs'));
      const code = e.code ? e.code.padStart(3, '0') : null;
      const cands = (v: string) => [{ value: v, sources: src }];
      F.bankAccountNo = bankOut(e.acct, ok ? 'confirmed' : 'review', reasons, src, cands(e.acct));
      F.bankCode = bankOut(code, ok && code && bankByCode(code) ? 'confirmed' : 'review', [...reasons, ...(code && !bankByCode(code) ? ['bank_code_not_in_hkicl_table'] : [])], src, code ? cands(code) : []);
      const bn = code ? bankByCode(code) : null;
      F.bankName = bankOut(bn ? bn.nameZhShort : null, bn && ok ? 'confirmed' : 'review', [...reasons, 'bank_name_derived_from_code'], src);
      const payeeOk = !p.mx.some((r) => !r.weak && r.payee && !sameNameTokens(r.payee, e.name));
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
    if (vn && o.nos.length) { agree.permitNo.both++; if (o.nos.some((x) => splitPermit(x).prefix === splitPermit(vn).prefix)) agree.permitNo.same++; }
    for (const k of ['a_to', 'b_to', 'c_to', 'd_to']) {
      const dv = rd.fields[k] && !(rd.unsure ?? []).includes(k) ? normDate(rd.fields[k]) : null;
      if (dv && o.to.size) { agree.toDates.both++; if (o.to.has(dv)) agree.toDates.same++; }
    }
  }
  {
    let both = 0, same = 0, sBoth = 0, sSame = 0;
    for (const t of tasks.filter((x) => x.spec === 'permit_card')) {
      const a = first[t.id], b = second[t.id];
      if (!a || !b || a.legible === 'illegible' || b.legible === 'illegible') continue;
      const na = a.fields.permit_no && !(a.unsure ?? []).includes('permit_no') ? normPermitNo(a.fields.permit_no) : null;
      const nb = b.fields.permit_no && !(b.unsure ?? []).includes('permit_no') ? normPermitNo(b.fields.permit_no) : null;
      if (na && nb) { both++; if (splitPermit(na).prefix === splitPermit(nb).prefix) same++; if (splitPermit(na).serial || splitPermit(nb).serial) { sBoth++; if (splitPermit(na).serial === splitPermit(nb).serial) sSame++; } }
    }
    summaryFlags.read1_vs_opus_permitPrefix_both = both; summaryFlags.read1_vs_opus_permitPrefix_same = same;
    summaryFlags.read1_vs_opus_permitSerial_both = sBoth; summaryFlags.read1_vs_opus_permitSerial_same = sSame;
  }
  summaryFlags.ocr_vs_vision_permitNo_both = agree.permitNo.both; summaryFlags.ocr_vs_vision_permitNo_same = agree.permitNo.same;
  summaryFlags.ocr_vs_vision_toDates_both = agree.toDates.both; summaryFlags.ocr_vs_vision_toDates_same = agree.toDates.same;

  // ---- 輸出 ----
  const out = persons.map((p, i) => ({ internalId: `p${String(i).padStart(3, '0')}`, key: p.key, keyKind: p.keyKind, hasDocs: p.hasDocs, docIds: p.docIds, staffNos: p.staffNos, typedSources: { maxwell: p.mx.length, uteam: p.ut.length, payrollEditor: p.pe.length }, flags: [...new Set(p.flags)], fields: p.fields }));
  await fs.writeFile(path.join(FIELDS_OUT, 'person-fields-ext.json'), JSON.stringify(out, null, 1));
  // summary（只有計數）
  const groupsOf = (pred: (p: Person) => boolean) => out.filter((_, i) => pred(persons[i]));
  const isStatus = (x: unknown): x is FieldOut => !!x && typeof x === 'object' && ['confirmed', 'review', 'missing'].includes((x as FieldOut).status) && 'reasons' in (x as object);
  const fieldNames = [...new Set(out.flatMap((o) => Object.keys(o.fields)))].filter((f) => out.some((o) => isStatus(o.fields[f])));
  const stat = (arr: typeof out) => Object.fromEntries(fieldNames.map((f) => {
    const c = { confirmed: 0, review: 0, missing: 0 } as Record<string, number>;
    arr.forEach((o) => { const x = o.fields[f]; if (isStatus(x)) c[x.status]++; });
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
  type Em = { name: FieldOut; relationship: FieldOut; tel: FieldOut };
  const emConfirmed = (c: Em) => [c.name, c.tel].some((f) => f.status !== 'missing') && [c.name, c.tel].every((f) => f.status !== 'review') && [c.name, c.relationship, c.tel].every((f) => f.status !== 'review');
  const emStat = (arr: typeof out) => {
    let contacts = 0, confirmedContacts = 0, personsWithContact = 0, personsWithConfirmed = 0;
    arr.forEach((o) => { const cs = (o.fields.emergencyContacts as Em[] | undefined) ?? []; contacts += cs.length; const k = cs.filter(emConfirmed).length; confirmedContacts += k; if (cs.length) personsWithContact++; if (k) personsWithConfirmed++; });
    return { personsWithContact, personsWithConfirmedContact: personsWithConfirmed, contactsTotal: contacts, contactsConfirmed: confirmedContacts };
  };
  // reason 人數 ＋ 純手寫清單
  const reasonPersons: Record<string, number> = {};
  const hwUnverified: Record<string, string[]> = {};
  const hwDate: Record<string, string[]> = {};
  out.forEach((o) => {
    const rs = new Set<string>();
    const visit = (name: string, f: unknown) => {
      if (!isStatus(f)) return;
      f.reasons.forEach((r) => rs.add(r));
      if (f.reasons.includes('handwritten_unverified')) (hwUnverified[name] ??= []).push(o.internalId);
      if (f.reasons.includes('handwritten_date_ambiguous')) (hwDate[name] ??= []).push(o.internalId);
    };
    for (const [k, v] of Object.entries(o.fields)) {
      if (k === 'emergencyContacts') (v as Em[]).forEach((c) => { visit(k, c.name); visit(k, c.relationship); visit(k, c.tel); });
      else if (k === 'staffNumbers') (v as { hireDate: FieldOut }[]).forEach((r) => visit(k, r.hireDate));
      else visit(k, v);
    }
    rs.forEach((r) => (reasonPersons[r] = (reasonPersons[r] ?? 0) + 1));
    o.flags.forEach((f) => { const k = `flag:${f.split(':')[0]}`; reasonPersons[k] = (reasonPersons[k] ?? 0) + 1; });
  });
  await fs.writeFile(path.join(FIELDS_OUT, 'handwritten-unverified.json'), JSON.stringify({
    counts: { handwritten_unverified: Object.fromEntries(Object.entries(hwUnverified).map(([k, v]) => [k, v.length])), handwritten_date_ambiguous: Object.fromEntries(Object.entries(hwDate).map(([k, v]) => [k, v.length])) },
    keys: { handwritten_unverified: hwUnverified, handwritten_date_ambiguous: hwDate },
  }, null, 1));
  const summary = {
    emergencyContacts: { allPersons: emStat(out), withDocs: emStat(groupsOf((p) => p.hasDocs)), typedListOnly: emStat(groupsOf((p) => p.flags.includes('typed_list_only_person'))), payrollEditorOnly: emStat(groupsOf((p) => p.flags.includes('payroll_editor_only_person'))) },
    reasonPersons,
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
