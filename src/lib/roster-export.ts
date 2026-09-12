// P1-WP3：更表 Excel 匯出——共用生成邏輯。
//
// 呢個檔案係「匯出 API」（src/app/api/sites/[id]/roster-export/route.ts）
// 同「對數 gate script」（scripts/report/roster-export-diff.ts）**共用**
// 嘅唯一 writer——兩邊 import 同一個 `buildRosterWorkbookForSite()`，
// 先保證「gate 過咗就即係真係出到嗰個檔」（唔會出現 API 同 gate 各自
// 一份邏輯、悄悄跑偏嘅情況）。
//
// 版面依據 tools/importer/importer/layout.py 頂註解（P0 已經逐格解釋
// 咗三種原始 Excel 版面，呢度唔重複 parser 嘅判斷邏輯——我哋係反過嚟
// 做 writer）：
//   - standard：姓名欄左邊 雞頭代號(-5) 時段(-4) 職級(-3) 工號(-2) 電話(-1)
//   - digital_port：多一欄英文名夾喺電話同姓名之間，
//                    雞頭代號(-6) 時段(-5) 職級(-4) 工號(-3) 電話(-2) 英文名(-1)
//   - citybus：電話同姓名之間冇英文名，改用 sub_site（"Property Name"），
//              雞頭代號(-6) 時段(-5) 職級(-4) sub_site(-3) 工號(-2) 電話(-1)
//
// P1-WP3 規劃裁定（2026-09-12 第二輪：「序列骨架」）：`sites.roster_
// layout.sections` 係一個由上而下嘅 section 列表（banner／header／
// guard_rows／blank／total_group／literal_row，見 `src/lib/
// roster-layout-template.ts`），`buildTemplatedRosterWorkbook()` 順序
// render，唔靠絕對 row number。模板由 `scripts/seed/lib/roster-
// layout.ts` seed 時逐行行過 `data/2026-07/*.xlsx` 原檔（配合
// wp1/rows.csv／wp2b/shift_records.csv／wp2b/shift_types.csv）runtime
// 反推，冇模板（新 site、未 seed）先跌返 `buildGenericRosterWorkbook()`
// （一個 shift_type 一個 block，冇橫額，見檔案下半部）。
//
// 現況（2026-09-12 第三輪，分階段規劃裁定後——「raw 字面優先」＋
// 「骨架逐行」兩個階段做完）：`roster-export-diff.ts --month 2026-07`
// **21/21 份 0-diff，exit 0**。做法：guard_rows／banner／header／
// total_group 逐行/逐格優先用 seed 時由 `data/2026-07/*.xlsx` 原檔逐行
// 讀出嘅 raw 字面（`provenance.raw_row`／`roster_layout` 嘅
// `rawRow(s)`，見 `scripts/seed/lib/roster-raw.ts`／
// `scripts/seed/lib/roster-layout.ts`），DB 推導淨係喺 raw 字面唔存在
// （新月份、或者呢一行成月零更冇對應 shift_record）先用返——即係話
// 「加一個分支，舊有 DB 推導路徑一格都冇改」。
//
// **`--derived` 模式（Gate 2，`buildRosterWorkbookForSite(..., {
// derivedOnly:true })`）**：逼成個 render 完全唔用 raw 字面，一律行
// DB 推導路徑，等 `roster-export-diff.ts --derived` 驗到「純推導」
// 本身（唔靠 raw 字面遮醜）啱唔啱——逐日格（更別/狀態代號）21 份入面
// 20 份 100%（實測揪到＋修咗一個真 bug：`shift_type.code` 撞 key 時
// seed 加嘅 `-2`／`-3` 尾綴會漏咗入逐日格，見 `displayShiftCode()`）；
// 結構格（banner/header/total_group 嘅計算式 fallback，例如
// `emitHeaderLabelsRow()` 冇寫到原檔喺 labelCol+DAYS 之後重用位置印
// 嘅裝飾欄、`total_group` 嘅 `workedByDayForRowRange`/
// `reqByDayForRowRange` 呢條 fallback 路徑之前一直冇被行過，Gate 1
// 一直用緊 raw_row，未驗過）仲未達 100%——詳細數字同分類見
// `out/p1/roster-export-diff-derived-summary.json`，誠實記錄呢個
// fallback 路徑嘅剩餘落差，留返下個 session 跟進（Gate 1 本身唔受
// 影響，因為 Gate 1 一直行緊 raw 字面路徑）。行首欄（雞頭代號／時段／
// 職級／工號／電話／姓名／英文名／Property Name）容許落差，已知原因
// 例如：`provenance.roster_broker_code` 冇值就跌返 settlement/
// operational broker；身份合併後 `staff_no` 為空。
import ExcelJS from "exceljs";
import { prisma } from "./db";
import { isRosterLayoutTemplate, type RosterLayoutTemplate, type BannerCell, type RawRow, type RawCellValue } from "./roster-layout-template";

function rawCellToExcelValue(v: RawCellValue): ExcelJS.CellValue {
  if (typeof v === "object") {
    // Defense-in-depth（見 scripts/seed/lib/roster-raw.ts 對應註解）：
    // ExcelJS `Value.getType()` 淨係睇 `value.formula || value.sharedFormula`
    // 係咪 truthy 嚟判斷係咪 formula cell，`formula:""` 係 falsy 會完全
    // 冇寫入（跌落 JSON type）。seed 捕捉果邊已經唔會產生呢種 wrapper，
    // 呢度淨係萬一（例如未來改咗 seed 邏輯）都唔會靜靜哋寫失敗。
    if (!v.formula) return v.result ?? null;
    return { formula: v.formula, result: v.result ?? undefined };
  }
  return v;
}

function extractRawRow(provenance: unknown): RawRow | undefined {
  if (!provenance || typeof provenance !== "object") return undefined;
  const raw = (provenance as Record<string, unknown>).raw_row;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as RawRow;
}

export type RosterLayout = "standard" | "digital_port" | "citybus";

export interface RosterExportSiteLike {
  canonicalName: string;
  aliases: string[];
}

/**
 * 判斷一個 DB site 對應邊種原始 Excel 版面。
 *
 * DB 嘅 Site model 冇獨立欄記呢個（P1-執行計劃.md 明文：唔准為咗呢個改
 * schema/migration，會拖累其他兩個平行進行嘅 agent）——改用簡單、確定性
 * 嘅判斷：canonicalName 或 aliases 含「數碼港」→digital_port；含「城巴」
 * →citybus；其他→standard。呢幾個字係盤/客戶嘅地區性描述名（P1-執行
 * 計劃.md 本身都成日提到「數碼港 CP1-4」「城巴 8 廠」），唔係安員/雞頭
 * 個人姓名，唔違反 PDPO。
 */
export function detectLayout(site: RosterExportSiteLike): RosterLayout {
  const names = [site.canonicalName, ...site.aliases];
  if (names.some((n) => n.includes("數碼港"))) return "digital_port";
  if (names.some((n) => n.includes("城巴"))) return "citybus";
  return "standard";
}

/** 誠實記錄一個已知嘅分類盲點（見 detectLayout 上面註解）：DB 入面
 * clientGroup="城巴車廠" 但 canonicalName/aliases 本身冇「城巴」字面嘅
 * site（例：創富廠IC，billing_model=admin_fee）會跌落 standard——目前
 * 呢類 site 2026-07 冇 shift_records，對呢個月嘅匯出冇實際影響；如果
 * 之後呢類 site 有咗更表資料，呢個判斷式要人手覆核。 */
export const KNOWN_LAYOUT_DETECTION_CAVEAT =
  "clientGroup=城巴車廠 但 canonicalName/aliases 冇「城巴」字面嘅 site（例：創富廠IC）會判做 standard 唔係 citybus——目前呢類 site 冇 shift_records，冇實際影響。";

const LABEL_COL: Record<RosterLayout, number> = { standard: 6, digital_port: 7, citybus: 7 };

