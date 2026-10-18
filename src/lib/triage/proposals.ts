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
    flags: z.array(z.enum(["printed_card_conflict", "embedded_card", "printed_corroborated", "printed_only", "card_name_conflict"])).max(4).optional(),
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
  skipped_partial: number;
  skipped_identity_mismatch: number;
  errors: number;
  /** applied 之中，只答部分覆核欄嘅題數 */
  applied_partial: number;
  /** 為剩餘覆核欄開（dry＝會開）嘅跟進題數 */
  follow_up_created: number;
}
const emptyCounts = (): ProposalCounts => ({ proposals_total: 0, matched_questions: 0, applied: 0, applied_partial: 0, follow_up_created: 0, skipped_no_question: 0, skipped_kind: 0, skipped_field_mismatch: 0, skipped_field_not_under_review: 0, skipped_value_mismatch: 0, skipped_invalid: 0, skipped_restricted: 0, skipped_low_confidence: 0, skipped_partial: 0, skipped_identity_mismatch: 0, errors: 0 });

type Disp = "applied" | "skipped_no_question" | "skipped_kind" | "skipped_field_not_under_review" | "skipped_value_mismatch" | "skipped_invalid" | "skipped_restricted" | "skipped_low_confidence" | "skipped_partial" | "skipped_identity_mismatch" | "errors";

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
export function planForQuestion(q: Pick<TriageQuestion, "kind" | "optionsJson" | "evidenceJson">, props: ReadonlyMap<ProposalField, string>): QuestionPlan {
  const ev = q.evidenceJson as unknown as QuestionEvidence;
  const opts = (q.optionsJson as unknown as QuestionOption[]) ?? [];
  if (q.kind === "name_not_confirmed") {
    const v = props.get("nameZh");
    if (v === undefined) return { type: "none" };
    const pkg = fieldValue(ev.person.nameZh);
    if (!pkg || !normZh(v) || normZh(v) !== normZh(pkg)) return { type: "skip", disp: "skipped_value_mismatch", fields: ["nameZh"] };
    if (!opts.some((o) => o.id === "use_package_name")) return { type: "skip", disp: "skipped_invalid", fields: ["nameZh"] };
    return { type: "answer", answer: { option: "use_package_name" }, fields: ["nameZh"], rest: [], invalidFields: [] };
  }
  if (q.kind === "hkid_not_confirmed") {
    const v = props.get("hkid");
    if (v === undefined) return { type: "none" };
    const want = canonicalHkid(v);
    const pkg = canonicalHkid(fieldValue(ev.person.hkid));
    if (!want || !pkg || want !== pkg) return { type: "skip", disp: "skipped_value_mismatch", fields: ["hkid"] };
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
    const dob = props.get("dateOfBirth");
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
        mark(key, [f], "skipped_low_confidence");
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
    for (const q of eligible) {
      const plan = planForQuestion(q, props);
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
        if (!prev.writes) {
          // TE-4：no_id_card 輸入嘅號碼已屬他人／同名唔同號 → 身份對唔上，計 skipped_identity_mismatch
          const idMismatch = q.kind === "no_id_card" && prev.impact.notes.some((n) => /hkid_belongs_to_other_guard|same_name_different_hkid|guard_hkid_differs|name_differs_from_guard/.test(n));
          mark(key, plan.fields, idMismatch ? "skipped_identity_mismatch" : "skipped_invalid");
          continue;
        }
        const followUp: FollowUpDraft | undefined = plan.rest.length > 0 ? { groupKey: `${q.groupKey}:rest`, restFields: plan.rest } : undefined;
        let followCreated = false;
        if (opts.dryRun) followCreated = !!followUp && !(await prisma.triageQuestion.findFirst({ where: { sessionId, groupKey: followUp.groupKey }, select: { id: true } }));
        else followCreated = !!(await submitAnswer(actor, q, plan.answer, prev.preview_hash, caps, opts.ip, { source: OCR_REREAD_SOURCE, ...(followUp ? { followUp } : {}) })).follow_up_created;
        mark(key, plan.fields, "applied");
        mark(key, plan.invalidFields, "skipped_invalid");
        counts.applied += 1;
        if (followUp) counts.applied_partial += 1;
        if (followCreated) counts.follow_up_created += 1;
      } catch (e) {
        // TE-4：no_id_card 輸入嘅號碼已屬他人（checkHkidOwner 422）＝身份對唔上
        const ownerClash = q.kind === "no_id_card" && e instanceof ApiError && e.status === 422 && e.message.includes("身份證號已屬於另一位");
        mark(key, plan.fields, ownerClash ? "skipped_identity_mismatch" : dispOf(e));
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
