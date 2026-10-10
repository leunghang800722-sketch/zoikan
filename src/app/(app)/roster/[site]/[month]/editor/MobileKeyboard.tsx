// 手機底部更別鍵盤（README §23）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import type { RowMeta } from "./roster-types";

export function MobileKeyboard({
  mobileKeypadRow,
  mobileKeypadDay,
  mobileKeypadKeys,
  monthNum,
  cancelKeyBuffer,
  applyMobileKeypadCode,
}: {
  mobileKeypadRow: RowMeta;
  mobileKeypadDay: number;
  mobileKeypadKeys: string[];
  monthNum: number;
  cancelKeyBuffer: () => void;
  applyMobileKeypadCode: (row: RowMeta, day: number, rawCode: string | null) => void;
}) {
  return (
    <>
        <div
          data-testid="roster-mobile-keypad"
          className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-zk-border bg-white px-4 py-3"
          style={{ boxShadow: "0 -4px 16px rgba(0,0,0,.08)" }}
        >
          <div className="text-xs text-zk-muted">
            {mobileKeypadRow.guardName || "(未命名)"} · {monthNum} 月 {mobileKeypadDay} 日 — 揀更別
          </div>
          {/* 第 8 項之後最多 6 個代號鍵＋1 個清除＝7 粒——用固定 4 欄
              grid（唔用 flex-wrap）令「清除」一定喺可預測位置（第二行
              最尾），唔會因為 flex-wrap 換行令掣數目唔同時跑位／喺
              MOBILE_KEYPAD_HEIGHT 估算高度以外。 */}
          <div className="grid grid-cols-4 gap-1.5">
            {mobileKeypadKeys.map((code) => {
              const isLeave = code !== mobileKeypadRow.shiftTypeCode;
              const s = shiftCodeStyle(code, { isLeave });
              return (
                <button
                  key={code}
                  type="button"
                  className="h-11 w-full rounded-lg text-zk-base font-semibold"
                  style={{
                    background: s.bg === "transparent" ? "var(--zk-card)" : s.bg,
                    color: s.fg === "transparent" ? "var(--zk-text)" : s.fg,
                    border: "1px solid var(--zk-border)",
                  }}
                  onClick={() => {
                    // 安全網：撳緊螢幕鍵盤嗰下，如果實體鍵盤仲有個 pending
                    // 嘅 buffer timer 未寫入，要即刻取消（唔係就可能兩邊
                    // 都寫，或者遲嚟嗰個 timer 蓋走撳掣寫嘅結果）。
                    cancelKeyBuffer();
                    applyMobileKeypadCode(mobileKeypadRow, mobileKeypadDay, code);
                  }}
                >
                  {code}
                </button>
              );
            })}
            <button
              type="button"
              className="h-11 w-full rounded-lg border border-zk-border bg-white text-xs text-zk-muted"
              onClick={() => {
                cancelKeyBuffer();
                applyMobileKeypadCode(mobileKeypadRow, mobileKeypadDay, null);
              }}
            >
              清除
            </button>
          </div>
        </div>
    </>
  );
}
