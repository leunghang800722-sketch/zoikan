// WP-AI1：`sql_select` 工具嘅 application 層防線（DB 層防線見
// scripts/db/ensure-ai-role.ts + prisma/migrations/…_wp_ai1_readonly_schema
// ——`zoikan_ai_ro` 呢個角色本身已經冇任何寫入權，呢度係第二重）。
//
// 規則（老闆／規劃 session 明文）：
//   - 只准單一句、以 SELECT 或 WITH 開頭
//   - 簡單 tokenizer 拒絕 DML/DDL/session 類關鍵字＋分號（多句）
//   - 強制 LIMIT 200（冇就加；有但超過 200 就收緊落 200——比「淨係加」
//     再嚴少少，防止用戶叫 AI 下一個好大嘅 LIMIT 撈晒成張表）
//   - 只可以查 `ai.` schema——明文拒絕 `public.`／`pg_catalog`／
//     `information_schema`／任何 `pg_` 開頭嘅識別符（呢個已經冚晒
//     pg_catalog 入面嘅 view/function，例如 pg_shadow/pg_read_file）
//
// 呢個 tokenizer 刻意簡單（規劃裁定明文要求），唔係一個完整 SQL parser：
// 已知限制見 docs/ai-assistant.md「已知限制」一節。
import type { Module } from "../rbac/matrix";

const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "ALTER",
  "DROP",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "SET",
  "RESET",
  "COPY",
  "CALL",
  "DO",
  "EXECUTE",
  "LOCK",
  // 規劃裁定額外加（唔喺原始清單，但同一個風險類別）：SELECT ... INTO
  // 會喺 Postgres 建一張新表，屬於寫入動作，唔可以淨係靠 DB grant 兜底
  // （雖然 zoikan_ai_ro 冇 CREATE 權，DB 層都會拒，但呢度提早喺
  // application 層講得清楚啲）。
  "INTO",
] as const;

export const SQL_MAX_LIMIT = 200;

export type SqlGuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** 逐字掃描，將 single-quoted string literal（處理 '' escape）嘅內容
 * 換成同長度嘅底線——之後嘅 keyword/schema 掃描唔會誤中字串值入面嘅
 * 文字（例如 `WHERE description ILIKE '%update%'`），亦保持索引位置
 * 一致（等 LIMIT 改寫可以直接用 codeOnly 嘅 match index 落原字串切）。 */
export function stripStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      out += "_";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "__";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out += "_";
          i++;
          break;
        }
        out += "_";
        i++;
      }
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

export function validateSqlSelect(rawQuery: string): SqlGuardResult {
  const trimmed = (rawQuery ?? "").trim();
  if (!trimmed) return { ok: false, reason: "查詢係空嘅" };

  // 只准單句：容許最多一個尾隨分號（用戶/LLM 手多加嘅），去咗先驗證；
  // 之後（去除字串內容後）唔准再出現任何分號。
  const withoutTrailingSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  const codeOnly = stripStringLiterals(withoutTrailingSemicolon);

  if (codeOnly.includes(";")) {
    return { ok: false, reason: "只准單一句 SQL（唔准用分號分隔多句）" };
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) {
    return { ok: false, reason: "只准 SELECT 或 WITH 開頭嘅查詢" };
  }

  for (const kw of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(codeOnly)) {
      return { ok: false, reason: `唔准使用關鍵字「${kw}」` };
    }
  }

  if (/\bFOR\s+UPDATE\b/i.test(codeOnly)) {
    return { ok: false, reason: "唔准 FOR UPDATE" };
  }
  if (/\bFOR\s+SHARE\b/i.test(codeOnly)) {
    return { ok: false, reason: "唔准 FOR SHARE" };
  }

  if (/pg_/i.test(codeOnly)) {
    return { ok: false, reason: "唔准存取 pg_ 開頭嘅系統目錄/函數" };
  }

  if (/\bpublic\s*\./i.test(codeOnly)) {
    return { ok: false, reason: "只可以查詢 ai. schema，唔准 public." };
  }
  if (/\bpg_catalog\s*\./i.test(codeOnly)) {
    return { ok: false, reason: "只可以查詢 ai. schema，唔准 pg_catalog." };
  }
  if (/\binformation_schema\b/i.test(codeOnly)) {
    return { ok: false, reason: "只可以查詢 ai. schema，唔准 information_schema" };
  }

  // 強制 LIMIT 200：冇就加喺尾；有但 > 200 就收緊做 200（simple tokenizer
  // 淨係揀最後一個 LIMIT 出現位置——已知限制：巢狀 subquery 入面自己嘅
  // LIMIT 會誤判做「outer LIMIT」，見 docs/ai-assistant.md）。
  const limitMatches = [...codeOnly.matchAll(/\bLIMIT\s+(\d+)\b/gi)];
  let finalSql = withoutTrailingSemicolon;
  if (limitMatches.length === 0) {
    finalSql = `${finalSql} LIMIT ${SQL_MAX_LIMIT}`;
  } else {
    const last = limitMatches[limitMatches.length - 1]!;
    const value = Number(last[1]);
    if (value > SQL_MAX_LIMIT || !Number.isFinite(value)) {
      const start = last.index!;
      const end = start + last[0].length;
      finalSql = `${finalSql.slice(0, start)}LIMIT ${SQL_MAX_LIMIT}${finalSql.slice(end)}`;
    }
  }

  return { ok: true, sql: finalSql };
}

