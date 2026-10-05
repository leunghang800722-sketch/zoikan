// WP-AI-OPS §28.4：guard_import generator（純規則；唔 call 任何外部 AI）。
// 輸入：導入包＋apply 完成後重新評估嘅結果（剩低 needs_review／conflict 同 link 但仍有 review 欄嘅人）。
// 一個人最多一條題目（group_key＝導入人 key）→ 冪等、已解決嘅唔會再出。
import type { Evaluation } from "@/lib/guards/import/apply";
import { fieldValue, packageConflicts, unassignedBankOf, type ImportPackage, type PackagePerson } from "@/lib/guards/import/package";
import { serverPersonKey, bankAccountRef } from "@/lib/guards/import/person-key";
import { bankComplete, digits, extKeyGroup, isBankKey, isEmergencyKey, normPayee, type ExtItem } from "@/lib/guards/import/ext";
import { hkidCheckDigitValid, canonicalHkid } from "@/lib/guards/identity";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { KIND_LABEL, REVIEW_FIELDS, type QuestionEvidence, type QuestionKind, type QuestionOption, type ReviewField } from "../types";

export interface QuestionDraft {
  kind: QuestionKind;
  groupKey: string;
  /** 人 key（serverPersonKey；bank_identity_unknown＝戶口 ref）＋鎖定嘅目標 guard（ext／bank 題）：分診「只有最近一次包含呢個人嘅包先答得」用 */
  personKey: string;
  targetGuardId: string | null;
  sort: number;
  title: string;
  evidence: QuestionEvidence;
  options: QuestionOption[];
}

const MAX_CANDIDATES = 5;
const KIND_ORDER: QuestionKind[] = [
  "no_id_card",
  "name_not_confirmed",
  "hkid_not_confirmed",
  "tel_only_candidate",
  "name_only_candidate",
  "staffno_shared_by_persons",
  "dup_tel_across_persons",
  "group_name_differs",
  "package_conflict",
  "other_review",
  "db_conflict",
  "ext_identity_check",
  "bank_identity_unknown",
  "bank_review",
  "field_review",
  "ext_field_conflict",
  "ext_field_review",
];

export const SKIP_OPTION: QuestionOption = { id: "skip", label: "跳過，留返人手處理" };

const hasValidHkid = (p: PackagePerson): boolean => {
  const c = canonicalHkid(fieldValue(p.hkid));
  return !!c && hkidCheckDigitValid(c);
};
const hkidConfirmedValid = (p: PackagePerson): boolean => p.hkid.status === "confirmed" && hasValidHkid(p);

function linkOptions(ids: string[]): QuestionOption[] {
  return ids.slice(0, MAX_CANDIDATES).map((id, i) => ({ id: "link", guard_id: id, label: `係同一個人（連去候選 ${i + 1}）` }));
}

export function kindForEvaluation(e: Evaluation, groupReasons: readonly string[]): QuestionKind | null {
  const r = new Set(e.reasons);
  if (e.action === "conflict") {
    if (groupReasons.length === 0) return "db_conflict";
    if (groupReasons.includes("group_name_differs")) return "group_name_differs";
    if (groupReasons.includes("staffno_shared_by_persons")) return "staffno_shared_by_persons";
    if (groupReasons.includes("dup_tel_across_persons")) return "dup_tel_across_persons";
    return "package_conflict";
  }
  if (e.action === "needs_review") {
    if (r.has("extract_fail") || !hasValidHkid(e.person)) return "no_id_card";
    if (r.has("name_not_confirmed") || r.has("create_no_name")) return "name_not_confirmed";
    if (r.has("hkid_not_confirmed_no_other_key") || r.has("create_hkid_not_confirmed") || r.has("guard_has_other_hkid_unconfirmed")) return "hkid_not_confirmed";
    if (r.has("tel_only_candidate")) return "tel_only_candidate";
    if (r.has("name_only_candidate") || r.has("name_multi_candidate") || r.has("same_name_different_dob")) return "name_only_candidate";
    return "other_review";
  }
  return null;
}

