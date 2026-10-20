// 更表編輯器格仔表（表頭／逐行／合計）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MutableRefObject, RefObject, SetStateAction } from "react";
import { Button } from "@/components/ui/Button";
import { brokerColor } from "@/lib/ui/broker-color";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import { DayCell } from "./DayCell";
import type { BrokerDto, CellState, GuardDto, RowMeta, SelRange, WaCellInfo } from "./roster-types";
import { fmtDateTime } from "@/lib/ui/format";

/** tooltip 用：訊息時間（香港時間、短格式）。 */
const fmtWaTime = (iso: string): string => fmtDateTime(iso);
import { LEAVE_CODES } from "./roster-types";
import {
  cellKeyOf,
  cellsEqual,
  coverageColor,
  DESK_COL_BROKER,
  DESK_COL_DAY,
  DESK_COL_SHIFT_TYPE,
  DESK_FIXED_TOTAL,
  MOBILE_COL_DAY,
  MOBILE_COL_NAME,
  MOBILE_KEYPAD_HEIGHT,
  type DayMeta,
} from "./roster-utils";

export function RosterGrid({
  compact,
  isBrokerSession,
  days,
  dayList,
  dayMetaList,
  year,
  monthNum,
  monthLocked,
  visibleRows,
  allRows,
  guardsById,
  brokersById,
  cells,
  baseline,
  sel,
  editing,
  editAnchor,
  editText,
  setEditText,
  keyBuffer,
  errorCellKey,
  dayTotals,
  dailyReq,
  selectedBrokerTotals,
  selectedBrokerCode,
  rowBrokerOverrides,
  setRowBrokerOverrides,
  rowStaffOverrides,
  setRowStaffOverrides,
  brokerSelectOptions,
  fillRowKey,
  setFillRowKey,
  setFillRowValue,
  containerRef,
  pointerTypeRef,
  onKeyDown,
  mobileKeypadRow,
  mobileKeypadDay,
  onCellMouseDown,
  onCellMouseEnter,
  onCellClick,
  onCellDoubleClick,
  openContextMenu,
  commitEdit,
  waInfo,
}: {
  compact: boolean;
  isBrokerSession: boolean;
  days: number;
  dayList: number[];
  dayMetaList: DayMeta[];
  year: number;
  monthNum: number;
  monthLocked: boolean;
  visibleRows: RowMeta[];
  allRows: RowMeta[];
  guardsById: Map<string, GuardDto>;
  brokersById: Map<string, BrokerDto>;
  cells: Map<string, CellState>;
  baseline: Map<string, CellState>;
  sel: SelRange | null;
  editing: boolean;
  editAnchor: { r: number; d: number } | null;
  editText: string;
  setEditText: (v: string) => void;
  keyBuffer: { r: number; d: number; text: string } | null;
  errorCellKey: string | null;
  dayTotals: number[];
  dailyReq: number[];
  selectedBrokerTotals: number[] | null;
  selectedBrokerCode: string | null;
  rowBrokerOverrides: Map<string, string>;
  setRowBrokerOverrides: Dispatch<SetStateAction<Map<string, string>>>;
  rowStaffOverrides: Map<string, string>;
  setRowStaffOverrides: Dispatch<SetStateAction<Map<string, string>>>;
  brokerSelectOptions: BrokerDto[];
  fillRowKey: string | null;
  setFillRowKey: (key: string | null) => void;
  setFillRowValue: (v: string) => void;
  containerRef: RefObject<HTMLDivElement | null>;
  pointerTypeRef: MutableRefObject<string>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  mobileKeypadRow: RowMeta | null;
  mobileKeypadDay: number | null;
  onCellMouseDown: (r: number, d: number, e: { shiftKey: boolean }) => void;
  onCellMouseEnter: (r: number, d: number) => void;
  onCellClick: (r: number, d: number, shiftKey: boolean) => void;
  onCellDoubleClick: (r: number, d: number) => void;
  openContextMenu: (r: number, d: number, x: number, y: number) => void;
  commitEdit: () => void;
  /** W3：來自 WhatsApp 嘅格仔 tooltip 資料（record id → 原訊息資訊） */
  waInfo?: Map<string, WaCellInfo>;
}) {
  // ---- WP-R2：桌面／手機固定欄闊度（README §04/§23）--------------------
  // EMP-P1：人喺呢個盤有多過一張合資格工號卡 → 工號格可手揀（儲存時寫 payload staff_number_id）；否則淨係顯示號碼。
  const staffNoCell = (row: RowMeta) =>
    row.staffCards && !monthLocked && !isBrokerSession ? (
      <select
        aria-label={`${row.guardName || row.guardId} 工號卡`}
        data-testid="roster-row-staffcard-select"
        value={rowStaffOverrides.get(row.key) ?? row.staffCardId ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          setRowStaffOverrides((prev) => {
            const next = new Map(prev);
            if (v && v !== row.staffCardId) next.set(row.key, v);
            else next.delete(row.key);
            return next;
          });
        }}
        style={{ fontSize: 10.5, padding: "0 2px", borderRadius: 4, maxWidth: 110 }}
      >
        {row.staffCards.map((c) => (
          <option key={c.id} value={c.id}>
            {c.number}
            {c.status === "former" ? "（已取消）" : ""}
          </option>
        ))}
      </select>
    ) : (
      row.staffNo
    );

  const showBrokerCol = !isBrokerSession && !compact;
  const deskNameWidth = DESK_FIXED_TOTAL - DESK_COL_SHIFT_TYPE - (showBrokerCol ? DESK_COL_BROKER : 0);
  const nameColWidth = compact ? MOBILE_COL_NAME : deskNameWidth;
  const leftOffsets = compact
    ? { name: 0 }
    : { shiftType: 0, name: DESK_COL_SHIFT_TYPE, broker: DESK_COL_SHIFT_TYPE + deskNameWidth };
  const fixedTotal = compact ? MOBILE_COL_NAME : DESK_FIXED_TOTAL;
  const dayColW = compact ? MOBILE_COL_DAY : DESK_COL_DAY;
  const rowH = compact ? 44 : 38;

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

    const chip = invalid ? { bg: "var(--zk-danger-tint)", fg: "var(--zk-danger-dark)", border: undefined } : shiftCodeStyle(code, { isLeave, isDraft });
    const wa = c?.source === "whatsapp" && c.id ? waInfo?.get(c.id) : undefined;
    const waText = wa ? [wa.group_label, wa.message_ts ? fmtWaTime(wa.message_ts) : null, wa.text ? `「${wa.text.length > 120 ? `${wa.text.slice(0, 120)}…` : wa.text}」` : null, wa.source_changed ? (wa.revoked ? "⚠ 原訊息已被發訊人撤回" : "⚠ 原訊息已被發訊人修改") : null].filter(Boolean).join("｜") : "";
    const title = c?.status ? `${c.source === "whatsapp" ? `來自 WhatsApp｜${waText ? `${waText}｜` : ""}` : ""}狀態：${c.status}（已排 ${dayTotals[d - 1]} / 所需 ${dailyReq[d - 1] ?? 0}）` : undefined;

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
    <>
      {/* ================= 格仔表（README §04/§23） ================= */}
      <div className="overflow-hidden rounded-lg border border-zk-border bg-white" style={{ opacity: monthLocked ? 0.8 : 1 }}>
        <div
          ref={containerRef}
          onPointerDown={(e) => {
            pointerTypeRef.current = e.pointerType;
          }}
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
                    className="sticky top-0 z-20 bg-zk-header text-left text-zk-xs font-semibold text-zk-muted"
                    style={{ left: leftOffsets.shiftType, width: DESK_COL_SHIFT_TYPE, minWidth: DESK_COL_SHIFT_TYPE, position: "sticky", borderRight: "1px solid var(--zk-border)", borderBottom: "1px solid var(--zk-border)", padding: "8px 0 8px 12px" }}
                  >
                    更別
                  </th>
                )}
                <th
                  className="sticky top-0 z-20 bg-zk-header text-left text-zk-xs font-semibold text-zk-muted"
                  style={{
                    left: leftOffsets.name,
                    width: nameColWidth,
                    minWidth: nameColWidth,
                    position: "sticky",
                    borderRight: compact || !showBrokerCol ? "1px solid var(--zk-border)" : undefined,
                    borderBottom: "1px solid var(--zk-border)",
                    padding: compact ? "0 12px" : "8px 10px",
                    boxShadow: compact ? "2px 0 6px rgba(0,0,0,.04)" : undefined,
                  }}
                >
                  {compact ? "姓名" : "姓名 / 工號"}
                </th>
                {showBrokerCol && (
                  <th
                    className="sticky top-0 z-20 bg-zk-header text-left text-zk-xs font-semibold text-zk-muted"
                    style={{ left: leftOffsets.broker, width: DESK_COL_BROKER, minWidth: DESK_COL_BROKER, position: "sticky", borderRight: "1px solid var(--zk-border)", borderBottom: "1px solid var(--zk-border)", padding: "8px 10px" }}
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
                      style={{ width: dayColW, background: m.headerBg, borderBottom: "1px solid var(--zk-border)", padding: "5px 0" }}
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
                // B1-5：呢行有冇手動覆寫過結算單位（rowBrokerOverrides），
                // 冇就跌返 row.brokerId（原本嘅預設值）。
                const effectiveRowBrokerId = rowBrokerOverrides.get(row.key) ?? row.brokerId;
                const broker = effectiveRowBrokerId ? brokersById.get(effectiveRowBrokerId) : null;
                const bc = brokerColor(broker?.code);
                return (
                  <tr
                    key={row.key}
                    data-testid="roster-row"
                    data-row-index={r}
                    data-row-key={row.key}
                    className="hover:bg-zk-header"
                    style={{ height: rowH, borderBottom: "1px solid var(--zk-surface)" }}
                  >
                    {!compact && (
                      <td
                        className="sticky z-10 bg-white text-center text-xs text-zk-muted"
                        style={{ left: leftOffsets.shiftType, width: DESK_COL_SHIFT_TYPE, minWidth: DESK_COL_SHIFT_TYPE, position: "sticky", borderRight: "1px solid var(--zk-border)" }}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span>{row.shiftTypeCode}</span>
                          <Button variant="link" size="sm"
                            type="button"
                            disabled={monthLocked}

                            onClick={() => {
                              setFillRowKey(row.key === fillRowKey ? null : row.key);
                              setFillRowValue("");
                            }}
                          >
                            整行
                          </Button>
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
                        borderRight: compact || !showBrokerCol ? "1px solid var(--zk-border)" : undefined,
                        boxShadow: compact ? "2px 0 6px rgba(0,0,0,.04)" : undefined,
                      }}
                    >
                      {compact ? (
                        // WP-R2 第 12 項：手機行高固定 44px，姓名格淨係
                        // 兩行（名／雞頭·工號）——證件到期呢類第三行 44px
                        // 塞唔落，compact 唔顯示（桌面照樣顯示）。
                        <div className="flex h-full flex-col justify-center gap-0.5 px-3 py-1">
                          <div className="truncate text-zk-base font-medium text-zk-text" title={row.guardName || "(未命名)"}>
                            {row.guardName || "(未命名)"}
                          </div>
                          <div className="flex items-center gap-1 truncate text-zk-2xs text-zk-faint">
                            {broker && (
                              <span className="font-semibold" style={{ color: bc.dot }}>
                                {broker.code}
                              </span>
                            )}
                            {broker && row.staffNo ? "·" : ""}
                            {staffNoCell(row)}
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-baseline gap-2 px-2.5">
                          <span className="truncate text-zk-base font-medium" title={row.guardName || "(未命名)"}>
                            {row.guardName || "(未命名)"}
                          </span>
                          <span className="shrink-0 text-zk-xs text-zk-faint">{staffNoCell(row)}</span>
                          {permitExpired && <span className="shrink-0 text-zk-2xs text-zk-danger">證件到期</span>}
                        </div>
                      )}
                    </td>
                    {showBrokerCol && (
                      <td className="sticky z-10 bg-white px-1.5" style={{ left: leftOffsets.broker, width: DESK_COL_BROKER, position: "sticky", borderRight: "1px solid var(--zk-border)" }}>
                        {/* B1-5（WP-ATTRIB）：內部角色可以逐行改結算單位
                            （對新格生效——已存在嘅格唔受影響，見
                            handleSave 嘅 isExistingRecord 判斷）；鎖定月
                            份／雞頭 session 唔見呢個控制，淨係顯示 pill。 */}
                        {monthLocked ? (
                          broker && (
                            <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: bc.bg, color: bc.fg }}>
                              {broker.code}
                            </span>
                          )
                        ) : (
                          <select
                            aria-label={`${row.guardName || row.guardId} 結算單位`}
                            data-testid="roster-row-broker-select"
                            value={effectiveRowBrokerId ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRowBrokerOverrides((prev) => {
                                const next = new Map(prev);
                                if (v) next.set(row.key, v);
                                else next.delete(row.key);
                                return next;
                              });
                            }}
                            style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 2px", borderRadius: 4, background: bc.bg, color: bc.fg, border: "none", maxWidth: DESK_COL_BROKER - 8 }}
                          >
                            <option value="">（未指定）</option>
                            {brokerSelectOptions.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.code}
                              </option>
                            ))}
                          </select>
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
                  className="sticky z-10 bg-zk-header text-zk-xs text-zk-muted"
                  style={{ left: 0, position: "sticky", borderTop: "1px solid var(--zk-border)", padding: "7px 12px" }}
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
                        className="text-center text-zk-xs font-semibold"
                        style={{ borderTop: "1px solid var(--zk-border)", padding: "7px 0", color: "var(--zk-text-secondary)" }}
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
                      style={{ borderTop: "1px solid var(--zk-border)", padding: compact ? "5px 0" : "6px 0" }}
                      title={`已排 ${t} / 所需 ${req}`}
                    >
                      <div className="text-zk-xs font-semibold" style={{ color: coverageColor(t, req) }}>
                        {t}
                      </div>
                      <div className="text-zk-2xs text-zk-faint">{req}</div>
                    </td>
                  );
                })}
              </tr>
              {selectedBrokerTotals && (
                <tr data-testid="roster-selected-broker-total">
                  <td
                    className="sticky z-10 text-zk-xs font-medium"
                    style={{ left: 0, position: "sticky", borderTop: "1px solid var(--zk-border)", padding: "7px 12px", background: "var(--zk-primary-tint-soft)", color: "var(--zk-primary-deep)" }}
                    colSpan={compact ? 1 : 2 + (showBrokerCol ? 1 : 0)}
                  >
                    所選雞頭合計（{selectedBrokerCode}）
                  </td>
                  {selectedBrokerTotals.map((t, i) => (
                    <td key={i} className="text-center text-zk-xs" style={{ borderTop: "1px solid var(--zk-border)", background: "var(--zk-primary-tint-soft)", color: "var(--zk-primary-deep)" }}>
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
    </>
  );
}
