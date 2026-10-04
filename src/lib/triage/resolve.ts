// WP-AI-OPS §28.4：題目＋答案 → 現有導入路徑嘅輸入（單人導入包＋逐欄 decisions＋強制對齊）。
// 重點：答案唔會直接 update DB——一律變成 `applyOnePerson`（同批量導入共用 applyPerson：只寫 confirmed／
// 已決定欄、hkid／電話唯一、writeAuditTx），所以預覽（dry-run）同實際寫入係同一條 code path。
import { BadRequest } from "@/lib/api/errors";
import { canonicalHkid, hkidCheckDigitValid } from "@/lib/guards/identity";
import type { FieldDecision, ForcedMatch, PersonDecisions } from "@/lib/guards/import/apply";
import { fieldValue, type ImportPackage, type PackagePerson } from "@/lib/guards/import/package";
import { normTel8, normZh, parseBirthDate } from "@/lib/guards/import/text";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import type { QuestionEvidence, QuestionKind, QuestionOption, ReviewField, TriageAnswer } from "./types";

export interface ResolvedWrite {
  mode: "write";
  pkg: ImportPackage;
  key: string;
  decisions?: Record<string, PersonDecisions>;
  forced?: Record<string, ForcedMatch>;
  autoKeepPendingName: boolean;
}
export type Resolved = { mode: "skip" } | ResolvedWrite;

interface QuestionLike {
  kind: QuestionKind;
  evidence: QuestionEvidence;
  options: QuestionOption[];
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
      if (!answer.guard_id) throw BadRequest("要揀邊個現有安員");
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
    default:
      throw BadRequest("唔支援嘅選項");
  }

  return {
    mode: "write",
    pkg: { version: 2, generatedAt: "triage", persons: [person] },
    key,
    ...(Object.keys(dec).length ? { decisions: { [key]: dec } } : {}),
    ...(forced ? { forced: { [key]: forced } } : {}),
    autoKeepPendingName,
  };
}