function reviewFieldsOf(e: Evaluation): { field: ReviewField; check: string }[] {
  const out: { field: ReviewField; check: string }[] = [];
  for (const f of REVIEW_FIELDS) {
    const st = e.person[f];
    const check = e.checks[f];
    if (st.status !== "review" || !fieldValue(st)) continue;
    // 唔再按 check（同現有值比較）篩：否則「問唔問」會洩露新值同現值係咪一樣（冇 PII view 嘅人睇到題目數）
    if (check === "missing" || check === "not_stored") continue;
    out.push({ field: f, check });
  }
  return out;
}

function optionsFor(kind: QuestionKind, p: PackagePerson, candidateIds: string[], groupReasons: readonly string[]): QuestionOption[] {
  const opts: QuestionOption[] = [];
  const hasName = !!fieldValue(p.nameZh);
  switch (kind) {
    case "no_id_card":
    case "hkid_not_confirmed":
      if (hasValidHkid(p)) opts.push({ id: "use_package_hkid", label: "用導入包嘅身份證號（我已核對）" });
      opts.push({ id: "enter_hkid", label: "輸入正確身份證號", input: "hkid" }, ...linkOptions(candidateIds));
      break;
    case "name_not_confirmed":
      if (hasName) opts.push({ id: "use_package_name", label: "用導入包嘅姓名（我已核對）" });
      opts.push({ id: "enter_name", label: "輸入正確姓名", input: "text" });
      if (hasName) opts.push({ id: "keep_pending", label: "照建，但標「姓名待核對」" });
      break;
    case "tel_only_candidate":
    case "name_only_candidate":
    case "other_review":
      opts.push(...linkOptions(candidateIds));
      if (hkidConfirmedValid(p)) opts.push({ id: "create_new", label: "唔係同一個人，新開一個安員" });
      break;
    case "group_name_differs":
      if (hasName) opts.push({ id: "use_package_name", label: "用導入包嘅姓名（我已核對）" });
      opts.push({ id: "enter_name", label: "輸入正確姓名", input: "text" });
      if (hasName) opts.push({ id: "keep_pending", label: "照用導入包姓名，但標「姓名待核對」" });
      break;
    case "staffno_shared_by_persons":
    case "dup_tel_across_persons":
      opts.push({ id: "keep", label: "呢個人用呢啲工號／電話（我確認冇問題）" }, { id: "drop_shared", label: "呢個人唔用有爭議嘅工號／電話" });
      break;
    case "package_conflict":
      opts.push({ id: "keep", label: "用呢條記錄（我確認冇問題）" });
      break;
    case "field_review":
      opts.push({ id: "apply_fields", label: "逐欄決定（確認／改正／略過）" });
      break;
    case "db_conflict":
      break;
  }
  void groupReasons;
  opts.push(SKIP_OPTION);
  return opts;
}

export interface DraftOptions {
  /** 作答／上載者冇「安員個人資料:view」：緊急聯絡人嘅出題唔准取決於「同現有聯絡人係咪一樣」（否則題目數變 oracle） */
  viewPii?: boolean;
  /** 冇「安員銀行資料:view」：銀行題同上（有銀行資料就一律出題，唔睇同現有戶口比較） */
  viewBank?: boolean;
  /** 現有安員（bank_identity_unknown 揾英文名 token 相同嘅候選、以及剔走已經有呢個戶口嘅） */
  guards?: ReadonlyMap<string, { id: string; nameEn: string | null; ext: { bank: { accountNo: string | null } } }>;
  /** 啱啱 apply 寫入咗嘅 ext 欄（包內 person key → ext key）：apply 後再評估變 same，唔應該（尤其冇 view 嘅 uniform 規則下）即時出假衝突題 */
  written?: ReadonlyMap<string, ReadonlySet<string>>;
}

const enTokens = (v: string | null | undefined): string[] =>
  normPayee(v)
    .split(" ")
    .filter((t) => t && !/^(MR|MS|MRS|MISS)$/.test(t))
    .sort();
