// WP-AI1：AI 助手工具層共用型別/helper。
//
// 每個工具都收 `AiToolContext`（帶住問嗰個人嘅 session＋預先計好嘅
// 收客價/出街價可見度）——「權限跟問嗰個人」嘅實現位置。`session` 型別
// 嚟自 `@/lib/rbac/requirePermission`（route 層 `requirePermission(req,
// "助手","view")` 已經驗證過先會行到呢度）。
import type { AuthedSession } from "../../rbac/requirePermission";
import { hasPermission } from "../../rbac/requirePermission";
import type { Module } from "../../rbac/matrix";
import type { AiFieldVisibility } from "../field-scrub";

export interface AiToolContext {
  session: AuthedSession;
  fieldVisibility: AiFieldVisibility;
}

export interface ToolDenied {
  denied: true;
  message: string;
}

/** 工具層第二重擋雞頭（route 層 `助手` module 已經硬性 deny 雞頭/安員，
 * 呢度純粹 defense-in-depth——即使將來邊度改壞咗令雞頭 session 都撞得到
 * 呢個工具，都唔會漏任何數據出去）。 */
export function denyIfBroker(ctx: AiToolContext): ToolDenied | null {
  if (ctx.session.baseRole === "雞頭" || ctx.session.baseRole === "安員") {
    return { denied: true, message: "呢個角色唔可以使用 AI 助手。" };
  }
  return null;
}

// 規劃裁定（推翻咗 WP-AI1 執行時嘅第一版判斷）：AI 助手工具**要同畫面
// 權限一致**——「你冇權見嘅報表，助手都唔答」。老闆話「全能解答」係指
// 能力範圍（讀操作說明＋讀真實系統數據），唔係話可以繞過 RBAC 矩陣；
// 「主管出廠見唔到毛利即時表」呢類設定係老闆自己喺矩陣度定嘅，AI 助手
// 唔應該變成一條逕自繞過去嘅後門。所以每個工具（除咗
// `describe_system`——純文字說明，冇對應資源）都要 `requireModuleOrDenied()`
// 檢查返對應嘅 report/resource module（例如 `gross_margin`→「毛利即時
// 表」、`roster`→「更表」……逐個工具檔案頂註解列明），先至再疊 field-
// group gate（收客價/出街價）決定邊啲*數字*見唔見得到。
export async function requireModuleOrDenied(ctx: AiToolContext, mod: Module): Promise<ToolDenied | null> {
  const broker = denyIfBroker(ctx);
  if (broker) return broker;
  const granted = await hasPermission(ctx.session, mod, "view");
  if (!granted) {
    return { denied: true, message: `你冇權睇「${mod}」，呢個問題答唔到。` };
  }
  return null;
}

export function toolResultJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function deniedResult(d: ToolDenied): string {
  return toolResultJson({ error: "permission_denied", message: d.message });
}

// ---------------------------------------------------------------------------
// WP-AI3 老闆 feedback（正式站助手）：雞頭顯示名／雞頭費未拆判斷——
// `rate_cards`／`explain_rate_card`／`broker_stats`／`site_overview` 共用。
//
// 1. 雞頭顯示名——之前工具淨係俾 `broker_code`（K/W/…/B07 呢類內部代
//    號），模型見到乜就照抄乜，答案成日出返個代號俾用戶（用戶睇唔明
//    「B07」係乜）。內部桶（`internal_longterm`/`internal_cash`）本身
//    冇一個有意義嘅「名」——`brokers.name` 對呢類 row 淨係同 `code`
//    一樣嘅佔位符（例如 B07 嘅 name 都係 "B07"），所以用 kind 揀一個
//    業務用語（「公司長工」／「公司兵」）代替；真係有真名（`name` 唔等
//    於 `code`）嘅雞頭（例如外判判頭）就用返個真名——呢個系統一路都
//    准雞頭/安員嘅名（唔係電話/銀行資料/密碼/OTP）流去 AI 助手，見
//    `docs/ai-assistant.md`/`system-prompt.ts` 鐵律 7。
//
// 2. 雞頭費未拆判斷——真數據查證：部分盤（例如啟航1331）啲卡源頭係
//    「總表外判價／糧單合計」，冧埋做一嚿出街價，冇拆開保安員工資／
//    雞頭費兩截——`broker_fee` 顯示 0 或 null 唔係「雞頭費真係 0」，
//    係源頭資料本身冇拆呢層。
// ---------------------------------------------------------------------------

// 刻意唔 import `@prisma/client` 嘅 `BrokerKind`——`src/lib/ai/tools/**`
// 唯讀邊界完全唔碰 Prisma（見 tests/ai-structural-guard.test.ts），呢個
// union 用字面量抄一份就得，同 `prisma/schema.prisma` 嘅 `enum
// BrokerKind` 保持同步（5 個值，改嗰邊要記得改埋呢度）。
export type BrokerKindLiteral = "broker" | "internal_cash" | "internal_longterm" | "external" | "special";

