# 在勤保安排更管理系統

內部系統：保安員排更、價目、結算、月結（一鍵結算）、報表、長工糧、AI 助手。老闆／主管／會計用電腦，雞頭（供應商）與保安員用手機。

> 呢個 repo 唔准有真人姓名／工號／電話／身份證／銀行資料（PDPO）。真實數據一律放喺 gitignored 嘅 `data/`、`tools/importer/out/`，只喺本機 runtime 讀入。

## 技術棧

- Next.js 15（App Router）＋ React 19 ＋ TypeScript ＋ Tailwind CSS 4
- Prisma 6 ＋ PostgreSQL（本機用 `embedded-postgres`，生產用 Zeabur 新加坡）
- 認證：iron-session cookie；權限：`src/lib/rbac/`（角色 × module × action 矩陣）
- 測試：Vitest（隔離臨時 PG）＋ Playwright（e2e）
- xlsx：ExcelJS；AI 助手：Anthropic SDK／DeepSeek（`src/lib/ai/`，唯讀）

## 本機起法

```bash
npm install
cp .env.example .env         # 填 DATABASE_URL、SESSION_SECRET；.env 已 gitignore
npm run db:start             # 起本機 embedded-postgres（背景 daemon，.pg/）
npm run db:reset             # 由零：停 → 刪 .pg/ → 起 → migrate deploy
npm run db:seed              # 讀 tools/importer/out + data/（本機資料）
npm run dev                  # http://localhost:3000
```

Seed 測試帳號（假電話）見 `.env.example` 註解。

## 測試

```bash
npx tsc --noEmit && npm run lint   # 型別＋ESLint（0 warning）
npm test                           # Vitest（獨立臨時 PG，唔掂開發庫）
npm run test:e2e                   # Playwright（會自己起 dev server；PW_PORT 可改 port）
npm run build                      # 生產 build（先 rm -rf .next）
npm run gate:locked-months         # 7／8 月已鎖定，任何改動前後都要證明數字唔變（12 步，約 10 分鐘）
npx knip                           # 死碼／多餘 export（knip.json：scripts／tests 當 entry）
```

## 目錄

| 路徑 | 內容 |
|---|---|
| `src/app/(app)/` | 登入後頁面（更表編輯器 `roster/`、保安員 `guards/`、月結 `month-close/`、報表 `reports/` …） |
| `src/app/api/` | REST API（欄位 snake_case；權限用 `requirePermission`） |
| `src/lib/` | 業務邏輯（`pricing/`、`month-close/`、`reports/`、`roster-upload/`、`rbac/`、`ai/` …） |
| `src/components/` | 共用 UI（`ui/` 為 Button／Banner／ConfirmDialog／DataTable 等唯一實作） |
| `prisma/` | schema＋migrations |
| `scripts/` | 啟動腳本（`db/`）、gate（`gate/`）、一次性匯入；已完結嘅歸檔喺 `scripts/archive/` |
| `tests/` | Vitest；`tests/e2e/` 為 Playwright |
| `docs/` | `api.md`、`ai-assistant.md`、`perf-2026-10/`（P3 分析附錄） |

## 設計與計劃文件（repo 根目錄）

- `在勤系統設計文件.md` — 系統設計藍圖（權限矩陣等）
- `README-P1.md` — P1 骨架／seed／報表重出／認證細節
- `P2-版面重設計計劃.md`、`P3-UI重構與效能優化計劃.md` — 各階段計劃與落實紀錄（P3 §8 為各階段紀錄、§9 為前後對照總表）

## 部署

Docker 映像（`Dockerfile`，多階段 build，`npm ci --include=dev`）部署去 Zeabur 新加坡。每次啟動先 `prisma migrate deploy`，再跑 `scripts/db/` 嘅幂等校正腳本，最後起 Next standalone server。部署前須通過：tsc／lint／vitest／build／Playwright 全綠，並跑 `gate:locked-months` 12/12。
