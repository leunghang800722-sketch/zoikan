// WP-AI1：AI 助手工具層嘅 field-level 錢銀欄位過濾——「每個工具收
// session，用現有 field-group gate」（規劃裁定，唔重新發明一套）。
//
// `src/lib/api/field-groups.ts` 嘅 `CLIENT_RATE_FIELDS`/`SETTLEMENT_FIELDS`
// 已經係逐 resource 嘅 snake_case 欄位名清單——同 AI 助手由 `ai.*` view
// 讀出嚟嘅 raw row（pg 驅動直接用 DB 欄位名，本身就係 snake_case）**完全
// 對得上**，唔使做 camelCase/snake_case 轉換就可以直接重用嗰個清單同
// `applyFieldGroupGate()`／`hasPermission()`。
//
// 呢個檔案本身淨係 import `@/lib/api/field-groups`（field-group 資料+gate
// 函數）同 `@/lib/rbac/requirePermission`（session 型別+hasPermission）—
// —兩個都唔喺 `src/lib/ai/**`／`src/app/api/ai/**` 之內，唔違反
// tests/ai-structural-guard.test.ts 嘅「呢兩個 tree 入面零 @/lib/db／零
// prisma.」規則（嗰個規則管嘅係呢個檔案*自己*嘅原始碼文字，唔係佢
// import 緊嘅其他檔案入面做緊咩）。
import type { AuthedSession } from "../rbac/requirePermission";
import { hasPermission } from "../rbac/requirePermission";
import { CLIENT_RATE_FIELDS, SETTLEMENT_FIELDS, type FieldGroupResource } from "../api/field-groups";

export type { FieldGroupResource };

/** 攞返「呢個 session 而家睇唔睇得到收客價／出街價」——工具層攞一次，
 * 之後同一個 request 入面幾多個工具都可以重用，唔使逐次查 DB。 */
export interface AiFieldVisibility {
  clientRateVisible: boolean;
  settlementVisible: boolean;
}

export async function computeFieldVisibility(session: AuthedSession): Promise<AiFieldVisibility> {
  const [clientRateVisible, settlementVisible] = await Promise.all([
    hasPermission(session, "收客價", "view"),
    hasPermission(session, "出街價", "view"),
  ]);
  return { clientRateVisible, settlementVisible };
}

function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  if (!keys.length) return obj;
  const clone: Record<string, unknown> = { ...obj };
  for (const k of keys) delete clone[k];
  return clone as T;
}

/** 對單一 resource 嘅一粒 row（snake_case key）做 field-group 過濾——
 * 冇收客價:view 剝 CLIENT_RATE_FIELDS[resource]，冇出街價:view 剝
 * SETTLEMENT_FIELDS[resource]。 */
export function scrubRowForResource<T extends Record<string, unknown>>(
  row: T,
  resource: FieldGroupResource,
  vis: AiFieldVisibility,
): T {
  let out = row;
  if (!vis.clientRateVisible) out = omit(out, CLIENT_RATE_FIELDS[resource]);
  if (!vis.settlementVisible) out = omit(out, SETTLEMENT_FIELDS[resource]);
  return out;
}

export function scrubRowsForResource<T extends Record<string, unknown>>(
  rows: T[],
  resource: FieldGroupResource,
  vis: AiFieldVisibility,
): T[] {
  return rows.map((r) => scrubRowForResource(r, resource, vis));
}

// ---------------------------------------------------------------------------
// 通用（唔知道邊個 resource）嘅欄位名 blocklist——`sql_select`（任意 SQL，
// 冇固定 resource 形狀）同 `recent_audit`（audit_log.before/after 可以係
// 任何 resource 嘅 DTO）用嚟做「淨係睇欄位名」嘅 best-effort scrub。
//
// 已知限制（見 docs/ai-assistant.md）：呢個係欄位*名*嘅 blocklist，唔識
// 分辨「呢個 SELECT 出嚟嘅欄叫 revenue，但佢嚟自邊張表」——一個查詢
// `SELECT cost AS revenue FROM ai.special_items` 用假 alias 就可以繞過
// （sql_select 本身冇 column provenance 分析，呢個屬於刻意權衡：規劃裁定
// 話 tokenizer 要「簡單」，唔做完整 SQL parser）。
// ---------------------------------------------------------------------------
const ALL_CLIENT_RATE_FIELD_NAMES = new Set(Object.values(CLIENT_RATE_FIELDS).flat());
const ALL_SETTLEMENT_FIELD_NAMES = new Set(Object.values(SETTLEMENT_FIELDS).flat());

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/** 遞歸剝走物件樹（唔理幾深、唔理 array/object）入面嘅指定欄位名。 */
function dropKeysDeep<T>(value: T, blocked: ReadonlySet<string>): T {
  function walk(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (v instanceof Date) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (blocked.has(normalizeKey(k))) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
  return walk(value) as T;
}

export function scrubUnknownShape<T>(value: T, vis: AiFieldVisibility): T {
  let out = value;
  if (!vis.clientRateVisible) out = dropKeysDeep(out, ALL_CLIENT_RATE_FIELD_NAMES);
  if (!vis.settlementVisible) out = dropKeysDeep(out, ALL_SETTLEMENT_FIELD_NAMES);
  return out;
}
