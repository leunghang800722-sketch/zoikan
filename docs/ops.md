# 在勤 運維說明：排程器、email 通知、自動開新月（P7）、自動化第二批（P8）

## 1. 一句講晒
App 起身時（Next.js `src/instrumentation.ts`，Node runtime）起一個每分鐘 tick 嘅排程器。到期 job 先攞 PG advisory lock，再認領（`scheduled_jobs.next_run_at` 先推進），跑完寫 `job_runs`（started／finished／status／summary）同 `scheduled_jobs.last_*`。結果以**站內通知**（首頁「通知」區、側欄「首頁」未讀 badge、`/notifications`）為主，有設 SMTP 同用戶電郵就加寄 email。

## 2. Job 清單（時間一律香港時間；老闆可喺「設定 › 自動排程」`/settings/jobs` 改 cron、開關、立即跑）
| key | 預設時間 | 做乜 | 寫入？ |
|---|---|---|---|
| `open_next_month` | 每月 25 日 09:00（`0 9 25 * *`） | 開「下個月」：`openMonth()`（複製掛盤／配額／每日需求，冪等）；價目卡只自動複製**價錢同上月一樣**嘅（經 `applyCopyLastMonthCards`，audit actor＝null、`by_job`）；價錢有變／新組合／月中改價嘅唔寫，通知「N 張價卡要你確認」並喺首頁出「價卡待確認」卡（`/rate-cards?month=…&pending=1` 自動開預覽）；目標月已鎖→跳過並通知。同月通知只一條（dedupe） | 是（經現有 lib＋鎖月檢查） |
| `nightly_month_health` | 每晚 21:00（`0 21 * * *`） | 對本月同未鎖嘅上月跑 `buildMonthHealth`；有**新**紅項（critical）先通知（dedupe＝紅項 hash）；全綠＋一鍵結算 run done→通知「可以鎖月」 | 否（唯讀；只寫通知／job_runs） |
| `triage_reminder` | 每日 09:00（`0 9 * * *`） | 負責人有超過 2 日未答嘅分診題→通知佢（每人每日一條） | 否（唯讀） |
| `auto_one_click` | 每 5 分鐘（`*/5 * * * *`） | P8.1：未鎖月份有新上載（靜置 ≥10 分鐘）→ 自動跑 `runOneClickMonthClose`（同手動掣同一個 lib、同一條全域 advisory xact lock）；完成→通知老闆＋會計「N 題要你答、未定價 N 更」＋連結 `/month-close?month=`；失敗／halt（例如上月未鎖、precheck 未齊）→ 同樣通知，原因一句 | 是（經現有一鍵結算 lib；actor＝排程系統帳號、所有 audit 帶 `after.by_job`） |
| `after_lock_exports` | 每 5 分鐘 | P8.3：`month_closes.locked_at` 新於 `state.last_processed_lock_at` 嘅月份 → 用現有匯出 lib（`writeBuffer`，唔落 tmp 檔）生成 4 份存入 `generated_files`：糧明細 Excel、月結總表 Excel、Postorder 格式總表、BOCHK autopay 檔（該月未計長工糧就跳過並寫明）；通知老闆＋會計「N 份檔已備妥」＋連結 `/month-close/files?month=`（文案提醒 autopay 入銀行前要人覆核） | 只寫 `generated_files` 同通知（唔改業務資料） |
| `permit_expiry_weekly` | 逢星期一 09:00（`0 9 * * 1`） | P8.4：牌照（現算值）／平安卡／QAS：30 日內到期 N 人、已過期但本月／下月仍有排更 M 人；通知主管＋老闆，連結 `/guards?expiring=30`；全部 0 就唔通知；同週一條（dedupe） | 否（唯讀） |
| `lock_ops_digest` | 每 5 分鐘 | P8.5：鎖月後生成每月修正摘要（`buildOpsDigest`）→ 通知老闆：數字摘要一定有；有 AI 設定就附 AI 摘要（經現有輸出 guard＋`assertNoPii`；失敗／guard 觸發／疑似含 PII 就只推數字）；同月只推一次；連結 `/reports/ops-digest?month=` | 否（唯讀；AI 用量寫一行 `ai_chat` audit，actor＝系統帳號＋`by_job`） |

