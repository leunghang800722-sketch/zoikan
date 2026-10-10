// WP-TERM-GUARD：permission module key → 顯示用字。key 本身（存喺 roles 權限矩陣、
// requirePermission 參數、DB `permissions.module`）一律不變；只有「畀人睇」嘅位
// （角色權限頁、403 訊息）經呢個對照表出「保安員…」。
export const MODULE_LABELS: Readonly<Record<string, string>> = {
  安員: "保安員",
  安員個人資料: "保安員個人資料",
  安員批量導入: "保安員批量導入",
  安員配對修復: "保安員配對修復",
  安員銀行資料: "保安員銀行資料",
  自己保安員: "自己保安員",
};

export function moduleLabel(key: string): string {
  return MODULE_LABELS[key] ?? key.replace(/(?<!保)保安員/g, "保安員");
}

/** 角色名（base_role／自訂角色名）顯示：內部識別「保安員」→ 顯示「保安員」。 */
export function roleDisplay(name: string): string {
  return name.replace(/(?<!保)保安員/g, "保安員");
}
