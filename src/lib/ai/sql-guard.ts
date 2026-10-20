// WP-AI1：`sql_select` 工具嘅 application 層防線（DB 層防線見
// scripts/db/ensure-ai-role.ts + prisma/migrations/…_wp_ai1_readonly_schema
// ——`zoikan_ai_ro` 呢個角色本身已經冇任何寫入權，呢度係第二重）。
//
// P6.2（H7，2026-10-11）：由「簡單 tokenizer＋regex」改做真正嘅 SQL
// parser（純 JS `pgsql-ast-parser`）——
//   - 抽**全部** relation（FROM 逗號 join、JOIN … ON、子查詢、CTE、
//     UNION 各支、lateral），每張都要喺 `TABLE_MODULE_MAP`（`ai.` schema）。
//   - 抽**全部被引用嘅欄位**（SELECT list、WHERE、JOIN ON／USING、GROUP BY、
//     ORDER BY、函數參數、子查詢），唔只係輸出欄名；`AS` 改名無效。
//     屬遮罩欄組（收客價／出街價／保安員個人資料／銀行）嘅欄，如果 session
//     冇對應權限 → 整條查詢拒絕（唔係遮罩輸出）。欄位按**所屬表**判斷
//     （`FIELDS[table]`，同畫面 field-group gate 同一份清單），唔會因為
//     brokers.name 同 guards 嘅 name 撞名就誤殺。
//   - `SELECT *`／`t.*`／整行引用（`to_jsonb(g)`）：該表有任何 session 冇權
//     睇嘅遮罩欄 → 拒絕。
//   - parse 失敗一律拒絕，唔退回 regex。
// 執行嘅 SQL 係「剝走注釋之後」嗰份（parse 同執行用同一份文字，注釋混淆
// 無效）。已知殘餘限制見 docs/ai-assistant.md「已知限制」。
import type { Module } from "../rbac/matrix";
import { parse, type Statement } from "pgsql-ast-parser";
import { CLIENT_RATE_FIELDS, SETTLEMENT_FIELDS, GUARD_PII_FIELDS, GUARD_BANK_FIELDS } from "../api/field-groups";
import { AI_GUARD_BLOCKED_FIELDS } from "./guard-blocked-fields";

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
  // 規劃裁定額外加：SELECT ... INTO 會喺 Postgres 建一張新表。
  "INTO",
] as const;

export const SQL_MAX_LIMIT = 200;

type MaskGroup = "clientRate" | "settlement" | "guardPii" | "guardBank" | "aiBlocked";

export interface MaskedHit {
  group: MaskGroup;
  /** 例如 `special_items.cost`、`guards.*`（淨係欄位／表名，唔含任何值）。 */
  what: string;
}

export interface SqlAnalysis {
  /** 認得嘅 `ai.*` table 名（去重、小寫）。 */
  tables: string[];
  /** 唔喺 `TABLE_MODULE_MAP` 嘅 relation 名——call 方應該拒絕。 */
  unknown: string[];
  /** 被引用嘅遮罩欄（含 `*`／整行引用展開）。 */
  maskedHits: MaskedHit[];
}

export type SqlGuardResult = { ok: true; sql: string; analysis: SqlAnalysis } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 文字層預處理
// ---------------------------------------------------------------------------

/** 剝走 `-- …` 同（可巢狀）`/* … *\/` 注釋，string literal／quoted identifier 內
 * 容保留。注釋位置換成一個空格。未結束嘅注釋或引號 → null（拒絕）。 */