### 2b. 「唔會自動跑」嘅情況（P8.1 `auto_one_click`）
- 月份已鎖（`month_closes.locked_at`）。
- 有一鍵結算 run 跑緊（任何月份，全域 busy；`applyStartedAt` 15 分鐘內）。
- 最新上載（`uploaded`／`parsed`／`confirmed`）未滿 10 分鐘——等齊所有檔先跑。
- 最新上載時間唔新過該月最後一次 run 嘅 `started_at`（冇新檔）；或同一批上載已觸發過（`scheduled_jobs.state.last_trigger_upload_at[月份]`＝觸發時嘅最新上載時間）。**失敗唔會每 5 分鐘無限重跑**：要人睇完通知再手動撳，或再上載新檔。
- **首次跑（`state` 空）唔觸發**：只記每個未鎖月份而家嘅最新上載時間做 baseline（job_runs.summary 有 `baseline`），之後有更新嘅上載先自動跑（避免部署當日將已有上載全部重跑）。
- **唔會自動鎖月**（鎖月仍要人簽收）。

### 2b-2. 排程系統帳號（P8 驗收 M1）
- `users` 內一個保留帳號：`tel=00000000`、name「系統排程」、`status=inactive`（登入 route 拒絕非 active → 401）、`password_hash` 係永遠 match 唔到嘅非 bcrypt 字串、角色＝老闆（job 內部經 lib 寫入時有老闆權限）。id 唔 hardcode：Dockerfile CMD 啟動時跑 `scripts/db/ensure-system-user.ts`（`npm run db:ensure-system-user`，冪等；失敗只 warn），job 首次用時亦會 lazily 建立。
- 用途：所有 job 內部寫入嘅 actor／`month_close_runs.started_by`／價卡 `created_by`／AutoCollector 內部 audit。排程執行期間（`withAuditJob`，AsyncLocalStorage）**所有** `audit_log` 寫入自動帶 `after.by_job=<job key>`，actor 為 null 嘅舊 lib audit 補系統帳號（`auto_one_click`、其他 job 經 runner 一律）。老闆帳號停用唔影響 job。UI 操作人顯示「系統排程」。
- 分診 session 擁有人：自動 run＝該月最新有效上載者（active 而且有「一鍵結算:create」，例如會計），冇就系統帳號。**系統帳號擁有嘅 `month_close` session，任何有「一鍵結算:create」嘅人都可以睇／答／批量接受**（`triage/session.ts` `canAccessOwnedBy`；列表、待答 badge 一併包含）。
- **M3 伺服器端保護**：`POST /api/auth/login` 對 `tel=00000000` 一律 401（唔理 status／密碼）；`users/:id` PATCH／`void`／`unvoid`／`reset-password`／`notify` 對系統帳號一律 403 `system_account`；`/users` 頁該行只顯示「系統」標記，冇任何編輯／恢復／重設掣。
- 系統擁有嘅 session 只俾有「一鍵結算:create」嘅人睇／答（列表、待答 badge、AI 診斷同一規則）；`triage_reminder` 對系統擁有嘅逾期題通知老闆＋會計。
- 批量接受「任一題屬已鎖月份 → 整批 403、零寫入」只對**單一 request（≤50 題）**成立；前端分批時，前面批次已寫入，之後某批遇鎖月會停低並顯示失敗數（已寫入嘅唔會回滾，同逐題人手答一樣）。
- `audit_log` 對未登記 DTO 嘅表，`after` 只保留 `id`＋`by_job`／`auto_source`／`batch_id` 三個 meta key（原本放寬到全部 meta 白名單，已收窄）。

### 2c. `scheduled_jobs.state`（jsonb，P8）
job 自己嘅記憶，只存月份／時間戳，無 PII：`auto_one_click`＝`{ last_trigger_upload_at: { "YYYY-MM": ISO } }`；`after_lock_exports`、`lock_ops_digest`＝`{ last_processed_lock_at: ISO }`（首次跑只處理最近 31 日內鎖嘅月份，免得一次過為歷史月份出檔／推送）。重新鎖月（`locked_at` 變新）會重新出檔（舊版各保留 1 份，見 `/month-close/files`「上一版」）；摘要推送同月只一次。

