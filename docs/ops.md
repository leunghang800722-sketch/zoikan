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
| `WA_AUTO_WRITE_ENABLED` | 否 | W3：WhatsApp 自動寫入總開關。冇設／`1`＝開（仍要群組自己開「自動寫入」）；`0` 或任何其他值＝全部改去分流（reason `auto_disabled`），**唔寫更表**（fail closed）。緊急剎車用 |
| `SCHEDULER_ENABLED` | 否 | `1`／`0`。冇設＝production 開，dev／test 關。e2e（Playwright）固定 `0` |
| `GUARD_OCR_ALS` | 否 | `1`（預設）／`0`。證件辨識地址欄查香港政府 ALS 地址庫作候選；**預設開**，送出去嘅係冇樓層室號嘅地址；`0` 完全唔呼叫；見「GUARD_OCR_ALS」段 |
| `GUARD_OCR_DEEPSEEK_MAX_TOKENS` | 否 | 預設 `4000`（≤8000）。DeepSeek 讀 B max_tokens；deepseek-flash 思考 token 計入上限，1500 會令入職表讀 B content 空（OCR-5.6）。撞頂（content 空或 JSON 被截）自動重試一次（加倍、封頂 8000；已達 8000 唔重試；重試本身失敗就降級照舊）；只對 DeepSeek 生效（Claude 遇 max_tokens 直接拋）。env 只接受 1000–8000 嘅整數（嚴格 `^\d+$`），其他一律回預設 4000（唔係 clamp，例如 9000／500 都係 4000）。audit：`b_retry_truncated`＝重試成功數、`b_retry_failed`＝重試失敗降級數 |
| `GUARD_OCR_DEEPSEEK_REASONING` | 否 | `low`（預設）／`high`／`max`／`off`（`thinking:{type:"disabled"}`）。DeepSeek 思考力度（OCR-5.6） |
| `GUARD_OCR_ARBITER` | 否 | `1`（預設）／`0`。證件辨識分歧欄第三讀仲裁（Claude，每份文件最多 1 次）；見下面「OCR 準確度評估」段 |

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
- **來源優先表**（`shift_records.source`，`src/lib/longterm-payroll/attendance-priority.ts`）：
  | 級 | source 值 |
  |---|---|
  | 0 人手 | `manual` |
  | 1 | `roster_upload` |
  | 2 | `master_roster`、`master_roster_only`、`master_roster_site` |
  | 3 | `payroll_only`、`payroll` |
  | 4 最低 | 其他／null |
- aggregate、SL 草稿生成（`generateLongtermInputDrafts`）、病假待確認清單（`listSlPending`）、勤工獎資格（`listAttendanceBonusEligible`）、頂位津貼草稿（`loadCoverShifts`）都用同一個 helper `pickBySourcePriority`：**shift** 按（保安員, 日, 盤）分組（helper 內部 key 一律帶 guardId：dayBest 按（人, 日）、groupBest 按（人, 日, 盤），caller 一次過交多人紀錄都唔會跨人污染）取最高優先級（同日自己崗位 B07＋頂位兩邊保留）；**leave** 逐日同全日所有盤、所有紀錄（shift 或 leave）比較，當日最高級來源有任何紀錄，低級來源嘅 leave 一律忽略；若最高級來源當日只有 leave（冇 shift），低級來源嘅 shift（任何盤）亦一律忽略（例：upload SL@盤B vs master 班@盤A → 病假，唔計返工）（所以跨盤「upload 班@盤A vs master SL@盤B」SL 唔計、唔生成草稿）。同一最高級同日多條（雙更）照舊全計；OT 紀錄（record_type=ot）唔受影響。只改紀錄挑選，唔改任何金額公式。
- 「人手」點寫：`POST /api/shift-records/batch` 新建、單條 `POST /api/shift-records` 新建（caller 冇帶 source 時）、`PATCH /api/shift-records/:id` 改 record_type／leave_code、面板 `POST /api/longterm/attendance-fix`，都寫 `source="manual"`；batch 更新現存格只喺 record_type／leave_code 改變（或由 cancelled 復活）先寫。純改結算單位（歸公司兵）唔蓋 source。對數套用（reconcile-apply）重寫紀錄會把 source 設返 `roster_upload`（明確以新上載為準）。
- 衝突判定（note／面板）按（人, 日）跨盤用同一套規則：只要某日有 ≥2 個來源而出勤代號唔一致就標示（例：upload 班@盤A vs master SL@盤B 面板有列）。衝突 note 文案：「⚠ 同日多來源紀錄衝突：MM-DD（A 代號 x / B 代號 y；已採用：來源 Z）……」，銀行對數 tab 照舊展開紅字。
- **「出勤修正」tab**（長工糧頁；讀 `長工糧:view`，寫 `長工糧:update`＝老闆／會計；主管／雞頭 403；無權限時掣停用）：
  1. 「同日多來源衝突」表（按日＋盤一行）：保安員、日期、各來源代號、系統而家採用邊個、對糧影響（返工／有薪／無薪／例假）。「採用：代號 X」或「設為代號…」下拉 → `POST /api/longterm/attendance-fix` 就地改寫該日最高來源紀錄為人手紀錄，舊內容留 audit before，**唔作廢任何紀錄**。最高來源已經係 X 就回 `noop:true`（畫面提示「冇改動」，唔顯示「已寫入」）；最高級內有代號唔同嗰條會被揀去改。
  2. **只有揀嘅代號同低來源一樣，衝突先會消失；否則衝突仍然標示，但已採用人手紀錄。**
  3. 「全部更歸雞頭嘅長工」表：本月所有正更結算單位都唔係 B07（internal_longterm）、非簽證形式長工 → 系統當頂位更（返工日 0、假期唔計）。「歸公司兵」＝`settle_internal`：將其正更 `settlement_broker_id` 設 B07（重新計價，source 不變）。
  4. 任何寫入後出現「要重算本月先反映」＋重算掣；已鎖月份整頁唯讀（API 403）。
- 限制：OT 唔喺面板處理；其餘 P18 驗收提出但決定唔改嘅項目只作註明。

## 長工糧規則：年資起點（P19a，2026-10）

| 規則 | 年資起點 | 備註 |
|---|---|---|
| 年資起點 | 該人**現行連續合約鏈（中斷再入職重新計）嘅第一段未作廢長工合約**嘅生效日（散工段唔計）；冇合約先 fallback `guards.hire_date` | MPF 僱員供款豁免（新僱傭首 30 日／首個不完整糧期）、法定假期 `after_3_months` 嘅 3 個月計算、年假 entitlement 三處共用同一起點 |

