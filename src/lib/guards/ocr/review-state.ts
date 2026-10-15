// WP-GUARD-OCR §29（Opus 驗收 M1）：核對狀態純函數。
// 中文姓名、身份證號、出生日期三欄就算兩讀一致（confirmed）都要用戶逐欄撳「對過證件，啱」先算已確認
// （同一模型兩讀可以犯同一錯）；其他欄 confirmed 預設已確認但可改。「全部自己輸入」（OCR 狀態 missing）嘅欄由用戶自己打字，打字即算確認。
import { OCR_FIELDS, type OcrFieldKey } from "./config";
import { normalizeField, type FieldStatus } from "./normalize";

const CRITICAL_FIELDS: readonly OcrFieldKey[] = ["name_zh", "hkid", "dob"];
export const REQUIRED_FIELDS: readonly OcrFieldKey[] = ["name_zh", "hkid"];
export const CRITICAL_MSG = "請對住證件逐個確認姓名、身份證號、出生日期";

export const FIELD_LABEL: Record<OcrFieldKey, string> = { name_zh: "中文姓名", name_en: "英文姓名", hkid: "身份證號", dob: "出生日期", sex: "性別", phone: "電話", address: "地址" };

export const isCritical = (k: OcrFieldKey): boolean => CRITICAL_FIELDS.includes(k);

/** 辨識完成後欄位嘅初始確認狀態。 */
export function initialAck(k: OcrFieldKey, status: FieldStatus): boolean {
  return isCritical(k) ? false : status === "confirmed";
}

/** 用戶改值之後嘅確認狀態：關鍵欄（OCR 讀到過）改咗要重新撳確認；OCR 讀唔到／全人手模式打字即算確認。 */
export function ackAfterEdit(k: OcrFieldKey, ocrStatus: FieldStatus, newValue: string): boolean {
  if (isCritical(k) && ocrStatus !== "missing") return false;
  if (ocrStatus === "confirmed") return true;
  return newValue.trim() !== "";
}

export interface ReviewField {
  value: string;
  ack: boolean;
}

/** 格式錯誤訊息（空值唔報）。 */
export function fieldError(k: OcrFieldKey, v: string, reasonMsg: Record<string, string>): string | null {
  if (!v.trim()) return null;
  const n = normalizeField(k, v);
  return n.valid ? null : (reasonMsg[n.reason ?? ""] ?? "格式唔啱");
}

/** 仲有咩未處理（空陣列＝可以去預覽）。 */
export function reviewProblems(form: Record<OcrFieldKey, ReviewField>, reasonMsg: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of OCR_FIELDS) {
    const f = form[k];
    const v = f.value.trim();
    if (REQUIRED_FIELDS.includes(k) && !v) out.push(`${FIELD_LABEL[k]}要填`);
    else {
      const err = fieldError(k, v, reasonMsg);
      if (err) out.push(`${FIELD_LABEL[k]}：${err}`);
      else if (!f.ack) out.push(isCritical(k) && v ? `${FIELD_LABEL[k]}要對過證件確認` : `${FIELD_LABEL[k]}要確認`);
    }
  }
  return out;
}

/** 三個關鍵欄有冇未確認（有值但未撳「對過證件，啱」）。 */
export function criticalPending(form: Record<OcrFieldKey, ReviewField>): boolean {
  return CRITICAL_FIELDS.some((k) => !form[k].ack);
}

/** 身份證號分組顯示：A123456(3) → "A 123456 (3)"（等寬字大字用）。 */
export function groupHkid(v: string): string {
  const m = v.replace(/\s+/g, "").toUpperCase().match(/^([A-Z]{1,2})(\d{6})\(?([0-9A])\)?$/);
  return m ? `${m[1]} ${m[2]} (${m[3]})` : v;
}

// ---------- WP-OCR-4：候選 chip（一撳套用）＋字級分歧高亮 ----------

