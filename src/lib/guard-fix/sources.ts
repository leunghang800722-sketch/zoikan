// WP-GUARD-FIX：讀兩份人手維護嘅 Excel 名單——
//   1. U Team 名單（Wilson，`data/2026-09/msg-file/U Team - People
//      template 20260824.xlsx`，sheet1，1,395 行）——7 月之後入職嘅新
//      散工，一鍵結算 stepGuardFix（舊 build-guard-fix-plan.ts 已刪）用嚟起 `create` 個案。
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
import { canonicalHkid } from "@/lib/guards/identity";

export const U_TEAM_XLSX_PATH = "data/2026-09/msg-file/U Team - People template 20260824.xlsx";

/** U Team 名單一行——欄位 index（0-based，任務指示已經核實）：
 * 員工編號(13)／中文姓名(15)／姓名（顯示名）(2)／電話號碼(9)／
 * 身份證/護照號碼(14)／入職日期(1)／員工狀態(4)。 */
export interface UTeamRow {
  uNumber: string | null; // 正規化（大寫、去空白）
  nameZh: string | null;
  displayName: string | null;
  tel: string | null; // 正規化
  /** 驗收（Opus 5.5）：淨係「真係身份證格式」先有值（`A123456(7)` 格式，
   * 同 `HKID_RE`（src/lib/api/schemas.ts）一致）——名單呢欄實測有一批
   * 唔係身份證嘅值（「需填寫…號碼」placeholder 22 行、「在職,正式編號…」
   * 「用緊…,個名正確寫法…」呢類備註），之前會原文寫入 `guards.hkid`，
   * 仲會令幾個唔同人共用同一個「身份證」。 */
  hkid: string | null;
  /** 身份證欄唔係身份證格式嗰陣嘅分類（唔存原文，避免 PII 周圍散）：
   * `mentions_other_number`＝備註提到佢用緊另一個工號（可能 DB 已經有
   * 呢個人）→ build 一律 needs_boss；`invalid`＝其他唔啱格式（寫唔入，
   * 要 HR 補）。 */
  hkidNote: "invalid" | "mentions_other_number" | null;
  hireDate: string | null; // YYYY-MM-DD
  employeeStatus: string | null;
}

// WP-STAFF-IMPORT B1：canonicalHkid 搬到 src/lib/guards/identity.ts，呢度 re-export。
export { canonicalHkid };

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

/** U Team 名單 sheet1 逐行解析——同一份邏輯俾 script（讀本機檔案路徑）
 * 同 `POST /api/guard-fix/staff-list`（讀上載嘅 xlsx bytes）共用，唔准
 * 各自抄一份（WP-GUARD-FIX-UI 鐵則）。 */
function parseUTeamWorksheet(ws: ExcelJS.Worksheet): UTeamRow[] {
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
      hkid: canonicalHkid(hkidRaw), // WP-STAFF-IMPORT B1：入 DB 一律 canonical（A1234563）
      hkidNote: !hkidRaw || canonicalHkid(hkidRaw) ? null : /用緊|正式編號|威信編號/.test(hkidRaw) ? "mentions_other_number" : "invalid",
      hireDate: hireDateRaw,
      employeeStatus,
    });
  }
  return rows;
}

/** `POST /api/guard-fix/staff-list` 用——由上載嘅 xlsx bytes（記憶體）
 * 解析，唔存落磁碟。回傳 rows＋`row_count`（`staff_list_uploads.
 * row_count`／`parse_summary` 用，唔存逐行 PII）。 */
export async function parseUTeamWorkbookBuffer(buffer: Buffer | ArrayBuffer): Promise<UTeamRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("U Team 名單 xlsx 冇 sheet1");
  return parseUTeamWorksheet(ws);
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
