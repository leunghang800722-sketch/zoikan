// WP-STAFF-IMPORT B3：證件資料批量導入——預覽（唯讀）＋套用（寫入）。
//
// 設計（規劃者 Fable 5.1 + Opus 抽樣後定案）：
//  - 導入包唔帶 guard id；伺服器對自己個 DB 對齊（match.ts：hkid→工號→電話→姓名＋第二鍵）。
//  - **逐欄**狀態 confirmed／review／missing：自動套用淨寫 confirmed 欄；review 欄喺覆核頁
//    逐欄「確認／改正後確認／略過」先寫。
//  - link：淨補空欄，現值唔同＝該欄入 conflict 唔覆蓋（`replace` 決定先會覆蓋姓名／英文名／出生日期）。
//  - create：hkid 要 confirmed；nameZh 係 review 都照建（hkid＋電話先係識別鍵），喺
//    `guards.identity_review_fields` 記 name_zh，覆核頁顯示「姓名待核對」。
//  - 寫入 guards／guard_staff_numbers／guard_phones(source=application_form)／
//    guard_addresses(source=address_proof)，全部 writeAuditTx；冪等（重跑唔重複建）。
//  - 分批 transaction（每批 25 人，timeout 120s）；批內任何錯誤 → 該批逐人重試，壞嗰個記 error。
//  - 導入包本身**唔入 DB**：preview／apply 都係請求內處理，用完即棄（apply 要重新帶包）。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit, writeAuditTx } from "@/lib/audit";
import { ApiError } from "@/lib/api/errors";
import { canonicalHkid, hkidCheckDigitValid, assertTelAvailable } from "@/lib/guards/identity";
import { createGuardPhone, createGuardAddress, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import {
  upsertCurrentStaffNumber,
  syncLegacyStaffNoColumns,
  normalizeStaffNumber,
  deriveSiaPermitExpiry,
  canOverrideDerivedSiaPermit,
} from "@/lib/guards/staff-numbers";
import { buildDbIndex, decideMatch, type Action, type DbGuard, type DbIndex } from "./match";
import { fieldValue, hashPackage, packageConflicts, type ImportPackage, type PackagePerson, type PersonField } from "./package";
import { parseBirthDate, maskAddressImport, maskHkidImport, maskTelImport, normAddress, normTel8, normZh } from "./text";

type Tx = Prisma.TransactionClient;

export const IMPORT_BATCH_SIZE = 25;
const IMPORT_ADVISORY_LOCK_KEY = 7261003;
const IMPORT_TX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// 載入現有安員（對齊用）
// ---------------------------------------------------------------------------
interface GuardSnap {
  id: string;
  nameZh: string;
  nameEn: string | null;
  hkid: string | null;
  dateOfBirth: Date | null;
  siaPermitAExpiry: Date | null;
  siaPermitBExpiry: Date | null;
  identityReviewFields: string[];
  tels: string[];
  staffNumbers: { scheme: string; number: string; status: string }[];
  addresses: string[];
}

interface DbCtx {
  index: DbIndex;
  byId: Map<string, GuardSnap>;
}

async function loadCtx(db: Tx | typeof prisma): Promise<DbCtx> {
  const [guards, phones, nos, addrs] = await Promise.all([
    db.guard.findMany({
      select: { id: true, nameZh: true, nameEn: true, hkid: true, tel: true, dateOfBirth: true, siaPermitAExpiry: true, siaPermitBExpiry: true, identityReviewFields: true },
    }),
    db.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    db.guardStaffNumber.findMany({ select: { guardId: true, scheme: true, number: true, status: true } }),
    db.guardAddress.findMany({ select: { guardId: true, address: true } }),
  ]);
  const phoneBy = new Map<string, string[]>();
  for (const p of phones) phoneBy.set(p.guardId, [...(phoneBy.get(p.guardId) ?? []), p.tel]);
  const noBy = new Map<string, GuardSnap["staffNumbers"]>();
  for (const n of nos) noBy.set(n.guardId, [...(noBy.get(n.guardId) ?? []), { scheme: n.scheme, number: n.number, status: n.status }]);
  const addrBy = new Map<string, string[]>();
  for (const a of addrs) addrBy.set(a.guardId, [...(addrBy.get(a.guardId) ?? []), a.address]);

  const byId = new Map<string, GuardSnap>();
  const dbGuards: DbGuard[] = guards.map((g) => {
    const tels = [...new Set([...(phoneBy.get(g.id) ?? []), ...(g.tel ? [g.tel] : [])])];
    byId.set(g.id, {
      id: g.id,
      nameZh: g.nameZh,
      nameEn: g.nameEn,
      hkid: canonicalHkid(g.hkid),
      dateOfBirth: g.dateOfBirth,
      siaPermitAExpiry: g.siaPermitAExpiry,
      siaPermitBExpiry: g.siaPermitBExpiry,
      identityReviewFields: g.identityReviewFields,
      tels,
      staffNumbers: noBy.get(g.id) ?? [],
      addresses: addrBy.get(g.id) ?? [],
    });
    return { id: g.id, nameZh: g.nameZh, hkid: canonicalHkid(g.hkid), tels, staffNos: (noBy.get(g.id) ?? []).map((n) => n.number) };
  });
  return { index: buildDbIndex(dbGuards), byId };
}

// ---------------------------------------------------------------------------
// 單人評估（preview 同 apply 共用）
// ---------------------------------------------------------------------------
export type FieldCheck = "new" | "fill" | "same" | "differs" | "conflict" | "missing" | "not_stored" | "invalid_date";

export interface Evaluation {
  person: PackagePerson;
  action: Action;
  guardId: string | null;
  reasons: string[];
  hkidCanon: string | null;
  checks: Record<PersonField, FieldCheck>;
}

function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function evaluate(p: PackagePerson, ctx: DbCtx, groupReasons: readonly string[], dec?: PersonDecisions): Evaluation {
  const hkidCanon = canonicalHkid(fieldValue(p.hkid));
  const nameZh = fieldValue(p.nameZh);
  // 電話淨係 confirmed 先用嚟對齊（review 電話唔可靠，唔好用佢 link 人／觸發衝突）
  const phoneForMatch = p.phone.status === "confirmed" ? fieldValue(p.phone) : null;
  const d = decideMatch(
    {
      staffNos: p.staffNumbers.map((n) => n.number),
      hkid: hkidCanon,
      hkidValid: !!hkidCanon && hkidCheckDigitValid(hkidCanon),
      hkidConfirmed: p.hkid.status === "confirmed",
      nameZh,
      phone: phoneForMatch,
      grade: p.rating,
      gradeReasons: p.reasons,
    },
    ctx.index,
    groupReasons,
  );
  let { action } = d;
  const reasons = [...d.reasons];
  if (action === "create") {
    if (p.hkid.status !== "confirmed") {
      action = "needs_review";
      reasons.push("create_hkid_not_confirmed");
    } else if (!nameZh) {
      action = "needs_review";
      reasons.push("create_no_name");
    } else if (p.nameZh.status !== "confirmed") {
      // 自動套用淨寫 confirmed 欄，冇例外：姓名未確認唔自動建人；人手喺覆核頁確認／改正後確認／
      // 揀「照建但標待核對」之後（逐人 decisions 路徑）先建。
      const nd = dec?.nameZh;
      if (!nd || nd.action === "skip") {
        action = "needs_review";
        reasons.push("name_not_confirmed");
      }
    }
  }
  const g = d.guardId ? ctx.byId.get(d.guardId) ?? null : null;
  const checks = {} as Record<PersonField, FieldCheck>;
  const val = {
    hkid: hkidCanon,
    nameZh,
    nameEn: fieldValue(p.nameEn),
    dateOfBirth: fieldValue(p.dateOfBirth),
    sex: fieldValue(p.sex),
    phone: normTel8(fieldValue(p.phone)),
    address: fieldValue(p.address),
  };
  for (const f of ["hkid", "nameZh", "nameEn", "dateOfBirth", "sex", "phone", "address"] as const) {
    if (f === "sex") {
      checks.sex = val.sex ? "not_stored" : "missing";
      continue;
    }
    if (!val[f]) {
      checks[f] = "missing";
      continue;
    }
    if (f === "dateOfBirth" && !parseBirthDate(val.dateOfBirth)) {
      checks.dateOfBirth = "invalid_date";
      continue;
    }
    if (action !== "link" || !g) {
      checks[f] = "new";
      continue;
    }
    switch (f) {
      case "hkid":
        checks.hkid = !g.hkid ? "fill" : g.hkid === val.hkid ? "same" : "conflict";
        break;
      case "nameZh":
        checks.nameZh = normZh(g.nameZh) === normZh(val.nameZh) || g.nameZh === val.nameZh ? "same" : "differs";
        break;
      case "nameEn":
        checks.nameEn = !g.nameEn ? "fill" : g.nameEn.trim().toUpperCase() === val.nameEn!.trim().toUpperCase() ? "same" : "differs";
        break;
      case "dateOfBirth":
        checks.dateOfBirth = !g.dateOfBirth ? "fill" : isoDate(g.dateOfBirth) === val.dateOfBirth ? "same" : "differs";
        break;
      case "phone": {
        if (g.tels.some((t) => normTel8(t) === val.phone)) checks.phone = "same";
        else checks.phone = "fill";
        break;
      }
      case "address": {
        const want = normAddress(val.address);
        checks.address = g.addresses.length === 0 ? "fill" : g.addresses.some((a) => normAddress(a) === want) ? "same" : "differs";
        break;
      }
    }
  }
  return { person: p, action, guardId: d.guardId, reasons: [...new Set(reasons)], hkidCanon, checks };
}

function evaluateAll(pkg: ImportPackage, ctx: DbCtx): Evaluation[] {
  const conflicts = packageConflicts(pkg.persons);
  return pkg.persons.map((p) => evaluate(p, ctx, conflicts.get(p.key) ?? []));
}

// ---------------------------------------------------------------------------
// 預覽（唯讀；回應內 hkid／電話／地址一律遮罩）
// ---------------------------------------------------------------------------
export interface PreviewRow {
  key: string;
  action: Action;
  reasons: string[];
  rating: string;
  /** 自動套用會處理呢個人（link／create；寫入淨係 confirmed 欄） */
  auto_apply: boolean;
  hkid_masked: string | null;
  name_zh: string | null;
  name_en: string | null;
  phone_masked: string | null;
  address_masked: string | null;
  current_name_zh: string | null;
  current_name_en: string | null;
  name_review_pending: boolean;
  fields: Record<PersonField, { status: string; check: FieldCheck }>;
  staff_numbers: number;
}

export interface PreviewResult {
  package_hash: string;
  package: { version: number; generated_at: string; persons: number };
  person_stats: Record<Action, number>;
  field_stats: Record<PersonField, { confirmed: number; review: number; missing: number }>;
  auto_apply: {
    persons: number;
    guards_to_create: number;
    guard_fields_to_fill: number;
    phones_to_add: number;
    addresses_to_add: number;
    staff_numbers_to_add: number;
    field_conflicts: number;
  };
  review: { persons: number; fields: Record<PersonField, number> };
  reason_counts: Record<string, number>;
  rows: PreviewRow[];
}

export async function previewImport(pkg: ImportPackage): Promise<PreviewResult> {
  const ctx = await loadCtx(prisma);
  const evals = evaluateAll(pkg, ctx);
  const fieldStats = Object.fromEntries(["hkid", "nameZh", "nameEn", "dateOfBirth", "sex", "phone", "address"].map((f) => [f, { confirmed: 0, review: 0, missing: 0 }])) as PreviewResult["field_stats"];
  const personStats: Record<Action, number> = { link: 0, create: 0, conflict: 0, needs_review: 0 };
  const reviewFields = Object.fromEntries(["hkid", "nameZh", "nameEn", "dateOfBirth", "sex", "phone", "address"].map((f) => [f, 0])) as Record<PersonField, number>;
  const reasonCounts: Record<string, number> = {};
  const aa = { persons: 0, guards_to_create: 0, guard_fields_to_fill: 0, phones_to_add: 0, addresses_to_add: 0, staff_numbers_to_add: 0, field_conflicts: 0 };
  let reviewPersons = 0;
  const rows: PreviewRow[] = [];
  const claimedNos = new Set<string>();

  for (const e of evals) {
    const p = e.person;
    personStats[e.action] += 1;
    for (const r of e.reasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
    let hasReview = false;
    for (const f of Object.keys(fieldStats) as PersonField[]) {
      fieldStats[f][p[f].status] += 1;
      if (p[f].status === "review") {
        reviewFields[f] += 1;
        hasReview = true;
      }
    }
    const applicable = e.action === "link" || e.action === "create";
    if (hasReview && applicable) reviewPersons += 1;
    if (applicable) {
      aa.persons += 1;
      const g = e.guardId ? ctx.byId.get(e.guardId) : null;
      if (e.action === "create") aa.guards_to_create += 1;
      for (const f of ["hkid", "nameEn", "dateOfBirth"] as const) {
        if (p[f].status === "confirmed" && e.checks[f] !== "invalid_date" && (e.checks[f] === "fill" || (e.action === "create" && f !== "hkid"))) aa.guard_fields_to_fill += 1;
        if (p[f].status === "confirmed" && (e.checks[f] === "differs" || e.checks[f] === "conflict")) aa.field_conflicts += 1;
      }
      if (p.nameZh.status === "confirmed" && e.checks.nameZh === "differs") aa.field_conflicts += 1;
      if (p.phone.status === "confirmed" && (e.checks.phone === "fill" || e.checks.phone === "new")) aa.phones_to_add += 1;
      if (p.address.status === "confirmed") {
        if (e.checks.address === "fill" || e.checks.address === "new") aa.addresses_to_add += 1;
        else if (e.checks.address === "differs") aa.field_conflicts += 1;
      }
      for (const n of p.staffNumbers) {
        const k = normalizeStaffNumber(n.number);
        if (claimedNos.has(k)) continue;
        const exists = g?.staffNumbers.some((x) => normalizeStaffNumber(x.number) === k);
        if (!exists) {
          aa.staff_numbers_to_add += 1;
          claimedNos.add(k);
        }
      }
    }
    const g = e.guardId ? ctx.byId.get(e.guardId) : null;
    rows.push({
      key: p.key,
      action: e.action,
      reasons: e.reasons,
      rating: p.rating,
      auto_apply: applicable,
      hkid_masked: maskHkidImport(e.hkidCanon),
      name_zh: fieldValue(p.nameZh),
      name_en: fieldValue(p.nameEn),
      phone_masked: maskTelImport(fieldValue(p.phone)),
      address_masked: maskAddressImport(fieldValue(p.address)),
      current_name_zh: g?.nameZh ?? null,
      current_name_en: g?.nameEn ?? null,
      name_review_pending: !!g?.identityReviewFields.includes("name_zh"),
      fields: Object.fromEntries((Object.keys(fieldStats) as PersonField[]).map((f) => [f, { status: p[f].status, check: e.checks[f] }])) as PreviewRow["fields"],
      staff_numbers: p.staffNumbers.length,
    });
  }
  return {
    package_hash: hashPackage(pkg),
    package: { version: pkg.version, generated_at: pkg.generatedAt, persons: pkg.persons.length },
    person_stats: personStats,
    field_stats: fieldStats,
    auto_apply: aa,
    review: { persons: reviewPersons, fields: reviewFields },
    reason_counts: reasonCounts,
    rows,
  };
}

// ---------------------------------------------------------------------------
// 套用
// ---------------------------------------------------------------------------
/** keep_pending＝（姓名）照建但標「待核對」，淨係人手覆核時可揀，自動路徑唔用。 */
export type ReviewAction = "confirm" | "replace" | "skip" | "keep_pending";
export interface FieldDecision {
  action: ReviewAction;
  /** 改正後嘅值（confirm 可以帶；replace 必帶或用包內值） */
  value?: string;
}
export type PersonDecisions = Partial<Record<PersonField, FieldDecision>>;

export type FieldOutcome = "written" | "same" | "conflict" | "skipped" | "not_confirmed" | "invalid" | "invalid_date" | "not_stored";

export interface PersonResult {
  key: string;
  outcome: "created" | "linked" | "conflict" | "needs_review" | "error";
  reasons: string[];
  fields: Partial<Record<PersonField, FieldOutcome>>;
  staff_numbers_added: number;
  staff_numbers_skipped: number;
  phones_added: number;
  addresses_added: number;
}

export interface ApplyResult {
  persons_total: number;
  outcomes: Record<PersonResult["outcome"], number>;
  guards_created: number;
  guards_updated: number;
  phones_added: number;
  addresses_added: number;
  staff_numbers_added: number;
  field_conflicts: number;
  fields_written: Record<string, number>;
  results: PersonResult[];
}

export interface ApplyOptions {
  actorUserId: string;
  ip: string | null;
  /** 淨係處理呢啲 key（冇＝全部） */
  personKeys?: readonly string[];
  /** 覆核頁逐人逐欄決定 */
  decisions?: Readonly<Record<string, PersonDecisions>>;
}

interface Want {
  value: string;
  replace: boolean;
  decided: boolean;
  /** 人手揀「照建但標待核對」 */
  pending?: boolean;
}

function wantField(p: PackagePerson, f: PersonField, dec: PersonDecisions | undefined): Want | "skip" | null {
  const d = dec?.[f];
  if (d?.action === "skip") return "skip";
  if (d && f !== "hkid") {
    const v = (d.value ?? fieldValue(p[f]))?.trim();
    if (!v) return null;
    return { value: v, replace: d.action === "replace", decided: true, pending: d.action === "keep_pending" };
  }
  if (p[f].status === "confirmed") {
    const v = fieldValue(p[f]);
    return v ? { value: v, replace: false, decided: false } : null;
  }
  return null;
}

async function applyPerson(tx: Tx, ctx: DbCtx, p: PackagePerson, groupReasons: readonly string[], dec: PersonDecisions | undefined, opts: ApplyOptions, acc: ApplyResult): Promise<PersonResult> {
  const ev = evaluate(p, ctx, groupReasons, dec);
  const res: PersonResult = { key: p.key, outcome: "needs_review", reasons: ev.reasons, fields: {}, staff_numbers_added: 0, staff_numbers_skipped: 0, phones_added: 0, addresses_added: 0 };
  if (ev.action === "conflict" || ev.action === "needs_review") {
    res.outcome = ev.action;
    return res;
  }
  const nameW = wantField(p, "nameZh", dec);
  const nameEnW = wantField(p, "nameEn", dec);
  const dobW = wantField(p, "dateOfBirth", dec);
  const phoneW = wantField(p, "phone", dec);
  const addrW = wantField(p, "address", dec);
  const bump = (f: PersonField, o: FieldOutcome) => {
    res.fields[f] = o;
    if (o === "written") acc.fields_written[f] = (acc.fields_written[f] ?? 0) + 1;
    if (o === "conflict") acc.field_conflicts += 1;
  };
  const noteSkip = (f: PersonField, w: Want | "skip" | null) => {
    if (w === "skip") bump(f, "skipped");
    else if (w === null) res.fields[f] = p[f].status === "missing" ? undefined : "not_confirmed";
  };

  let guardId: string;
  let g: GuardSnap | null = null;
  const review = new Set<string>();

  if (ev.action === "create") {
    const nameVal = nameW && nameW !== "skip" ? nameW.value : fieldValue(p.nameZh)!;
    const dobVal = dobW && dobW !== "skip" ? dobW.value : null;
    const dobOk = parseBirthDate(dobVal);
    if (dobVal && !dobOk) bump("dateOfBirth", "invalid_date");
    // 姓名未確認（review 且冇人手決定）→ 仍然建人，記待核對
    if (p.nameZh.status !== "confirmed" && !(nameW && nameW !== "skip" && nameW.decided && !nameW.pending)) review.add("name_zh");
    const nameEnVal = nameEnW && nameEnW !== "skip" ? nameEnW.value : null;
    const created = await tx.guard.create({
      data: {
        nameZh: nameVal,
        nameEn: nameEnVal,
        hkid: ev.hkidCanon!,
        dateOfBirth: dobOk,
        employmentType: "cash_casual",
        status: "active",
        identityReviewFields: [...review],
        createdBy: opts.actorUserId,
      },
    });
    await writeAuditTx(tx, { actorUserId: opts.actorUserId, tableName: "guards", rowId: created.id, action: "create", after: created, ip: opts.ip });
    guardId = created.id;
    res.outcome = "created";
    acc.guards_created += 1;
    bump("hkid", "written");
    bump("nameZh", "written");
    if (nameEnVal) bump("nameEn", "written");
    else noteSkip("nameEn", nameEnW);
    if (dobOk) bump("dateOfBirth", "written");
    else if (res.fields.dateOfBirth !== "invalid_date") noteSkip("dateOfBirth", dobW);
  } else {
    g = ctx.byId.get(ev.guardId!)!;
    guardId = g.id;
    res.outcome = "linked";
    const data: Prisma.GuardUncheckedUpdateInput = {};
    // hkid：淨補空
    const hk = ev.hkidCanon;
    if (hk && p.hkid.status === "confirmed") {
      if (!g.hkid) {
        data.hkid = hk;
        bump("hkid", "written");
      } else bump("hkid", g.hkid === hk ? "same" : "conflict");
    } else noteSkip("hkid", null);
    // nameZh
    const marker = new Set(g.identityReviewFields);
    if (nameW === "skip" || nameW === null) noteSkip("nameZh", nameW);
    else if (normZh(g.nameZh) === normZh(nameW.value) || g.nameZh === nameW.value) {
      bump("nameZh", "same");
      if (nameW.decided) marker.delete("name_zh");
    } else if (nameW.replace) {
      data.nameZh = nameW.value;
      marker.delete("name_zh");
      bump("nameZh", "written");
    } else bump("nameZh", "conflict");
    // nameEn
    if (nameEnW === "skip" || nameEnW === null) noteSkip("nameEn", nameEnW);
    else if (!g.nameEn) {
      data.nameEn = nameEnW.value;
      bump("nameEn", "written");
    } else if (g.nameEn.trim().toUpperCase() === nameEnW.value.toUpperCase()) bump("nameEn", "same");
    else if (nameEnW.replace) {
      data.nameEn = nameEnW.value;
      bump("nameEn", "written");
    } else bump("nameEn", "conflict");
    // dateOfBirth
    if (dobW === "skip" || dobW === null) noteSkip("dateOfBirth", dobW);
    else if (!parseBirthDate(dobW.value)) bump("dateOfBirth", "invalid_date");
    else if (!g.dateOfBirth || dobW.replace) {
      if (g.dateOfBirth && isoDate(g.dateOfBirth) === dobW.value) bump("dateOfBirth", "same");
      else {
        const dob = parseBirthDate(dobW.value)!;
        data.dateOfBirth = dob;
        // 同 PATCH /api/guards/:id 一致：出生日期變咗要重算牌照衍生值
        const hadValueBefore = g.siaPermitAExpiry != null || g.siaPermitBExpiry != null;
        if (canOverrideDerivedSiaPermit({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry, hadValueBefore })) {
          const derived = deriveSiaPermitExpiry({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry, dateOfBirth: dob });
          data.siaPermitExpiry = derived.siaPermitExpiry;
          data.siaPermitType = derived.siaPermitType;
        }
        bump("dateOfBirth", "written");
      }
    } else bump("dateOfBirth", isoDate(g.dateOfBirth) === dobW.value ? "same" : "conflict");
    if (marker.size !== g.identityReviewFields.length) data.identityReviewFields = [...marker];
    if (Object.keys(data).length > 0) {
      const before = await tx.guard.findUniqueOrThrow({ where: { id: g.id } });
      const after = await tx.guard.update({ where: { id: g.id }, data });
      await writeAuditTx(tx, { actorUserId: opts.actorUserId, tableName: "guards", rowId: g.id, action: "update", before, after, ip: opts.ip });
      acc.guards_updated += 1;
    }
  }
  res.fields.sex = p.sex.status === "missing" ? undefined : "not_stored";

  // --- 工號（任何 scheme）：同一 scheme 已有另一個 current 就唔郁；屬另一人就跳過 ---
  const curG = g ?? { staffNumbers: [] as GuardSnap["staffNumbers"] };
  for (const n of p.staffNumbers) {
    const number = normalizeStaffNumber(n.number);
    const scheme = n.scheme.trim().toUpperCase();
    const mine = curG.staffNumbers.find((x) => normalizeStaffNumber(x.number) === number);
    if (mine) continue;
    const other = await tx.guardStaffNumber.findUnique({ where: { number }, select: { guardId: true } });
    if (other) {
      res.staff_numbers_skipped += 1;
      if (other.guardId !== guardId) res.reasons.push("staffno_belongs_to_other");
      continue;
    }
    if (curG.staffNumbers.some((x) => x.scheme === scheme && x.status === "current") || (await tx.guardStaffNumber.count({ where: { guardId, scheme, status: "current" } })) > 0) {
      res.staff_numbers_skipped += 1;
      res.reasons.push("staffno_scheme_has_other_current");
      continue;
    }
    try {
      const r = await upsertCurrentStaffNumber(tx, { guardId, scheme, number, source: "staff_import", createdBy: opts.actorUserId });
      await writeAuditTx(tx, { actorUserId: opts.actorUserId, tableName: "guard_staff_numbers", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
      res.staff_numbers_added += 1;
      acc.staff_numbers_added += 1;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      res.staff_numbers_skipped += 1;
      res.reasons.push("staffno_invalid");
    }
  }
  if (res.staff_numbers_added > 0) await syncLegacyStaffNoColumns(tx, guardId);

  // --- 電話（confirmed／已決定；全表唯一） ---
  if (phoneW === "skip") bump("phone", "skipped");
  else if (phoneW === null) noteSkip("phone", null);
  else {
    const tel = normTel8(phoneW.value);
    if (!tel) bump("phone", "invalid");
    else {
      const existing = await tx.guardPhone.findFirst({ where: { tel }, select: { guardId: true } });
      if (existing) bump("phone", existing.guardId === guardId ? "same" : "conflict");
      else {
        try {
          await assertTelAvailable(tx, tel, guardId);
          const r = await createGuardPhone(tx, { guardId, tel, isPrimary: false, source: "application_form", createdBy: opts.actorUserId });
          await syncLegacyGuardContactColumns(tx, guardId, ["tel"]);
          await writeAuditTx(tx, { actorUserId: opts.actorUserId, tableName: "guard_phones", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
          res.phones_added += 1;
          acc.phones_added += 1;
          bump("phone", "written");
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          bump("phone", "conflict");
        }
      }
    }
  }

  // --- 地址（confirmed／已決定；現有地址唔同＝conflict，除非 replace 加為新主要） ---
  if (addrW === "skip") bump("address", "skipped");
  else if (addrW === null) noteSkip("address", null);
  else {
    const have = await tx.guardAddress.findMany({ where: { guardId }, select: { address: true } });
    const want = normAddress(addrW.value);
    if (have.some((a) => normAddress(a.address) === want)) bump("address", "same");
    else if (have.length > 0 && !addrW.replace) bump("address", "conflict");
    else {
      const r = await createGuardAddress(tx, { guardId, address: addrW.value, isPrimary: addrW.replace, source: "address_proof", createdBy: opts.actorUserId });
      await syncLegacyGuardContactColumns(tx, guardId, ["address"]);
      await writeAuditTx(tx, { actorUserId: opts.actorUserId, tableName: "guard_addresses", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
      res.addresses_added += 1;
      acc.addresses_added += 1;
      bump("address", "written");
    }
  }
  return res;
}

export async function applyImport(pkg: ImportPackage, opts: ApplyOptions): Promise<ApplyResult> {
  const only = opts.personKeys ? new Set(opts.personKeys) : null;
  const decisionKeys = opts.decisions ? new Set(Object.keys(opts.decisions)) : null;
  const persons = pkg.persons.filter((p) => (!only || only.has(p.key)) && (!decisionKeys || decisionKeys.has(p.key)));
  const groupReasons = packageConflicts(pkg.persons);
  const acc: ApplyResult = {
    persons_total: persons.length,
    outcomes: { created: 0, linked: 0, conflict: 0, needs_review: 0, error: 0 },
    guards_created: 0,
    guards_updated: 0,
    phones_added: 0,
    addresses_added: 0,
    staff_numbers_added: 0,
    field_conflicts: 0,
    fields_written: {},
    results: [],
  };

  const runBatch = async (batch: PackagePerson[]): Promise<PersonResult[]> => {
    const part: ApplyResult = { ...acc, guards_created: 0, guards_updated: 0, phones_added: 0, addresses_added: 0, staff_numbers_added: 0, field_conflicts: 0, fields_written: {}, results: [] };
    const out = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK_KEY})`);
        let ctx = await loadCtx(tx);
        const rs: PersonResult[] = [];
        for (const p of batch) {
          const r = await applyPerson(tx, ctx, p, groupReasons.get(p.key) ?? [], opts.decisions?.[p.key], opts, part);
          rs.push(r);
          if (r.outcome === "created" || r.staff_numbers_added || r.phones_added || r.addresses_added || Object.values(r.fields).includes("written")) ctx = await loadCtx(tx);
        }
        return rs;
      },
      { timeout: IMPORT_TX_TIMEOUT_MS, maxWait: 30_000 },
    );
    // 批成功先合併計數
    acc.guards_created += part.guards_created;
    acc.guards_updated += part.guards_updated;
    acc.phones_added += part.phones_added;
    acc.addresses_added += part.addresses_added;
    acc.staff_numbers_added += part.staff_numbers_added;
    acc.field_conflicts += part.field_conflicts;
    for (const [k, v] of Object.entries(part.fields_written)) acc.fields_written[k] = (acc.fields_written[k] ?? 0) + v;
    return out;
  };

  for (let i = 0; i < persons.length; i += IMPORT_BATCH_SIZE) {
    const batch = persons.slice(i, i + IMPORT_BATCH_SIZE);
    let rs: PersonResult[];
    try {
      rs = await runBatch(batch);
    } catch {
      // 批失敗（已 rollback）→ 逐人重試，壞嗰個記 error（理由碼，唔帶資料）
      rs = [];
      for (const p of batch) {
        try {
          rs.push(...(await runBatch([p])));
        } catch {
          rs.push({ key: p.key, outcome: "error", reasons: ["apply_failed"], fields: {}, staff_numbers_added: 0, staff_numbers_skipped: 0, phones_added: 0, addresses_added: 0 });
        }
      }
    }
    for (const r of rs) {
      acc.outcomes[r.outcome] += 1;
      acc.results.push(r);
    }
  }

  await writeAudit({
    actorUserId: opts.actorUserId,
    tableName: "guard_import",
    rowId: opts.actorUserId,
    action: "guard_import_apply",
    after: {
      persons: acc.persons_total,
      outcomes: acc.outcomes,
      guards_created: acc.guards_created,
      guards_updated: acc.guards_updated,
      phones_added: acc.phones_added,
      addresses_added: acc.addresses_added,
      staff_numbers_added: acc.staff_numbers_added,
      field_conflicts: acc.field_conflicts,
      review_decisions: opts.decisions ? Object.keys(opts.decisions).length : 0,
    },
    ip: opts.ip,
  });
  return acc;
}
