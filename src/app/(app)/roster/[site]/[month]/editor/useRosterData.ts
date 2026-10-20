// 更表編輯器資料層（P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變）——
// 載入／重新 fetch（儲存成功之後 `reloadTick` 變就重跑）、靜態資料快取、
// 未定價摘要。載入完成後要重置嘅 UI 狀態（警告／錯誤／選格）由容器經
// `onLoadedRef` 注入，呼叫位置同搬出前一致。
"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { apiGet, apiGetAll, ApiClientError } from "@/lib/api-client";
import { cachedLookup } from "@/lib/ui/lookup-cache";
import { cachedRows } from "@/lib/ui/lookups";
import type {
  RosterStaffNumbersDto,
  StaffCardDto,
  BrokerDto,
  CellState,
  DailyRequirementDto,
  GuardDto,
  MonthCloseDto,
  QuotaDto,
  RowMeta,
  ShiftRecordDto,
  ShiftTypeDto,
  SiteDto,
  UnpricedSummary,
} from "./roster-types";
import { buildRowsAndCells, dayOfMonthFromIso, daysInMonth, parseMonthStr, workDateStr } from "./roster-utils";

export function useRosterData({ siteId, month, onLoadedRef }: { siteId: string; month: string; onLoadedRef: MutableRefObject<() => void> }) {
  const [loading, setLoading] = useState(true);
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
  // WP-MISC（老闆 2026-09-20 拍板）：LINK 呢類「客戶直接出糧」嘅盤——頁
  // 頂 Notice 用（見下面「鎖定／提示橫幅」段）。
  const [guardsPaidByClient, setGuardsPaidByClient] = useState(false);
  // EMP-P1：盤 staff_scheme（顯示該盤體系工號）＋各 guard 嘅合資格工號卡
  const [staffScheme, setStaffScheme] = useState<string | null>(null);

  const [shiftTypesById, setShiftTypesById] = useState<Map<string, ShiftTypeDto>>(new Map());
  const [guardsById, setGuardsById] = useState<Map<string, GuardDto>>(new Map());
  const [brokersById, setBrokersById] = useState<Map<string, BrokerDto>>(new Map());

  const [rows, setRows] = useState<RowMeta[]>([]);
  const [extraRows, setExtraRows] = useState<RowMeta[]>([]); // 加保安員／複製上月加嘅新行，未儲存前冇 baseline
  const [baseline, setBaseline] = useState<Map<string, CellState>>(new Map());
  const [cells, setCells] = useState<Map<string, CellState>>(new Map());
  // 2026-09-12 老闆 feedback：雞頭篩選＋人數/更數統計條——保留原始
  // ShiftRecordDto 陣列（唔淨係聚合完嘅 rows/cells），俾統計條逐日/逐
  // 狀態計數（confirmed／pending 分開計）。
  const [records, setRecords] = useState<ShiftRecordDto[]>([]);

  const [dailyReq, setDailyReq] = useState<number[]>([]); // index0 = day1
  const [quotas, setQuotas] = useState<QuotaDto[]>([]);
  const [monthLocked, setMonthLocked] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // P3-2.4：靜態載入資料（同一盤同一月內，儲存／重新計價唔重拉）。
  const staticRef = useRef<{
    key: string;
    site: SiteDto;
    shiftTypes: ShiftTypeDto[];
    guards: GuardDto[];
    dailyRequirements: DailyRequirementDto[];
    quotaRows: QuotaDto[];
    monthCloses: MonthCloseDto[];
    brokers: BrokerDto[];
  } | null>(null);

  // WP-PRICE §3：頁首持續顯示嘅「呢個月有 N 更未定價」Notice——載入時同
  // 儲存後（`reloadTick` 一齊帶）刷新，用 GET /api/shift-records/unpriced。
  const [unpricedSummary, setUnpricedSummary] = useState<UnpricedSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<UnpricedSummary>("/api/shift-records/unpriced", { month, site_id: siteId })
      .then((res) => {
        if (!cancelled) setUnpricedSummary(res);
      })
      .catch(() => {
        // 未定價 Notice 純粹 additive 提示，攞唔到就靜靜唔顯示（唔阻住成個更表編輯器）。
        if (!cancelled) setUnpricedSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, month, reloadTick]);
  const skipExtraRowsResetRef = useRef(false);

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
        const workDateFrom = workDateStr(y, m, 1);
        const workDateTo = workDateStr(y, m, d);

        // P3-2.4（附錄 b A-9）：靜態資料（盤資料、更種、保安員輕量表、雞頭、每日所需人手、配額、
        // 月結鎖定狀態）同「更次記錄」分開——儲存／重新計價（reloadTick）之後淨係重拉
        // shift-records，唔再重拉 guards／brokers／month-closes 等。guards／brokers／month-closes
        // 另經模組級 lookup cache（60 s，寫入相關資源即作廢），同一分頁切換盤時唔重複打。
        const staticKey = `${siteId}|${month}`;
        const fetchRecords = () =>
          apiGetAll<ShiftRecordDto>("/api/shift-records", { site_id: siteId, work_date_from: workDateFrom, work_date_to: workDateTo, view: "grid" });
        let st = staticRef.current?.key === staticKey ? staticRef.current : null;
        let records: ShiftRecordDto[];
        if (st) {
          records = await fetchRecords();
        } else {
          const [site, shiftTypes, recs, guards, dailyRequirements, quotaRows, monthCloses, brokers] = await Promise.all([
            apiGet<SiteDto>(`/api/sites/${siteId}`),
            apiGetAll<ShiftTypeDto>("/api/shift-types", { site_id: siteId }),
            fetchRecords(),
            cachedRows<GuardDto>("/api/guards?fields=lite"),
            apiGetAll<DailyRequirementDto>("/api/daily-requirements", { site_id: siteId, work_date_from: workDateFrom, work_date_to: workDateTo }),
            apiGetAll<QuotaDto>("/api/quotas", { site_id: siteId, month }),
            cachedLookup(`monthclose:${month}`, () => apiGetAll<MonthCloseDto>("/api/month-closes", { month })),
            cachedRows<BrokerDto>("/api/brokers"),
          ]);
          if (cancelled) return;
          records = recs;
          st = { key: staticKey, site, shiftTypes, guards, dailyRequirements, quotaRows, monthCloses, brokers };
          staticRef.current = st;
        }
        if (cancelled) return;
        const { site, shiftTypes, guards, dailyRequirements, quotaRows, monthCloses, brokers } = st;
        const brokerSession = !("created_by" in site);
        setIsBrokerSession(brokerSession);
        setSiteName(site.canonical_name);
        setHasRosterLayout(site.has_roster_layout ?? false);
        setGuardsPaidByClient(site.guards_paid_by_client ?? false);
        setStaffScheme(site.staff_scheme ?? null);
        // EMP-P1：盤有設定 scheme 先去拎工號卡（雞頭 session／未設定盤唔使）
        const cardsByGuard = new Map<string, StaffCardDto[]>();
        if (!brokerSession && site.staff_scheme && site.staff_scheme !== "U") {
          try {
            const sn = await apiGet<RosterStaffNumbersDto>(`/api/sites/${siteId}/roster-staff-numbers`, { month });
            for (const g of sn.guards) cardsByGuard.set(g.guard_id, g.cards);
          } catch {
            // 純顯示用，攞唔到就跌返 guards.staff_no，唔阻住編輯器
          }
        }

        const stMap = new Map(shiftTypes.map((s) => [s.id, s]));
        const gMap = new Map(guards.map((g) => [g.id, g]));
        const bMap = new Map(brokers.map((b) => [b.id, b]));
        setShiftTypesById(stMap);
        setGuardsById(gMap);
        setBrokersById(bMap);

        setRecords(records);
        const built = buildRowsAndCells(records, stMap, gMap, { scheme: site.staff_scheme ?? null, cardsByGuard });
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

        onLoadedRef.current();
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
  }, [siteId, month, reloadTick, onLoadedRef]);

  return {
    loading,
    slowLoading,
    forbidden,
    loadError,
    isBrokerSession,
    siteName,
    hasRosterLayout,
    guardsPaidByClient,
    staffScheme,
    shiftTypesById,
    guardsById,
    brokersById,
    rows,
    extraRows,
    setExtraRows,
    baseline,
    cells,
    setCells,
    records,
    dailyReq,
    quotas,
    monthLocked,
    reloadTick,
    setReloadTick,
    staticRef,
    skipExtraRowsResetRef,
    unpricedSummary,
  };
}
