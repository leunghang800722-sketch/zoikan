// WP-AI-OPS §28.4：題目＋答案 → 現有導入路徑嘅輸入（單人導入包＋逐欄 decisions＋強制對齊）。
// 重點：答案唔會直接 update DB——一律變成 `applyOnePerson`（同批量導入共用 applyPerson：只寫 confirmed／
// 已決定欄、hkid／電話唯一、writeAuditTx），所以預覽（dry-run）同實際寫入係同一條 code path。
import { BadRequest } from "@/lib/api/errors";
import { canonicalHkid, hkidCheckDigitValid } from "@/lib/guards/identity";
import type { FieldDecision, ForcedMatch, PersonDecisions } from "@/lib/guards/import/apply";
import { fieldValue, type ImportPackage, type PackagePerson } from "@/lib/guards/import/package";
import { normTel8, normZh, parseBirthDate } from "@/lib/guards/import/text";
import type { ExtDecision } from "@/lib/guards/import/ext";
import { HKICL_BANK_OPTIONS } from "@/lib/longterm-payroll/hkicl-bank-codes";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { EXTRA_NAME_OPTIONS, type QuestionEvidence, type QuestionKind, type QuestionOption, type ReviewField, type TriageAnswer } from "./types";

export interface ResolvedWrite {
  mode: "write";
  pkg: ImportPackage;
  key: string;
  decisions?: Record<string, PersonDecisions>;
  forced?: Record<string, ForcedMatch>;
  autoKeepPendingName: boolean;
}
/** TE-13.1：dropped＝答案接受（剔走爭議工號／電話）但呢筆記錄冇身份資料、冇 link 目標 → 唔寫任何嘢、唔建人 */
export type Resolved = { mode: "skip" } | { mode: "dropped" } | ResolvedWrite;

interface QuestionLike {
  kind: QuestionKind;
  evidence: QuestionEvidence;
  options: QuestionOption[];
  /** 題目建立時已對到嘅現有保安員（link 目標）；冇＝新人 */
  targetGuardId?: string | null;
}

const CONFLICT_KINDS = new Set<QuestionKind>(["staffno_shared_by_persons", "dup_tel_across_persons", "group_name_differs", "package_conflict"]);
const REVIEW_PKG_KEY: Record<ReviewField, "nameZh" | "nameEn" | "dateOfBirth" | "phone" | "address"> = {
  nameZh: "nameZh",
  nameEn: "nameEn",
  dateOfBirth: "dateOfBirth",
  phone: "phone",
  address: "address",
};

function requireHkid(raw: string | null | undefined): string {
  const c = canonicalHkid(raw ?? null);
  if (!c || !hkidCheckDigitValid(c)) throw BadRequest("身份證號唔合法（格式或檢查碼唔啱）");
  return c;
}

function requireName(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v || !normZh(v)) throw BadRequest("請輸入中文姓名");
  return v;
}