### 2d. 鎖月後檔案（P8.3）
`generated_files`（bytea，`current` 標最新版；partial unique index 保證同月同 kind 只一份 current）。下載 `GET /api/files/:id`：權限＝原匯出 route 嘅 `export`（糧明細／月結總表／長工糧），雞頭 403；**BOCHK autopay 檔下載要 `?confirm_locked=1`**（沿用原 route 防重複出糧閘，頁面彈確認）；每次下載寫 `export_download` audit。糧明細檔內有保安員姓名／工號（同手動匯出一樣），受同一權限保護。

來源卡 `source` 以 `auto:` 開頭（一鍵自動定價、未經人確認）一律唔自動複製（`auto_source`，auto 卡只可 propose）。

價卡「同上月一樣」嘅定義（`classifyCopyCandidates`）：上月卡 `effective_to`＝上月最後一日；上上月最後一日仍生效嘅同 (盤, 更種, 雞頭) 卡四個價（收客價／出糧價／雞頭費／支付價）一致，且上月內冇新卡生效 → `same`。冇上上月卡 → `new`；價錢唔同 → `rate_changed`；上月內有新卡 → `changed_in_month`。

## 3. 環境變數（Zeabur 要老闆加）
| 變數 | 必須？ | 說明 |
|---|---|---|
| `SMTP_URL` | 否（冇設＝email 關閉） | nodemailer 連線字串，`smtps://用戶:密碼@主機:465`。**冇設時**只寫站內通知，log `[notify] email disabled` |
| `NOTIFY_FROM` | 否 | 寄件人顯示，例 `在勤 <notify@你的網域>`；預設 `在勤 <no-reply@zoikan.local>` |
| `APP_BASE_URL` | 否 | email 內連結根網址；預設 `https://zoikan.zeabur.app` |
| `JOB_TIMEOUT_MS` | 否 | 單個 job 最長執行毫秒，預設 600000 |
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

## 5b. 逾時同失敗重試
- 每個 job 最長執行時間 `JOB_TIMEOUT_MS`（預設 600000＝10 分鐘）；逾時記 `job_runs.status=timeout`、通知老闆（「自動排程超時」），排程唔再等、tick 照繼續。**底層 job 無法強制中止，所以 advisory lock 會持有到佢真正完成先釋放**：期間「立即跑」回 409 `job_running`、排程重試為 `skipped_locked`，避免同一 job 並發重複寫入。
- 排程跑失敗／逾時：1 小時後重試（唔遲過原本下次排程時間），連續最多重試 3 次，之後等下個排程；每次失敗都有 `job_failed` 通知。手動「立即跑」失敗唔重排。

## 6. 防重跑／多 instance
- 每次跑 job 先開一條專用 PG 連線攞 `pg_try_advisory_lock(hashtextextended('zoikan:job:<key>',0))`，攞唔到＝另一個 instance／run-now 跑緊，直接跳過。
- 攞到 lock 後再 `UPDATE scheduled_jobs SET next_run_at=<下次> WHERE next_run_at<=now` 認領，count=0＝已有人跑咗。
- 停機錯過嘅排程，重啟後第一個 tick 補跑一次（job 全部冪等）。

## 7. 相關檔案
`src/instrumentation.ts`、`src/lib/scheduler/{cron,lock,runner,start,state,types}.ts`、`src/lib/jobs/*`（P8：`auto-one-click`、`after-lock-exports`、`permit-expiry-weekly`、`lock-ops-digest`）、`src/lib/files/generated.ts`、`src/lib/triage/batch-accept.ts`、`src/lib/notify/*`、`src/lib/months/open-month.ts`、`prisma/migrations/20261011150000_p7_notifications_scheduler`、`20261012000000_p8_scheduled_job_state`、`20261012010000_p8_generated_files`。