// 欄位 header 行（col1..labelCol），跟 detectLayout 上面列嘅 offset 次序。
const HEADER_ROW_LABELS: Record<RosterLayout, readonly string[]> = {
  standard: ["", "Time", "Rank", "Staff No.", "Tel", "Name"],
  digital_port: ["", "Time", "Rank", "Staff No.", "Tel", "", "Name"],
  citybus: ["", "Time", "Rank", "Property Name", "Staff No.", "Phone No.", "Name"],
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function fmtTime(d: Date | null): string {
  if (!d) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function timeSlotLabel(startTime: Date | null, endTime: Date | null): string {
  if (!startTime || !endTime) return "";
  return `${fmtTime(startTime)}-${fmtTime(endTime)}`;
}

/**
 * shift_type.label 由 seed 存做 `${原始rank文字}（${代號描述}）`（見
 * scripts/seed/index.ts seedShiftTypes()／tools/importer/out/.../
 * shift_types.csv 嘅 rank + label 兩欄，例如 rank="早Zone IC"、
 * label="早Zone IC（Zone IC / 早更IC 一般代號）"），呢度攞「（」之前
 * 嗰部分，反推返原檔「Rank」/職級 欄嘅原始文字。
 */
export function rankFromShiftTypeLabel(label: string | null): string {
  if (!label) return "";
  const idx = label.indexOf("（");
  return idx >= 0 ? label.slice(0, idx) : label;
}

function dayOfMonth(d: Date): number {
  return d.getUTCDate();
}

/** Gate 2（`--derived`）實測揪到嘅真 bug：`scripts/seed/index.ts`
 * `seedShiftTypes()` 為咗滿足 DB `(site_id,code,start_time)` unique
 * 約束，撞 key 嗰陣會幫 `shift_type.code` 加 `-2`／`-3`……呢類尾綴
 * （純粹 DB 去重人工物，唔係原檔真係印住嘅字面——實測：數碼港 CP5
 * 撞到「D」畀人加咗做「D-2」，逐日格由「D」變咗「D-2」）。逐日格
 * render 用嘅係「畀人睇嘅代號」，一定要剝走呢個純 DB 內部尾綴先
 * 得（`total_group`/`guard_rows` 分組嗰邊淨係用 DB id 揀 scope，唔會
 * 撞到呢個問題，唔使改）。 */
function displayShiftCode(code: string): string {
  return code.replace(/-\d+$/, "");
}

/** 原檔電話一律「4位 空格 4位」（例："6055 6026"），DB `guards.tel`
 * 存嘅係去咗空格嘅純數字——匯出時補返個空格先夾得返原檔（見
 * roster-export-diff.ts gate 實測，呢個格式差異之前計咗做值差異）。
 * 唔係 8 位數字（例如冇電話、或者格式特殊）就原樣輸出。 */
function formatTel(tel: string | null): string {
  if (!tel) return "";
  const digits = tel.replace(/\s/g, "");
  if (/^\d{8}$/.test(digits)) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return tel;
}

export interface BuildRosterOptions {
  /** 雞頭隔離：淨係包 settlement 或 operational broker = 呢個 id 嘅記錄
   * （同 broker-isolation.ts 嘅 scopeShiftRecordWhere 同一條 OR 邏輯，
   * 呢度獨立重寫一份係因為呢個共用函數要俾冇 session 概念嘅 gate
   * script 都用得——唔跟 session 走）。 */
  brokerId?: string | null;
  /** P1-WP3 Gate 2（`--derived` 模式，規劃裁定 2026-09-12 階段 3）：忽略
   * `provenance.raw_row`／`roster_layout` 嘅 `rawRow(s)`，一律行返純
   * DB 推導路徑（同冇 seed 過 raw 字面嘅新月份一致）——等
   * `roster-export-diff.ts --derived` 可以驗到「純推導」本身啱唔啱，
   * 唔靠 raw 字面遮醜。 */
  derivedOnly?: boolean;
}

export interface RosterExportResult {
  workbook: ExcelJS.Workbook;
  layout: RosterLayout;
  siteName: string;
  /** 呢個 site 呢個月有冇任何 shift_type 出到 block（全部冇資料就係空 workbook）。 */
  blockCount: number;
  /** Opus 對抗式驗收 A1（應修）：`--derived` 模式下面（`opts.derivedOnly`）
   * 有幾多格係*仍然*要靠 `section.rawRows` raw 字面 fallback 先寫得到
   * （唔係純 DB 推導）——分兩類：`external`＝呢一行對應嘅 guard 喺
   * `allRecords`（冇 isExternal/payroll_only 濾走）其實有記錄，淨係
   * 業務規則唔喺更表視圖顯示；`zeroShift`＝成個月都完全冇任何
   * shift_record（連 external 都冇）。俾 `roster-export-diff.ts
   * --derived` 出返「真實純推導覆蓋率」。
   *
   * Opus 對抗式驗收第二輪 R2：加第三類 `allCancelled`——呢一行*曾經*
   * 有 shift_record（唔係 zeroShift 嗰種「乜都冇」），但全部畀人 void
   * 晒（見 R1／`guardsByRowRange` 嘅 `allCancelled` flag）。呢類行雖然
   * 而家係純 DB 推導（零逐日格、行首欄由 guard 推導，冇用 `section.
   * rawRows`），但同「原檔嗰個月」嘅字面已經唔一致（原檔仲印住 void
   * 之前嘅內容）——刻意計落 `raw_fallback_rows`／覆蓋率個分母，等
   * gate 報表明確反映「呢個月嘅匯出已經同原檔有出入（因為之後有人
   * void 咗嘢），唔係靜靜哋當冇事」。冇用到就係 `{external:0,
   * zeroShift:0,allCancelled:0}`。 */
  rawFallbackCells?: { external: number; zeroShift: number; allCancelled: number };
}

// 跟 scripts/report/roster.ts 一致嘅 sheet 命名（唔跟住個 month 變）。
const SHEET_NAME = "2026";

function provenanceRowNumber(r: { provenance: unknown }): number | null {
  const p = (r.provenance ?? {}) as Record<string, unknown>;
  const cell = typeof p.cell === "string" ? p.cell : null;
  if (!cell) return null;
  const m = cell.match(/^[A-Za-z]+(\d+)$/);
  return m ? Number(m[1]) : null;
}

function setRowValues(ws: ExcelJS.Worksheet, row: number, startCol: number, values: Array<string | number | Date>): void {
  values.forEach((v, i) => {
    if (v === "" || v === null || v === undefined) return;
    ws.getCell(row, startCol + i).value = v;
  });
}

function writeBannerCells(ws: ExcelJS.Worksheet, row: number, labelCol: number, cells: BannerCell[]): void {
  for (const c of cells) {
    const col = labelCol + c.colOffset;
    if (col < 1) continue;
    ws.getCell(row, col).value = c.value;
  }
}

function emitBlankRow(ws: ExcelJS.Worksheet): void {
  ws.addRow([]);
}

function emitLiteralRow(ws: ExcelJS.Worksheet, labelCol: number, cells: BannerCell[]): void {
  const rowNum = ws.rowCount + 1;
  ws.addRow([]);
  writeBannerCells(ws, rowNum, labelCol, cells);
}

/** Gate 1 階段 1／2（純加法）：逐格寫返 `RawRow`（col number→值）落一個
 * 已經開好嘅 row——`guard_rows`／`banner`／`header`／`total_group`／
 * `literal_row` 全部共用。 */
function writeRawRowCells(ws: ExcelJS.Worksheet, rowNum: number, rawRow: RawRow): void {
  for (const [colStr, v] of Object.entries(rawRow)) {
    const col = Number(colStr);
    if (!Number.isFinite(col) || col < 1) continue;
    ws.getCell(rowNum, col).value = rawCellToExcelValue(v);
  }
}

/** 開一新行並逐格照抄 `rawRow`。 */
function emitRawRow(ws: ExcelJS.Worksheet, rawRow: RawRow): void {
  const rowNum = ws.rowCount + 1;
  ws.addRow([]);
  writeRawRowCells(ws, rowNum, rawRow);
}

function emitDateRow(ws: ExcelJS.Worksheet, labelCol: number, days: number, month: Date): void {
  const rowNum = ws.rowCount + 1;
  ws.addRow([]);
  ws.getCell(rowNum, labelCol).value = "Date";
  for (let i = 0; i < days; i++) ws.getCell(rowNum, labelCol + 1 + i).value = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1));
}

function emitHeaderLabelsRow(ws: ExcelJS.Worksheet, labelCol: number, labels: string[], days: number, month: Date, trailingSummaryCodes?: string[]): void {
  const rowNum = ws.rowCount + 1;
  ws.addRow([]);
  for (let i = 0; i < Math.min(labelCol, labels.length); i++) {
    if (labels[i]) ws.getCell(rowNum, i + 1).value = labels[i]!;
  }
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1));
    ws.getCell(rowNum, labelCol + 1 + i).value = WEEKDAY[d.getUTCDay()];
  }
  // Gate 2（`--derived`）：主總計欄（labelCol+days+1）之後，原檔有啲檔
  // 重用位置多印幾欄「按請假代號分類嘅小計」legend（見
  // scripts/seed/lib/roster-layout.ts `trailingSummaryLabelsAt()`）——
  // 呢啲文字本身係 LeaveCode enum 值（結構性關鍵字，唔係 PII），derived
  // fallback 都寫得返。
  if (trailingSummaryCodes) {
    for (let i = 0; i < trailingSummaryCodes.length; i++) {
      ws.getCell(rowNum, labelCol + days + 2 + i).value = trailingSummaryCodes[i]!;
    }
  }
}