散工轉長工嘅人（`guards.hire_date` 係散工入職日），MPF 同法定假一律由長工合約生效日起計。糧單 notes 會寫「年資起點：長工合約 YYYY-MM-DD（散工段唔計）」（只喺同入職日唔同時出）。

P19a 修正：年資起點取**現行連續合約鏈**第一段生效日——由該月生效嘅合約段向前追溯，前段 `effectiveTo` 同後段 `effectiveFrom` 相差 ≤1 日先當連續；離職再入職（有中斷）就由中斷後第一段起計。MPF 豁免、法定假 3 個月、年假 entitlement 同一口徑；舊規則月份（8 月以前 under60days）同樣跟呢個起點。合約日早過 hire_date 只出 warning（唔改計算）；「散工段唔計」note 只喺合約日遲過入職日先出。

## 離職月結算：平均工資（ADW）流程（P19b，2026-10-15）
離職月應付＝基本薪金（全月）＋未放年假補償（平均工資×結餘日數；日數＝7×服務日數÷365）－假期扣薪±其他；MPF ≥65 歲不適用。
- **平均工資次序**：①人手輸入整筆金額（離職結算輸入項）②「平均工資與假期」tab 嘅 `guard_avg_wages` 該月記錄 ③系統按《僱傭條例》第 2(3) 條自動計（離職日前 12 個月，服務期短過就由服務起點；分子＝net_basic＋OT＋津貼，已扣走無薪假／無薪法定假／病假日工資，唔計年假補償、4/5 病假津貼、人手扣款；分母＝日曆日－不獲全薪日子）——**期間內每個月系統都有糧線先用** ④唔齊（系統上線前嘅月份冇糧線）就維持月薪÷當月日數。逐人備註「★ 離職補年假」寫明用邊一層。
- **導航卡**：長工糧月報頁頂「離職者平均工資待確認」卡＝③④未能用、而且仲未輸入平均工資嘅離職者。逐人列系統用咗嘅日薪、未放年假日數、按條例補入缺失月份嘅參考值；喺卡入面直接填「終止僱傭合約薪酬計算表」嘅平均日薪（source 自動帶該表名）→ 儲存 → 撳「重算本月」套用，卡就消失。月鎖後唯讀。
- 鎖月、一鍵結算 precheck 只出警告（有幾多位待確認），唔阻擋。
- 日薪制長工唔做條例自動計（維持每更價）。歷史月份補入用現行合約月薪（舊月份調薪冇追溯）。

### 平均工資口徑（勞工處《僱傭條例》平均工資定義，P19b.4，老闆 2026-10-15 拍板）
- **一律計入**：津貼（交通、勤工／花紅、佣金、制服等 `special_allowance`／`other_allowance`／頂位津貼）。
- **加班費有條件計入**：計算期（離職前 12 個月或服務期）內，(a) 每個有糧線嘅月份都有加班費（>0，固定性質），或 (b) 每月平均加班費 ≥ 同期每月平均工資（不含加班費）嘅 20%（恰好 20% 算計入）→ 全部加班費計入分子；否則加班費全部剔除。邊界月（期間起點／離職月）OT 同工資按期間內日子比例攤；平均按期間月數（日數÷(365/12)）；有糧線月份只得 1 個月唔判「固定性質」（規劃者保守取捨，待老闆確認）；負數 OT 當 0；不含 OT 工資 ≤0 時 ratio 為 null。結果記入 `al_adw_json.otRule`（`included`／`reason` constant｜ge_20pct｜excluded／`avgOt`／`avgWagesExOt`／`ratio`／`monthsWithOt`／`monthsCounted`），逐人「★ 離職補年假」備註一句講明。
- **不予計算期間**：4/5 病假、無薪假、無薪法定假等不獲全薪日子，連同該等日子嘅工資一齊由分子分母剔走（按勞工處定義）；年假補償、4/5 病假津貼、人手扣款不計。

## OCR 準確度評估（OCR-5）＋第三讀仲裁開關（OCR-4）

評估腳本 `scripts/staff-import/eval-ocr.ts`——**本機由規劃者跑真檔；執行員／CI 只跑合成 fixture**（`--dry`）。用同一條應用內路徑：同規格圖（1,600px 全圖＋2×2 放大格，ImageMagick `magick`／PDF 用 `pdftoppm`，可用 `MAGICK_BIN`／`PDFTOPPM_BIN` 覆蓋）→ `getReadClients()`（真 Claude＋DeepSeek，key 由 `.env` 經 dotenv 載入；其他 env 檔用 `DOTENV_CONFIG_PATH=…`）→ `readDocument`（候選字／仲裁）→ 逐欄對 truth（現有 normalize canon）。

```
# 真跑（key 在 .env；manifest 同報表都放 data/，唔入 git）
npx tsx scripts/staff-import/eval-ocr.ts --manifest data/2026-10/ocr-eval/manifest.json --out data/2026-10/ocr-eval/report-before.json
# 試跑少量／單一文件類型／並行度（預設 2）
npx tsx scripts/staff-import/eval-ocr.ts --manifest … --limit 5 --only-doc-type onboarding_form --concurrency 2
# 合成 fixture＋fake client（唔打 API，無需 key）
npx tsx scripts/staff-import/eval-ocr.ts --dry
# WP-OCR-3：流程選擇（預設 two-stage＝讀 A 定位 → 欄位級裁圖 → 讀 B；legacy＝舊單次流程 1,600px 全圖＋2×2 格）
npx tsx scripts/staff-import/eval-ocr.ts --manifest … --flow legacy --out data/2026-10/ocr-eval/report-legacy.json
npx tsx scripts/staff-import/eval-ocr.ts --manifest … --flow two-stage --out data/2026-10/ocr-eval/report-twostage.json
```

