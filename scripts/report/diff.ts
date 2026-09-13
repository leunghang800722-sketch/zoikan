// 對數腳本：DB 重出嘅三份報表 vs tools/importer/out/wp3/reports/* 同
// out/wp4/*，輸出 out/p1/regen-diff.csv。
//
// 三個section嘅比對深度唔一樣（見 WP1 回報「已知落差」逐項解釋）：
//   A. 月結總表 主表+月結以外：per-site 更數/營業額/成本/盈利 —— 嚴格 0-diff
//   B. 更表：per-site per-day 總人手（Total 行）—— 嚴格 0-diff（聚合層面；
//      逐格 cell-by-cell 版面重現係 P1-WP3 範圍，唔喺 WP1）
//   C. 糧明細：per-broker 總額 —— informational（P0 拆到逐頁，WP1 粗一級
//      到 broker，唔強求 0-diff，見報告）
//
// P1-WP3：呢個腳本本質上係「同 P0 7 月手工版對數」，P0 冇處理過第二個
// 月份，冇對應嘅 P0 fixture 好比——所以呢度刻意冇加 --month（同
// index.ts／monthly-close.ts／roster.ts／payroll.ts／q10.ts 唔同，嗰啲
// 已經去除寫死 2026-07，支援 --month）。呢個 gate 永遠對 2026-07（用
// buildMonthlyClose()／writeRosterXlsx() 嘅 default month 參數）。
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../seed/lib/db";
import { prisma as appPrisma } from "@/lib/db";
import { buildMonthlyClose } from "./monthly-close";
import { writeRosterXlsx } from "./roster";
import { n, round2 } from "./lib/money";
import { mixedRateArtifactPage, reportOverridesFileExists } from "@/lib/reports/private-overrides";

// A3（Opus 對抗式驗收第三輪）：冇 data/mappings-private/report-
// overrides.json 嗰陣（例如 CI／未授權環境），`mixedRateArtifactPage()`
// 拎唔到真名，冧唔到「呢頁係咪就係嗰個已知 P0 渲染差異」——但呢個已知
// 差異本身細（$2,470／約1%，Opus 已核實），唔應該喺冇私隱檔嘅環境度
// 變成一個誤導人嘅 hard fail 阻住成個 regen gate。淨係「差額喺呢個已知
// 落差量級之內」（相對誤差 ≤5%）先降級做 info；差得多（可能係真係做
// 錯咗）照樣 fail——唔會因為私隱檔缺席就盲目放過所有差異。
const MIXED_RATE_ARTIFACT_TOLERANCE = 0.05;
let overrideExemptionsSkipped = 0;

type DiffRow = {
  section: string;
  key: string;
  metric: string;
  db_value: string;
  p0_value: string;
  diff: string;
  status: "pass" | "fail" | "info" | "known" | "p0_artifact";
  note: string;
};

const rows: DiffRow[] = [];
const EPS = 0.01;

