// P3-4.2：非 `<Button>` 嘅專用按鈕 class——格仔表／鍵盤／icon／選單項／選擇 chip 專用，只准用呢幾個命名 class，唔好再手寫 className。
/** 純 icon／箭咀按鈕（‹ ›、✕）。 */
export const iconBtn = "inline-flex items-center justify-center px-1 text-zk-faint hover:text-zk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary disabled:opacity-40";
/** 彈出選單入面每一項。 */
export const menuItemBtn = "block w-full px-3 py-1.5 text-left hover:bg-zk-header disabled:opacity-40";
/** 手機大掣（鍵盤／對話框底部 sticky 動作）。 */
export const touchBtn = "flex h-[54px] flex-1 items-center justify-center rounded-xl text-zk-md font-semibold disabled:opacity-40";
/** 單選／多選 chip（選中＝藍框）。 */
export function choiceBtn(selected: boolean, extra = ""): string {
  return `rounded-[5px] border px-2 py-[3px] text-zk-xs ${selected ? "border-zk-primary bg-zk-primary-tint-soft font-semibold text-zk-primary" : "border-zk-border text-zk-text-secondary hover:bg-zk-header"} ${extra}`;
}
/** 純文字 tab／篩選切換（選中＝藍粗字）。 */
export function choiceBtnText(selected: boolean): string {
  return `text-zk-sm ${selected ? "font-semibold text-zk-primary" : "text-zk-muted"}`;
}