function stripComments(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          out += quote + quote;
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === quote) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && n === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return null;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 將 single-quoted string literal 內容換成同長度底線（供 keyword 掃描用）。 */
function stripStringLiterals(sql: string): string {
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

// ---------------------------------------------------------------------------
// 規劃裁定：`sql_select` 要跟返每張 `ai.*` view 對應嗰個畫面 module 嘅
// view 權。
// ---------------------------------------------------------------------------
const TABLE_MODULE_MAP: Record<string, Module> = {
  sites: "盤",
  shift_types: "盤",
  brokers: "雞頭",
  broker_site_assignments: "雞頭",
  guards: "安員",
  // AI-PII-2：工號卡／長工合約／長工糧 view（長工糧 view 要「長工糧:view」＝老闆／會計）
  guard_staff_numbers: "安員",
  guard_longterm_contracts: "長工糧",
  longterm_payroll_runs: "長工糧",
  longterm_payroll_lines: "長工糧",
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

const ALL_GROUPS: readonly MaskGroup[] = ["clientRate", "settlement", "guardPii", "guardBank"]; // audit_log JSON 欄用；aiBlocked 只對 guards 表（見 maskedColumnsOf）

/** audit_log 嘅 before／after 係任意 resource 嘅 DTO JSON（可以含上面四組任何欄）——
 * 冇辦法按欄位名逐個分，所以引用呢兩欄（或 `*`）當掂到全部四組。 */
const AUDIT_JSON_COLUMNS: ReadonlySet<string> = new Set(["before", "after"]);

/** 由 `FIELDS[table]` 砌：某表某組嘅遮罩欄。 */
function maskedColumnsOf(table: string): Array<{ group: MaskGroup; columns: ReadonlySet<string> }> {
  if (table === "audit_log") return ALL_GROUPS.map((group) => ({ group, columns: AUDIT_JSON_COLUMNS }));
  const out: Array<{ group: MaskGroup; columns: ReadonlySet<string> }> = [];
  const add = (group: MaskGroup, src: Record<string, readonly string[]>) => {
    const cols = src[table];
    if (cols && cols.length) out.push({ group, columns: new Set(cols.map((c) => c.toLowerCase())) });
  };
  add("clientRate", CLIENT_RATE_FIELDS);
  add("settlement", SETTLEMENT_FIELDS);
  // AI-PII-2／2.1：guards 另加 AI 專用遮罩（永遠拒，唔受權限影響）；原有 guardPii／guardBank 組照舊（冇「保安員個人資料:view」睇唔到緊急聯絡人姓名／別名／黑名單查核日期）
  if (table === "guards") out.push({ group: "aiBlocked", columns: new Set(AI_GUARD_BLOCKED_FIELDS) });
  add("guardPii", GUARD_PII_FIELDS);
  add("guardBank", GUARD_BANK_FIELDS);
  return out;
}

/** 禁用函數：會執行字串內嘅 SQL（繞過 relation 檢查）、改 session、讀檔、遠端連線。 */
const BLOCKED_FUNCTION_RE = /(^|_)to_xml(_and_xmlschema)?$|^(query_to_xml|cursor_to_xml|database_to_xml|schema_to_xml)|^dblink|^lo_|^set_config$|^current_setting$|^pg_|^txid_|^xmlexists$|^xpath/i;

// ---------------------------------------------------------------------------
// AST 分析
// ---------------------------------------------------------------------------
type Node = Record<string, unknown>;

interface FromItem {
  /** 引用名（alias 或表名，小寫）。 */
  ref: string;
  /** 真 ai 表名；derived（子查詢／CTE／函數）係 null。 */
  table: string | null;
}
interface Scope {
  items: FromItem[];
}

interface AnalysisState {
  tables: Set<string>;
  unknown: Set<string>;
  hits: MaskedHit[];
  hitKeys: Set<string>;
  cteNames: Set<string>;
  error: string | null;
}

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function pushHit(st: AnalysisState, group: MaskGroup, what: string) {
  const k = `${group}|${what}`;
  if (st.hitKeys.has(k)) return;
  st.hitKeys.add(k);
  st.hits.push({ group, what });
}

function checkColumnOnTable(st: AnalysisState, table: string, col: string) {
  for (const m of maskedColumnsOf(table)) {
    if (m.columns.has(col)) pushHit(st, m.group, `${table}.${col}`);
  }
}

function checkStarOnTable(st: AnalysisState, table: string) {
  for (const m of maskedColumnsOf(table)) pushHit(st, m.group, `${table}.*`);
}

function fail(st: AnalysisState, msg: string) {
  if (!st.error) st.error = msg;
}

const SELECT_TYPES = new Set(["select", "union", "union all", "with", "with recursive", "values"]);

function isSelectLike(n: unknown): n is Node {
  return !!n && typeof n === "object" && SELECT_TYPES.has((n as Node).type as string);
}

function walkStatement(node: Node, chain: Scope[], st: AnalysisState): void {
  const type = node.type as string;
  if (type === "union" || type === "union all") {
    if (isSelectLike(node.left)) walkStatement(node.left as Node, chain, st);
    if (isSelectLike(node.right)) walkStatement(node.right as Node, chain, st);
    return;
  }
  if (type === "with" || type === "with recursive") {
    const binds = (node.bind as Node[] | undefined) ?? [];
    for (const b of binds) {
      const alias = lower((b.alias as Node | undefined)?.name);
      if (alias in TABLE_MODULE_MAP) {
        fail(st, `CTE 名「${alias}」同 ai 表同名，唔准用`);
        continue;
      }
      st.cteNames.add(alias);
    }
    for (const b of binds) {
      const s = b.statement as Node | undefined;
      if (!s || !isSelectLike(s)) {
        fail(st, "WITH 入面只准 SELECT 類語句");
        continue;
      }
      walkStatement(s, chain, st);
    }
    if (isSelectLike(node.in)) walkStatement(node.in as Node, chain, st);
    else fail(st, "WITH 之後只准 SELECT 類語句");
    return;
  }
  if (type === "values") {
    walkGeneric(node, chain, st, false, false);
    return;
  }
  if (type !== "select") {
    fail(st, "只准 SELECT 或 WITH 開頭嘅查詢");
    return;
  }

  // ---- plain select -----------------------------------------------------
  const scope: Scope = { items: [] };
  const from = (node.from as Node[] | undefined) ?? [];
  for (const f of from) {
    const ft = f.type as string;
    if (ft === "table") {
      const nm = f.name as Node;
      const schema = nm.schema == null ? null : lower(nm.schema);
      const name = lower(nm.name);
      const alias = lower(nm.alias) || name;
      if (schema !== null && schema !== "ai") {
        fail(st, `只可以查詢 ai. schema，唔准 ${schema}.`);
        continue;
      }
      if (schema === null && st.cteNames.has(name)) {
        scope.items.push({ ref: alias, table: null });
      } else if (name in TABLE_MODULE_MAP) {
        st.tables.add(name);
        scope.items.push({ ref: alias, table: name });
      } else {
        st.unknown.add(name);
        scope.items.push({ ref: alias, table: null });
      }
    } else if (ft === "call") {
      const alias = lower((f.alias as Node | undefined)?.name) || lower((f.function as Node | undefined)?.name);
      scope.items.push({ ref: alias, table: null });
    } else {
      scope.items.push({ ref: lower(f.alias), table: null });
    }
  }
  const nextChain = [...chain, scope];
  for (const f of from) walkGeneric(f, nextChain, st, false, false);
  for (const key of ["columns", "where", "groupBy", "having", "orderBy", "limit", "distinct", "for"]) {
    if (node[key] !== undefined) walkGeneric(node[key], nextChain, st, key === "columns", false);
  }
}

function resolveQualified(chain: Scope[], qual: string): FromItem | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const hit = chain[i]!.items.find((it) => it.ref === qual);
    if (hit) return hit;
  }
  return null;
}

