// 更表編輯器（P1-WP3，設計文件§6.1/§6.2/§4.1/§4.2）——以現有 Excel 更表為
// 視覺藍本：一「行」=(shift_type_id, guard_id) 組合（`key =
// shiftTypeId|guardId`，同 scripts/report/roster.ts 一致嘅分組口徑），
// 一「列」= day 1..月尾。格顯示 record_type=shift/ot 時用
// shift_type.code，record_type=leave 時用 leave_code。
//
// 儲存＝一次過送 POST /api/shift-records/batch（樂觀 UI＋失敗回滾，唔逐格
// 即時打 API）——見 src/app/api/shift-records/batch/route.ts 頂註解。
"use client";
//
// P3-5.1：原本單檔 ~2,800 行，拆成 editor/ 目錄（純搬移，行為零改變，
// 所有 data-testid 不變）：
//   RosterEditor.tsx      容器（state 接線＋組合）
//   useRosterData.ts      載入／重新 fetch／靜態資料快取／未定價摘要
//   useCellSelection.ts   選格／編輯／拖選／鍵盤／手機鍵盤 buffer／右鍵選單
//   useRosterActions.ts   儲存／重新計價／還原／複製上月／加保安員／整行填
//   RosterHeader / RosterBrokerStats / RosterNotices / RosterGrid /
//   MobileKeyboard / ContextMenu / FillRowModal / AddGuardModal / SaveToast
//   roster-types.ts／roster-utils.ts  型別、純函數
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { invalidateLookups } from "@/lib/ui/lookup-cache";
import { confirmLeaveIfUnsaved, setUnsavedCount } from "@/lib/ui/unsaved-guard";
import { rememberMonth } from "@/lib/ui/month-store";
import { MQ_BELOW_SM } from "@/lib/ui/breakpoints";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { AddGuardModal } from "./AddGuardModal";
import { ContextMenu } from "./ContextMenu";
import { FillRowModal } from "./FillRowModal";
import { MobileKeyboard } from "./MobileKeyboard";
import { RosterBrokerStats } from "./RosterBrokerStats";
import { RosterGrid } from "./RosterGrid";
import { RosterHeader } from "./RosterHeader";
import { QuotaStrip, RosterNotices } from "./RosterNotices";
import { SaveToast } from "./SaveToast";
import type { RowMeta } from "./roster-types";
import { MOBILE_KEYPAD_LEAVE_CODES } from "./roster-types";
import {
  cellsEqual,
  computeBrokerStats,
  dayMeta,
  daysInMonth,
  hongKongTodayYMD,
  isEffectiveShiftCell,
  parseMonthStr,
} from "./roster-utils";
import { useCellSelection } from "./useCellSelection";
import { useRosterActions } from "./useRosterActions";
import { useRosterData } from "./useRosterData";

