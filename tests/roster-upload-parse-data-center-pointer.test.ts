// WP-ROSTER-UPLOAD Phase B-1（B1-8 第 5 項）：`applyDataCenterMarkerPointer()`
// 合成單元測試——證明呢個 pure function 本身邏輯啱（同一 row_index 遇到
// 「數據中心」marker 格之後嘅日子填 sub_site_name="數據中心"，直至嗰條
// row_index 完結；已經有真實子盤欄值嘅格唔畀蓋過去）。
//
// 呢個函數刻意未接落 `parse.ts` 嘅 `extractSheet()` pipeline——實測
// `npm run gate:roster-parse` 對住真實 8 月 CP5 主檔（2 粒「數據中心」
// marker 格）發現接咗落去會令 sub_site_names 同 8 月試算 python
// importer 嘅 ground truth fixture 唔夾（36/36 變 35/36）。即係任務書
// 「該格之後嘅行……屬數據中心子盤」呢條規則，同呢兩粒已知真實 marker
// 格嘅正確行為有出入，唔敢自己假設邊個啱，所以用呢個合成測試證明邏輯
// 本身冇寫錯，但唔接落真實 pipeline（回報會講呢個矛盾）。
import { describe, it, expect } from "vitest";
import { applyDataCenterMarkerPointer, type ParsedCellRow } from "@/lib/roster-upload/parse";

function cell(overrides: Partial<ParsedCellRow> & Pick<ParsedCellRow, "rowIndex" | "workDate" | "rawCode" | "codeKind">): ParsedCellRow {
  return {
    subSiteName: null,
    staffNoRaw: "U90001",
    nameRaw: "測試保安員甲",
    telRaw: "6100001",
    rankRaw: null,
    timeRaw: null,
    brokerCodeRaw: null,
    hours: null,
    warnings: [],
    ...overrides,
  };
}

describe("WP-ROSTER-UPLOAD Phase B-1：applyDataCenterMarkerPointer()", () => {
  it("marker 格之後、同一 row_index 嘅日子填返「數據中心」", () => {
    const rows = [
      cell({ rowIndex: 10, workDate: "2026-09-01", rawCode: "N", codeKind: "shift" }),
      cell({ rowIndex: 10, workDate: "2026-09-02", rawCode: "數據中心", codeKind: "marker" }),
      cell({ rowIndex: 10, workDate: "2026-09-03", rawCode: "N", codeKind: "shift" }),
      cell({ rowIndex: 10, workDate: "2026-09-04", rawCode: "N", codeKind: "shift" }),
    ];
    const result = applyDataCenterMarkerPointer(rows);
    const bySubSite = new Map(result.map((r) => [r.workDate, r.subSiteName]));
    expect(bySubSite.get("2026-09-01")).toBeNull();
    expect(bySubSite.get("2026-09-02")).toBeNull(); // marker 格本身唔改自己
    expect(bySubSite.get("2026-09-03")).toBe("數據中心");
    expect(bySubSite.get("2026-09-04")).toBe("數據中心");
  });

  it("唔同 row_index（下一位保安員）唔會俾上一行嘅 marker 影響——天然邊界", () => {
    const rows = [
      cell({ rowIndex: 10, workDate: "2026-09-01", rawCode: "數據中心", codeKind: "marker" }),
      cell({ rowIndex: 10, workDate: "2026-09-02", rawCode: "N", codeKind: "shift" }),
      cell({ rowIndex: 11, workDate: "2026-09-01", rawCode: "N", codeKind: "shift" }),
    ];
    const result = applyDataCenterMarkerPointer(rows);
    const row11 = result.find((r) => r.rowIndex === 11 && r.workDate === "2026-09-01");
    expect(row11?.subSiteName).toBeNull();
  });

  it("已經有真實子盤欄值嘅格唔畀 marker 蓋過", () => {
    const rows = [
      cell({ rowIndex: 20, workDate: "2026-09-01", rawCode: "數據中心", codeKind: "marker" }),
      cell({ rowIndex: 20, workDate: "2026-09-02", rawCode: "N", codeKind: "shift", subSiteName: "柴灣車廠" }),
    ];
    const result = applyDataCenterMarkerPointer(rows);
    const row = result.find((r) => r.workDate === "2026-09-02");
    expect(row?.subSiteName).toBe("柴灣車廠");
  });

  it("冇 marker 格嘅行完全唔受影響", () => {
    const rows = [cell({ rowIndex: 30, workDate: "2026-09-01", rawCode: "N", codeKind: "shift" })];
    const result = applyDataCenterMarkerPointer(rows);
    expect(result[0]!.subSiteName).toBeNull();
  });
});
