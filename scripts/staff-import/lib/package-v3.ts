// WP-STAFF-FIELDS 第二階段：由 v2 導入包（327 人）＋ person-fields-ext.json ＋ typed-sources.json 砌 v3 包。
// 純函數（唔讀檔、唔印值）；輸入容忍欄位唔存在／舊格式。console 只准印計數（見 17-build-package-v3.ts）。
import { randomUUID } from 'node:crypto';
import { HKICL_BANK_CODE_SET, HKICL_BANK_OPTIONS } from '@/lib/longterm-payroll/hkicl-bank-codes';
import { canonicalHkid } from '@/lib/guards/identity';
import { importPackageSchemaV3, packagePersonSchema, unassignedBankAccountSchema } from '@/lib/guards/import/package';

type St = 'confirmed' | 'review' | 'missing';
type Leaf = { value: string | null; status: St };
interface ExtField { value?: string | null; status?: string; reasons?: string[] }
export interface ExtPerson {
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
const SKIP_REASON = 'handwritten_unverified';

export interface BuildCounts {
  persons_total: number;
  persons_with_docs: number;
  persons_typed_only: number;
  ext_joined: number;
  ext_not_joined_docs: number;
  unassigned_bank: number;
  unassigned_dropped: number;
  leaves_skipped_handwritten_unverified: number;
  leaves_dropped_invalid: number;
  identity_check_persons: number;
  by_field: Record<string, Record<St, number>>;
}

export function buildPackageV3(v2: V2Package, ext: ExtPerson[], typed: TypedSources, now = new Date()) {
  const counts: BuildCounts = {
    persons_total: 0, persons_with_docs: 0, persons_typed_only: 0, ext_joined: 0, ext_not_joined_docs: 0, unassigned_bank: 0, unassigned_dropped: 0,
    leaves_skipped_handwritten_unverified: 0, leaves_dropped_invalid: 0, identity_check_persons: 0, by_field: {},
  };
  const tally = (name: string, l: Leaf) => {
    const c = (counts.by_field[name] ??= { confirmed: 0, review: 0, missing: 0 });
    c[l.status] += 1;
  };

  const leafOf = (f: unknown): Leaf => {
    const x = f as ExtField | null | undefined;
    if (!x || x.status === 'missing' || !x.value || (x.status !== 'confirmed' && x.status !== 'review')) return MISSING;
    if (x.reasons?.includes(SKIP_REASON)) {
      counts.leaves_skipped_handwritten_unverified += 1;
      return MISSING;
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
    const L = (name: string, f: unknown): Leaf => {
      let l = leafOf(f);
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
    const code = leafOf(F.bankCode);
    const okCode = code.value && HKICL_BANK_CODE_SET.has(code.value.padStart(3, '0')) ? { ...code, value: code.value.padStart(3, '0') } : MISSING;
    let name = leafOf(F.bankName);
    if (okCode.value && !name.value) name = { value: HKICL_BANK_OPTIONS.find((b) => b.code === okCode.value)?.nameZhShort ?? null, status: okCode.status };
    const bank = { code: okCode, name, accountNo: leafOf(F.bankAccountNo), payeeName: leafOf(F.bankPayeeName) };
    for (const k of Object.keys(bank) as (keyof typeof bank)[]) if (identityCheck && bank[k].status === 'confirmed') bank[k] = { ...bank[k], status: 'review' };
    out.bank = bank;
    tally('bank', bank.accountNo);
    const bankReasons = [...new Set(['bankAccountNo', 'bankCode', 'bankPayeeName'].flatMap((k) => ((F[k] as ExtField | undefined)?.reasons ?? []).filter((r) => r.startsWith('bank_') || r.endsWith('_differs') || r === 'maxwell_payee_differs')))];
    // 緊急聯絡人：新格式 emergencyContacts[]（≤4），舊格式 emergency1/2Name…
    const arr = Array.isArray(F.emergencyContacts) ? (F.emergencyContacts as Record<string, unknown>[]) : [1, 2].map((i) => ({ name: F[`emergency${i}Name`], relationship: F[`emergency${i}Relationship`], tel: F[`emergency${i}Tel`] }));
    out.emergencyContacts = arr
      .slice(0, 4)
      .map((c, i) => ({ name: L(`emergency.${i + 1}.name`, c.name), relationship: L(`emergency.${i + 1}.relationship`, c.relationship), tel: L(`emergency.${i + 1}.tel`, c.tel) }))
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
    throw new Error('package-v3: sanitize loop');
  };

  const persons: Record<string, unknown>[] = [];
  for (const p of v2.persons) {
    const e = extFor(p);
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
    if (e.keyKind === 'internal' || (e.flags ?? []).includes('payroll_editor_only_person')) {
      const F = (e.fields ?? {}) as Record<string, unknown>;
      const code = leafOf(F.bankCode).value?.padStart(3, '0') ?? '';
      const acct = leafOf(F.bankAccountNo).value ?? '';
      const payee = leafOf(F.bankPayeeName).value ?? '';
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
    const hk = e.keyKind === 'hkid' ? canonicalHkid(e.key) : null;
    const nos = [...new Set((e.staffNos ?? []).map(cleanNo).filter((x): x is string => !!x))];
    if (e.keyKind === 'staffNo' && !nos.includes(cleanNo(e.key)!)) nos.push(cleanNo(e.key)!);
    const row = typedRows.find((r) => (hk && canonicalHkid(r.hkid ?? '') === hk) || (r.staffNo && nos.includes(cleanNo(r.staffNo)!)));
    const staffNumbers = nos.map((n) => ({ scheme: n.match(/^[A-Z]+/)?.[0] ?? 'U', number: n })).filter((n) => /^[A-Z]{1,4}[0-9A-Z-]{1,16}$/.test(n.number));
    const x = extFields(e, staffNumbers);
    // 打字名單唔係身份來源（§26.2）：hkid／姓名一律 review，唔會用嚟自動建人；只用嚟 link 現有安員
    const person = {
      key: randomUUID(),
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
  return { pkg: parsed, counts };
}
