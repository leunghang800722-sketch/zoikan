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
