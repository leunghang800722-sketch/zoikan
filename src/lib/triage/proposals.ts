// TR-1：「OCR 重讀建議答案」導入——本機重讀腳本（scripts/staff-import/19-triage-reread.ts）出嘅 proposals.json，
// 上載後按 personKey 配對該 session 嘅 open 題，砌成現有 answerSchema 答案，逐題經現有 previewAnswer → submitAnswer 寫入。
//  - 唔新增任何 option 種類；唔直接 update DB（全部經現有預覽＝寫入路徑，同樣 validations／preview_hash／audit）。
//  - 只處理 field_review／name_not_confirmed／hkid_not_confirmed；其餘 kind 一律唔掂（skipped_kind）。
//  - TR-2：field_review 一題多欄，只得部分覆核欄有建議（或有欄格式唔合法）→ 答有建議嘅欄，並喺同一 tx 為剩餘覆核欄開新 field_review 題
//    （groupKey `<舊>:rest`、evidence 只含剩餘欄），避免未決定嘅欄跟住變「已答」。冪等：同 groupKey 已存在就唔重覆開。
//  - 回應淨係計數（唔回任何欄位值）；單位：skipped_* 以「建議條數」計；matched_questions／applied 以「題目數」計。
import { z } from "zod";
import type { TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { canonicalHkid, hkidCheckDigitValid } from "@/lib/guards/identity";
import { fieldValue } from "@/lib/guards/import/package";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { serverPersonKey } from "@/lib/guards/import/person-key";
import { normTel8, normZh, parseBirthDate } from "@/lib/guards/import/text";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { previewAnswer, submitAnswer, type FollowUpDraft } from "./apply";
import { restrictedKindsFor } from "./session";
import { viewerCaps } from "./view";
import type { QuestionEvidence, QuestionOption, ReviewField, TriageAnswer } from "./types";

const PROPOSAL_MAX = 2000;
const PROPOSAL_FIELDS = ["nameZh", "nameEn", "hkid", "dateOfBirth", "phone", "address"] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];
/** 呢個功能處理嘅題目類別（其餘一律 skipped_kind） */
const PROPOSAL_KINDS = ["field_review", "name_not_confirmed", "hkid_not_confirmed", "no_id_card"] as const;
const OCR_REREAD_SOURCE = "ocr_reread" as const;

