// WP-TERM-GUARD：顯示用詞「安員」→「保安員」守門。
// (a) src/** 冇殘留舊稱（allowlist 以外）；(b) 「保保安員」0；(c) 四（加兩）個 permission key 仍存在。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MATRIX, MODULES, ROLE_NAMES } from "../src/lib/rbac/matrix";
import { MODULE_LABELS, moduleLabel } from "../src/lib/rbac/labels";

const ROOT = path.resolve(__dirname, "..");
const PERMISSION_KEYS = ["安員", "自己安員", "安員個人資料", "安員銀行資料", "安員批量導入", "安員配對修復"];
const OLD = /(?<!保)安員/g;

function tracked(dirs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...dirs], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => /\.(ts|tsx|mjs|js|md|sh)$/.test(f) && !f.endsWith("tests/term-guard.test.ts") && !f.includes("one-off/term-guard-scan"));
}

/** 去掉「permission key／角色名」精確字串字面值同物件 key（呢類係內部識別，唔改）。 */
function stripAllowed(line: string): string {
  let s = line;
  for (const k of PERMISSION_KEYS) {
    s = s.replace(new RegExp(`(["'\`])${k}\\1`, "g"), "");
  }
  // 物件 key（安員: …／安員個人資料: …）
  s = s.replace(/(^|[\s{,])(自己安員|安員個人資料|安員銀行資料|安員批量導入|安員配對修復|安員)\s*:(?!:)/g, "$1");
  // 舊資料相容 marker：/保?安員…/（容許舊 DB 已存嘅舊稱字串）
  s = s.replace(/保\?安員/g, "");
  return s;
}

describe("WP-TERM-GUARD", () => {
  it("(a) src/** 顯示字串冇舊稱「安員」（permission key 檔／精確 key 字面值除外）", () => {
    const ALLOW_FILES = new Set(["src/lib/rbac/matrix.ts", "src/lib/rbac/labels.ts", "src/lib/ui/format.ts"]);
    const bad: string[] = [];
    for (const f of tracked(["src"])) {
      if (ALLOW_FILES.has(f)) continue;
      readFileSync(path.join(ROOT, f), "utf8")
        .split("\n")
        .forEach((l, i) => {
          if (OLD.test(stripAllowed(l))) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
          OLD.lastIndex = 0;
        });
    }
    expect(bad).toEqual([]);
  });

  it("(b) 全 repo（src／tests／docs／scripts）「保保安員」0", () => {
    const bad: string[] = [];
    for (const f of tracked(["src", "tests", "docs", "scripts", "README.md"])) {
      if (readFileSync(path.join(ROOT, f), "utf8").includes("保保安員")) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  it("(c) permission key 不變：matrix 有 key、角色名仍有「安員」、顯示經 label 對照", () => {
    for (const k of PERMISSION_KEYS) {
      expect(MODULES as readonly string[]).toContain(k);
      for (const role of ROLE_NAMES) expect(DEFAULT_MATRIX[role][k as keyof typeof DEFAULT_MATRIX["老闆"]]).toBeDefined();
      expect(MODULE_LABELS[k]).toBe(k.replace("安員", "保安員"));
      expect(moduleLabel(k)).toMatch(/保安員/);
    }
    expect(ROLE_NAMES as readonly string[]).toContain("安員");
    expect(moduleLabel("糧務")).toBe("糧務");
  });
});