/**
 * P1-WP3 規劃裁定（2026-09-12 第二輪）：「序列骨架」——`site.rosterLayout.
 * sections` 係一個由上而下嘅 section 列表，呢個函數順序逐個 render，
 * 唔靠絕對 row number（上一版嘅做法喺複合 block 度會錯位，見
 * `src/lib/roster-layout-template.ts` 頂註解）。冇模板（新 site、未
 * seed）跌返 `buildGenericRosterWorkbook()`。
 */
async function buildTemplatedRosterWorkbook(
  site: { id: string; canonicalName: string },
  template: RosterLayoutTemplate,
  month: Date,
  opts: BuildRosterOptions,
): Promise<RosterExportResult> {
  const layout = template.layout;
  const labelCol = LABEL_COL[layout];
  const monthStartUtc = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const DAYS = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const monthEndUtc = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), DAYS));

  // 規劃裁定（第二輪修正）：`section.shiftTypeCodes` 陣列實際存嘅係 DB
  // shift_type.id（唔係 code 字面）——見 scripts/seed/lib/roster-layout.ts
  // 頂註解：`(site_id, code, start_time)` 先係 unique，同一個 site 入面
  // 兩個唔同 shift_type 可以有一樣嘅 code（例：啟航1331 早/夜兩個
  // Zone IC 都叫 "IC"），用 code 字串揀 section 會撈埋唔啱嘅安員（呢個
  // 陣列本身留低做冇 provenance 嘅 fallback membership，見
  // `guardsForCodes()`）。

  const allRecords = await prisma.shiftRecord.findMany({
    where: {
      siteId: site.id,
      workDate: { gte: monthStartUtc, lte: monthEndUtc },
      isExternal: false,
      // Opus 對抗式驗收 B2 揪到嘅真 bug：`source: { not: "payroll_only" }`
      // 喺 Prisma/Postgres 底下對 `source IS NULL` 嘅記錄一律唔算匹配
      // （NULL 三值邏輯，`column <> value` 對 NULL 永遠唔係 TRUE）——但
      // 除咗 seed 入嚟嘅 7 月記錄，UI／API（`shift-records`／
      // `shift-records/batch`）建嘅記錄根本冇設 `source`（一律 NULL），
      // 實測：呢個 query 令*任何* UI 新建嘅記錄（新月份最明顯）完全消
      // 失喺更表匯出——`guardsForCodes()`/`guardsByRowRange()` 收到嘅
      // `allRecords` 永遠得返 7 月 seed 入嚟嗰批，新月份自然「零安員
      // 行」。改用 `OR:[{source:null},{source:{not:"payroll_only"}}]`
      // 先至令 NULL 同「唔係 payroll_only」都算通過。
      OR: [{ source: null }, { source: { not: "payroll_only" } }],
      ...(opts.brokerId ? { AND: [{ OR: [{ settlementBrokerId: opts.brokerId }, { operationalBrokerId: opts.brokerId }] }] } : {}),
    },
    include: { guard: { include: { defaultBroker: true } }, settlementBroker: true, operationalBroker: true, shiftType: true },
    orderBy: [{ workDate: "asc" }],
  });

  // Opus 對抗式驗收 A1（應修）：淨係俾 rawRows fallback 分類用——冇
  // isExternal/source 呢兩個「更表視圖」濾走條件嘅版本，等下面判斷一個
  // 用咗 raw fallback 嘅 row 究竟係「external（DB 有記錄淨係業務規則
  // 唔顯示）」定「zeroShift（真係乜記錄都冇）」。淨係喺 rawRows 有嘢
  // 用嗰陣先計（見 rawFallbackCells 相關邏輯），平時（大部分 site×月）
  // 呢條 query 嘅結果都用唔著，但勝在簡單、唔使逐 row 開 query。
  const rowsWithAnyRecordPromise = prisma.shiftRecord
    .findMany({
      where: { siteId: site.id, workDate: { gte: monthStartUtc, lte: monthEndUtc } },
      select: { provenance: true },
    })
    .then((rows) => {
      const set = new Set<number>();
      for (const r of rows) {
        const rn = provenanceRowNumber(r);
        if (rn !== null) set.add(rn);
      }
      return set;
    });
  const rawFallbackCells = { external: 0, zeroShift: 0, allCancelled: 0 };

  // Gate 1 階段 1（純加法）：`section.rawRows`（見 scripts/seed/lib/
  // roster-layout.ts）淨係喺 seed 嗰陣由 2026-07 原檔captured，唔係跟
  // 住匯出月份變——一定要確認「而家匯出緊嘅的確係原檔嗰個月」先可以用
  // （唔係就會將 7 月嘅 raw 字面錯誤咁貼落 8 月新開嘅（本身應該係空白
  // 等緊填）安員行）。用「呢個 site 呢個月有冇*任何*一條 shift_record
  // 帶住 provenance.cell」做判斷——原檔 seed 入嚟嘅記錄先會有，UI 手動
  // 開嘅新月份記錄唔會有（唔靠寫死月份數字）。
  // Gate 2（`--derived`）：`opts.derivedOnly` 一律當「冇 raw 可用」，
  // 逼成個 render 行返純 DB 推導路徑（同下面 `g.rawRow` 檢查一齊用）。
  const isSourceMonth = allRecords.some((r) => provenanceRowNumber(r) !== null);
  // Opus 對抗式驗收 B1（必修）：`opts.brokerId` 存在即係雞頭版匯出——
  // `section.rawRows`／`g.rawRow`／`section.rawRow`／total_group 嘅
  // `row.rawRow` 全部係「成行／成格原始字面」，唔理邊個 broker，一律
  // 停用（唔淨係 banner/header/total_group，guard_rows 嘅逐行 raw
  // fallback 一樣停用——見下面 `byRow || (isSourceMonth && !opts.
  // brokerId)`／`rawOnly` 兩處）。雞頭版安員行只可以由已經用
  // `settlementBrokerId`/`operationalBrokerId` scope 過嘅
  // `allRecords` 砌，其他 broker 嘅安員行一律留空。
  const hasAnyProvenanceRows = !opts.derivedOnly && !opts.brokerId && isSourceMonth;

  type RowAgg = {
    staffNo: string;
    tel: string;
    nameZh: string;
    nameEn: string;
    brokerCode: string;
    propertyName: string;
    rank: string;
    timeSlot: string;
    minRow: number;
    days: Map<number, string>;
    /** Gate 1 階段 1（純加法）：呢一行嘅 raw 字面（col→值；formula 格
     * `{formula,result}`），由 `scripts/seed/lib/roster-raw.ts` seed 時
     * 由原檔逐行讀出寫入 `provenance.raw_row`——同一行嘅所有
     * shift_records 存同一份，攞第一條搵到嘅就得。有呢個就 render 成行
     * 照抄（見 writeGuardRow），冇（新月份／呢行成月冇任何 shift_record）
     * 就照舊由 DB 推導，呢個分支唔會改到舊路徑。 */
    rawRow?: RawRow;
    /** Gate 2 規劃裁定修正（2026-09-12）：呢一行邊幾日係
     * `record_type='shift'`（正更，唔包括 `ot`/`leave`）——trailing
     * total 主計欄用嚟計數（見 writeGuardRow）。實測發現原檔嘅
     * COUNTIF 公式（例如 HKU座頭C更）淨係數緊呢一段 guard_rows
     * section 嘅「主更代號」，唔係逐格見到嘅任何代號都計；一行入面
     * 交錯埋 OT（`record_type='ot'`，例如 "OT1"）嘅日子唔應該計落
     * 主計欄——舊有 `sectionOwnCodes`（成個 section 嘅 code 集合，
     * 包括 OT 嘅 code）會錯誤咁將 OT-only 嘅行都計到落主計欄。 */
    shiftDays: Set<number>;
    /** Opus 對抗式驗收第二輪 R1：呢一行（provenance row number）*曾經*
     * 有 shift_record 落過（唔係新月份「一格都未填過」），但*全部*已經
     * `status=cancelled`——即係「成行畀人 void 晒」，唔係「呢一行本身
     * 冇資料」。`guardsByRowRange()` 遇到呢種情況要照舊喺 `byRow` set
     * 一個 entry（day/shiftDays 留空＝逐日格零，行首欄由呢條 cancelled
     * 記錄嘅 `guard`／`provenance` 推導），令 render loop 唔會跌落
     * `section.rawRows`（會印返 void 之前嘅原檔字面，PDPO／資料準確
     * 都唔啱）。呢個 flag 俾 render loop 計 `rawFallbackCells.
     * allCancelled`（R2）用。 */
    allCancelled?: boolean;
  };
  const dayWorkedByShiftType = new Map<string, number[]>();
  for (const r of allRecords) {
    // Opus 對抗式驗收 B3：cancelled 唔計「worked」。
    if (r.recordType !== "shift" || r.status === "cancelled") continue;
    const day = dayOfMonth(r.workDate);
    if (!dayWorkedByShiftType.has(r.shiftTypeId)) dayWorkedByShiftType.set(r.shiftTypeId, new Array(DAYS).fill(0));
    dayWorkedByShiftType.get(r.shiftTypeId)![day - 1]++;
  }

  /**
   * 規劃裁定（第二輪，實測反推）：一個 guard_rows section 嘅
   * `shiftTypeCodes` 可能蓋住多過一個 code（HKU座頭C更嗰種主更/OT短更
   * 逐行交錯嘅檔），要將同一個 guard 喺**呢個 section 自己嘅 code 範圍
   * 之內**嘅記錄合埋（唔係一個 guard 成個 site×月嘅記錄全部合埋——
   * 唔同 block／唔同 Date header 嘅記錄唔可以扯埋同一行，見下面
   * `codes` 傳入時淨係傳嗰個 section 自己嘅 shiftTypeCodes）。 */
  function guardsForCodes(shiftTypeIds: string[]): RowAgg[] {
    const idSet = new Set(shiftTypeIds);
    const map = new Map<string, RowAgg>();
    // Opus 對抗式驗收 B2 規劃裁定：行次序（冇 provenance 嘅新月份）＝
    // shift_type 骨架順序（`shiftTypeIds` 本身嘅次序，嚟自
    // `section.shiftTypeCodes`）→雞頭代號→姓名——唔係跟住呢個 guard
    // 邊個 shiftTypeId 出現得早，攞佢喺 `shiftTypeIds` 入面嘅 index
    // 做主排序鍵。
    const shiftTypeOrder = new Map<string, number>(); // guardId -> min index within shiftTypeIds
    for (const r of allRecords) {
      if (!idSet.has(r.shiftTypeId)) continue;
      // Opus 對抗式驗收 B3：cancelled 當冇記錄過，唔起呢一行、唔計呢一日。
      if (r.status === "cancelled") continue;
      const orderIdx = shiftTypeIds.indexOf(r.shiftTypeId);
      if (!shiftTypeOrder.has(r.guardId) || orderIdx < shiftTypeOrder.get(r.guardId)!) shiftTypeOrder.set(r.guardId, orderIdx);
      const day = dayOfMonth(r.workDate);
      const cellCode = r.recordType === "shift" || r.recordType === "ot" ? displayShiftCode(r.shiftType.code) : (r.leaveCode ?? "?");
      const rowNum = provenanceRowNumber(r);
      if (!map.has(r.guardId)) {
        const provenance = (r.provenance ?? {}) as Record<string, unknown>;
        const str = (k: string): string | null => (typeof provenance[k] === "string" && provenance[k] ? (provenance[k] as string) : null);
        // 規劃裁定（第二輪 point 3）：雞頭代號欄用原檔 col A 值——
        // provenance.roster_broker_code（P0 wp2b `roster_broker_code`，
        // 最貼近原檔逐格）。實測發現（殷樺花園）：呢個欄有時 P0 記低
        // 咗個原檔 cell 真係空白（roster_broker_code=null，但
        // settlementBroker 已經由糧單/總表反推出嚟）——呢種情況一定要
        // 跟返「原檔 col A 值」render 做空白，唔可以跌返 settlement
        // broker。淨係喺**完全冇 provenance**（UI 新增、未經 P0 import
        // 嘅記錄，冇 `cell`）先至用 settlement/operational/default
        // broker 做 fallback。
        const hasProvenance = typeof provenance.cell === "string" && !!provenance.cell;
        const brokerCode = hasProvenance
          ? (str("roster_broker_code") ?? "")
          : (str("roster_broker_code") ?? str("master_broker_code") ?? r.settlementBroker?.code ?? r.operationalBroker?.code ?? r.guard.defaultBroker?.code ?? "");
        const subSite = str("sub_site");
        map.set(r.guardId, {
          staffNo: r.guard.staffNo ?? "",
          tel: formatTel(r.guard.tel),
          nameZh: r.guard.nameZh,
          nameEn: r.guard.nameEn ?? "",
          brokerCode,
          propertyName: subSite ?? site.canonicalName,
          rank: rankFromShiftTypeLabel(r.shiftType.label),
          timeSlot: timeSlotLabel(r.shiftType.startTime, r.shiftType.endTime),
          minRow: rowNum ?? Number.MAX_SAFE_INTEGER,
          days: new Map(),
          shiftDays: new Set(),
        });
      }
      const agg = map.get(r.guardId)!;
      agg.days.set(day, cellCode);
      if (r.recordType === "shift") agg.shiftDays.add(day);
      if (rowNum !== null && rowNum < agg.minRow) agg.minRow = rowNum;
    }
    // B2 規劃裁定：有 provenance（source month 嘅殘留 fallback 情況）
    // 就照舊跟 minRow 優先——唔改 Gate 1 已經 21/21 嘅路徑；完全冇
    // provenance（新月份，全部 minRow 都係 MAX_SAFE_INTEGER）先用
    // 「shift_type 骨架順序→雞頭代號→姓名」。
    return [...map.entries()]
      .sort(([gidA, a], [gidB, b]) => {
        if (a.minRow !== b.minRow) return a.minRow - b.minRow;
        const orderA = shiftTypeOrder.get(gidA) ?? Number.MAX_SAFE_INTEGER;
        const orderB = shiftTypeOrder.get(gidB) ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB || a.brokerCode.localeCompare(b.brokerCode) || a.nameZh.localeCompare(b.nameZh);
      })
      .map(([, a]) => a);
  }

  /**
   * P1-WP3 第三輪規劃裁定（2026-09-12）：**唔准用啟發式分辨交錯行**——
   * 直接用 `provenance.cell` 嘅 row number 喺 [rowFrom,rowTo] 範圍之內
   * 嘅記錄，**照 row 次序**逐行出（一行=一個 row number，唔理跨咗幾多
   * 個唔同 shift_type）。搵唔到任何一行有 provenance（新月份，例如 UI
   * 開 8 月）就返 null，等 caller 用 `guardsForCodes()`（shiftTypeCodes
   * fallback＋shift_type 順序→雞頭代號→姓名排序）代替。
   */
  function guardsByRowRange(rowFrom: number, rowTo: number): Map<number, RowAgg> | null {
    const byRow = new Map<number, RowAgg>();
    // Opus 對抗式驗收 B3：raw_row 係「成行」捕捉（唔知邊個 record
    // cancelled），逐行記低邊幾日被 cancel 咗，等下面剝走 raw_row 入面
    // 對應嘅 column（唔可以成行一齊唔用 raw_row，會累街坊將呢一行其餘
    // 冇 cancel 嘅日子都變成計算式 fallback）。
    const cancelledDaysByRow = new Map<number, Set<number>>();

    // Opus 對抗式驗收第二輪 R1：預先掃一次呢個範圍，搵出邊啲 row
    // number「成行冇任何 active（未 cancel）記錄」——即係話呢一行*曾經*
    // 有記錄（唔係新月份嗰種「乜都未填過」），但全部畀人 void 晒。呢類
    // row 下面唔可以留喺 `byRow` 度冇 entry（會令 render loop 跌落
    // `section.rawRows`，印返 void 之前嘅原檔字面——呢個正正係 R1 要
    // 擋嘅 bug），要照舊喺 `byRow` set 一個「零逐日格」嘅 entry。
    const rowsInRange = new Set<number>();
    const activeRowsInRange = new Set<number>();
    for (const r of allRecords) {
      const rowNum = provenanceRowNumber(r);
      if (rowNum === null || rowNum < rowFrom || rowNum > rowTo) continue;
      rowsInRange.add(rowNum);
      if (r.status !== "cancelled") activeRowsInRange.add(rowNum);
    }
    const allCancelledRows = new Set([...rowsInRange].filter((rn) => !activeRowsInRange.has(rn)));

    for (const r of allRecords) {
      const rowNum = provenanceRowNumber(r);
      if (rowNum === null || rowNum < rowFrom || rowNum > rowTo) continue;
      const day = dayOfMonth(r.workDate);
      if (r.status === "cancelled") {
        if (!cancelledDaysByRow.has(rowNum)) cancelledDaysByRow.set(rowNum, new Set());
        cancelledDaysByRow.get(rowNum)!.add(day);
        // R1：呢一行成行冇任何 active 記錄——用呢條 cancelled 記錄嘅
        // guard/provenance 起一個「識別行」（staff_no/tel/name/雞頭
        // 代號由呢個 guard 推導），但**唔設 `rawRow`**、`days`／
        // `shiftDays` 留空（=零逐日格）。呢個判斷淨係睇「成行係咪冇
        // 任何 active 記錄」，唔理呢條 record 本身處理次序——mixed row
        // （有啲 active 有啲 cancelled）唔會入呢個分支（`allCancelledRows`
        // 唔會含呢個 rowNum），照舊行返落面嗰個 active 分支起
        // `rawRow`，B3 個剝 cancelled column 邏輯不變。
        if (allCancelledRows.has(rowNum) && !byRow.has(rowNum)) {
          const provenance = (r.provenance ?? {}) as Record<string, unknown>;
          const str = (k: string): string | null => (typeof provenance[k] === "string" && provenance[k] ? (provenance[k] as string) : null);
          const brokerCode = str("roster_broker_code") ?? "";
          const subSite = str("sub_site");
          byRow.set(rowNum, {
            staffNo: r.guard.staffNo ?? "",
            tel: formatTel(r.guard.tel),
            nameZh: r.guard.nameZh,
            nameEn: r.guard.nameEn ?? "",
            brokerCode,
            propertyName: subSite ?? site.canonicalName,
            rank: rankFromShiftTypeLabel(r.shiftType.label),
            timeSlot: timeSlotLabel(r.shiftType.startTime, r.shiftType.endTime),
            minRow: rowNum,
            days: new Map(),
            shiftDays: new Set(),
            allCancelled: true,
          });
        }
        continue; // cancelled 唔起（一般）身份、唔記日子（下面 identity 由其餘未 cancel 嘅 record 起）
      }
      const cellCode = r.recordType === "shift" || r.recordType === "ot" ? displayShiftCode(r.shiftType.code) : (r.leaveCode ?? "?");
      if (!byRow.has(rowNum)) {
        const provenance = (r.provenance ?? {}) as Record<string, unknown>;
        const str = (k: string): string | null => (typeof provenance[k] === "string" && provenance[k] ? (provenance[k] as string) : null);
        const brokerCode = str("roster_broker_code") ?? "";
        const subSite = str("sub_site");
        byRow.set(rowNum, {
          staffNo: r.guard.staffNo ?? "",
          tel: formatTel(r.guard.tel),
          nameZh: r.guard.nameZh,
          nameEn: r.guard.nameEn ?? "",
          brokerCode,
          propertyName: subSite ?? site.canonicalName,
          rank: rankFromShiftTypeLabel(r.shiftType.label),
          timeSlot: timeSlotLabel(r.shiftType.startTime, r.shiftType.endTime),
          minRow: rowNum,
          rawRow: extractRawRow(r.provenance),
          days: new Map(),
          shiftDays: new Set(),
        });
      }
      const agg = byRow.get(rowNum)!;
      agg.days.set(day, cellCode);
      if (r.recordType === "shift") agg.shiftDays.add(day);
    }
    // Opus 對抗式驗收 B3：呢一行有 raw_row 又有 cancelled 咗嘅日子——
    // 逐個剝走 raw_row 入面對應嗰幾個 column（絕對 col number =
    // labelCol + day），令 writeGuardRow() 嘅 raw 分支自然照抄剩低嗰啲
    // （已剝走嘅唔會喺 Object.entries 出現，格留空）。
    for (const [rowNum, cancelledDays] of cancelledDaysByRow) {
      const agg = byRow.get(rowNum);
      if (!agg || !agg.rawRow) continue;
      const filtered: RawRow = { ...agg.rawRow };
      for (const day of cancelledDays) delete filtered[String(labelCol + day)];
      agg.rawRow = filtered;
    }
    if (byRow.size === 0) return null; // 冇任何 provenance 落喺呢個範圍——新月份，用 fallback
    return byRow;
  }

  /** row-range 版本嘅 worked/required 計法——直接用 provenance row 落喺
   * 範圍之內嘅記錄（唔靠 shiftTypeId 分組），對 total_group 嘅
   * scope 判斷更準（唔使 fuzzy-match rank 文字估邊個 sub-run）。搵唔到
   * 就 fallback 去 `workedByDayForCodes`/`reqByDayForCodes`。 */
  function workedByDayForRowRange(rowFrom: number, rowTo: number): number[] | null {
    const out = new Array(DAYS).fill(0);
    let found = false;
    for (const r of allRecords) {
      if (r.recordType !== "shift") continue;
      const rowNum = provenanceRowNumber(r);
      if (rowNum === null || rowNum < rowFrom || rowNum > rowTo) continue;
      found = true;
      // Opus 對抗式驗收 B3：cancelled 唔計「worked」（`found` 淨係想知
      // 呢個 row range 係咪原檔 scope，同計唔計數係兩件事）。
      if (r.status === "cancelled") continue;
      out[dayOfMonth(r.workDate) - 1]++;
    }
    return found ? out : null;
  }

  async function reqByDayForRowRange(rowFrom: number, rowTo: number): Promise<number[] | null> {
    const stIds = new Set<string>();
    for (const r of allRecords) {
      const rowNum = provenanceRowNumber(r);
      if (rowNum === null || rowNum < rowFrom || rowNum > rowTo) continue;
      stIds.add(r.shiftTypeId);
    }
    if (stIds.size === 0) return null;
    return reqByDayForCodes([...stIds]);
  }

  function workedByDayForCodes(shiftTypeIds: string[]): number[] {
    const out = new Array(DAYS).fill(0);
    for (const id of shiftTypeIds) {
      const arr = dayWorkedByShiftType.get(id);
      if (!arr) continue;
      for (let i = 0; i < DAYS; i++) out[i] += arr[i];
    }
    return out;
  }

  async function reqByDayForCodes(shiftTypeIds: string[]): Promise<number[]> {
    const stIds = shiftTypeIds;
    const out = new Array(DAYS).fill(0);
    if (stIds.length === 0) return out;
    const daily = await prisma.dailyRequirement.groupBy({
      by: ["workDate"],
      where: { siteId: site.id, shiftTypeId: { in: stIds }, workDate: { gte: monthStartUtc, lte: monthEndUtc } },
      _sum: { headcountRequired: true },
    });
    for (const d of daily) out[dayOfMonth(d.workDate) - 1] += d._sum.headcountRequired ?? 0;
    return out;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  let blockCount = 0;
  const rowsWithAnyRecord = await rowsWithAnyRecordPromise;

  for (const section of template.sections) {
    switch (section.kind) {
      case "banner":
        // Gate 1 階段 2（純加法）：呢一行有 rawRow 就逐格照抄成行（連
        // `cells` 冧唔到嘅額外欄都照抄），冇（新月份）先跌返 `cells`
        // 相對 offset 寫法（舊路徑完全冇改）。
        if (hasAnyProvenanceRows && section.rawRow) {
          emitRawRow(ws, section.rawRow);
        } else {
          emitLiteralRow(ws, labelCol, section.cells);
        }
        break;
      case "header":
        // Gate 1 階段 2（純加法）：header 兩行（Date／欄位 label+星期幾）
        // 有 rawRow 就逐格照抄（連原檔喺 labelCol+DAYS 之後重用位置寫
        // 嘅額外裝飾欄——例如逐個請假代號嘅小計欄 header——都照抄）。
        // `hasAnyProvenanceRows` 即係「而家匯出緊嘅正正係模板捕捉嗰個
        // 月」——呢種情況下 seed 一定試過掃呢兩行，`dateRowRaw`／
        // `labelRowRaw` 冇（undefined）唔係「未捕捉」，而係「原檔嗰行
        // 本身真係全空」（實測：屯門凱和山第二個 block 冇重複印星期幾
        // 行）——一定要跟住寫空行，唔可以跌落舊有*計算式* fallback（嗰個
        // 唔理原檔實際有冇嘢，逢有 header section 都照計星期幾出嚟）。
        // 冇 provenance（新月份）先真係用返 `emitDateRow`／
        // `emitHeaderLabelsRow`（一格都冇改）。
        if (hasAnyProvenanceRows) {
          if (section.dateRowRaw) emitRawRow(ws, section.dateRowRaw);
          else emitBlankRow(ws);
          if (section.labelRowRaw) emitRawRow(ws, section.labelRowRaw);
          else emitBlankRow(ws);
        } else {
          emitDateRow(ws, labelCol, DAYS, month);
          emitHeaderLabelsRow(ws, labelCol, section.labels, DAYS, month, section.trailingSummaryCodes);
        }
        break;
      case "guard_rows": {
        // Gate 2 規劃裁定修正：呢一行（原檔 row number）自己係咪真係有
        // 主總計欄——優先用逐行捕捉嘅 `trailingTotalRows`（seed 時逐行
        // check，見 scripts/seed/lib/roster-layout.ts），冇（舊模板未
        // 重新 seed）先跌返成個 section 嘅 `hasTrailingTotal`。
        const rowHasTrailingTotal = (originalRow: number | undefined): boolean => {
          if (section.trailingTotalRows) return originalRow !== undefined && section.trailingTotalRows.includes(String(originalRow));
          return !!section.hasTrailingTotal;
        };
        const writeGuardRow = (g: RowAgg | undefined, originalRow?: number) => {
          const rowNum = ws.rowCount + 1;
          ws.addRow([]);
          if (!g) {
            // Gate 2 規劃裁定修正：呢一行冇任何 shift_record（成個 7 月
            // 零更），但原檔呢一行本身有自己嘅主總計欄（COUNTIF 一定
            // 得 0，因為冇任何一日有更）——純 DB 推導都計得返（0 係
            // 數學事實，唔靠 raw 字面），唔使成行留空。B1：雞頭版
            // （`opts.brokerId`）呢一行實牙實齒係「唔屬於呢個 broker」
            // （`allRecords` 已經 scope 過），連呢個 0 都唔寫——「其他行
            // 留空」，唔淨係唔漏名/電話，連「呢個位置有第幾多個更」呢類
            // 結構性暗示都唔漏。
            if (!opts.brokerId && rowHasTrailingTotal(originalRow)) {
              ws.getCell(rowNum, labelCol + 1 + DAYS).value = 0;
              if (section.trailingSummaryCodes) {
                for (let i = 0; i < section.trailingSummaryCodes.length; i++) {
                  ws.getCell(rowNum, labelCol + DAYS + 2 + i).value = 0;
                }
              }
            }
            return;
          }
          blockCount++;
          // Gate 1 階段 1（純加法，新分支）：呢一行有 raw_row（seed 時由
          // 原檔逐行讀出，見 scripts/seed/lib/roster-raw.ts）就逐格原樣
          // 照抄（連行內合計欄嘅 formula 都一齊照抄，唔使再靠
          // section.hasTrailingTotal 個別計），完全唔行落面嗰段 DB 推導
          // 邏輯——冇 raw_row 先行返舊路徑（舊路徑一格都冇改）。Gate 2
          // `--derived`（`opts.derivedOnly`）／雞頭版（`opts.brokerId`）
          // 強制唔用（下面 hasAnyProvenanceRows 已經係 false，但
          // g.rawRow 呢個 check 本身冇跟住 hasAnyProvenanceRows 行，要
          // 獨立加返 `!opts.derivedOnly && !opts.brokerId`）。
          if (g.rawRow && !opts.derivedOnly && !opts.brokerId) {
            writeRawRowCells(ws, rowNum, g.rawRow);
            return;
          }
          const line: string[] =
            layout === "standard"
              ? [g.brokerCode, g.timeSlot, g.rank, g.staffNo, g.tel, g.nameZh]
              : layout === "digital_port"
                ? [g.brokerCode, g.timeSlot, g.rank, g.staffNo, g.tel, g.nameEn, g.nameZh]
                : [g.brokerCode, g.timeSlot, g.rank, g.propertyName, g.staffNo, g.tel, g.nameZh];
          setRowValues(ws, rowNum, 1, line);
          for (let d = 0; d < DAYS; d++) {
            const v = g.days.get(d + 1);
            if (v) ws.getCell(rowNum, labelCol + 1 + d).value = v;
          }
          // 規劃裁定（第二輪 point 3；Gate 2 修正 2026-09-12）：行內合計欄
          // （如有）照原檔——原檔有啲檔喺日期欄之後多一格（例如
          // `COUNTIF(G5:AK5,"C1")`），呢度用*匯出月份*實際日數計位置
          // （唔跟 seed 嗰陣個 31），值＝呢個 guard 呢一行**正更**
          // （`record_type='shift'`）出現幾多次——實測（HKU座頭C更）
          // 揪到原檔嘅 COUNTIF 淨係數緊個 section 嘅主更代號，唔包括
          // 交錯埋嘅 OT（`record_type='ot'`，例如 "OT1"）；舊有
          // `sectionOwnCodes`（成個 section 嘅 code 集合，連 OT 個 code
          // 都計埋）會令 OT-only 嘅行都錯誤咁計到主計欄度，改用
          // `g.shiftDays`（呢一行邊幾日係正更，seed 已經分開存
          // `record_type`）先啱。
          if (rowHasTrailingTotal(originalRow)) {
            const cnt = g.shiftDays.size;
            ws.getCell(rowNum, labelCol + 1 + DAYS).value = cnt;
            // Gate 2（`--derived`）：主總計欄之後嘅「按請假代號分類小計」
            // 額外欄（見 section.trailingSummaryCodes／
            // scripts/seed/lib/roster-layout.ts trailingSummaryLabelsAt()）
            // ——逐個代號喺呢一行嘅 `g.days`（實際更別/leaveCode 代號）
            // 數出現次數，純 DB 推導，唔靠 raw 字面。
            if (section.trailingSummaryCodes) {
              for (let i = 0; i < section.trailingSummaryCodes.length; i++) {
                const code = section.trailingSummaryCodes[i]!;
                const codeCnt = [...g.days.values()].filter((v) => v === code).length;
                ws.getCell(rowNum, labelCol + DAYS + 2 + i).value = codeCnt;
              }
            }
          }
        };

        // 第三輪規劃裁定：優先用 provenance row 範圍精確還原（連內部
        // blank_guard_row 位置都照原檔）；搵唔到（新月份冇 provenance）
        // 先跌返 shiftTypeCodes 排序 fallback（shift_type→雞頭代號→姓名，
        // 純 sequential，minRows 補底）。
        //
        // Gate 1 階段 1（純加法）：`guardsByRowRange` 淨係喺*成個 section
        // 嘅 row 範圍入面完全冇任何 provenance*先至返 null——一個單行
        // section（好似「成月零更嘅安員」嗰種）好易撞正呢個情況（section
        // 得一行、嗰行本身冇 shift_record），但呢個 site×月成體嚟講其實
        // 係原檔月（`hasAnyProvenanceRows`），先至用得 section.rawRows
        // 頂上（唔可以用喺新月份，會將 7 月嘅字面錯誤貼落 8 月新行）。
        const byRow = guardsByRowRange(section.rowFrom, section.rowTo);
        // Gate 2 規劃裁定修正（2026-09-12）：呢度特登用 `isSourceMonth`
        // （唔理 `opts.derivedOnly`），唔用 `hasAnyProvenanceRows`——
        // `hasAnyProvenanceRows` 喺 `--derived` 一律強制 false（保護
        // banner/header/total_group 唔用 raw 字面，呢個唔改），但「成個
        // section 淨係得 external／零更安員（`byRow` 成個範圍都搵唔到
        // 任何記錄，例如客戶自己嘅人成月都冇入 `allRecords`）」嘅
        // section 就算喺 `--derived` 都要入呢個分支——原因：呢類行喺
        // *任何* DB query 都攞唔到嘢（唔係「識推導但揀咗唔用」），
        // `section.rawRows`／逐行 `trailingTotalRows` 係*唯一*仲原檔
        // row 位置對應得返嘅資料（唔係「cheat」，係冇第二條路）。
        // `isSourceMonth` 保證咗月份安全（新月份實牙實齒 false，唔會漏
        // 用 7 月字面）。Opus 對抗式驗收 B1（必修）：`!opts.brokerId`——
        // 雞頭版一律唔行呢個 raw fallback（`byRow` 本身已經係
        // broker-scoped，如果呢個 section 成個 range 對呢個 broker嚟講
        // 一條記錄都冇，即係呢個 section 淨係得其他 broker 嘅安員，成個
        // section 應該原封不動留空，唔可以再跌落 `section.rawRows`
        // 攞返其他 broker 嘅真名/電話）。
        if (byRow || (isSourceMonth && !opts.brokerId)) {
          for (let row = section.rowFrom; row <= section.rowTo; row++) {
            const g = byRow?.get(row);
            if (g) {
              // R2：呢一行如果係「成行 void 晒」（R1 個 `allCancelled`
              // flag），計落 `rawFallbackCells.allCancelled`——雖然
              // render 路徑本身純推導（唔係 raw 字面），但呢一行嘅內容
              // 同原檔（seed 嗰陣個月）已經唔一致，值得喺報表單獨track。
              if (g.allCancelled) rawFallbackCells.allCancelled++;
              writeGuardRow(g, row);
              continue;
            }
            // 呢一行冇任何 shift_record 落入 `allRecords`（`allRecords`
            // 嘅 query 故意剝走 `isExternal:true`／`source='payroll_
            // only'`——呢兩類人業務上唔應該計落更表統計，但佢哋物理上
            // 仍然存在原檔嘅方格入面：成月零更嘅安員、純特殊項調整、
            // 或者客戶自己嘅人（external）。呢種情況冇對應 record 可以
            // 用 DB 推導呢一行嘅內容（連 `record_type='shift'` 呢類
            // 基本歸類都冇），淨係搵 `section.rawRows`（原檔逐格字面，
            // seed 時逐行全部記低，見 scripts/seed/lib/roster-layout.ts）
            // 頂上——呢個唔算「用 raw 字面遮醜」（呢一行喺任何 DB query
            // 都攞唔到嘢，`--derived` 都要用，唔係揀唔揀嘅問題），冇就
            // writeGuardRow(undefined)（純空行，佢入面會再補返自己嘅
            // 主總計欄，如果原檔呢個位真係有——但雞頭版連呢個都唔補，
            // 見 writeGuardRow 入面 `!opts.brokerId` 個 check）。實測：
            // 數碼港 CP1-4 有大批 external 安員行淨係靠呢個 fallback
            // 先重現得返（曾經錯誤咁淨係喺 `hasAnyProvenanceRows` 先俾
            // 用，令呢批 external 行喺 `--derived` 完全變空 316 格逐日
            // 格 regression，已經 revert）。B1：雞頭版（`opts.brokerId`）
            // 一律唔用 `section.rawRows`——呢一行可能係*其他 broker*
            // 嘅安員，raw 字面會洩漏真名/電話/工號。
            const rawOnly = opts.brokerId ? undefined : section.rawRows?.[String(row)];
            if (rawOnly) {
              blockCount++;
              // A1：分類記低（`external`＝呢個 row 喺冇 isExternal/source
              // 濾走嘅版本其實有記錄；`zeroShift`＝真係乜記錄都冇）。
              if (rowsWithAnyRecord.has(row)) rawFallbackCells.external++;
              else rawFallbackCells.zeroShift++;
              emitRawRow(ws, rawOnly);
              continue;
            }
            writeGuardRow(undefined, row);
          }
        } else {
          const guards = guardsForCodes(section.shiftTypeCodes);
          const n = Math.max(section.minRows, guards.length);
          for (let i = 0; i < n; i++) writeGuardRow(guards[i]);
        }
        break;
      }
      case "blank":
        for (let i = 0; i < section.rows; i++) emitBlankRow(ws);
        break;
      case "total_group": {
        // 第三輪規劃裁定：優先用 provenance row 範圍（scopeRowFrom/To）
        // 精確判斷邊啲記錄計呢組數，搵唔到（新月份）先跌返 scopeCodes。
        const workedArr = workedByDayForRowRange(section.rowFrom, section.rowTo) ?? workedByDayForCodes(section.scopeCodes);
        const reqArr = (await reqByDayForRowRange(section.rowFrom, section.rowTo)) ?? (await reqByDayForCodes(section.scopeCodes));
        // Gate 2 規劃裁定修正（2026-09-12）：原檔嘅「尚欠」公式本身係
        // `=所需人手-Total`（直接減，見原檔 formula 例如
        // `H12-H11`），冇 `MAX(0,...)` 夾住——超額配置（實際出更多過
        // 所需）原檔會出負數（例如 -1）。之前呢度用 `Math.max(0,...)`
        // 夾住，喺 derived 模式（純 DB 推導，冇 raw 字面）令呢類「超額」
        // 日子計錯（實測：數碼港 CP5）。跟返原檔公式，容許負數。
        const shortfallArr = reqArr.map((req, i) => req - workedArr[i]);
        for (const row of section.rows) {
          // Gate 1 階段 2（純加法）：呢一行有 rawRow 就逐格照抄（連原檔
          // 會出現嘅負數「尚欠」呢類 `Math.max(0,...)` 計唔返嘅值都啱），
          // 冇（新月份）先跌返舊有 metric 計法（一格都冇改）。
          if (hasAnyProvenanceRows && row.rawRow) {
            emitRawRow(ws, row.rawRow);
            continue;
          }
          const rowNum = ws.rowCount + 1;
          ws.addRow([]);
          writeBannerCells(ws, rowNum, labelCol, row.cells);
          const arr = row.metric === "worked" ? workedArr : row.metric === "required" ? reqArr : row.metric === "shortfall" ? shortfallArr : null;
          if (arr) {
            for (let i = 0; i < DAYS; i++) ws.getCell(rowNum, labelCol + 1 + i).value = arr[i];
          } else if (row.literalDayValues) {
            for (let i = 0; i < Math.min(DAYS, row.literalDayValues.length); i++) {
              const v = row.literalDayValues[i];
              if (v !== null && v !== undefined) ws.getCell(rowNum, labelCol + 1 + i).value = v;
            }
          }
        }
        break;
      }
      case "literal_row":
        // Gate 1 階段 2（純加法）：見 banner 個案同一手法。
        if (hasAnyProvenanceRows && section.rawRow) {
          emitRawRow(ws, section.rawRow);
        } else {
          emitLiteralRow(ws, labelCol, section.cells);
        }
        break;
    }
  }

  return { workbook: wb, layout, siteName: site.canonicalName, blockCount, rawFallbackCells };
}

