// 更表編輯器（P1-WP3，設計文件§6.1/§6.2/§4.1/§4.2）——以現有 Excel 更表為
// 視覺藍本：一「行」=(shift_type_id, guard_id) 組合（`key =
// shiftTypeId|guardId`，同 scripts/report/roster.ts 一致嘅分組口徑），
// 一「列」= day 1..月尾。格顯示 record_type=shift/ot 時用
// shift_type.code，record_type=leave 時用 leave_code。
//
// 儲存＝一次過送 POST /api/shift-records/batch（樂觀 UI＋失敗回滾，唔逐格
// 即時打 API）——見 src/app/api/shift-records/batch/route.ts 頂註解。
"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet, apiGetAll, apiPost, ApiClientError } from "@/lib/api-client";
import { Notice } from "@/components/ui/Notice";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
// P2 整合驗收①：麵包屑／手機頁首「‹」呢兩條連結改用 `GuardedLink`——
// 未儲存改動時撳落去要經 `unsaved-guard` store 問一句先跳（下面
// `handleMobileBack` 舊有嘅本地 `window.confirm` 版本刪咗，改用同一個
// store，唔再自己維護一份）。冇未儲存改動風險嘅連結（冇權限／鎖定月份
// 提示條嗰啲）照舊用普通 `Link` 就夠。
import { GuardedLink } from "@/components/ui/GuardedLink";
import { confirmLeaveIfUnsaved, setUnsavedCount } from "@/lib/ui/unsaved-guard";

// ---------------------------------------------------------------------------
// 型別（wire format，一律 snake_case，同 request/response body 一致——見
// docs/api.md「欄位命名」；淨係列出呢個畫面用得到嘅欄）。

type RecordStatus = "draft" | "pending_approval" | "confirmed" | "completed" | "cancelled";
type RecordType = "shift" | "leave" | "ot";

type SiteDto = {
  id: string;
  canonical_name: string;
  status: string;
  // 淨係內部角色 DTO（toSiteDTO）先有呢個欄，雞頭 DTO（toBrokerSiteDTO）
  // 冇——用嚟判斷而家呢個 session 係咪雞頭（畫面要剝走「雞頭」欄同啲
  // 內部專用操作）。
  created_by?: string;
  // Opus 對抗式驗收第二輪 R3：呢個盤有冇 roster_layout 模板——冇就
  // GET roster-export 會 409 no_roster_layout，匯出掣要顯示提示
  // 唔可以照樣當連結掣使（見底下匯出按鈕嗰段）。
  has_roster_layout?: boolean;
};

type ShiftTypeDto = {
  id: string;
  site_id: string;
  code: string;
  label: string;
  headcount_required?: number;
  voided_at: string | null;
};

type GuardDto = {
  id: string;
  staff_no: string | null;
  name_zh: string;
  tel: string | null;
  default_broker_id: string | null;
  sia_permit_expiry: string | null;
  status: string;
};

type ShiftRecordDto = {
  id: string;
  work_date: string;
  site_id: string;
  shift_type_id: string;
  guard_id: string;
  settlement_broker_id: string | null;
  operational_broker_id: string | null;
  record_type: RecordType;
  leave_code: string | null;
  status: RecordStatus;
};

type DailyRequirementDto = {
  id: string;
  site_id: string;
  shift_type_id: string;
  work_date: string;
  headcount_required: number;
};

type QuotaDto = {
  id: string;
  month: string;
  site_id: string;
  shift_type_id: string;
  broker_id: string;
  target_shifts: number;
};

type MonthCloseDto = {
  id: string;
  month: string;
  locked_at: string | null;
};

type BrokerDto = {
  id: string;
  code: string;
  name: string;
};

type BatchResponse = { results: { key: string; id: string; action: string }[]; warnings: string[] };

// P1-WP3 第三輪規劃裁定（point B(4)）：同步 `prisma/schema.prisma` 嘅
// `LeaveCode` enum（已經由 `tools/importer/mappings/status_codes.csv`
// 擴充咗保留原始字面嘅 OFF/NPL，見 schema 頂註解）。
const LEAVE_CODES: readonly string[] = ["RD", "OFF", "AL", "SL", "NL", "NPL", "SH"];
// WP-R2 第 8 項：手機鍵盤唔出 OFF／NPL——呢兩個係歷史保留代號（schema
// 註解：OFF＝RD、NPL＝NL），batch API 照舊接受（`LEAVE_CODES` 冇改，舊
// 資料／桌面打字都照樣得），淨係手機鍵盤按鍵收窄做實際會用嘅代號。
const MOBILE_KEYPAD_LEAVE_CODES: readonly string[] = LEAVE_CODES.filter((c) => c !== "OFF" && c !== "NPL");

type CellState = {
  code: string | null;
  id: string | null;
  status: RecordStatus | null;
  recordType: RecordType | null;
};

type RowMeta = {
  key: string; // `${shiftTypeId}|${guardId}`
  shiftTypeId: string;
  guardId: string;
  shiftTypeCode: string;
  guardName: string;
  staffNo: string;
  tel: string;
  brokerId: string | null;
};

type SelRange = { a: { r: number; d: number }; b: { r: number; d: number } };

// ---------------------------------------------------------------------------
// 純函數 helper（日期計算全部用 UTC，避免時區令「幾號」跳日）。

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseMonthStr(month: string): { year: number; monthNum: number } {
  const [y, m] = month.split("-").map(Number);
  return { year: y, monthNum: m };
}

function daysInMonth(year: number, monthNum: number): number {
  return new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
}

function dayOfMonthFromIso(iso: string): number {
  return new Date(iso).getUTCDate();
}

function prevMonthStr(month: string): string {
  const { year, monthNum } = parseMonthStr(month);
  const pm = monthNum === 1 ? 12 : monthNum - 1;
  const py = monthNum === 1 ? year - 1 : year;
  return `${py}-${pad2(pm)}`;
}

// WP-R2：月份 chip「‹ › 」撳＝跳去上／下月（README §04）。
function nextMonthStr(month: string): string {
  const { year, monthNum } = parseMonthStr(month);
  const nm = monthNum === 12 ? 1 : monthNum + 1;
  const ny = monthNum === 12 ? year + 1 : year;
  return `${ny}-${pad2(nm)}`;
}