function realTablesInChain(chain: Scope[]): string[] {
  const out: string[] = [];
  for (const s of chain) for (const it of s.items) if (it.table) out.push(it.table);
  return out;
}

function walkRef(node: Node, chain: Scope[], st: AnalysisState, insideCall: boolean): void {
  const name = lower(node.name);
  const tableNode = node.table as Node | undefined;
  const qual = tableNode ? lower(tableNode.name) : null;
  const qualSchema = tableNode?.schema != null ? lower(tableNode.schema) : null;
  if (qualSchema !== null && qualSchema !== "ai") {
    fail(st, `只可以查詢 ai. schema，唔准 ${qualSchema}.`);
    return;
  }
  if (name === "*") {
    if (qual) {
      const item = resolveQualified(chain, qual);
      if (item?.table) checkStarOnTable(st, item.table);
      else if (!item) for (const t of realTablesInChain(chain)) checkStarOnTable(st, t);
      return;
    }
    if (insideCall) return; // count(*) 呢類
    const scope = chain[chain.length - 1];
    if (scope) for (const it of scope.items) if (it.table) checkStarOnTable(st, it.table);
    return;
  }
  if (qual) {
    const item = resolveQualified(chain, qual);
    if (item?.table) checkColumnOnTable(st, item.table, name);
    else if (!item) for (const t of realTablesInChain(chain)) checkColumnOnTable(st, t, name); // 保守
    return;
  }
  // 無 qualifier：可能係欄位，亦可能係整行引用（to_jsonb(g)）
  const whole = resolveQualified(chain, name);
  if (whole?.table) checkStarOnTable(st, whole.table);
  for (const t of realTablesInChain(chain)) checkColumnOnTable(st, t, name);
}

