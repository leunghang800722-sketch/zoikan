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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { apiGet, apiGetAll, apiPost, ApiClientError } from "@/lib/api-client";

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

// 左邊固定欄寬度（px）——用嚟計 sticky 欄嘅 left offset。
const COL_SHIFT_TYPE = 56;
const COL_NAME = 96;
const COL_STAFF_NO = 88;
// 2026-09-12 老闆 feedback：更表唔顯示安員電話（聯絡資料只喺安員名冊，按 安員:view 權限）；Excel 匯出照原檔格式保留
const COL_TEL = 0;
const COL_BROKER = 104;
const COL_DAY = 44;

export default function RosterEditor({ siteId, month }: { siteId: string; month: string }) {
  const { year, monthNum } = parseMonthStr(month);
  const days = daysInMonth(year, monthNum);
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days]);

  const [loading, setLoading] = useState(true);
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
  const skipExtraRowsResetRef = useRef(false);

  // 選格／編輯
  const [sel, setSel] = useState<SelRange | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

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
          apiGetAll<ShiftRecordDto>("/api/shift-records", { site_id: siteId, work_date_from: workDateFrom, work_date_to: workDateTo }),
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

  const commitEdit = useCallback(() => {
    if (!editing || !sel) return;
    const row = displayRowsRef.current[sel.b.r];
    if (!row) {
      setEditing(false);
      setEditText("");
      return;
    }
    const key = cellKeyOf(row.key, sel.b.d);
    const code = normalizeCode(editText);
    setCells((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      next.set(key, { code, id: existing?.id ?? null, status: existing?.status ?? null, recordType: existing?.recordType ?? null });
      return next;
    });
    setEditing(false);
    setEditText("");
    setErrorCellKey((prev) => (prev === key ? null : prev));
  }, [editing, sel, editText]);

  const startEdit = useCallback((r: number, d: number, initial: string) => {
    setSel({ a: { r, d }, b: { r, d } });
    setEditing(true);
    setEditText(initial);
  }, []);

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
        } else {
          // 打緊字入格入面（可能仲有其他鍵，例如純粹字元）——唔畀個
          // keydown 走漏去 layout／外層嘅全局快捷鍵（例如側欄），淨係
          // input 嘅 onChange 自己處理個值就夠。
          e.stopPropagation();
        }
        return;
      }
      if (!sel) return;
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
          if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key) && sel.a.r === sel.b.r && sel.a.d === sel.b.d) {
            e.preventDefault();
            e.stopPropagation();
            startEdit(sel.b.r, sel.b.d, e.key);
          }
      }
    },
    [monthLocked, editing, sel, commitEdit, moveSelection, clearSelectedRange, startEdit],
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
      if (monthLocked) return;
      const row = visibleRows[r];
      if (!row) return;
      const current = cells.get(cellKeyOf(row.key, d))?.code ?? "";
      startEdit(r, d, current);
    },
    [monthLocked, visibleRows, cells, startEdit],
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
    },
    [monthLocked, editing, commitEdit, visibleRows, cells],
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
  const applyFillRow = useCallback(
    (row: RowMeta, rawCode: string) => {
      const code = normalizeCode(rawCode);
      if (code === null) {
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
    return <div className="p-6 text-sm text-gray-500">載入緊更表……</div>;
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

  const leftOffsets = {
    shiftType: 0,
    name: COL_SHIFT_TYPE,
    staffNo: COL_SHIFT_TYPE + COL_NAME,
    tel: COL_SHIFT_TYPE + COL_NAME + COL_STAFF_NO,
    broker: COL_SHIFT_TYPE + COL_NAME + COL_STAFF_NO + COL_TEL,
  };
  const dayColStart = COL_SHIFT_TYPE + COL_NAME + COL_STAFF_NO + COL_TEL + (isBrokerSession ? 0 : COL_BROKER);

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

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{siteName || "更表編輯器"}</h1>
          <p className="text-xs text-gray-500">{month} 更表（{days} 日）{dirtyCount > 0 ? ` · ${dirtyCount} 格未儲存` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={monthLocked}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => setShowAddGuard(true)}
          >
            加保安員
          </button>
          <button
            type="button"
            disabled={monthLocked}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCopyPrevMonth}
          >
            複製上月（{prevMonthStr(month)}）
          </button>
          <button
            type="button"
            disabled={dirtyCount === 0}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRevert}
          >
            還原
          </button>
          <button
            type="button"
            disabled={monthLocked || saving || dirtyCount === 0}
            className="rounded bg-blue-600 text-white px-4 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSave}
          >
            {saving ? "儲存緊……" : "儲存"}
          </button>
          {/* P1-WP3：更表匯出（GET /api/sites/:id/roster-export?month=）——
              `更表匯出` module 出廠冇雞頭，冇權限撳落去會見到 API 嘅 403
              JSON（喺新分頁顯示），唔會壞成個編輯器。
              Opus 對抗式驗收第二輪 R3：呢個盤冇 roster_layout 模板嘅話
              （`hasRosterLayout===false`），API 而家會 409
              no_roster_layout——UI 唔准照樣當正常連結掣（撳落去先喺新
              分頁見錯誤 JSON 太隱蔽），改用一個 disabled 掣＋文字提示。 */}
          {hasRosterLayout === false ? (
            <span
              data-testid="roster-export-unavailable"
              title="呢個盤未有更表版面模板，唔可以匯出"
              className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-400 cursor-not-allowed"
            >
              未有更表模板，唔可以匯出
            </span>
          ) : (
            <a
              data-testid="roster-export-link"
              href={`/api/sites/${siteId}/roster-export?month=${month}`}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              匯出 Excel
            </a>
          )}
        </div>
      </div>

      {/* 老闆 feedback 2026-09-12：雞頭篩選器＋人數/更數統計條——篩選器
          淨係內部角色見（雞頭 session 本身「只見自己」，冇篩選必要）；
          統計條兩種 session 都顯示（雞頭 session 因為 API 本身已經淨係
          傳返自己嘅記錄，呢度自然得返自己一行）。 */}
      {brokerStats.length > 0 && (
        <div className="rounded border border-gray-200 p-2 space-y-2" data-testid="broker-stats-bar">
          {!isBrokerSession && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="broker-filter-select" className="text-xs text-gray-600">
                雞頭篩選
              </label>
              <select
                id="broker-filter-select"
                data-testid="broker-filter-select"
                className="border border-gray-300 rounded px-2 py-1 text-sm"
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
                <button
                  type="button"
                  data-testid="broker-filter-clear"
                  className="text-xs text-blue-600 underline"
                  onClick={() => setSelectedBrokerCode(null)}
                >
                  清除篩選
                </button>
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse" data-testid="broker-stats-table">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-4 py-0.5 font-medium">雞頭</th>
                  <th className="pr-4 py-0.5 font-medium">人數</th>
                  <th className="pr-4 py-0.5 font-medium">已確認</th>
                  <th className="pr-4 py-0.5 font-medium">待審批</th>
                  <th className="pr-4 py-0.5 font-medium">已排／配額</th>
                </tr>
              </thead>
              <tbody>
                {brokerStats.map((b) => {
                  const scheduled = b.confirmed + b.pending;
                  const isSelected = selectedBrokerCode === b.code;
                  return (
                    <tr
                      key={b.brokerId}
                      data-testid="broker-stats-row"
                      data-broker-code={b.code}
                      className={
                        "border-t border-gray-100" +
                        (isBrokerSession ? "" : " cursor-pointer hover:bg-gray-50") +
                        (isSelected ? " bg-blue-50 font-medium" : "")
                      }
                      onClick={isBrokerSession ? undefined : () => setSelectedBrokerCode(b.code)}
                    >
                      <td className="pr-4 py-0.5">
                        {b.code}
                        {b.name ? `（${b.name}）` : ""}
                      </td>
                      <td className="pr-4 py-0.5">{b.headcount}</td>
                      <td className="pr-4 py-0.5">{b.confirmed}</td>
                      <td className="pr-4 py-0.5">{b.pending}</td>
                      <td className="pr-4 py-0.5">{b.quotaTarget > 0 ? `${scheduled}／${b.quotaTarget}` : scheduled}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {monthLocked && (
        <div className="rounded border border-red-300 bg-red-50 text-red-800 text-sm px-3 py-2">
          呢個月（{month}）已經鎖定，唔可以再改更表。如需修改，請聯絡有「月結鎖定解鎖」權限嘅同事。
        </div>
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

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="outline-none border border-gray-300 rounded overflow-auto max-h-[72vh] select-none"
      >
        <table className="border-collapse text-sm" style={{ minWidth: dayColStart + days * COL_DAY + 80 }}>
          <thead>
            <tr>
              <th className="sticky top-0 z-20 bg-gray-100 border border-gray-300 sticky-left" style={{ left: leftOffsets.shiftType, width: COL_SHIFT_TYPE, position: "sticky" }}>
                更別
              </th>
              <th className="sticky top-0 z-20 bg-gray-100 border border-gray-300" style={{ left: leftOffsets.name, width: COL_NAME, position: "sticky" }}>
                姓名
              </th>
              <th className="sticky top-0 z-20 bg-gray-100 border border-gray-300" style={{ left: leftOffsets.staffNo, width: COL_STAFF_NO, position: "sticky" }}>
                工號
              </th>
              {!isBrokerSession && (
                <th className="sticky top-0 z-20 bg-gray-100 border border-gray-300" style={{ left: leftOffsets.broker, width: COL_BROKER, position: "sticky" }}>
                  雞頭
                </th>
              )}
              {dayList.map((d) => (
                <th key={d} className="sticky top-0 z-10 bg-gray-100 border border-gray-300 font-normal" style={{ width: COL_DAY }}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, r) => {
              const guard = guardsById.get(row.guardId);
              const permitExpired = guard?.sia_permit_expiry ? new Date(guard.sia_permit_expiry) < new Date(year, monthNum - 1 + 1, 0) : false;
              const broker = row.brokerId ? brokersById.get(row.brokerId) : null;
              return (
                <tr key={row.key} data-testid="roster-row" data-row-index={r} data-row-key={row.key}>
                  <td className="sticky z-10 bg-white border border-gray-300 text-center font-medium" style={{ left: leftOffsets.shiftType, width: COL_SHIFT_TYPE, position: "sticky" }}>
                    <div className="flex flex-col items-center gap-0.5">
                      <span>{row.shiftTypeCode}</span>
                      <button
                        type="button"
                        disabled={monthLocked}
                        className="text-[10px] text-blue-600 underline disabled:opacity-40"
                        onClick={() => {
                          setFillRowKey(row.key === fillRowKey ? null : row.key);
                          setFillRowValue("");
                        }}
                      >
                        整行
                      </button>
                    </div>
                  </td>
                  <td className="sticky z-10 bg-white border border-gray-300 px-1" style={{ left: leftOffsets.name, width: COL_NAME, position: "sticky" }}>
                    {row.guardName || "(未命名)"}
                    {permitExpired && <span className="ml-1 text-red-600 text-[10px]">證件到期</span>}
                  </td>
                  <td className="sticky z-10 bg-white border border-gray-300 px-1 text-xs" style={{ left: leftOffsets.staffNo, width: COL_STAFF_NO, position: "sticky" }}>
                    {row.staffNo}
                  </td>
                  {!isBrokerSession && (
                    <td className="sticky z-10 bg-white border border-gray-300 px-1 text-xs" style={{ left: leftOffsets.broker, width: COL_BROKER, position: "sticky" }}>
                      {broker?.name ?? row.brokerId ?? ""}
                    </td>
                  )}
                  {dayList.map((d) => {
                    const key = cellKeyOf(row.key, d);
                    const c = cells.get(key);
                    const isDirty = !cellsEqual(baseline.get(key), c);
                    const selected = sel ? sel.b.r === r && sel.b.d === d : false;
                    const inRange = bounds ? r >= bounds.r0 && r <= bounds.r1 && d >= bounds.d0 && d <= bounds.d1 : false;
                    const isError = errorCellKey === key;
                    const code = c?.code ?? null;
                    const invalid = !!code && code !== row.shiftTypeCode && !LEAVE_CODES.includes(code);
                    const isEditingHere = editing && selected;

                    let cls = "border border-gray-300 text-center text-sm h-8 align-middle cursor-cell";
                    if (monthLocked) cls += " bg-gray-100 text-gray-400 cursor-not-allowed";
                    else if (isError) cls += " bg-red-200 text-red-900 font-semibold";
                    else if (invalid) cls += " bg-red-100 text-red-700";
                    else if (!code) cls += " bg-white";
                    else if (c?.status === "pending_approval") cls += " bg-yellow-200 text-yellow-900 font-medium";
                    else if (!c?.status) cls += " bg-gray-200 text-gray-800";
                    else if (c.status === "draft") cls += " bg-gray-200 text-gray-800";
                    else cls += " bg-emerald-50 text-emerald-900 font-medium";
                    if (isDirty) cls += " ring-2 ring-inset ring-blue-500";
                    if (selected) cls += " outline outline-2 -outline-offset-2 outline-indigo-600";
                    else if (inRange) cls += " bg-indigo-100";

                    return (
                      <td
                        key={d}
                        className={cls}
                        style={{ width: COL_DAY }}
                        title={c?.status ? `狀態：${c.status}` : undefined}
                        data-testid={`roster-cell-${r}-${d}`}
                        onMouseDown={(e) => onCellMouseDown(r, d, { shiftKey: e.shiftKey })}
                        onMouseEnter={() => onCellMouseEnter(r, d)}
                        onClick={(e) => onCellClick(r, d, e.shiftKey)}
                        onDoubleClick={() => onCellDoubleClick(r, d)}
                      >
                        {isEditingHere ? (
                          <input
                            autoFocus
                            className="w-full h-full text-center bg-white outline-none"
                            value={editText}
                            maxLength={4}
                            onChange={(e) => setEditText(e.target.value.toUpperCase())}
                            onBlur={commitEdit}
                          />
                        ) : (
                          code ?? ""
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={4 + (isBrokerSession ? 0 : 1) + days} className="border border-gray-300 text-center text-gray-400 py-6 text-sm">
                  {allRows.length === 0
                    ? "呢個盤呢個月未有更表記錄——撳「加保安員」開始排更，或者撳「複製上月」。"
                    : "呢個雞頭喺呢個盤搵唔到保安員行（篩選只影響顯示，其他雞頭嘅記錄照喺度）。"}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky z-10 bg-gray-50 border border-gray-300 font-medium" style={{ left: leftOffsets.shiftType, position: "sticky" }} colSpan={3 + (isBrokerSession ? 0 : 1)}>
                Total
              </td>
              {dayTotals.map((t, i) => (
                <td key={i} className="border border-gray-300 text-center bg-gray-50">
                  {t}
                </td>
              ))}
            </tr>
            <tr>
              <td className="sticky z-10 bg-gray-50 border border-gray-300 font-medium" style={{ left: leftOffsets.shiftType, position: "sticky" }} colSpan={3 + (isBrokerSession ? 0 : 1)}>
                所需人手
              </td>
              {dayList.map((d) => (
                <td key={d} className="border border-gray-300 text-center bg-gray-50">
                  {dailyReq[d - 1] ?? 0}
                </td>
              ))}
            </tr>
            <tr>
              <td className="sticky z-10 bg-gray-50 border border-gray-300 font-medium" style={{ left: leftOffsets.shiftType, position: "sticky" }} colSpan={3 + (isBrokerSession ? 0 : 1)}>
                尚欠
              </td>
              {dayList.map((d) => {
                const short = Math.max(0, (dailyReq[d - 1] ?? 0) - dayTotals[d - 1]);
                return (
                  <td key={d} className={`border border-gray-300 text-center bg-gray-50 ${short > 0 ? "text-red-600 font-semibold" : ""}`}>
                    {short}
                  </td>
                );
              })}
            </tr>
            {/* 老闆 feedback 2026-09-12：篩選咗某個雞頭時加多一行「所選
                雞頭合計」——Total／尚欠一律照計全部（唔受篩選影響，見上面
                dayTotals 注解），呢行先係篩選範圍嘅合計。 */}
            {selectedBrokerTotals && (
              <tr data-testid="roster-selected-broker-total">
                <td className="sticky z-10 bg-blue-50 border border-gray-300 font-medium text-blue-900" style={{ left: leftOffsets.shiftType, position: "sticky" }} colSpan={3 + (isBrokerSession ? 0 : 1)}>
                  所選雞頭合計（{selectedBrokerCode}）
                </td>
                {selectedBrokerTotals.map((t, i) => (
                  <td key={i} className="border border-gray-300 text-center bg-blue-50 text-blue-900">
                    {t}
                  </td>
                ))}
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {fillRowKey && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={() => setFillRowKey(null)}>
          <div className="bg-white rounded shadow-lg p-4 w-72 space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-gray-700">
              整行填滿（成個月 {days} 日全部填同一個代號）——更別代號或者請假代號（AL/NL/RD/SL/SH）：
            </p>
            <input
              autoFocus
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
    </div>
  );
}
