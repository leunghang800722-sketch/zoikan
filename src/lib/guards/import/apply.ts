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
//    guard_addresses(source=address_proof｜application_form，跟包內 address.source)，全部 writeAuditTx；冪等（重跑唔重複建）。
//  - 分批 transaction（每批 25 人，timeout 120s）；批內任何錯誤 → 該批逐人重試，壞嗰個記 error。
//  - 導入包本身**唔入 DB**：preview／apply 都係請求內處理，用完即棄（apply 要重新帶包）。
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
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
import { buildDbIndex, decideMatch, type Action, type DbGuard, type DbIndex, type RosterEvidence } from "./match";
import { addressSourceOf, fieldValue, hashPackage, packageConflicts, type ImportPackage, type PackagePerson, type PersonField } from "./package";
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
  const [guards, phones, nos, addrs, rosterRows] = await Promise.all([
    db.guard.findMany({
      select: { id: true, nameZh: true, nameEn: true, hkid: true, tel: true, dateOfBirth: true, siaPermitAExpiry: true, siaPermitBExpiry: true, identityReviewFields: true },
    }),
    db.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    db.guardStaffNumber.findMany({ select: { guardId: true, scheme: true, number: true, status: true } }),
    db.guardAddress.findMany({ select: { guardId: true, address: true } }),
    // 更表佐證（name_only 輔助判斷 c；只計 by_staff_no／by_name_tel／override 等有獨立鍵嘅行，by_name／ambiguous 唔計）：一次過預載未作廢上載入面各 guard 出現過嘅原始工號／電話（DISTINCT，唔 N+1）
    db.$queryRaw<{ guard_id: string; staff_no_raw: string | null; tel_raw: string | null }[]>`
      SELECT DISTINCT r.guard_id, r.staff_no_raw, r.tel_raw
      FROM roster_upload_rows r JOIN roster_uploads u ON u.id = r.upload_id
      WHERE r.guard_id IS NOT NULL AND u.voided_at IS NULL AND (r.staff_no_raw IS NOT NULL OR r.tel_raw IS NOT NULL)
        AND (r.guard_match IN ('by_staff_no', 'by_name_tel') OR r.match_basis IN ('staff_no', 'tel', 'name_tel', 'override'))`,
  ]);
  const roster = new Map<string, RosterEvidence>();
  for (const r of rosterRows) {
    const e = roster.get(r.guard_id) ?? { staffNoRaws: [], telRaws: [] };
    if (r.staff_no_raw) e.staffNoRaws.push(r.staff_no_raw);
    if (r.tel_raw) e.telRaws.push(r.tel_raw);
    roster.set(r.guard_id, e);
  }
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
    return { id: g.id, nameZh: g.nameZh, hkid: canonicalHkid(g.hkid), tels, staffNos: (noBy.get(g.id) ?? []).map((n) => n.number), dob: isoDate(g.dateOfBirth) };
  });
  return { index: buildDbIndex(dbGuards, roster), byId };
}

// ---------------------------------------------------------------------------
// 單人評估（preview 同 apply 共用）
// ---------------------------------------------------------------------------
export type FieldCheck = "new" | "fill" | "same" | "differs" | "conflict" | "missing" | "not_stored" | "invalid_date" | "hidden";

export interface Evaluation {
  person: PackagePerson;
  action: Action;
  guardId: string | null;
  reasons: string[];
  /** 對齊依據（hkid／staff_no／tel／name／name_dob／name_roster_evidence／name_en／no_existing_guard／manual_link／manual_create） */
  basis: string[];
  /** 對齊時搵到嘅候選 guard id（分診出題用；唔入 preview 回應） */
  candidates: string[];
  hkidCanon: string | null;
  checks: Record<PersonField, FieldCheck>;
}

