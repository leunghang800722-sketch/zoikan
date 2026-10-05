// WP-GUARD-OCR §29（Opus 驗收 M1）：核對狀態純函數。
// 中文姓名、身份證號、出生日期三欄就算兩讀一致（confirmed）都要用戶逐欄撳「對過證件，啱」先算已確認
// （同一模型兩讀可以犯同一錯）；其他欄 confirmed 預設已確認但可改。「全部自己輸入」（OCR 狀態 missing）嘅欄由用戶自己打字，打字即算確認。
import { OCR_FIELDS, type OcrFieldKey } from "./config";
import { normalizeField, type FieldStatus } from "./normalize";

export const CRITICAL_FIELDS: readonly OcrFieldKey[] = ["name_zh", "hkid", "dob"];
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
  return r.counts_hidden ? "已提交（寫入結果要有安員個人資料權限先睇到）" : "未有寫入任何資料（現有紀錄已齊，或者要人手處理）";
}
