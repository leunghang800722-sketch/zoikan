// WP-AI1：結構性保證——掃 `src/lib/ai/**` 同 `src/app/api/ai/**`，斷言
// 零 import `@/lib/db`（Prisma 寫入客戶端）、零 `prisma.`、零
// `$executeRaw`／`$transaction`、零 import 任何 `src/app/api/**/route.ts`、
// 零 `fetch(` 去內部 API。
//
// 設計決定（見 docs/ai-assistant.md「結構性保證點做」一節）：呢個掃描
// 係逐檔案原始碼文字嘅**直接**（唔係遞歸/transitive）檢查——`src/lib/
// ai/**` 入面嘅檔案可以 import 其他既有 lib（`@/lib/rbac/requirePermission`
// 、`@/lib/api/field-groups`、`@/lib/audit`），因為呢啲檔案本身唔喺
// scan 嘅 tree 之內，佢哋自己點用 `@/lib/db` 唔關「AI 呢一側有冇直接掂
// 寫入客戶端」嘅事——真正嘅業務數據來源收窄喺 `src/lib/ai/tools/*.ts`
// 呢一層：逐個工具檔案淨係准 import `@/lib/ai/db`（唯讀連線）、
// `@/lib/reports/*`（純讀 report builder）、`@/lib/rbac/requirePermission`
// 、`@/lib/api/field-groups`（權限/field-gate，唔係業務數據來源）—— 呢個
// allowlist 用另一個更窄嘅斷言逐個工具檔案檢查。
//
// `src/lib/ai-conversation.ts`／`src/lib/ai-rate-limit.ts` 刻意擺喺
// `src/lib/ai/` 樹之外（頂層，同 `src/lib/audit.ts` 一樣）——佢哋管嘅係
// 助手自己嘅對話 history／daily rate limit 呢類應用狀態，本身就需要正常
// 讀寫 DB（唔係「AI 查詢業務數據」嗰條唯讀邊界），刻意擺出嚟令呢個
// 掃描唔使開特殊例外。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function listFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path.relative(ROOT, full)));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

const AI_LIB_FILES = listFiles("src/lib/ai");
const AI_API_FILES = listFiles("src/app/api/ai");
const ALL_SCANNED = [...AI_LIB_FILES, ...AI_API_FILES];

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

