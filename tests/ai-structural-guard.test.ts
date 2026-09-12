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

  // 業務數據來源收窄：src/lib/ai/tools/*.ts 逐個工具檔案，`@/lib/*` 呢
  // 一類 import 淨係准嚟自呢個 allowlist（唯讀 DB 連線／field-scrub／
  // 純讀報表／rbac 權限判斷）——唔准另外起一個會掂到寫入客戶端嘅業務
  // 數據 helper 再 import 落嚟。
  const ALLOWED_LIB_IMPORT_PREFIXES = [
    "@/lib/reports/",
    "../db", // src/lib/ai/db.ts（相對路徑，tools/*.ts 入面用 "../db"）
    "../field-scrub",
    "../sql-guard",
    "./common",
    "../../rbac/requirePermission",
    "../../rbac/matrix", // `Module` type——規劃裁定：工具要跟返畫面權限（見 tools/common.ts）
    "../../api/field-groups",
  ];

  const TOOL_FILES = listFiles("src/lib/ai/tools").filter((f) => !f.endsWith("index.ts"));

  it("tools/ 目錄掃到合理數量嘅檔案", () => {
    expect(TOOL_FILES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(TOOL_FILES)("%s 嘅 lib import 淨係嚟自 allowlist（@/lib/ai/db、@/lib/reports/*、rbac/field-groups、common）", (relPath) => {
    const src = readSource(relPath);
    const importLines = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const imp of importLines) {
      const isThirdParty = !imp.startsWith(".") && !imp.startsWith("@/lib/") && !imp.startsWith("../") && !imp.startsWith("./");
      if (isThirdParty) continue; // zod、@anthropic-ai/sdk/* 等第三方套件唔受限
      if (imp.startsWith("@/lib/reports/")) continue;
      const allowed = ALLOWED_LIB_IMPORT_PREFIXES.some((prefix) => imp === prefix || imp.startsWith(prefix));
      expect(allowed, `${relPath} import 咗未列入 allowlist 嘅 "${imp}"`).toBe(true);
    }
  });
});
