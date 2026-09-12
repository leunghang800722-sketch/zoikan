// C3 field-level gate：冇「收客價」呢個 permission 嘅 session（例如主管
// 出廠設定）回應剝 client_rate*／special_items.revenue／月結營業額/毛利
// 呢類收客價相關數字——同雞頭嗰種「成個資源都見唔到」唔同，呢度係
// 「見到呢張 rate_card，但入面收客價嗰粒數冇」。
import type { AuthedSession } from "./requirePermission";
import { hasPermission } from "./requirePermission";

const CLIENT_RATE_SENSITIVE_FIELDS = ["clientRate", "clientRateSnapshot", "revenue"] as const;

export async function canViewClientRate(session: AuthedSession): Promise<boolean> {
  return hasPermission(session, "收客價", "view");
}

export async function canWriteClientRate(session: AuthedSession): Promise<boolean> {
  return hasPermission(session, "收客價", "update");
}

/** 冇 收客價:view 就剝走呢個 row 嘅收客價相關欄（唔改變其他欄）。 */
export async function applyClientRateViewGate<T extends Record<string, unknown>>(session: AuthedSession, row: T): Promise<T> {
  if (await canViewClientRate(session)) return row;
  const clone: Record<string, unknown> = { ...row };
  for (const f of CLIENT_RATE_SENSITIVE_FIELDS) delete clone[f];
  return clone as T;
}

export async function applyClientRateViewGateToList<T extends Record<string, unknown>>(
  session: AuthedSession,
  list: { rows: T[]; total: number; skip: number; take: number },
): Promise<{ rows: T[]; total: number; skip: number; take: number }> {
  if (await canViewClientRate(session)) return list;
  const rows = await Promise.all(list.rows.map((r) => applyClientRateViewGate(session, r)));
  return { ...list, rows };
}

/** body 入面帶咗 client_rate（camelCase: clientRate）就要求 收客價:update，冇就 403。 */
export async function assertClientRateWritable(session: AuthedSession, body: Record<string, unknown>): Promise<void> {
  const touchesClientRate = Object.prototype.hasOwnProperty.call(body, "clientRate") || Object.prototype.hasOwnProperty.call(body, "client_rate");
  if (!touchesClientRate) return;
  if (!(await canWriteClientRate(session))) {
    const { Forbidden } = await import("../api/errors");
    throw Forbidden("冇「收客價」寫入權限，唔可以改 client_rate");
  }
}