function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function evaluate(p: PackagePerson, ctx: DbCtx, groupReasons: readonly string[], dec?: PersonDecisions, forced?: ForcedMatch): Evaluation {
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
      dob: p.dateOfBirth.status === "confirmed" && parseBirthDate(fieldValue(p.dateOfBirth)) ? fieldValue(p.dateOfBirth) : null,
      nameConfirmed: p.nameZh.status === "confirmed",
      grade: p.rating,
      gradeReasons: p.reasons,
    },
    ctx.index,
    groupReasons,
  );
  let { action } = d;
  let guardId = d.guardId;
  let basis = d.basis;
  let reasons = [...d.reasons];
  // WP-AI-OPS §28.4：人手（對話式分診）揀咗「連去呢個現有安員」／「新開一個」。只喺冇包內群組衝突時生效；
  // 仍然要過唯一性（hkid 屬另一人／身份證互相矛盾 → 唔 link／唔 create），之後行同一條 create／link 寫入路徑。
  if (forced && groupReasons.length === 0) {
    const hk = p.hkid.status === "confirmed" ? hkidCanon : null;
    if (forced.mode === "link") {
      const fg = ctx.byId.get(forced.guardId);
      const hkOther = hk ? ctx.index.byHkid.get(hk)?.find((x) => x.id !== forced.guardId) : undefined;
      if (!fg) {
        action = "needs_review";
        guardId = null;
        reasons = ["forced_guard_missing"];
      } else if (hk && fg.hkid && fg.hkid !== hk) {
        action = "conflict";
        guardId = null;
        reasons = ["guard_hkid_differs"];
      } else if (hkOther) {
        action = "conflict";
        guardId = null;
        reasons = ["hkid_belongs_to_other_guard"];
      } else {
        action = "link";
        guardId = fg.id;
        reasons = [];
        basis = [...basis, "manual_link"];
      }
    } else if (!hkidCanon || !hkidCheckDigitValid(hkidCanon) || p.hkid.status !== "confirmed") {
      action = "needs_review";
      guardId = null;
      reasons = ["create_hkid_not_confirmed"];
    } else if (ctx.index.byHkid.get(hkidCanon)?.length) {
      action = "conflict";
      guardId = null;
      reasons = ["hkid_belongs_to_other_guard"];
    } else {
      action = "create";
      guardId = null;
      reasons = [];
      basis = [...basis, "manual_create"];
    }
  }
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
  const g = guardId ? ctx.byId.get(guardId) ?? null : null;
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
        else checks.phone = g.tels.length === 0 ? "fill" : "differs";
        break;
      }
      case "address": {
        const want = normAddress(val.address);
        checks.address = g.addresses.length === 0 ? "fill" : g.addresses.some((a) => normAddress(a) === want) ? "same" : "differs";
        break;
      }
    }
  }
  return { person: p, action, guardId, reasons: [...new Set(reasons)], basis, candidates: d.candidates, hkidCanon, checks };
}

function evaluateAll(pkg: ImportPackage, ctx: DbCtx, decisions?: Readonly<Record<string, PersonDecisions>>): Evaluation[] {
  const conflicts = packageConflicts(pkg.persons);
  return pkg.persons.map((p) => evaluate(p, ctx, conflicts.get(p.key) ?? [], decisions?.[p.key]));
}

// ---------------------------------------------------------------------------
// 預覽（唯讀；回應內 hkid／電話／地址一律遮罩）
// ---------------------------------------------------------------------------
export interface PreviewRow {
  key: string;
  action: Action;
  reasons: string[];
  /** 對齊依據（覆核頁顯示） */
  basis: string[];
  rating: string;
  /** 自動套用會處理呢個人（link／create；寫入淨係 confirmed 欄） */
  auto_apply: boolean;
  hkid_masked: string | null;
  name_zh: string | null;
  name_en: string | null;
  phone_masked: string | null;
  address_masked: string | null;
  /** 地址來源：address_proof｜application_form */
  address_source: string;
  current_name_zh: string | null;
  current_name_en: string | null;
  /** 讀者冇「安員個人資料:view」而現有姓名同導入包唔同：唔回名，只回旗 */
  current_name_hidden?: boolean;
  name_review_pending: boolean;
  fields: Record<PersonField, { status: string; check: FieldCheck }>;
  staff_numbers: number;
}