/** 去走 // 同 /* *\/ comment，同單/雙/backtick 字串嘅內容——先至掃
 * 「code 本身真係咁寫」，唔會誤判 comment 入面解釋緊條規則嘅文字（例如
 * 呢個檔案自己嘅頭註解），或者 `output-guard.ts` 嗰個 blocklist 陣列
 * 入面本身故意放住嘅 "prisma."／"$executeRaw" 呢類*資料*（用嚟偵測 LLM
 * 輸出，唔係真係 call 緊）。夠簡單就得，唔使完整 tokenizer。 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      out += ch;
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++; // skip escaped char
        i++;
      }
      if (i < src.length) {
        out += ch;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

describe("WP-AI1 §6：結構性保證——src/lib/ai/** 同 src/app/api/ai/**", () => {
  it("掃到嘅檔案數量合理（防止 glob 打空令成個 test 形同虛設）", () => {
    expect(AI_LIB_FILES.length).toBeGreaterThan(10);
    expect(AI_API_FILES.length).toBeGreaterThan(0);
  });

  it.each(ALL_SCANNED)("%s 冇 import @/lib/db", (relPath) => {
    const src = readSource(relPath);
    expect(src).not.toMatch(/from\s+["']@\/lib\/db["']/);
    expect(src).not.toMatch(/require\(\s*["']@\/lib\/db["']\s*\)/);
  });

  // 下面幾條用「去走 comment/string」之後嘅版本嚟掃「code 本身」，唔會
  // 誤中 comment 解釋緊條規則嘅文字，或者 output-guard.ts 嗰個 blocklist
  // 陣列入面故意放住嘅 "prisma."／"$executeRaw" 呢類*資料*（見上面
  // stripCommentsAndStrings() 註解）。Import path 就要用原始文字檢查
  // （嗰個路徑本身就係字串 literal，去走字串會令呢個檢查形同虛設）。
  it.each(ALL_SCANNED)("%s 冇 prisma. 字面調用（去走 comment/string 之後）", (relPath) => {
    const code = stripCommentsAndStrings(readSource(relPath));
    expect(code).not.toMatch(/\bprisma\s*\./);
  });

  it.each(ALL_SCANNED)("%s 冇 $executeRaw／$transaction（去走 comment/string 之後）", (relPath) => {
    const code = stripCommentsAndStrings(readSource(relPath));
    expect(code).not.toContain("$executeRaw");
    expect(code).not.toContain("$transaction");
  });

  it.each(ALL_SCANNED)("%s 冇 import 任何 src/app/api/**/route", (relPath) => {
    const src = readSource(relPath);
    expect(src).not.toMatch(/from\s+["'][^"']*\/api\/[^"']*\/route["']/);
  });

  it.each(ALL_SCANNED)("%s 冇 fetch( 去內部 API（去走 comment/string 之後）", (relPath) => {
    const code = stripCommentsAndStrings(readSource(relPath));
    expect(code).not.toMatch(/\bfetch\(/);
  });

  // ------------------------------------------------------------------
  // Opus 驗收應修①：呢個結構性掃描之前淨係管 `src/lib/ai/tools/**`，
  // `list_feedback`（`src/lib/feedback/ai-tools/list-feedback.ts`）刻意
  // 擺喺另一個目錄用正常 Prisma 讀（見該檔案頂註解＋
  // docs/ai-assistant.md「ai schema 唔加 view」一節），但呢個掃描本身
  // 唔應該淨係憑「擺喺邊個目錄」就放行唔受管——所以呢度明文列出全部
  // 「會俾模型直接調用」嘅工具定義檔目錄，兩個目錄行**同一套**
  // 斷言（import allowlist／冇 fetch(／冇 import route.ts），
  // `list_feedback` 用 `@/lib/db` 呢一項淨係用下面
  // `IMPORT_ALLOWLIST_EXEMPTIONS` **明列豁免**（唔係靠目錄位置繞過），
  // 仲加多一條「`buildAiTools()` 用嘅每個工具定義檔都要喺呢兩個目錄之
  // 內」——將來如果有人喺第三個目錄起個新工具檔案再喺 `tools/index.ts`
  // import 落嚟，呢條會唔通過（唔使個新目錄自己記得嚟呢個 test 度加）。
  const MODEL_FACING_TOOL_DIRS = ["src/lib/ai/tools", "src/lib/feedback/ai-tools"];

  // 業務數據來源收窄：兩個 MODEL_FACING_TOOL_DIRS 入面逐個工具檔案，
  // `@/lib/*`／相對路徑呢類 import 淨係准嚟自呢個 allowlist（唯讀 DB
  // 連線／field-scrub／sql-guard／純讀報表／rbac 權限判斷／common
  // helper）——唔准另外起一個會掂到寫入客戶端嘅業務數據 helper 再
  // import 落嚟。呢度用「解析做 repo-root 相對路徑」嚟比對（見
  // `resolveImportToRepoPath()`），唔係逐個 import specifier 串比對——
  // 兩個目錄慣用嘅寫法唔同（`src/lib/ai/tools/**` 慣用相對路徑
  // `"../db"`／`"./common"`，`src/lib/feedback/ai-tools/**` 慣用
  // `@/lib/...` alias），解析做同一種表示先可以用同一套 allowlist。
  const ALLOWED_LIB_IMPORT_TARGETS = [
    "src/lib/reports/", // prefix——純讀 report builder
    "src/lib/ai/db.ts", // 唯讀 pg 連線（aiQuery()）
    "src/lib/ai/field-scrub.ts",
    "src/lib/ai/sql-guard.ts",
    "src/lib/ai/tools/common.ts",
    "src/lib/rbac/requirePermission.ts",
    "src/lib/rbac/matrix.ts", // `Module` type——規劃裁定：工具要跟返畫面權限（見 tools/common.ts）
    "src/lib/api/field-groups.ts",
    "src/lib/app-error-log.ts", // WP-AI-DIAG：`recent_app_errors` 嘅專用 reader（`listRecentAppErrors()`，只讀已遮罩日誌；跟 list_feedback 先例，tool 檔本身唔含 prisma.／@/lib/db）
    "src/lib/ui/broker-kind.ts", // P2-B 應修⑤：`BROKER_KIND_LABEL` 搬咗去呢度，tools/common.ts re-export（純字面量 map，唔碰 DB）
  ];

  // 明列豁免——`list_feedback` 用 `@/lib/db`（Prisma）直接讀
  // `feedback_reports`，原因（詳見 docs/ai-assistant.md「ai schema 唔加
  // view」一節）：(1) 只讀 `findMany`，冇任何寫入方法調用（另有
  // `tests/feedback-tools-readonly.test.ts` 逐檔案掃 Prisma 寫入方法）；
  // (2) 老闆限定（`buildAiTools()` 淨係 `baseRole==="老闆"` 先掛載，
  // `run()` 入面 defense-in-depth 再核一次）；(3) `feedback_reports`
  // 本身唔喺 `ai` schema，冇對應嘅唯讀 view 可以用。呢個豁免逐檔案明
  // 列（`Record`），唔係一條寬鬆嘅目錄級例外。
  const IMPORT_ALLOWLIST_EXEMPTIONS: Record<string, string[]> = {
    "src/lib/feedback/ai-tools/list-feedback.ts": ["src/lib/db.ts"],
  };

  /** 將一個 import specifier（相對路徑或者 `@/...` alias，`@/` → `src/`，
   * 見 tsconfig.json `paths`）解析做 repo-root 相對嘅 `.ts` 檔案路徑，
   * 等兩種寫法可以用同一套 allowlist 比對。淨係處理「相對路徑」同
   * `@/lib/` alias——第三方套件（`imp` 唔屬於呢兩種）由呼叫方自己
   * 跳過，唔會行到呢度。 */
  function resolveImportToRepoPath(fromFileRelPath: string, importSpecifier: string): string {
    if (importSpecifier.startsWith("@/")) {
      return path.join("src", importSpecifier.slice(2)) + ".ts";
    }
    const fromDir = path.dirname(path.join(ROOT, fromFileRelPath));
    return path.relative(ROOT, path.resolve(fromDir, importSpecifier)) + ".ts";
  }

  const TOOL_FILES = MODEL_FACING_TOOL_DIRS.flatMap((dir) => listFiles(dir)).filter((f) => !f.endsWith("index.ts"));

  it("MODEL_FACING_TOOL_DIRS 兩個目錄合共掃到合理數量嘅檔案", () => {
    expect(TOOL_FILES.length).toBeGreaterThanOrEqual(11); // 10+ 條 src/lib/ai/tools/*.ts + list-feedback.ts
  });

  it.each(TOOL_FILES)("%s 嘅 lib import 淨係嚟自 allowlist（含明列豁免）", (relPath) => {
    const src = readSource(relPath);
    const importLines = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const imp of importLines) {
      const isRelevant = imp.startsWith(".") || imp.startsWith("@/lib/");
      if (!isRelevant) continue; // zod、@anthropic-ai/sdk/* 等第三方套件唔受限
      const resolved = resolveImportToRepoPath(relPath, imp);
      const exempted = IMPORT_ALLOWLIST_EXEMPTIONS[relPath]?.includes(resolved) ?? false;
      const allowed = exempted || ALLOWED_LIB_IMPORT_TARGETS.some((target) => resolved === target || resolved.startsWith(target));
      expect(allowed, `${relPath} import 咗未列入 allowlist 嘅 "${imp}"（解析做 "${resolved}"）`).toBe(true);
    }
  });

  // 同 ALL_SCANNED 嗰兩條一致風格，擴展落 MODEL_FACING_TOOL_DIRS 兩個
  // 目錄（`list-feedback.ts` 之前唔喺任何結構性掃描嘅 tree 之內，冇被
  // 斷言過「冇 fetch(」／「冇 import route.ts」）。
  it.each(TOOL_FILES)("%s 冇 fetch( 去內部 API（去走 comment/string 之後）", (relPath) => {
    const code = stripCommentsAndStrings(readSource(relPath));
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it.each(TOOL_FILES)("%s 冇 import 任何 src/app/api/**/route", (relPath) => {
    const src = readSource(relPath);
    expect(src).not.toMatch(/from\s+["'][^"']*\/api\/[^"']*\/route["']/);
  });

  // 「將來新目錄會被抓到」：靜態掃 `src/lib/ai/tools/index.ts`（
  // `buildAiTools()` 嘅定義處）入面每一個供俾 `create*Tool` 工廠函數嘅
  // import，解析嗰個 import 嘅來源檔案，斷言一定喺 MODEL_FACING_TOOL_
  // DIRS 之內——如果第日有人加多一個工具檔案擺第三個目錄（例如
  // `src/lib/reports/ai-tools/`）再喺呢度 import 落嚟用，呢條會唔通過，
  // 唔使個新目錄自己記得嚟呢個 test 度加白名單。
  it("buildAiTools() 回傳嘅每個工具嘅定義檔都必須喺 MODEL_FACING_TOOL_DIRS 之內", () => {
    const indexRelPath = "src/lib/ai/tools/index.ts";
    const src = readSource(indexRelPath);
    const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    let toolFactoryImportCount = 0;
    while ((match = importRegex.exec(src))) {
      const importedNames = match[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!.trim());
      const modSpecifier = match[2]!;
      const isToolFactoryImport = importedNames.some((n) => /^create[A-Za-z0-9]*Tool$/.test(n));
      if (!isToolFactoryImport) continue; // 淨係理 `create*Tool` 呢類工廠函數 import（`common`/型別 import 唔屬於「工具定義檔」）
      toolFactoryImportCount++;
      const resolved = resolveImportToRepoPath(indexRelPath, modSpecifier);
      const inAllowedDir = MODEL_FACING_TOOL_DIRS.some((dir) => resolved === `${dir}.ts` || resolved.startsWith(`${dir}/`));
      expect(inAllowedDir, `${indexRelPath} 嘅 "${modSpecifier}"（解析做 "${resolved}"）唔喺 MODEL_FACING_TOOL_DIRS 之內`).toBe(true);
    }
    // 防止 regex 打空令呢條斷言形同虛設（現時 14 個 create*Tool import）。
    expect(toolFactoryImportCount).toBeGreaterThanOrEqual(10);
  });
});
