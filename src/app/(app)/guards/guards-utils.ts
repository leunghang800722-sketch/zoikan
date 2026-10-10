// 保安員名冊頁純函數（P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變）。
import { todayLocalStr } from "@/lib/ui/format";

/** Drawer tab 面板 class：揀中 tab 顯示，其餘 `hidden`（各區塊照舊 mount）。 */
export const tabClsFor = (drawerTab: string) => (t: string) => (drawerTab === t ? "space-y-3" : "hidden");

// WP-STAFFNO：乙類牌照過 70 歲失效——編輯抽屜「乙類到期」旁邊灰字
// 提示用（純前端顯示，真正「失效唔計」嘅邏輯喺後台
// `deriveSiaPermitExpiry()`，呢度淨係為咗即時 UI 提示，冇 `now` 參數
// 就用瀏覽器而家嗰刻，容許幾百毫秒嘅時區/時鐘噪音——呢個純粹係
// 提示文字，唔影響實際存落 DB 嘅值）。
// Fable5.1（4 個細修 3）：原本直接用 `now.getFullYear()`／`getMonth()`
// （瀏覽器本地時區）計歲數，同後台 `ageAsOfHk()`（
// src/lib/guards/staff-numbers.ts，一律用 `todayLocalStr()` 換做香港
// 時區嘅 YYYY-MM-DD 先計）唔一致——HK 00:00–08:00 呢段時間，如果用戶
// 部機本地時區唔係 HK（例如 UTC），前端提示可能同後台實際判斷差一
// 日。改用 `todayLocalStr(now)` 一致計法。
export function isAge70OrOlder(dobStr: string, now: Date = new Date()): boolean {
  if (!dobStr) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobStr);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number) as unknown as [number, number, number, number];
  const [ty, tm, td] = todayLocalStr(now).split("-").map(Number);
  let age = ty - y;
  if (tm < mo || (tm === mo && td < d)) age -= 1;
  return age >= 70;
}
// WP-PII（可接受但順手）：牌照（sia_permit_expiry）／平安卡
// （safety_card_expiry）兩個到期日一齊揀「較早」嗰一個嚟顯示/高亮——
// 一個保安員可以牌照仲有效但平安卡就快到期（或者反過嚟），淨係睇
// 牌照會漏警示。冇填嘅一邊當「冇呢個限制」，兩個都冇填先算「未填」。
//
// WP-MISC（老闆 2026-09-20 拍板）：QAS 到期日（qas_expiry_date）一齊
// 納入呢個「揀最近到期」嘅比較——擴成 variadic，唔止兩個。
export function earlierExpiry(...dates: Array<string | null | undefined>): string | null | undefined {
  let result: string | null | undefined;
  for (const d of dates) {
    if (!d) continue;
    if (!result || d < result) result = d; // "YYYY-MM-DD" 字串排序等同日期排序
  }
  return result;
}
