// P15 驗收 M1：同一保安員嘅生效合約日期唔准靜靜重疊（重疊會令加薪靜靜失效，計糧仍用舊合約）。
// 重疊檢查喺 route 內（transaction＋FOR UPDATE guard）做；區間以 [effectiveFrom, effectiveTo(null＝無限)] 計，只睇未作廢合約。
import { ApiError } from "@/lib/api/errors";

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface ContractLike {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export function overlapError(rows: ContractLike[], canClose: boolean): ApiError {
  return new ApiError(409, "contract_overlap", `同一保安員已有日期重疊嘅生效合約（${rows.map((r) => `${ymd(r.effectiveFrom)}～${r.effectiveTo ? ymd(r.effectiveTo) : "無結束日"}`).join("；")}）。${canClose ? "可勾選「自動結束上一段合約」（close_previous）先建立新合約" : "請先調整或作廢重疊嘅合約"}`, {
    overlapping: rows.map((r) => ({ id: r.id, effective_from: ymd(r.effectiveFrom), effective_to: r.effectiveTo ? ymd(r.effectiveTo) : null })),
    can_close_previous: canClose,
  });
}

/** 新段生效日前一日（UTC）。 */
export function dayBefore(d: Date): Date {
  return new Date(d.getTime() - DAY);
}

/** close_previous 只適用於：重疊合約全部較新段早開始，而且新段結束日唔短過佢哋（否則會令新段之後出現空檔）。 */
export function canAutoClose(rows: ContractLike[], from: Date, to: Date | null): boolean {
  return rows.every((r) => r.effectiveFrom.getTime() < from.getTime() && (r.effectiveTo === null ? to === null : to === null || r.effectiveTo.getTime() <= to.getTime()));
}