interface DiffSeg {
  ch: string;
  /** 呢個字同對方唔同（刪／換／加） */
  diff: boolean;
}
export interface CharDiff {
  a: DiffSeg[];
  b: DiffSeg[];
  /** max(a 嘅不同字數, b 嘅不同字數) */
  changed: number;
}

/** 逐字（code point）LCS 比對：回傳兩邊各字係咪屬於分歧位。純函數。 */
export function diffChars(a: string, b: string): CharDiff {
  const x = [...a];
  const y = [...b];
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const sa: DiffSeg[] = [];
  const sb: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      sa.push({ ch: x[i]!, diff: false });
      sb.push({ ch: y[j]!, diff: false });
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      sa.push({ ch: x[i]!, diff: true });
      i++;
    } else {
      sb.push({ ch: y[j]!, diff: true });
      j++;
    }
  }
  return { a: sa, b: sb, changed: Math.max(sa.filter((s) => s.diff).length, sb.filter((s) => s.diff).length) };
}

/** 兩個候選只差 1–2 個字（高亮分歧字先有意義）。 */
export function isCloseVariant(a: string, b: string, maxChanged = 2): boolean {
  if (!a || !b || a === b) return false;
  const d = diffChars(a, b);
  return d.changed >= 1 && d.changed <= maxChanged;
}

const MAX_CHIPS = 4;
export interface CandidateChip {
  value: string;
  /** 逐字分歧高亮（淨中文姓名／地址、同參考候選只差 1–2 字先有）；null＝唔高亮 */
  segs: DiffSeg[] | null;
}

/** review 欄嘅候選 chip：最多 4 個、去重；中文姓名／地址同第一個候選（第一個本身對第二個）比對高亮分歧字。 */
export function candidateChips(k: OcrFieldKey, candidates: readonly string[]): CandidateChip[] {
  const vals = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))].slice(0, MAX_CHIPS);
  const highlight = k === "name_zh" || k === "address";
  return vals.map((value, i) => {
    const ref = i === 0 ? vals[1] : vals[0];
    if (!highlight || !ref || !isCloseVariant(value, ref)) return { value, segs: null };
    const d = diffChars(value, ref);
    return { value, segs: d.a };
  });
}

const WRITTEN_LABEL: Record<string, string> = {
  hkid: "身份證號", name_zh: "中文姓名", name_en: "英文姓名", date_of_birth: "出生日期", phone: "電話", address: "地址",
  nameZh: "中文姓名", nameEn: "英文姓名", dateOfBirth: "出生日期", sex: "性別",
};

export interface ApplySummaryInput {
  guards_created: number;
  guards_updated: number;
  phones_added: number;
  addresses_added: number;
  staff_numbers_added?: number;
  fields_written?: Record<string, number>;
  counts_hidden?: boolean;
}

/** 完成提示：講清楚寫咗乜。新建人＝「已新增保安員：姓名、身份證號…」；連去現有＝「補咗…」。唔出英文 key（未知 key 顯示「其他資料」）。 */
export function applySummaryText(r: ApplySummaryInput): string {
  const labels: string[] = [];
  const add = (l: string) => {
    if (!labels.includes(l)) labels.push(l);
  };
  for (const [k, n] of Object.entries(r.fields_written ?? {})) if (n > 0) add(WRITTEN_LABEL[k] ?? "其他資料");
  if (r.phones_added > 0) add("電話");
  if (r.addresses_added > 0) add("地址");
  if ((r.staff_numbers_added ?? 0) > 0) add("工號");
  if (r.guards_created > 0) return labels.length ? `已新增保安員：${labels.join("、")}` : "已新增保安員";
  if (labels.length) return `補咗：${labels.join("、")}`;
  return r.counts_hidden ? "已提交（寫入結果要有保安員個人資料權限先睇到）" : "未有寫入任何資料（現有紀錄已齊，或者要人手處理）";
}