// WP-R2：今日（香港時間）高亮用——同 src/lib/ai/system-prompt.ts
// `hongKongToday()` 一樣做法（伺服器/瀏覽器一律用 Asia/Hong_Kong，唔靠
// 本機時區）。淨係喺 `loading` 完咗先會 render 到用得着呢個值嘅格仔表，
// 所以唔會有 SSR/CSR 唔同日先後 render 撞第日嘅 hydration mismatch 風險。
function hongKongTodayYMD(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

type DayMeta = {
  weekday: string;
  isWeekend: boolean;
  isToday: boolean;
  headerBg: string;
  weekdayColor: string;
  dayColor: string;
  /** 資料格底色（今日／週末），`undefined` = 平日（透明，跟返行 hover 底）。 */
  colBg?: string;
};

function dayMeta(y: number, m: number, day: number, today: { y: number; m: number; d: number } | null): DayMeta {
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  const isWeekend = wd === 0 || wd === 6;
  const isToday = !!today && today.y === y && today.m === m && today.d === day;
  return {
    weekday: WEEKDAY_LABELS[wd],
    isWeekend,
    isToday,
    headerBg: isToday ? "#dbeafe" : isWeekend ? "#f1f5f9" : "#fafbfc",
    weekdayColor: isToday ? "#2563eb" : "#94a3b8",
    dayColor: isToday ? "#1d4ed8" : isWeekend ? "#64748b" : "#0f172a",
    colBg: isToday ? "#eff6ff" : isWeekend ? "#f8fafc" : undefined,
  };
}

// WP-R2：底部合計行「已排」數配色（README §04：≥所需 綠；<所需 但
// ≥所需×0.55 中性；否則紅；冇所需設定＝中性）。
function coverageColor(count: number, required: number): string {
  if (!required || required <= 0) return "#334155";
  if (count >= required) return "#0f766e";
  if (count >= required * 0.55) return "#334155";
  return "#dc2626";
}

function workDateStr(year: number, monthNum: number, day: number): string {
  return `${year}-${pad2(monthNum)}-${pad2(day)}`;
}

function cellKeyOf(rowKey: string, day: number): string {
  return `${rowKey}#${day}`;
}

function normalizeCode(text: string | null | undefined): string | null {
  if (text == null) return null;
  const t = text.trim().toUpperCase();
  return t === "" ? null : t;
}

function cellsEqual(a: CellState | undefined, b: CellState | undefined): boolean {
  return (a?.code ?? null) === (b?.code ?? null);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function buildRowsAndCells(
  records: ShiftRecordDto[],
  shiftTypesById: Map<string, ShiftTypeDto>,
  guardsById: Map<string, GuardDto>,
): { rows: RowMeta[]; cells: Map<string, CellState> } {
  const rowsMap = new Map<string, RowMeta>();
  const cellsMap = new Map<string, CellState>();

  for (const r of records) {
    const day = dayOfMonthFromIso(r.work_date);
    const rowKey = `${r.shift_type_id}|${r.guard_id}`;
    const st = shiftTypesById.get(r.shift_type_id);
    const code = r.record_type === "shift" || r.record_type === "ot" ? (st?.code ?? "?") : (r.leave_code ?? "?");
    cellsMap.set(cellKeyOf(rowKey, day), { code, id: r.id, status: r.status, recordType: r.record_type });

    if (!rowsMap.has(rowKey)) {
      const guard = guardsById.get(r.guard_id);
      rowsMap.set(rowKey, {
        key: rowKey,
        shiftTypeId: r.shift_type_id,
        guardId: r.guard_id,
        shiftTypeCode: st?.code ?? "?",
        guardName: guard?.name_zh ?? "",
        staffNo: guard?.staff_no ?? "",
        tel: guard?.tel ?? "",
        brokerId: r.settlement_broker_id ?? guard?.default_broker_id ?? null,
      });
    }
  }

  const rows = [...rowsMap.values()].sort(
    (a, b) => a.shiftTypeCode.localeCompare(b.shiftTypeCode) || a.guardName.localeCompare(b.guardName),
  );
  return { rows, cells: cellsMap };
}

function isEffectiveShiftCell(row: RowMeta, day: number, cells: Map<string, CellState>, baseline: Map<string, CellState>): boolean {
  const key = cellKeyOf(row.key, day);
  const c = cells.get(key);
  if (!c || !c.code || c.code !== row.shiftTypeCode) return false;
  const dirty = !cellsEqual(baseline.get(key), c);
  // 本地新填／改嘅格，batch API 一律寫 record_type=shift（清格/正更代號
  // 先會送出去，見 batch route 頂註解）；未改過嘅格跟返 baseline 本身嘅
  // record_type（可能係 shift 或 ot——ot 唔計落 Total，同
  // scripts/report/roster.ts 口徑一致）。
  const effectiveType = dirty ? "shift" : c.recordType;
  return effectiveType === "shift";
}

// 左邊固定欄寬度（px，WP-R2 按 README §04/§23 重新分配）——用嚟計 sticky
// 欄嘅 left offset。
// 桌面（≥1024，非 compact）：更別 44 + 姓名/工號（彈性）+ 雞頭 70 = 300 總闊。
const DESK_COL_SHIFT_TYPE = 44;
const DESK_COL_BROKER = 70;
const DESK_FIXED_TOTAL = 300;
const DESK_COL_DAY = 34;
// 手機（compact，<640）：單一「姓名」固定欄 118px（連工號／雞頭代號都收
// 埋落姓名格下行，冇獨立更別／工號／雞頭欄——跟 README §23 手機原型
// 1:1，見 P2-版面重設計計劃.md §2「手機更別鍵盤」判斷附近段落）。
const MOBILE_COL_NAME = 118;
const MOBILE_COL_DAY = 44;
// 2026-09-12 老闆 feedback：更表唔顯示安員電話（聯絡資料只喺安員名冊，按 安員:view 權限）；Excel 匯出照原檔格式保留，`RowMeta.tel` 仍然保留但呢頁唔顯示。

// WP-R2 第 9 項：手機底部更別鍵盤實際高度（約），等表格捲動區留返
// padding-bottom，撳近底部嘅格先唔會俾鍵盤遮住。
const MOBILE_KEYPAD_HEIGHT = 143;

// WP-R2 第 13 項：格仔（`<td>` 一格代表一日一行）抽做獨立 `memo` 元件，
// props 淨係傳原始值（string/number/boolean）同穩定嘅 callback（useCallback
// 過），等其他格改動（例如揀第二格）唔使成個表重新 render 每一粒格。
type DayCellProps = {
  r: number;
  d: number;
  rowKey: string;
  code: string | null;
  isDirty: boolean;
  selected: boolean;
  inRange: boolean;
  isError: boolean;
  chipBg: string;
  chipFg: string;
  chipBorder: string | undefined;
  monthLocked: boolean;
  compact: boolean;
  dayColW: number;
  rowH: number;
  colBg: string | undefined;
  isToday: boolean;
  isWeekend: boolean;
  isEditingHere: boolean;
  editText: string;
  /** P2 整合驗收應修②：compact 實體鍵盤打緊嘅未完成代號（唔開 inline
   * input，淨係細字顯示緊喺格入面），`undefined`＝呢格冇打緊。 */
  keyBufferText: string | undefined;
  title: string | undefined;
  onCellMouseDown: (r: number, d: number, e: { shiftKey: boolean }) => void;
  onCellMouseEnter: (r: number, d: number) => void;
  onCellClick: (r: number, d: number, shiftKey: boolean) => void;
  onCellDoubleClick: (r: number, d: number) => void;
  onContextMenu: (r: number, d: number, x: number, y: number) => void;
  onEditTextChange: (v: string) => void;
  onCommitEdit: () => void;
};

const DayCell = memo(function DayCell(props: DayCellProps) {
  const {
    r,
    d,
    code,
    isDirty,
    selected,
    inRange,
    isError,
    chipBg,
    chipFg,
    chipBorder,
    monthLocked,
    compact,
    dayColW,
    rowH,
    colBg,
    isToday,
    isWeekend,
    isEditingHere,
    editText,
    keyBufferText,
    title,
    onCellMouseDown,
    onCellMouseEnter,
    onCellClick,
    onCellDoubleClick,
    onContextMenu,
    onEditTextChange,
    onCommitEdit,
  } = props;
  const tdBg = isError ? "#fecaca" : colBg;
  // 三層可以同時出現、唔會互撞：選中＝outline（藍）；dirty＝inset ring
  // box-shadow（琥珀色 #f59e0b）；draft／請假＝chip 自己嘅 border（喺
  // chip span 層，唔喺呢度，draft 虛線藍／請假虛線橙）。
  //
  // P2 整合驗收應修①：dirty ring 原本同「選中」outline 一樣用
  // `#2563eb`（藍），兩層又同色又貼埋，肉眼分唔清邊個係邊個；而且藍色
  // 又同 draft 嘅虛線藍撞。改做琥珀色 `#f59e0b`（同「請假」chip 嘅虛線
  // 橙同色系但唔同形狀——請假係內層 chip 嘅虛線細框，dirty 係成格嘅實
  // 線 inset ring，唔會混淆），令「呢格未儲存」呢個狀態同「呢格揀緊」
  // 完全用唔同顏色，一眼分得出。
  const shadows: string[] = [];
  if (isDirty) shadows.push("inset 0 0 0 2px #f59e0b");
  if (inRange && !selected) shadows.push("inset 0 0 0 9999px rgba(37,99,235,.08)");
  return (
    <td
      className={`text-center align-middle cursor-cell ${monthLocked ? "cursor-not-allowed" : ""}`}
      style={{
        width: dayColW,
        height: rowH,
        background: tdBg,
        outline: selected ? "2px solid #2563eb" : undefined,
        outlineOffset: selected ? -2 : undefined,
        boxShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
      }}
      title={title}
      data-testid={`roster-cell-${r}-${d}`}
      data-dirty={isDirty || undefined}
      data-today={isToday || undefined}
      data-weekend={isWeekend || undefined}
      onMouseDown={(e) => onCellMouseDown(r, d, { shiftKey: e.shiftKey })}
      onMouseEnter={() => onCellMouseEnter(r, d)}
      onClick={(e) => onCellClick(r, d, e.shiftKey)}
      onDoubleClick={() => onCellDoubleClick(r, d)}
      onContextMenu={(e) => {
        // P2 整合驗收「可接受 1 順手」：以前 `monthLocked` 就直接 `return`，
        // 冇行到 `preventDefault()`，鎖定月份右鍵會彈瀏覽器原生選單
        // （不一致——未鎖定嗰陣一定唔會見到原生選單）。改做一律先
        // `preventDefault()`，先至判斷鎖定與否決定使唔使開自己個選單。
        e.preventDefault();
        if (monthLocked) return;
        onContextMenu(r, d, e.clientX, e.clientY);
      }}
    >
      {isEditingHere ? (
        <input
          autoFocus
          className="h-full w-full bg-white text-center outline-none"
          value={editText}
          maxLength={4}
          onChange={(e) => onEditTextChange(e.target.value.toUpperCase())}
          onBlur={onCommitEdit}
        />
      ) : keyBufferText ? (
        // P2 整合驗收應修②：打緊未完成嘅多字代號（例如打咗「S」仲等緊
        // 「H」）——細字顯示喺格入面，蓋過原本個 chip（等夠鐘／打夠／
        // Enter 先變返正式 chip）。
        <span data-testid="roster-cell-key-buffer" className="text-[11px] font-semibold text-[#b45309]">
          {keyBufferText}
        </span>
      ) : (
        code && (
          <span
            className="inline-block font-semibold"
            style={{
              fontSize: compact ? 12 : 11,
              minWidth: compact ? 28 : 22,
              padding: compact ? "5px 0" : "3px 0",
              borderRadius: compact ? 6 : 5,
              background: chipBg,
              color: chipFg,
              border: chipBorder,
            }}
          >
            {code}
          </span>
        )
      )}
    </td>
  );
});

export default function RosterEditor({ siteId, month }: { siteId: string; month: string }) {
  const router = useRouter();
  const { year, monthNum } = parseMonthStr(month);
  const days = daysInMonth(year, monthNum);
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days]);

  const [loading, setLoading] = useState(true);
  // 2026-09-13 緊急：手機闊度下左邊固定四欄（56+96+88+104=344px）闊過整個容器（~324px），
  // 日期欄永遠被固定欄遮住，捲極都見唔到。compact（<640px）改用窄欄並收起工號／雞頭欄。
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const [slowLoading, setSlowLoading] = useState(false); // 載入超過 15 秒 → 顯示重試掣（安全網）
  useEffect(() => {
    if (!loading) { setSlowLoading(false); return; }
    const t = setTimeout(() => setSlowLoading(true), 15_000);
    return () => clearTimeout(t);
  }, [loading]);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isBrokerSession, setIsBrokerSession] = useState(false);
  const [siteName, setSiteName] = useState("");
  // Opus 對抗式驗收第二輪 R3：冇 roster_layout 模板嘅盤，匯出掣要顯示
  // 提示（唔准當正常連結用——GET roster-export 而家會 409
  // no_roster_layout）。`undefined`＝仲未載入完（唔顯示提示，避免載入
  // 中間閃一下）。
  const [hasRosterLayout, setHasRosterLayout] = useState<boolean | undefined>(undefined);

  const [shiftTypesById, setShiftTypesById] = useState<Map<string, ShiftTypeDto>>(new Map());
  const [guardsById, setGuardsById] = useState<Map<string, GuardDto>>(new Map());
  const [brokersById, setBrokersById] = useState<Map<string, BrokerDto>>(new Map());

  const [rows, setRows] = useState<RowMeta[]>([]);
  const [extraRows, setExtraRows] = useState<RowMeta[]>([]); // 加安員／複製上月加嘅新行，未儲存前冇 baseline
  const [baseline, setBaseline] = useState<Map<string, CellState>>(new Map());
  const [cells, setCells] = useState<Map<string, CellState>>(new Map());
  // 2026-09-12 老闆 feedback：雞頭篩選＋人數/更數統計條——保留原始
  // ShiftRecordDto 陣列（唔淨係聚合完嘅 rows/cells），俾統計條逐日/逐
  // 狀態計數（confirmed／pending 分開計）。
  const [records, setRecords] = useState<ShiftRecordDto[]>([]);

  const [dailyReq, setDailyReq] = useState<number[]>([]); // index0 = day1
  const [quotas, setQuotas] = useState<QuotaDto[]>([]);
  const [monthLocked, setMonthLocked] = useState(false);

  // 雞頭篩選（老闆 feedback 2026-09-12）：揀住嘅雞頭代號（例如 "K"），
  // `null` = 全部。狀態放 URL query `?broker=K`（方便分享／重載保留）；
  // 淨係內部角色顯示篩選器（雞頭 session 本身淨見自己，冇篩選必要）。
  // 用 code（唔係內部 uuid）做 URL 值——同老闆講嘅「雞頭代號」一致。
  const [selectedBrokerCode, setSelectedBrokerCode] = useState<string | null>(null);
  const urlSyncedFromLoadRef = useRef(false);

  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [errorCellKey, setErrorCellKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // WP-R2：儲存成功 toast（README §04「儲存後 Toast」）——右下深色 toast，
  // 3 秒後自動消失。
  const [showSaveToast, setShowSaveToast] = useState(false);
  useEffect(() => {
    if (!showSaveToast) return;
    const t = setTimeout(() => setShowSaveToast(false), 3000);
    return () => clearTimeout(t);
  }, [showSaveToast]);
  const skipExtraRowsResetRef = useRef(false);

  // 選格／編輯
  const [sel, setSel] = useState<SelRange | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  // WP-R2 第 4 項：拖選多格後打字，inline input 要開喺「錨點」格（拖選
  // 起手嗰格，即 sel.a）——`sel` 本身喺編輯期間保持成個範圍唔變（等
  // commit 嗰下識寫晒成個範圍），淨係呢個 `editAnchor` 話畀 render 知
  // input 要畫喺邊格。
  const [editAnchor, setEditAnchor] = useState<{ r: number; d: number } | null>(null);

  // 拖曳填充（純前端 state：mousedown 嘅格個 code 複製去拖到嘅範圍；高亮
  // 顯示借用選格 `sel` 本身——mouseenter 會不斷更新 `sel.b`，唔使額外
  // state）。
  const draggingRef = useRef(false);
  const dragSourceRef = useRef<{ r: number; d: number; code: string | null } | null>(null);
  const dragCurrentRef = useRef<{ r: number; d: number } | null>(null);

  // 加安員 modal
  const [showAddGuard, setShowAddGuard] = useState(false);
  const [addGuardId, setAddGuardId] = useState("");
  const [addShiftTypeId, setAddShiftTypeId] = useState("");

  // 整行填
  const [fillRowKey, setFillRowKey] = useState<string | null>(null);
  const [fillRowValue, setFillRowValue] = useState("");

  // WP-R2 第 4 項：右鍵選單（README Interactions：「右鍵選單：清除／整行
  // 填／整行清」）。`x`/`y` 用 `clientX`/`clientY`（fixed 定位）。
  const [contextMenu, setContextMenu] = useState<{ r: number; d: number; x: number; y: number } | null>(null);
  // WP-R2 第 5 項：手機頁首「⋯」更多選單（README §23 冇畫，但四個動作
  // 「加保安員／複製上月／匯出 Excel／還原」手機唔可以消失）。
  const [showMobileMore, setShowMobileMore] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // allRows＝呢個盤呢個月全部行（已儲存+未儲存新加嘅），唔受雞頭篩選
  // 影響——儲存 diff／複製上月／加安員去重都要睇成個集合，先唔會漏
  // 咗篩選緊冇顯示嗰啲行嘅改動。
  const allRows = useMemo(() => [...rows, ...extraRows], [rows, extraRows]);
  // visibleRows＝畫面實際渲染／鍵盤導覽嗰個集合——揀咗雞頭篩選就淨係
  // 呢個雞頭嘅行；日合計／尚欠照計 allRows（唔受篩選影響，見底下
  // dayTotals），呢個淨係管顯示同「所選雞頭合計」。
  const visibleRows = useMemo(() => {
    if (!selectedBrokerCode) return allRows;
    return allRows.filter((r) => (r.brokerId ? brokersById.get(r.brokerId)?.code : null) === selectedBrokerCode);
  }, [allRows, selectedBrokerCode, brokersById]);
  const displayRowsRef = useRef<RowMeta[]>(visibleRows);
  useEffect(() => {
    displayRowsRef.current = visibleRows;
  }, [visibleRows]);

  // ---- 初次載入／重新 fetch（儲存成功之後都會經呢個 effect 重跑一次）----
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setForbidden(null);
      setLoadError(null);
      if (!skipExtraRowsResetRef.current) setExtraRows([]);
      skipExtraRowsResetRef.current = false;
      try {
        const { year: y, monthNum: m } = parseMonthStr(month);
        const d = daysInMonth(y, m);
        const site = await apiGet<SiteDto>(`/api/sites/${siteId}`);
        if (cancelled) return;
        const brokerSession = !("created_by" in site);
        setIsBrokerSession(brokerSession);
        setSiteName(site.canonical_name);
        setHasRosterLayout(site.has_roster_layout ?? false);

        const workDateFrom = workDateStr(y, m, 1);
        const workDateTo = workDateStr(y, m, d);

        const [shiftTypes, records, guards, dailyRequirements, quotaRows, monthCloses, brokers] = await Promise.all([
          apiGetAll<ShiftTypeDto>("/api/shift-types", { site_id: siteId }),
          apiGetAll<ShiftRecordDto>("/api/shift-records", { site_id: siteId, work_date_from: workDateFrom, work_date_to: workDateTo, view: "grid" }),
          apiGetAll<GuardDto>("/api/guards", {}),
          apiGetAll<DailyRequirementDto>("/api/daily-requirements", { site_id: siteId }),
          apiGetAll<QuotaDto>("/api/quotas", { site_id: siteId, month }),
          apiGetAll<MonthCloseDto>("/api/month-closes", {}),
          apiGetAll<BrokerDto>("/api/brokers", {}),
        ]);
        if (cancelled) return;

        const stMap = new Map(shiftTypes.map((s) => [s.id, s]));
        const gMap = new Map(guards.map((g) => [g.id, g]));
        const bMap = new Map(brokers.map((b) => [b.id, b]));
        setShiftTypesById(stMap);
        setGuardsById(gMap);
        setBrokersById(bMap);

        setRecords(records);
        const built = buildRowsAndCells(records, stMap, gMap);
        setRows(built.rows);
        setBaseline(new Map(built.cells));
        setCells(new Map(built.cells));
        setExtraRows((prev) => prev.filter((er) => !built.rows.some((r) => r.key === er.key)));

        const reqByDay = new Array(d).fill(0) as number[];
        for (const req of dailyRequirements) {
          const day = dayOfMonthFromIso(req.work_date);
          if (day >= 1 && day <= d) reqByDay[day - 1] += req.headcount_required;
        }
        setDailyReq(reqByDay);
        setQuotas(quotaRows);

        const locked = monthCloses.some((mc) => mc.month.slice(0, 7) === month && !!mc.locked_at);
        setMonthLocked(locked);

        setWarnings([]);
        setErrorBanner(null);
        setErrorCellKey(null);
        setSel(null);
        setEditing(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && (err.status === 403 || err.status === 404)) {
          setForbidden(err.message || "冇權限或搵唔到呢個盤");
        } else {
          setLoadError(err instanceof Error ? err.message : "讀取資料失敗，請重新整理再試");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [siteId, month, reloadTick]);

  // ---- 雞頭篩選 ←→ URL query `?broker=` 同步 -----------------------------
  // 讀（一次性，載入時攞返 URL 已有嘅 broker 代號，令重載／分享連結保留
  // 篩選狀態）：唔用 next/navigation 嘅 useSearchParams（避免呢個已經
  // "use client" 嘅互動編輯器頁面被迫加 Suspense boundary），純粹讀
  // window.location，同埋淨係喺 client mount 之後先做（避免 SSR
  // hydration mismatch）。
  useEffect(() => {
    if (urlSyncedFromLoadRef.current) return;
    urlSyncedFromLoadRef.current = true;
    const fromUrl = new URLSearchParams(window.location.search).get("broker");
    if (fromUrl) setSelectedBrokerCode(fromUrl);
  }, []);

  // 寫：揀咗（或清咗）雞頭篩選，即刻用 replaceState 更新返 URL query（唔
  // 加入 history stack，唔觸發 Next 導航／重新 fetch）。
  useEffect(() => {
    if (!urlSyncedFromLoadRef.current) return; // 等讀嗰個 effect 行咗先，避免一開波就寫走個原本嘅 URL 值
    const url = new URL(window.location.href);
    if (selectedBrokerCode) url.searchParams.set("broker", selectedBrokerCode);
    else url.searchParams.delete("broker");
    window.history.replaceState(null, "", url.toString());
  }, [selectedBrokerCode]);

  // ---- 選格移動 --------------------------------------------------------
  const moveSelection = useCallback(
    (dr: number, dd: number, extend: boolean) => {
      setSel((prev) => {
        const base = prev?.b ?? { r: 0, d: 1 };
        const nb = { r: clamp(base.r + dr, 0, Math.max(visibleRows.length - 1, 0)), d: clamp(base.d + dd, 1, days) };
        if (extend && prev) return { a: prev.a, b: nb };
        return { a: nb, b: nb };
      });
    },
    [visibleRows.length, days],
  );

  // WP-R2：手機底部更別鍵盤（README §23）——撳鍵直接寫入揀住嗰格，同桌面
  // 打字（commitEdit）用同一種「寫 cells map」方式，淨係唔經 editing/
  // editText 呢條 input 路徑（手機冇實體鍵盤，直接撳掣）。第 11 項：
  // compact 下實體鍵盤單字母打字都經呢條路徑（onKeyDown 直接call），唔
  // 開 inline input。
  const applyMobileKeypadCode = useCallback((row: RowMeta, day: number, rawCode: string | null) => {
    const key = cellKeyOf(row.key, day);
    const code = normalizeCode(rawCode);
    setCells((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      next.set(key, { code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
      return next;
    });
    setErrorCellKey((prev) => (prev === key ? null : prev));
    setSel(null); // 撳完鍵即刻收埋鍵盤（同撳「清除」一樣）
  }, []);

  // P2 整合驗收應修②：compact（<640）實體鍵盤打多字代號（SH／SL／AL／
  // NL／RD）打唔到——原本 `onKeyDown` 逐個 keystroke 即刻 call
  // `applyMobileKeypadCode`（單一字元當成完整代號寫入＋收埋選格），打
  // 「S」就即刻當「S」寫咗，跟住個「H」已經冇 sel 可以再寫。改做喺
  // `keyBuffer` state 度逐個 keystroke 砌住個字串（唔開 `editing` inline
  // input）：
  //   - 而家個 buffer 係「呢行更別代號／請假代號」入面某個代號嘅字首，
  //     而且仲有更長嘅候選（例如「S」係「SH」同「SL」嘅字首）——唔即刻
  //     寫，等最多 500ms 睇下一個 keystroke；
  //   - 否則（啱好等於某個代號但冇更長候選、或者本身就係呢行自己嘅更
  //     別代號、或者乜代號都夾唔到）即刻寫入——呢行自己嘅更別代號通常
  //     淨係一個字母（D／N），就算佢啱好係另一個代號嘅字首（「N」係
  //     「NL」嘅字首）都要即刻寫，唔應該有延遲。
  // Enter＝就住而家個 buffer 即刻寫入；Escape＝取消（唔寫入）。
  const [keyBuffer, setKeyBuffer] = useState<{ r: number; d: number; text: string } | null>(null);
  const keyBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearKeyBufferTimer = useCallback(() => {
    if (keyBufferTimerRef.current) {
      clearTimeout(keyBufferTimerRef.current);
      keyBufferTimerRef.current = null;
    }
  }, []);

  // Unmount 都要清埋個 pending timer，唔可以喺 component 消失咗之後先
  // 觸發（React 18 strict mode／離開頁面都會 unmount）。
  useEffect(() => clearKeyBufferTimer, [clearKeyBufferTimer]);

  const pushKeyBufferChar = useCallback(
    (row: RowMeta, r: number, d: number, char: string) => {
      const base = keyBuffer && keyBuffer.r === r && keyBuffer.d === d ? keyBuffer.text : "";
      const next = (base + char).toUpperCase();
      const candidates = [row.shiftTypeCode, ...MOBILE_KEYPAD_LEAVE_CODES.filter((c) => c !== row.shiftTypeCode)];
      const isRowShiftCode = next === row.shiftTypeCode;
      const hasLongerCandidate = candidates.some((c) => c.length > next.length && c.startsWith(next));
      clearKeyBufferTimer();
      if (isRowShiftCode || !hasLongerCandidate) {
        setKeyBuffer(null);
        applyMobileKeypadCode(row, d, next);
        return;
      }
      setKeyBuffer({ r, d, text: next });
      keyBufferTimerRef.current = setTimeout(() => {
        keyBufferTimerRef.current = null;
        setKeyBuffer(null);
        applyMobileKeypadCode(row, d, next);
      }, 500);
    },
    [keyBuffer, applyMobileKeypadCode, clearKeyBufferTimer],
  );

  const flushKeyBuffer = useCallback(() => {
    if (!keyBuffer) return;
    clearKeyBufferTimer();
    const row = displayRowsRef.current[keyBuffer.r];
    const { d, text } = keyBuffer;
    setKeyBuffer(null);
    if (row) applyMobileKeypadCode(row, d, text);
  }, [keyBuffer, applyMobileKeypadCode, clearKeyBufferTimer]);

  const cancelKeyBuffer = useCallback(() => {
    clearKeyBufferTimer();
    setKeyBuffer(null);
  }, [clearKeyBufferTimer]);

  // 安全網：撳咗第二格（滑鼠／方向鍵）令 `sel` 唔再對住個 buffer 緊嘅
  // 格，就即刻寫低而家個 buffer（唔留低喺背景靜靜哋等 500ms 先寫入一個
  // 已經唔選緊嘅格）。
  useEffect(() => {
    if (!keyBuffer) return;
    if (!sel || sel.b.r !== keyBuffer.r || sel.b.d !== keyBuffer.d) flushKeyBuffer();
  }, [sel, keyBuffer, flushKeyBuffer]);

  // WP-R2 第 4 項：commit 寫入 `sel` 成個範圍（唔淨係 sel.b 嗰格）——拖選
  // 多格之後打字，全部揀咗嘅格都要寫同一個代號。單格編輯（雙擊／單格打
  // 字）嘅 `sel.a===sel.b`，行為同以前一樣。
  const commitEdit = useCallback(() => {
    if (!editing || !sel) return;
    const r0 = Math.min(sel.a.r, sel.b.r);
    const r1 = Math.max(sel.a.r, sel.b.r);
    const d0 = Math.min(sel.a.d, sel.b.d);
    const d1 = Math.max(sel.a.d, sel.b.d);
    const code = normalizeCode(editText);
    const touchedKeys: string[] = [];
    setCells((prev) => {
      const next = new Map(prev);
      for (let r = r0; r <= r1; r++) {
        const row = displayRowsRef.current[r];
        if (!row) continue;
        for (let d = d0; d <= d1; d++) {
          const key = cellKeyOf(row.key, d);
          touchedKeys.push(key);
          const existing = next.get(key);
          next.set(key, { code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
        }
      }
      return next;
    });
    setEditing(false);
    setEditText("");
    setEditAnchor(null);
    setErrorCellKey((prev) => (prev && touchedKeys.includes(prev) ? null : prev));
  }, [editing, sel, editText]);

  // `opts.keepSelection`：拖選多格後打字（README「拖選多格一齊填」）要
  // 保留成個 `sel` 範圍等 commitEdit 寫晒（唔可以好似以前咁一開始編輯就
  // 摺埋做單格）。compact（手機）冇實體鍵盤 inline input 呢條路徑——第
  // 11 項要求 `editing` 喺 compact 下永遠唔會變 true，早退唔做嘢，打字
  // 由 onKeyDown 直接經 `applyMobileKeypadCode` 寫入。
  const startEdit = useCallback(
    (r: number, d: number, initial: string, opts?: { keepSelection?: boolean }) => {
      if (compact) return;
      if (!opts?.keepSelection) setSel({ a: { r, d }, b: { r, d } });
      setEditAnchor({ r, d });
      setEditing(true);
      setEditText(initial);
    },
    [compact],
  );

  const clearSelectedRange = useCallback(() => {
    if (!sel) return;
    const r0 = Math.min(sel.a.r, sel.b.r);
    const r1 = Math.max(sel.a.r, sel.b.r);
    const d0 = Math.min(sel.a.d, sel.b.d);
    const d1 = Math.max(sel.a.d, sel.b.d);
    setCells((prev) => {
      const next = new Map(prev);
      for (let r = r0; r <= r1; r++) {
        const row = displayRowsRef.current[r];
        if (!row) continue;
        for (let d = d0; d <= d1; d++) {
          const key = cellKeyOf(row.key, d);
          const existing = next.get(key);
          next.set(key, { code: null, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
        }
      }
      return next;
    });
  }, [sel]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (monthLocked) return;
      if (editing) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          commitEdit();
          moveSelection(1, 0, false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          commitEdit();
          moveSelection(0, e.shiftKey ? -1 : 1, false);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
          setEditText("");
          setEditAnchor(null);
        } else {
          // 打緊字入格入面（可能仲有其他鍵，例如純粹字元）——唔畀個
          // keydown 走漏去 layout／外層嘅全局快捷鍵（例如側欄），淨係
          // input 嘅 onChange 自己處理個值就夠。
          e.stopPropagation();
        }
        return;
      }
      if (!sel) return;
      // P2 整合驗收應修②：compact 實體鍵盤 buffer——Enter＝就住而家個
      // buffer 即刻寫入（唔好似平時 Enter 咁移去下一格）；Escape＝取消
      // 個 buffer（唔寫入）。冇 buffer 就冇呢兩個特例，行返落面一般嘅
      // switch（Enter＝移去下一格，等等）。
      if (compact && keyBuffer) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          flushKeyBuffer();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelKeyBuffer();
          return;
        }
      }
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(-1, 0, e.shiftKey);
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(1, 0, e.shiftKey);
          break;
        case "ArrowLeft":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(0, -1, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(0, 1, e.shiftKey);
          break;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(0, e.shiftKey ? -1 : 1, false);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          moveSelection(1, 0, false);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          e.stopPropagation();
          clearSelectedRange();
          break;
        default:
          // WP-R2 第 4 項：拖選多格之後打字要一齊填（唔再要求
          // sel.a===sel.b）；第 11 項：compact 冇 inline input，單字母
          // 直接經 applyMobileKeypadCode 寫入嗰格（同手機鍵盤按鍵一樣
          // 路徑），唔開 editing。
          if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            if (compact) {
              const row = displayRowsRef.current[sel.b.r];
              if (row) pushKeyBufferChar(row, sel.b.r, sel.b.d, e.key);
            } else {
              startEdit(sel.a.r, sel.a.d, e.key, { keepSelection: true });
            }
          }
      }
    },
    [monthLocked, editing, sel, compact, keyBuffer, commitEdit, moveSelection, clearSelectedRange, startEdit, pushKeyBufferChar, flushKeyBuffer, cancelKeyBuffer],
  );

  const onCellClick = useCallback(
    (r: number, d: number, shiftKey: boolean) => {
      if (monthLocked) return;
      if (editing) commitEdit();
      setSel((prev) => (shiftKey && prev ? { a: prev.a, b: { r, d } } : { a: { r, d }, b: { r, d } }));
      containerRef.current?.focus({ preventScroll: true }); // 2026-09-12：統計條令容器可能半出視窗，focus() 會捲動頁面，令 mousedown→mouseup 落喺唔同格（拖選成兩行、click 唔觸發）
    },
    [monthLocked, editing, commitEdit],
  );

  const onCellDoubleClick = useCallback(
    (r: number, d: number) => {
      // WP-R2：手機（compact）冇實體鍵盤，撳格改用底部更別鍵盤（見
      // `applyMobileKeypadCode`），唔經呢條 inline <input> 編輯路徑——
      // 雙擊/雙撳一律當普通揀格。
      if (monthLocked || compact) return;
      const row = visibleRows[r];
      if (!row) return;
      const current = cells.get(cellKeyOf(row.key, d))?.code ?? "";
      startEdit(r, d, current);
    },
    [monthLocked, compact, visibleRows, cells, startEdit],
  );

  // ---- 拖曳填充（純前端 state，mousedown 個格個 code 複製去拖到嘅範圍）----
  const onCellMouseDown = useCallback(
    (r: number, d: number, e: { shiftKey: boolean }) => {
      if (monthLocked || e.shiftKey) return;
      if (editing) commitEdit();
      const row = visibleRows[r];
      const code = row ? cells.get(cellKeyOf(row.key, d))?.code ?? null : null;
      setSel({ a: { r, d }, b: { r, d } });
      draggingRef.current = true;
      dragSourceRef.current = { r, d, code };
      dragCurrentRef.current = { r, d };
      containerRef.current?.focus({ preventScroll: true }); // 2026-09-12：統計條令容器可能半出視窗，focus() 會捲動頁面，令 mousedown→mouseup 落喺唔同格（拖選成兩行、click 唔觸發）
      // WP-R2 第 9 項：手機撳格開底部鍵盤，格仔要滾去畫面中間，唔可以俾
      // fixed 喺底嘅鍵盤遮住。特登放喺 mousedown（唔喺 onClick）——
      // `sel` 一改，`mobileKeypadRow`／容器 max-height 已經即刻（同一個
      // React 批次）變，如果撳呢下再等個 click 事件，個 click 隨時因為
      // 容器已經摺埋一截、格仔喺 mousedown→mouseup 之間走咗位而唔觸發
      // （同上面 2026-09-12 果個 comment 講嘅一樣問題）。Mousedown 一定
      // 會準確咁接住呢粒 r/d（撳落嗰下都仲未移位），唔使靠個 click。
      if (compact) {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          const el = container?.querySelector<HTMLElement>(`[data-testid="roster-cell-${r}-${d}"]`);
          if (!container || !el) return;
          el.scrollIntoView({ block: "nearest", inline: "center" });
          // `scrollIntoView` 唔知道底部仲有一個 fixed 嘅更別鍵盤（唔屬於
          // 文件流，唔會計落 container 嘅可視高度入面）——鍵盤開咗之後
          // container 本身 max-height 已經縮咗（見下面表格容器嗰段
          // style），但如果個格喺 scrollIntoView 嗰下都仲未完全入返嗰個
          // （已經縮咗嘅）範圍，呢度再手動較正多一次。
          const cellRect = el.getBoundingClientRect();
          const keypadTop = window.innerHeight - MOBILE_KEYPAD_HEIGHT;
          const overlap = cellRect.bottom - keypadTop;
          if (overlap > 0) container.scrollTop += overlap + 8;
        });
      }
    },
    [monthLocked, editing, commitEdit, visibleRows, cells, compact],
  );

  const onCellMouseEnter = useCallback((r: number, d: number) => {
    if (!draggingRef.current) return;
    dragCurrentRef.current = { r, d };
    setSel((prev) => (prev ? { a: prev.a, b: { r, d } } : prev));
  }, []);

  useEffect(() => {
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const src = dragSourceRef.current;
      const cur = dragCurrentRef.current;
      dragSourceRef.current = null;
      dragCurrentRef.current = null;
      if (!src || !cur || (src.r === cur.r && src.d === cur.d)) return;
      const r0 = Math.min(src.r, cur.r);
      const r1 = Math.max(src.r, cur.r);
      const d0 = Math.min(src.d, cur.d);
      const d1 = Math.max(src.d, cur.d);
      setCells((prev) => {
        const next = new Map(prev);
        for (let r = r0; r <= r1; r++) {
          const row = displayRowsRef.current[r];
          if (!row) continue;
          for (let d = d0; d <= d1; d++) {
            const key = cellKeyOf(row.key, d);
            const existing = next.get(key);
            next.set(key, { code: src.code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
          }
        }
        return next;
      });
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // ---- 整行填：揀代號，一鍵填晒成行（成個月全部日）----------------------
  // WP-R2 第 4 項：「整行清」＝呢個 function 入面 rawCode 打空／清咗嘅
  // path——唔使揀代號都得，成個月 `days` 日全部清做 null（右鍵選單
  // 「整行清」直接 call `applyFillRow(row, "")`；桌面「整行」modal 個
  // input 留空撳「填滿全行」都係同一效果）。
  const applyFillRow = useCallback(
    (row: RowMeta, rawCode: string) => {
      const code = normalizeCode(rawCode);
      if (code === null) {
        setCells((prev) => {
          const next = new Map(prev);
          for (let d = 1; d <= days; d++) {
            const key = cellKeyOf(row.key, d);
            const existing = next.get(key);
            next.set(key, { code: null, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
          }
          return next;
        });
        setFillRowKey(null);
        setFillRowValue("");
        return;
      }
      const allowed = code === row.shiftTypeCode || LEAVE_CODES.includes(code);
      if (!allowed) {
        setErrorBanner(`「${code}」唔係呢行（更別 ${row.shiftTypeCode}）嘅更別代號，都唔係請假代號（AL/NL/RD/SL/SH）`);
        return;
      }
      setCells((prev) => {
        const next = new Map(prev);
        for (let d = 1; d <= days; d++) {
          const key = cellKeyOf(row.key, d);
          const existing = next.get(key);
          next.set(key, { code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
        }
        return next;
      });
      setFillRowKey(null);
      setFillRowValue("");
    },
    [days],
  );

  // ---- 複製上月（同盤同人）----------------------------------------------
  const handleCopyPrevMonth = useCallback(async () => {
    if (monthLocked) return;
    setErrorBanner(null);
    try {
      const pm = prevMonthStr(month);
      const { year: py, monthNum: pm2 } = parseMonthStr(pm);
      const pDays = daysInMonth(py, pm2);
      const prevRecords = await apiGetAll<ShiftRecordDto>("/api/shift-records", {
        site_id: siteId,
        work_date_from: workDateStr(py, pm2, 1),
        work_date_to: workDateStr(py, pm2, pDays),
      });
      if (prevRecords.length === 0) {
        setErrorBanner(`上個月（${pm}）搵唔到呢個盤嘅更表記錄，冇嘢可以複製`);
        return;
      }
      const knownKeys = new Set(allRows.map((r) => r.key));
      const nextCells = new Map(cells);
      const newExtra: RowMeta[] = [];
      for (const r of prevRecords) {
        const day = dayOfMonthFromIso(r.work_date);
        if (day > days) continue; // 今個月冇呢個日數（例如上月31號、今個月得30日）——跳過
        const rowKey = `${r.shift_type_id}|${r.guard_id}`;
        const st = shiftTypesById.get(r.shift_type_id);
        const code = r.record_type === "shift" || r.record_type === "ot" ? st?.code ?? null : r.leave_code;
        if (!code) continue;
        if (!knownKeys.has(rowKey)) {
          const guard = guardsById.get(r.guard_id);
          newExtra.push({
            key: rowKey,
            shiftTypeId: r.shift_type_id,
            guardId: r.guard_id,
            shiftTypeCode: st?.code ?? "?",
            guardName: guard?.name_zh ?? "",
            staffNo: guard?.staff_no ?? "",
            tel: guard?.tel ?? "",
            brokerId: r.settlement_broker_id ?? guard?.default_broker_id ?? null,
          });
          knownKeys.add(rowKey);
        }
        const key = cellKeyOf(rowKey, day);
        const existing = nextCells.get(key);
        nextCells.set(key, { code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
      }
      setCells(nextCells);
      if (newExtra.length > 0) setExtraRows((prev) => [...prev, ...newExtra]);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "複製上月失敗");
    }
  }, [monthLocked, month, siteId, allRows, cells, days, shiftTypesById, guardsById]);

  // ---- 加安員：純前端加一行空行，未填格儲存之前唔會出現喺下次 reload ----
  const guardOptions = useMemo(() => [...guardsById.values()].sort((a, b) => a.name_zh.localeCompare(b.name_zh)), [guardsById]);
  const shiftTypeOptions = useMemo(
    () => [...shiftTypesById.values()].filter((s) => !s.voided_at).sort((a, b) => a.code.localeCompare(b.code)),
    [shiftTypesById],
  );

  const handleAddGuardRow = useCallback(() => {
    if (!addGuardId || !addShiftTypeId) return;
    const rowKey = `${addShiftTypeId}|${addGuardId}`;
    if (allRows.some((r) => r.key === rowKey)) {
      setShowAddGuard(false);
      setAddGuardId("");
      setAddShiftTypeId("");
      return;
    }
    const guard = guardsById.get(addGuardId);
    const st = shiftTypesById.get(addShiftTypeId);
    setExtraRows((prev) => [
      ...prev,
      {
        key: rowKey,
        shiftTypeId: addShiftTypeId,
        guardId: addGuardId,
        shiftTypeCode: st?.code ?? "?",
        guardName: guard?.name_zh ?? "",
        staffNo: guard?.staff_no ?? "",
        tel: guard?.tel ?? "",
        brokerId: guard?.default_broker_id ?? null,
      },
    ]);
    setShowAddGuard(false);
    setAddGuardId("");
    setAddShiftTypeId("");
  }, [addGuardId, addShiftTypeId, allRows, guardsById, shiftTypesById]);

  // ---- 儲存：淨係送真係改過嘅格 --------------------------------------
  const handleSave = useCallback(async () => {
    if (monthLocked || saving) return;
    setErrorBanner(null);
    setErrorCellKey(null);

    // 用 allRows（唔係篩選緊嘅 visibleRows）——揀咗雞頭篩選之後，其他
    // 雞頭嘅行雖然而家冇顯示，但如果之前已經有改動（例如清咗篩選前打
    // 落嘅格）都要照送出去，唔可以因為篩選漏咗（篩選只影響顯示）。
    const rowByKey = new Map(allRows.map((r) => [r.key, r]));
    const keys = new Set<string>([...baseline.keys(), ...cells.keys()]);
    const diffCells: { guard_id: string; shift_type_id: string; work_date: string; code: string | null }[] = [];
    const invalidMsgs: string[] = [];

    for (const key of keys) {
      const b = baseline.get(key);
      const c = cells.get(key);
      if (cellsEqual(b, c)) continue;
      const hashIdx = key.lastIndexOf("#");
      const rowKey = key.slice(0, hashIdx);
      const day = Number(key.slice(hashIdx + 1));
      const row = rowByKey.get(rowKey);
      if (!row) continue;
      const code = c?.code ?? null;
      if (code !== null) {
        const allowed = code === row.shiftTypeCode || LEAVE_CODES.includes(code);
        if (!allowed) {
          invalidMsgs.push(`${row.guardName || row.guardId}（更別 ${row.shiftTypeCode}）第 ${day} 日輸入「${code}」——同呢行嘅更別代號／請假代號（AL/NL/RD/SL/SH）都對唔上`);
          continue;
        }
      }
      diffCells.push({ guard_id: row.guardId, shift_type_id: row.shiftTypeId, work_date: workDateStr(year, monthNum, day), code });
    }

    if (invalidMsgs.length > 0) {
      setErrorBanner(`輸入有錯，未送出（請改正再儲存）：\n${invalidMsgs.join("\n")}`);
      return;
    }
    if (diffCells.length === 0) {
      setErrorBanner("冇改動，唔使儲存");
      return;
    }

    setSaving(true);
    try {
      const res = await apiPost<BatchResponse>("/api/shift-records/batch", { site_id: siteId, month, cells: diffCells });
      setWarnings(res.warnings ?? []);
      skipExtraRowsResetRef.current = true;
      setReloadTick((t) => t + 1);
      setShowSaveToast(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorBanner(err.message);
        const m = err.message.match(/([0-9a-fA-F-]{8,})\|(\d{4}-\d{2}-\d{2})\|([0-9a-fA-F-]{8,})/);
        if (m) {
          const [, guardIdPart, dateStr, shiftTypeIdPart] = m;
          const rowKey = `${shiftTypeIdPart}|${guardIdPart}`;
          setErrorCellKey(cellKeyOf(rowKey, Number(dateStr.slice(8, 10))));
        }
      } else {
        setErrorBanner(err instanceof Error ? err.message : "儲存失敗");
      }
    } finally {
      setSaving(false);
    }
  }, [monthLocked, saving, allRows, baseline, cells, siteId, month, year, monthNum]);

  const handleRevert = useCallback(() => {
    setCells(new Map(baseline));
    setExtraRows([]);
    setErrorBanner(null);
    setErrorCellKey(null);
    setEditing(false);
  }, [baseline]);


  // ---- 底部合計 ----------------------------------------------------------
  // Total／尚欠一律計 allRows（老闆 feedback 2026-09-12：呢兩行「照計
  // 全部（唔受篩選影響）」），淨係「所選雞頭合計」先睇 visibleRows。
  const dayTotals = useMemo(() => {
    const totals = new Array(days).fill(0) as number[];
    for (const row of allRows) {
      for (let d = 1; d <= days; d++) {
        if (isEffectiveShiftCell(row, d, cells, baseline)) totals[d - 1]++;
      }
    }
    return totals;
  }, [allRows, cells, baseline, days]);

  // 所選雞頭合計（`null` = 揀咗「全部」，唔顯示呢行）——同 dayTotals
  // 一樣嘅口徑，淨係範圍收窄做 visibleRows（已經篩選咗嘅集合）。
  const selectedBrokerTotals = useMemo(() => {
    if (!selectedBrokerCode) return null;
    const totals = new Array(days).fill(0) as number[];
    for (const row of visibleRows) {
      for (let d = 1; d <= days; d++) {
        if (isEffectiveShiftCell(row, d, cells, baseline)) totals[d - 1]++;
      }
    }
    return totals;
  }, [selectedBrokerCode, visibleRows, cells, baseline, days]);

  const dirtyCount = useMemo(() => {
    let n = 0;
    const keys = new Set<string>([...baseline.keys(), ...cells.keys()]);
    for (const key of keys) if (!cellsEqual(baseline.get(key), cells.get(key))) n++;
    return n;
  }, [baseline, cells]);

  // P2 整合驗收①：`dirtyCount` 變化就同步落 `unsaved-guard` module-level
  // store——全站 nav 連結（`GuardedLink`，DesktopNav／MobileNav／呢頁麵包
  // 屑／手機「‹」）撳落去之前會讀呢個 store 決定使唔使 confirm。unmount
  // （離開呢個編輯器頁）要歸零，唔留低舊數值影響第二頁嘅連結。
  useEffect(() => {
    setUnsavedCount(dirtyCount);
    return () => setUnsavedCount(0);
  }, [dirtyCount]);

  // WP-R2 第 3 項：頁首月份 chip「‹ › 」（README §04）——跳去上／下月嘅
  // roster route，帶埋而家嘅 broker 篩選（如果有揀）。有未儲存改動要
  // confirm，取消就唔跳（Opus 驗收：「dirty 時撳下月 confirm 取消唔
  // 跳」）。P2 整合驗收①：改用 `confirmLeaveIfUnsaved()`（讀返上面同步
  // 落 store 嘅 `dirtyCount`），同 `GuardedLink` 用同一份邏輯／同一句
  // 提示字，唔再自己組一次 `window.confirm` 字串。
  const goMonth = useCallback(
    (targetMonth: string) => {
      if (!confirmLeaveIfUnsaved()) return;
      const url = new URL(`/roster/${siteId}/${targetMonth}`, window.location.origin);
      if (selectedBrokerCode) url.searchParams.set("broker", selectedBrokerCode);
      router.push(url.pathname + url.search);
    },
    [router, siteId, selectedBrokerCode],
  );

  // WP-R2 第 3 項：離開（跳月／關頁）有未儲存改動要提示——`beforeunload`
  // 擋得到整頁關閉／重新整理；App 內部導航（goMonth／手機返回）另外用
  // `window.confirm` 攔（見底下 goMonth 同手機頁首「‹」）。
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCount]);

  // WP-R2 第 13 項：今日（香港時間）＋逐日 dayMeta 淨係按 y/m/today 計一
  // 次（唔係每格 render 都重新計一次 `Intl.DateTimeFormat`／`Date`）。
  const today = useMemo(() => hongKongTodayYMD(), []);
  const dayMetaList = useMemo(
    () => dayList.map((d) => dayMeta(year, monthNum, d, today)),
    [dayList, year, monthNum, today],
  );

  // WP-R2 第 4 項：右鍵選單——揀咗嘅格唔喺撳右鍵嗰格範圍入面，就將選格
  // 收窄做單一嗰格（同 Excel 一致嘅行為）；已經揀晒個範圍入面就保留成個
  // 範圍（等「清除所選」可以一次清晒）。鎖定月份唔開（DayCell 本身
  // onContextMenu 已經擋咗，呢度加多層保險）。
  const openContextMenu = useCallback(
    (r: number, d: number, x: number, y: number) => {
      if (monthLocked) return;
      setSel((prev) => {
        if (prev) {
          const r0 = Math.min(prev.a.r, prev.b.r);
          const r1 = Math.max(prev.a.r, prev.b.r);
          const d0 = Math.min(prev.a.d, prev.b.d);
          const d1 = Math.max(prev.a.d, prev.b.d);
          if (r >= r0 && r <= r1 && d >= d0 && d <= d1) return prev;
        }
        return { a: { r, d }, b: { r, d } };
      });
      setContextMenu({ r, d, x, y });
    },
    [monthLocked],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Escape／點選單以外嘅地方收埋右鍵選單。
  useEffect(() => {
    if (!contextMenu) return;
    const onDocMouseDown = () => closeContextMenu();
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onDocKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onDocKeyDown);
    };
  }, [contextMenu, closeContextMenu]);

  // WP-R2 第 5 項：手機「⋯」更多選單——Escape／點選單以外嘅地方收埋。
  useEffect(() => {
    if (!showMobileMore) return;
    const onDocMouseDown = () => setShowMobileMore(false);
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMobileMore(false);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onDocKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onDocKeyDown);
    };
  }, [showMobileMore]);

  // ---- 雞頭人數／更數統計條（老闆 feedback 2026-09-12）------------------
  // 用原始 `records`（未經 rows/cells 聚合）逐更計數，先分得到
  // confirmed／pending 兩個桶。歸屬雞頭嘅口徑同 buildRowsAndCells()一致：
  // settlement_broker_id 冇填就跟 guard.default_broker_id；仲係冇（例如
  // 舊更表冇填雞頭欄）嘅記錄唔計入任何雞頭列（同 §「Y=公司兵」呢類淨係
  // 憑糧明細先反推得到嘅安排一致，呢度冇資料源可以反推，唔會亂估）。
  // 內部角色見晒全部雞頭；雞頭 session 本身 API 已經淨係傳返自己嗰啲
  // records（scopeShiftRecordWhere），呢度自然淨係計到自己一行，唔使
  // 額外分支處理。
  type BrokerStat = {
    brokerId: string;
    code: string;
    name: string;
    headcount: number;
    confirmed: number;
    pending: number;
    quotaTarget: number;
  };
  const brokerStats = useMemo<BrokerStat[]>(() => {
    const byBroker = new Map<string, { guards: Set<string>; confirmed: number; pending: number }>();
    for (const rec of records) {
      const brokerId = rec.settlement_broker_id ?? guardsById.get(rec.guard_id)?.default_broker_id ?? null;
      if (!brokerId) continue;
      let bucket = byBroker.get(brokerId);
      if (!bucket) {
        bucket = { guards: new Set(), confirmed: 0, pending: 0 };
        byBroker.set(brokerId, bucket);
      }
      bucket.guards.add(rec.guard_id);
      if (rec.status === "confirmed" || rec.status === "completed") bucket.confirmed++;
      else if (rec.status === "pending_approval" || rec.status === "draft") bucket.pending++;
    }
    const quotaTotalsByBroker = new Map<string, number>();
    for (const q of quotas) {
      quotaTotalsByBroker.set(q.broker_id, (quotaTotalsByBroker.get(q.broker_id) ?? 0) + q.target_shifts);
    }
    const stats: BrokerStat[] = [];
    for (const [brokerId, bucket] of byBroker) {
      const broker = brokersById.get(brokerId);
      stats.push({
        brokerId,
        code: broker?.code ?? brokerId,
        name: broker?.name ?? "",
        headcount: bucket.guards.size,
        confirmed: bucket.confirmed,
        pending: bucket.pending,
        quotaTarget: quotaTotalsByBroker.get(brokerId) ?? 0,
      });
    }
    return stats.sort((a, b) => a.code.localeCompare(b.code));
  }, [records, guardsById, brokersById, quotas]);

  // ---- 畫面 ---------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-6 text-sm text-gray-500">
        載入緊更表……
        {slowLoading && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
            載入時間比平時長（超過 15 秒）——可能係網絡慢或者登入已過期。
            <div className="mt-2 flex gap-2">
              <button type="button" className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700" onClick={() => window.location.reload()}>重新載入</button>
              <a href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`} className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">重新登入</a>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-3" data-testid="roster-forbidden">
        <h1 className="text-xl font-semibold text-gray-900">冇權限或搵唔到呢個盤</h1>
        <p className="text-sm text-gray-600">{forbidden}——你可能冇份呢個盤，或者個網址打錯。</p>
        <Link href="/" className="inline-block text-blue-600 underline text-sm">
          返首頁
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-3">
        <h1 className="text-xl font-semibold text-gray-900">讀取失敗</h1>
        <p className="text-sm text-gray-600">{loadError}</p>
        <button
          type="button"
          className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => setReloadTick((t) => t + 1)}
        >
          重試
        </button>
      </div>
    );
  }


  // ---- WP-R2：桌面／手機固定欄闊度（README §04/§23）--------------------
  const showBrokerCol = !isBrokerSession && !compact;
  const deskNameWidth = DESK_FIXED_TOTAL - DESK_COL_SHIFT_TYPE - (showBrokerCol ? DESK_COL_BROKER : 0);
  const nameColWidth = compact ? MOBILE_COL_NAME : deskNameWidth;
  const leftOffsets = compact
    ? { name: 0 }
    : { shiftType: 0, name: DESK_COL_SHIFT_TYPE, broker: DESK_COL_SHIFT_TYPE + deskNameWidth };
  const fixedTotal = compact ? MOBILE_COL_NAME : DESK_FIXED_TOTAL;
  const dayColW = compact ? MOBILE_COL_DAY : DESK_COL_DAY;
  const rowH = compact ? 44 : 38;
  // 該盤全部有效更別代號——頁首「N 日 · 更別 …」＋未鎖定提示條圖例＋手機
  // 鍵盤按鍵都用呢個（Fable 規劃判斷，P2-版面重設計計劃.md §2：「31 日 ·
  // 更別 D」改為列出全部代號，唔跟原型淨顯示一個）。
  // 同一個代號（例如「D」）喺呢個盤可以對應多個 shift_type 記錄（唔同
  // id，例如唔同時段／唔同人手要求但沿用同一個代號字面）——呢度淨係想
  // 列出「呢個盤有邊啲代號」，用 Set 去重先至唔會顯示重複代號。
  const siteShiftCodes = [...new Set(shiftTypeOptions.map((s) => s.code))];

  function rangeBounds() {
    if (!sel) return null;
    return {
      r0: Math.min(sel.a.r, sel.b.r),
      r1: Math.max(sel.a.r, sel.b.r),
      d0: Math.min(sel.a.d, sel.b.d),
      d1: Math.max(sel.a.d, sel.b.d),
    };
  }
  const bounds = rangeBounds();

  // 手機底部更別鍵盤（README §23）：揀住單一格、未鎖定、冇喺 inline
  // 編輯（桌面專用路徑，compact 已經喺 onCellDoubleClick 禁咗）先顯示。
  // 按鍵＝呢一行嘅更別代號（一定 valid，因為 row 本身固定咗
  // shift_type_id）＋請假代號，唔重複、唔寫死 D/N/SH/RD/AL（Fable 規劃
  // 判斷，P2-版面重設計計劃.md §2）。
  const mobileKeypadRow: RowMeta | null =
    compact && !monthLocked && !editing && sel && sel.a.r === sel.b.r && sel.a.d === sel.b.d ? (visibleRows[sel.b.r] ?? null) : null;
  const mobileKeypadDay = mobileKeypadRow ? sel!.b.d : null;
  const mobileKeypadKeys = mobileKeypadRow
    ? [mobileKeypadRow.shiftTypeCode, ...MOBILE_KEYPAD_LEAVE_CODES.filter((code) => code !== mobileKeypadRow.shiftTypeCode)]
    : [];

  // 格仔渲染（桌面／手機共用；淨係 sizePx／字級隨 compact 改）——保留
  // 原本嘅拖選／打字／選中／dirty／invalid／伺服器錯誤高亮邏輯，配色改
  // 用 `shiftCodeStyle()`（README「格內代號 chip」）；第 13 項抽咗做
  // `DayCell` memo 元件，呢度淨係計算原始值 props。
  function renderDayCell(row: RowMeta, r: number, d: number) {
    const key = cellKeyOf(row.key, d);
    const c = cells.get(key);
    const isDirty = !cellsEqual(baseline.get(key), c);
    const selected = sel ? sel.b.r === r && sel.b.d === d : false;
    const inRange = bounds ? r >= bounds.r0 && r <= bounds.r1 && d >= bounds.d0 && d <= bounds.d1 : false;
    const isError = errorCellKey === key;
    const code = c?.code ?? null;
    const isLeave = !!code && code !== row.shiftTypeCode && LEAVE_CODES.includes(code);
    const invalid = !!code && code !== row.shiftTypeCode && !LEAVE_CODES.includes(code);
    const isDraft = c?.status === "draft" || c?.status === "pending_approval";
    // WP-R2 第 4 項：inline input 開喺「錨點」格（`editAnchor`），唔再係
    // `selected`（拖選多格之後 `selected` 淨係代表 sel.b，同 sel.a 未必
    // 係同一格）。
    const isEditingHere = editing && !compact && !!editAnchor && editAnchor.r === r && editAnchor.d === d;
    const keyBufferText = keyBuffer && keyBuffer.r === r && keyBuffer.d === d ? keyBuffer.text : undefined;
    const m = dayMetaList[d - 1];

    const chip = invalid ? { bg: "#fee2e2", fg: "#b91c1c", border: undefined } : shiftCodeStyle(code, { isLeave, isDraft });
    const title = c?.status ? `狀態：${c.status}（已排 ${dayTotals[d - 1]} / 所需 ${dailyReq[d - 1] ?? 0}）` : undefined;

    return (
      <DayCell
        key={d}
        r={r}
        d={d}
        rowKey={row.key}
        code={code}
        isDirty={isDirty}
        selected={selected}
        inRange={inRange}
        isError={isError}
        chipBg={chip.bg}
        chipFg={chip.fg}
        chipBorder={chip.border}
        monthLocked={monthLocked}
        compact={compact}
        dayColW={dayColW}
        rowH={rowH}
        colBg={m.colBg}
        isToday={m.isToday}
        isWeekend={m.isWeekend}
        isEditingHere={isEditingHere}
        editText={editText}
        keyBufferText={keyBufferText}
        title={title}
        onCellMouseDown={onCellMouseDown}
        onCellMouseEnter={onCellMouseEnter}
        onCellClick={onCellClick}
        onCellDoubleClick={onCellDoubleClick}
        onContextMenu={openContextMenu}
        onEditTextChange={setEditText}
        onCommitEdit={commitEdit}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ================= 桌面頁首（README §04） ================= */}
      {!compact && (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <GuardedLink href="/roster" className="flex items-center gap-1.5 text-xs text-zk-muted hover:text-zk-text">
              更表 <span className="text-zk-faintest">/</span> {siteName || "…"}
            </GuardedLink>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-3">
              <h1 className="text-[22px] font-bold tracking-[-0.01em] text-zk-text">{siteName || "更表編輯器"}</h1>
              <div className="flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[3px] text-[13px] text-[#334155]">
                <button type="button" className="text-zk-faint hover:text-zk-text" onClick={() => goMonth(prevMonthStr(month))} aria-label="上一月">
                  ‹
                </button>
                {year} 年 {monthNum} 月
                <button type="button" className="text-zk-faint hover:text-zk-text" onClick={() => goMonth(nextMonthStr(month))} aria-label="下一月">
                  ›
                </button>
              </div>
              <span className="text-xs text-zk-muted">
                {days} 日{siteShiftCodes.length > 0 ? ` · 更別 ${siteShiftCodes.join("／")}` : ""}
                {dirtyCount > 0 ? ` · ${dirtyCount} 格未儲存` : ""}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={monthLocked}
              className="rounded-md border border-[#d1d5db] bg-white px-3.5 py-[7px] text-[13px] text-[#334155] hover:bg-zk-header disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => setShowAddGuard(true)}
            >
              加保安員
            </button>
            <button
              type="button"
              disabled={monthLocked}
              className="rounded-md border border-[#d1d5db] bg-white px-3.5 py-[7px] text-[13px] text-[#334155] hover:bg-zk-header disabled:cursor-not-allowed disabled:opacity-45"
              onClick={handleCopyPrevMonth}
            >
              複製上月（{prevMonthStr(month)}）
            </button>
            {hasRosterLayout === false ? (
              <span
                data-testid="roster-export-unavailable"
                title="呢個盤未有更表版面模板，唔可以匯出"
                className="cursor-not-allowed rounded-md border border-zk-border px-3.5 py-[7px] text-[13px] text-zk-faintest"
              >
                未有更表模板，唔可以匯出
              </span>
            ) : (
              <a
                data-testid="roster-export-link"
                href={`/api/sites/${siteId}/roster-export?month=${month}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-[#d1d5db] bg-white px-3.5 py-[7px] text-[13px] text-[#334155] hover:bg-zk-header"
              >
                匯出 Excel
              </a>
            )}
            <span className="mx-1 h-[22px] w-px bg-zk-border" />
            <button
              type="button"
              disabled={dirtyCount === 0}
              className="rounded-md border border-[#d1d5db] bg-white px-3.5 py-[7px] text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
              style={{ color: "#94a3b8" }}
              onClick={handleRevert}
            >
              還原
            </button>
            <button
              type="button"
              disabled={monthLocked || saving || dirtyCount === 0}
              className="rounded-md border border-[#2563eb] bg-[#2563eb] px-4 py-[7px] text-[13px] font-semibold text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed"
              style={{ opacity: monthLocked ? 0.45 : saving || dirtyCount === 0 ? 0.6 : 1 }}
              onClick={handleSave}
            >
              {saving ? "儲存緊……" : "儲存"}
            </button>
          </div>
        </div>
      )}

      {/* ================= 手機頁首（README §23） =================
          注意：R1 嘅全域手機頂欄（漢堡＋「在勤」＋頭像，`MobileNav.tsx`）
          呢頁都會照樣顯示喺上面——原型 `mShowBar` 喺 roster 頁會收埋個
          全域頂欄，但 `MobileNav.tsx` 屬於 R1 外殼檔案，WP-R2 任務明確
          唔准改，所以呢個更表專屬頂欄改為疊喺全域頂欄下面（唔係取代
          佢），見完成回報「偏差」一節。 */}
      {compact && (
        <div data-testid="roster-mobile-header" className="-mx-4 -mt-3.5 flex items-center justify-between gap-3 border-b border-zk-border bg-white px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <GuardedLink href="/roster" aria-label="返回更表索引" className="text-xl text-zk-text">
              ‹
            </GuardedLink>
            <div className="min-w-0">
              <div className="truncate text-[16px] font-bold text-zk-text">{siteName || "更表編輯器"}</div>
              <div className="text-[11.5px] text-zk-muted">
                {year} 年 {monthNum} 月 · {monthLocked ? "已鎖定" : "排更中"}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* WP-R2 第 5 項：加保安員／複製上月／匯出 Excel／還原——手機
                頁首冇位擺齊，收埋做「⋯」選單，沿用桌面同一啲 handler。 */}
            <div className="relative">
              <button
                type="button"
                data-testid="roster-mobile-more"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={showMobileMore}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[#d1d5db] text-[15px] leading-none text-[#334155]"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowMobileMore((v) => !v)}
              >
                ⋯
              </button>
              {showMobileMore && (
                <div
                  data-testid="roster-mobile-more-menu"
                  className="absolute right-0 top-9 z-40 w-48 rounded-md border border-zk-border bg-white py-1 text-[13px] text-zk-text"
                  style={{ boxShadow: "0 6px 20px rgba(15,23,42,.15)" }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={monthLocked}
                    className="block w-full px-3 py-1.5 text-left hover:bg-zk-header disabled:opacity-40"
                    onClick={() => {
                      setShowMobileMore(false);
                      setShowAddGuard(true);
                    }}
                  >
                    加保安員
                  </button>
                  <button
                    type="button"
                    disabled={monthLocked}
                    className="block w-full px-3 py-1.5 text-left hover:bg-zk-header disabled:opacity-40"
                    onClick={() => {
                      setShowMobileMore(false);
                      handleCopyPrevMonth();
                    }}
                  >
                    複製上月（{prevMonthStr(month)}）
                  </button>
                  {hasRosterLayout === false ? (
                    <span
                      data-testid="roster-export-unavailable"
                      title="呢個盤未有更表版面模板，唔可以匯出"
                      className="block px-3 py-1.5 text-left text-zk-faintest"
                    >
                      未有更表模板，唔可以匯出
                    </span>
                  ) : (
                    <a
                      data-testid="roster-export-link"
                      href={`/api/sites/${siteId}/roster-export?month=${month}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block px-3 py-1.5 hover:bg-zk-header"
                      onClick={() => setShowMobileMore(false)}
                    >
                      匯出 Excel
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={dirtyCount === 0}
                    className="block w-full px-3 py-1.5 text-left hover:bg-zk-header disabled:opacity-40"
                    onClick={() => {
                      setShowMobileMore(false);
                      handleRevert();
                    }}
                  >
                    還原{dirtyCount > 0 ? `（${dirtyCount} 格未儲存）` : ""}
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={monthLocked || saving || dirtyCount === 0}
              className="rounded-md border border-[#2563eb] bg-[#2563eb] px-3 py-[6px] text-[12.5px] font-semibold text-white disabled:cursor-not-allowed"
              style={{ opacity: monthLocked ? 0.45 : saving || dirtyCount === 0 ? 0.6 : 1 }}
              onClick={handleSave}
            >
              {saving ? "儲存緊…" : "儲存"}
            </button>
          </div>
        </div>
      )}

      {/* ================= 雞頭統計卡（桌面，README §04） ================= */}
      {brokerStats.length > 0 && !compact && (
        <div className="flex flex-col gap-2" data-testid="broker-stats-bar">
          <div
            className="grid gap-2.5"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
            data-testid="broker-stats-table"
          >
            {brokerStats.map((b) => {
              const scheduled = b.confirmed + b.pending;
              const isSelected = selectedBrokerCode === b.code;
              const bc = brokerColor(b.code);
              const pct = b.quotaTarget > 0 ? Math.min(100, Math.round((scheduled / b.quotaTarget) * 100)) : 100;
              return (
                <div
                  key={b.brokerId}
                  data-testid="broker-stats-row"
                  data-broker-code={b.code}
                  className={`flex flex-col gap-1.5 rounded-lg border bg-white px-3.5 py-2.5 ${isBrokerSession ? "" : "cursor-pointer hover:bg-zk-header"}`}
                  style={{ borderColor: isSelected ? bc.dot : "#e5e7eb" }}
                  onClick={isBrokerSession ? undefined : () => setSelectedBrokerCode(isSelected ? null : b.code)}
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-zk-text">
                      <span className="h-2 w-2 rounded-sm" style={{ background: bc.dot }} />
                      {b.code}
                      {b.name ? `（${b.name}）` : ""}
                    </span>
                    <span className="text-[11.5px] text-zk-muted">{b.headcount} 人</span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[18px] font-bold text-zk-text">{b.confirmed}</span>
                    <span className="text-[11.5px] text-zk-muted">
                      已確認 · 待審批{" "}
                      <span style={{ color: b.pending > 0 ? "#b45309" : "#64748b", fontWeight: b.pending > 0 ? 600 : 400 }}>{b.pending}</span>
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-zk-surface">
                    <div className="h-full" style={{ width: `${pct}%`, background: bc.dot }} />
                  </div>
                  <div className="text-[11px] text-zk-faint">
                    {b.quotaTarget > 0 ? `配額 ${b.quotaTarget} · 已排 ${scheduled}` : "未設配額（軟性限制）"}
                  </div>
                </div>
              );
            })}
          </div>
          {!isBrokerSession && (
            <div className="flex items-center gap-2">
              {/* 舊雞頭篩選下拉：卡本身已經可以撳篩選，呢個下拉保留做
                  輔助／後備（testid 要留喺 DOM），視覺上隱藏。 */}
              <label htmlFor="broker-filter-select" className="sr-only">
                雞頭篩選
              </label>
              <select
                id="broker-filter-select"
                data-testid="broker-filter-select"
                className="sr-only"
                value={selectedBrokerCode ?? ""}
                onChange={(e) => setSelectedBrokerCode(e.target.value || null)}
              >
                <option value="">全部</option>
                {brokerStats.map((b) => (
                  <option key={b.brokerId} value={b.code}>
                    {b.code}
                    {b.name ? `（${b.name}）` : ""}
                  </option>
                ))}
              </select>
              {selectedBrokerCode && (
                <button type="button" data-testid="broker-filter-clear" className="text-xs text-zk-primary underline" onClick={() => setSelectedBrokerCode(null)}>
                  清除篩選
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= 雞頭 chips（手機，README §23） ================= */}
      {brokerStats.length > 0 && compact && (
        <div className="flex flex-col gap-1.5" data-testid="broker-stats-bar">
          <div className="nosb flex gap-1.5 overflow-x-auto" data-testid="broker-stats-table">
            {brokerStats.map((b) => {
              const isSelected = selectedBrokerCode === b.code;
              const bc = brokerColor(b.code);
              return (
                <button
                  key={b.brokerId}
                  type="button"
                  data-testid="broker-stats-row"
                  data-broker-code={b.code}
                  disabled={isBrokerSession}
                  className="flex shrink-0 items-center gap-1 rounded-[14px] border px-2 py-1 text-[11.5px] text-[#334155]"
                  style={{ borderColor: isSelected ? bc.dot : "#e5e7eb" }}
                  onClick={() => setSelectedBrokerCode(isSelected ? null : b.code)}
                >
                  <span className="h-[7px] w-[7px] rounded-sm" style={{ background: bc.dot }} />
                  {b.code}
                  {b.name ? `（${b.name}）` : ""} <b>{b.confirmed}</b>
                </button>
              );
            })}
          </div>
          {!isBrokerSession && (
            <div className="flex items-center gap-2">
              <select
                id="broker-filter-select"
                data-testid="broker-filter-select"
                className="sr-only"
                value={selectedBrokerCode ?? ""}
                onChange={(e) => setSelectedBrokerCode(e.target.value || null)}
                aria-hidden
              >
                <option value="">全部</option>
                {brokerStats.map((b) => (
                  <option key={b.brokerId} value={b.code}>
                    {b.code}
                  </option>
                ))}
              </select>
              {selectedBrokerCode && (
                <button type="button" data-testid="broker-filter-clear" className="text-[11.5px] text-zk-primary underline" onClick={() => setSelectedBrokerCode(null)}>
                  清除篩選
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= 鎖定／提示橫幅 ================= */}
      {monthLocked ? (
        <Notice
          variant="warning"
          action={
            <Link href="/reports/monthly-close" className="text-[12px] underline" style={{ color: "inherit" }}>
              去月結工作台
            </Link>
          }
        >
          {month} 已鎖定 — 更表只讀。如需修改，請聯絡有「月結鎖定解鎖」權限嘅同事。
        </Notice>
      ) : (
        !compact && (
          <div className="flex items-center gap-3.5 rounded-md border border-zk-border bg-white px-3 py-2 text-xs text-zk-muted">
            <span>撳格打字（D / N / SH / RD / AL）· 拖選多格一齊填 · 右鍵：清除／整行填／整行清</span>
            <span className="ml-auto inline-flex flex-wrap gap-2.5">
              {siteShiftCodes.map((code) => {
                const s = shiftCodeStyle(code);
                return (
                  <span key={code} className="inline-flex items-center gap-1">
                    <span className="h-3 w-3 rounded-[3px]" style={{ background: s.bg === "transparent" ? "#f1f5f9" : s.bg, border: s.border }} />
                    {code}
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ border: "1px dashed #f59e0b" }} />
                假
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ border: "1px dashed #2563eb" }} />
                待批
              </span>
              {/* P2 整合驗收應修①：加返「未儲存」圖例——同格仔嘅 dirty inset
                  ring 同一個顏色（琥珀色），等用戶睇圖例就知呢個顏色代表
                  「未儲存」，唔使靠估。 */}
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ boxShadow: "inset 0 0 0 2px #f59e0b" }} />
                未儲存
              </span>
            </span>
          </div>
        )
      )}
      {warnings.length > 0 && (
        <div className="rounded border border-yellow-300 bg-yellow-50 text-yellow-900 text-sm px-3 py-2 space-y-1">
          <p className="font-medium">儲存成功，但有以下軟性警示（唔擋寫入，建議留意）：</p>
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {errorBanner && (
        <div className="rounded border border-red-300 bg-red-50 text-red-800 text-sm px-3 py-2 whitespace-pre-wrap">{errorBanner}</div>
      )}

      {/* ================= 格仔表（README §04/§23） ================= */}
      <div className="overflow-hidden rounded-lg border border-zk-border bg-white" style={{ opacity: monthLocked ? 0.8 : 1 }}>
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="outline-none overflow-auto select-none"
          // WP-R2 第 9 項：容器本身 max-height 封頂 72vh——如果淨係用
          // scrollTop 較正，揀住嘅係最尾一行嘅話，容器已經冇位再向下
          // 捲（本身個底邊已經伸到鍵盤範圍），scrollTop 點加都冇用。鍵
          // 盤開緊嗰陣直接縮細容器可視高度（扣走鍵盤高度），先保證容
          // 器底邊實際唔會伸過鍵盤頂。
          style={{ maxHeight: compact && mobileKeypadRow && mobileKeypadDay !== null ? `calc(72vh - ${MOBILE_KEYPAD_HEIGHT}px)` : "72vh" }}
        >
          <table className="border-collapse text-sm" style={{ minWidth: fixedTotal + days * dayColW }}>
            <thead>
              <tr>
                {!compact && (
                  <th
                    className="sticky top-0 z-20 bg-[#fafbfc] text-left text-[11px] font-semibold text-zk-muted"
                    style={{ left: leftOffsets.shiftType, width: DESK_COL_SHIFT_TYPE, minWidth: DESK_COL_SHIFT_TYPE, position: "sticky", borderRight: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb", padding: "8px 0 8px 12px" }}
                  >
                    更別
                  </th>
                )}
                <th
                  className="sticky top-0 z-20 bg-[#fafbfc] text-left text-[11px] font-semibold text-zk-muted"
                  style={{
                    left: leftOffsets.name,
                    width: nameColWidth,
                    minWidth: nameColWidth,
                    position: "sticky",
                    borderRight: compact || !showBrokerCol ? "1px solid #e5e7eb" : undefined,
                    borderBottom: "1px solid #e5e7eb",
                    padding: compact ? "0 12px" : "8px 10px",
                    boxShadow: compact ? "2px 0 6px rgba(0,0,0,.04)" : undefined,
                  }}
                >
                  {compact ? "姓名" : "姓名 / 工號"}
                </th>
                {showBrokerCol && (
                  <th
                    className="sticky top-0 z-20 bg-[#fafbfc] text-left text-[11px] font-semibold text-zk-muted"
                    style={{ left: leftOffsets.broker, width: DESK_COL_BROKER, minWidth: DESK_COL_BROKER, position: "sticky", borderRight: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb", padding: "8px 10px" }}
                  >
                    雞頭
                  </th>
                )}
                {dayList.map((d) => {
                  const m = dayMetaList[d - 1];
                  return (
                    <th
                      key={d}
                      className="sticky top-0 z-10 text-center font-normal"
                      style={{ width: dayColW, background: m.headerBg, borderBottom: "1px solid #e5e7eb", padding: "5px 0" }}
                      data-testid={`roster-day-header-${d}`}
                      data-today={m.isToday || undefined}
                      data-weekend={m.isWeekend || undefined}
                    >
                      <div style={{ fontSize: 9.5, color: m.weekdayColor }}>{m.weekday}</div>
                      <div style={{ fontSize: compact ? 12.5 : 12, fontWeight: 600, color: m.dayColor, lineHeight: 1.2 }}>{d}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, r) => {
                const guard = guardsById.get(row.guardId);
                const permitExpired = guard?.sia_permit_expiry ? new Date(guard.sia_permit_expiry) < new Date(year, monthNum - 1 + 1, 0) : false;
                const broker = row.brokerId ? brokersById.get(row.brokerId) : null;
                const bc = brokerColor(broker?.code);
                return (
                  <tr
                    key={row.key}
                    data-testid="roster-row"
                    data-row-index={r}
                    data-row-key={row.key}
                    className="hover:bg-[#fafbfc]"
                    style={{ height: rowH, borderBottom: "1px solid #f1f5f9" }}
                  >
                    {!compact && (
                      <td
                        className="sticky z-10 bg-white text-center text-xs text-zk-muted"
                        style={{ left: leftOffsets.shiftType, width: DESK_COL_SHIFT_TYPE, minWidth: DESK_COL_SHIFT_TYPE, position: "sticky", borderRight: "1px solid #e5e7eb" }}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span>{row.shiftTypeCode}</span>
                          <button
                            type="button"
                            disabled={monthLocked}
                            className="text-[10px] text-zk-primary underline disabled:opacity-40"
                            onClick={() => {
                              setFillRowKey(row.key === fillRowKey ? null : row.key);
                              setFillRowValue("");
                            }}
                          >
                            整行
                          </button>
                        </div>
                      </td>
                    )}
                    <td
                      className="sticky z-10 bg-white"
                      style={{
                        left: leftOffsets.name,
                        width: nameColWidth,
                        minWidth: nameColWidth,
                        maxWidth: nameColWidth,
                        position: "sticky",
                        borderRight: compact || !showBrokerCol ? "1px solid #e5e7eb" : undefined,
                        boxShadow: compact ? "2px 0 6px rgba(0,0,0,.04)" : undefined,
                      }}
                    >
                      {compact ? (
                        // WP-R2 第 12 項：手機行高固定 44px，姓名格淨係
                        // 兩行（名／雞頭·工號）——證件到期呢類第三行 44px
                        // 塞唔落，compact 唔顯示（桌面照樣顯示）。
                        <div className="flex h-full flex-col justify-center gap-0.5 px-3 py-1">
                          <div className="truncate text-[13.5px] font-medium text-zk-text" title={row.guardName || "(未命名)"}>
                            {row.guardName || "(未命名)"}
                          </div>
                          <div className="flex items-center gap-1 truncate text-[10.5px] text-zk-faint">
                            {broker && (
                              <span className="font-semibold" style={{ color: bc.dot }}>
                                {broker.code}
                              </span>
                            )}
                            {broker && row.staffNo ? "·" : ""}
                            {row.staffNo}
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-baseline gap-2 px-2.5">
                          <span className="truncate text-[13px] font-medium" title={row.guardName || "(未命名)"}>
                            {row.guardName || "(未命名)"}
                          </span>
                          <span className="shrink-0 text-[11px] text-zk-faint">{row.staffNo}</span>
                          {permitExpired && <span className="shrink-0 text-[10px] text-red-600">證件到期</span>}
                        </div>
                      )}
                    </td>
                    {showBrokerCol && (
                      <td className="sticky z-10 bg-white px-2.5" style={{ left: leftOffsets.broker, width: DESK_COL_BROKER, position: "sticky", borderRight: "1px solid #e5e7eb" }}>
                        {broker && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: bc.bg, color: bc.fg }}>
                            {broker.code}
                          </span>
                        )}
                      </td>
                    )}
                    {dayList.map((d) => renderDayCell(row, r, d))}
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td
                    colSpan={(compact ? 1 : 2) + (showBrokerCol ? 1 : 0) + days}
                    className="py-6 text-center text-sm text-zk-faintest"
                  >
                    {allRows.length === 0
                      ? "呢個盤呢個月未有更表記錄——撳「加保安員」開始排更，或者撳「複製上月」。"
                      : "呢個雞頭喺呢個盤搵唔到保安員行（篩選只影響顯示，其他雞頭嘅記錄照喺度）。"}
                  </td>
                </tr>
              )}
            </tbody>
            {/* WP-R2 第 6／7 項：合計行桌面／手機都要 render（手機之前
                `{!compact}` 令成行消失）——桌面兩行（已排色碼／所需灰色
                細字）；雞頭視角（isBrokerSession）淨係顯示自己已排數，
                唔做紅綠色碼、唔顯示所需（所需係成個盤口徑，對雞頭無
                意義）。 */}
            <tfoot>
              <tr>
                <td
                  className="sticky z-10 bg-[#fafbfc] text-[11px] text-zk-muted"
                  style={{ left: 0, position: "sticky", borderTop: "1px solid #e5e7eb", padding: "7px 12px" }}
                  colSpan={compact ? 1 : 2 + (showBrokerCol ? 1 : 0)}
                >
                  {isBrokerSession ? "自己已排" : "每日已排 / 所需"}
                </td>
                {dayTotals.map((t, i) => {
                  const req = dailyReq[i] ?? 0;
                  if (isBrokerSession) {
                    return (
                      <td
                        key={i}
                        className="text-center text-[11px] font-semibold"
                        style={{ borderTop: "1px solid #e5e7eb", padding: "7px 0", color: "#334155" }}
                        title={`自己已排 ${t}`}
                      >
                        {t}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={i}
                      className="text-center"
                      style={{ borderTop: "1px solid #e5e7eb", padding: compact ? "5px 0" : "6px 0" }}
                      title={`已排 ${t} / 所需 ${req}`}
                    >
                      <div className="text-[11px] font-semibold" style={{ color: coverageColor(t, req) }}>
                        {t}
                      </div>
                      <div className="text-[9.5px] text-[#94a3b8]">{req}</div>
                    </td>
                  );
                })}
              </tr>
              {selectedBrokerTotals && (
                <tr data-testid="roster-selected-broker-total">
                  <td
                    className="sticky z-10 text-[11px] font-medium"
                    style={{ left: 0, position: "sticky", borderTop: "1px solid #e5e7eb", padding: "7px 12px", background: "#eff6ff", color: "#1e40af" }}
                    colSpan={compact ? 1 : 2 + (showBrokerCol ? 1 : 0)}
                  >
                    所選雞頭合計（{selectedBrokerCode}）
                  </td>
                  {selectedBrokerTotals.map((t, i) => (
                    <td key={i} className="text-center text-[11px]" style={{ borderTop: "1px solid #e5e7eb", background: "#eff6ff", color: "#1e40af" }}>
                      {t}
                    </td>
                  ))}
                </tr>
              )}
            </tfoot>
          </table>
          {/* WP-R2 第 9 項：鍵盤開緊嗰陣表底加返 padding-bottom（≥鍵盤高
              度），等最底幾行可以捲上嚟，唔會俾 fixed 底部鍵盤遮住。 */}
          {compact && mobileKeypadRow && mobileKeypadDay !== null && <div style={{ height: MOBILE_KEYPAD_HEIGHT }} aria-hidden />}
        </div>
      </div>

      {/* ================= 手機底部更別鍵盤（README §23） ================= */}
      {mobileKeypadRow && mobileKeypadDay !== null && (
        <div
          data-testid="roster-mobile-keypad"
          className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-zk-border bg-white px-4 py-3"
          style={{ boxShadow: "0 -4px 16px rgba(0,0,0,.08)" }}
        >
          <div className="text-xs text-zk-muted">
            {mobileKeypadRow.guardName || "(未命名)"} · {monthNum} 月 {mobileKeypadDay} 日 — 揀更別
          </div>
          {/* 第 8 項之後最多 6 個代號鍵＋1 個清除＝7 粒——用固定 4 欄
              grid（唔用 flex-wrap）令「清除」一定喺可預測位置（第二行
              最尾），唔會因為 flex-wrap 換行令掣數目唔同時跑位／喺
              MOBILE_KEYPAD_HEIGHT 估算高度以外。 */}
          <div className="grid grid-cols-4 gap-1.5">
            {mobileKeypadKeys.map((code) => {
              const isLeave = code !== mobileKeypadRow.shiftTypeCode;
              const s = shiftCodeStyle(code, { isLeave });
              return (
                <button
                  key={code}
                  type="button"
                  className="h-11 w-full rounded-lg text-[13px] font-semibold"
                  style={{
                    background: s.bg === "transparent" ? "#fff" : s.bg,
                    color: s.fg === "transparent" ? "#0f172a" : s.fg,
                    border: "1px solid #e5e7eb",
                  }}
                  onClick={() => {
                    // 安全網：撳緊螢幕鍵盤嗰下，如果實體鍵盤仲有個 pending
                    // 嘅 buffer timer 未寫入，要即刻取消（唔係就可能兩邊
                    // 都寫，或者遲嚟嗰個 timer 蓋走撳掣寫嘅結果）。
                    cancelKeyBuffer();
                    applyMobileKeypadCode(mobileKeypadRow, mobileKeypadDay, code);
                  }}
                >
                  {code}
                </button>
              );
            })}
            <button
              type="button"
              className="h-11 w-full rounded-lg border border-zk-border bg-white text-xs text-zk-muted"
              onClick={() => {
                cancelKeyBuffer();
                applyMobileKeypadCode(mobileKeypadRow, mobileKeypadDay, null);
              }}
            >
              清除
            </button>
          </div>
        </div>
      )}

      {/* ================= 右鍵選單（README Interactions：清除／整行填／
          整行清） ================= */}
      {contextMenu &&
        (() => {
          const row = visibleRows[contextMenu.r];
          if (!row) return null;
          const cellCode = cells.get(cellKeyOf(row.key, contextMenu.d))?.code ?? "";
          const menuWidth = 152;
          const left = typeof window !== "undefined" ? Math.min(contextMenu.x, window.innerWidth - menuWidth - 8) : contextMenu.x;
          const top = typeof window !== "undefined" ? Math.min(contextMenu.y, window.innerHeight - 140) : contextMenu.y;
          return (
            <div
              data-testid="roster-context-menu"
              className="fixed z-50 rounded-md border border-zk-border bg-white py-1 text-[13px] text-zk-text"
              style={{ left, top, width: menuWidth, boxShadow: "0 6px 20px rgba(15,23,42,.15)" }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-zk-header"
                onClick={() => {
                  clearSelectedRange();
                  closeContextMenu();
                }}
              >
                清除所選
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-zk-header"
                onClick={() => {
                  setFillRowKey(row.key);
                  setFillRowValue(cellCode);
                  closeContextMenu();
                }}
              >
                整行填
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-zk-header"
                onClick={() => {
                  applyFillRow(row, "");
                  closeContextMenu();
                }}
              >
                整行清
              </button>
            </div>
          );
        })()}

      {fillRowKey && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={() => setFillRowKey(null)}>
          <div className="bg-white rounded shadow-lg p-4 w-72 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-gray-700">
              整行填滿（成個月 {days} 日全部填同一個代號）——更別代號或者請假代號（AL/NL/RD/SL/SH）；留空撳「填滿全行」＝整行清（成行清空）：
            </p>
            <input
              autoFocus
              data-testid="roster-fill-row-input"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm uppercase"
              value={fillRowValue}
              onChange={(e) => setFillRowValue(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const row = visibleRows.find((r) => r.key === fillRowKey);
                  if (row) applyFillRow(row, fillRowValue);
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="text-sm px-3 py-1 rounded border border-gray-300" onClick={() => setFillRowKey(null)}>
                取消
              </button>
              <button
                type="button"
                className="text-sm px-3 py-1 rounded bg-blue-600 text-white"
                onClick={() => {
                  const row = visibleRows.find((r) => r.key === fillRowKey);
                  if (row) applyFillRow(row, fillRowValue);
                }}
              >
                填滿全行
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddGuard && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={() => setShowAddGuard(false)}>
          <div className="bg-white rounded shadow-lg p-4 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-gray-900">加保安員行</h2>
            <label className="block text-xs text-gray-600">
              保安員
              <select
                aria-label="加保安員行:保安員"
                data-testid="add-guard-select-guard"
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
                value={addGuardId}
                onChange={(e) => setAddGuardId(e.target.value)}
              >
                <option value="">請揀保安員</option>
                {guardOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name_zh}
                    {g.staff_no ? `（${g.staff_no}）` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-gray-600">
              更別
              <select
                aria-label="加保安員行:更別"
                data-testid="add-guard-select-shift-type"
                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm"
                value={addShiftTypeId}
                onChange={(e) => setAddShiftTypeId(e.target.value)}
              >
                <option value="">請揀更別</option>
                {shiftTypeOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="text-sm px-3 py-1 rounded border border-gray-300" onClick={() => setShowAddGuard(false)}>
                取消
              </button>
              <button
                type="button"
                disabled={!addGuardId || !addShiftTypeId}
                className="text-sm px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
                onClick={handleAddGuardRow}
              >
                加入
              </button>
            </div>
          </div>
        </div>
      )}

      {quotas.length > 0 && (
        <div className="text-xs text-gray-500 border border-gray-200 rounded p-2">
          <p className="font-medium text-gray-600 mb-1">本月配額（純顯示，超配額警示會喺儲存後嘅黃色提示出現）：</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {quotas.map((q) => (
              <li key={q.id}>
                {shiftTypesById.get(q.shift_type_id)?.code ?? q.shift_type_id} · {brokersById.get(q.broker_id)?.name ?? q.broker_id}：{q.target_shifts} 更
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ================= 儲存成功 Toast（README §04） ================= */}
      {showSaveToast && (
        <div
          data-testid="roster-save-toast"
          className="fixed bottom-5 right-5 z-50 rounded-md bg-[#0f172a] px-4 py-2.5 text-[13px] text-white"
          style={{ boxShadow: "0 6px 18px rgba(15,23,42,.3)" }}
        >
          已儲存
        </div>
      )}
    </div>
  );
}
