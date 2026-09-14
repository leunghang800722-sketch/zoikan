// P2-B 應修⑤：`BROKER_KIND_LABEL` 由 `src/lib/ai/tools/common.ts` 搬嚟呢度
// （UI 層唔應該 import `ai/` 目錄——`src/lib/ai/tools/**` 係 AI 助手工具層
// 專用嘅唯讀邊界，見 `tests/ai-structural-guard.test.ts`；UI 頁面 import
// 嗰邊嘅 code 方向反咗）。`ai/tools/common.ts` 而家由呢度 re-export（見
// 該檔案），內容冇改，純粹搬地方，兩邊都用返同一份 object。
export type BrokerKindLiteral = "broker" | "internal_cash" | "internal_longterm" | "external" | "special";

/** 逐 kind 嘅業務用語對照（`brokers.kind` → 顯示用語）。 */
export const BROKER_KIND_LABEL: Record<BrokerKindLiteral, string> = {
  broker: "外判判頭",
  internal_cash: "公司兵",
  internal_longterm: "公司長工",
  external: "客戶自己嘅人",
  special: "特殊結算單位",
};

// README §14「種類 pill」欄——公司兵／公司長工 藍，外判／其他一律灰。
export type BrokerKindPillTone = "blue" | "neutral";

export function brokerKindPillTone(kind: string | undefined): BrokerKindPillTone {
  return kind === "internal_cash" || kind === "internal_longterm" ? "blue" : "neutral";
}
