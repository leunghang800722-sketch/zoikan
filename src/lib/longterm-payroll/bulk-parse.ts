// P14.2：批量導入檔（JSON／CSV）→ rows。client-safe 純函數（唔 import server 模組）。
// CSV 第一行係表頭（欄名＝staff_no／staff_no_mw／name_en／name_zh／kind／amount／date_from／date_to／doctor_note_verified／note）。
const KEYS = ["staff_no", "staff_no_mw", "name_en", "name_zh", "kind", "amount", "date_from", "date_to", "doctor_note_verified", "note"] as const;

/** RFC4180 簡化版 CSV 解析（支援 "" 轉義、欄內逗號／換行）。 */
export function parseCsvText(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  return out;
}

/** P15.2：平均工資批量用 `{ keys: AVG_WAGE_KEYS, required: "avg_daily_wage", numeric: ["avg_daily_wage"] }`。 */
export const AVG_WAGE_BULK_OPTS = { keys: ["staff_no", "staff_no_mw", "name_en", "name_zh", "avg_daily_wage", "note"], required: "avg_daily_wage", numeric: ["avg_daily_wage"] } as const;

export function parseBulkText(name: string, text: string, opts: { keys: readonly string[]; required: string; numeric: readonly string[] } = { keys: KEYS, required: "kind", numeric: ["amount"] }): { rows: Record<string, unknown>[]; error: string | null } {
  try {
    if (/\.json$/i.test(name) || text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) {
      const j = JSON.parse(text) as unknown;
      const arr = Array.isArray(j) ? j : j && typeof j === "object" && Array.isArray((j as { rows?: unknown }).rows) ? (j as { rows: unknown[] }).rows : null;
      if (!arr) return { rows: [], error: "JSON 要係陣列，或者 { rows: [...] }" };
      return { rows: arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") as Record<string, unknown>[], error: null };
    }
    const grid = parseCsvText(text);
    if (grid.length < 2) return { rows: [], error: "CSV 要有表頭行同至少一行資料" };
    const head = grid[0]!.map((h) => h.trim().toLowerCase());
    if (!head.includes(opts.required)) return { rows: [], error: `CSV 表頭要有 ${opts.required} 欄` };
    const rows = grid.slice(1).map((r) => {
      const o: Record<string, unknown> = {};
      head.forEach((h, i) => {
        if (!opts.keys.includes(h)) return;
        const v = (r[i] ?? "").trim();
        if (v === "") return;
        if (opts.numeric.includes(h)) o[h] = Number.isFinite(Number(v)) ? Number(v) : v;
        else if (h === "doctor_note_verified") o[h] = /^(1|true|yes|y|是)$/i.test(v);
        else o[h] = v;
      });
      return o;
    });
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: `讀唔到檔案：${e instanceof Error ? e.message : "格式錯"}` };
  }
}
