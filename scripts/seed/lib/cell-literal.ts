// P1-WP3 Gate 1（規劃裁定，分階段純加法）：讀一個 exceljs cell 嘅原始
// 字面，做返 `RawCellValue`（見 `src/lib/roster-layout-template.ts`）。
// 呢個 helper 俾 `roster-raw.ts`（逐條 shift_record 嘅 raw_row）同
// `roster-layout.ts`（guard_rows section 嘅 rawRows）共用，避免兩份
// 幾乎一樣嘅邏輯各自維護、日後漂移。
import type ExcelJS from "exceljs";
import type { RawCellValue, RawRow } from "../../../src/lib/roster-layout-template";

export function cellRawValue(cell: ExcelJS.Cell): RawCellValue | null {
  const v = cell.value;
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      const s = (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
      return s === "" ? null : s;
    }
    // formula 形狀（master "formula" 或 follower "sharedFormula"）——真正
    // cached 數值喺 `cell.result`（ExcelJS 獨立屬性，同
    // `scripts/report/roster-export-diff.ts` 嘅 `cellEffectiveRaw()`
    // 一致手法）。
    if ("formula" in o || "sharedFormula" in o) {
      const result = cell.result;
      let resultVal: string | number | null;
      if (result === null || result === undefined) resultVal = null;
      else if (result instanceof Date) resultVal = result.toISOString();
      else if (typeof result === "object") resultVal = null; // 罕見嵌套形狀，唔識就唔存 result（formula 文字本身仍然存）
      else resultVal = result;
      const formulaText = typeof o.formula === "string" && o.formula ? o.formula : null;
      if (formulaText) return { formula: formulaText, result: resultVal };
      // 冇真正 formula 文字（純 sharedFormula follower，master cell 嘅
      // formula string 冇喺呢個 cell.value 出現）——直接存 resolved
      // 結果做返 plain 值（唔起 `{formula:"",...}` wrapper）。ExcelJS
      // `Value.getType()`（node_modules/exceljs/lib/doc/cell.js）淨係
      // 睇 `value.formula || value.sharedFormula` 係咪 truthy 嚟判斷係咪
      // formula cell——`formula:""` 係 falsy，會令佢完全認唔到係
      // formula 格、跌落 JSON type 寫失敗（實測：淺水灣道11號蔚峰園
      // R9C38 一撞到就變成完全冇寫入嘅 regression）；Gate 1 本身淨係
      // 比較 resolved 值（唔比較 formula 文字），所以直接存 plain 值
      // 對 gate 結果冇影響，仲順手避開成個 ExcelJS 陷阱。
      return resultVal;
    }
    if ("result" in o) {
      const r = (o as { result: unknown }).result;
      if (typeof r === "string" || typeof r === "number") return r;
      return null;
    }
    return null;
  }
  if (typeof v === "string" || typeof v === "number") return v;
  return null;
}

/** 讀成行非空 cell，做返 `RawRow`（col number → 值）。冇非空 cell 就
 * 返 `null`（同「呢一行喺原檔本身就係完全空白」區分開，等 caller 決定
 * 要唔要當「冇資料」處理）。 */
export function rowRawLiteral(ws: ExcelJS.Worksheet, row: number): RawRow | null {
  const out: RawRow = {};
  ws.getRow(row).eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cellRawValue(cell);
    if (v !== null) out[String(col)] = v;
  });
  return Object.keys(out).length === 0 ? null : out;
}