- manifest：`{ cases:[{ id, docs:[{ type:"id_card"|"address_proof"|"onboarding_form", image:"<jpg/png/pdf 路徑，相對 manifest 所在資料夾或絕對>", page?:<PDF 頁，預設 1> }], truth:{ name_zh?, name_en?, hkid?, dob?, sex?, phone?, address?, bank_account? } }] }`。`bank_account` 路徑 A 唔讀，會略過並喺報表 notes 標明。`--dry` 專用可選 `fake`（每種文件嘅 a／b／arbiter 覆蓋，見 `tests/fixtures/ocr-eval/manifest.dry.json`）。
- 逐欄結果：`exact`（confirmed 且啱）／`review_contains_truth`（review 而預填值或候選含 truth）／`wrong`（confirmed 但錯＝最危險，另計 `confirmed_wrong`；或 review 而候選都唔含 truth）／`missing`。另出：review 率、review 欄平均候選數、估算人手改字次數（wrong＋missing）、估算撳候選次數（review 含 truth 但預填唔啱）、calls／tokens（含 `by_provider`、仲裁文件數）。失敗 case 重試 1 次，仍失敗只記錯誤類別、唔計入欄位統計。
- **隱私**：console 同 `--out` JSON 只有計數／百分比；per-case 只有 case id＋`doc.field → 結果類別`，唔印欄位值、姓名、圖片路徑。`--out` 必須喺 `<cwd>/data/` 之下（否則拒絕）。圖片只喺記憶體經 stdin／stdout 傳（PDF 例外：`pdftoppm` 暫存 PNG 放系統 temp，用完即刪）。
- 建議每個 OCR 子階段改動前後各跑一次（同一 manifest），比 before／after。
- **`--flow legacy|two-stage`（WP-OCR-3，預設 two-stage）**：two-stage 用 `readStageA`（全圖＋要求回報電話／地址欄位 box）→ Node 端 `cropFields`（ImageMagick 按 `src/lib/guards/ocr/field-crops.ts` 同一套幾何裁：外擴、鄰欄限制、長邊 1,000px）→ `readStageB`。報表同 console 多 `flow`、`field_crops_docs`（用咗欄位級裁圖嘅文件數）、`fallback_tiles_docs`（本應欄位級但冇有效 box 而退回 2×2 格嘅文件數；身份證／住址證明本身冇欄位級設計，唔計）。同一 manifest 跑兩個 flow 即可比較。`--dry` 可選 `fake.<docType>.boxes`（欄位 → `{x,y,w,h}`｜null）測 box／後備路徑，見 `tests/fixtures/ocr-eval/manifest.dry-crops.json`。

### 真 API schema 實測（OCR-4.4，改 schema／prompt 後必須跑）

fake client 驗唔到 Claude structured output 對 schema 文法大細／結構嘅 400（OCR-5.4 事故：入職表 5 欄＋5 box → 整份退回 DeepSeek）。所以**改過 `ocrJsonSchema`、stage A／仲裁 prompt、欄位 box 結構之後，必須本機跑一次**：

```
npx tsx scripts/staff-import/ocr-schema-smoke.ts        # key 由 .env 經 dotenv 載入；其他檔用 DOTENV_CONFIG_PATH=<path>
```

腳本用 ImageMagick 生成三張合成圖（白底黑字假表格，冇 PII），三種文件類型各打一次真 Claude stage A（入職表含 box／refs），斷言 200、冇退回後備、解析成功；只印通過／失敗同 token 數，唔印 key。共 3 次真呼叫。

OCR-5.6 起，有 `DEEPSEEK_API_KEY` 時另跑 DeepSeek 段（三種文件各 1 次 `json_object`，入職表用 5 圖情境，共 3 次）：斷言 content 非空、JSON 合法、未撞頂——改 DeepSeek 請求參數（`reasoning_effort`／`thinking`／`max_tokens`）之後必須跑。審計：`guard_ocr_read` 加 `b_retry_truncated`（讀 B／仲裁撞頂 content 空而重試嘅次數，淨計數）。根因：deepseek-flash 係思考模型，思考 token 計入 max_tokens，舊 1500 令入職表 5 欄裁圖讀 B 撞頂、整份退成 `one_read_unclear`。

## 證件辨識兩段式讀（OCR-3：欄位級裁圖）

- 入職表（電話、地址）放大圖改為**欄位級裁圖**：每欄一張，完整包住欄位格（印刷 label＋手寫內容），長邊 ≤1,000px（細過就放大，最多 2×），由 2,400px 來源圖裁出；唔再用固定 2×2 格切斷手寫行。2×2 格只係後備（讀 A 冇回報有效 box、box 不合格、或者任何一步失敗）。身份證／住址證明照舊用 2×2 格。
- 流程：瀏覽器 `POST /api/guards/ocr/read` `stage:"a"`（只傳全圖）→ 伺服器回 `field_boxes`＋`continuation` → 瀏覽器用 `field-crops.ts` 算幾何、canvas 裁圖 → `stage:"b"`。任何一步失敗（網絡／400／503／格式怪）自動退回舊單次流程，用戶無感。細節見 `docs/api.md`。
- **`continuation`**：伺服器簽名（HMAC-SHA256，key 由 `SESSION_SECRET` 經固定 label 衍生）嘅 token，10 分鐘有效、綁定 session 用戶、單次使用（process 內記 nonce）；**伺服器唔存任何 state**。`SESSION_SECRET` 輪換會令未用嘅 continuation 作廢（用戶重新辨識即可）。token 內含讀 A 嘅原始讀數（本來就會回俾同一 client），**唔加密、唔寫 log／DB／audit**。多實例部署下單次使用只係盡力而為（nonce 唔跨實例），核心防線係簽名＋10 分鐘＋userId。
- **配額**：`stage:"a"` 同舊單次流程各預留 1 次（同一次辨識只計 1 次）；`stage:"b"` 唔另外預留（continuation 證明 a 已預留）。stage b 失敗而 client 退回舊流程時，該次辨識會計 2 次預留（a＋舊流程）。
- **audit `guard_ocr_read`**：`after.stage`＝`"a"`｜`"b"`（舊流程冇此欄）。stage a 另記每份文件 `boxes`（有效 box 欄數）；stage b 另記 `field_crops_docs`／`fallback_tiles_docs`（淨計數）。冇值、冇 box 座標、冇 continuation、冇圖。
- **分格線防呆**：prompt 加「印刷分格線唔係數字 1；電話固定 8 位；見到 9–10 位請重新數並剔走疑似分格線；戶口號碼按格數抄」＋電話 `digit_count`（模型自報位數，目前只解析保留）。電話 9–10 位時 `normalize.ts` 嘗試剔走「1」得出首位 2–9 嘅 8 位解（唯一或最多 2 個）→ 入候選（reason `phone_gridline_suspect`，status `review`，唔自動 confirmed）。
- **路徑 B**（`scripts/staff-import/lib/`）：`phone-crop.ts`／`form-address-crop.ts`／`crop-box.ts` 外擴改為按 label 行高比例（上下 1.2×、左右 0.6×、最少 0.03），唔越過上／下一個 label 行同同行嘅左右 label（`crop-pad.ts`），`pad` 參數俾 caller 調。戶口號碼位數按 HKICL 銀行代號核對（`hkicl-digits.ts`，只收計劃書列明嘅匯豐 9／12、中銀 12／14、恒生 9；表外銀行唔檢查），唔啱 → review `acct_digits_mismatch`（`15-fields-merge.ts` 套用）。**位數表需要規劃者核實同補齊其他銀行。**

## 證件辨識跨文件上下文（OCR-1）

