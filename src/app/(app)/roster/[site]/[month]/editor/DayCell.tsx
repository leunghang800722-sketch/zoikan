"use client";

import { memo } from "react";

// WP-R2 第 13 項：格仔（`<td>` 一格代表一日一行）抽做獨立 `memo` 元件，
// props 淨係傳原始值（string/number/boolean）同穩定嘅 callback（useCallback
// 過），等其他格改動（例如揀第二格）唔使成個表重新 render 每一粒格。
type DayCellProps = {
  r: number;
  d: number;
  rowKey: string;
  code: string | null;
  isDirty: boolean;
  selected: boolean;
  inRange: boolean;
  isError: boolean;
  chipBg: string;
  chipFg: string;
  chipBorder: string | undefined;
  monthLocked: boolean;
  compact: boolean;
  dayColW: number;
  rowH: number;
  colBg: string | undefined;
  isToday: boolean;
  isWeekend: boolean;
  isEditingHere: boolean;
  editText: string;
  /** P2 整合驗收應修②：compact 實體鍵盤打緊嘅未完成代號（唔開 inline
   * input，淨係細字顯示緊喺格入面），`undefined`＝呢格冇打緊。 */
  keyBufferText: string | undefined;
  title: string | undefined;
  onCellMouseDown: (r: number, d: number, e: { shiftKey: boolean }) => void;
  onCellMouseEnter: (r: number, d: number) => void;
  onCellClick: (r: number, d: number, shiftKey: boolean) => void;
  onCellDoubleClick: (r: number, d: number) => void;
  onContextMenu: (r: number, d: number, x: number, y: number) => void;
  onEditTextChange: (v: string) => void;
  onCommitEdit: () => void;
};

export const DayCell = memo(function DayCell(props: DayCellProps) {
  const {
    r,
    d,
    code,
    isDirty,
    selected,
    inRange,
    isError,
    chipBg,
    chipFg,
    chipBorder,
    monthLocked,
    compact,
    dayColW,
    rowH,
    colBg,
    isToday,
    isWeekend,
    isEditingHere,
    editText,
    keyBufferText,
    title,
    onCellMouseDown,
    onCellMouseEnter,
    onCellClick,
    onCellDoubleClick,
    onContextMenu,
    onEditTextChange,
    onCommitEdit,
  } = props;
  const tdBg = isError ? "var(--zk-danger-border)" : colBg;
  // 三層可以同時出現、唔會互撞：選中＝outline（藍）；dirty＝inset ring
  // box-shadow（琥珀色 #f59e0b）；draft／請假＝chip 自己嘅 border（喺
  // chip span 層，唔喺呢度，draft 虛線藍／請假虛線橙）。
  //
  // P2 整合驗收應修①：dirty ring 原本同「選中」outline 一樣用
  // `#2563eb`（藍），兩層又同色又貼埋，肉眼分唔清邊個係邊個；而且藍色
  // 又同 draft 嘅虛線藍撞。改做琥珀色 `#f59e0b`（同「請假」chip 嘅虛線
  // 橙同色系但唔同形狀——請假係內層 chip 嘅虛線細框，dirty 係成格嘅實
  // 線 inset ring，唔會混淆），令「呢格未儲存」呢個狀態同「呢格揀緊」
  // 完全用唔同顏色，一眼分得出。
  const shadows: string[] = [];
  if (isDirty) shadows.push("inset 0 0 0 2px var(--zk-amber)");
  if (inRange && !selected) shadows.push("inset 0 0 0 9999px rgba(37,99,235,.08)");
  return (
    <td
      className={`text-center align-middle cursor-cell ${monthLocked ? "cursor-not-allowed" : ""}`}
      style={{
        width: dayColW,
        height: rowH,
        background: tdBg,
        outline: selected ? "2px solid var(--zk-primary)" : undefined,
        outlineOffset: selected ? -2 : undefined,
        boxShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
      }}
      title={title}
      data-testid={`roster-cell-${r}-${d}`}
      data-dirty={isDirty || undefined}
      data-today={isToday || undefined}
      data-weekend={isWeekend || undefined}
      onMouseDown={(e) => onCellMouseDown(r, d, { shiftKey: e.shiftKey })}
      onMouseEnter={() => onCellMouseEnter(r, d)}
      onClick={(e) => onCellClick(r, d, e.shiftKey)}
      onDoubleClick={() => onCellDoubleClick(r, d)}
      onContextMenu={(e) => {
        // P2 整合驗收「可接受 1 順手」：以前 `monthLocked` 就直接 `return`，
        // 冇行到 `preventDefault()`，鎖定月份右鍵會彈瀏覽器原生選單
        // （不一致——未鎖定嗰陣一定唔會見到原生選單）。改做一律先
        // `preventDefault()`，先至判斷鎖定與否決定使唔使開自己個選單。
        e.preventDefault();
        if (monthLocked) return;
        onContextMenu(r, d, e.clientX, e.clientY);
      }}
    >
      {isEditingHere ? (
        <input
          autoFocus
          className="h-full w-full bg-white text-center outline-none"
          value={editText}
          maxLength={4}
          onChange={(e) => onEditTextChange(e.target.value.toUpperCase())}
          onBlur={onCommitEdit}
        />
      ) : keyBufferText ? (
        // P2 整合驗收應修②：打緊未完成嘅多字代號（例如打咗「S」仲等緊
        // 「H」）——細字顯示喺格入面，蓋過原本個 chip（等夠鐘／打夠／
        // Enter 先變返正式 chip）。
        <span data-testid="roster-cell-key-buffer" className="text-zk-xs font-semibold text-zk-warning-darker">
          {keyBufferText}
        </span>
      ) : (
        code && (
          <span
            className="inline-block font-semibold"
            style={{
              fontSize: compact ? 12 : 11,
              minWidth: compact ? 28 : 22,
              padding: compact ? "5px 0" : "3px 0",
              borderRadius: compact ? 6 : 5,
              background: chipBg,
              color: chipFg,
              border: chipBorder,
            }}
          >
            {code}
          </span>
        )
      )}
    </td>
  );
});
