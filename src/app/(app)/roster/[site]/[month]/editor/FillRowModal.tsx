// 更表編輯器「整行填」對話框。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { Button } from "@/components/ui/Button";
import type { RowMeta } from "./roster-types";

export function FillRowModal({
  fillRowKey,
  fillRowValue,
  setFillRowKey,
  setFillRowValue,
  visibleRows,
  days,
  applyFillRow,
}: {
  fillRowKey: string | null;
  fillRowValue: string;
  setFillRowKey: (key: string | null) => void;
  setFillRowValue: (v: string) => void;
  visibleRows: RowMeta[];
  days: number;
  applyFillRow: (row: RowMeta, rawCode: string) => void;
}) {
  return (
    <>
      {fillRowKey && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={() => setFillRowKey(null)}>
          <div className="bg-white rounded shadow-lg p-4 w-72 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-zk-text-secondary">
              整行填滿（成個月 {days} 日全部填同一個代號）——更別代號或者請假代號（AL/NL/RD/SL/SH）；留空撳「填滿全行」＝整行清（成行清空）：
            </p>
            <input
              autoFocus
              data-testid="roster-fill-row-input"
              className="w-full border border-zk-input-border rounded px-2 py-1 text-sm uppercase"
              value={fillRowValue}
              onChange={(e) => setFillRowValue(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const row = visibleRows.find((r) => r.key === fillRowKey);
                  if (row) applyFillRow(row, fillRowValue);
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => setFillRowKey(null)}>
                取消
              </Button>
              <Button variant="primary" size="sm"
                type="button"

                onClick={() => {
                  const row = visibleRows.find((r) => r.key === fillRowKey);
                  if (row) applyFillRow(row, fillRowValue);
                }}
              >
                填滿全行
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