- 流程：先讀印刷證件（身份證／住址證明）→ 伺服器回 `refs_token`（已核實欄位值，簽名、10 分鐘、綁用戶、≤8k）→ 入職表 stage a／b 帶 token。入職表**讀 A** 見到印刷證件 confirmed 值（只用嚟判斷潦草字；明顯唔同就照抄並標 `differs_from_reference`），**讀 B 同仲裁盲讀**。只收兩讀一致嘅 confirmed 值：身份證讀錯／兩讀唔同／靠仲裁確認嘅欄唔會帶入。
- 入職表加讀姓名／身份證號／出生日期，**只做交叉核對**，唔覆蓋身份證值。UI 喺身份證三個關鍵欄（同地址欄）下面顯示「入職表手寫（唯讀）：…　同身份證一致 ✓／手寫同證件唔同（提示）／手寫讀唔到」。**OCR-1.3（老闆指示）**：身份證號碼／出生日期／中英文姓名一律以身份證為準，住址一律以住址證明為準（冇先用入職表手寫地址）；「唔一致」只顯示中度提示「入職表手寫同證件唔同，已以證件為準」（地址：「…已以住址證明為準」），唔阻提交、唔改值、唔額外加鎖；關鍵欄原有「對過證件，啱」確認規則不變。API 每欄多 `source_of_truth` 標示。
- 欄位級裁圖上限 `OCR_MAX_FIELD_CROPS=6`（電話、地址、姓名、HKID、出生日期；2×2 格上限 4 不變）。姓名／HKID／出生日期冇 box 就唔加裁圖，唔影響後備判定。
- **配額**：同一次辨識仍只計 1 次（入職表第二個 stage a 用 refs_token 抵銷預留，單次使用）；token 無效就照常預留。`SESSION_SECRET` 輪換會令進行中嘅 token 失效（自動照舊讀／退回舊流程）。
- **audit `guard_ocr_read`**（淨計數）：stage a `refs_issued`／`refs_injected_docs`／`refs_rejected`；stage b `refs_rejected`、`cross{match,differs,unreadable}`。冇值、冇 token。
- **評估**：`eval-ocr.ts` two-stage 次序同 client 一致；console 多「跨文件 refs」一行（注入文件數、cross 三類計數）；`--no-refs` 關閉注入方便前後對比。`by_doc_field` 自然多 `onboarding_form.name_zh/hkid/dob`。
- **路徑 B**：`crosscheck(…, { printed: true })`（`03-crosscheck.ts` 已開）加 `cmp[f].printed`＝同一文件包印刷身份證抽取值對申請表手寫抽取值（姓名／身份證號／英文名／地址）；有明確結果（match／mismatch）時優先於 U Team／Maxwell／DB 打字名單。`fields-ext` 證據類別加 `printed_ref`（獨立於打字名單同手寫讀數；`15-fields-merge` 尚未接入，需要時喺該檔將身份證抽取值以 `printed_ref` 加入 Cand）。

**`GUARD_OCR_ARBITER`**（Zeabur env，預設 `1`）：分歧欄第三讀仲裁開關；`0`／`false`／`off`／`no` 關閉＝回到兩讀。成本：每份文件最多多 1 次 Claude 呼叫（只喺有分歧欄且唔係兩讀 confidence 都係 high 時（OCR-4.4）；地址欄只差形近字亦算分歧），用量計入 audit `guard_ocr_read` 嘅 `usage_by_provider.claude`，另有 `arbiter_calls`。冇 `CLAUDE_API_KEY`（純 DeepSeek 模式）自動冇仲裁。

**`GUARD_OCR_ALS`**（Zeabur env，預設 `1`＝開，老闆 2026-10-15 決定）：證件辨識（住址證明、入職表）嘅地址欄，喺兩讀完成後（仲裁之前）向香港政府 ALS（Address Lookup Service，`https://www.als.gov.hk/lookup`，免費、免 key）查一次標準地址，作為額外候選（chip 上有細字「政府地址庫」），**唔會自動 confirmed**。
- **送出去嘅內容**：只有 地區／街道／門牌／屋邨／座／大廈 組成嘅查詢字串；**樓層、室號（15樓、A室、Flat A、15/F、Room 1203、G/F、舖、單位…）一律先剔走先送**（`hk-address.alsQueryFromParts`，送出前再斷言一次；大廈名本身含「樓」字嘅部件亦唔送）；永遠唔送姓名、電話或其他欄位。查詢資訊太少（冇街道／屋邨／大廈）就唔查。ALS 回嚟嘅標準地址由本地拼返樓層室號，樓層室號從來冇出過公司。
- **呼叫規則**：每份文件最多 1 次、每次辨識請求最多 2 份文件（住址證明＋入職表）、逾時 3 秒；429／5xx／網絡錯誤靜靜略過（不影響辨識）；Score < 60 或冇結果就冇候選。
- **紀錄**：查詢字串唔寫 log／audit／DB；audit `guard_ocr_read` 只加計數 `als_called_docs`／`als_candidate_docs`／`als_failed`。
- **關閉**：Zeabur env 設 `GUARD_OCR_ALS=0`（或 `false`／`off`／`no`）並重啟，完全唔會連 `als.gov.hk`。
- **評估**：`eval-ocr.ts` 報表多 `als_enabled`／`als_called_docs`／`als_candidate_docs`／`als_failed`／`als_truth_from_candidate`（review_contains_truth 入面真值只來自 ALS 候選嘅欄數）；`--no-als` 唔查 ALS；`--dry` 用 fake ALS（唔打網絡）。

## 舊分流題 OCR 重讀（TR-1，2026-10）

目的：生產 `guard_import` 分流 session 仲有大量 `field_review`／`name_not_confirmed`／`hkid_not_confirmed` 未答；用新 OCR 管線（兩段式＋refs＋仲裁）重讀原文件，**只喺極有把握時**出「建議答案」，老闆確認計數後批量套用，餘下留人手。

流程（全部喺本機＋/triage）：
1. **本機跑重讀（規劃者，真 API）**：
```bash
npx tsx scripts/staff-import/19-triage-reread.ts \
  --package data/2026-10/staff-import/out/import-package.json \
  --person-fields data/2026-10/staff-fields/person-fields-ext.json \
  --extract data/2026-10/staff-import/out/extract.json \
  --index data/2026-10/staff-import/index.json \
  --out data/2026-10/triage-reread/proposals.json [--docs-dir data/2026-09/staff-docs] [--limit N] [--only-key K] [--concurrency 2]
npx tsx scripts/staff-import/19-triage-reread.ts --dry     # fake client＋記憶體內合成 fixture，唔讀 data、唔打 API（執行員／CI 用）
```
   `--out` 必須喺 `data/` 之下（gitignored）。console 同 `summary` 只有計數（人數、每欄建議數、唔建議原因計數）；`proposals[]` 含欄位值，**只喺 `data/` 本機檔**。每人揀身份證／住址證明（`extract.address.page`）／入職表各 1 頁，次序同 client 一樣（印刷文件 stage A → refs → 入職表 stage A → 裁圖 → stage B），`mergeDocFields` 按來源規則（身份證／住址證明為準）得最終欄。
