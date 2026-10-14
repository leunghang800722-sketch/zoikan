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
| `longterm_input_drafts` | 每日 21:30（`30 21 * * *`）；更表上載自動一鍵結算 done 後亦觸發一次 | P9.1：本月＋上月（未鎖）由更表 SL 日子生成「病假段（醫生紙待核）」**草稿**（`longterm_payroll_inputs.status=draft`；連續日合併一段、金額空、醫生紙＝未核、同日期集合 dedupe、更表改咗只更新未確認草稿、會計刪走嘅唔再生成、已確認嘅唔郁但出「更表同已確認輸入唔同」通知）；另計勤工獎合資格清單（更表冇 SL／NL／NPL；**唔建 input、唔填金額**）。通知會計「N 條草稿待確認」「勤工獎合資格 N 人」（body 只有月份／數字）。**老闆規則：草稿未確認唔計糧。** P10.3：同一個 job 另外按「頂位價目表」（`/settings/cover-rates`）為每位長工每月出一條「頂位津貼」草稿（金額＝逐更價之和；無價嘅盤／職級唔生成，通知老闆＋會計「N 個盤／職級未有頂位價，去設定 ›」；同月已有已確認頂位津貼就唔出）。鎖月月份唔生成 | 是（只寫 `status=draft` 輸入；actor＝排程系統帳號、audit 帶 `by_job`） |

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


### 頂位價目表（P10）
- 價目表 `/settings/cover-rates`：老闆改、會計睇。**改價＝新增一行新生效日**；生效區間覆蓋已鎖月份嘅價唔可以改額／作廢。價目表只影響「頂位草稿」金額；草稿要會計確認先計糧。
- 由歷史反推 `/settings/cover-rates/infer`（老闆專用、純唯讀）：揀月份→建議價（一致／多個價要揀／只得 1 次）＋推斷唔到清單＋回測；「採用」先寫價目表（`source=inferred`，生效日要係未鎖月份，預設本月 1 號）。正式站步驟見 P3 §14.1。
- 通知 `cover_rates_missing`：有頂位更但價目表冇價時，每個「缺價組合集合」（盤＋職級，唔計更數）只推一次；之後更數增加唔會再推，缺價組合增減先再推。

### 倒序重算長工糧（先重算較早月份，P15）

用途：已計咗較後月份（例如 8 月）之後要重算較早月份（例如 7 月）——`recompute` 會擋（「後月已計過」），要先作廢後月。

1. **（如月份已鎖）解鎖**：同 P14 步驟 1。只有未鎖月份可作廢。
2. **作廢最近一個已計月份**：長工糧頁 › 揀嗰個月 › 本月糧 › 「作廢本月計算（老闆）」填原因（`POST /api/longterm/payroll/:month/void`）。一次只可作廢最近一個月；後面仲有已計月份就逐個由最後一個開始作廢。成功提示會講回滾咗幾多人假期結餘；作廢對話框會先顯示「之前月份已計：有／冇」同「回滾方式：快照／精確重建／近似重建」；近似重建要額外剔確認先可作廢。如提示「N 人係舊資料重建」，代表呢批係 P15 前計過、冇快照，上月起算數係近似重建（「系統首次計算」嘅月份例外，回滾係精確），**重算後請抽查 AL／SL 已放日數**。
3. **（可選）批量導入平均工資**：「平均工資與假期」tab › 批量導入（`POST /api/longterm/avg-wages/bulk`，欄 `staff_no`／`staff_no_mw`／`name_en`／`avg_daily_wage`），數字以銀行用嘅 12 個月平均日薪（ADW）為準；冇導入 SL 4/5 同離職年假派彩會 fallback 月薪/當月日數。
4. **按日期順序重算**：先較早月份「重算本月」，再逐月計到最新（假期結餘逐月累積，順序錯會被擋）。
5. 作廢會清走該月 source 為「computed／自動計」嘅平均工資；人手同批量導入嘅保留。audit：`void_longterm_payroll_month`。

### 解鎖舊月份做銀行對數嘅標準流程（P14）

