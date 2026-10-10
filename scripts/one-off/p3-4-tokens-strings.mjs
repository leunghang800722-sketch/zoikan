// P3-4.1 一次性 codemod (2)：字串／inline style 內嘅 hex → var(--zk-*)；以及少量近似色 class。
import fs from "node:fs";
import path from "node:path";
const DRY = process.argv.includes("--dry");
const ROOT = path.resolve(process.cwd(), "src");
const SKIP = [/browser-images\.ts$/, /manifest\.ts$/, /app\/layout\.tsx$/, /broker-color\.ts$/, /shift-code-color\.ts$/];
const V = {
  "334155": "text-secondary", "475569": "text-secondary", "2563eb": "primary", "dc2626": "danger", "0f766e": "success", "e5e7eb": "border",
  "b91c1c": "danger-dark", "fef2f2": "danger-bg", "c2410c": "warning", "94a3b8": "faint", "d1d5db": "input-border", "fecaca": "danger-border",
  "1e40af": "primary-deep", "cbd5e1": "faintest", "64748b": "muted", "fafbfc": "header", "b45309": "warning-darker", "1d4ed8": "primary-dark",
  "fff7ed": "warning-bg", "eff6ff": "primary-tint-soft", "dbeafe": "primary-tint", "9a3412": "warning-dark", "f8fafc": "surface-2",
  "ecfdf5": "success-bg", "047857": "success-dark", "f6f7f9": "bg", "ccfbf1": "success-tint", "ffedd5": "warning-tint", "fee2e2": "danger-tint",
  "93c5fd": "primary-light", "1e293b": "dark-hover", "f59e0b": "amber", "fed7aa": "warning-border", "0f172a": "text", "f1f5f9": "surface",
  "ffffff": "card", "fff": "card",
  // 近似
  "f97316": "warning", "ea580c": "warning", "fffbf5": "warning-bg", "fde4c4": "warning-border", "fffafa": "danger-bg", "f0f7ff": "primary-tint-soft",
  "f8fbff": "primary-tint-soft", "a7f3d0": "success-bg", "bfdbfe": "primary-tint", "15803d": "success-dark", "e2e8f0": "border",
};
// class 版（近似色）
const CLS = { "fffbf5": "warning-bg", "fde4c4": "warning-border", "fffafa": "danger-bg", "f0f7ff": "primary-tint-soft", "f8fbff": "primary-tint-soft", "a7f3d0": "success-border", "bfdbfe": "primary-tint", "15803d": "success-dark", "ea580c": "warning", "f97316": "warning", "e2e8f0": "border" };
const PREFIX = "bg|text|border|border-[tblrxy]|ring|fill|stroke|divide";
const clsRe = new RegExp(`(?<![\\w-])((?:[a-z0-9-]+:)*)(${PREFIX})-\\[#([0-9a-fA-F]{6})\\](\\/\\d+)?`, "g");
function walk(d, out = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name)) out.push(p); } return out; }
let n = 0, c = 0;
for (const f of walk(ROOT)) {
  if (SKIP.some((r) => r.test(f))) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return line;
    const cut = line.indexOf("//") >= 0 && !/https?:\/\//.test(line) ? line.indexOf("//") : line.length;
    let head = line.slice(0, cut), tail = line.slice(cut);
    const h0 = head;
    head = head.replace(clsRe, (m, vars, prefix, hex, op) => {
      const k = CLS[hex.toLowerCase()];
      if (!k) return m;
      c++;
      if (k === "success-border") return `${vars}${prefix}-zk-success/30${op ?? ""}`;
      return `${vars}${prefix}-zk-${k}${op ?? ""}`;
    });
    head = head.replace(/(["'`])([^"'`\n]*?)#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (m) => m); // noop（保留）
    // 字串內任何 hex（唔係 class 內 [#…]）
    head = head.replace(/(?<!\[)#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])/g, (m, hex, off, str) => {
      const k = V[hex.toLowerCase()];
      if (!k) return m;
      // 必須喺引號字串內：數前面引號數量為奇數
      const before = str.slice(0, off);
      const inStr = ((before.match(/"/g) || []).length % 2 === 1) || ((before.match(/'/g) || []).length % 2 === 1) || ((before.match(/`/g) || []).length % 2 === 1);
      if (!inStr) return m;
      n++;
      return `var(--zk-${k})`;
    });
    if (head !== h0) changed = true;
    return head + tail;
  });
  if (changed && !DRY) fs.writeFileSync(f, out.join("\n"));
}
console.log(JSON.stringify({ strings: n, cls: c }));