export function resolveAnswer(q: QuestionLike, answer: TriageAnswer): Resolved {
  if (answer.option === "skip") return { mode: "skip" };
  const opt = q.options.find((o) => o.id === answer.option && (answer.option !== "link" || o.guard_id === answer.guard_id));
  if (!opt) throw BadRequest("呢個選項唔屬於呢條問題");

  const p0 = q.evidence.person;
  const person: PackagePerson = JSON.parse(JSON.stringify(p0)) as PackagePerson;
  const key = person.key;
  const dec: PersonDecisions = {};
  let forced: ForcedMatch | undefined;
  let autoKeepPendingName = false;
  let dropOnly = false;

  // 包內衝突類：人手確認咗，清走包內衝突標記（跨人衝突喺單人包入面本來就唔會再偵測到）
  if (CONFLICT_KINDS.has(q.kind)) person.conflicts = [];

  switch (answer.option) {
    case "use_package_hkid": {
      const c = requireHkid(fieldValue(person.hkid));
      person.hkid = { value: c, status: "confirmed" };
      if (person.rating === "fail") person.rating = "review";
      autoKeepPendingName = true;
      break;
    }
    case "enter_hkid": {
      const c = requireHkid(answer.value);
      person.hkid = { value: c, status: "confirmed" };
      if (person.rating === "fail") person.rating = "review";
      autoKeepPendingName = true;
      break;
    }
    case "use_package_name": {
      if (!fieldValue(person.nameZh)) throw BadRequest("導入包冇姓名，請輸入");
      dec.nameZh = { action: "confirm" };
      break;
    }
    case "enter_name":
      dec.nameZh = { action: "confirm", value: requireName(answer.value) };
      break;
    case "keep_pending":
      if (!fieldValue(person.nameZh)) throw BadRequest("導入包冇姓名，請輸入");
      dec.nameZh = { action: "keep_pending" };
      break;
    case "link": {
      if (!answer.guard_id) throw BadRequest("要揀邊個現有保安員");
      forced = { mode: "link", guardId: answer.guard_id };
      break;
    }
    case "create_new":
      forced = { mode: "create" };
      autoKeepPendingName = true;
      break;
    case "keep":
      break;
    case "drop_shared": {
      const shared = new Set((q.evidence.shared_staff_numbers ?? []).map(normalizeStaffNumber));
      person.staffNumbers = person.staffNumbers.filter((n) => !shared.has(normalizeStaffNumber(n.number)));
      if (q.evidence.shared_tel) person.phone = { value: null, status: "missing" };
      // TE-13.1：冇 confirmed 有效身份證、又冇 link 目標 → 淨係剔走爭議工號／電話，唔建人（create 路徑一定要 HKID）
      const hk = person.hkid.status === "confirmed" ? canonicalHkid(fieldValue(person.hkid)) : null;
      if (!(hk && hkidCheckDigitValid(hk)) && !q.targetGuardId) dropOnly = true;
      break;
    }
    case "apply_fields": {
      const allowed = new Set((q.evidence.review_fields ?? []).map((r) => r.field));
      const entries = Object.entries(answer.fields ?? {}) as [ReviewField, NonNullable<TriageAnswer["fields"]>[ReviewField]][];
      if (entries.length === 0) throw BadRequest("請最少對一個欄位作出決定");
      for (const [f, d] of entries) {
        if (!d || !allowed.has(f)) throw BadRequest("呢個欄位唔屬於呢條問題");
        if (d.action === "skip") {
          dec[REVIEW_PKG_KEY[f]] = { action: "skip" };
          continue;
        }
        const value = (d.value ?? fieldValue(person[REVIEW_PKG_KEY[f]]) ?? "").trim();
        if (!value) throw BadRequest("欄位值唔可以空");
        if (f === "dateOfBirth" && !parseBirthDate(value)) throw BadRequest("出生日期要係 YYYY-MM-DD 而且合理");
        if (f === "phone" && !normTel8(value)) throw BadRequest("電話要係 8 位香港電話");
        if (f === "nameZh") requireName(value);
        const fd: FieldDecision = { action: d.action, value };
        dec[REVIEW_PKG_KEY[f]] = fd;
      }
      break;
    }
    case "apply_ext_fields": {
      const allowed = new Set((q.evidence.ext_review ?? []).map((r) => r.key));
      const entries = Object.entries(answer.ext_fields ?? {});
      if (entries.length === 0) throw BadRequest("請最少對一個欄位作出決定");
      const ext: Record<string, ExtDecision> = {};
      for (const [k, c] of entries) {
        if (!allowed.has(k)) throw BadRequest("呢個欄位唔屬於呢條問題");
        // 用導入值＝replace（現值空＝補空；現值唔同＝覆蓋，要權限）；保留現值／跳過＝唔寫
        // 銀行例外：現值唔同要明確揀「取代現有戶口」（replace_existing）先 replace，否則只補空（confirm）
        ext[k] = c !== "use_import" ? "skip" : k === "bank" && !answer.replace_existing ? "confirm" : "replace";
      }
      dec.ext = ext;
      // 鎖定寫入目標＝題目建立時嘅 guard（唔重新評估對齊）
      if (q.evidence.guard_id) forced = { mode: "link", guardId: q.evidence.guard_id };
      break;
    }
    case "confirm_ext_identity": {
      if (q.kind !== "ext_identity_check") throw BadRequest("呢個選項唔屬於呢條問題");
      // 人手確認咗身份：包內 review 嘅新欄當 confirmed（仍然只補空欄，現值唔同＝conflict 唔覆蓋）
      const ext: Record<string, ExtDecision> = {};
      for (const r of q.evidence.ext_review ?? []) ext[r.key] = "confirm_id"; // 只繞過身份／銀行閘，唔繞過長工入職日期閘
      dec.ext = ext;
      if (q.evidence.guard_id) forced = { mode: "link", guardId: q.evidence.guard_id };
      break;
    }
    case "assign_bank": {
      const u = q.evidence.unassigned;
      if (q.kind !== "bank_identity_unknown" || !u) throw BadRequest("呢個選項唔屬於呢條問題");
      if (!answer.guard_id) throw BadRequest("要揀邊個保安員");
      forced = { mode: "link", guardId: answer.guard_id };
      // 人手已經揀咗戶口屬於邊個：呢度先將戶口當 confirmed 寫入（銀行名稱由 HKICL 編號推出）
      const bankName = HKICL_BANK_OPTIONS.find((b) => b.code === u.bankCode)?.nameZhShort ?? null;
      person.bank = {
        code: { value: u.bankCode, status: "confirmed" },
        name: { value: bankName, status: bankName ? "confirmed" : "missing" },
        accountNo: { value: u.accountNo, status: "confirmed" },
        payeeName: { value: u.payeeName, status: "confirmed" },
      };
      // 目標保安員已有唔同戶口：預設 confirm（衝突、唔覆蓋）；明確揀「取代現有戶口」先 replace
      dec.ext = { bank: answer.replace_existing ? "replace" : "confirm" };
      break;
    }
    default:
      throw BadRequest("唔支援嘅選項");
  }

  // TE-5：同名現有保安員要人手決定——連結（link_guard_id）或建新人（create_new）。唔准按姓名自動連結；仍然過 evaluate 嘅唯一性／身份矛盾檢查
  if (answer.extra && (answer.extra.link_guard_id || answer.extra.create_new)) {
    if (!EXTRA_NAME_OPTIONS.includes(answer.option) || answer.option === "keep") throw BadRequest("呢個選項唔使決定連結／建新人");
    if (answer.extra.link_guard_id && answer.extra.create_new) throw BadRequest("連結同建新人只可揀其中一個");
    if (forced) throw BadRequest("呢個選項已經指定咗連結／建新人");
    if (answer.extra.link_guard_id) forced = { mode: "link", guardId: answer.extra.link_guard_id };
    else {
      forced = { mode: "create" };
      autoKeepPendingName = true;
    }
  }

  // TE-3：補姓名（人手對住證據圖輸入）——直接當 confirmed 寫入包內 person；preview／answer 同一路徑
  if (answer.extra && (answer.extra.name_zh || answer.extra.name_en || answer.extra.dob)) {
    // TE-11：enter_name（輸入中文名）可以同時帶卡上英文名 extra.name_en；其他 extra 仍只限建人類選項
    const enterNameEn = answer.option === "enter_name" && !answer.extra.name_zh && !answer.extra.dob;
    if (!EXTRA_NAME_OPTIONS.includes(answer.option) && !enterNameEn) throw BadRequest("呢個選項唔使補姓名");
    // TE-3 S1：extra 只喺包內冇姓名／姓名未確認先接受（已確認嘅姓名唔俾人手蓋）
    const confirmed = (f: { value: string | null; status: string } | undefined) => !!f?.value && f.status === "confirmed";
    if ((answer.extra.name_zh && confirmed(person.nameZh)) || (answer.extra.name_en && confirmed(person.nameEn))) throw BadRequest("呢個人嘅姓名已經確認，唔使再補");
    if (answer.extra.name_zh) person.nameZh = { value: requireName(answer.extra.name_zh), status: "confirmed" };
    if (answer.extra.name_en) person.nameEn = { value: answer.extra.name_en.trim(), status: "confirmed" };
    // TE-4：OCR 重讀嵌入身份證副本一併帶出生日期（格式要合法）
    if (answer.extra.dob) {
      if (!parseBirthDate(answer.extra.dob)) throw BadRequest("出生日期格式唔啱（YYYY-MM-DD）");
      // TE-4.2 S1：包內出生日期已確認——唔同＝400，相同當冇事
      if (confirmed(person.dateOfBirth)) {
        // N1：兩邊先經 parseBirthDate 轉成日期再比（格式唔同但同一日唔算唔同）
        const a = parseBirthDate(person.dateOfBirth.value ?? "");
        const b = parseBirthDate(answer.extra.dob);
        const same = a && b ? a.getTime() === b.getTime() : person.dateOfBirth.value?.trim() === answer.extra.dob;
        if (!same) throw BadRequest("呢個人嘅出生日期已經確認，唔使再補");
      } else person.dateOfBirth = { value: answer.extra.dob, status: "confirmed" };
    }
  }

  if (dropOnly) return { mode: "dropped" };
  return {
    mode: "write",
    pkg: { version: 3, generatedAt: "triage", persons: [person] },
    key,
    ...(Object.keys(dec).length ? { decisions: { [key]: dec } } : {}),
    ...(forced ? { forced: { [key]: forced } } : {}),
    autoKeepPendingName,
  };
}
