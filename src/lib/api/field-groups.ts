// Opus 對抗式驗收 M1/M2/M3/P4：收客價／出街價 field-level gate 嘅**中央**
// 定義——唔准逐 route 各自補（之前 `rbac/field-gates.ts` 淨係管
// rate_cards/special_items 兩個資源、掛漏 sites/shift_records/
// month_closes，同一個概念散落幾個 route 自己判斷，容易漏）。
//
// 呢個檔案淨係做「邊個資源嘅邊啲欄屬於邊個 field group」呢個**資料**
// 定義；`applyFieldGroupGate()`／`assertFieldGroupWritable()` 兩個函數
// 係**唯一**執行入口，全部 route 一律經呢兩個，唔准自己再寫一次
// `delete data.clientRate` 呢類散裝邏輯。
//
// key 用 **snake_case**（同 request/response body 嘅 wire format 一致，
// 見 src/lib/api/schemas.ts／src/lib/api/dto/）。
import type { AuthedSession } from "../rbac/requirePermission";
import { hasPermission } from "../rbac/requirePermission";
import { Forbidden } from "./errors";
import { brandSafeResponse, type Dto } from "./serialize";

export const CLIENT_RATE_FIELDS = {
  shift_records: ["client_rate_snapshot"],
  rate_cards: ["client_rate"],
  sites: ["monthly_fee"],
  special_items: ["revenue"],
  // month_closes 而家嘅 schema 仲未有營業額/毛利呢類聚合欄（呢啲喺
  // WP3/WP4 先會加落 site_monthly_summary 呢類報表 view）——呢度預留
  // 空陣列，等嗰陣加返欄嗰陣順手加落嚟就得，唔使改呢個機制本身。
  month_closes: [],
  // C2（Opus 對抗式驗收第四輪）：guards/brokers 冇「收客價」相關欄。
  guards: [],
  brokers: [],
  // P1-WP3（E）：referral_fee_rates 冇「收客價」性質嘅欄（呢個表淨係
  // 記公司俾雞頭嘅介紹費，唔係收客嗰邊）。
  referral_fee_rates: [],
} as const;

export const SETTLEMENT_FIELDS = {
  shift_records: [
    "guard_wage_snapshot",
    "broker_fee_snapshot",
    "rescue_rate",
    "referral_fee_snapshot",
    "settlement_page",
    "source",
    "provenance",
  ],
  // C2（Opus 對抗式驗收第四輪）：payout_rate（出街價｜俾雞頭嘅單價）之前
  // 漏咗喺呢個 list，冇出街價:view 都見到。
  rate_cards: ["guard_wage", "broker_fee", "payout_rate", "source", "evidence", "note"],
  sites: [],
  // C2：cost 係盤級支出（出街價性質嘅金錢），之前漏咗。
  special_items: ["cost"],
  month_closes: [],
  // C2：guards.monthly_salary（長工月薪，出街價性質嘅人力成本）、
  // brokers.bank_info（雞頭銀行戶口）之前完全冇經呢個機制——GET guards／
  // GET brokers 嘅內部角色 DTO（toGuardFullDTO／toBrokerFullDTO）冇
  // 出街價:view 都會見到成個 monthly_salary／bank_info。
  guards: ["monthly_salary"],
  brokers: ["bank_info"],
  // P1-WP3（E）：fee_per_shift 係公司出俾雞頭嘅成本（「出街價」性質）——
  // 內部角色冇「出街價:view」（例如會計出廠已經有，但自訂角色可以關）
  // 就見唔到呢粒數。雞頭自己睇自己嘅費率唔經呢個機制（見 broker-dto.ts
  // 註解），一向准。
  referral_fee_rates: ["fee_per_shift"],
} as const;

export type FieldGroupResource = keyof typeof CLIENT_RATE_FIELDS;

function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  if (!keys.length) return obj;
  const clone: Record<string, unknown> = { ...obj };
  for (const k of keys) delete clone[k];
  return clone as T;
}

/** 讀：冇「收客價:view」剝 CLIENT_RATE_FIELDS；冇「出街價:view」剝
 * SETTLEMENT_FIELDS 入面嘅價錢/來源欄。全部角色（包括老闆/主管/會計）
 * 一視同仁經呢個 gate——冇任何角色可以繞過（老闆出廠矩陣兩個 module
 * 都係 grant，所以老闆實際上乜都睇到，但路徑一致，唔靠「老闆特殊處理」）。 */
export async function applyFieldGroupGate<T extends Record<string, unknown>>(
  session: AuthedSession,
  resource: FieldGroupResource,
  row: T,
): Promise<T> {
  let out = row;
  const clientFields = CLIENT_RATE_FIELDS[resource];
  if (clientFields.length && !(await hasPermission(session, "收客價", "view"))) {
    out = omit(out, clientFields);
  }
  const settlementFields = SETTLEMENT_FIELDS[resource];
  if (settlementFields.length && !(await hasPermission(session, "出街價", "view"))) {
    out = omit(out, settlementFields);
  }
  return out;
}

export async function applyFieldGroupGateToList<T extends Record<string, unknown>>(
  session: AuthedSession,
  resource: FieldGroupResource,
  list: { rows: T[]; total: number; skip: number; take: number },
): Promise<Dto<{ rows: T[]; total: number; skip: number; take: number }>> {
  const rows = await Promise.all(list.rows.map((r) => applyFieldGroupGate(session, resource, r)));
  return brandSafeResponse({ ...list, rows });
}

/** 寫：parseBody() 之後，create/update 落 Prisma 之前一律經呢個。body
 * 用 snake_case（同 schemas.ts 嘅 parse 輸出一致）。 */
export async function assertFieldGroupWritable(
  session: AuthedSession,
  resource: FieldGroupResource,
  body: Record<string, unknown>,
): Promise<void> {
  const clientFields = CLIENT_RATE_FIELDS[resource].filter((f) => f in body);
  if (clientFields.length && !(await hasPermission(session, "收客價", "update"))) {
    throw Forbidden(`冇「收客價」寫入權限，唔可以改 ${clientFields.join("/")}`);
  }
  const settlementFields = SETTLEMENT_FIELDS[resource].filter((f) => f in body);
  if (settlementFields.length && !(await hasPermission(session, "出街價", "update"))) {
    throw Forbidden(`冇「出街價」寫入權限，唔可以改 ${settlementFields.join("/")}`);
  }
}