用途：正式站舊月份（例如 7、8 月）要導入長工合約＋人手輸入、重新計糧、同銀行 Payroll Editor 逐人對數、全部差異解釋清楚，再鎖返。每步用邊個頁／API：

1. **解鎖（原因必填）**：月結總表 › 該月 › 解鎖（`POST /api/month-closes/:id/unlock`，要「月結鎖定解鎖:void」，老闆）。解鎖會寫 audit `unlock_month`。
2. **導入長工合約**：長工糧頁 › 合約 › Maxwell 導入（`POST /api/longterm/contracts/import`），揀「由第一個未鎖月起生效」，睇 summary 嘅 `filled_name_en`／`filled_staff_no_mw`／`salary_mismatch`／`unmatched`。
3. **導入人手輸入**：長工糧頁 › 人手輸入 › 批量導入（JSON／CSV；先預覽再確認；`POST /api/longterm/inputs/bulk`，可重做，冪等）；有更表 SL 要草稿就按「由更表生成草稿」（老闆；`POST /api/longterm/inputs/drafts/generate?month=`），再喺同頁確認草稿。
4. **計糧**：長工糧頁 › 重算本月（`POST /api/longterm/payroll/:month/recompute`）。
5. **對數**：長工糧頁 › 銀行對數 › 上載銀行 Payroll Editor 檔（xls／xlsx；密碼保護檔先用 Excel 另存冇密碼版本；`POST /api/longterm/payroll/:month/reconcile`）。睇 summary：吻合／有差額（≤1／≤100／>100）／只喺銀行／只喺系統。
6. **解釋全部差異**：差異行展開睇系統組成，追根因；修資料（合約、人手輸入、更表）後「重算本月」再重新上載（同人同差額嘅舊原因會自動帶過嚟）；真係規則／口徑差異就標原因（`PATCH /api/longterm/reconcile-rows/:id`）。直至「未解釋」＝0。可匯出差異 CSV 存檔（冇姓名）。
7. **重鎖**：月結總表 › 鎖月。鎖月前體檢會顯示「本月銀行對數：N 項未解釋」（只提示，唔擋鎖）。

**解鎖期間各 job 對舊月份嘅行為（P14.4，test：`tests/p14-4-unlock-safety.test.ts`）**
- `auto_one_click`：只處理有 parsed 上載嘅未鎖月份；**曾解鎖而冇新上載（最新上載唔新過解鎖時間）→ 唔重跑**（`reopened_no_new_upload`）；解鎖後有新上載先會觸發一鍵結算。冇新上載時原有條件（`no_new_upload`／`already_triggered`）亦照舊。
- `longterm_input_drafts`：只處理「上月＋本月」（HK），舊月份唔掂；舊月份要草稿用上面步驟 3 嘅手動生成。
- `open_next_month`：只開「下個月」，唔掂舊月。
- `nightly_month_health`：只體檢本月＋未鎖上月，唯讀。
- `after_lock_exports`／`lock_ops_digest`：**重鎖時會重出檔／摘要（鎖月時間新於上次處理）——可接受**：新 `generated_files` 以新鎖月時間為準；摘要通知同月只推一次（dedupe）。重鎖後出嘅 BOCHK autopay 檔入銀行前仍要人覆核。

### 病假（SL）流程（P17，老闆 2026-10-14 規則）
> 老闆原文意思：「病假例子比較少，更表當月有病假 mark 咗就彈出詢問人手確認先出津貼，唔好自動幫佢決定。」
- 更表任何 SL 日子 → 一定要人手確認（有冇香港註冊醫生病假紙）先會出 4/5 津貼；**未確認一律當無薪**（草稿唔計糧）。系統唔自動確認任何草稿。
- 主動彈出（三處同一件事，連去長工糧頁 › 人手輸入 `?month=YYYY-MM&focus=sl-drafts`）：
  1. 通知 kind `sl_drafts_pending`（老闆＋會計；「N 段病假要你確認醫生紙（M 人）」，body 無姓名；dedupe＝月＋草稿 id 集合 hash，集合變咗先再通知）。每日 21:30 `longterm_input_drafts`、手動「即時生成草稿」、一鍵結算都會觸發。
  2. 一鍵結算「長工結算」步 `needs_human`：「病假 N 段未確認——未確認唔會出津貼，一律當無薪」（附「去確認病假 ›」連結）；報告 `lock_precondition.sl_drafts_pending`；**鎖月前有未確認 SL 草稿 → 擋鎖（`409 sl_drafts_pending`）**，鎖定區列為「一定要做好先可以鎖」。
  3. 首頁收件箱卡「病假要確認醫生紙」（上月＋本月）。
