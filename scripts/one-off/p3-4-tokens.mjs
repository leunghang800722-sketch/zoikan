// P3-4.1 一次性 codemod：arbitrary hex class / Tailwind 原生色 / text-[Npx] → zk-* token。
// 只改 className 字串，值等於（或就近）現有 token；唔改任何 logic。用法：node scripts/one-off/p3-4-tokens.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");
const ROOT = path.resolve(process.cwd(), "src");

const HEX = {
  "334155": "text-secondary", "2563eb": "primary", "dc2626": "danger", "0f766e": "success", "e5e7eb": "border",
  "b91c1c": "danger-dark", "fef2f2": "danger-bg", "c2410c": "warning", "94a3b8": "faint", "d1d5db": "input-border",
  "fecaca": "danger-border", "1e40af": "primary-deep", "475569": "text-secondary", "cbd5e1": "faintest", "64748b": "muted",
  "fafbfc": "header", "b45309": "warning-darker", "1d4ed8": "primary-dark", "fff7ed": "warning-bg", "eff6ff": "primary-tint-soft",
  "dbeafe": "primary-tint", "9a3412": "warning-dark", "f8fafc": "surface-2", "ecfdf5": "success-bg", "047857": "success-dark",
  "f6f7f9": "bg", "ccfbf1": "success-tint", "ffedd5": "warning-tint", "fee2e2": "danger-tint", "93c5fd": "primary-light",
  "1e293b": "dark-hover", "f59e0b": "amber", "fed7aa": "warning-border",
};
const PREFIX = "bg|text|border|border-[tblrxy]|ring|fill|stroke|from|to|via|divide|outline|decoration|placeholder|accent|caret";
const hexRe = new RegExp(`(?<![\\w-])((?:[a-z0-9-]+:)*)(${PREFIX})-\\[#([0-9a-fA-F]{3,6})\\](\\/\\d+)?`, "g");

function mapHex(prefix, hex) {
  let h = hex.toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h === "ffffff") return "white";
  if (h === "0f172a") return /^(text|placeholder|decoration|caret|accent)$/.test(prefix) ? "zk-text" : "zk-dark";
  if (h === "f1f5f9") return /^(border|divide|ring|outline)/.test(prefix) ? "zk-border-soft" : "zk-surface";
  const t = HEX[h];
  return t ? `zk-${t}` : null;
}

const NATIVE = {
  red: { 50: "danger-bg", 100: "danger-tint", 200: "danger-border", 300: "danger-border", 400: "danger", 500: "danger", 600: "danger", 700: "danger-dark", 800: "danger-dark" },
  green: { 50: "success-bg", 100: "success-tint", 200: "success/30", 300: "success/30", 600: "success", 700: "success-dark", 800: "success-dark" },
  emerald: { 50: "success-bg", 700: "success-dark" },
  orange: { 50: "warning-bg", 100: "warning-tint", 200: "warning-border", 300: "warning-border", 600: "warning", 700: "warning", 800: "warning-dark", 900: "warning-dark" },
  amber: { 50: "warning-bg", 100: "warning-tint", 200: "warning-border", 300: "warning-border", 700: "warning-darker", 800: "warning-dark", 900: "warning-dark" },
  yellow: { 50: "warning-bg", 200: "warning-border", 300: "warning-border", 600: "warning-darker", 800: "warning-dark", 900: "warning-dark" },
  blue: { 50: "primary-tint-soft", 100: "primary-tint", 200: "primary/30", 300: "primary/30", 600: "primary", 700: "primary-dark", 900: "primary-deep" },
  gray: { 50: "header", 100: "surface", 200: "border", 300: "input-border", 400: "faint", 500: "muted", 600: "text-secondary", 700: "text-secondary", 800: "dark-hover", 900: "dark" },
};
const GRAY_BORDER100 = "border-soft";
const nativeRe = new RegExp(`(?<![\\w-])((?:[a-z0-9-]+:)*)(${PREFIX})-(red|green|emerald|orange|amber|yellow|blue|gray)-(\\d{2,3})(\\/\\d+)?(?![\\w-])`, "g");

const FS = { "9": "2xs", "9.5": "2xs", "10": "2xs", "10.5": "2xs", "11": "xs", "11.5": "xs", "12": "sm", "12.5": "sm", "13": "base", "13.5": "base", "14": "md", "15": "md", "16": "lg", "17": "lg", "18": "lg", "19": "xl", "20": "xl", "21": "xl", "22": "xl", "26": "2xl", "28": "2xl", "30": "2xl" };
const fsRe = /(?<![\w-])((?:[a-z0-9-]+:)*)text-\[([0-9.]+)px\]/g;

let counts = { hex: 0, hexLeft: 0, native: 0, fs: 0, files: 0 };
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, "utf8");
  let s = src;
  s = s.replace(hexRe, (m, vars, prefix, hex, op) => {
    const t = mapHex(prefix, hex);
    if (!t) { counts.hexLeft++; return m; }
    counts.hex++;
    return `${vars}${prefix}-${t}${op ?? ""}`;
  });
  s = s.replace(nativeRe, (m, vars, prefix, color, shade, op) => {
    let t = NATIVE[color]?.[Number(shade)];
    if (color === "gray" && shade === "100" && /^border|^divide/.test(prefix)) t = GRAY_BORDER100;
    if (!t) return m;
    counts.native++;
    // 已帶 /opacity 嘅 token（例如 success/30）+ 原本冇 op
    return `${vars}${prefix}-zk-${t}${op ?? ""}`;
  });
  s = s.replace(fsRe, (m, vars, n) => {
    const k = FS[n] ?? FS[String(Number(n))];
    if (!k) return m;
    counts.fs++;
    return `${vars}text-zk-${k}`;
  });
  if (s !== src) {
    counts.files++;
    if (!DRY) fs.writeFileSync(f, s);
  }
}
console.log(JSON.stringify(counts));