export interface PreviewResult {
  /** 冇「安員個人資料:view」：依賴「新值 vs 現值」比較嘅彙總計數已隱藏（見 project.ts） */
  counts_hidden?: boolean;
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

/** decisions（淨係單人證件包 preview 用）：令預覽同帶 decisions 嘅 apply 用同一套判斷（例如姓名已由用戶確認就唔再報 name_not_confirmed）。 */
export async function previewImport(pkg: ImportPackage, decisions?: Readonly<Record<string, PersonDecisions>>): Promise<PreviewResult> {
  const ctx = await loadCtx(prisma);
  const evals = evaluateAll(pkg, ctx, decisions);
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
      if (p.phone.status === "confirmed" && (e.checks.phone === "fill" || e.checks.phone === "differs" || e.checks.phone === "new")) aa.phones_to_add += 1;
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
      basis: e.basis,
      rating: p.rating,
      auto_apply: applicable,
      hkid_masked: maskHkidImport(e.hkidCanon),
      name_zh: fieldValue(p.nameZh),
      name_en: fieldValue(p.nameEn),
      phone_masked: maskTelImport(fieldValue(p.phone)),
      address_masked: maskAddressImport(fieldValue(p.address)),
      address_source: addressSourceOf(p.address),
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

export type FieldOutcome = "written" | "same" | "conflict" | "skipped" | "not_confirmed" | "invalid" | "invalid_date" | "not_stored" | "not_written";

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
  counts_hidden?: boolean;
  persons_total: number;
  outcomes: Record<PersonResult["outcome"], number>;
  guards_created: number;
  guards_updated: number;
  phones_added: number;
  addresses_added: number;
  staff_numbers_added: number;
  field_conflicts: number;
  /** 因冇權限覆蓋現有非空值而被擋嘅人數（reason overwrite_forbidden；只取決於現值係咪非空） */
  overwrite_blocked: number;
  fields_written: Record<string, number>;
  results: PersonResult[];
}

/** 人手強制對齊（對話式分診）：link＝連去指定現有安員；create＝新開一個。 */
export type ForcedMatch = { mode: "link"; guardId: string } | { mode: "create" };

/** 寫入時每筆 audit 嘅摘要（分診「預覽＝實際寫入」比對用；唔含 id／時間）。 */
export interface WriteChange {
  table: string;
  action: string;
  rowId: string;
  before: unknown;
  after: unknown;
}

export interface ApplyOptions {
  actorUserId: string;
  ip: string | null;
  /** 逐人強制對齊（key → link／create）；淨係分診用 */
  forced?: Readonly<Record<string, ForcedMatch>>;
  /** 收集每筆寫入（唔影響寫入本身） */
  collect?: WriteChange[];
  /** true＝操作人冇「安員個人資料:view」：電話只准補空（安員已有電話就唔加），令寫入結果唔再反映「估啱電話」 */
  fillOnlyPii?: boolean;
  /** 寫 guards audit 時落 `after.import_via` 硬標記（預設 guard_import；分診傳 triage） */
  via?: "guard_import" | "triage" | "single_ocr";
  /** false＝操作人冇「安員:update」：唔准經導入覆蓋現有安員姓名（會 403）。undefined 當 true。 */
  canEditGuard?: boolean;
  /** false＝操作人冇「安員個人資料:update」：唔准覆蓋現有唔同嘅出生日期／地址（會 403）。undefined 當 true（內部呼叫）。 */
  canOverwritePii?: boolean;
  /** 單人套用：結果係 name_not_confirmed（未寫任何嘢）就自動加「照建但標待核對」再行一次——分診答案已經由人手確認咗其他嘢，姓名仍然標待核對 */
  autoKeepPendingName?: boolean;
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

export const PII_OVERWRITE_DENIED_MSG = "呢條要有安員個人資料修改權限嘅同事（例如老闆）答";
function assertMayOverwritePii(opts: ApplyOptions): void {
  if (opts.canOverwritePii === false) throw new ApiError(403, "forbidden", PII_OVERWRITE_DENIED_MSG);
}
export function isOverwriteForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.message === PII_OVERWRITE_DENIED_MSG;
}
function assertMayEditGuard(opts: ApplyOptions): void {
  if (opts.canEditGuard === false) throw new ApiError(403, "forbidden", PII_OVERWRITE_DENIED_MSG);
}

async function auditTx(tx: Tx, opts: ApplyOptions, input: Parameters<typeof writeAuditTx>[1]): Promise<void> {
  opts.collect?.push({ table: input.tableName, action: input.action, rowId: input.rowId, before: input.before ?? null, after: input.after ?? null });
  // 硬標記只落 guards（create／update）after：DTO mapper 之外經 AUDIT_META_PASSTHROUGH_KEYS 保留；非 PII
  const marked = input.tableName === "guards" && input.after && typeof input.after === "object" ? { ...input, after: { ...(input.after as object), import_via: opts.via ?? "guard_import" } } : input;
  await writeAuditTx(tx, marked);
}

async function applyPerson(tx: Tx, ctx: DbCtx, p: PackagePerson, groupReasons: readonly string[], dec: PersonDecisions | undefined, opts: ApplyOptions, acc: ApplyResult): Promise<PersonResult> {
  const ev = evaluate(p, ctx, groupReasons, dec, opts.forced?.[p.key]);
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
    await auditTx(tx, opts, { actorUserId: opts.actorUserId, tableName: "guards", rowId: created.id, action: "create", after: created, ip: opts.ip });
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
    // 覆蓋權檢查一律喺比較現值「之前」做（唔理新值同現值係咪一樣），免得 200／403 變成探測現值嘅 oracle
    if (nameW && nameW !== "skip" && nameW.replace && g.nameZh) assertMayEditGuard(opts);
    if (nameEnW && nameEnW !== "skip" && nameEnW.replace && g.nameEn) assertMayEditGuard(opts);
    if (dobW && dobW !== "skip" && dobW.replace && g.dateOfBirth) assertMayOverwritePii(opts);
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
      await auditTx(tx, opts, { actorUserId: opts.actorUserId, tableName: "guards", rowId: g.id, action: "update", before, after, ip: opts.ip });
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
      await auditTx(tx, opts, { actorUserId: opts.actorUserId, tableName: "guard_staff_numbers", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
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
      else if (opts.fillOnlyPii && (await tx.guardPhone.count({ where: { guardId } })) > 0) bump("phone", "conflict");
      else {
        try {
          await assertTelAvailable(tx, tel, guardId);
          const r = await createGuardPhone(tx, { guardId, tel, isPrimary: false, source: "application_form", createdBy: opts.actorUserId });
          await syncLegacyGuardContactColumns(tx, guardId, ["tel"]);
          await auditTx(tx, opts, { actorUserId: opts.actorUserId, tableName: "guard_phones", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
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
    if (addrW.replace && have.length > 0) assertMayOverwritePii(opts);
    const want = normAddress(addrW.value);
    if (have.some((a) => normAddress(a.address) === want)) bump("address", "same");
    else if (have.length > 0 && !addrW.replace) bump("address", "conflict");
    else {
      const r = await createGuardAddress(tx, { guardId, address: addrW.value, isPrimary: addrW.replace, source: addressSourceOf(p.address), createdBy: opts.actorUserId });
      await syncLegacyGuardContactColumns(tx, guardId, ["address"]);
      await auditTx(tx, opts, { actorUserId: opts.actorUserId, tableName: "guard_addresses", rowId: r.created.id, action: "create", after: r.created, ip: opts.ip });
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
    overwrite_blocked: 0,
    fields_written: {},
    results: [],
  };

  const runBatch = async (batch: PackagePerson[]): Promise<PersonResult[]> => {
    const part: ApplyResult = { ...acc, guards_created: 0, guards_updated: 0, phones_added: 0, addresses_added: 0, staff_numbers_added: 0, field_conflicts: 0, overwrite_blocked: 0, fields_written: {}, results: [] };
    const out = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK_KEY})`);
        let ctx = await loadCtx(tx);
        const rs: PersonResult[] = [];
        for (const p of batch) {
          // 逐人 savepoint：呢個人因為冇權限覆蓋現有非空值而被擋 → 只 rollback 佢自己（唔半寫佢其他欄），
          // 標 overwrite_forbidden，其他人照常寫；唔會成批／成個請求 403（前面批次已 commit）。
          await tx.$executeRawUnsafe("SAVEPOINT import_person");
          const snap = { ...part, fields_written: { ...part.fields_written } };
          let r: PersonResult;
          try {
            r = await applyPerson(tx, ctx, p, groupReasons.get(p.key) ?? [], opts.decisions?.[p.key], opts, part);
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT import_person");
          } catch (e) {
            if (!isOverwriteForbidden(e)) throw e;
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT import_person");
            Object.assign(part, snap);
            part.overwrite_blocked += 1;
            r = { key: p.key, outcome: "needs_review", reasons: ["overwrite_forbidden"], fields: {}, staff_numbers_added: 0, staff_numbers_skipped: 0, phones_added: 0, addresses_added: 0 };
          }
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
    acc.overwrite_blocked += part.overwrite_blocked;
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
      overwrite_blocked: acc.overwrite_blocked,
      review_decisions: opts.decisions ? Object.keys(opts.decisions).length : 0,
      ...(pkg.source ? { package_source: pkg.source } : {}),
    },
    ip: opts.ip,
  });
  return acc;
}

// ---------------------------------------------------------------------------
// WP-AI-OPS §28.4：分診用嘅 export（唔改上面 preview／apply 行為）
// ---------------------------------------------------------------------------
/** 對齊評估（唔寫 DB）：分診出題用——apply 完成後重新評估，剩低 needs_review／conflict 嘅就係要問嘅人。 */
export async function evaluateImportPackage(pkg: ImportPackage): Promise<{ evals: Evaluation[]; guards: ReadonlyMap<string, Readonly<GuardSnap>> }> {
  const ctx = await loadCtx(prisma);
  return { evals: evaluateAll(pkg, ctx), guards: ctx.byId };
}

class DryRunRollback extends Error {}

const FP_STRIP = new Set(["id", "guardId", "createdAt", "updatedAt", "createdBy", "created_at", "updated_at", "created_by", "guard_id"]);
function fpNormalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => fpNormalize(x));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => !FP_STRIP.has(k))
        .sort()
        .map((k) => [k, fpNormalize(o[k])]),
    );
  }
  return v;
}

/** 一個人嘅「寫入指紋」：結果 + 每筆寫入（去咗 id／時間戳；update 保留 rowId）。預覽同實際寫入逐字相同先准 commit。 */
export function writeFingerprint(res: PersonResult, changes: readonly WriteChange[]): string {
  const norm = JSON.parse(
    JSON.stringify({ res, changes: changes.map((c) => ({ table: c.table, action: c.action, rowId: c.action === "update" ? c.rowId : null, before: c.before, after: c.after })) }),
  ) as unknown;
  return createHash("sha256").update(JSON.stringify(fpNormalize(norm))).digest("hex");
}

export interface SingleApplyOutcome {
  result: PersonResult;
  changes: WriteChange[];
  fingerprint: string;
}

export type SingleApplyMode =
  | { kind: "dry" }
  | {
      kind: "commit";
      /** 用重算出嚟嘅指紋核對預覽時俾用戶睇嗰次；唔一致＝資料中途變咗 → rollback + 409 */
      verify: (fingerprint: string) => boolean;
      /** 同一個 transaction 內（寫入之後、commit 之前）做嘅嘢，例如標記問題已答 */
      beforeCommit?: (tx: Prisma.TransactionClient, outcome: SingleApplyOutcome) => Promise<void>;
    };

/**
 * 單人套用（對話式分診用）：同批量導入共用 applyPerson（同一套唯一性／只寫 confirmed 欄／audit），
 * 但包喺一個 transaction——dry 一定 rollback（預覽）；commit 先重算指紋，唔一致就 rollback。
 */
export async function applyOnePerson(pkg1: ImportPackage, opts: ApplyOptions, mode: SingleApplyMode): Promise<SingleApplyOutcome> {
  if (pkg1.persons.length !== 1) throw new ApiError(400, "bad_request", "單人套用淨係收一個人");
  const p = pkg1.persons[0]!;
  const changes: WriteChange[] = [];
  const acc: ApplyResult = {
    persons_total: 1,
    outcomes: { created: 0, linked: 0, conflict: 0, needs_review: 0, error: 0 },
    guards_created: 0,
    guards_updated: 0,
    phones_added: 0,
    addresses_added: 0,
    staff_numbers_added: 0,
    field_conflicts: 0,
    overwrite_blocked: 0,
    fields_written: {},
    results: [],
  };
  let outcome: SingleApplyOutcome | null = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK_KEY})`);
        const ctx = await loadCtx(tx);
        const groupReasons = packageConflicts(pkg1.persons);
        const gr = groupReasons.get(p.key) ?? [];
        let result = await applyPerson(tx, ctx, p, gr, opts.decisions?.[p.key], { ...opts, collect: changes }, acc);
        if (opts.autoKeepPendingName && result.outcome === "needs_review" && result.reasons.includes("name_not_confirmed") && fieldValue(p.nameZh) && !opts.decisions?.[p.key]?.nameZh) {
          // needs_review 路徑喺任何寫入之前就返，所以重行安全
          result = await applyPerson(tx, ctx, p, gr, { ...(opts.decisions?.[p.key] ?? {}), nameZh: { action: "keep_pending" } }, { ...opts, collect: changes }, acc);
        }
        outcome = { result, changes, fingerprint: writeFingerprint(result, changes) };
        if (mode.kind === "dry") throw new DryRunRollback();
        if (!mode.verify(outcome.fingerprint)) throw new ApiError(409, "conflict", "資料中途變咗，影響同預覽唔一致，請重新預覽", { field: "preview_hash" });
        if (result.outcome === "needs_review" || result.outcome === "conflict" || result.outcome === "error") throw new ApiError(422, "unprocessable", "呢個答案唔會寫入任何資料，請揀其他選項或者跳過");
        await mode.beforeCommit?.(tx, outcome);
      },
      { timeout: IMPORT_TX_TIMEOUT_MS, maxWait: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return outcome!;
}