- 處理：長工糧頁人手輸入 tab「病假要你確認醫生紙」面板，每段顯示日期、連續日數、夠唔夠 4 日提示、結餘、確認後預計津貼金額；**逐段**撳「有醫生紙，確認」（醫生紙標已核實＋計糧）或「冇醫生紙，當無薪」（作廢草稿並記原因，同一組日期之後唔再生成）。**冇「全部確認」一掣**（`confirm-batch` API 仍保留，但唔用於病假）。確認後撳「重算本月」睇金額。
- 鎖月覆蓋：只有老闆，鎖定區勾「全部未確認病假當無薪，照鎖」＋必填原因（`sl_unpaid_override` + `sl_unpaid_reason`），草稿保持未確認（＝唔出津貼），寫入鎖月 audit `sl_unpaid_override`。
- **短病假（`SL_CONFIRMED_SHORT_PAID`，`compute.ts`，預設 `true`，老闆決定）**：已人手確認醫生紙嘅病假段，確認咗就出 4/5 津貼，唔理連續幾日（結餘仍然限制）。`gate:ltpay-aug` fixture builder（`scripts/gate/build-ltpay-aug-fixture.ts`）只對 oracle 真係出咗津貼（該人 `sl_pay>0` 且段連續 ≥4 日）嘅段標 `doctorNoteVerified=true`，其餘標未核實，因底稿「一律假設有醫生紙」同 oracle／銀行實況（短段冇出）不符。

### 每週一日例假（P17.5，老闆 2026-10-14）
- 同一日同時有例假碼（RD／OFF）同無薪假碼（NL／NPL）：看該日所屬週（週一至週日，只計該月內日子），冇其他明確 RD／OFF 日 → 當 RD（有薪例假，唔扣）；否則當 NPL（扣）。同一週多日衝突而冇明確 RD：只最早一日當 RD（保守）。純 NPL（冇 RD 標記）照舊扣，唔自動補例假。逐人 notes 有「同日 RD／NPL 衝突：按每週一日例假當 RD／當 NPL」。實作 `compute.ts` `resolveRdNplConflicts()`。

### 長工糧核對工具（P11.2，dev-only，唔入正式站）

`npx tsx scripts/gate/ltpay-vs-payrolleditor.ts <payrolleditor.xls> --month YYYY-MM [--out <json>] [--sheet <名>]`

- 讀 BOCHK Payroll Editor 舊格式 `.xls`（SheetJS `xlsx@0.18.5`，只係 devDependency；有密碼保護嘅檔會報中文提示：用 `tools/importer/venv/bin/msoffcrypto-tool -p VelvetSweatshop in.xls out.xls` 解密，或 Excel 另存無密碼檔；連線用環境變數 `DATABASE_URL`，冇表頭／冇明細行會報錯而唔係靜靜雞 rc=0）；按表頭搵 賬戶號碼／名稱／金額／備考號，冇表頭就用 BOCHK 明細固定欄位次序。
- 同系統該月最新有效 `longterm_payroll_runs` 逐人 `autopay` 比對；配對先用備考號 `LT<YYYYMM>-<工號>`，再用戶口（唯一先算）。吻合容差 ±0.01；差額分桶 ≤1／1–100／>100。
- console 只印數字；`--out` 逐人明細（工號＋兩邊金額＋差額；冇人名／戶口）建議放 `data/`。
- `npm run gate:ltpay-aug -- --out data/xxx.json` 亦會存 8 月逐人比對（誰啱誰唔啱）。
- 導入 Maxwell 名單到正式站前：揀「由第一個未鎖月起生效」（`contract_start_mode=first_unlocked`），再核對 summary 嘅 `salary_mismatch`。