// ---------------------------------------------------------------------------
// 規劃裁定：`sql_select` 要跟返每張 `ai.*` view 對應嗰個畫面 module 嘅
// view 權——「你冇權見嘅報表，助手都唔答」。呢個表逐一列晒全部 13 個
// `ai.*` view 對應邊個 module（同其他工具/現有 REST API 用緊嗰個
// module 一致，例如 `guard_lookup`→安員、`rate_cards`→出街價）。
// ---------------------------------------------------------------------------
export const TABLE_MODULE_MAP: Record<string, Module> = {
  sites: "盤",
  shift_types: "盤",
  brokers: "雞頭",
  broker_site_assignments: "雞頭",
  guards: "安員",
  shift_records: "更表",
  daily_requirements: "更表",
  quotas: "更表",
  rate_cards: "出街價",
  referral_fee_rates: "出街價",
  special_items: "月結總表",
  month_closes: "月結總表",
  audit_log: "操作紀錄",
  users: "用戶管理",
};

export interface ReferencedTables {
  /** 認得嘅 `ai.*` table 名（去重、小寫）。 */
  tables: string[];
  /** `FROM`/`JOIN` 之後跟住嘅識別符，但唔喺 `TABLE_MODULE_MAP` 度嘅
   * （包括打錯字、或者未來新加但漏咗登記嘅 view）——呢種一律當「抽唔到
   * 對應權限」，call 方應該拒絕呢條查詢，唔准當「冇限制」處理。 */
  unknown: string[];
}

/** 由 `FROM`/`JOIN` 之後嘅識別符抽表名——search_path 已經鎖死喺 `ai`
 * （見 scripts/db/ensure-ai-role.ts），所以查詢可以寫 `FROM sites` 或者
 * `FROM ai.sites`，兩種都要認得到，先可以夾埋 `TABLE_MODULE_MAP` 判斷
 * 使唔使呢個工具嘅 caller 有對應 module 嘅 view 權。刻意簡單（同呢個
 * 檔案其他部分一致嘅 tokenizer 精神）：唔識別 subquery 嵌套深淺，淨係
 * 掃全句 `FROM`/`JOIN` 關鍵字後面第一個識別符。 */
export function extractReferencedTables(sql: string): ReferencedTables {
  const codeOnly = stripStringLiterals(sql);
  const matches = [...codeOnly.matchAll(/\b(?:FROM|JOIN)\s+(?:ai\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi)];
  const tables = new Set<string>();
  const unknown = new Set<string>();
  for (const m of matches) {
    const name = m[1]!.toLowerCase();
    if (name in TABLE_MODULE_MAP) tables.add(name);
    else unknown.add(name);
  }
  return { tables: [...tables], unknown: [...unknown] };
}

/** 由抽出嚟嘅 table 名，攞返呢條查詢需要邊幾個 module 嘅 view 權（去重）。 */
export function modulesForTables(tables: string[]): Module[] {
  return [...new Set(tables.map((t) => TABLE_MODULE_MAP[t]!))];
}
