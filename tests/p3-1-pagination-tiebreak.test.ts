// P3-1.8（B-4）：offset 分頁 list route 嘅 orderBy 必須有 `id` 做 tie-breaker（否則同值行次序不穩定，
// 第 1／2 頁之間可能重複或漏行）；P3-1.7（B-3）：三個大 interactive tx 必須有 timeout。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/route\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("P3-1.8 分頁 orderBy 加 id tie-breaker", () => {
  it("所有帶 skip＋take 嘅 findMany，orderBy 都含 id", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const file of walk(path.join(root, "app/api"))) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.findMany\(/.test(line) || !/\bskip\b/.test(line) || !/\btake\b/.test(line)) return;
        checked++;
        if (!/orderBy:\s*\[[^\]]*\{\s*id:\s*"(asc|desc)"\s*\}\s*\]/.test(line)) bad.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(bad).toEqual([]);
  });
});

describe("P3-1.7 大 interactive transaction 有 timeout", () => {
  it.each([
    ["app/api/shift-records/batch/route.ts"],
    ["app/api/months/[month]/open/route.ts"],
    ["lib/roster-upload/service.ts"],
  ])("%s 含 timeout: 60_000", (rel) => {
    expect(fs.readFileSync(path.join(root, rel), "utf8")).toContain("timeout: 60_000, maxWait: 10_000");
  });
});
