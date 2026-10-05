// WP-STAFF-FIELDS 第二階段：由 v2 導入包（327 人）＋ person-fields-ext.json ＋ typed-sources.json 砌 v3 包。
// 純函數（唔讀檔、唔印值）；輸入容忍欄位唔存在／舊格式。console 只准印計數（見 17-build-package-v3.ts）。
import { createHash } from 'node:crypto';
import { HKICL_BANK_CODE_SET, HKICL_BANK_OPTIONS } from '@/lib/longterm-payroll/hkicl-bank-codes';
import { canonicalHkid } from '@/lib/guards/identity';
import { importPackageSchemaV3, packagePersonSchema, unassignedBankAccountSchema } from '@/lib/guards/import/package';

type St = 'confirmed' | 'review' | 'missing';
type Leaf = { value: string | null; status: St };
interface ExtField { value?: string | null; status?: string; reasons?: string[]; sources?: string[] }
export interface ExtPerson {
  docIds?: string[];
  key: string;
  keyKind?: string;
  hasDocs?: boolean;
  staffNos?: string[];
  flags?: string[];
  fields?: Record<string, unknown>;
}
export interface V2Person { key: string; hkid: Leaf; nameZh: Leaf; nameEn: Leaf; staffNumbers: { scheme: string; number: string }[]; [k: string]: unknown }
export interface V2Package { version: 2; generatedAt: string; persons: V2Person[] }
export interface TypedSources {
  maxwell?: { staffNo?: string | null; nameEn?: string | null; nameZh?: string | null; hkid?: string | null }[];
  uteam?: { staffNo?: string | null; nameEn?: string | null; nameZh?: string | null; hkid?: string | null }[];
}

const MISSING: Leaf = { value: null, status: 'missing' };
const cleanNo = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, '') || null;
// 減題規則（主規劃 2026-10-05）：以下 reason 一律唔入包、唔出題，只入 unverified-report（內部 key＋欄名＋reason，冇值）
const DROP_REASONS = ['handwritten_unverified', 'handwritten_date_ambiguous', 'permit_serial_unverified'];
// review 狀態要「畫面上人可以直接決定」先入包出題
const REVIEW_OK = ['staff_no_row_sources_disagree', 'linked_by_staff_no_only', 'filename_staff_no_shared', 'typed_row_hkid_conflict'];
const isBankReason = (r: string) => r.startsWith('bank_') || r === 'pe_multiple_accounts' || r.endsWith('_differs');
export interface UnverifiedRow { person: string; field: string; reason: string }

export interface BuildCounts {
  persons_total: number;
  persons_with_docs: number;
  persons_typed_only: number;
  ext_joined: number;
  ext_not_joined_docs: number;
  unassigned_bank: number;
  unassigned_dropped: number;
  leaves_skipped_handwritten_unverified: number;
  leaves_not_decidable_review: number;
  bank_copy_only_skipped: number;
  bank_review_pe_persons: number;
  join_by_index: number;
  join_fallback: number;
  join_failed: number;
  leaves_dropped_invalid: number;
  identity_check_persons: number;
  typed_only_no_identity_skipped: number;
  by_field: Record<string, Record<St, number>>;
}

