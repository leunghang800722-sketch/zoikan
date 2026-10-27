// 倉庫衛生：測試／程式碼／docs 入面唔可以出現真實員工編號。真實 U／MP／MG／MW 號分佈喺 0–8 字頭（U0／U1… 都有），，
// 所以合成工號一律用 9 字頭（U9xxxx／MP9xxx）；呢度掃全部文字檔，非 9 字頭（含 O 誤讀寫法）一律 fail。
// 冇允許清單：舊有嘅連號佔位（原本 0 字頭）已全部改做 9 字頭。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["src", "tests", "docs", "scripts"];
const EXT = new Set([".ts", ".tsx", ".md", ".mjs", ".js", ".json", ".sh", ".psv", ".csv"]);
const RE = /\b(U|MP|MG|MW)[0-8O][0-9O]{3,5}\b/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(name))) out.push(p);
  }
}

describe("repo hygiene：員工編號", () => {
  it("src／tests／docs／scripts 冇非 9 字頭嘅員工編號樣 token（只報計數同位置，唔印號碼）", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(path.join(process.cwd(), r), files);
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(RE)) bad.push(`${path.relative(process.cwd(), f)}:${text.slice(0, m.index).split("\n").length}`);
    }
    expect(bad, `非 9 字頭工號樣 token 位置：${bad.join(", ")}`).toEqual([]);
  });
});
