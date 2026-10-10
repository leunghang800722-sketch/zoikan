// 更表編輯器右鍵選單（清除／整行填／整行清）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { menuItemBtn } from "@/components/ui/button-classes";
import type { CellState, RowMeta } from "./roster-types";
import { cellKeyOf } from "./roster-utils";

export function ContextMenu({
  contextMenu,
  visibleRows,
  cells,
  clearSelectedRange,
  closeContextMenu,
  setFillRowKey,
  setFillRowValue,
  applyFillRow,
}: {
  contextMenu: { r: number; d: number; x: number; y: number } | null;
  visibleRows: RowMeta[];
  cells: Map<string, CellState>;
  clearSelectedRange: () => void;
  closeContextMenu: () => void;
  setFillRowKey: (key: string | null) => void;
  setFillRowValue: (v: string) => void;
  applyFillRow: (row: RowMeta, rawCode: string) => void;
}) {
  return (
    <>
      {contextMenu &&
        (() => {
          const row = visibleRows[contextMenu.r];
          if (!row) return null;
          const cellCode = cells.get(cellKeyOf(row.key, contextMenu.d))?.code ?? "";
          const menuWidth = 152;
          const left = typeof window !== "undefined" ? Math.min(contextMenu.x, window.innerWidth - menuWidth - 8) : contextMenu.x;
          const top = typeof window !== "undefined" ? Math.min(contextMenu.y, window.innerHeight - 140) : contextMenu.y;
          return (
            <div
              data-testid="roster-context-menu"
              className="fixed z-50 rounded-md border border-zk-border bg-white py-1 text-zk-base text-zk-text"
              style={{ left, top, width: menuWidth, boxShadow: "0 6px 20px rgba(15,23,42,.15)" }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                type="button"
                className={menuItemBtn}
                onClick={() => {
                  clearSelectedRange();
                  closeContextMenu();
                }}
              >
                清除所選
              </button>
              <button
                type="button"
                className={menuItemBtn}
                onClick={() => {
                  setFillRowKey(row.key);
                  setFillRowValue(cellCode);
                  closeContextMenu();
                }}
              >
                整行填
              </button>
              <button
                type="button"
                className={menuItemBtn}
                onClick={() => {
                  applyFillRow(row, "");
                  closeContextMenu();
                }}
              >
                整行清
              </button>
            </div>
          );
        })()}
    </>
  );
}
