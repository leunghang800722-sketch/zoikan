import fs from "node:fs";
import { parse } from "csv-parse/sync";

export function readCsv<T = Record<string, string>>(path: string): T[] {
  if (!fs.existsSync(path)) {
    throw new Error(`CSV 唔存在: ${path}`);
  }
  const raw = fs.readFileSync(path, "utf-8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    // P1-WP3：tools/importer/out/wp1/rows.csv 開頭有 UTF-8 BOM
    // （`﻿`）——冇呢個 option 嘅話第一欄嘅 header 名會變成
    // "﻿file"，令逐個 row.file 查詢全部 undefined。csv-parse 嘅
    // `bom:true` 會喺 parse 之前自動剝走呢個 BOM；其餘現有 CSV（wp2b/*）
    // 本身冇 BOM，呢個 option 對佢哋冇行為影響。
    bom: true,
  }) as T[];
}

export function num(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: string | undefined | null): boolean {
  return String(v).trim().toLowerCase() === "true";
}

export function str(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function dateOnly(v: string | undefined | null): Date | null {
  const s = str(v);
  if (!s) return null;
  // work_date/effective_from 呢啲純日期欄位，一律當 Asia/Hong_Kong 嘅曆日、
  // 存做 UTC 午夜（Prisma @db.Date 唔理時區，但要避免 JS Date parse 受本機時區影響）
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

export function timeOnly(v: string | undefined | null): Date | null {
  const s = str(v);
  if (!s) return null;
  const [h, mi] = s.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(mi)) return null;
  // Prisma @db.Time 淨係用返 Date 個 time-of-day 部分，年月日隨便揀一個固定值
  return new Date(Date.UTC(1970, 0, 1, h, mi, 0));
}

export function arr(v: string | undefined | null, sep = ";"): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);
}
