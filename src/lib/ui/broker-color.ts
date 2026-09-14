// WP-R1：雞頭配色——README「共用元件」定咗 B07／K／W／Y 四個固定色；
// 其餘雞頭代號（G／T／D／B09／B10…）冇喺 design handoff 定義，用固定
// 調色盤按代號 hash 穩定分配（Fable 規劃判斷，見 P2-版面重設計計劃.md
// §2：「同一代號永遠同一色」，唔需要問老闆）。
export interface BrokerColorStyle {
  /** 8px 方點／圓點用嘅實色（例如雞頭統計卡、手機 chip）。 */
  dot: string;
  /** pill／chip 底色。 */
  bg: string;
  /** pill／chip 字色。 */
  fg: string;
}

const FIXED: Record<string, BrokerColorStyle> = {
  B07: { dot: "#2563eb", bg: "#dbeafe", fg: "#1e40af" },
  K: { dot: "#0f766e", bg: "#ccfbf1", fg: "#0f766e" },
  W: { dot: "#b45309", bg: "#fef3c7", fg: "#92400e" },
  Y: { dot: "#6d28d9", bg: "#ede9fe", fg: "#5b21b6" },
};

// 至少 6 種，同 FIXED 嗰四種顏色系分開，避免混淆。
const PALETTE: BrokerColorStyle[] = [
  { dot: "#0369a1", bg: "#e0f2fe", fg: "#075985" }, // 天藍
  { dot: "#15803d", bg: "#dcfce7", fg: "#166534" }, // 綠
  { dot: "#a21caf", bg: "#fae8ff", fg: "#86198f" }, // 洋紅
  { dot: "#b91c1c", bg: "#fee2e2", fg: "#991b1b" }, // 紅
  { dot: "#c2410c", bg: "#ffedd5", fg: "#9a3412" }, // 橙
  { dot: "#4338ca", bg: "#e0e7ff", fg: "#3730a3" }, // 靛
];

const FALLBACK: BrokerColorStyle = { dot: "#94a3b8", bg: "#f1f5f9", fg: "#475569" };

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** `code` 係雞頭代號（例：B07／K／自訂代號）；冇代號時回中性灰。同一
 * 代號永遠回同一組顏色（FIXED 表冇嘅先用 hash 揀 PALETTE）。 */
export function brokerColor(code: string | null | undefined): BrokerColorStyle {
  if (!code) return FALLBACK;
  const upper = code.toUpperCase();
  if (FIXED[upper]) return FIXED[upper];
  return PALETTE[hashCode(upper) % PALETTE.length];
}
