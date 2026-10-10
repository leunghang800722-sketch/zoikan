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
import { CLIENT_RATE_FIELDS, SETTLEMENT_FIELDS, GUARD_PII_FIELDS, GUARD_BANK_FIELDS, type FieldGroupResource } from "../api/field-groups";

export type { FieldGroupResource };

/** 攞返「呢個 session 而家睇唔睇得到收客價／出街價／保安員個人資料／保安員
 * 銀行資料」——工具層攞一次，之後同一個 request 入面幾多個工具都可以
 * 重用，唔使逐次查 DB。 */
export interface AiFieldVisibility {
  clientRateVisible: boolean;
  settlementVisible: boolean;
  // WP-PII（Opus 驗收必修 1b）：`recent_audit`／`sql_select` 呢類「唔知
  // 邊個 resource」嘅通用工具，之前完全冇檢查呢兩個新 field group——冇
  // 「保安員個人資料/保安員銀行資料:view」都一樣經呢兩個工具讀到 hkid／
  // bank_account_no（DB 層 `ai.audit_log` 嘅 scrub_json blocklist 已經
  // 喺另一個 migration 加咗做第一重防線，呢度係應用層第二重
  // defense-in-depth）。
  guardPiiVisible: boolean;
  guardBankVisible: boolean;
}

export async function computeFieldVisibility(session: AuthedSession): Promise<AiFieldVisibility> {
  const [clientRateVisible, settlementVisible, guardPiiVisible, guardBankVisible] = await Promise.all([
    hasPermission(session, "收客價", "view"),
    hasPermission(session, "出街價", "view"),
    hasPermission(session, "安員個人資料", "view"),
    hasPermission(session, "安員銀行資料", "view"),
  ]);
  return { clientRateVisible, settlementVisible, guardPiiVisible, guardBankVisible };
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
  // WP-PII：`guard_lookup` 呢類工具用嘅 `ai.guards` view 本身結構上冇呢
  // 16 個新欄（見 prisma/migrations/…wp_ai1_readonly_schema 頂註解），
  // 呢度純粹保持同 applyFieldGroupGate() 一致嘅四層 gate，日後有第二個
  // 工具查到帶呢啲欄嘅 resource 都唔會漏。
  if (!vis.guardPiiVisible) out = omit(out, GUARD_PII_FIELDS[resource]);
  if (!vis.guardBankVisible) out = omit(out, GUARD_BANK_FIELDS[resource]);
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

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// WP-PII（Opus 驗收必修 1b）：`recent_audit`（audit_log.before/after，
// 已核實 DB 入面係 `pickWhitelist()` 轉出嚟嘅 snake_case DTO）同
// `sql_select`（`ai.*` view 直接查，欄名一律係 Postgres 欄位名，都係
// snake_case）而家實際上見到嘅一律係 snake_case key；呢度連 camelCase
// 變體都一齊加落 blocklist——純粹 defense-in-depth（萬一第二個未來
// call site 用 camelCase 傳落嚟，都唔會漏），成本近乎零（Set 多幾個
// 唔存在嘅 key 淨係唔會撞中）。
function namesWithCamelVariant(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    out.add(normalizeKey(n));
    out.add(normalizeKey(snakeToCamel(n)));
  }
  return out;
}

const ALL_GUARD_PII_FIELD_NAMES = namesWithCamelVariant(Object.values(GUARD_PII_FIELDS).flat());
const ALL_GUARD_BANK_FIELD_NAMES = namesWithCamelVariant(Object.values(GUARD_BANK_FIELDS).flat());

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
  if (!vis.guardPiiVisible) out = dropKeysDeep(out, ALL_GUARD_PII_FIELD_NAMES);
  if (!vis.guardBankVisible) out = dropKeysDeep(out, ALL_GUARD_BANK_FIELD_NAMES);
  return out;
}

// ---------------------------------------------------------------------------
// P2.5「現場反映」開會模式——電話號碼 pattern（best-effort，同上面「已知
// 限制」一致嘅刻意權衡：簡單 regex，唔係完整 PII detector）。用途兩個：
// 1. `src/app/api/feedback/session/chat/route.ts` 送用戶輸入去 LLM 之前
//    先過呢個（呼應 `docs/ai-assistant.md`「電話、銀行資料、密碼、OTP
//    一律唔准送」——訪談對話都係送去 Anthropic/DeepSeek 處理，唔可以
//    例外）。
// 2. `src/lib/feedback/ai-tools/list-feedback.ts`（老闆用 AI 助手讀已經
//    送出嘅意見）讀出嗰陣再 scrub 一次（defense-in-depth——即使入口
//    冇擋晒，呢一層做最後把關）。
// 香港電話：8 位數字（可以有 +852／852 前綴、空格、連字號）。刻意寬鬆
// （寧枉勿縱）：連 8 位純數字（唔係電話嘅普通數量詞，例如「20250101」
// 呢類日期）都會被剝——呢個係規劃裁定嘅刻意權衡，見上面「已知限制」
// 一節嘅精神（simple regex over完整 NLP/PII detector）。
// ---------------------------------------------------------------------------
const PHONE_LIKE_PATTERN = /(\+?852[-\s]?)?\b\d{4}[-\s]?\d{4}\b/g;

export function scrubPhoneLike(text: string): string {
  return text.replace(PHONE_LIKE_PATTERN, "[已隱藏電話]");
}