async function buildGenericRosterWorkbook(
  site: { id: string; canonicalName: string },
  layout: RosterLayout,
  month: Date,
  opts: BuildRosterOptions,
): Promise<RosterExportResult> {
  const siteId = site.id;
  const labelCol = LABEL_COL[layout];
  const headerLabels = HEADER_ROW_LABELS[layout];

  const monthStartUtc = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const DAYS = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const monthEndUtc = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), DAYS));

  const shiftTypes = await prisma.shiftType.findMany({
    where: { siteId, voidedAt: null },
    orderBy: { code: "asc" },
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME);
  let blockCount = 0;

  // 冇 roster_layout 模板（新 site，未跑過 seed 反推）：冇原檔可以對齊，
  // 淨係補 2 行空白等第一個 block 嘅「Date」行落喺同「有模板」情況一致
  // 嘅 row（row3），純粹方便人手比對，唔代表呢 2 行有咩數據意義。
  ws.addRow([]);
  ws.addRow([]);

  for (const st of shiftTypes) {
    // is_external=true（客戶自己嘅人）／source='payroll_only'（淨係喺
    // 糧單出現、更表冇對應 cell 嘅記錄）一律唔喺更表視圖顯示——同
    // scripts/report/roster.ts writeRosterXlsx() 同一個口徑（見嗰個
    // 檔案頂註解，Opus 驗收 item 3 已經確認呢個口徑）。
    const records = await prisma.shiftRecord.findMany({
      where: {
        siteId,
        shiftTypeId: st.id,
        workDate: { gte: monthStartUtc, lte: monthEndUtc },
        isExternal: false,
        // Opus 對抗式驗收 B2：同 buildTemplatedRosterWorkbook 一致嘅
        // NULL-safe 修正（見嗰邊詳細註解）。
        OR: [{ source: null }, { source: { not: "payroll_only" } }],
        ...(opts.brokerId
          ? { AND: [{ OR: [{ settlementBrokerId: opts.brokerId }, { operationalBrokerId: opts.brokerId }] }] }
          : {}),
      },
      include: { guard: { include: { defaultBroker: true } }, settlementBroker: true, operationalBroker: true },
      orderBy: [{ workDate: "asc" }],
    });
    // Opus 對抗式驗收 B3：cancelled 嘅記錄唔算「呢個更別有資料」——避免
    // 淨係得 cancelled 記錄嘅更別都當「有嘢」出成個 block（下面逐格
    // render 仲要再跳過 cancelled，見 for 迴圈入面嘅 skip）。
    const activeRecords = records.filter((r) => r.status !== "cancelled");
    if (activeRecords.length === 0) continue; // 呢個更別呢個月（或者呢個雞頭）冇資料——冧走成個 block

    type RowAgg = {
      staffNo: string;
      tel: string;
      nameZh: string;
      nameEn: string;
      brokerCode: string;
      propertyName: string;
      days: Map<number, string>;
    };
    const rows = new Map<string, RowAgg>();
    const dayTotals = new Array(DAYS).fill(0);

    for (const r of records) {
      // Opus 對抗式驗收 B3：void 咗（`status=cancelled`）嘅格當冇更次
      // 記錄過——同 computeWarnings()（shift-records/batch/route.ts）
      // 一致口徑，唔會喺更表匯出照印。
      if (r.status === "cancelled") continue;
      const day = dayOfMonth(r.workDate);
      const cellCode = r.recordType === "shift" || r.recordType === "ot" ? displayShiftCode(st.code) : (r.leaveCode ?? "?");
      if (r.recordType === "shift") dayTotals[day - 1]++;

      if (!rows.has(r.guardId)) {
        const brokerCode = r.settlementBroker?.code ?? r.operationalBroker?.code ?? r.guard.defaultBroker?.code ?? "";
        const provenance = (r.provenance ?? {}) as Record<string, unknown>;
        const subSite = typeof provenance.sub_site === "string" && provenance.sub_site ? provenance.sub_site : null;
        rows.set(r.guardId, {
          staffNo: r.guard.staffNo ?? "",
          tel: formatTel(r.guard.tel),
          nameZh: r.guard.nameZh,
          nameEn: r.guard.nameEn ?? "",
          brokerCode,
          propertyName: subSite ?? site.canonicalName,
          days: new Map(),
        });
      }
      rows.get(r.guardId)!.days.set(day, cellCode);
    }

    blockCount++;

    // ---- Header 行：「Date」+ 逐日日期 ----
    const dateRow: Array<string | Date> = new Array(labelCol).fill("");
    dateRow[labelCol - 1] = "Date";
    for (let i = 0; i < DAYS; i++) dateRow.push(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1)));
    ws.addRow(dateRow);

    // ---- 下一行：雞頭代號／時段／職級／工號／[英文名或Property Name]／電話／Name ----
    const fieldRow: string[] = [...headerLabels];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1));
      fieldRow.push(WEEKDAY[d.getUTCDay()]);
    }
    ws.addRow(fieldRow);

    // ---- 逐個安員一行 ----
    const sortedGuards = [...rows.entries()].sort(
      ([, a], [, b]) => (a.staffNo || "").localeCompare(b.staffNo || "") || a.nameZh.localeCompare(b.nameZh),
    );
    const rank = rankFromShiftTypeLabel(st.label);
    const timeSlot = timeSlotLabel(st.startTime, st.endTime);
    for (const [, g] of sortedGuards) {
      const line: string[] = [];
      if (layout === "standard") {
        line.push(g.brokerCode, timeSlot, rank, g.staffNo, g.tel, g.nameZh);
      } else if (layout === "digital_port") {
        line.push(g.brokerCode, timeSlot, rank, g.staffNo, g.tel, g.nameEn, g.nameZh);
      } else {
        line.push(g.brokerCode, timeSlot, rank, g.propertyName, g.staffNo, g.tel, g.nameZh);
      }
      for (let i = 0; i < DAYS; i++) line.push(g.days.get(i + 1) ?? "");
      ws.addRow(line);
    }

    // ---- Total／所需人手／尚欠 三行（同 scripts/report/roster.ts 一致嘅邏輯，
    //      淨係收窄做呢個 block/shift_type 專屬——daily_requirements 本身
    //      就有 shift_type_id 呢個粒度）----
    const daily = await prisma.dailyRequirement.groupBy({
      by: ["workDate"],
      where: { siteId, shiftTypeId: st.id, workDate: { gte: monthStartUtc, lte: monthEndUtc } },
      _sum: { headcountRequired: true },
    });
    const reqByDay = new Array(DAYS).fill(0);
    for (const d of daily) reqByDay[dayOfMonth(d.workDate) - 1] = d._sum.headcountRequired ?? 0;

    const labelledRow = (label: string): string[] => {
      const arr = new Array(labelCol).fill("");
      arr[labelCol - 1] = label;
      return arr;
    };
    ws.addRow([...labelledRow("Total"), ...dayTotals]);
    ws.addRow([...labelledRow("所需人手"), ...reqByDay]);
    // Gate 2 規劃裁定修正：同 buildTemplatedRosterWorkbook 一致，跟返
    // 原檔公式（直接減，容許負數，見嗰邊嘅詳細註解），唔再夾住 0。
    ws.addRow([...labelledRow("尚欠"), ...reqByDay.map((req, i) => req - dayTotals[i])]);
    ws.addRow([]); // block 之間留一行分隔
  }

  return { workbook: wb, layout, siteName: site.canonicalName, blockCount };
}