## 對數差異常見根因：更表多來源衝突（P16b.3）
- 現象：銀行對數某人有差額，展開「組成」見紅色「⚠ 同日多來源紀錄衝突：MM-DD（來源A 代號 / 來源B 代號）」。意思：同一個人同一日喺 `shift_records` 有 ≥2 個來源（`roster_upload`／`master_roster`／`payroll_only` 等）而出勤代號唔一致（例如 班 vs SL、NL＋RD vs AL）。
- 系統處理：aggregate 照現行規則計（唔因為衝突改公式），只喺長工糧 line 的 notes 加提示；對數 summary `attendance_conflicts` 係有此提示嘅人數。
- 點跟進：逐個日期對辦公室出勤紀錄／糧單備註，決定邊個來源正確；去更表對數頁用正確來源套用（或作廢錯嘅紀錄），再「重算本月」→ 重新上載銀行檔。7 月實例：差額多數係辦公室出勤同更表唔同（返工 vs 無薪假、SL／AL vs NPL、RD vs 病假日）。
- 同期對數工具細修：批量輸入重複判斷計 note（OT 650 同補假日工資 650 唔再被當重複）；銀行檔第二表頭行（英文表頭）自動跳過，summary `header_rows_skipped`。

## 長工糧更表來源優先次序＋「出勤修正」面板（P18）
- **來源優先表**（`shift_records.source`，`src/lib/longterm-payroll/attendance-priority.ts`）：`manual`（人手：更表編輯器／`POST /api/shift-records/batch` 寫入）＞ `roster_upload` ＞ `master_roster` ＞ `payroll_only` ＞ 其他／null（同一級）。aggregate 每人每日只取**最高優先來源**嘅出勤紀錄（record_type=shift／leave）；同一最高來源同日多條（例如雙更）照舊全部計；OT 紀錄（record_type=ot）唔受影響。只改紀錄挑選，唔改任何金額公式。
- 「人手」點識別：批量儲存 API 原本**冇**寫 `source`（新建為 null、更新保留舊值），所以 P18 起 batch 新建一律寫 `source="manual"`，更新現存格只喺 record_type／leave_code 有改（或由 cancelled 復活）先改寫 `manual`；單純改結算單位（歸公司兵）／狀態唔蓋 source。對數套用（reconcile-apply）重寫紀錄會把 source 設返 `roster_upload`（明確以新上載為準）。單條 `POST/PATCH /api/shift-records` 唔寫 source（未改）。
- 衝突 note 文案：「⚠ 同日多來源紀錄衝突：MM-DD（A 代號 x / B 代號 y；已採用：來源 Z）……」，銀行對數 tab 照舊展開紅字。
- **「出勤修正」tab**（長工糧頁，老闆／會計，`長工糧:view`；寫入需要更表權限）：
  1. 「同日多來源衝突」表：保安員、日期、各來源代號、系統而家採用邊個、對糧影響（返工／有薪／無薪／例假）。每行「採用：代號 X」（X＝其他來源已有代號）或「設為代號…」下拉（返工／SL／NPL／NL／RD／OFF／SH／AL）→ 經 batch API 就地改寫該日最高來源紀錄（保留其 site／shift_type）為人手紀錄，舊內容留喺 audit before，**唔作廢任何紀錄**；改完兩邊一致，衝突即時消失。
  2. 「全部更歸雞頭嘅長工」表：本月所有正更結算單位都唔係 B07（internal_longterm）、非簽證形式長工 → 系統當頂位更（返工日 0、假期唔計）。「歸公司兵」＝按盤分組，用 batch API 將其全部正更 `settlement_broker_id` 設 B07（自動重新計價，source 不變）。
  3. 任何寫入後出現「要重算本月先反映」＋重算掣；已鎖月份整頁唯讀（掣停用，batch 亦 403）。
- 限制：目標紀錄係該日最高來源當中最近更新嗰條；若最高來源同日本身有兩條不同代號（同級衝突）面板只改其中一條。OT 唔喺面板處理。