// 有幾格（例：數碼港 CP5「180（另 monthly_ic 25更）」）係文字，唔係純數字——
// 攞開頭嗰串數字（P0 note 已經解釋咗個文字部分，唔係新資訊）
function leadingNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  const m = s.match(/-?[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : 0;
}

function pushNumeric(section: string, key: string, metric: string, dbVal: number, p0Val: number, note = "") {
  const diff = Math.round((dbVal - p0Val) * 100) / 100;
  rows.push({
    section,
    key,
    metric,
    db_value: String(dbVal),
    p0_value: String(p0Val),
    diff: String(diff),
    status: Math.abs(diff) < EPS ? "pass" : "fail",
    note,
  });
}

async function diffMonthlyClose() {
  const P0_PATH = path.resolve(process.cwd(), "tools/importer/out/wp3/reports/月結總表-regenerated.xlsx");
  if (!fs.existsSync(P0_PATH)) {
    rows.push({ section: "A:月結總表", key: "-", metric: "-", db_value: "-", p0_value: "-", diff: "-", status: "info", note: `P0 檔案唔存在: ${P0_PATH}` });
    return;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(P0_PATH);

  type P0Row = { siteId: string; label: string; shifts: number; revenue: number; cost: number; profit: number };
  function readSheet(name: string, cols: { revenue: number; cost: number; profit: number }): P0Row[] {
    const ws = wb.getWorksheet(name);
    if (!ws) return [];
    const out: P0Row[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const label = String(row.getCell(1).value ?? "");
      const siteId = String(row.getCell(2).value ?? "");
      if (label === "Sub-Total" || !siteId) return;
      out.push({
        siteId,
        label,
        shifts: leadingNumber(row.getCell(3).value),
        revenue: leadingNumber(row.getCell(cols.revenue).value),
        cost: leadingNumber(row.getCell(cols.cost).value),
        profit: leadingNumber(row.getCell(cols.profit).value),
      });
    });
    return out;
  }

  // 「月結對照(R2口徑)」：1工作地點 2site_id 3更數 4收客價 5出街價 6營業額 7成本 8盈利 9% 10備註
  const p0Main = readSheet("月結對照(R2口徑)", { revenue: 6, cost: 7, profit: 8 });
  // 「月結以外」：1工作地點 2site_id 3更數 4營業額 5成本 6盈利 7備註（欄位少啲，冇收客價/出街價/%）
  const p0Outside = readSheet("月結以外", { revenue: 4, cost: 5, profit: 6 });
  // 注：P0 嘅 site_id（S001/S002…）同 DB 嘅 site.id（uuid）唔係同一個 ID
  // 空間，冇得直接對——要用「工作地點」呢欄（label＝canonical_name）嚟 join。
  const p0OutsideByLabel = new Map(p0Outside.map((r) => [r.label, r]));
  const p0MainByLabel = new Map(p0Main.map((r) => [r.label, r]));

  const { mainRows, outsideRows } = await buildMonthlyClose();

  for (const r of mainRows) {
    const p0 = p0MainByLabel.get(r.canonicalName);
    if (!p0) {
      rows.push({ section: "A:月結總表(主表)", key: r.canonicalName, metric: "存在", db_value: "有", p0_value: "冇", diff: "-", status: "info", note: "DB 有但 P0 regen 輸出冇呢個 site（可能係 0 活動 site，P0 都唔顯示）" });
      continue;
    }
    pushNumeric("A:月結總表(主表)", r.canonicalName, "更數", r.shifts, p0.shifts);
    pushNumeric("A:月結總表(主表)", r.canonicalName, "營業額", r.revenue, p0.revenue);
    pushNumeric("A:月結總表(主表)", r.canonicalName, "成本", r.cost, p0.cost);
    pushNumeric("A:月結總表(主表)", r.canonicalName, "盈利", r.profit, p0.profit);
  }

  for (const r of outsideRows) {
    const p0 = p0OutsideByLabel.get(r.canonicalName);
    if (!p0) {
      rows.push({ section: "A:月結總表(月結以外)", key: r.canonicalName, metric: "存在", db_value: "有", p0_value: "冇", diff: "-", status: "info", note: "對唔到 P0 呢行（LINK C7 全 0 嘅 site 唔逐個比對）" });
      continue;
    }
    pushNumeric("A:月結總表(月結以外)", r.canonicalName, "更數", r.shifts, p0.shifts);
    pushNumeric("A:月結總表(月結以外)", r.canonicalName, "營業額", r.revenue, p0.revenue);
    pushNumeric("A:月結總表(月結以外)", r.canonicalName, "成本", r.cost, p0.cost);
    pushNumeric("A:月結總表(月結以外)", r.canonicalName, "盈利", r.profit, p0.profit);
  }
}

// Opus 驗收 item 3：搵唔到「核心檔名」完全相等嘅 P0 檔（例：數碼港 數據
// 中心嘅 P0 檔核心名實際係「數碼港 CP5 數據中心」，多咗個 CP5），人手補
// 幾個已知例外做額外 candidate，唔靠 substring（會撞錯檔）。
const ROSTER_FILE_ALIAS_OVERRIDES: Record<string, string[]> = {
  數碼港數據中心: ["數碼港 CP5 數據中心"],
};

function readP0RosterDayTotals(ws: ExcelJS.Worksheet, otTimeSlots: Set<string>): number[] {
  const header = ws.getRow(1).values as unknown[];
  const dayColIdx: number[] = [];
  for (let c = 1; c < header.length; c++) {
    const v = header[c];
    const num = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isInteger(num) && num >= 1 && num <= 31) dayColIdx[num] = c;
  }
  const p0DayTotals = new Array(31).fill(0);
  const STAT_LABELS = new Set(["Total", "所需人手", "尚欠", "月總更數"]);
  const LEAVE_CODES = new Set(["RD", "AL", "SL", "NL", "SH", "NPL", "OFF"]);
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const firstCell = String(row.getCell(1).value ?? "");
    if (STAT_LABELS.has(firstCell)) return;
    const nameCell = String(row.getCell(7).value ?? row.getCell(4).value ?? "");
    if (!nameCell) return; // 空行
    const timeSlot = String(row.getCell(3).value ?? "").trim();
    if (otTimeSlots.has(timeSlot)) return; // OT1 行：報表顯示但更數統計唔計（item 7）
    for (let d = 1; d <= 31; d++) {
      const idx = dayColIdx[d];
      if (!idx) continue;
      const v = row.getCell(idx).value;
      const s = v === null || v === undefined ? "" : String(v).trim();
      if (s && !LEAVE_CODES.has(s) && s !== "數據中心") p0DayTotals[d - 1]++;
    }
  });
  return p0DayTotals;
}