export const FEE_SPLIT_NOTE = "呢個盤嘅出街價未拆開保安員工資同雞頭費（源頭只有合計），只可以俾合計數。";

/** 老闆 feedback（正式站第四輪 live 驗收）：`internal_longterm`（「公司
 * 長工」桶）唔係逐更出街價——`shift_records` 嘅 guard_wage_snapshot／
 * broker_fee_snapshot 對呢桶通常淨係 0（薪金唔係逐更 snapshot，係月薪，
 * 喺毛利即時表嗰邊做「長工月薪分攤」計），之前將呢個 0 直接回俾模型，
 * 模型會答「出街價 0」——而家逐個工具（broker_stats／site_overview）
 * 對呢桶嘅逐更出街價欄一律回 null，帶呢句 note 講明係月薪，唔計出街價。 */
export const LONGTERM_PAYOUT_NOTE = "月薪長工，唔計逐更出街價（成本係月薪分攤，見毛利表）。";

export type FeeSplit = "split" | "combined";

/** pg 驅動對 numeric/decimal 欄位預設用字串返（避免精度損失）——呢個
 * helper 逐個工具都要用，統一擺一個地方轉。 */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 「未拆」判斷——`broker_fee` 為 null/0，*且*出街價約等於保安員工資
 * （即係全部金額落咗喺 `guard_wage` 度，`broker_fee` 冧埋一齊冇拆）。 */
export function feeSplitStatus(params: { guardWage: unknown; brokerFee: unknown; payoutRate: unknown }): FeeSplit {
  const wage = toNum(params.guardWage);
  const fee = toNum(params.brokerFee);
  const payout = toNum(params.payoutRate) ?? (wage !== null ? wage + (fee ?? 0) : null);
  const feeIsZeroOrNull = fee === null || fee === 0;
  const payoutApproxWage = wage !== null && payout !== null && Math.abs(payout - wage) < 0.01;
  return feeIsZeroOrNull && payoutApproxWage ? "combined" : "split";
}

/** 雞頭顯示名——`name`/`code`/`kind` 嚟自 `ai.brokers` view（或者
 * Prisma `Broker`）嘅同名欄。 */
export function brokerDisplayName(b: { name: string | null | undefined; code: string | null | undefined; kind: string | null | undefined }): string {
  if (b.kind === "internal_longterm") return "公司長工";
  if (b.kind === "internal_cash") return "公司兵";
  if (b.name && b.name !== b.code) return b.name;
  if (b.kind === "external") return "客戶自己嘅人";
  if (b.kind === "special") return "特殊結算單位";
  return "外判公司"; // kind==="broker" 但冇填真名嘅 fallback（seed 資料理論上唔應該出現）
}

/** 逐 kind 嘅業務用語對照（`brokers.kind` → 顯示用語），俾要自己組
 * display name（唔經 `brokerDisplayName()`）嘅地方用，例如逐雞頭列
 * 表要保留返個人名之餘都想知道類別。 */
export const BROKER_KIND_LABEL: Record<BrokerKindLiteral, string> = {
  broker: "外判判頭",
  internal_cash: "公司兵",
  internal_longterm: "公司長工",
  external: "客戶自己嘅人",
  special: "特殊結算單位",
};

/** `aiQuery()` 嘅 row 型別預設淨係 `{[column:string]: any}`（pg 嘅
 * `QueryResultRow`，index signature，冇實際欄位名）——同呢種型別
 * spread 加多幾個具名欄，TS 對個結果型別嘅推斷有時會走盲（跌返齋得
 * 嗰幾個新欄，冇晒原本 index signature），要顯式標返個交集型別先可以
 * 之後照樣用 `row.xxx` 攞返原本嘅欄。`rate_cards`／`explain_rate_card`／
 * `broker_stats`／`site_overview` 逐個工具帶住雞頭 row 嗰陣共用呢個。 */
export function withFeeSplit<T extends Record<string, unknown>>(
  raw: T,
  broker: { name: unknown; code: unknown; kind: unknown },
  fee: { guardWage: unknown; brokerFee: unknown; payoutRate: unknown },
): T & { broker_display_name: string; fee_split: FeeSplit; fee_split_note: string | null } {
  const feeSplit = feeSplitStatus({ guardWage: fee.guardWage, brokerFee: fee.brokerFee, payoutRate: fee.payoutRate });
  return {
    ...raw,
    broker_display_name: brokerDisplayName({ name: broker.name as string | null, code: broker.code as string | null, kind: broker.kind as string | null }),
    fee_split: feeSplit,
    fee_split_note: feeSplit === "combined" ? FEE_SPLIT_NOTE : null,
  };
}