export interface BuildOpts {
  /** person-fields.json 每人嘅 docIds（次序同 v2.persons 一致）：按次序 join 時逐對核對 docIds 集合；冇提供就唔做次序 join（只按 key join） */
  v2DocIds?: string[][];
  now?: Date;
}
export function buildPackageV3(v2: V2Package, ext: ExtPerson[], typed: TypedSources, opts: BuildOpts | Date = {}) {
  const o: BuildOpts = opts instanceof Date ? { now: opts } : opts;
  const now = o.now ?? new Date();
  const counts: BuildCounts = {
    persons_total: 0, persons_with_docs: 0, persons_typed_only: 0, ext_joined: 0, ext_not_joined_docs: 0, unassigned_bank: 0, unassigned_dropped: 0,
    leaves_skipped_handwritten_unverified: 0, leaves_not_decidable_review: 0, bank_copy_only_skipped: 0, bank_review_pe_persons: 0, join_by_index: 0, join_fallback: 0, join_failed: 0, leaves_dropped_invalid: 0, identity_check_persons: 0, typed_only_no_identity_skipped: 0, by_field: {},
  };
  const tally = (name: string, l: Leaf) => {
    const c = (counts.by_field[name] ??= { confirmed: 0, review: 0, missing: 0 });
    c[l.status] += 1;
  };

  const report: UnverifiedRow[] = [];
  let curPerson = '';
  type Kind = 'plain' | 'bank' | 'emergency';
  const leafOf = (f: unknown, field = '?', kind: Kind = 'plain'): Leaf => {
    const x = f as ExtField | null | undefined;
    if (!x || x.status === 'missing' || (x.status !== 'confirmed' && x.status !== 'review')) return MISSING;
    const reasons = x.reasons ?? [];
    const drop = reasons.find((r) => DROP_REASONS.includes(r));
    if (drop) {
      if (x.value || x.status === 'review') {
        counts.leaves_skipped_handwritten_unverified += 1;
        report.push({ person: curPerson, field, reason: drop });
      }
      return MISSING;
    }
    if (!x.value) {
      if (x.status === 'review') {
        counts.leaves_not_decidable_review += 1;
        report.push({ person: curPerson, field, reason: reasons.find((r) => r === 'sources_disagree') ?? 'review_without_candidate' });
      }
      return MISSING;
    }
    if (x.status === 'review') {
      const ok = kind === 'bank' ? reasons.some(isBankReason) : reasons.some((r) => REVIEW_OK.includes(r)) || (kind === 'emergency' && reasons.includes('sources_disagree'));
      if (!ok) {
        counts.leaves_not_decidable_review += 1;
        report.push({ person: curPerson, field, reason: reasons.find((r) => !['typed_list_only'].includes(r)) ?? 'review_unspecified' });
        return MISSING;
      }
    }
    return { value: String(x.value), status: x.status };
  };

  const byHkid = new Map<string, ExtPerson>();
  const byNo = new Map<string, ExtPerson[]>();
  for (const e of ext) {
    if (e.hasDocs === false || e.keyKind === 'internal') continue;
    const h = canonicalHkid(e.key);
    if (h) byHkid.set(h, e);
    for (const n of e.staffNos ?? []) byNo.set(cleanNo(n)!, [...(byNo.get(cleanNo(n)!) ?? []), e]);
  }
  const used = new Set<ExtPerson>();

  const extFor = (p: V2Person): ExtPerson | null => {
    const h = canonicalHkid(p.hkid.value ?? '');
    if (h && byHkid.has(h)) return byHkid.get(h)!;
    const c = [...new Set(p.staffNumbers.flatMap((n) => byNo.get(cleanNo(n.number)!) ?? []))];
    return c.length === 1 ? c[0]! : null;
  };

  // 新欄 → v3 欄位物件（flags 降級：疑似重複／工號身份唔一致 → confirmed 全降 review）
  const extFields = (e: ExtPerson, staffNumbers: { scheme: string; number: string }[]) => {
    const F = (e.fields ?? {}) as Record<string, unknown>;
    const identityCheck = (e.flags ?? []).some((f) => f.startsWith('possible_duplicate_of:')) || (F.staffNoCheck as { status?: string } | undefined)?.status === 'mismatch';
    const L = (name: string, f: unknown, kind: Kind = 'plain'): Leaf => {
      let l = leafOf(f, name, kind);
      if (identityCheck && l.status === 'confirmed') l = { ...l, status: 'review' };
      tally(name, l);
      return l;
    };
    const out: Record<string, unknown> = {};
    const sia = { no: L('siaPermit.no', F.siaPermitNo), aExpiry: L('siaPermit.aExpiry', F.siaPermitAExpiry), bExpiry: L('siaPermit.bExpiry', F.siaPermitBExpiry), cExpiry: L('siaPermit.cExpiry', F.siaPermitCExpiry), dExpiry: L('siaPermit.dExpiry', F.siaPermitDExpiry) };
    out.siaPermit = sia;
    out.safetyCard = { no: L('safetyCard.no', F.safetyCardNo), expiry: L('safetyCard.expiry', F.safetyCardExpiry) };
    out.qas = { issueDate: L('qas.issueDate', F.qasIssueDate), expiryDate: L('qas.expiryDate', F.qasExpiryDate) };
    out.hireDate = L('hireDate', F.hireDate);
    // 銀行
    // 銀行只收 Payroll Editor 來源；淨係銀行卡／存摺副本（bank_copy_only）唔入包、唔出題
    const peSourced = ['bankAccountNo', 'bankCode', 'bankPayeeName'].some((k) => ((F[k] as ExtField | undefined)?.sources ?? []).includes('typed_pe'));
    const hasCopyOnly = ['bankAccountNo'].some((k) => ((F[k] as ExtField | undefined)?.reasons ?? []).includes('bank_copy_only'));
    if (!peSourced && hasCopyOnly) counts.bank_copy_only_skipped += 1;
    // Payroll Editor 過濾按欄：每隻欄自己嘅 sources 要含 typed_pe
    const B = (k: string) => (((F[k] as ExtField | undefined)?.sources ?? []).includes('typed_pe') ? leafOf(F[k], `bank.${k}`, 'bank') : MISSING);
    const code = B('bankCode');
    const rawCode = peSourced ? ((F.bankCode as ExtField | undefined)?.value ?? null) : null;
    const codeBad = !!rawCode && !HKICL_BANK_CODE_SET.has(String(rawCode).padStart(3, '0'));
    const okCode = code.value && !codeBad ? { ...code, value: code.value.padStart(3, '0') } : MISSING;
    let name = B('bankName');
    if (okCode.value && !name.value) name = { value: HKICL_BANK_OPTIONS.find((b) => b.code === okCode.value)?.nameZhShort ?? null, status: okCode.status };
    const bank = { code: okCode, name, accountNo: B('bankAccountNo'), payeeName: B('bankPayeeName') };
    // 銀行編號唔喺 HKICL 表：戶口照入包，但降 review（出 bank_review 俾人決定）
    if (codeBad && bank.accountNo.value) bank.accountNo = { ...bank.accountNo, status: 'review' };
    if (bank.accountNo.value && Object.values(bank).some((l) => l.status === 'review')) counts.bank_review_pe_persons += 1;
    for (const k of Object.keys(bank) as (keyof typeof bank)[]) if (identityCheck && bank[k].status === 'confirmed') bank[k] = { ...bank[k], status: 'review' };
    out.bank = bank;
    tally('bank', bank.accountNo);
    const bankReasons = !peSourced ? [] : [...new Set(['bankAccountNo', 'bankCode', 'bankPayeeName'].flatMap((k) => ((F[k] as ExtField | undefined)?.reasons ?? []).filter((r) => r.startsWith('bank_') || r.endsWith('_differs') || r === 'maxwell_payee_differs' || r === 'pe_multiple_accounts')))];
    // 緊急聯絡人：新格式 emergencyContacts[]（≤4），舊格式 emergency1/2Name…
    const arr = Array.isArray(F.emergencyContacts) ? (F.emergencyContacts as Record<string, unknown>[]) : [1, 2].map((i) => ({ name: F[`emergency${i}Name`], relationship: F[`emergency${i}Relationship`], tel: F[`emergency${i}Tel`] }));
    out.emergencyContacts = arr
      .slice(0, 4)
      .map((c, i) => ({ name: L(`emergency.${i + 1}.name`, c.name, 'emergency'), relationship: L(`emergency.${i + 1}.relationship`, c.relationship, 'emergency'), tel: L(`emergency.${i + 1}.tel`, c.tel, 'emergency') }))
      .filter((c) => c.name.value || c.tel.value);
    // 逐工號入職日期
    const hires = new Map<string, Leaf>();
    for (const r of (Array.isArray(F.staffNumbers) ? F.staffNumbers : []) as { staffNo?: string | null; hireDate?: unknown }[]) {
      const no = cleanNo(r.staffNo);
      if (no) hires.set(no, L('staffHire', r.hireDate));
    }
    const sn = staffNumbers.map((n) => {
      const h = hires.get(cleanNo(n.number)!);
      return h && h.value ? { ...n, hireDate: h } : { ...n };
    });
    return { fields: out, staffNumbers: sn, identityCheck, bankReasons };
  };

  // 驗證：每個 leaf 過 zod；唔過嘅 leaf 轉 missing（逐 leaf 試，計 dropped）
  const sanitize = (p: Record<string, unknown>): Record<string, unknown> => {
    let cur = p;
    for (let guard = 0; guard < 80; guard++) {
      const r = packagePersonSchema.safeParse(cur);
      if (r.success) return r.data as Record<string, unknown>;
      const path = r.error.issues[0]!.path;
      if (process.env.PKG_DEBUG) console.error('sanitize', guard, path.join('.'), r.error.issues[0]!.code);
      // 把出錯位置（leaf 本身，path 最後係 value/status 或 leaf 名）改成 missing leaf
      let target: unknown = cur;
      const leafPath = path.length && (path[path.length - 1] === 'value' || path[path.length - 1] === 'status') ? path.slice(0, -1) : path;
      const next = JSON.parse(JSON.stringify(cur));
      target = next;
      for (let i = 0; i < leafPath.length - 1; i++) target = (target as Record<string | number, unknown>)[leafPath[i] as string | number];
      const last = leafPath[leafPath.length - 1] as string | number;
      if (!target || !leafPath.length || typeof target !== 'object' || (target as Record<string | number, unknown>)[last] === undefined) throw new Error(`package-v3: 無法修復 ${path.join('.')}`);
      (target as Record<string | number, unknown>)[last] = MISSING;
      counts.leaves_dropped_invalid += 1;
      cur = next;
    }
    throw new Error(`package-v3: sanitize loop ${JSON.stringify(packagePersonSchema.safeParse(cur).error?.issues.slice(0, 3).map((i) => [i.path.join('.'), i.code]))}`);
  };

  const persons: Record<string, unknown>[] = [];
  // join：v2 包由 person-fields.json 逐個 map 出嚟，ext 有文件嗰批同一次序（docIds 一致）→ 先按次序 join，
  // 有 hkid 兩邊都有時要一致先認；否則退回 hkid／工號 join。
  const docsExt = ext.filter((e) => e.hasDocs === true);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;
  const pairHkidClash = (p: V2Person, cand: ExtPerson) => {
    const h = canonicalHkid(p.hkid.value ?? '');
    return !!h && cand.keyKind === 'hkid' && canonicalHkid(cand.key) !== h;
  };
  // 次序 join 只喺：長度一致、有 docIds 可核對、而且冇任何一對身份證對唔上 先用；任何一對身份證衝突 → 成批放棄，改用 key join
  let byIndex = !!o.v2DocIds && o.v2DocIds.length === v2.persons.length && docsExt.length === v2.persons.length;
  if (byIndex) byIndex = !v2.persons.some((p, i) => pairHkidClash(p, docsExt[i]!));
  for (const [pi, p] of v2.persons.entries()) {
    let e: ExtPerson | null = null;
    if (byIndex) {
      const cand = docsExt[pi]!;
      const h = canonicalHkid(p.hkid.value ?? '');
      const hkidOk = !!h && cand.keyKind === 'hkid' && canonicalHkid(cand.key) === h;
      const staffOk = p.staffNumbers.some((n) => (cand.staffNos ?? []).map(cleanNo).includes(cleanNo(n.number)));
      const docsOk = sameSet(o.v2DocIds![pi]!, (cand as { docIds?: string[] }).docIds ?? []);
      if (docsOk && (hkidOk || staffOk) && !used.has(cand)) {
        e = cand;
        counts.join_by_index += 1;
      } else {
        counts.join_failed += 1;
        curPerson = p.key;
        persons.push(sanitize({ ...p }));
        continue;
      }
    }
    if (!e) {
      e = extFor(p);
      if (e && !used.has(e)) counts.join_fallback += 1;
      else {
        e = null;
        counts.join_failed += 1;
      }
    }
    curPerson = p.key;
    const base: Record<string, unknown> = { ...p };
    delete base.conflicts;
    const conflicts = (p as { conflicts?: string[] }).conflicts;
    if (!e) {
      counts.ext_not_joined_docs += 1;
      persons.push(sanitize({ ...p, ...(conflicts ? { conflicts } : {}) }));
      continue;
    }
    used.add(e);
    counts.ext_joined += 1;
    const x = extFields(e, p.staffNumbers);
    const reasons = [...new Set([...(p.reasons as string[]), ...x.bankReasons, ...(x.identityCheck ? ['ext_identity_check'] : [])])].slice(0, 60);
    if (x.identityCheck) counts.identity_check_persons += 1;
    persons.push(sanitize({ ...base, staffNumbers: x.staffNumbers, reasons, ...(conflicts ? { conflicts } : {}), ...x.fields }));
    counts.persons_with_docs += 1;
  }

  // 只喺打字名單嘅人（hkid 或工號做 key）
  const typedRows = [...(typed.maxwell ?? []), ...(typed.uteam ?? [])];
  const unassigned: Record<string, unknown>[] = [];
  for (const e of ext) {
    if (used.has(e)) continue;
    if (e.key.startsWith('pe:') || (e.flags ?? []).includes('payroll_editor_only_person')) {
      const F = (e.fields ?? {}) as Record<string, unknown>;
      curPerson = e.key;
      const code = leafOf(F.bankCode, 'bank.bankCode', 'bank').value?.padStart(3, '0') ?? '';
      const acct = leafOf(F.bankAccountNo, 'bank.bankAccountNo', 'bank').value ?? '';
      const payee = leafOf(F.bankPayeeName, 'bank.bankPayeeName', 'bank').value ?? '';
      const cand = { key: e.key.slice(0, 64), bankCode: code, accountNo: acct, payeeName: payee };
      if (unassignedBankAccountSchema.safeParse(cand).success) {
        unassigned.push(cand);
        counts.unassigned_bank += 1;
      } else counts.unassigned_dropped += 1;
      continue;
    }
    if (e.hasDocs === true) {
      counts.ext_not_joined_docs += 1;
      continue;
    }
    if (e.keyKind === 'internal') {
      counts.typed_only_no_identity_skipped += 1; // 冇身份證／工號做 key，對唔到人，唔入包
      continue;
    }
    const hk = e.keyKind === 'hkid' ? canonicalHkid(e.key) : null;
    const nos = [...new Set((e.staffNos ?? []).map(cleanNo).filter((x): x is string => !!x))];
    if (e.keyKind === 'staffNo' && !nos.includes(cleanNo(e.key)!)) nos.push(cleanNo(e.key)!);
    const row = typedRows.find((r) => (hk && canonicalHkid(r.hkid ?? '') === hk) || (r.staffNo && nos.includes(cleanNo(r.staffNo)!)));
    const staffNumbers = nos.flatMap((n) => {
      const m = /^([A-Z]{1,4})\d[0-9A-Z-]{0,15}$/.exec(n);
      return m ? [{ scheme: m[1]!, number: n }] : [];
    });
    // 確定性 key（跨 build 穩定，令跨 session 去重認得）：來源檔類別＋身份證／工號
    const newKey = `typed:${createHash('sha256').update(`typed_list|${hk ?? nos[0] ?? e.key}`).digest('hex').slice(0, 12)}`;
    curPerson = newKey;
    const x = extFields(e, staffNumbers);
    // 打字名單唔係身份來源（§26.2）：hkid／姓名一律 review，唔會用嚟自動建人；只用嚟 link 現有安員
    const person = {
      key: newKey,
      hkid: hk ? { value: hk, status: 'review' as St } : MISSING,
      nameZh: row?.nameZh ? { value: row.nameZh, status: 'review' as St } : MISSING,
      nameEn: row?.nameEn ? { value: row.nameEn, status: 'review' as St } : MISSING,
      dateOfBirth: MISSING, sex: MISSING, phone: MISSING, address: { ...MISSING },
      staffNumbers: x.staffNumbers,
      rating: 'review',
      reasons: [...new Set(['typed_list_only_person', ...x.bankReasons, ...(x.identityCheck ? ['ext_identity_check'] : [])])],
      ...x.fields,
    };
    if (x.identityCheck) counts.identity_check_persons += 1;
    persons.push(sanitize(person));
    counts.persons_typed_only += 1;
  }
  counts.persons_total = persons.length;
  const pkg = { version: 3 as const, generatedAt: now.toISOString(), persons, ...(unassigned.length ? { unassignedBankAccounts: unassigned } : {}) };
  const parsed = importPackageSchemaV3.parse(pkg);
  return { pkg: parsed, counts, report };
}
