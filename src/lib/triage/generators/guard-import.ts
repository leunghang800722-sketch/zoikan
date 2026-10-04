// WP-AI-OPS §28.4：guard_import generator（純規則；唔 call 任何外部 AI）。
// 輸入：導入包＋apply 完成後重新評估嘅結果（剩低 needs_review／conflict 同 link 但仍有 review 欄嘅人）。
// 一個人最多一條題目（group_key＝導入人 key）→ 冪等、已解決嘅唔會再出。
import type { Evaluation } from "@/lib/guards/import/apply";
import { fieldValue, packageConflicts, type ImportPackage, type PackagePerson } from "@/lib/guards/import/package";
import { hkidCheckDigitValid, canonicalHkid } from "@/lib/guards/identity";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { KIND_LABEL, REVIEW_FIELDS, type QuestionEvidence, type QuestionKind, type QuestionOption, type ReviewField } from "../types";

export interface QuestionDraft {
  kind: QuestionKind;
  groupKey: string;
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
  "field_review",
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

export function draftGuardImportQuestions(pkg: ImportPackage, evals: readonly Evaluation[]): QuestionDraft[] {
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
    if (seen.has(p.key)) continue; // duplicate_key_in_package：只問一次
    seen.add(p.key);
    const gr = group.get(p.key) ?? [];
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
      person: p,
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
      groupKey: p.key,
      sort: KIND_ORDER.indexOf(kind) * 100000 + (order.get(p.key) ?? 0),
      title: KIND_LABEL[kind],
      evidence,
      options: optionsFor(kind, p, evidence.candidate_guard_ids, gr),
    });
  }
  return drafts.sort((a, b) => a.sort - b.sort);
}
