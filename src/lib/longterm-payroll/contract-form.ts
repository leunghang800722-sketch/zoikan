// P17.4：長工糧「合約」tab 編輯表單嘅純函數（client-safe，冇 DB）。
// 正式站兩個 bug：(1) API 回 ISO 日期時間（2026-08-31T00:00:00.000Z），塞入 <input type=date> 會顯示空白，
// 用戶以為已清空，其實 state 仍係舊值 → 清唔到結束日；(2) 4xx（尤其 409 contract_overlap）錯誤只喺頁頂 Banner，
// 表單位置睇唔到。
/** <input type="date"> 只收 YYYY-MM-DD；API 回嘅 ISO 日期時間要截走時間部分。 */
export function dateInputValue(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : "";
}

/** 編輯合約 PATCH body：結束日留空＝送 `effective_to: null`（清空＝仲生效），唔係唔送。 */
export function contractPatchBody(salary: string, effectiveTo: string): { monthly_salary: number; effective_to: string | null } {
  return { monthly_salary: Number(salary), effective_to: effectiveTo.trim() ? effectiveTo.trim() : null };
}

/** 合約 POST／PATCH 4xx 嘅顯示文字；409 contract_overlap 補「要先結束／作廢另一段」提示（message 已列出重疊合約日期）。 */
export function contractErrorMessage(res: { status: number; error: string; message: string }): string {
  if (res.status === 409 && res.error === "contract_overlap") return `${res.message}（要先結束或作廢另一段合約，或者改日期，先儲存得）`;
  return res.message;
}
