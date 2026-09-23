// 驗收 2026-09-23：`tests/fixtures/roster-parse-aug-2026.json` 以檔名做
// key，但有個 8 月更表檔名本身夾住「<人名> U<工號>」（檔名係會計自己改
// 嘅），直接入 git 違反「code／fixture 唔准有真名／真工號」鐵則。gate
// 同 fixture builder 一律用呢個函數將檔名轉做 fixture key：剝走「中文名
// ＋U 號」同任何獨立 U 號 token，其餘（盤號、盤名、月份）保留方便人睇。
export function rosterFixtureKey(fileName: string): string {
  return fileName
    .replace(/\s*[一-鿿]{2,4}\s+U\d{4,6}\b/g, "")
    .replace(/\s*\bU\d{4,6}\b/g, "")
    .replace(/\s{2,}/g, " ");
}