/** 公開入口——`GET /api/sites/:id/roster-export` 同
 * `scripts/report/roster-export-diff.ts` 兩邊共用嘅唯一 writer（見檔案
 * 頂註解）。有 `site.roster_layout` 模板就用 `buildTemplatedRosterWorkbook`
 * （block 分組／橫額／表頭裝飾字跟原檔），冇就跌返
 * `buildGenericRosterWorkbook`（一個 shift_type 一個 block，冇橫額）。 */
export async function buildRosterWorkbookForSite(
  siteId: string,
  month: Date,
  opts: BuildRosterOptions = {},
): Promise<RosterExportResult> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
  const rawTemplate = site.rosterLayout as unknown;
  if (isRosterLayoutTemplate(rawTemplate)) {
    return buildTemplatedRosterWorkbook(site, rawTemplate, month, opts);
  }
  const layout = detectLayout(site);
  return buildGenericRosterWorkbook(site, layout, month, opts);
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

// ---------------------------------------------------------------------------
// P1-WP3 Gate 2（`--derived` 模式，規劃裁定 2026-09-12 階段 3）：逐格分類
// 「呢格屬於邊一類」（逐日格／行首欄／結構格），俾 `roster-export-diff.ts
// --derived` 用嚟分桶統計，唔使喺 gate script 度重複一次 section 邏輯。
// 呢度嘅 row 計法（banner=1／header=2／guard_rows=rowTo-rowFrom+1／
// blank=N／total_group=rows.length／literal_row=1）同
// `buildTemplatedRosterWorkbook()` 逐個 section render 出嚟嘅實際 row 數
// 完全一致（row 數本身唔跟 raw／derived 定 DAYS 變，淨係格值先變），
// 純粹重新行一次 section 列表計 row 範圍，唔會令呢個 export writer 本身
// 多一條分支。
export type RosterCellKind = "day" | "row_header" | "structural";