function walkGeneric(value: unknown, chain: Scope[], st: AnalysisState, inColumnList: boolean, insideCall: boolean): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) walkGeneric(v, chain, st, inColumnList, insideCall);
    return;
  }
  if (typeof value !== "object") return;
  const node = value as Node;
  const type = node.type as string | undefined;

  if (isSelectLike(node) && type !== "values") {
    walkStatement(node, chain, st);
    return;
  }
  if (type === "ref") {
    walkRef(node, chain, st, insideCall);
    return;
  }
  if (type === "call") {
    const fn = node.function as Node | undefined;
    const fname = lower(fn?.name);
    if (fn?.schema != null) fail(st, "唔准用 schema-qualified 函數");
    if (BLOCKED_FUNCTION_RE.test(fname)) fail(st, `唔准使用函數「${fname}」`);
    walkGeneric(node.args, chain, st, false, true);
    for (const k of ["orderBy", "filter", "over", "distinct"]) if (node[k] !== undefined) walkGeneric(node[k], chain, st, false, false);
    return;
  }
  // JOIN … USING (a, b)：欄位名節點冇 type
  if (node.join && typeof node.join === "object") {
    const using = (node.join as Node).using as Node[] | undefined;
    if (using) for (const u of using) for (const t of realTablesInChain(chain)) checkColumnOnTable(st, t, lower(u.name));
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "_location") continue;
    walkGeneric(v, chain, st, k === "columns" ? true : inColumnList && k === "expr", insideCall);
  }
}

function analyze(stmt: Statement): SqlAnalysis | { error: string } {
  const st: AnalysisState = { tables: new Set(), unknown: new Set(), hits: [], hitKeys: new Set(), cteNames: new Set(), error: null };
  walkStatement(stmt as unknown as Node, [], st);
  if (st.error) return { error: st.error };
  return { tables: [...st.tables], unknown: [...st.unknown], maskedHits: st.hits };
}