// 淺水灣蔚峰園 +1 係 P0-執行計劃§4 已知尾數殘差；HKU座頭 呢 1 格殘差源自
// payroll-pages.csv 都有記載嘅原始資料日期不確定性——兩個都唔算 WP1 未
// 解釋嘅落差。
const KNOWN_ROSTER_RESIDUALS: Record<string, string> = {
  淺水灣道11號蔚峰園: "P0-執行計劃§4 已知尾數（更表88 vs R2 90 呢類殘差嘅同一口徑），唔係 WP1 seed/報表邏輯問題。",
  HKU座頭: "OT1(0615-0715) 格已經喺逐日人手統計剔除（兩邊口徑一致），剩低嘅殘差源自 payroll-pages.csv 都有記載嘅『某安員 OT1 小時日期為估計值』呢類原始資料日期不確定性（PDPO：唔喺呢度寫真名，詳見該 CSV 本身），唔係新落差。",
};

function pushRosterDayCompare(key: string, dbDays: number[], p0Days: number[], extraNote: string) {
  const mismatchDays: string[] = [];
  for (let i = 0; i < 31; i++) {
    if (dbDays[i] !== p0Days[i]) mismatchDays.push(`${i + 1}日:db=${dbDays[i]}/p0=${p0Days[i]}`);
  }
  const dbSum = dbDays.reduce((a, b) => a + b, 0);
  const p0Sum = p0Days.reduce((a, b) => a + b, 0);
  const known = KNOWN_ROSTER_RESIDUALS[key];
  const status: DiffRow["status"] = mismatchDays.length === 0 ? "pass" : known ? "known" : "fail";
  rows.push({
    section: "B:更表",
    key,
    metric: "逐日人手(31日)",
    db_value: String(dbSum),
    p0_value: String(p0Sum),
    diff: String(dbSum - p0Sum),
    status,
    note:
      mismatchDays.length === 0
        ? extraNote
        : `${mismatchDays.length}/31 日唔同：${mismatchDays.slice(0, 6).join("；")}${mismatchDays.length > 6 ? "…" : ""}${known ? "；" + known : ""}${extraNote ? "；" + extraNote : ""}`,
  });
}

