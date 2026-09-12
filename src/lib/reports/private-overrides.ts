// P1-WP4：由 scripts/report/lib/private-overrides.ts 搬入 src/lib/reports/
// （單一位置，俾 scripts/report/diff.ts 同 src/lib/reports/monthly-close.ts
// 兩邊共用，符合「scripts 做 thin wrapper，邏輯歸一入 src/lib」嘅原則）。
// PDPO：某幾個 P0 xlsx 渲染產物嘅已知落差要用實際 settlement_page／客戶
// 全名嚟做比對，但呢個真名唔可以硬編碼喺 git-tracked 嘅程式碼入面。真名
// （如果有）由 gitignored 嘅 data/mappings-private/report-overrides.json
// 讀入；冇呢個檔案就跳過呢個特例（該頁行標準比對路徑，唔會靜默豁免）。
import fs from "node:fs";
import path from "node:path";

const PRIVATE_OVERRIDES_JSON = path.join(process.cwd(), "data", "mappings-private", "report-overrides.json");

interface ReportOverrides {
  mixedRateArtifactPage?: string;
  excludedClientNames?: string[];
}

let cached: ReportOverrides | null = null;
function load(): ReportOverrides {
  if (cached) return cached;
  if (!fs.existsSync(PRIVATE_OVERRIDES_JSON)) {
    cached = {};
    return cached;
  }
  cached = JSON.parse(fs.readFileSync(PRIVATE_OVERRIDES_JSON, "utf-8")) as ReportOverrides;
  return cached;
}

export function mixedRateArtifactPage(): string | undefined {
  return load().mixedRateArtifactPage;
}

export function excludedClientNames(): string[] {
  return load().excludedClientNames ?? [];
}

export function reportOverridesFileExists(): boolean {
  return fs.existsSync(PRIVATE_OVERRIDES_JSON);
}