2. **保守規則**（`scripts/staff-import/lib/triage-reread-core.ts`）：只對 package 狀態為 `review` 嘅欄出建議；最終欄 `confirmed`（兩讀一致，或仲裁 `agree_b`；`agree_a` 唔收——仲裁只收讀 A 候選，非獨立證據；`ACCEPT_ARBITER_AGREE_A` 常數）而且格式 valid（HKID 檢查碼、電話 8 位、日期曆法、姓名全中文…）；地址只收住址證明來源；**TR-2（老闆 2026-10-17）**：身份證號／出生日期／中英文姓名一律以身份證副本為準、住址一律以住址證明為準——入職表手寫同印刷文件唔一致**唔再阻擋**（`cross_differs` 已移除，只將 confidence 標 `medium`）；address_proof 兩讀唔一致（`not_confirmed`）照樣留人手；package `reasons` 顯示舊 crosscheck 對打字名單（Maxwell／Uteam／DB）有唔一致（`mismatch_<欄>`／`nameZh_near_match`／`phone_differs_from_list`）→ 唔建議。唔建議原因計數：`no_read`／`not_confirmed`／`wrong_source`／`arbiter_agree_a`／`invalid_format`／`typed_list_disagrees`；summary 另有 `skipped_by_field`（每欄每原因計數）同 `cache_hits`。
   **讀數快取（TR-2）**：加 `--cache data/2026-10/triage-reread/cache/`，每個 docId＋doc type＋page 嘅 stage 結果（fields、arbiter、usage…；入職表 cross 每次按 refs 重算）存 JSON（`data/` 下，gitignored，路徑必須喺 `data/` 下），再跑命中就唔打 API、唔準備圖；`--no-cache` 強制重讀並覆寫。失敗嘅人唔入快取（已讀完嘅印刷文件會入）。資料夾型來源（多張圖）只支援「全部圖片」或「單一 PDF」，其餘版面該人當失敗（唔猜頁）。
3. **上載**：`/triage` → 保安員證件資料導入嗰張卡 →「⋯」→「導入 OCR 重讀建議」→ 揀 `proposals.json` → 自動 **dry run** 顯示計數（建議共幾條／配對幾題／可自動答幾題／各 skipped 原因）→ 確認「確認套用 N 題」。亦可直接 `POST /api/triage/sessions/:id/proposals?dry_run=1`（見 `docs/api.md`）。
4. **注意**：dry run 係每題獨立預覽，套用時前面幾題寫入可能令後面嘅題（例如同一電話／工號）寫唔到，實際 `applied` 可能少過 dry run；套用中途中斷可直接重跑（已答嘅題自動略過）。`field_review` 只有部分覆核欄有建議（或某欄格式唔合法）→ **答有建議嘅欄**（`applied_partial`），並喺同一 tx 為剩餘覆核欄開新 `field_review` 題（`follow_up_created`；groupKey `<舊>:rest`、同 personKey／sort／targetGuard、evidence 只含剩餘欄），舊題 answered，未決定嘅欄仍有人問；同 groupKey 已存在就唔重覆開（冪等）。dry run 亦顯示 `applied_partial`／`follow_up_created`；`skipped_field_mismatch` 細分 `skipped_field_not_under_review`（建議欄唔喺題目覆核欄）／`skipped_value_mismatch`（name／hkid 確認類值唔同）。自動答嘅題 `answerJson.source=ocr_reread`，session 卡顯示「OCR 重讀自動答 N 條」；寫入係「確認」性質（只補空欄／確認包內值，唔覆蓋現有唔同值），無自動撤銷（現有「撤銷補齊」只屬補齊價目卡題，唔適用保安員導入題）；改正要用人手改保安員資料。

## 更表寫入：audit 同 transaction（G2／G4，2026-10）
- `POST /api/shift-records/batch`：shift 寫入同 `audit_log` 喺同一個 `$transaction`（`writeAuditMany(…, tx)`，一條 `createMany`，次序／內容同舊版一致；timeout 60s／maxWait 10s 不變）。tx 中途失敗（unique 衝突、鎖月、audit 寫入失敗）→ shift 同 audit 一齊 rollback。
- `POST /api/shift-records`：撞 unique 而現存行係 `cancelled` 就重用該行（`update`＋audit `update`，`after.reused_cancelled=true`，回 201＋`reused:true`）；現存行唔係 cancelled 仍 409。audit 同寫入同 tx。
- **G4b**：`openMonth()`（`src/lib/months/open-month.ts`）、`applyAttendanceFix()`（`src/lib/longterm-payroll/attendance-fix.ts`）、`applyReconcileDecisions()`（`src/lib/roster-upload/reconcile-apply.ts`）嘅 audit 同樣用 `writeAuditMany(…, tx)` 喺同一 transaction 最後一步一條 `createMany` 寫入，失敗一齊 rollback（reconcile-apply 只收 SAVEPOINT 成功項嘅 audit）。attendance-fix 嘅 auto 價卡 journal 維持 commit 後 best effort（唔拖冧主寫入）。2,000 條 audit createMany 喺 tx 內實測約 0.1 秒。

## WhatsApp 報更：WAHA Zeabur service 設定清單（W0，2026-10）

> 計劃書：`docs/plans/whatsapp-roster-plan.md`（§3 webhook、§7 部署、§7.2 防封號）。下面係老闆喺 Zeabur 照做嘅清單；**所有 key／secret 只放 Zeabur env，唔入 git**。W0 只落庫，未解析、未寫更表。

**A. 新增 `waha` service（同系統同一個 Zeabur 專案）**

