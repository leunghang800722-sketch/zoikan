// WP-OCR-1：跨文件上下文（refs）——印刷證件已核實（confirmed）欄位值，注入入職表讀 A 嘅 prompt，並於 stage b 同入職表手寫值交叉核對。
// 純函數、零重 import（server / browser 都可以安全 import）。鐵則：refs 值只喺記憶體同簽名 token 內往返，唔寫 log／DB／audit。
import { OCR_CROSS_CHECK_FIELDS, OCR_CROSS_FIELDS, OCR_DOC_FIELDS, OCR_MAX_REF_VALUE_CHARS, OCR_REFS_FIELDS, type OcrDocType, type OcrFieldKey, type OcrRefsField } from "./config";
import { crossCheck, isUnclear, type CrossInfo, type CrossResult, type FieldResult, type SourceOfTruth } from "./normalize";

export type Refs = Partial<Record<OcrRefsField, string>>;
type CrossField = (typeof OCR_CROSS_FIELDS)[number];

/** 不可信字串消毒：NFKC、剔控制字元、折疊空白、截長度。 */
function sanitizeRefValue(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, OCR_MAX_REF_VALUE_CHARS);
}

/** 未信任 refs（token 內容、client 傳入）→ 只保留白名單欄位、消毒後非空嘅字串值。 */
export function sanitizeRefs(raw: unknown): Refs {
  const out: Refs = {};
  if (!raw || typeof raw !== "object") return out;
  const rec = raw as Record<string, unknown>;
  for (const k of OCR_REFS_FIELDS) {
    const v = sanitizeRefValue(rec[k]);
    if (v && !isUnclear(v)) out[k] = v;
  }
  return out;
}

export const refsCount = (r: Refs): number => Object.keys(r).length;

/**
 * 由一批已讀完嘅印刷文件（final 結果）抽 confirmed 欄位值。
 * 只收：status confirmed、而且係兩讀一致（冇 arbiter 標籤——仲裁 2/3 確認嘅唔算「兩讀一致」，較保守）、
 * 欄位屬於該文件類型嘅抽取欄、值非空。先出現者優先（呢度文件次序：身份證、住址證明）。
 */
export function confirmedRefsFromDocs(docs: readonly { type: OcrDocType; fields: Partial<Record<OcrFieldKey, FieldResult>> }[]): Refs {
  const out: Refs = {};
  for (const d of docs) {
    if (d.type === "onboarding_form") continue; // 手寫表本身唔當參考
    for (const k of OCR_REFS_FIELDS) {
      if (out[k] !== undefined || !OCR_DOC_FIELDS[d.type].includes(k)) continue;
      const f = d.fields[k];
      if (!f || f.status !== "confirmed" || f.arbiter) continue;
      const v = sanitizeRefValue(f.value);
      if (v) out[k] = v;
    }
  }
  return out;
}

export interface CrossOutcome {
  /** 入職表嘅欄：against id_card（address 欄 against address_proof） */
  form: Partial<Record<CrossField | "address", CrossInfo>>;
  /** 身份證嘅欄：against onboarding_form（additive，回應 `id_cross`；只有姓名／HKID／出生日期） */
  id: Partial<Record<CrossField, CrossInfo>>;
}

/**
 * 單欄交叉核對（入職表手寫 vs 證件／住址證明值）。保守：入職表欄只有 confirmed（兩讀一致）先拎值嚟比；
 * review／missing 一律 unreadable（讀 A 睇過 refs，讀 B 盲讀，兩讀唔一致就唔可以話「一致」）。
 * 靠仲裁 agree_a 先 confirmed 亦當 unreadable：仲裁收讀 A 候選，唔係獨立證據。
 */
export function crossForField(k: OcrFieldKey, f: Pick<FieldResult, "status" | "value" | "arbiter"> | undefined, refValue: string, now: Date = new Date()): CrossResult {
  return f && f.status === "confirmed" && f.arbiter !== "agree_a" ? crossCheck(f.value, refValue, k, now) : "unreadable";
}

/**
 * 入職表 reconcile 結果 vs refs → 交叉核對。有 refs 值先有該欄。
 * WP-OCR-1.3：地址（refs.address＝住址證明 confirmed 值）亦做 cross（against address_proof）；只做提示，唔改值。
 */
export function crossForOnboarding(refs: Refs, formFields: Partial<Record<OcrFieldKey, FieldResult>>, now: Date = new Date()): CrossOutcome {
  const out: CrossOutcome = { form: {}, id: {} };
  for (const k of OCR_CROSS_CHECK_FIELDS) {
    const rv = refs[k];
    if (!rv) continue;
    const result = crossForField(k, formFields[k], rv, now);
    if (k === "address") {
      out.form.address = { against: "address_proof", result };
      continue;
    }
    out.form[k] = { against: "id_card", result };
    out.id[k] = { against: "onboarding_form", result };
  }
  return out;
}

/** 彙整 cross 計數（audit／評估用）。 */
export function countCross(o: CrossOutcome): { match: number; differs: number; unreadable: number } {
  const c = { match: 0, differs: 0, unreadable: 0 };
  for (const x of Object.values(o.form)) if (x) c[x.result] += 1;
  return c;
}

/**
 * WP-OCR-1.3：每欄標示最終紀錄採用邊份文件（source_of_truth，additive）。老闆指示：身份證號／出生日期／中英文姓名一律以身份證為準；
 * 住址一律以住址證明為準（冇住址證明先用入職表手寫地址）；電話只有入職表。入職表手寫嘅姓名／HKID／出生日期只做交叉核對。
 * addressFromProof：入職表地址嘅標示——有（confirmed）住址證明值＝address_proof，否則 onboarding_form（伺服器 best-effort：住址證明 review 值伺服器唔入 refs，
 * 最終採用邊份由 client 按住址證明有冇值決定，同呢個標示一致時以 client 為準）。就地標記，唔改任何值。
 */
export function tagSourceOfTruth(type: OcrDocType, fields: Partial<Record<OcrFieldKey, FieldResult>>, addressFromProof = false): void {
  for (const [k, f] of Object.entries(fields) as [OcrFieldKey, FieldResult | undefined][]) {
    if (!f) continue;
    if (type === "id_card") f.source_of_truth = "id_card";
    else if (type === "address_proof") f.source_of_truth = "address_proof";
    else f.source_of_truth = (k === "name_zh" || k === "hkid" || k === "dob" ? "id_card" : k === "address" && addressFromProof ? "address_proof" : "onboarding_form") satisfies SourceOfTruth;
  }
}
