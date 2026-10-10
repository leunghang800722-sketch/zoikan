// 更表編輯器選格／編輯／拖選／鍵盤／右鍵選單（P3-5.1：由 RosterEditor.tsx
// 原樣搬出，行為零改變）。
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { CellState, RowMeta, SelRange } from "./roster-types";
import { MOBILE_KEYPAD_LEAVE_CODES } from "./roster-types";
import { cellKeyOf, clamp, MOBILE_KEYPAD_HEIGHT, normalizeCode } from "./roster-utils";

export function useCellSelection({
  cells,
  setCells,
  setErrorCellKey,
  displayRowsRef,
  visibleRows,
  days,
  compact,
  monthLocked,
  containerRef,
}: {
  cells: Map<string, CellState>;
  setCells: Dispatch<SetStateAction<Map<string, CellState>>>;
  setErrorCellKey: Dispatch<SetStateAction<string | null>>;
  displayRowsRef: MutableRefObject<RowMeta[]>;
  visibleRows: RowMeta[];
  days: number;
  compact: boolean;
  monthLocked: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
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
  // 最近一次 pointerdown 嘅輸入類型（mouse／touch／pen）：淨係滑鼠先容許 mouseenter 範圍拖選（見 onCellMouseEnter）。
  const pointerTypeRef = useRef<string>("mouse");
  const dragSourceRef = useRef<{ r: number; d: number; code: string | null } | null>(null);
  const dragCurrentRef = useRef<{ r: number; d: number } | null>(null);

  // WP-R2 第 4 項：右鍵選單（README Interactions：「右鍵選單：清除／整行
  // 填／整行清」）。`x`/`y` 用 `clientX`/`clientY`（fixed 定位）。
  const [contextMenu, setContextMenu] = useState<{ r: number; d: number; x: number; y: number } | null>(null);

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
  }, [setCells, setErrorCellKey]);

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
  }, [keyBuffer, applyMobileKeypadCode, clearKeyBufferTimer, displayRowsRef]);

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
  }, [editing, sel, editText, displayRowsRef, setCells, setErrorCellKey]);

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
  }, [sel, displayRowsRef, setCells]);

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
    [monthLocked, editing, sel, compact, keyBuffer, commitEdit, moveSelection, clearSelectedRange, startEdit, pushKeyBufferChar, flushKeyBuffer, cancelKeyBuffer, displayRowsRef],
  );

  const onCellClick = useCallback(
    (r: number, d: number, shiftKey: boolean) => {
      if (monthLocked) return;
      if (editing) commitEdit();
      setSel((prev) => (shiftKey && prev ? { a: prev.a, b: { r, d } } : { a: { r, d }, b: { r, d } }));
      containerRef.current?.focus({ preventScroll: true }); // 2026-09-12：統計條令容器可能半出視窗，focus() 會捲動頁面，令 mousedown→mouseup 落喺唔同格（拖選成兩行、click 唔觸發）
    },
    [monthLocked, editing, commitEdit, containerRef],
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
    [monthLocked, editing, commitEdit, visibleRows, cells, compact, containerRef],
  );

  const onCellMouseEnter = useCallback(
    (r: number, d: number) => {
      if (!draggingRef.current) return;
      // P3-3.8：觸控（pointerType≠mouse）冇拖曳填充。彈出底部鍵盤令表格容器縮細、格仔移位，指標下面換咗另一格會觸發
      // 合成 mouseenter，將單格選擇變範圍選擇（sel.a≠sel.b）→ 鍵盤即刻收埋（e2e wp-r2 (f)）。用 pointerType 判斷（唔用闊度），
      // 所以窄窗口嘅桌面滑鼠用家仍然可以拖曳填充。
      if (pointerTypeRef.current !== "mouse") return;
      dragCurrentRef.current = { r, d };
      setSel((prev) => (prev ? { a: prev.a, b: { r, d } } : prev));
    },
    [],
  );

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
  }, [displayRowsRef, setCells]);

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

  return {
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
  };
}
