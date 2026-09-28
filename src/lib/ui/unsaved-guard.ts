// P2 整合驗收①：更表有未儲存改動時，撳左欄／麵包屑／手機抽屜嘅
// `<Link>` 會直接 client-side 導航跳走，唔會觸發 `beforeunload`（嗰個淨係
// 擋得到成頁關閉／重新整理），改動會靜靜哋遺失。呢個 module 做一個
// module-level 全域 store——`RosterEditor` 有未儲存改動就 `setUnsavedCount()`
// 寫低幾多格未儲存，全站任何 nav 連結（經 `GuardedLink`，見
// `@/components/ui/GuardedLink`）撳落去之前都問返 `confirmLeaveIfUnsaved()`，
// 同 `RosterEditor` 自己嘅 `goMonth`／手機頁首「‹」用返同一份狀態，唔使
// 兩邊各自維護一份 dirty 數。
//
// 純 module-level 變數（唔係 React state／context）——呢個 store 要俾
// *唔知道* RosterEditor 存唔存在嘅 nav component（DesktopNav／MobileNav，
// 呢兩個掛喺 `(app)/layout.tsx`，成個站每一頁都有，包括未進入任何更表
// 編輯器嘅頁面）讀到，用 React state／context 就要成個站都包一層
// provider，殺雞用牛刀；淨係一個模組級變數＋幾個 function 就夠。

let unsavedCount = 0;

/** `RosterEditor` 嘅 `dirtyCount` 變化時 call（包括 unmount 歸零）。 */
export function setUnsavedCount(n: number): void {
  unsavedCount = n;
}

/** 冇未儲存改動就直接放行（true）；有就彈 `window.confirm`，用戶揀「取消」
 * 就擋（false）。淨係喺 client 用（`window` 存在）。 */
export function confirmLeaveIfUnsaved(): boolean {
  if (unsavedCount <= 0) return true;
  return window.confirm(`有 ${unsavedCount} 格未儲存，離開會遺失，確定？`);
}