| 項目 | 設定 |
|---|---|
| Image | `devlikeapro/waha`（用 NOWEB engine，**唔用** Chromium engine，慳資源） |
| Volume | 持久 volume 掛 `/app/.sessions`（session 檔；重啟唔使再掃 QR） |
| `WHATSAPP_DEFAULT_ENGINE` | `NOWEB` |
| `WHATSAPP_HOOK_URL` | `http://<系統 service 內部名>:8080/api/webhooks/whatsapp`（Zeabur 私網服務名；唔支援私網就用系統公開網址 `https://…/api/webhooks/whatsapp`，HMAC＋header 照驗） |
| `WHATSAPP_HOOK_EVENTS` | `message,message.edited,message.revoked`（**唔好**訂 `message.any`／`message.ack`／`presence`） |
| `WHATSAPP_HOOK_HMAC_KEY` | 隨機長字串（例 `openssl rand -hex 32`）＝系統 env `WA_WEBHOOK_HMAC_KEY` |
| `WHATSAPP_HOOK_CUSTOM_HEADERS` | `X-Zoikan-Hook:<另一個隨機字串>`＝系統 env `WA_WEBHOOK_HEADER_SECRET` |
| `WAHA_API_KEY` | 隨機字串＝系統 env `WAHA_API_KEY`（系統查 session 狀態／群組列表用，header `X-Api-Key`） |
| `WAHA_DASHBOARD_ENABLED` | `false`（要用 dashboard 掃 QR 時先暫時開，掃完即關或加 basic auth） |
| `WHATSAPP_DOWNLOAD_MEDIA` | `false`（唔下載圖／語音／貼圖） |
| 對外網路 | **唔開公網**（私網即可）；系統先會用 `WAHA_BASE_URL` 連入 |

> **注意（W0.2）**：計劃書 §3.2 第 3 重「私網／IP allowlist／middleware 擋外網 `/api/webhooks/*`」**未實作**。而家 webhook 只靠 **HMAC-sha512 + `X-Zoikan-Hook` header** 兩重驗證（key／secret 未設一律拒絕）；請務必設足夠長嘅隨機 key，並盡量用私網 hook URL。

**B. 系統（Next）service 加 env**

`WA_ENABLED`（`0`／`1`；預設 `0`＝webhook 一律回 503，確認 WAHA 設定好先開 `1`）、`WA_WEBHOOK_HMAC_KEY`、`WA_WEBHOOK_HEADER_SECRET`、`WAHA_BASE_URL`（例 `http://waha:3000`）、`WAHA_API_KEY`、`WAHA_SESSION`（預設 `default`）。

**C. 開通步驟**

1. 用**專用公司 SIM 號碼**（唔好用老闆私人號），先人手入群、養號 1–2 星期；一次入 ≤10 個群，逐週加。
2. 起 `waha` service，開 dashboard 建 session `default`、掃 QR 登入；掃完關 dashboard。
3. 系統加上面 env，`WA_ENABLED=1`，重新部署。
4. 登入系統 →「WhatsApp 報更」→ 撳「同步群組」（新群預設「略過」）→ 逐個群揀類型、綁盤口／判頭。
5. 群組有訊息後，頁面「系統狀態」應見 WAHA session `WORKING`、「最後收到訊息」更新、訊息清單有行。

**D. 驗收／排錯**

- webhook 回 `503 {"error":"whatsapp_disabled"}`＝`WA_ENABLED` 未設 `1`；`401`＝HMAC key 或 `X-Zoikan-Hook` 不符（或系統未設 key／secret，一律拒絕；唔會落庫、唔會記 body）；`413`＝body >64 KB；`400`＝格式錯。
- 重覆投遞（WAHA 重試）由 `message_id` 唯一約束吸收，回 200。
- 保留期：`whatsapp_retention` job 每日 03:00 將超過 90 日嘅訊息原文置空（設定頁「自動排程」可見）。
- 一旦封號／斷線：系統其他部分唔受影響，照舊人手入更；健康區 WAHA 狀態會變 `FAILED`／「連唔到」。
- **鐵則**：系統永遠唔呼叫任何發送／已讀／輸入中 API（`tests/whatsapp-misc.test.ts` 掃描 `src/lib/whatsapp` 等目錄禁用字串）。

## WhatsApp 解析 dry-run 流程（W1，2026-10）

**目的**：試點群（2 個單盤群＋1 個判頭群，連續 2 星期）只「記錄建議」同實際排更對照，量度準確率；**不寫更表、不開分流題**。

**A. 開通**
1. W0 嘅 WAHA／webhook 已通（見上節）；`WA_ENABLED=1`；`DEEPSEEK_API_KEY` 已設（預設 provider；`CLAUDE_API_KEY` 有設＝DeepSeek 連唔到時 Claude 後備）。
2. 「WhatsApp 報更」→ 試點群揀類型、綁盤口／判頭、口語對照（`早→A`、`夜→N`…；冇對照時用更別 `startTime` 時段推：06–12 早、12–18 中、18– 夜）。**唔好開「自動寫入」**（W1 唔會寫，W3 先生效）。
3. `/settings/jobs` 確認 `WhatsApp 報更解析（dry-run）`（每分鐘）已啟用；日摘要 job 每日 09:00 通知老闆。
4. 每日睇 `/whatsapp/intents`：統計卡（收／過濾／解析／建議自動／分流／忽略／對照一致率）＋逐條 ✓／✗／—。

**B. 驗收指標（計劃書 §9 W1）**：試點 2 星期「建議自動」嘅對照一致率 ≥90%（卡上「建議自動 · 一致率」）；誤殺率 <5%（`/whatsapp` 訊息清單篩「略過」→ 人手抽查 `filtered_out` 訊息；過濾閾值可喺群組「綁定設定」逐群調，預設 40）。

**C. 判定規則（只記錄）**：`routed=auto_write` 只睇計劃書 §6.1 第 1–6 項（盤口／人／日期＋未鎖月＋−2～+45 日／更碼／無衝突且未額滿／類別 shift 或 leave）；第 7 項（群組 `auto_write`）記喺 `resolution.group_auto_write`，頁面顯示「群組未開自動寫入」備註。`cover`／`cancel` 一律 `triage`。凌晨 00:00–05:00 發出而用「今日／今晚／而家／今個更／聽日」→ `date_ambiguous`（候選：當日、前一日）。

**D. 真 API smoke（規劃者跑；改過 `src/lib/whatsapp/parse.ts` 嘅 schema／prompt／上限後必跑）**
```
npx tsx scripts/whatsapp/parse-smoke.ts [deepseek|claude|both]
```
用合成訊息（測試甲／乙、假日期）各打一次真 provider，斷言：`json_object` 輸出過 zod 嚴格解析、輸出 token 唔撞 2,000 上限（reasoning_effort low；思考 token 計入上限）。key 由 `.env`（或 `DOTENV_CONFIG_PATH`）載入，console 只印通過／失敗同 token 數。執行員測試一律用 fake LLM，唔打真 API。

**E. 排錯**：訊息 `status=error`＝LLM 連唔到／處理失敗 3 次（`error` 欄只有原因碼 `llm_unavailable|parse_failed|resolve_failed`；SQL 將 `status` 改返 `received`、`parse_attempts` 歸零即可重跑）；`/whatsapp` 頁「積壓」＝`status=received` 數量；排程只有 1 分鐘精度，所以 job 每分鐘跑一次、每次處理到冇待處理或 45 秒預算用盡。

