// 更表編輯器動作（P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變）——
// 儲存／重新計價／還原／複製上月／加保安員／整行填，以及儲存 toast 狀態。
"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { apiGetAll, apiPost, ApiClientError } from "@/lib/api-client";
import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
import type {
  BatchResponse,
  BrokerDto,
  CellState,
  GuardDto,
  RowMeta,
  ShiftRecordDto,
  ShiftTypeDto,
  UnpricedGroup,
} from "./roster-types";
import { LEAVE_CODES } from "./roster-types";
import {
  cellKeyOf,
  cellsEqual,
  dayOfMonthFromIso,
  daysInMonth,
  normalizeCode,
  parseMonthStr,
  prevMonthStr,
  workDateStr,
} from "./roster-utils";

export function useRosterActions({
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
}: {
  siteId: string;
  month: string;
  siteName: string;
  year: number;
  monthNum: number;
  days: number;
  monthLocked: boolean;
  allRows: RowMeta[];
  baseline: Map<string, CellState>;
  cells: Map<string, CellState>;
  setCells: Dispatch<SetStateAction<Map<string, CellState>>>;
  setExtraRows: Dispatch<SetStateAction<RowMeta[]>>;
  setReloadTick: Dispatch<SetStateAction<number>>;
  skipExtraRowsResetRef: MutableRefObject<boolean>;
  shiftTypesById: Map<string, ShiftTypeDto>;
  guardsById: Map<string, GuardDto>;
  brokersById: Map<string, BrokerDto>;
  setErrorBanner: Dispatch<SetStateAction<string | null>>;
  setInfoBanner: Dispatch<SetStateAction<string | null>>;
  setErrorCellKey: Dispatch<SetStateAction<string | null>>;
  setWarnings: Dispatch<SetStateAction<string[]>>;
  setEditing: Dispatch<SetStateAction<boolean>>;
  askConfirm: (opts: ConfirmOptions) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  // WP-R2：儲存成功 toast（README §04「儲存後 Toast」）——右下深色 toast，
  // 3 秒後自動消失。
  const [showSaveToast, setShowSaveToast] = useState(false);
  // WP-PRICE：儲存呢次帶嚟嘅未定價數（null＝呢次儲存全部有價，唔顯示
  // 警告字眼；>0＝toast 改講「已儲存 · N 格未定價」）。
  const [saveToastUnpriced, setSaveToastUnpriced] = useState<number | null>(null);
  // P0（Opus 驗收重現）：儲存呢次帶嚟嘅「冇結算單位」格數——呢批更
  // 唔止未定價，係喺糧明細完全消失，一定要獨立、更顯眼咁警告。
  const [saveToastNoSettlement, setSaveToastNoSettlement] = useState<number | null>(null);
  // B1-5（WP-ATTRIB）：儲存呢次帶嚟「結算單位推算」（settlement_
  // inferred，見 batch/route.ts）嘅格數——推算唔係錯，但建議會計覆核，
  // 用溫和色（唔似 saveToastNoSettlement 咁緊急），優先序最低。
  const [saveToastSettlementInferred, setSaveToastSettlementInferred] = useState<number | null>(null);
  useEffect(() => {
    if (!showSaveToast) return;
    const t = setTimeout(() => setShowSaveToast(false), 3000);
    return () => clearTimeout(t);
  }, [showSaveToast]);

  // 加保安員 modal
  // B1-5（WP-ATTRIB）：逐行結算單位覆寫——用戶喺「雞頭」欄改咗某一行嘅
  // 結算單位（未儲存前純前端狀態，key＝row.key），儲存嗰陣（仲有畀新格
  // 用嘅 fallback，見 handleSave 嘅 diffCells 建構）同「複製上月」review
  // 都會讀呢個 map。冇喺呢度出現嘅行照用 row.brokerId（原本嘅預設值）。
  const [rowBrokerOverrides, setRowBrokerOverrides] = useState<Map<string, string>>(new Map());
  // EMP-P1：用戶喺工號格手揀咗邊張工號卡（rowKey → staff_number_id）；儲存時寫入該行有送出嘅格
  const [rowStaffOverrides, setRowStaffOverrides] = useState<Map<string, string>>(new Map());
  const [showAddGuard, setShowAddGuard] = useState(false);
  const [addGuardId, setAddGuardId] = useState("");
  const [addShiftTypeId, setAddShiftTypeId] = useState("");
  // B1-5（WP-ATTRIB）：加保安員嗰陣可以揀結算單位——空字串代表「跟返揀咗
  // 嗰個保安員嘅 default_broker_id」（見 handleAddGuardRow）。
  const [addBrokerId, setAddBrokerId] = useState("");

  // 整行填
  const [fillRowKey, setFillRowKey] = useState<string | null>(null);
  const [fillRowValue, setFillRowValue] = useState("");

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
    [days, setCells, setErrorBanner],
  );

  // ---- 複製上月（同盤同人）----------------------------------------------
  const handleCopyPrevMonth = useCallback(async () => {
    if (monthLocked) return;
    setErrorBanner(null);
    setInfoBanner(null);
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
      // 必修 1(b)（Opus 第二輪驗收）：PR（code="PR"，糧明細生成對數佔位
      // 更別）唔可以隨「複製上月」原封搬入新月份——batch/route.ts 對
      // 新建 PR 記錄一律 400，如果唔喺呢度攔截，「複製上月」會將 7 月
      // PR 記錄複製落 cells，撳「儲存」嗰下先撞 400（用戶體驗差，仲要
      // 逐格排查邊格撞）。用 Set 記低跳過咗邊幾行（guard+更別），唔係
      // 逐格計。
      const skippedPrRowKeys = new Set<string>();
      for (const r of prevRecords) {
        const day = dayOfMonthFromIso(r.work_date);
        if (day > days) continue; // 今個月冇呢個日數（例如上月31號、今個月得30日）——跳過
        const rowKey = `${r.shift_type_id}|${r.guard_id}`;
        const st = shiftTypesById.get(r.shift_type_id);
        if (st?.code === "PR") {
          skippedPrRowKeys.add(rowKey);
          continue;
        }
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
            tel: "", // P3-2.4：輕量 guards 唔帶電話；RowMeta.tel 本來就唔顯示
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
      if (skippedPrRowKeys.size > 0) {
        setInfoBanner(`已略過 ${skippedPrRowKeys.size} 行對數佔位更別（PR）——呢類更別淨係 P0 匯入時對數用，唔可以排更。`);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "複製上月失敗");
    }
  }, [monthLocked, month, siteId, allRows, cells, days, shiftTypesById, guardsById, setCells, setErrorBanner, setExtraRows, setInfoBanner]);

  // ---- 加保安員：純前端加一行空行，未填格儲存之前唔會出現喺下次 reload ----
  const guardOptions = useMemo(() => [...guardsById.values()].sort((a, b) => a.name_zh.localeCompare(b.name_zh)), [guardsById]);
  // B1-5（WP-ATTRIB）：結算單位選項——任務書寫「該盤 broker_site_
  // assignments 嘅雞頭＋公司兵＋長工單位」，呢度用返本身已經攞晒嘅
  // `brokersById`（`/api/brokers` 全公司範圍，冇再打 broker-site-
  // assignments API 逐盤篩窄）——選項會多過任務書要求嘅範圍（多過該
  // 盤有份嘅雞頭），但唔會少（唔會漏），已知落差見回報。
  const brokerSelectOptions = useMemo(() => [...brokersById.values()].sort((a, b) => a.code.localeCompare(b.code)), [brokersById]);
  // 必修 1(b)（Opus 第二輪驗收）：「加保安員」嘅更別選項一律剔走
  // code="PR"（對數佔位更別，唔可以排更——見 batch/route.ts 新建 400）。
  const shiftTypeOptions = useMemo(
    () => [...shiftTypesById.values()].filter((s) => !s.voided_at && s.code !== "PR").sort((a, b) => a.code.localeCompare(b.code)),
    [shiftTypesById],
  );

  const handleAddGuardRow = useCallback(() => {
    if (!addGuardId || !addShiftTypeId) return;
    const rowKey = `${addShiftTypeId}|${addGuardId}`;
    if (allRows.some((r) => r.key === rowKey)) {
      setShowAddGuard(false);
      setAddGuardId("");
      setAddShiftTypeId("");
      setAddBrokerId("");
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
        tel: "", // P3-2.4：輕量 guards 唔帶電話；RowMeta.tel 本來就唔顯示
        // B1-5：人手揀咗結算單位就用嗰個，冇揀先跌返 guard.default_broker_id。
        brokerId: addBrokerId || guard?.default_broker_id || null,
      },
    ]);
    setShowAddGuard(false);
    setAddGuardId("");
    setAddShiftTypeId("");
    setAddBrokerId("");
  }, [addGuardId, addShiftTypeId, addBrokerId, allRows, guardsById, shiftTypesById, setExtraRows]);

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
    const diffCells: { guard_id: string; shift_type_id: string; work_date: string; code: string | null; settlement_broker_id?: string; staff_number_id?: string }[] = [];
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
      // P0（Opus 驗收重現）：之前呢度冇送 settlement_broker_id，令新建
      // 記錄（「複製上月」／新增格）完全冚做 guard.default_broker_id
      // fallback——93 個長工/公司兵保安員嗰個欄係 NULL，條記錄就喺糧明細
      // 消失。`row.brokerId`（RowMeta，見 buildRowsAndCells／
      // handleCopyPrevMonth／handleAddGuardRow）已經帶咗「複製嘅來源
      // 記錄值」或者「呢行現有嘅結算單位」——送埋出去等 batch route 唔使
      // 淨係靠 guard 嘅 default 值。`?? undefined`：null 唔可以直接送
      // （schema 淨係 `uuid.optional()`，唔准 null），冇值就交返俾
      // server 端更深嘅 fallback 鏈（同盤/任何盤最近一條、長工桶…）。
      //
      // 應修 2：`row.brokerId` 係「呢一整行」（同一 shift_type_id+guard_id）
      // 嘅結算單位，但同一行入面唔同日可以有唔同嘅 settlement_broker_id
      // （例如舊月份逐日人手指定過）。`b?.id` 有值即代表呢個格本身已經
      // 存在一條記錄——淨係改咗 code（唔係新建），呢種情況唔可以再送
      // row 級嘅 brokerId 落去，否則會用同一行嘅值覆蓋咗呢一格自己原有
      // 、可能唔同嘅結算單位。只有「新建格」（`b?.id` 冇值——新增行／
      // 複製上月新落嘅格）先至送 settlement_broker_id，等後端 fallback
      // 鏈有嘢跟；既有記錄唔送，由後端保留該記錄原值。
      const isExistingRecord = !!b?.id;
      // B1-5：用戶喺「雞頭」欄手動覆寫咗呢行嘅結算單位（rowBrokerOverrides）
      // 就優先用嗰個，冇覆寫先跌返 row.brokerId（原本嘅預設值）。
      const effectiveBrokerId = rowBrokerOverrides.get(rowKey) ?? row.brokerId ?? undefined;
      diffCells.push({
        guard_id: row.guardId,
        shift_type_id: row.shiftTypeId,
        work_date: workDateStr(year, monthNum, day),
        code,
        ...(isExistingRecord ? {} : { settlement_broker_id: effectiveBrokerId }),
        ...(rowStaffOverrides.has(rowKey) ? { staff_number_id: rowStaffOverrides.get(rowKey)! } : {}),
      });
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
      // WP-PRICE：呢次儲存有未定價格就喺 toast 講清楚（唔准靜靜當儲存
      // 成功；`reloadTick`＋1 同時會觸發上面嘅未定價 Notice 刷新）。
      setSaveToastUnpriced(res.pricing && res.pricing.unpriced > 0 ? res.pricing.unpriced : null);
      setSaveToastNoSettlement(res.no_settlement_count && res.no_settlement_count > 0 ? res.no_settlement_count : null);
      setSaveToastSettlementInferred(res.settlement_inferred_count && res.settlement_inferred_count > 0 ? res.settlement_inferred_count : null);
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
  }, [monthLocked, saving, allRows, baseline, cells, siteId, month, year, monthNum, rowBrokerOverrides, rowStaffOverrides, setErrorBanner, setErrorCellKey, setReloadTick, setWarnings, skipExtraRowsResetRef]);

  // WP-PRICE §M3：「重新計價」——價目卡補咗／改咗之後，一鍵將呢個盤呢個
  // 月全部 shift 記錄嘅 snapshot 追返卡（見 POST /api/shift-records/
  // reprice）。M3（Opus 驗收「reprice 清空數據」修正）：改為 dry-run 預覽
  // →確認流程——先用 `dry_run:true`（預設）攞 diff 摘要（changed／
  // unchanged／kept_unresolved），用 confirm() 俾用戶睇過先至真係
  // `dry_run:false` 寫入（唔再係「撳咗就即刻覆蓋成個盤」嘅單一 confirm）。
  type RepriceDryRunResult = { changed: number; unchanged: number; kept_unresolved: number; unpriced: number; groups: UnpricedGroup[] };
  const [repricing, setRepricing] = useState(false);
  const handleReprice = useCallback(async () => {
    if (repricing) return;
    setRepricing(true);
    setInfoBanner(null);
    try {
      // 必修 2（Opus 第二輪驗收）：dry-run 預覽淨係用嚟俾用戶睇 diff 摘要
      // （confirm() 嗰句文字入面），**唔再** `setUnpricedSummary(...)`
      // 覆蓋頁首 banner——dry-run 冇寫 DB，banner 應該繼續顯示緊「而家
      // DB 入面真實」嘅未定價數（由 `/api/shift-records/unpriced`、即
      // `buildUnpricedSummary()` 提供），唔可以俾 reprice 自己嗰套
      // 「模擬」數頂替咗。
      const preview = await apiPost<RepriceDryRunResult>("/api/shift-records/reprice", { month, site_id: siteId, dry_run: true });
      if (preview.changed === 0) {
        setInfoBanner(`重新計價預覽：呢個盤呢個月冇任何更次嘅收客價／出街價會變（同現有 snapshot 一致），${preview.unpriced} 更仍然未定價（冇對應價目卡）。冇嘢寫入。`);
        return;
      }
      const keptNote = preview.kept_unresolved > 0 ? `（其中 ${preview.kept_unresolved} 更資料庫搵唔到對應卡，保留原有 snapshot 唔會清走）` : "";
      const proceed = await askConfirm({
        message: `重新計價預覽 ${month}（${siteName || siteId}）：${preview.changed} 更嘅收客價／出街價會改變，${preview.unchanged} 更不變${keptNote}，仲有 ${preview.unpriced} 更未定價。確定要寫入？`,
        confirmLabel: "寫入",
      });
      if (!proceed) {
        return;
      }
      const res = await apiPost<{ repriced: number; changed: number; unchanged: number; kept_unresolved: number; unpriced: number; groups: UnpricedGroup[] }>(
        "/api/shift-records/reprice",
        { month, site_id: siteId, dry_run: false },
      );
      // 必修 2：寫入成功之後**唔用 reprice 回覆嘅數覆蓋 banner**——
      // `setReloadTick` 會觸發上面嗰個 `apiGet("/api/shift-records/
      // unpriced", ...)` 嘅 useEffect 重新 fetch 權威數字（同
      // `buildUnpricedSummary()` 一致），banner 用嗰個。
      skipExtraRowsResetRef.current = true;
      setReloadTick((t) => t + 1);
      setErrorBanner(null);
      setInfoBanner(`重新計價完成：${res.repriced} 更已改寫，仲有 ${res.unpriced} 更未定價。`);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "重新計價失敗");
    } finally {
      setRepricing(false);
    }
  }, [repricing, month, siteId, siteName, askConfirm, setErrorBanner, setInfoBanner, setReloadTick, skipExtraRowsResetRef]);

  const handleRevert = useCallback(() => {
    setCells(new Map(baseline));
    setExtraRows([]);
    setErrorBanner(null);
    setErrorCellKey(null);
    setEditing(false);
  }, [baseline, setCells, setEditing, setErrorBanner, setErrorCellKey, setExtraRows]);

  return {
    saving,
    showSaveToast,
    saveToastUnpriced,
    saveToastNoSettlement,
    saveToastSettlementInferred,
    rowBrokerOverrides,
    setRowBrokerOverrides,
    rowStaffOverrides,
    setRowStaffOverrides,
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
  };
}