/** 英文名 token 完全相同（至少 2 個 token）先算候選。 */
export function sameEnglishTokens(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = enTokens(a);
  const y = enTokens(b);
  return x.length >= 2 && x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * 新欄題目（對已 link 嘅人）：
 *  - 身份閘未過（typed 名單 only 但身份證／姓名對唔硬）或 ext_identity_check 標記 → ext_identity_check（重要層）；
 *  - 銀行：review／同現有戶口唔同／戶口已屬另一人／銀行閘 hold → bank_review（重要層）；
 *  - 長工入職日期（長工糧讀 guards.hire_date）→ ext_field_review；
 *  - 其餘 review → ext_field_review；confirmed 但同現值唔同 → ext_field_conflict。
 */
function extDrafts(e: Evaluation, order: number, opts: DraftOptions): QuestionDraft[] {
  const p = e.person;
  if (e.action !== "link" || !e.guardId || e.ext.length === 0) return [];
  // 冇對應 view 嘅作答者：出題與否唔准取決於「同現有值比較」（same／differs／add／taken 一律當 differs）
  const uniform = (k: string) => (isBankKey(k) ? opts.viewBank === false : isEmergencyKey(k) ? opts.viewPii === false : false);
  const eff = (i: ExtItem): string => (uniform(i.key) && ["same", "differs", "add", "taken"].includes(i.check) ? "differs" : i.check === "taken" ? "differs" : i.check);
  const incomplete = !bankComplete(p);
  const mk = (kind: QuestionKind, suffix: string, items: ExtItem[]): QuestionDraft => ({
    kind,
    groupKey: `${serverPersonKey(p)}:${suffix}`,
    personKey: serverPersonKey(p),
    targetGuardId: e.guardId,
    sort: KIND_ORDER.indexOf(kind) * 100000 + order,
    title: KIND_LABEL[kind],
    evidence: {
      v: 1,
      person: { ...p, key: serverPersonKey(p) }, // 包內 key 唔入題目 evidence（可能衍生自身份證）
      reasons: [...new Set([...e.reasons, ...(kind === "bank_review" && incomplete ? ["bank_incomplete"] : [])])],
      candidate_guard_ids: [],
      ext_review: items.map((i) => ({ key: i.key, check: eff(i), status: i.status, ...(i.held ? { held: i.held } : {}) })),
      guard_id: e.guardId,
    },
    options:
      kind === "bank_review" && incomplete
        ? [SKIP_OPTION] // 包內銀行四欄唔齊：只可以跳過（唔准砌半套戶口）
        : kind === "ext_identity_check"
        ? [{ id: "confirm_ext_identity", label: "身份冇錯，照寫入（只補空欄）" }, SKIP_OPTION]
        : [{ id: "apply_ext_fields", label: "逐欄決定（用導入值／保留現值／跳過）" }, SKIP_OPTION],
  });
  const wrote = opts.written?.get(p.key);
  const live = e.ext.filter((i) => i.check !== "not_stored" && !wrote?.has(i.key));
  // 身份閘 / 重複標記
  if (!e.gate.scalars || (p.reasons.includes("ext_identity_check") && live.some((i) => i.status === "review"))) {
    const items = live.filter((i) => (i.status === "review" || i.held === "identity") && !(i.status === "confirmed" && eff(i) === "same"));
    if (items.length) return [mk("ext_identity_check", "extidentity", items)];
  }
  // 銀行：review／同現有唔同／閘 hold；另外 confirmed 但 apply 後仍然係「補空」（fill／new）＝有原因冇自動寫（例如 link 前後身份證先補上），都要人確認
  // 銀行 held 而 check=same（有 view：現有戶口同導入一樣）→ 冇嘢好確認，唔出題；冇 view 照舊 uniform（eff 會將 same 當 differs）
  const bank = live.filter((i) => isBankKey(i.key) && (i.status === "review" || eff(i) === "differs" || (i.held === "bank" && eff(i) !== "same") || (i.status === "confirmed" && (i.check === "fill" || i.check === "new"))));
  const longterm = live.filter((i) => i.held === "longterm");
  const review = live.filter((i) => extKeyGroup(i.key) !== "bank" && (i.status === "review" || i.held === "longterm") && eff(i) !== "same");
  const conflict = live.filter((i) => extKeyGroup(i.key) !== "bank" && i.status === "confirmed" && !i.held && eff(i) === "differs");
  void longterm;
  const out: QuestionDraft[] = [];
  if (bank.length) out.push(mk("bank_review", "bank", bank));
  if (review.length) out.push(mk("ext_field_review", "extreview", review));
  if (conflict.length) out.push(mk("ext_field_conflict", "extconflict", conflict));
  return out;
}

/** Payroll Editor 有戶口但對唔到人 → 逐條一題（候選＝英文名 token 完全相同嘅現有安員，最多 5 個）。 */
function unassignedBankDrafts(pkg: ImportPackage, opts: DraftOptions): QuestionDraft[] {
  const list = unassignedBankOf(pkg);
  if (list.length === 0) return [];
  const inPersons = new Set(pkg.persons.map((p) => (p.bank?.accountNo ? fieldValue(p.bank.accountNo) : null)).filter((x): x is string => !!x));
  const guards = [...(opts.guards?.values() ?? [])];
  const haveAcct = new Set(guards.map((g) => digits(g.ext.bank.accountNo)).filter(Boolean));
  const seen = new Set<string>();
  const out: QuestionDraft[] = [];
  list.forEach((u, i) => {
    const ref = bankAccountRef(u.bankCode, u.accountNo);
    if (seen.has(ref)) return;
    seen.add(ref);
    // 已經有安員用緊呢個戶口（已答／已由包內人帶入）→ 唔再問；冇銀行 view 嘅作答者唔准因此改變出唔出題（交俾跨 session 去重）
    if (inPersons.has(u.accountNo) || (opts.viewBank !== false && haveAcct.has(digits(u.accountNo)))) return;
    const cands = guards.filter((g) => sameEnglishTokens(u.payeeName, g.nameEn)).slice(0, MAX_CANDIDATES).map((g) => g.id);
    const synthetic: PackagePerson = {
      key: ref,
      hkid: { value: null, status: "missing" },
      nameZh: { value: null, status: "missing" },
      nameEn: { value: null, status: "missing" },
      dateOfBirth: { value: null, status: "missing" },
      sex: { value: null, status: "missing" },
      phone: { value: null, status: "missing" },
      address: { value: null, status: "missing" },
      staffNumbers: [],
      rating: "review",
      reasons: ["bank_identity_unknown"],
      bank: {
        code: { value: u.bankCode, status: "review" },
        name: { value: null, status: "missing" },
        accountNo: { value: u.accountNo, status: "review" },
        payeeName: { value: u.payeeName, status: "review" },
      },
    };
    out.push({
      kind: "bank_identity_unknown",
      groupKey: `bankpe:${ref}`,
      personKey: ref,
      targetGuardId: null,
      sort: KIND_ORDER.indexOf("bank_identity_unknown") * 100000 + i,
      title: KIND_LABEL.bank_identity_unknown,
      evidence: { v: 1, person: synthetic, reasons: ["bank_identity_unknown"], candidate_guard_ids: cands, unassigned: { key: ref, bankCode: u.bankCode, accountNo: u.accountNo, payeeName: u.payeeName } },
      options: [
        ...cands.map((id, n): QuestionOption => ({ id: "assign_bank", guard_id: id, label: `呢個戶口係候選 ${n + 1} 嘅` })),
        { id: "assign_bank", label: "搜尋其他保安員", input: "guard_search" },
        SKIP_OPTION,
      ],
    });
  });
  return out;
}

export function draftGuardImportQuestions(pkg: ImportPackage, evals: readonly Evaluation[], opts: DraftOptions = {}): QuestionDraft[] {
  const group = packageConflicts(pkg.persons);
  // 包內共用工號
  const noOwners = new Map<string, Set<string>>();
  for (const p of pkg.persons) for (const n of p.staffNumbers) {
    const k = normalizeStaffNumber(n.number);
    if (!noOwners.has(k)) noOwners.set(k, new Set());
    noOwners.get(k)!.add(p.key);
  }
  const order = new Map(pkg.persons.map((p, i) => [p.key, i]));
  const seen = new Set<string>();
  const drafts: QuestionDraft[] = [];
  for (const e of evals) {
    const p = e.person;
    const sk = serverPersonKey(p);
    if (seen.has(p.key) || seen.has(`sk:${sk}`)) continue; // duplicate_key_in_package／同一個人兩行：只問一次
    seen.add(p.key);
    seen.add(`sk:${sk}`);
    const gr = group.get(p.key) ?? [];
    drafts.push(...extDrafts(e, order.get(p.key) ?? 0, opts));
    let kind = kindForEvaluation(e, gr);
    let reviewFields: { field: ReviewField; check: string }[] | undefined;
    if (!kind && e.action === "link" && e.guardId) {
      reviewFields = reviewFieldsOf(e);
      if (reviewFields.length > 0) kind = "field_review";
    }
    if (!kind) continue;
    const candidateIds = [...new Set([...(e.guardId ? [e.guardId] : []), ...e.candidates])].slice(0, MAX_CANDIDATES);
    const evidence: QuestionEvidence = {
      v: 1,
      person: { ...p, key: sk },
      reasons: [...new Set([...e.reasons, ...gr])],
      candidate_guard_ids: kind === "field_review" ? [] : candidateIds,
      ...(kind === "staffno_shared_by_persons" || kind === "dup_tel_across_persons" || kind === "group_name_differs" || kind === "package_conflict"
        ? {
            shared_staff_numbers: p.staffNumbers.map((n) => normalizeStaffNumber(n.number)).filter((k) => (noOwners.get(k)?.size ?? 0) > 1),
            shared_tel: gr.includes("dup_tel_across_persons"),
          }
        : {}),
      ...(reviewFields ? { review_fields: reviewFields, guard_id: e.guardId } : {}),
    };
    drafts.push({
      kind,
      groupKey: sk,
      personKey: sk,
      targetGuardId: null,
      sort: KIND_ORDER.indexOf(kind) * 100000 + (order.get(p.key) ?? 0),
      title: KIND_LABEL[kind],
      evidence,
      options: optionsFor(kind, p, evidence.candidate_guard_ids, gr),
    });
  }
  drafts.push(...unassignedBankDrafts(pkg, opts));
  return drafts.sort((a, b) => a.sort - b.sort);
}

/**
 * R2：答咗 ext_identity_check（照寫入）之後，仍然 held／衝突／冇寫到嘅欄要有題跟進：
 *  - 長工人層面入職日期仍 held → ext_field_review（會影響長工糧計算）；
 *  - 銀行冇寫（冇銀行 update 權／四欄唔齊／戶口被用…）→ bank_review（四欄唔齊只有跳過＋bank_incomplete）；
 *  - 其他欄同現值唔同（conflict）→ ext_field_conflict。
 * 答「跳過」就唔會呼叫呢個函數。
 */
export function identityFollowUps(person: PackagePerson, outcomes: readonly { key: string; outcome: string }[], guardId: string | null, sort: number): QuestionDraft[] {
  const sk = serverPersonKey(person);
  const mk = (kind: QuestionKind, suffix: string, items: { key: string; check: string; status: string; held?: string }[], extraReasons: string[] = [], skipOnly = false): QuestionDraft => ({
    kind,
    groupKey: `${sk}:${suffix}`,
    personKey: sk,
    targetGuardId: guardId,
    sort,
    title: KIND_LABEL[kind],
    evidence: { v: 1, person: { ...person, key: sk }, reasons: extraReasons, candidate_guard_ids: [], ext_review: items, guard_id: guardId },
    options: skipOnly ? [SKIP_OPTION] : [{ id: "apply_ext_fields", label: "逐欄決定（用導入值／保留現值／跳過）" }, SKIP_OPTION],
  });
  const out: QuestionDraft[] = [];
  const o = new Map(outcomes.map((x) => [x.key, x.outcome]));
  if (o.get("hireDate") === "held") out.push(mk("ext_field_review", "extreview", [{ key: "hireDate", check: "held", status: "confirmed", held: "longterm" }]));
  const bo = o.get("bank");
  if (bo !== undefined && bo !== "written" && bo !== "same" && bo !== "skipped") {
    const incomplete = !bankComplete(person);
    out.push(mk("bank_review", "bank", [{ key: "bank", check: "held", status: "review", held: "bank" }], incomplete ? ["bank_incomplete"] : [], incomplete));
  }
  const conflicts = outcomes.filter((x) => x.outcome === "conflict" && !isBankKey(x.key)).map((x) => ({ key: x.key, check: "differs", status: "confirmed" }));
  if (conflicts.length) out.push(mk("ext_field_conflict", "extconflict", conflicts));
  return out;
}
