// WP-OCR-1.3：多份文件讀完之後，每個表單欄「最終採用邊份文件嘅值」（純函數，client／測試共用）。
// 老闆指示（來源優先）：身份證號碼、出生日期、中英文姓名一律以身份證為準；住址一律以住址證明為準（住址證明有 confirmed 或 review 值就用佢；
// 冇住址證明／讀唔到先用入職表手寫地址）；電話只有入職表。入職表手寫嘅姓名／HKID／出生日期／（有住址證明時嘅）地址只做交叉核對（cross＋唯讀顯示），
// 唔可以覆蓋證件值，亦唔會因為「唔一致」要求額外確認。
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "./config";
import type { CrossResult, FieldResult } from "./normalize";
import { crossForField } from "./refs";

type FieldLike = Pick<FieldResult, "status" | "value" | "arbiter"> & { cross?: { result: CrossResult } };
interface FieldPick<F extends FieldLike> {
  /** 最終採用嘅值來自邊份文件 */
  doc: OcrDocType;
  result: F;
  /** 同入職表手寫值交叉核對結果（冇手寫值／冇證件值＝undefined） */
  cross?: CrossResult;
  /** 入職表手寫值（只供唯讀顯示；讀到先有） */
  formValue?: string;
  /** WP-OCR-1.4：證件／住址證明呢欄 missing 或 review，入職表手寫值只係「參考」（唯讀顯示＋可一撳填入；唔自動填、唔改 value、來源仍係證件） */
  referenceOnly?: boolean;
}
export interface MergedFields<F extends FieldLike> {
  picks: Partial<Record<OcrFieldKey, FieldPick<F>>>;
  /** 地址採用邊份文件（兩份都冇＝null） */
  addrFrom: OcrDocType | null;
}

const ID_CROSS_FIELDS = ["name_zh", "hkid", "dob"] as const;

export function mergeDocFields<F extends FieldLike>(docs: ReadonlyMap<OcrDocType, { fields: Partial<Record<OcrFieldKey, F>> }>, now: Date = new Date()): MergedFields<F> {
  const picks: Partial<Record<OcrFieldKey, FieldPick<F>>> = {};
  const id = docs.get("id_card");
  const form = docs.get("onboarding_form");
  for (const k of OCR_DOC_FIELDS.id_card) {
    const r = id?.fields[k];
    if (r) picks[k] = { doc: "id_card", result: r, ...(r.cross ? { cross: r.cross.result } : {}) };
  }
  const phone = form?.fields.phone;
  if (phone) picks.phone = { doc: "onboarding_form", result: phone };
  // 入職表手寫姓名／身份證號／出生日期：只作唯讀顯示（讀到先顯示），絕不覆蓋身份證值
  for (const k of ID_CROSS_FIELDS) {
    const hv = form?.fields[k];
    const p = picks[k];
    if (!p || !hv || hv.status === "missing" || !hv.value.trim()) continue;
    if (p.cross !== undefined) p.formValue = hv.value;
    else if (p.result.status !== "confirmed") {
      // WP-OCR-1.4：證件欄 missing／review（冇 cross）→ 手寫值做唯讀參考，方便人手打字；值照舊係證件嘅 value（missing＝空）
      p.formValue = hv.value;
      p.referenceOnly = true;
    }
  }
  // 地址：住址證明有值（confirmed 或 review）就用佢；冇上載或者讀唔到先用入職表
  const proof = docs.get("address_proof")?.fields.address;
  const formAddr = form?.fields.address;
  let addrFrom: OcrDocType | null = null;
  if (proof && (proof.status !== "missing" || !formAddr || formAddr.status === "missing")) {
    const p: FieldPick<F> = { doc: "address_proof", result: proof };
    // 入職表手寫地址只做 cross：伺服器有算（refs.address＝住址證明 confirmed）就用佢；否則（住址證明 review）喺度用同一個純函數補算
    if (formAddr) {
      const hasForm = formAddr.status !== "missing" && formAddr.value.trim() !== "";
      if (hasForm) p.formValue = formAddr.value;
      if (hasForm && proof.status !== "confirmed") p.referenceOnly = true; // 住址證明 review：手寫地址只做參考（missing 時按來源規則直接用入職表地址）
      if (formAddr.cross) p.cross = formAddr.cross.result;
      else if (proof.status !== "missing" && proof.value.trim()) p.cross = crossForField("address", formAddr, proof.value, now);
    }
    picks.address = p;
    addrFrom = "address_proof";
  } else if (formAddr) {
    picks.address = { doc: "onboarding_form", result: formAddr };
    addrFrom = "onboarding_form";
  }
  return { picks, addrFrom };
}