## WhatsApp 分診題流程（W2，2026-10）

W1 dry-run 之後，`routed=triage` 嘅 intent 會即時變成「待答問題」（`/triage`，來源「WhatsApp 報更分流」）；仍然**唔會自動寫更表**（W3 先做）。無 migration、無新 env。

**A. 文員日常**：`/triage` → 「WhatsApp 報更分流」卡 →「繼續答」。題卡顯示 WhatsApp 原話＋群名＋時間＋發訊人＋系統解析＋卡住原因；候選保安員一鍵揀（標「近 60 日同盤」），揀完「預覽影響」→「確認寫入」＝新增一條**待批核**排更（`source=whatsapp`，主管喺批核頁 `/approvals` 批；排更頁頁首會提示「本月有 N 格來自 WhatsApp」）。勾「記住呢個花名」＝之後同一個叫法直接對到佢。同一條訊息最多問兩輪，之後只剩「人手入更／忽略」。
**B. 撞更**：「以 WhatsApp 為準」＝取消舊記錄再寫新（同一 transaction，失敗全部還原）；「保留舊」＝唔入更。額滿／超配額：「仍然入更（待批核）」或「唔入更」。月份已鎖：只可「人手處理」；若答題時月份被鎖，系統回「呢個月已鎖定，唔可以入更，請人手處理」，題保持未答。
**C. 負責人**：群綁定盤有主管就歸主管（系統暫時冇「用戶↔盤」主管關係，實際上通常歸老闆）；老闆可喺 `/triage` 「⋯ → 轉交」。新題會通知負責人（站內通知「WhatsApp 報更有新分流題」，同一 session 同一日只通知一次，內容冇個人資料）；`triage_reminder` job 照舊催辦超過 2 日未答嘅題。
**D. 批量**：卡上「批量接受建議」只處理兩類——有唯一「近 60 日同盤」候選嘅 `wa_person_ambiguous`、撞更／撞請假嘅 `wa_shift_conflict`（預設保留舊）。
**E. 編輯／撤回**：發訊人編輯 → 舊題作廢、按新文字重出新題；撤回 → 未答題作廢。已答題唔會自動改，題目卡會標「⚠ 原訊息已被修改／撤回」。
**F. 權限**：睇原話／姓名要「保安員:view」，入更要「更表:create」（老闆、主管有；會計冇更表新增，只會見到 restricted）；雞頭、保安員硬性拒。

## WhatsApp 自動寫入（W3，2026-10）

W1／W2 之後，**群組開咗「自動寫入」**嘅群，解析有把握嘅更／請假會直接寫入更表（`source=whatsapp`、狀態 `pending_approval`＝待批核；群組再開「自動確認」先直接 `confirmed`）。其餘照 W2 去分流。Migration `20261020000000_wa_w3_auto_write_cap`（只加欄 `whatsapp_groups.auto_write_daily_cap`，預設 50）。

**開通步驟（建議）**：先喺一個試點群開「自動寫入」（**唔好**開「自動確認」），睇 `/whatsapp/intents` 嘅「自動寫入結果」同 `/whatsapp/pending` 一星期，一致率夠高、主管冇大量退回，先考慮擴到其他群。

**兩個開關都要開先會自動寫**：① 環境變數 `WA_AUTO_WRITE_ENABLED`（總開關，冇設／`1`＝開）**同** ② 該群組喺「綁定設定」撳開「自動寫入」。任何一個關，都唔會寫更表：總開關關＝已開群組嘅訊息全部改去分流；群組開關關＝只記建議（dry-run，唔開題），並計入 `/whatsapp` 頁同日摘要嘅「建議自動但群組未開 N」。**上線前要逐群開**（新同步嘅群預設「略過」、自動寫入全關）；睇到「建議自動但群組未開」有數字，就係有群組仲未開。

**寫入條件（全部齊先寫，缺一即分流）**：群組 `auto_write=true`＋總開關 `WA_AUTO_WRITE_ENABLED`＋LLM 信心 ≥0.6＋計劃書 §6.1 第 1–6 項（盤口、保安員硬鍵、日期 −2～+45 日且未鎖月、更碼對得到、冇撞更／同更已存在／額滿／配額滿、`shift`／`leave`）＋今日該群未達上限＋5 分鐘內冇重覆。群組未開「自動寫入」＝dry-run（只記建議，同 W1）。

**安全閥**：
- **每群每日上限** `auto_write_daily_cap`（預設 50，`/whatsapp` →「綁定設定」可改，0–1000；0＝全部分流）：按訊息香港日計，超過 → 分流（reason `daily_cap`，題卡可「照解析結果入更」）。
- **總開關** `WA_AUTO_WRITE_ENABLED=0` → 全部分流（reason `auto_disabled`），無需重新部署以外嘅操作；改 env 後重啟 service。
- **5 分鐘去重**：同一發訊人 5 分鐘內，另一條訊息已自動寫入同一保安員／日子／更別（或請假碼）→ 當重覆（`ignored`，reason `duplicate_recent`），唔再寫（例如主管剛退回嗰條，發訊人又 send 多次）。
- 鎖月：寫入前同 transaction 內再檢查；鎖咗 → 分流（「鎖月中」題）。
- 撞更：寫入前同 transaction 內再用 `FOR SHARE` 查一次同人同日（其他更種／請假）；有 → 分流，唔寫。

**批核**：`/whatsapp/pending`（WhatsApp 待批）逐條或「批核已選」（逐條走現有 `/api/shift-records/[id]/approve`）；「全選」唔包含有 ⚠ 嘅記錄。退回要寫原因（走現有 reject＝回 draft）。排更頁頁首「本月有 N 格來自 WhatsApp，等緊批核」連去待批清單；格仔 hover 見「來自 WhatsApp｜群｜時間｜原話」（原話要「保安員:view」權）。

**編輯／撤回**：發訊人編輯（新 revision）或撤回後——
- 舊記錄仍 `pending_approval`（且當月未鎖）→ **自動退回**（同新 revision 嘅解析結果喺同一個 transaction：新結果寫入成功先取消舊記錄；新 revision 連續 3 次處理失敗＝舊記錄保留，另開一條「原訊息已修改，自動處理失敗」分流題）：記錄設 `cancelled`（audit `void`，`void_reason=source_message_edited｜source_message_revoked`），編輯嘅由新 revision 重新解析重寫（同一格會重用該行）；
- 已確認／已批核／已結算（或當月已鎖）→ **唔自動改**，只標 `source_changed`：待批清單、排更格 tooltip、排更頁橫幅顯示「⚠ 原訊息已被發訊人修改／撤回」，由人手判斷。

