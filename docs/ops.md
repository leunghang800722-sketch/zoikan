# 在勤 運維說明：排程器、email 通知、自動開新月（P7）

## 1. 一句講晒
App 起身時（Next.js `src/instrumentation.ts`，Node runtime）起一個每分鐘 tick 嘅排程器。到期 job 先攞 PG advisory lock，再認領（`scheduled_jobs.next_run_at` 先推進），跑完寫 `job_runs`（started／finished／status／summary）同 `scheduled_jobs.last_*`。結果以**站內通知**（首頁「通知」區、側欄「首頁」未讀 badge、`/notifications`）為主，有設 SMTP 同用戶電郵就加寄 email。

## 2. Job 清單（時間一律香港時間；老闆可喺「設定 › 自動排程」`/settings/jobs` 改 cron、開關、立即跑）
| key | 預設時間 | 做乜 | 寫入？ |
|---|---|---|---|
| `open_next_month` | 每月 25 日 09:00（`0 9 25 * *`） | 開「下個月」：`openMonth()`（複製掛盤／配額／每日需求，冪等）；價目卡只自動複製**價錢同上月一樣**嘅（經 `applyCopyLastMonthCards`，audit actor＝null、`by_job`）；價錢有變／新組合／月中改價嘅唔寫，通知「N 張價卡要你確認」並喺首頁出「價卡待確認」卡（`/rate-cards?month=…&pending=1` 自動開預覽）；目標月已鎖→跳過並通知。同月通知只一條（dedupe） | 是（經現有 lib＋鎖月檢查） |
| `nightly_month_health` | 每晚 21:00（`0 21 * * *`） | 對本月同未鎖嘅上月跑 `buildMonthHealth`；有**新**紅項（critical）先通知（dedupe＝紅項 hash）；全綠＋一鍵結算 run done→通知「可以鎖月」 | 否（唯讀；只寫通知／job_runs） |
| `triage_reminder` | 每日 09:00（`0 9 * * *`） | 負責人有超過 2 日未答嘅分診題→通知佢（每人每日一條） | 否（唯讀） |

價卡「同上月一樣」嘅定義（`classifyCopyCandidates`）：上月卡 `effective_to`＝上月最後一日；上上月最後一日仍生效嘅同 (盤, 更種, 雞頭) 卡四個價（收客價／出糧價／雞頭費／支付價）一致，且上月內冇新卡生效 → `same`。冇上上月卡 → `new`；價錢唔同 → `rate_changed`；上月內有新卡 → `changed_in_month`。

## 3. 環境變數（Zeabur 要老闆加）
| 變數 | 必須？ | 說明 |
|---|---|---|
| `SMTP_URL` | 否（冇設＝email 關閉） | nodemailer 連線字串，`smtps://用戶:密碼@主機:465`。**冇設時**只寫站內通知，log `[notify] email disabled` |
| `NOTIFY_FROM` | 否 | 寄件人顯示，例 `在勤 <notify@你的網域>`；預設 `在勤 <no-reply@zoikan.local>` |
| `APP_BASE_URL` | 否 | email 內連結根網址；預設 `https://zoikan.zeabur.app` |
| `SCHEDULER_ENABLED` | 否 | `1`／`0`。冇設＝production 開，dev／test 關。e2e（Playwright）固定 `0` |

Email 內容同站內通知 body 一樣：只有盤名／數字／id／月份，連結指向 `APP_BASE_URL`。用戶電郵由本人喺「改密碼」頁、或老闆喺「用戶」頁（`通知電郵`）設定；電郵屬聯絡資料，唔入 `ai` schema、唔入 AI 工具輸出、audit 只記「已改」。`notify_prefs` 可逐類關電郵（站內通知照常有）。

## 4. 試跑
1. 以老闆登入 → 設定 › 自動排程（`/settings/jobs`）→ 撳「立即跑」。手動跑**唔影響**下次排程時間，同排程共用 advisory lock（撞正跑緊會提示等一等）。
2. 想睇 `open_next_month` 嘅效果又唔想真開月：先用 `triage_reminder`／`nightly_month_health`（唯讀）試通知同 email；`open_next_month` 冪等，重跑唔會重複寫。
3. API：`POST /api/admin/jobs/<key>/run-now`；結果睇 `GET /api/admin/jobs` 的 `recent_runs`，或 DB 表 `job_runs`。

## 5. 停用／緊急剎車
- 單個 job：`/settings/jobs` 撳「停用」（`scheduled_jobs.enabled=false`，`next_run_at` 清空）。
- 整個排程器：Zeabur 設 `SCHEDULER_ENABLED=0` 後重啟。
- 只停 email：移除 `SMTP_URL`。
- 排程 job 出錯會通知老闆（`job_failed`），錯誤全文唔放通知，睇 `job_runs.summary`。機器重啟時遺留 >1 小時嘅 `running` 紀錄會被標為 `error`（`stale_running`）。

## 6. 防重跑／多 instance
- 每次跑 job 先開一條專用 PG 連線攞 `pg_try_advisory_lock(hashtextextended('zoikan:job:<key>',0))`，攞唔到＝另一個 instance／run-now 跑緊，直接跳過。
- 攞到 lock 後再 `UPDATE scheduled_jobs SET next_run_at=<下次> WHERE next_run_at<=now` 認領，count=0＝已有人跑咗。
- 停機錯過嘅排程，重啟後第一個 tick 補跑一次（job 全部冪等）。

## 7. 相關檔案
`src/instrumentation.ts`、`src/lib/scheduler/{cron,lock,runner,start,types}.ts`、`src/lib/jobs/*`、`src/lib/notify/*`、`src/lib/months/open-month.ts`、`prisma/migrations/20261011150000_p7_notifications_scheduler`。
