// WP-GUARD-FIX：讀兩份人手維護嘅 Excel 名單——
//   1. U Team 名單（Wilson，`data/2026-09/msg-file/U Team - People
//      template 20260824.xlsx`，sheet1，1,395 行）——7 月之後入職嘅新
//      散工，`build-guard-fix-plan.ts` 用嚟起 `create` 個案。
//   2. 核對表「主檔（每人一行）」（`/Users/macbookpro/Desktop/MSG /
//      在勤員工資料核對表-2026-09-19（全部保留版）.xlsx`）——已經人手核
//      對過「DB 已有邊個人」嘅結果，`系統id` 直接係 `guards.id`，用嚟起
//      `link` 個案（見 build-guard-fix-plan.ts §「link 判斷」）。
//
// 兩個都係人手維護嘅 Excel，欄位次序由老闆/Wilson 定，唔會因為呢個
// script 執行而變——用固定欄位 index（呢個 module 頂註解記低咗），冇用
// header 文字比對（避免中文欄名有隱藏字元/全形空格導致比對唔中）。
import ExcelJS from "exceljs";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";

export const U_TEAM_XLSX_PATH = "data/2026-09/msg-file/U Team - People template 20260824.xlsx";
export const CROSS_CHECK_XLSX_PATH = "/Users/macbookpro/Desktop/MSG /在勤員工資料核對表-2026-09-19（全部保留版）.xlsx";

/** U Team 名單一行——欄位 index（0-based，任務指示已經核實）：
 * 員工編號(13)／中文姓名(15)／姓名（顯示名）(2)／電話號碼(9)／
 * 身份證/護照號碼(14)／入職日期(1)／員工狀態(4)。 */
export interface UTeamRow {
  uNumber: string | null; // 正規化（大寫、去空白）
  nameZh: string | null;
  displayName: string | null;
  tel: string | null; // 正規化
  hkid: string | null; // trim，大寫（同 guards.hkid 入 DB 前嘅慣例一致：唔轉大寫——保留原文，比對時先兩邊都轉大寫）
  hireDate: string | null; // YYYY-MM-DD
  employeeStatus: string | null;
}

function cellText(row: ExcelJS.Row, col1based: number): string | null {
  // 驗收：`.value` 嘅型別係 ExcelJS `CellValue`（union，`CellSharedFormulaValue`
  // 冇 index signature）——直接 cast 做 `Record<string, unknown>` tsc 會嫌
  // overlap 唔夠，要先落返 `unknown`（同 src/lib/roster-upload/layout.ts
  // `clean()` 一致做法：嗰邊個參數本身就係 `unknown`）。
  const v: unknown = row.getCell(col1based).value;
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v !== null) {
    if ("richText" in (v as Record<string, unknown>)) {
      const s = (v as { richText: Array<{ text?: string }> }).richText.map((t) => t.text ?? "").join("");
      const trimmed = s.trim();
      return trimmed === "" ? null : trimmed;
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ("result" in (v as Record<string, unknown>)) {
      const r = (v as { result: unknown }).result;
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      if (r === null || r === undefined) return null;
      const s = String(r).trim();
      return s === "" ? null : s;
    }
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

export async function loadUTeamList(filePath: string = U_TEAM_XLSX_PATH): Promise<UTeamRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0]!;
  const rows: UTeamRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const uNumberRaw = cellText(row, 14); // idx13
    const nameZh = cellText(row, 16); // idx15
    const displayName = cellText(row, 3); // idx2
    const telRaw = cellText(row, 10); // idx9
    const hkidRaw = cellText(row, 15); // idx14
    const hireDateRaw = cellText(row, 2); // idx1
    const employeeStatus = cellText(row, 5); // idx4
    if (!uNumberRaw && !nameZh && !displayName) continue; // 完全空行跳過
    rows.push({
      uNumber: uNumberRaw ? normalizeStaffNumber(uNumberRaw) : null,
      nameZh,
      displayName,
      tel: telRaw ? normalizeTel(telRaw) : null,
      hkid: hkidRaw ? hkidRaw.toUpperCase().replace(/\s+/g, "") : null,
      hireDate: hireDateRaw,
      employeeStatus,
    });
  }
  return rows;
}

export interface UTeamIndex {
  byUNumber: Map<string, UTeamRow>;
  /** 姓名（中文姓名／顯示名都試）→ 呢個名嘅全部候選（可能多過一個，
   * caller 要處理 ambiguous）。 */
  byName: Map<string, UTeamRow[]>;
}

export function buildUTeamIndex(rows: UTeamRow[]): UTeamIndex {
  const byUNumber = new Map<string, UTeamRow>();
  const byName = new Map<string, UTeamRow[]>();
  const addName = (name: string | null, row: UTeamRow) => {
    if (!name) return;
    const key = name.trim();
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(row);
  };
  for (const row of rows) {
    if (row.uNumber) byUNumber.set(row.uNumber, row);
    addName(row.nameZh, row);
    if (row.displayName && row.displayName !== row.nameZh) addName(row.displayName, row);
  }
  return { byUNumber, byName };
}

/** 核對表「主檔（每人一行）」一行——欄位 index（0-based，peek 過
 * header 核實）：系統id(0)／中文姓名(1)／U編號(5)／MP編號(6)／
 * 其他編號(9)／已取消嘅號(10)／英文名(11)／身份證(12)。 */
export interface CrossCheckRow {
  systemId: string | null; // = guards.id
  nameZh: string | null;
  uNumber: string | null;
  hkid: string | null;
}

export async function loadCrossCheckMainSheet(filePath: string = CROSS_CHECK_XLSX_PATH): Promise<CrossCheckRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("主檔（每人一行）");
  if (!ws) throw new Error(`核對表搵唔到 sheet「主檔（每人一行）」：${filePath}`);
  const rows: CrossCheckRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const systemId = cellText(row, 1); // idx0
    const nameZh = cellText(row, 2); // idx1
    const uNumberRaw = cellText(row, 6); // idx5
    const hkidRaw = cellText(row, 13); // idx12
    if (!systemId && !nameZh) continue;
    rows.push({
      systemId,
      nameZh,
      uNumber: uNumberRaw ? normalizeStaffNumber(uNumberRaw) : null,
      hkid: hkidRaw ? hkidRaw.toUpperCase().replace(/\s+/g, "") : null,
    });
  }
  return rows;
}

export interface CrossCheckIndex {
  byName: Map<string, CrossCheckRow[]>;
}

export function buildCrossCheckIndex(rows: CrossCheckRow[]): CrossCheckIndex {
  const byName = new Map<string, CrossCheckRow[]>();
  for (const row of rows) {
    if (!row.nameZh) continue;
    const key = row.nameZh.trim();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(row);
  }
  return { byName };
}