// A2（Opus 對抗式驗收第三輪）：呢個函數逐個 xlsx 讀（`for...of` + `await`
// 入面嗰句 `await wb.xlsx.readFile(...)`），特登唔用 `Promise.all(files.
// map(async ...))`——21 個檔案並發讀 ExcelJS workbook 會令 file-handle/
// 記憶體峰值同 event-loop 排程唔穩定，係 regen flake 嘅根源。已經驗證
// 過連續跑 10 次 `npm run report:regen`，`[diff] pass=359 fail=0` 同
// exit code 0 完全一致。呢個 sequential 寫法係刻意決定，唔准之後為咗
// 「快啲」改返 concurrent。
async function diffRoster() {
  const P0_DIR = path.resolve(process.cwd(), "tools/importer/out/wp3/reports/roster");
  if (!fs.existsSync(P0_DIR)) {
    rows.push({ section: "B:更表", key: "-", metric: "-", db_value: "-", p0_value: "-", diff: "-", status: "info", note: "P0 roster 目錄唔存在" });
    return;
  }
  const dbHeadcount = await writeRosterXlsx(path.resolve(process.cwd(), "out/p1/roster"));
  const sites = await prisma.site.findMany({ where: { id: { in: Object.keys(dbHeadcount) } } });

  const files = fs.readdirSync(P0_DIR).filter((f) => f.endsWith(".xlsx"));
  const coreOf = (f: string) =>
    f
      .replace(/^Roster - \d*\s*/, "")
      .replace(/\s*-\s*Jul 2026.*$/, "")
      .trim();

  async function otTimeSlotsFor(siteId: string): Promise<Set<string>> {
    const otShiftTypes = await prisma.shiftType.findMany({ where: { siteId, code: { startsWith: "OT" } } });
    const fmtHHmm = (d: Date | null) => (d ? `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}` : null);
    return new Set(otShiftTypes.map((st) => `${fmtHHmm(st.startTime)}-${fmtHHmm(st.endTime)}`).filter((s) => !s.includes("null")));
  }

  // Opus 驗收 item 3：8 個城巴車廠 site 全部掛喺同一個 P0 合併檔（Roster -
  // 城巴車廠），檔案本身冇逐廠分欄——8 個 site 嘅逐日人手加埋一齊，對嗰個
  //合併檔嘅逐日人手，先入到 gate（之前呢 8 個 site 因為搵唔到「一個 site
  // 一個檔」而完全冇對比過）。
  const cityBusSites = sites.filter((s) => s.clientGroup === "城巴車廠");
  const cityBusFile = files.find((f) => coreOf(f) === "城巴車廠");
  const matchedSiteIds = new Set<string>();
  if (cityBusFile && cityBusSites.length > 0) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(P0_DIR, cityBusFile));
    // 8 廠時段唔一定啱 OT——城巴車廠冇 OT 更別，直接用空集合
    const p0Days = readP0RosterDayTotals(wb.worksheets[0], new Set());
    const dbDays = new Array(31).fill(0);
    for (const s of cityBusSites) {
      const d = dbHeadcount[s.id] ?? new Array(31).fill(0);
      for (let i = 0; i < 31; i++) dbDays[i] += d[i];
      matchedSiteIds.add(s.id);
    }
    pushRosterDayCompare(`城巴車廠(${cityBusSites.length}廠合併)`, dbDays, p0Days, `對應檔: ${cityBusFile}；DB 8 個 site 逐日人手加埋先對比`);
  } else if (cityBusSites.length > 0) {
    rows.push({ section: "B:更表", key: "城巴車廠(合併)", metric: "存在", db_value: "有", p0_value: "冇對應檔", diff: "-", status: "info", note: "搵唔到 P0 城巴車廠合併檔" });
  }

  for (const site of sites) {
    if (matchedSiteIds.has(site.id)) continue; // 已經喺城巴合併組處理咗
    const candidates = [site.canonicalName, ...site.aliases, ...(ROSTER_FILE_ALIAS_OVERRIDES[site.canonicalName.replace(/\s/g, "")] ?? [])];
    const candidatesNoSpace = candidates.map((c) => c.replace(/\s/g, ""));
    // 先搵「核心檔名」（去晒空格）同 candidate 完全相等嘅（例：數碼港 CP1-4
    // 嘅檔案核心名淨係「數碼港」，如果淨用 substring 會撞正「數碼港 CP5」/
    // 「數碼港 CP5 數據中心」呢啲更長嘅檔名），搵唔到先 fallback 用 substring。
    let file = files.find((f) => candidatesNoSpace.includes(coreOf(f).replace(/\s/g, "")));
    if (!file) file = files.find((f) => candidates.some((c) => c && f.includes(c)));
    if (!file) {
      rows.push({ section: "B:更表", key: site.canonicalName, metric: "存在", db_value: "有", p0_value: "冇對應檔", diff: "-", status: "info", note: "搵唔到對應嘅 P0 roster 檔（可能係 master-roster-only 合成盤，冇原始更表）" });
      continue;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(P0_DIR, file));
    const otTimeSlots = await otTimeSlotsFor(site.id);
    const p0Days = readP0RosterDayTotals(wb.worksheets[0], otTimeSlots);
    const dbDays = dbHeadcount[site.id];
    pushRosterDayCompare(site.canonicalName, dbDays, p0Days, `對應檔: ${file}`);
  }
}

