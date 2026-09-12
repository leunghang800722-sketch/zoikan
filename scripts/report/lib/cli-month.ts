// P1-WP3：`scripts/report/*` 去除寫死 2026-07——共用 `--month YYYY-MM`
// CLI 參數解析，冇傳就跌返 2026-07（保留原本行為，`npm run report:regen`
// 唔使加參數都照跑得到）。
export function parseMonthArg(argv: string[], fallback = "2026-07"): Date {
  const idx = argv.indexOf("--month");
  const raw = idx >= 0 ? argv[idx + 1] : fallback;
  if (!raw) throw new Error("--month 要帶值（YYYY-MM）");
  const iso = raw.length <= 7 ? `${raw}-01` : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`--month 格式唔啱: ${raw}（要 YYYY-MM）`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
