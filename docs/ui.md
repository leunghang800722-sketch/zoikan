# UI 規則（手機／覆蓋層／返回）

## 覆蓋層必須用 `useHistoryOverlay`
- 任何蓋住頁面嘅元件（Drawer、對話框、手機抽屜、全屏側欄）一律用 `src/lib/ui/use-history-overlay.ts` 嘅 `useHistoryOverlay(open, onClose, key, enabled?)`。
- 原因：「加到主畫面」（`manifest.display: "standalone"`）冇瀏覽器返回掣；Android 系統返回／iOS 手勢如果覆蓋層唔喺 history，會直接離開成頁。hook 開覆蓋層時 `pushState`（同一 URL），返回（popstate）只關覆蓋層；UI 關閉經 hook 嘅 `close()`（`history.back()` 由 popstate 去關）。
- 嵌套用唔同 `key`，後開先關。導航離開覆蓋層（例如抽屜入面撳連結）用 `closeForNavigation()`，留低嘅舊 entry 由全域 popstate 自動跳過。
- AI 助手側欄只喺 `< lg`（全屏）入 history（`enabled=isMobile`），桌面側欄照舊。`ConfirmDialog` 唔使。
- 唔好改 `useMonthState`／month-store 嘅 `replaceState`（只同步 query，唔加紀錄）。

## 手機頂欄返回
- `MobileNav` 頂欄（`< lg` 每頁，首頁 `/` 除外）左邊有「‹」（`aria-label="返回上一頁"`，testid `mobile-nav-back`）。
- `src/lib/ui/back-nav.ts`：`NavHistoryTracker`（`(app)/layout`）將頁面 stack 記入 `sessionStorage`（上限 50）；`goBack`：有上一頁就 `router.back()`，否則去父路徑（`parentPath`：深層頁返所屬 index，例如 `/month-close/files` → `/month-close`），再否則 `/`。
- 頁內「‹ 返回…」連結用 `BackLink`（同一 `goBack`，`href` 係冇紀錄時嘅去處）。
- 桌面（`lg` 以上）唔加頂欄返回。

## 分診對話框（要你睇）
- 載入：`useTriagePager`（頭 5 題、剩 ≤3 題背景 prefetch）；counts 取自 session，唔受分頁影響。
- 頂部左邊「‹ 返回列表」（＝關對話框）；題目區底「‹ 上一題／下一題 ›」回看本次對話框內處理過嘅題（已答只讀、跳過可重新答）。
- 位置記喺 `sessionStorage`（`zk-triage-pos-<session id>`），重開顯示「由第 N 題繼續」＋「由頭開始」（連跳過咗嘅一齊攞）。