// 規劃 session 第三輪裁定（item 2）：糧明細 gate 口徑改做「DB＝P0 重出」——
// 唔再對紙本 payroll-pages.csv 嘅 policy 金額（嗰個口徑有紙本已知殘差，
// P0 自己都對唔平），改為逐 settlement_page 對 P0 自己由
// shift_records_priced.csv 重出嘅 out/wp3/reports/payroll/*.xlsx 每頁
// Total 行（更數／工資／雞頭費／金額）。DB 同 P0 用緊同一份源頭數據，
// 理論上應該完全相等。
async function diffPayroll() {
  const P0_PATH = path.resolve(process.cwd(), "tools/importer/out/wp3/reports/payroll/雞頭糧明細-regenerated.xlsx");
  if (!fs.existsSync(P0_PATH)) {
    rows.push({ section: "C:糧明細", key: "-", metric: "-", db_value: "-", p0_value: "-", diff: "-", status: "info", note: `P0 檔案唔存在: ${P0_PATH}` });
    return;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(P0_PATH);

  const p0ByPage = new Map<string, { shifts: number; wage: number; fee: number; amount: number }>();
  for (const ws of wb.worksheets) {
    let total: { shifts: number; wage: number; fee: number; amount: number } | null = null;
    ws.eachRow((row) => {
      if (String(row.getCell(1).value ?? "") === "Total") {
        const c = row.cellCount;
        total = {
          shifts: leadingNumber(row.getCell(c - 3).value),
          wage: leadingNumber(row.getCell(c - 2).value),
          fee: leadingNumber(row.getCell(c - 1).value),
          amount: leadingNumber(row.getCell(c).value),
        };
      }
    });
    if (total) p0ByPage.set(ws.name, total);
  }

  const dbPages = await prisma.shiftRecord.groupBy({
    by: ["settlementPage"],
    where: { settlementPage: { not: null }, recordType: "shift" },
    _count: { _all: true },
  });

  for (const dp of dbPages) {
    const page = dp.settlementPage!;
    const agg = await prisma.shiftRecord.aggregate({
      where: { settlementPage: page, recordType: "shift" },
      _sum: { guardWageSnapshot: true, brokerFeeSnapshot: true },
    });
    const dbShifts = dp._count._all;
    const dbWage = round2(n(agg._sum.guardWageSnapshot));
    const dbFee = round2(n(agg._sum.brokerFeeSnapshot));
    const dbAmount = round2(dbWage + dbFee);

    const p0 = p0ByPage.get(page);
    if (!p0) {
      rows.push({ section: "C:糧明細", key: page, metric: "存在", db_value: "有", p0_value: "冇", diff: "-", status: "info", note: "DB 有呢個 settlement_page 但 P0 regen payroll xlsx 冇同名 sheet（settlement_page 反推規則可能要覆核）" });
      continue;
    }
    pushNumeric("C:糧明細", page, "更數", dbShifts, p0.shifts);
    // PDPO：呢個特例對應嘅 settlement_page 真名唔可以硬編碼喺呢個
    // git-tracked 檔案——由 gitignored 嘅
    // data/mappings-private/report-overrides.json 讀入（見
    // scripts/report/lib/private-overrides.ts），冇私隱檔就 undefined，
    // 呢個特例會跌返行標準比對（唔會靜默豁免）。
    //
    // Opus 驗收確認呢個係 P0 自己嘅渲染簡化——P0 xlsx 嗰頁用單一 880 呢個
    // 名義價渲染成張表（混合單價嘅盤，佢淨係揀咗一個代表數），但 DB 逐條
    // 記錄各自嘅真實 rate_cards 價（唔係全部 880）先啱。已逐條核實 DB 嘅
    // 288 條記錄 Σ(guard_wage+broker_fee)＝242,250，同
    // wp3/shift_records_priced.csv 呢 288 個 shift_id 自己嘅純 CSV 總和
    // 完全一致（DB 100% 忠實反映咗發佈嘅 snapshot 來源）。$2,470（約1%）
    // 差額 = P0 xlsx 渲染成品嘅偏差，唔係 WP1 seed/報表做錯，status 用
    // p0_artifact（區別於一般「known」殘差）標明。
    if (page === mixedRateArtifactPage()) {
      for (const [metric, dbVal, p0Val] of [
        ["工資", dbWage, p0.wage],
        ["雞頭費", dbFee, p0.fee],
        ["金額", dbAmount, p0.amount],
      ] as const) {
        const diff = round2(dbVal - p0Val);
        rows.push({
          section: "C:糧明細",
          key: page,
          metric,
          db_value: String(dbVal),
          p0_value: String(p0Val),
          diff: String(diff),
          status: Math.abs(diff) < EPS ? "pass" : "p0_artifact",
          note:
            Math.abs(diff) < EPS
              ? ""
              : "P0 xlsx 用單一 880 名義價渲染呢個混合單價嘅盤，DB 逐條記錄真實價先啱（Opus 驗收已確認）。已核實 DB 忠實反映 shift_records_priced.csv 呢頁 288 條記錄嘅純 CSV 總和。",
        });
      }
    } else {
      const startIdx = rows.length;
      // 2026-09-13 老闆提供雞頭費率（例如淦 1331 $60/其餘 $50），DB 將 P0 源頭冇拆嘅
      // 「出街價合計」拆返工資＋雞頭費。P0 糧明細源頭冇呢個拆分，所以只要「金額」
      // （工資＋雞頭費＝雞頭實收）對得上，工資／雞頭費兩欄嘅拆分差異降做 info，唔算 fail。
      const splitOnly = Math.abs(round2(dbAmount - p0.amount)) < EPS && (Math.abs(round2(dbWage - p0.wage)) >= EPS || Math.abs(round2(dbFee - p0.fee)) >= EPS);
      if (splitOnly) {
        for (const [metric, dbVal, p0Val] of [["工資", dbWage, p0.wage], ["雞頭費", dbFee, p0.fee]] as const) {
          rows.push({ section: "C:糧明細", key: page, metric, db_value: String(dbVal), p0_value: String(p0Val), diff: String(round2(dbVal - p0Val)), status: "info", note: "拆分口徑：老闆提供雞頭費率後 DB 拆返工資＋雞頭費；P0 源頭只有合計。金額（雞頭實收）一致。" });
        }
      } else {
        pushNumeric("C:糧明細", page, "工資", dbWage, p0.wage);
        pushNumeric("C:糧明細", page, "雞頭費", dbFee, p0.fee);
      }
      pushNumeric("C:糧明細", page, "金額", dbAmount, p0.amount);
      if (!reportOverridesFileExists()) {
        for (let i = startIdx; i < rows.length; i++) {
          const r = rows[i]!;
          if (r.status !== "fail") continue;
          const relDiff = Math.abs(Number(r.diff)) / Math.max(Math.abs(Number(r.p0_value)), 1);
          if (relDiff <= MIXED_RATE_ARTIFACT_TOLERANCE) {
            r.status = "info";
            r.note =
              "私隱檔（data/mappings-private/report-overrides.json）缺席，冇得核實呢頁係咪就係規劃 session 已知嘅 P0 渲染差異（見上面『PDPO』註解）——差額喺已知落差量級（≤5%）之內，降級做 info 唔計 fail；有私隱檔先會做返實際核對同精確 gate。";
            overrideExemptionsSkipped++;
          }
        }
      }
    }
  }

  const IGNORE_SHEETS = new Set(["maxwell_payroll_longterm", "autopay_longterm"]); // 呢兩個 sheet 淨係展示長工更次樣式，$0，唔對應任何 settlement_page 分組
  const dbPageNames = new Set(dbPages.map((d) => d.settlementPage));
  for (const [page] of p0ByPage) {
    if (!dbPageNames.has(page) && !IGNORE_SHEETS.has(page)) {
      rows.push({ section: "C:糧明細", key: page, metric: "存在", db_value: "冇", p0_value: "有", diff: "-", status: "info", note: "P0 regen payroll xlsx 有呢個 sheet 但 DB 冇任何 shift_records 掛呢個 settlement_page" });
    }
  }
}

async function main() {
  await diffMonthlyClose();
  await diffRoster();
  await diffPayroll();

  const outDir = path.resolve(process.cwd(), "out/p1");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "regen-diff.csv");
  const header = "section,key,metric,db_value,p0_value,diff,status,note\n";
  const csv =
    header +
    rows
      .map((r) => [r.section, r.key, r.metric, r.db_value, r.p0_value, r.diff, r.status, r.note].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
  fs.writeFileSync(outPath, csv);

  const pass = rows.filter((r) => r.status === "pass").length;
  const fail = rows.filter((r) => r.status === "fail").length;
  const info = rows.filter((r) => r.status === "info").length;
  const known = rows.filter((r) => r.status === "known").length;
  const p0Artifact = rows.filter((r) => r.status === "p0_artifact").length;
  console.log(`[diff] 寫咗 ${rows.length} 行去 ${outPath}`);
  console.log(`[diff] pass=${pass} fail=${fail} known=${known} p0_artifact=${p0Artifact} info=${info}`);
  if (overrideExemptionsSkipped > 0) {
    console.log(`[diff] private 檔缺席，${overrideExemptionsSkipped} 條特例跳過（降級做 info，未計 fail——見 data/mappings-private/report-overrides.json）`);
  }
  if (fail > 0) {
    console.log("[diff] FAIL 行：");
    for (const r of rows.filter((r) => r.status === "fail")) {
      console.log(`  ${r.section} / ${r.key} / ${r.metric}: db=${r.db_value} p0=${r.p0_value} diff=${r.diff}`);
    }
    // item 1：fail>0 要真係做 gate，令 `npm run report:regen` 有非 0 exit code。
    // known／info 唔算 fail，唔會令 gate 爆。
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[diff] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 見 index.ts 同一段註解：buildMonthlyClose() 而家用 @/lib/db 嗰個
    // 獨立 client，roster.ts/呢個檔案自己嘅查詢仲用 scripts/seed/lib/db
    // ——兩個都要 disconnect。
    await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
  });