// ---------------------------------------------------------------------------
// 對外 API
// ---------------------------------------------------------------------------
export function validateSqlSelect(rawQuery: string): SqlGuardResult {
  const trimmed = (rawQuery ?? "").trim();
  if (!trimmed) return { ok: false, reason: "查詢係空嘅" };

  // 保留原有嚴格規則：原文（連注釋）入面除咗一個尾隨分號，唔准再有分號
  // （例如 `…; -- DROP TABLE` 呢類「分號＋注釋」寫法一律拒絕）。
  const rawNoTrailing = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (stripStringLiterals(rawNoTrailing).includes(";")) return { ok: false, reason: "只准單一句 SQL（唔准用分號分隔多句）" };

  const noComments = stripComments(trimmed);
  if (noComments === null) return { ok: false, reason: "SQL 注釋或引號冇結束" };
  const cleaned = noComments.trim();
  // 容許最多一個尾隨分號
  const withoutTrailingSemicolon = (cleaned.endsWith(";") ? cleaned.slice(0, -1) : cleaned).trim();
  if (!withoutTrailingSemicolon) return { ok: false, reason: "查詢係空嘅" };
  const codeOnly = stripStringLiterals(withoutTrailingSemicolon);

  if (codeOnly.includes(";")) return { ok: false, reason: "只准單一句 SQL（唔准用分號分隔多句）" };
  if (!/^\s*(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) return { ok: false, reason: "只准 SELECT 或 WITH 開頭嘅查詢" };

  for (const kw of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(codeOnly)) return { ok: false, reason: `唔准使用關鍵字「${kw}」` };
  }
  if (/\bFOR\s+UPDATE\b/i.test(codeOnly)) return { ok: false, reason: "唔准 FOR UPDATE" };
  if (/\bFOR\s+SHARE\b/i.test(codeOnly)) return { ok: false, reason: "唔准 FOR SHARE" };
  if (/pg_/i.test(codeOnly)) return { ok: false, reason: "唔准存取 pg_ 開頭嘅系統目錄/函數" };
  if (/\bpublic\s*\./i.test(codeOnly)) return { ok: false, reason: "只可以查詢 ai. schema，唔准 public." };
  if (/\bpg_catalog\s*\./i.test(codeOnly)) return { ok: false, reason: "只可以查詢 ai. schema，唔准 pg_catalog." };
  if (/\binformation_schema\b/i.test(codeOnly)) return { ok: false, reason: "只可以查詢 ai. schema，唔准 information_schema" };

  let statements: Statement[];
  try {
    statements = parse(withoutTrailingSemicolon, { locationTracking: true });
  } catch {
    return { ok: false, reason: "SQL 語法解析失敗（唔支援嘅寫法，請用簡單啲嘅 SELECT）" };
  }
  if (statements.length !== 1) return { ok: false, reason: "只准單一句 SQL" };
  const stmt = statements[0]!;
  if (!SELECT_TYPES.has(stmt.type) || stmt.type === "values") return { ok: false, reason: "只准 SELECT 或 WITH 開頭嘅查詢" };

  const analysis = analyze(stmt);
  if ("error" in analysis) return { ok: false, reason: analysis.error };

  return { ok: true, sql: applyLimit(withoutTrailingSemicolon, stmt), analysis };
}

/** 強制 LIMIT 200：plain select（或 WITH … 嘅主 select）直接加／收緊；UNION 或者
 * LIMIT 唔係整數常數就包一層 `SELECT * FROM (…) LIMIT 200`。 */
function applyLimit(sql: string, stmt: Statement): string {
  const wrap = () => `SELECT * FROM (${sql}) AS _ai_q LIMIT ${SQL_MAX_LIMIT}`;
  const s = stmt as unknown as Node;
  const main: Node | null =
    s.type === "select" ? s : (s.type === "with" || s.type === "with recursive") && (s.in as Node | undefined)?.type === "select" ? (s.in as Node) : null;
  if (!main) return wrap();
  const lim = main.limit as Node | undefined;
  if (!lim) return `${sql} LIMIT ${SQL_MAX_LIMIT}`;
  const limitExpr = lim.limit as Node | undefined;
  if (!limitExpr || limitExpr.type !== "integer") return wrap(); // 只有 OFFSET，或者 LIMIT 唔係整數常數
  const value = Number(limitExpr.value);
  if (Number.isFinite(value) && value <= SQL_MAX_LIMIT) return sql;
  const loc = limitExpr._location as { start: number; end: number } | undefined;
  if (!loc) return wrap();
  return `${sql.slice(0, loc.start)}${SQL_MAX_LIMIT}${sql.slice(loc.end)}`;
}

/** 由抽出嚟嘅 table 名，攞返呢條查詢需要邊幾個 module 嘅 view 權（去重）。 */
export function modulesForTables(tables: string[]): Module[] {
  return [...new Set(tables.map((t) => TABLE_MODULE_MAP[t]!))];
}

/** 呢個 session 冇權睇、但查詢有引用嘅遮罩欄（空＝放行）。 */
export function deniedMaskedHits(
  analysis: SqlAnalysis,
  vis: { clientRateVisible: boolean; settlementVisible: boolean; guardPiiVisible: boolean; guardBankVisible: boolean },
): MaskedHit[] {
  const visible: Record<MaskGroup, boolean> = {
    clientRate: vis.clientRateVisible,
    settlement: vis.settlementVisible,
    guardPii: vis.guardPiiVisible,
    guardBank: vis.guardBankVisible,
    aiBlocked: false, // AI-PII-2：AI 專用遮罩欄永遠不可見
  };
  return analysis.maskedHits.filter((h) => !visible[h.group]);
}