export default function RosterEditor({ siteId, month, canReprice = false }: { siteId: string; month: string; canReprice?: boolean }) {
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
  const router = useRouter();
  const { year, monthNum } = parseMonthStr(month);
  const days = daysInMonth(year, monthNum);
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days]);
  // P3-3.2：月份來自路徑，記入 sessionStorage 等其他頁（月份選擇器）跟住呢個月。
  useEffect(() => {
    rememberMonth(month);
  }, [month]);

  // 2026-09-13 緊急：手機闊度下左邊固定四欄（56+96+88+104=344px）闊過整個容器（~324px），
  // 日期欄永遠被固定欄遮住，捲極都見唔到。compact（<640px）改用窄欄並收起工號／雞頭欄。
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MQ_BELOW_SM);
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // 雞頭篩選（老闆 feedback 2026-09-12）：揀住嘅雞頭代號（例如 "K"），
  // `null` = 全部。狀態放 URL query `?broker=K`（方便分享／重載保留）；
  // 淨係內部角色顯示篩選器（雞頭 session 本身淨見自己，冇篩選必要）。
  // 用 code（唔係內部 uuid）做 URL 值——同老闆講嘅「雞頭代號」一致。
  const [selectedBrokerCode, setSelectedBrokerCode] = useState<string | null>(null);
  const urlSyncedFromLoadRef = useRef(false);

  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // P3-4.2：取代 window.alert——一次過嘅結果提示（下一次動作時清走）。
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const [errorCellKey, setErrorCellKey] = useState<string | null>(null);

  // 載入完成後重置嘅 UI 狀態（警告／錯誤／選格）——由 useRosterData 喺
  // 載入成功嗰刻呼叫（位置同搬出前一致）。
  const onLoadedRef = useRef<() => void>(() => {});
  const {
    loading,
    slowLoading,
    forbidden,
    loadError,
    isBrokerSession,
    siteName,
    hasRosterLayout,
    guardsPaidByClient,
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
    setReloadTick,
    staticRef,
    skipExtraRowsResetRef,
    unpricedSummary,
  } = useRosterData({ siteId, month, onLoadedRef });

  const containerRef = useRef<HTMLDivElement | null>(null);
  // allRows＝呢個盤呢個月全部行（已儲存+未儲存新加嘅），唔受雞頭篩選
  // 影響——儲存 diff／複製上月／加保安員去重都要睇成個集合，先唔會漏
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


  const {
    sel,
    setSel,
    editing,
    setEditing,
    editText,
    setEditText,
    editAnchor,
    pointerTypeRef,
    keyBuffer,
    cancelKeyBuffer,
    applyMobileKeypadCode,
    commitEdit,
    clearSelectedRange,
    onKeyDown,
    onCellClick,
    onCellDoubleClick,
    onCellMouseDown,
    onCellMouseEnter,
    contextMenu,
    openContextMenu,
    closeContextMenu,
  } = useCellSelection({ cells, setCells, setErrorCellKey, displayRowsRef, visibleRows, days, compact, monthLocked, containerRef });
  onLoadedRef.current = () => {
    setWarnings([]);
    setErrorBanner(null);
    setErrorCellKey(null);
    setSel(null);
    setEditing(false);
  };

  const {
    saving,
    showSaveToast,
    saveToastUnpriced,
    saveToastNoSettlement,
    saveToastSettlementInferred,
    rowBrokerOverrides,
    setRowBrokerOverrides,
    showAddGuard,
    setShowAddGuard,
    addGuardId,
    setAddGuardId,
    addShiftTypeId,
    setAddShiftTypeId,
    addBrokerId,
    setAddBrokerId,
    fillRowKey,
    setFillRowKey,
    fillRowValue,
    setFillRowValue,
    applyFillRow,
    handleCopyPrevMonth,
    guardOptions,
    brokerSelectOptions,
    shiftTypeOptions,
    handleAddGuardRow,
    handleSave,
    repricing,
    handleReprice,
    handleRevert,
  } = useRosterActions({
    siteId,
    month,
    siteName,
    year,
    monthNum,
    days,
    monthLocked,
    allRows,
    baseline,
    cells,
    setCells,
    setExtraRows,
    setReloadTick,
    skipExtraRowsResetRef,
    shiftTypesById,
    guardsById,
    brokersById,
    setErrorBanner,
    setInfoBanner,
    setErrorCellKey,
    setWarnings,
    setEditing,
    askConfirm,
  });

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


  // ---- 雞頭人數／更數統計條（老闆 feedback 2026-09-12）------------------
  // W2：WhatsApp 分診答題寫入、仍待批核嘅格數（頁首提示用）
  const waPending = useMemo(() => records.filter((r) => r.source === "whatsapp" && r.status === "pending_approval").length, [records]);
  const brokerStats = useMemo(() => computeBrokerStats(records, guardsById, brokersById, quotas), [records, guardsById, brokersById, quotas]);

  // ---- 畫面 ---------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-6 text-sm text-zk-muted">
        載入緊更表……
        {slowLoading && (
          <div className="mt-3 rounded border border-zk-warning-border bg-zk-warning-bg p-3 text-zk-warning-dark">
            載入時間比平時長（超過 15 秒）——可能係網絡慢或者登入已過期。
            <div className="mt-2 flex gap-2">
              <Button variant="primary" size="md" type="button" onClick={() => window.location.reload()}>重新載入</Button>
              <a href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`} className="rounded border border-zk-input-border px-3 py-1.5 text-sm hover:bg-zk-header">重新登入</a>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-3" data-testid="roster-forbidden">
        <h1 className="text-xl font-semibold text-zk-dark">冇權限或搵唔到呢個盤</h1>
        <p className="text-sm text-zk-text-secondary">{forbidden}——你可能冇份呢個盤，或者個網址打錯。</p>
        <Link href="/" className="inline-block text-zk-primary underline text-sm">
          返首頁
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center space-y-3">
        <h1 className="text-xl font-semibold text-zk-dark">讀取失敗</h1>
        <p className="text-sm text-zk-text-secondary">{loadError}</p>
        <Button variant="secondary" size="md"
          type="button"

          onClick={() => {
            invalidateLookups();
            staticRef.current = null;
            setReloadTick((t) => t + 1);
          }}
        >
          重試
        </Button>
      </div>
    );
  }



  // 該盤全部有效更別代號——頁首「N 日 · 更別 …」＋未鎖定提示條圖例＋手機
  // 鍵盤按鍵都用呢個（Fable 規劃判斷，P2-版面重設計計劃.md §2：「31 日 ·
  // 更別 D」改為列出全部代號，唔跟原型淨顯示一個）。
  // 同一個代號（例如「D」）喺呢個盤可以對應多個 shift_type 記錄（唔同
  // id，例如唔同時段／唔同人手要求但沿用同一個代號字面）——呢度淨係想
  // 列出「呢個盤有邊啲代號」，用 Set 去重先至唔會顯示重複代號。
  const siteShiftCodes = [...new Set(shiftTypeOptions.map((s) => s.code))];

  // 手機底部更別鍵盤（README §23）：揀住單一格、未鎖定、冇喺 inline
  // 編輯（桌面專用路徑，compact 已經喺 onCellDoubleClick 禁咗）先顯示。
  // 按鍵＝呢一行嘅更別代號（一定 valid，因為 row 本身固定咗
  // shift_type_id）＋請假代號，唔重複、唔寫死 D/N/SH/RD/AL（Fable 規劃
  // 判斷，P2-版面重設計計劃.md §2）。
  const mobileKeypadRow: RowMeta | null =
    compact && !monthLocked && !editing && sel && sel.a.r === sel.b.r && sel.a.d === sel.b.d ? (visibleRows[sel.b.r] ?? null) : null;
  const mobileKeypadDay = mobileKeypadRow ? sel!.b.d : null;
  // 必修 1(b)（Opus 第二輪驗收）：手機鍵盤剔走 code="PR"（對數佔位更別，
  // 唔可以排更）——就算呢一行本身係歷史 PR 行（例如揭返 7 月鎖定咗嘅
  // 記錄），都唔俾用戶經手機鍵盤撳「PR」呢粒鍵（新建會撞 batch 400）。
  const mobileKeypadKeys = mobileKeypadRow
    ? [
        ...(mobileKeypadRow.shiftTypeCode === "PR" ? [] : [mobileKeypadRow.shiftTypeCode]),
        ...MOBILE_KEYPAD_LEAVE_CODES.filter((code) => code !== mobileKeypadRow.shiftTypeCode),
      ]
    : [];


  return (
    <div className="flex flex-col gap-3">
      {confirmDialog}
      <RosterHeader
        compact={compact}
        siteName={siteName}
        siteId={siteId}
        month={month}
        year={year}
        monthNum={monthNum}
        days={days}
        siteShiftCodes={siteShiftCodes}
        dirtyCount={dirtyCount}
        monthLocked={monthLocked}
        saving={saving}
        hasRosterLayout={hasRosterLayout}
        goMonth={goMonth}
        setShowAddGuard={setShowAddGuard}
        handleCopyPrevMonth={handleCopyPrevMonth}
        handleRevert={handleRevert}
        handleSave={handleSave}
      />

      {brokerStats.length > 0 && (
        <RosterBrokerStats
          brokerStats={brokerStats}
          compact={compact}
          isBrokerSession={isBrokerSession}
          selectedBrokerCode={selectedBrokerCode}
          setSelectedBrokerCode={setSelectedBrokerCode}
        />
      )}

      <RosterNotices
        monthLocked={monthLocked}
        month={month}
        compact={compact}
        siteShiftCodes={siteShiftCodes}
        guardsPaidByClient={guardsPaidByClient}
        unpricedSummary={unpricedSummary}
        canReprice={canReprice}
        repricing={repricing}
        handleReprice={handleReprice}
        warnings={warnings}
        errorBanner={errorBanner}
        infoBanner={infoBanner}
        waPending={waPending}
      />

      <RosterGrid
        compact={compact}
        isBrokerSession={isBrokerSession}
        days={days}
        dayList={dayList}
        dayMetaList={dayMetaList}
        year={year}
        monthNum={monthNum}
        monthLocked={monthLocked}
        visibleRows={visibleRows}
        allRows={allRows}
        guardsById={guardsById}
        brokersById={brokersById}
        cells={cells}
        baseline={baseline}
        sel={sel}
        editing={editing}
        editAnchor={editAnchor}
        editText={editText}
        setEditText={setEditText}
        keyBuffer={keyBuffer}
        errorCellKey={errorCellKey}
        dayTotals={dayTotals}
        dailyReq={dailyReq}
        selectedBrokerTotals={selectedBrokerTotals}
        selectedBrokerCode={selectedBrokerCode}
        rowBrokerOverrides={rowBrokerOverrides}
        setRowBrokerOverrides={setRowBrokerOverrides}
        brokerSelectOptions={brokerSelectOptions}
        fillRowKey={fillRowKey}
        setFillRowKey={setFillRowKey}
        setFillRowValue={setFillRowValue}
        containerRef={containerRef}
        pointerTypeRef={pointerTypeRef}
        onKeyDown={onKeyDown}
        mobileKeypadRow={mobileKeypadRow}
        mobileKeypadDay={mobileKeypadDay}
        onCellMouseDown={onCellMouseDown}
        onCellMouseEnter={onCellMouseEnter}
        onCellClick={onCellClick}
        onCellDoubleClick={onCellDoubleClick}
        openContextMenu={openContextMenu}
        commitEdit={commitEdit}
      />

      {mobileKeypadRow && mobileKeypadDay !== null && (
        <MobileKeyboard
          mobileKeypadRow={mobileKeypadRow}
          mobileKeypadDay={mobileKeypadDay}
          mobileKeypadKeys={mobileKeypadKeys}
          monthNum={monthNum}
          cancelKeyBuffer={cancelKeyBuffer}
          applyMobileKeypadCode={applyMobileKeypadCode}
        />
      )}

      <ContextMenu
        contextMenu={contextMenu}
        visibleRows={visibleRows}
        cells={cells}
        clearSelectedRange={clearSelectedRange}
        closeContextMenu={closeContextMenu}
        setFillRowKey={setFillRowKey}
        setFillRowValue={setFillRowValue}
        applyFillRow={applyFillRow}
      />

      <FillRowModal
        fillRowKey={fillRowKey}
        fillRowValue={fillRowValue}
        setFillRowKey={setFillRowKey}
        setFillRowValue={setFillRowValue}
        visibleRows={visibleRows}
        days={days}
        applyFillRow={applyFillRow}
      />

      <AddGuardModal
        showAddGuard={showAddGuard}
        setShowAddGuard={setShowAddGuard}
        addGuardId={addGuardId}
        setAddGuardId={setAddGuardId}
        addShiftTypeId={addShiftTypeId}
        setAddShiftTypeId={setAddShiftTypeId}
        addBrokerId={addBrokerId}
        setAddBrokerId={setAddBrokerId}
        guardOptions={guardOptions}
        shiftTypeOptions={shiftTypeOptions}
        brokerSelectOptions={brokerSelectOptions}
        isBrokerSession={isBrokerSession}
        guardsById={guardsById}
        brokersById={brokersById}
        handleAddGuardRow={handleAddGuardRow}
      />

      {quotas.length > 0 && <QuotaStrip quotas={quotas} shiftTypesById={shiftTypesById} brokersById={brokersById} />}

      <SaveToast
        showSaveToast={showSaveToast}
        saveToastNoSettlement={saveToastNoSettlement}
        saveToastUnpriced={saveToastUnpriced}
        saveToastSettlementInferred={saveToastSettlementInferred}
      />
    </div>
  );
}