**日摘要**（每日 09:00 通知老闆）加「自動寫入 N、待批 M、拒絕 K」（只有數字）。

**疑難**：
- 群組開咗自動寫入但冇記錄＝睇 `/whatsapp/intents` 嗰條嘅原因碼；`只係建議（群組未開自動寫入）`＝群組開關未開。
- 突然全部去分流＝查 `WA_AUTO_WRITE_ENABLED` 係咪設咗 `0`／亂碼，或群組當日已達上限。
- 寫入嘅身份係「系統排程」帳號（`created_by`）；審計日誌 action＝`create`／`void`，`source=whatsapp`，`provenance` 含 `message_id`、`revision`、`intent_idx`、`sender_guard_id`。

## WhatsApp 運維 runbook（W5，2026-10）

**每日睇邊度**：`/whatsapp` 頂部「系統狀態」（WAHA session、最後收到時間、積壓、24 小時錯誤、最近告警）；`/whatsapp/metrics`（近 7／30 日數字：收訊、過濾、解析、建議自動、實際自動寫入、待批／已批／退回、Triage 開題／已答、對照一致率、AI 呼叫／token、錯誤；可按群睇）；每日 09:00 日摘要通知。

**告警（`whatsapp_health` job，每 15 分鐘，`/settings/jobs` 可見；通知類別「WhatsApp 橋接異常／斷線／積壓」，通知設定可關 email）**
- 「WhatsApp 橋接異常：…」＝WAHA session 唔係 WORKING。同一次故障同一狀態 6 小時最多提醒一次；恢復後會有一條「已恢復」，之後再出事（即使喺 6 小時內）會再提醒。
- 「WhatsApp 橋接可能斷線」＝週一至六香港 13:00–23:00 先檢查：所有已綁定（啟用、非「略過」）群，自「當日 07:00 同現在減 6 小時之中較遲者」起冇收到任何訊息。即係只計工作時段內嘅靜默，前一晚到早上嘅無訊息唔會誤報。每次故障只報一條，有新訊息到達即重設，下次再靜就再報。
- 「WhatsApp 解析積壓」＝待解析超過 200 條，或最舊一條等超過 30 分鐘：先睇「WhatsApp 報更解析＋自動寫入」job 有冇出錯（`/settings/jobs`）、AI 服務（`DEEPSEEK_API_KEY`／AI Hub）連唔連得到；job 每分鐘自動重試，3 次失敗嘅訊息會標「錯誤」。

**被封號／session 失敗（FAILED）後點做**
1. 確認：`/whatsapp` 見 WAHA session 「FAILED」或「連唔到」；用 WAHA dashboard（只限內網／老闆）睇 session。
2. 後備：報更照舊人手入更（主管轉發／雞頭入更），系統其他部分唔受影響；唔好急住換號重複登入（頻密登出／重掃會增加封號風險，見計劃書 §7.2）。
3. 若只係斷線／STOPPED：喺 Zeabur 重啟 `waha` service（volume `/app/.sessions` 持久，通常唔使重掃 QR）。
4. 若係 SCAN_QR_CODE：用 WAHA dashboard 對該 session 重掃 QR（用公司專用 SIM 嘅手機：WhatsApp → 已連結裝置 → 連結裝置）。掃完 session 應轉 WORKING，15 分鐘內會收到「已恢復」。
5. 若確認被封：換專用 SIM／新號碼，按 W0 清單重新建 session、人手入群（一次 ≤10 個群，逐週加），再喺 `/whatsapp` 撳「同步群組」；舊綁定嘅 `group_jid` 通常不變（群冇換）。期間群組開關可保持，訊息補唔返（唔抓歷史）——受影響日子由主管人手入更。
6. 斷線期間冇收到嘅訊息唔會補；恢復後只收新訊息。

**口語對照**：`/whatsapp` → 群組「綁定設定」。「口語 → 更碼」每行揀該盤有效更別（大群／判頭群顯示所有盤嘅更碼）；詞唔可以重覆（全形／半形算同一個詞），。更碼對照單字（如「早」「夜」）可以；請假詞覆寫最少 2 個字（用包含式匹配，單字太易誤中，介面同 API 都會擋）。「請假詞對照」係可選覆寫：例如該群習慣講「病」就係年假，就加「病 → AL」；冇覆寫就用內建（病假→SL、年假→AL、事假／無薪→NL、例假／RD→RD、公假→SH）。「放假／休息」內建唔自動入，群組可覆寫成 RD。改咗對照只影響之後新解析嘅訊息。

**保留期**：訊息原文 90 日後由 `whatsapp_retention`（每日 03:00）置空；解析結果、審計日誌照舊保留。指標只用數字，唔受影響。
## WhatsApp 請假／替更／取消（W4，2026-10）

無 migration、無新 env。

- **請假**：AL／SL／NL／RD／SH 同「聽日病假」「17-19 號病假」（逐日一條）照 W3 規則自動寫入（要群組開「自動寫入」）；「放假」（唔知年假／事假／例假）一律去分流。同日已有更而報請假＝分流題，題卡會寫明「會取消 X 月 X 日 X 更」，揀「以 WhatsApp 為準」先會取消該更同寫請假。
- **病假仍要人手確認醫生紙**：WhatsApp 寫入嘅病假 **未批核（待批清單）前唔會計入長工糧／病假草稿**；批核後下次草稿生成先出現喺「長工糧 › 人手輸入 › 病假待確認」，一樣要逐段按「有醫生紙，確認」先出 4/5 津貼（群組開「自動確認」都唔會令病假自動確認）。
- **替更／取消首階段一律分流（唔自動）**：「A 頂 B 聽日夜更」→ 待答題「替更要你確認」：兩個人都配對到就一撳「確認替更」（B 嗰更取消、A 入更待批核）；唔肯定邊個就喺同一題揀齊兩位先可確認；B 當日冇更只會加 A；A 同日已有其他更／請假就只可以「以 WhatsApp 為準」或人手。「聽日唔返」→ 待答題「取消要你確認」：「取消該更」或「改為請假（揀碼）」；搵唔到可取消嘅更就轉「未能自動理解」。取消／替更要「更表」作廢權限（老闆／主管）。
- **被替者取消唔等於請假**：被替者該更取消原因記 `covered_by_whatsapp`（audit `void`），唔會寫請假；如果訊息講明被替者請病假，另一條請假 intent 會自己處理。
- **批量接受唔包替更／取消**：「批量接受建議」只處理人名唯一候選／撞更保留舊記錄兩類。
- 過濾層補咗 RD／SH／NPL 口語（例假、公假、休假…），之前「我21號例假」會被當閒話。
