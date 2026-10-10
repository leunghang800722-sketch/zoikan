// 更表編輯器儲存成功 Toast（README §04）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

export function SaveToast({
  showSaveToast,
  saveToastNoSettlement,
  saveToastUnpriced,
  saveToastSettlementInferred,
}: {
  showSaveToast: boolean;
  saveToastNoSettlement: number | null;
  saveToastUnpriced: number | null;
  saveToastSettlementInferred: number | null;
}) {
  return (
    <>
      {showSaveToast && (
        <div
          data-testid="roster-save-toast"
          className="fixed bottom-5 right-5 z-50 rounded-md px-4 py-2.5 text-zk-base text-white"
          style={{
            // WP-PRICE／P0：有「冇結算單位」就用更搶眼嘅紅色（呢批更會喺
            // 糧明細完全消失，比「未定價」更嚴重）；有未定價格用警示色
            // （唔係「儲存成功」嗰隻深藍色）；B1-5：淨係「結算單位推算」
            // 優先序最低（用同一個警示色，唔算錯，淨係建議覆核）。
            background: saveToastNoSettlement ? "var(--zk-danger-dark)" : saveToastUnpriced ? "var(--zk-warning-darker)" : saveToastSettlementInferred ? "var(--zk-warning-darker)" : "var(--zk-text)",
            boxShadow: "0 6px 18px rgba(15,23,42,.3)",
          }}
        >
          {saveToastNoSettlement
            ? `已儲存 · ${saveToastNoSettlement} 格冇結算單位（唔會出現喺糧單，請盡快指定雞頭）`
            : saveToastUnpriced
              ? `已儲存 · ${saveToastUnpriced} 格未定價（冇對應價目卡）`
              : saveToastSettlementInferred
                ? `已儲存 · ${saveToastSettlementInferred} 格結算單位係推算出嚟，建議覆核`
                : "已儲存"}
        </div>
      )}
    </>
  );
}