const proposalSchema = z
  .object({
    person_key: z.string().min(1).max(64),
    field: z.enum(PROPOSAL_FIELDS),
    value: z.string().trim().min(1).max(500),
    basis: z.enum(["two_reads", "arbiter"]),
    doc: z.enum(["id_card", "address_proof", "onboarding_form"]),
    /** TE-4：low＝只有印刷／唔一致，要人手覆核（唔自動答；計 skipped_low_confidence） */
    confidence: z.enum(["high", "medium", "low"]),
    /** TE-4：可選旗標（例 printed_card_conflict、embedded_card）；只用嚟顯示／統計，伺服器唔據此寫入 */
    flags: z.array(z.enum(["printed_card_conflict", "embedded_card", "printed_corroborated", "printed_only", "card_name_conflict", "form_differs", "form_conflict", "card_unverified", "typed_list_differs", "arbiter_agree_a"])).max(4).optional(),
    /**
     * 配對提示（additive，可選）：題目嘅 personKey 係伺服器 HMAC（serverPersonKey：身份證 → 工號集合 → 包內 key），唔係包內 persons[].key。
     * 本機腳本帶埋包內該人嘅身份證值／工號，伺服器用同一個函數推返 personKey 去配對。只用嚟砌 key，唔寫入任何地方。
     */
    match: z.object({ hkid: z.string().max(20).nullable().optional(), staff_numbers: z.array(z.string().min(1).max(32)).max(20).optional() }).strict().optional(),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
/** 頂層唔 strict：proposals.json 帶埋 summary（淨計數）都收得。 */
export const proposalsBodySchema = z.object({ version: z.literal(1), proposals: z.array(proposalSchema).max(PROPOSAL_MAX) });

interface ProposalCounts {
  proposals_total: number;
  matched_questions: number;
  applied: number;
  skipped_no_question: number;
  skipped_kind: number;
  skipped_field_mismatch: number;
  /** skipped_field_mismatch 細分：建議欄唔喺題目覆核欄 */
  skipped_field_not_under_review: number;
  /** skipped_field_mismatch 細分：name／hkid 確認類值同題目唔同 */
  skipped_value_mismatch: number;
  skipped_invalid: number;
  skipped_restricted: number;
  /** TE-4：confidence=low（印刷冇卡／印刷同卡唔一致）——留人手 */
  skipped_low_confidence: number;
  /** TE-5：preview 回 needs_decision（同名現有保安員）——要人決定連結／建新人，唔按姓名自動連結 */
  skipped_needs_decision: number;
  /** TE-11.5：同一條題被兩個 person_key（或推導 key）各配一次——只答一次，後者計呢項（避免 dry 重複計、apply 第二次 409 已答過） */
  skipped_duplicate_question: number;
  skipped_partial: number;
  skipped_identity_mismatch: number;
  errors: number;
  /** applied 之中，只答部分覆核欄嘅題數 */
  applied_partial: number;
  /** 為剩餘覆核欄開（dry＝會開）嘅跟進題數 */
  follow_up_created: number;
  /** TE-11.4：skipped_invalid 嘅原因碼分佈（preview:<原因碼> 或 submit:<狀態>:<code>:<固定訊息>；唔記任何值；單位＝建議條數） */
  invalid_reasons: Record<string, number>;
  /** TE-11.4：commit 時遇 409「資料中途變咗」而自動重新預覽再答一次嘅題數 */
  resubmitted: number;
}
const emptyCounts = (): ProposalCounts => ({ invalid_reasons: {}, resubmitted: 0, proposals_total: 0, matched_questions: 0, applied: 0, applied_partial: 0, follow_up_created: 0, skipped_no_question: 0, skipped_kind: 0, skipped_field_mismatch: 0, skipped_field_not_under_review: 0, skipped_value_mismatch: 0, skipped_invalid: 0, skipped_restricted: 0, skipped_low_confidence: 0, skipped_needs_decision: 0, skipped_duplicate_question: 0, skipped_partial: 0, skipped_identity_mismatch: 0, errors: 0 });

type Disp = "applied" | "skipped_no_question" | "skipped_kind" | "skipped_field_not_under_review" | "skipped_value_mismatch" | "skipped_invalid" | "skipped_restricted" | "skipped_low_confidence" | "skipped_needs_decision" | "skipped_duplicate_question" | "skipped_partial" | "skipped_identity_mismatch" | "errors";

export type QuestionPlan =
  | { type: "none" } // 呢條題同呢個人嘅建議冇關係（唔計 matched）
  | { type: "skip"; disp: Exclude<Disp, "applied" | "skipped_no_question" | "skipped_kind" | "errors">; fields: ProposalField[] }
  /** fields＝今次答咗嘅欄；rest＝仍要覆核而今次冇答嘅欄（要開跟進題）；invalidFields＝有建議但格式唔合法（留喺 rest） */
  | { type: "answer"; answer: TriageAnswer; fields: ProposalField[]; rest: ReviewField[]; invalidFields: ProposalField[] };

/**
 * 純函數：一條 open 題 ＋ 該人嘅建議（欄位 → 值）→ 要答乜／跳過原因。
 *  - name_not_confirmed：只接受 nameZh 建議而且同題目 evidence 嘅姓名一致（＝確認，option use_package_name）。
 *  - hkid_not_confirmed：只接受 hkid 建議而且同 evidence 嘅身份證號（canonical）一致（option use_package_hkid）。
 *  - field_review：答有建議而且格式合法嘅覆核欄（apply_fields；action=confirm＋值：只補空／確認，唔覆蓋現有唔同值）；剩餘覆核欄放 rest（由 runProposals 開跟進題）。
 */
/** TE-11：每欄建議嘅來源資訊（證件為準自動答用）。 */
export interface ProposalMeta {
  confidence: "high" | "medium" | "low";
  basis: "two_reads" | "arbiter";
  doc: "id_card" | "address_proof" | "onboarding_form";
  flags?: readonly string[];
}
/** 證件為準：身份證副本讀數（兩讀一致）＋confidence high（入職表交叉核對一致或印刷佐證）＋冇衝突旗 */
const cardTruth = (m: ProposalMeta | undefined): boolean => !!m && m.confidence === "high" && m.basis === "two_reads" && m.doc === "id_card" && !(m.flags ?? []).some((f) => f === "printed_card_conflict" || f === "card_name_conflict");

export function planForQuestion(q: Pick<TriageQuestion, "kind" | "optionsJson" | "evidenceJson">, props: ReadonlyMap<ProposalField, string>, meta: ReadonlyMap<ProposalField, ProposalMeta> = new Map()): QuestionPlan {
  const ev = q.evidenceJson as unknown as QuestionEvidence;
  const opts = (q.optionsJson as unknown as QuestionOption[]) ?? [];
  if (q.kind === "name_not_confirmed") {
    const v = props.get("nameZh");
    if (v === undefined) return { type: "none" };
    const pkg = fieldValue(ev.person.nameZh);
    if (!pkg || !normZh(v) || normZh(v) !== normZh(pkg)) {
      // TE-11 證件為準：卡讀數（two_reads、high、冇衝突旗）同包內唔一致 → 用 enter_name 寫入卡上中文名，並帶卡上英文名（包內英文名未確認先帶）；身份決定（同名／同號候選）由 preview 攔住留人
      if (cardTruth(meta.get("nameZh")) && normZh(v) && opts.some((o) => o.id === "enter_name")) {
        const en = props.get("nameEn");
        const enOpen = !(ev.person.nameEn?.value && ev.person.nameEn.status === "confirmed");
        const useEn = !!en && enOpen && meta.get("nameEn") !== undefined && meta.get("nameEn")!.confidence !== "low";
        return { type: "answer", answer: { option: "enter_name", value: v, ...(useEn ? { extra: { name_en: en } } : {}) }, fields: useEn ? ["nameZh", "nameEn"] : ["nameZh"], rest: [], invalidFields: [] };
      }
      return { type: "skip", disp: "skipped_value_mismatch", fields: ["nameZh"] };
    }
    if (!opts.some((o) => o.id === "use_package_name")) return { type: "skip", disp: "skipped_invalid", fields: ["nameZh"] };
    return { type: "answer", answer: { option: "use_package_name" }, fields: ["nameZh"], rest: [], invalidFields: [] };
  }
  if (q.kind === "hkid_not_confirmed") {
    const v = props.get("hkid");
    if (v === undefined) return { type: "none" };
    const want = canonicalHkid(v);
    const pkg = canonicalHkid(fieldValue(ev.person.hkid));
    if (!want || !pkg || want !== pkg) {
      // TE-11 證件為準：卡讀數 checksum 過＋two_reads high → enter_hkid（owner／同名候選等身份決定仍由 preview 留人）
      if (want && hkidCheckDigitValid(want) && cardTruth(meta.get("hkid")) && opts.some((o) => o.id === "enter_hkid")) return { type: "answer", answer: { option: "enter_hkid", value: want }, fields: ["hkid"], rest: [], invalidFields: [] };
      return { type: "skip", disp: "skipped_value_mismatch", fields: ["hkid"] };
    }
    if (!opts.some((o) => o.id === "use_package_hkid")) return { type: "skip", disp: "skipped_invalid", fields: ["hkid"] };
    return { type: "answer", answer: { option: "use_package_hkid" }, fields: ["hkid"], rest: [], invalidFields: [] };
  }
  if (q.kind === "no_id_card") {
    // TE-4：嵌入身份證副本讀到 hkid（＋姓名／出生日期）→ 揀「輸入身份證號」並帶 extra 補姓名／出生日期（解決 create_no_name）；身份檢查照舊（號碼已屬他人 → 預覽唔寫）
    const v = props.get("hkid");
    if (v === undefined) return { type: "none" };
    const canon = canonicalHkid(v);
    if (!canon || !hkidCheckDigitValid(canon)) return { type: "skip", disp: "skipped_invalid", fields: ["hkid"] };
    if (!opts.some((o) => o.id === "enter_hkid")) return { type: "skip", disp: "skipped_invalid", fields: ["hkid"] };
    // TE-3 S1：包內姓名已確認嘅唔再補（server 亦會 400）
    const nameOpen = (f: { value?: string | null; status?: string } | undefined) => !(f?.value && f.status === "confirmed");
    const nz = nameOpen(ev.person?.nameZh) ? props.get("nameZh") : undefined;
    const ne = nameOpen(ev.person?.nameEn) ? props.get("nameEn") : undefined;
    const dob = nameOpen(ev.person?.dateOfBirth) ? props.get("dateOfBirth") : undefined; // TE-4.2 S1：已確認出生日期唔帶
    const extra: NonNullable<TriageAnswer["extra"]> = {};
    const fields: ProposalField[] = ["hkid"];
    if (nz && normZh(nz)) { extra.name_zh = nz; fields.push("nameZh"); }
    if (ne) { extra.name_en = ne; fields.push("nameEn"); }
    if (dob && parseBirthDate(dob)) { extra.dob = dob; fields.push("dateOfBirth"); }
    return { type: "answer", answer: { option: "enter_hkid", value: canon, ...(Object.keys(extra).length ? { extra } : {}) }, fields, rest: [], invalidFields: [] };
  }
  if (q.kind === "field_review") {
    const rf = (ev.review_fields ?? []).map((r) => r.field);
    const have = rf.filter((f) => props.has(f));
    if (have.length === 0) return { type: "none" };
    if (!opts.some((o) => o.id === "apply_fields")) return { type: "skip", disp: "skipped_invalid", fields: have };
    const fields: NonNullable<TriageAnswer["fields"]> = {};
    const invalidFields: ProposalField[] = [];
    for (const f of rf) {
      if (!props.has(f)) continue;
      const v = props.get(f)!;
      const bad = (f === "dateOfBirth" && !parseBirthDate(v)) || (f === "phone" && !normTel8(v)) || (f === "nameZh" && !normZh(v));
      if (bad) invalidFields.push(f);
      else fields[f as ReviewField] = { action: "confirm", value: v };
    }
    const answered = Object.keys(fields) as ProposalField[];
    if (answered.length === 0) return { type: "skip", disp: "skipped_invalid", fields: have };
    const rest = rf.filter((f) => !answered.includes(f));
    return { type: "answer", answer: { option: "apply_fields", fields }, fields: answered, rest, invalidFields };
  }
  return { type: "none" };
}

/** preview 唔可寫入嘅原因碼（impact.notes 內「原因碼：a,b」；冇就用人話首句） */
function previewReason(notes: readonly string[], text?: string): string {
  const m = notes.map((n) => /原因碼：([A-Za-z0-9_,]+)/.exec(n)?.[1]).find(Boolean);
  return `preview:${m ?? (text ? text.slice(0, 40) : "not_writable")}`;
}
/** commit 失敗原因：ApiError＝狀態＋code；其他＝error */
export function submitReason(e: unknown): string {
  // 只記狀態＋code（訊息可能帶電話／工號等原值，唔記）
  if (!(e instanceof ApiError)) return "submit:error";
  // TE-11.6：preview_hash 409 附指紋差異路徑（只路徑＋類型，冇值；最多 3 條，字元白名單）
  const dp = e.status === 409 && e.details?.field === "preview_hash" && Array.isArray(e.details.diff_paths) ? (e.details.diff_paths as unknown[]).filter((x): x is string => typeof x === "string" && /^[\w.\[\]#<>:$-]{1,80}$/.test(x)).slice(0, 3) : [];
  return `submit:${e.status}:${e.code}${dp.length ? `:${dp.join(",")}` : ""}`;
}

export function dispOf(e: unknown): Disp {
  if (e instanceof ApiError) return e.status === 403 ? "skipped_restricted" : e.status >= 400 && e.status < 500 ? "skipped_invalid" : "errors";
  return "errors";
}

export interface ProposalRunResult extends ProposalCounts {
  dry_run: boolean;
}

export async function runProposals(actor: AuthedSession, sessionId: string, proposals: readonly Proposal[], opts: { dryRun: boolean; ip: string | null }): Promise<ProposalRunResult> {
  const counts = emptyCounts();
  counts.proposals_total = proposals.length;
  // 同一人同一欄冇共識（同欄多個唔同值）→ 全部當 invalid，唔猜
  const byKey = new Map<string, Map<ProposalField, Set<string>>>();
  const idxOf = new Map<string, number[]>();
  proposals.forEach((p, i) => {
    const m = byKey.get(p.person_key) ?? byKey.set(p.person_key, new Map()).get(p.person_key)!;
    (m.get(p.field) ?? m.set(p.field, new Set()).get(p.field)!).add(p.value);
    const k = `${p.person_key}|${p.field}`;
    idxOf.set(k, [...(idxOf.get(k) ?? []), i]);
  });
  /** TE-11.4：skipped_invalid 唔好吞——記原因碼（固定訊息／狀態碼，唔記任何值） */
  const seenQuestions = new Set<string>(); // TE-11.5：同一題只處理一次
  const noteInvalid = (n: number, reason: string) => {
    counts.invalid_reasons[reason] = (counts.invalid_reasons[reason] ?? 0) + n;
  };
  const disp = new Array<Disp | null>(proposals.length).fill(null);
  const mark = (key: string, fields: readonly ProposalField[], d: Disp) => {
    for (const f of fields) for (const i of idxOf.get(`${key}|${f}`) ?? []) if (disp[i] === null) disp[i] = d;
  };

  // 配對：題目 personKey 係伺服器 HMAC（serverPersonKey），所以用建議帶嘅 match（身份證／工號）推返同一個 key；
  // 亦兼容 person_key 直接等於 personKey／evidence.person.key（舊 session 用包內 key）。
  const rows = byKey.size ? await prisma.triageQuestion.findMany({ where: { sessionId, status: "open" }, orderBy: [{ sort: "asc" }, { id: "asc" }] }) : [];
  const qsByQKey = new Map<string, TriageQuestion[]>();
  for (const r of rows) {
    const pk = (r.evidenceJson as unknown as QuestionEvidence | null)?.person?.key;
    for (const k of new Set([pk, r.personKey].filter((x): x is string => !!x))) qsByQKey.set(k, [...(qsByQKey.get(k) ?? []), r]);
  }
  const matchOf = new Map<string, Proposal["match"]>();
  for (const p of proposals) if (p.match && !matchOf.has(p.person_key)) matchOf.set(p.person_key, p.match);
  const qsByKey = new Map<string, TriageQuestion[]>();
  for (const key of byKey.keys()) {
    const m = matchOf.get(key);
    const derived = m ? serverPersonKey({ key, hkid: { value: m.hkid ?? null }, staffNumbers: (m.staff_numbers ?? []).map((number) => ({ number })) }) : null;
    const hit = new Map<string, TriageQuestion>();
    for (const k of [key, derived]) for (const q of k ? (qsByQKey.get(k) ?? []) : []) hit.set(q.id, q);
    qsByKey.set(key, [...hit.values()].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id)));
  }
  const restricted = new Set(await restrictedKindsFor(actor));
  /** N1 顯式身份檢查：有 match＝推導 key 要等於題目 personKey，而且身份證／工號集合要同 evidence.person 一致；冇 match＝person_key 要等於 evidence.person.key（冇 evidence 可對就唔過） */
  const identityOk = (q: TriageQuestion, key: string): boolean => {
    const ep = (q.evidenceJson as unknown as QuestionEvidence | null)?.person;
    if (!ep) return false;
    const m = matchOf.get(key);
    if (!m) return ep.key === key;
    const derived = serverPersonKey({ key, hkid: { value: m.hkid ?? null }, staffNumbers: (m.staff_numbers ?? []).map((number) => ({ number })) });
    if (derived !== (q.personKey ?? ep.key)) return false;
    if ((canonicalHkid(m.hkid ?? null) ?? null) !== (canonicalHkid(ep.hkid?.value ?? null) ?? null)) return false;
    const a = [...new Set((m.staff_numbers ?? []).map(normalizeStaffNumber))].sort().join(",");
    const b = [...new Set((ep.staffNumbers ?? []).map((n) => normalizeStaffNumber(n.number)))].sort().join(",");
    return a === b;
  };
  const caps = await viewerCaps(actor);

  for (const [key, fieldMap] of byKey) {
    const allFields = [...fieldMap.keys()];
    const conflicting = allFields.filter((f) => fieldMap.get(f)!.size > 1);
    mark(key, conflicting, "skipped_invalid");
    const props = new Map<ProposalField, string>();
    for (const f of allFields) if (!conflicting.includes(f)) props.set(f, [...fieldMap.get(f)!][0]!);
    // TE-4：低信心（印刷冇卡／印刷同卡唔一致）嘅建議唔自動答——先剔走，其餘照處理
    for (const f of [...props.keys()]) {
      const idxs = idxOf.get(`${key}|${f}`) ?? [];
      if (idxs.length > 0 && idxs.every((i) => proposals[i]!.confidence === "low")) {
        // TE-9：hkid 建議（含 printed_only 低信心）等於系統內一位現有保安員嘅身份證號 → 要人一撳連結（計 skipped_needs_decision），唔計低信心
        const canon = f === "hkid" ? canonicalHkid(props.get(f) ?? null) : null;
        const owners = canon ? await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM guards WHERE regexp_replace(upper(hkid), '[()（）[:space:]]', '', 'g') = ${canon} LIMIT 2` : [];
        mark(key, [f], owners.length === 1 ? "skipped_needs_decision" : "skipped_low_confidence");
        props.delete(f);
      }
    }
    if (props.size === 0) continue;
    const qsRaw = qsByKey.get(key) ?? [];
    if (qsRaw.length === 0) {
      mark(key, allFields, "skipped_no_question");
      continue;
    }
    const qs = qsRaw.filter((q) => identityOk(q, key));
    if (qs.length === 0) {
      mark(key, allFields, "skipped_identity_mismatch");
      continue;
    }
    const eligible = qs.filter((q) => (PROPOSAL_KINDS as readonly string[]).includes(q.kind));
    if (eligible.length === 0) {
      mark(key, allFields, "skipped_kind");
      continue;
    }
    const metaMap = new Map<ProposalField, ProposalMeta>();
    for (const f of props.keys()) {
      const pi = (idxOf.get(`${key}|${f}`) ?? [])[0];
      if (pi !== undefined) {
        const p = proposals[pi]!;
        metaMap.set(f, { confidence: p.confidence, basis: p.basis, doc: p.doc, ...(p.flags ? { flags: p.flags } : {}) });
      }
    }
    /** S2：自動答嘅題 audit 記今次用到嘅建議旗標（form_differs 等；淨旗標，唔記值） */
    const flagsOf = (fields: readonly ProposalField[]): string[] => [...new Set(fields.flatMap((f) => metaMap.get(f)?.flags ?? []))];
    for (const q of eligible) {
      if (seenQuestions.has(q.id)) {
        mark(key, allFields, "skipped_duplicate_question");
        continue;
      }
      seenQuestions.add(q.id);
      const plan = planForQuestion(q, props, metaMap);
      if (plan.type === "none") continue;
      counts.matched_questions += 1;
      if (plan.type === "skip") {
        mark(key, plan.fields, plan.disp);
        continue;
      }
      if (restricted.has(q.kind)) {
        mark(key, plan.fields, "skipped_restricted");
        continue;
      }
      try {
        const prev = await previewAnswer(actor, q, plan.answer, caps, opts.ip);
        if (prev.impact.needs_decision) {
          mark(key, plan.fields, "skipped_needs_decision");
          continue;
        }
        if (!prev.writes) {
          // TE-4：no_id_card 輸入嘅號碼已屬他人／同名唔同號 → 身份對唔上，計 skipped_identity_mismatch
          const idMismatch = q.kind === "no_id_card" && prev.impact.notes.some((n) => /hkid_belongs_to_other_guard|same_name_different_hkid|guard_hkid_differs|name_differs_from_guard/.test(n));
          mark(key, plan.fields, idMismatch ? "skipped_identity_mismatch" : "skipped_invalid");
          if (!idMismatch) noteInvalid(plan.fields.length, previewReason(prev.impact.notes, prev.impact.reason_text));
          continue;
        }
        const followUp: FollowUpDraft | undefined = plan.rest.length > 0 ? { groupKey: `${q.groupKey}:rest`, restFields: plan.rest } : undefined;
        let followCreated = false;
        if (opts.dryRun) followCreated = !!followUp && !(await prisma.triageQuestion.findFirst({ where: { sessionId, groupKey: followUp.groupKey }, select: { id: true } }));
        else {
          const sub = (hash: string) => submitAnswer(actor, q, plan.answer, hash, caps, opts.ip, { source: OCR_REREAD_SOURCE, ...(followUp ? { followUp } : {}), ...(flagsOf(plan.fields).length ? { flags: flagsOf(plan.fields) } : {}) });
          try {
            followCreated = !!(await sub(prev.preview_hash)).follow_up_created;
          } catch (e) {
            // 409「資料中途變咗」（預覽同 commit 指紋唔同）——重新預覽一次再答（同題卡 UI 一樣）；仍失敗就照原樣計 invalid
            if (!(e instanceof ApiError && e.status === 409 && e.details?.field === "preview_hash")) throw e;
            const again = await previewAnswer(actor, q, plan.answer, caps, opts.ip);
            if (!again.writes || again.impact.needs_decision) throw e;
            counts.resubmitted += 1;
            followCreated = !!(await sub(again.preview_hash)).follow_up_created;
          }
        }
        mark(key, plan.fields, "applied");
        mark(key, plan.invalidFields, "skipped_invalid");
        counts.applied += 1;
        if (followUp) counts.applied_partial += 1;
        if (followCreated) counts.follow_up_created += 1;
      } catch (e) {
        // TE-4：no_id_card 輸入嘅號碼已屬他人（checkHkidOwner 422）＝身份對唔上
        const ownerClash = q.kind === "no_id_card" && e instanceof ApiError && e.status === 422 && e.message.includes("身份證號已屬於另一位");
        const d = ownerClash ? "skipped_identity_mismatch" : dispOf(e);
        mark(key, plan.fields, d);
        if (d === "skipped_invalid") noteInvalid(plan.fields.length, submitReason(e));
      }
    }
    // 呢個人冇被任何題認領嘅建議（欄位唔喺任何 open 題嘅覆核欄內）
    mark(key, allFields, "skipped_field_not_under_review");
  }
  for (const d of disp) {
    if (!d || d === "applied") continue;
    counts[d] += 1;
    if (d === "skipped_field_not_under_review" || d === "skipped_value_mismatch") counts.skipped_field_mismatch += 1;
  }
  if (!opts.dryRun) {
    await writeAudit({
      actorUserId: actor.userId,
      tableName: "triage_sessions",
      rowId: sessionId,
      action: "triage_proposals_import",
      after: { session_id: sessionId, answered_via: OCR_REREAD_SOURCE, ...counts },
      ip: opts.ip,
    });
  }
  return { ...counts, dry_run: opts.dryRun };
}