export interface GuardRowSpan {
  from: number;
  to: number;
  labelCol: number;
  days: number;
}

/** 逐個 template 計佢自己嘅 guard_rows row 範圍（喺*呢個 template 自己
 * 個 workbook* 入面嘅 1-indexed row number，唔理城巴合併嗰種跨 site
 * offset——嗰個由 caller 自己加）。 */
export function computeGuardRowSpans(template: RosterLayoutTemplate, days: number): GuardRowSpan[] {
  const labelCol = LABEL_COL[template.layout];
  const spans: GuardRowSpan[] = [];
  let cursor = 1;
  for (const section of template.sections) {
    switch (section.kind) {
      case "banner":
      case "literal_row":
        cursor += 1;
        break;
      case "header":
        cursor += 2;
        break;
      case "guard_rows": {
        const n = section.rowTo - section.rowFrom + 1;
        spans.push({ from: cursor, to: cursor + n - 1, labelCol, days });
        cursor += n;
        break;
      }
      case "blank":
        cursor += section.rows;
        break;
      case "total_group":
        cursor += section.rows.length;
        break;
    }
  }
  return spans;
}

/** (row,col) 屬邊一類——`spans` 已經加埋城巴合併嘅跨 site row offset。 */
export function classifyRosterCell(spans: GuardRowSpan[], row: number, col: number): RosterCellKind {
  for (const s of spans) {
    if (row < s.from || row > s.to) continue;
    if (col <= s.labelCol) return "row_header";
    if (col <= s.labelCol + s.days) return "day";
    return "structural";
  }
  return "structural";
}

/** 行首欄（row_header）逐格對應緊邊個業務欄位——見檔案頂註解三種版面
 * 嘅 offset 定義。淨係俾 Gate 2 分類報告用（人類可讀嘅欄位名，唔係
 * PDPO 個人資料，純粹欄位標籤）。 */
export function rowHeaderFieldName(layout: RosterLayout, col: number, labelCol: number): string {
  const offset = col - labelCol;
  if (offset === 0) return "姓名";
  const standardMap: Record<number, string> = { [-5]: "雞頭代號", [-4]: "時段", [-3]: "職級", [-2]: "工號", [-1]: "電話" };
  const digitalPortMap: Record<number, string> = { [-6]: "雞頭代號", [-5]: "時段", [-4]: "職級", [-3]: "工號", [-2]: "電話", [-1]: "英文名" };
  const citybusMap: Record<number, string> = { [-6]: "雞頭代號", [-5]: "時段", [-4]: "職級", [-3]: "Property Name", [-2]: "工號", [-1]: "電話" };
  const map = layout === "standard" ? standardMap : layout === "digital_port" ? digitalPortMap : citybusMap;
  return map[offset] ?? `col_offset_${offset}`;
}
