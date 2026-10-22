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
| `triage_evidence_cleanup` | 每日 03:30（`30 3 * * *`） | TE-1：刪 `triage_evidence_images` 過期（建立 180 日／跳過題 30 日）同孤兒圖（已冇 open／skipped 題需要該欄）；分批 500、每批喺分診全域 advisory lock 下行；summary／audit 只計數（`expired`、`orphans`） | 是（只刪證據裁圖；actor＝系統） |

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

**OCR-6 手寫電話收緊（老闆 2026-10-20）**：只對 `phone` 欄，其他欄規則不變。背景：OCR 評估 102 人，電話 confirmed-but-wrong 5→7/36（2/3 仲裁放寬代價）。
- `reconcile`：電話 `confirmed` 必須 **讀 A、讀 B、仲裁三者正規化後逐字相同**（容許空格／`+852`／連字號）＋valid（8 位、首位 2–9、冇分格線嫌疑）。2/3 一致（仲裁同其中一讀）→ `review`，`value` 預填一致嗰個值，`arbiter: agree_a|agree_b`，`reason: phone_needs_three_way`；兩讀相同但冇仲裁／仲裁 unclear／仲裁讀到另一個值 → `review`，`reason: phone_needs_three_way`（`value`＝兩讀值；`arbiter` 為 `unclear`／`independent`／冇）；三讀全唔同照舊 `reads_differ`。任何一讀（A、B、仲裁）去非數字後位數唔係 8（含分格線嫌疑 9–10 位）→ `review`，`reason: phone_digit_count`（分格線推算候選照樣入候選池、排前）。
- `read.ts`：`disputedFields` 對 `phone` 永遠回 true（兩讀都有值即跑仲裁，即使兩讀一致或都 `high`）。**成本**：每份入職表（有電話欄）多一次 Claude 仲裁讀數（原本兩讀一致時唔跑）；仲裁 prompt 仍只問分歧欄，電話一致時候選淨一個值。冇仲裁 client（`GUARD_OCR_ARBITER=0`、純 DeepSeek 模式、冇全圖）→ 電話永遠 `review`（唔會 `confirmed`），人手覆核量上升，屬預期。
- 前端 reason 文案：`phone_digit_count`、`phone_needs_three_way`。API 回應形狀不變（additive reason 值）。
- 評估：`scripts/staff-import/eval-ocr.ts` 報表只存結果類別，唔存三讀原值，所以改動前後要各用真 API 跑一次同一 manifest 比 `phone` 欄 `confirmed 但錯`／`review` 數（`--dry` 合成 fixture 只驗流程）。

**OCR-6.1 電話盲讀仲裁＋獨立來源佐證（2026-10-20）**：真 API 評估（102 人，phone n=36）顯示三讀一致規則冇減少 confirmed_wrong（7 → 7）——7 個係三讀一致咁讀錯（仲裁見到候選值會錨定，同讀 A 同一個 model），所以：
- **盲讀仲裁**（只對 phone）：`read.ts` 仲裁 phone 時 prompt **唔帶**兩讀候選值（user text 只講 BLIND、要求獨立讀 8 位數；system prompt 講明盲讀、唔好由其他欄推斷）；其他欄候選照舊。仍要三讀一致先可能 confirmed。`ReadOptions.phoneBlind`（預設 true；eval `--no-phone-blind` 可還原舊行為做前後對照）。
- **獨立來源佐證**：電話 confirmed 要 OCR 三讀一致值同**獨立來源**（打字名單 crosscheck 電話／已存 `guards.tel`／`guard_phones`）正規化後相同。冇獨立來源 → `review`，reason `phone_no_independent_source`（預填 OCR 值）；獨立來源唔同 → `review`，reason `phone_differs_from_list`（候選兩個，OCR 值預填）。即電話同 TE-12 證件欄一樣要「兩個獨立來源」。API：`POST /api/guards/ocr/read` 的 stage b／舊單次 body 可帶 additive `independent_phones: string[]`（≤5 個、每個 ≤40 字）；冇帶＝電話只會 review。TR 重讀腳本（`19-triage-reread`）冇獨立電話來源，所以電話唔再出自動建議（全部 review）。

**OCR-6.2 獨立電話來源接駁（2026-10-21）**：邊個 caller 有獨立來源：
- **new-from-docs（stage b）**：伺服器端——refs_token 內身份證 confirmed 嘅 HKID 配對到系統已有保安員（`guards.hkid`，只用 HKID，唔用姓名）→ 佢嘅 `guards.tel`＋`guard_phones` 自動做 `independent_phones`（client 唔使傳，亦可額外傳）。冇配對（全新保安員）→ 電話 review＋預填 OCR 值，畫面顯示「冇獨立來源（名單／已存電話）可以佐證，請對住圖核對電話」。伺服器查到嘅已存電話**只用嚟比對**（OCR-6.3），絕不入 candidates／candidates_ranked 或任何回應欄；client 自己傳嘅 `independent_phones` 先可以回。HKID 配對兩邊都 canonical（舊資料帶括號／小寫都配到）。confirmed 回應同形狀，唔分「伺服器佐證」定「client 名單命中」。**殘餘風險**：有上載權限者可用「猜號＋睇 confirmed／review」試探某 HKID 嘅已存電話（oracle），需要擁有該 HKID 圖及逐個猜，風險可接受。
- **人手覆核量會升（OCR-6.3）**：冇獨立來源（全新保安員、冇打字名單）嘅電話一律 review，new-from-docs 新人電話全部要人手對圖核對。
- **舊單次 body／stage b 無 refs**：只用 client 傳嘅 `independent_phones`；冇傳＝review。
- **導入管線**（`scripts/staff-import` extract／aggregate）：用 Apple Vision 本機 OCR，唔經產品 OCR 讀取，所以冇 OCR 電話 confirmed 要佐證；打字名單電話已係 `person-fields` crosscheck 嘅來源。
- **重讀腳本 `19-triage-reread`**：`--list-phones <json>`（`{"<person_key>":["9xxxxxxx"]}` 或 `{"persons":[{"person_key","phones":[]}]}`；每人 ≤5、每個 ≤40 字；格式唔啱即停，訊息唔印值）。有名單電話且三讀一致相同 → 電話出建議；冇傳／唔同＝照舊全部 review。讀數快取 key 帶名單電話指紋，`OCR_PIPELINE_VERSION` 已升（舊快取失效）。
- **eval**（`scripts/staff-import/eval-ocr.ts`）：manifest case 可選 `list: { phone }`（獨立來源）同 `truth_source: { phone: 'list'|'form' }`；報表 `by_field.phone.breakdown` 逐類計 confirmed_wrong：`unanimous_wrong`（三讀一致但錯）／`arbiter_anchored`（仲裁同其中一讀一致、另一讀唔同）／`truth_from_list_differs`（真值嚟自名單而手寫 OCR 值唔同）／`other`；只比較正規化值，**唔寫值**。flags：`--phone-blind`（預設）／`--no-phone-blind`。console 另印 phone 逐類計數。

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

## 分流覆核證據裁圖補做流程（TE-1，2026-10）

目的：題卡直接顯示原文件相應欄位嘅裁圖（身份證號／姓名／出生日期／電話／地址），覆核人對住圖打返正確資料。**只存欄位裁圖**（唔存成頁），AES-256-GCM 加密，**答題即刪**，保留期（跳過 30 日／最長 180 日）只係安全網。

**來源優先順序（老闆 2026-10-18；TE-2 加印刷）**：身份證號＝身份證副本 1 → 牌照／證書印刷 2 → 入職表手寫 3；中英文姓名／出生日期＝身份證副本 1 → 入職表手寫 2；住址＝住址證明（1）→ 入職表（2）；電話＝入職表。兩個來源都有就兩張都出（優先排前），題卡先顯示優先來源，第二張摺埋「亦見入職表手寫」，每張標來源（身份證副本／住址證明／入職表手寫）。

補做 280 條現有題嘅次序（S5）：
1. **先跑 TR 自動答題**（`19-triage-reread.ts` → `/triage` 「⋯ → 導入 OCR 重讀建議」），令有把握嘅題先答晒（答咗嘅題唔需要圖）。
2. **本機出圖（規劃者）**：
```bash
npx tsx scripts/staff-import/20-triage-evidence.ts \
  --package data/2026-10/staff-import/out/import-package.json \
  --person-fields data/2026-10/staff-fields/person-fields-ext.json \
  --extract data/2026-10/staff-import/out/extract.json \
  --index data/2026-10/staff-import/index.json \
  --existing-crops data/2026-10/staff-import/out/phone-crops.json,data/2026-10/staff-import/out/address-crops-new.json \
  --out data/2026-10/triage-evidence/ [--docs-dir data/2026-09/staff-docs] [--limit N] [--only-key K]
npx tsx scripts/staff-import/20-triage-evidence.ts --dry     # 合成假證件版面（ImageMagick 即時畫），唔讀 data、唔打 API

**TE-3（老闆試用反饋）**：題卡只見有問題欄嘅裁圖；「確認寫入」改一鍵（未預覽就自動預覽，可確認即寫入；否則喺同一張卡展開要補嘅欄／人話原因）；冇姓名嘅無證人，揀輸入身份證號後會喺同卡展開中文姓名（必填）／英文姓名（選填）輸入框，旁邊顯示姓名裁圖，填完自動重新預覽。**導入抽取（`lib/extract.ts`／`lib/aggregate.ts`）**：任何頁（包括 other／證書）每行用 NFKC 行內搜尋 HKID（check digit 通過先收）；身份證 label（身份證號碼／I.D. Card No／HKID／Identity Card No）後面 7–9 位英數串（含下一行）會試 OCR 混淆（首位 2↔Z、0↔O／D、1↔I、5↔S、8↔B、6↔G，括號缺失），**只收唯一一個 check digit 通過**，note `ocr_confusion_fixed`；純數字冇 label 唔收。新來源 `aux.printedHkid`；身份證頁冇 HKID 時後備次序 permit＞printed＞form（flag `hkid_from_secondary`，level low；印刷多個唔同號＝`hkid_printed_multiple` 唔用）。裁圖腳本 printed 來源同樣行內搜尋＋checksum，長行只裁號碼 x 範圍（按字元比例；側躺頁唔裁）。**呢啲抽取改動要下次導入先生效；本次冇重跑導入。重跑前建議先比對新舊抽取每欄計數。**

**TE-4 重讀腳本嵌入身份證副本流程（老闆：只要讀到嵌入卡就以佢為準自動答題）**：`19-triage-reread.ts` 對「身份證欄（hkid／中文姓名／出生日期）未確認（review 或 missing）而且冇整頁身份證副本」嘅人，掃佢所有文件嘅所有頁（唔理導入分類；入職表頁除外，每人 ≤12 頁）搵夾住嘅細身份證副本：① 第一階段＝導入 OCR 整頁行（`--ocr-dir`，預設 extract 同層 `ocr`／`ocr2`）用 TE-2 `detectEmbeddedCards`（四方向，倒轉 180° 都得）；② 搵唔到再對該頁做 TE-2.1 二階段（300dpi 分格局部 Apple Vision，要本機 swiftc／`--vision-bin`；冇 Vision 就只做第一階段）。搵到卡區後 **轉正＋加 10% 邊距裁成一張獨立卡圖（長邊 ≤1600px）**，用 `prepareDocumentImages`（同整頁身份證一樣）交真 OCR 管線 `id_card` two-stage 讀 hkid／name_zh／name_en／dob／sex，按現有 source-of-truth 規則（證件為準；兩讀一致＋格式／HKID check digit valid 先出建議）出 proposal；卡圖只喺記憶體／系統暫存，用完即刪，快取 key 加 `__emb`。**印刷佐證**：同一人證書／牌照頁行內（唔喺卡區內）、checksum 通過嘅號碼（TE-3 (3) `scanPageHkids`；再加 extract 已有嘅 `aux.printedHkid`／`aux.permitHkid`，下次導入先有）——同卡讀數一致＝proposal `confidence: high`＋flag `printed_corroborated`；有印刷但同卡唔一致＝全部卡建議降 `low`＋`printed_card_conflict`（留人手）；冇印刷＝卡自己為準（`medium`，自動答）；**冇卡、只有唯一一個印刷號碼**＝淨 `hkid` `low`＋`printed_only`（review，唔自動答）。新旗：`--only-missing-hkid`（只處理 hkid missing 嘅人，供真 API 小範圍試跑）、`--only-key K`、`--no-embedded`（唔做嵌入卡偵測）、`--ocr-dir`、`--vision-bin`。console／summary 只計數：`embedded_cards_found`、`embedded_second_stage_found`、`second_stage_pages`、`card_printed_corroborated`、`card_printed_conflict`、`printed_only_review`、`proposals_low_confidence`。**伺服器**：proposals 對 `no_id_card` 題收 `hkid`（checksum 要通過）＋可選 `nameZh`／`nameEn`／`dateOfBirth`，砌成 `enter_hkid` ＋ `extra:{name_zh,name_en,dob}`（解決 create_no_name，extra 加 `dob`，audit 只記 key）；身份檢查照舊——號碼已屬他人（`checkHkidOwner` 422）→ `skipped_identity_mismatch`；`confidence:"low"` 嘅建議唔自動答，計 `skipped_low_confidence`。

**TE-4.1（Opus 驗收修正）**：① TE-3 混淆修正收緊——只收同一行緊跟 label 嘅 token（下一行後備淨限該行只有 token）；8 位純數字似日期（ddmmyyyy／yyyymmdd）或電話（5／6／9 開頭）拒絕；原文要有結構線索（末位喺括號內〔右括號可缺〕或空格分開 check digit）先做修正；修正值（`ocr_confusion_fixed`）永遠 low，唔可獨力做 hkid 後備／本人佐證／配對 key，要有另一個未修正來源同值先用（aggregate 同重讀腳本一致）。誤收率回歸：隨機 8 位／日期／電話各 2000 個（純數字 token、及日期／電話套括號結構）≤0.5%。② 嵌入卡整人一致性：卡上讀到嘅中文名（normZh）／英文名（sameEnglishTokens）同包內任何已有姓名比對（就算冇出建議）；唔一致，或卡欄喺入職表 cross／打字名單檢查唔一致 → 該人所有卡建議降 `low`＋`card_name_conflict`（summary `card_name_conflict`）；包內完全冇姓名先保持 medium。③ 印刷佐證只用未經混淆修正嘅值升 high；修正值只可令狀態變 conflict。④ 讀數快取 key 加卡區 box／rot／stage hash。⑤ 伺服器 `extra` 姓名只喺包內冇姓名／姓名未確認先接受，否則 400（建議砌答案時亦唔帶已確認姓名）；題卡打姓名時舊預覽 hash 作廢，確認前自動重新預覽。

**TE-4.2**：① 出生日期——server `extra.dob`：包內出生日期已 confirmed 而唔同 → 400，相同當冇事；proposals 對已確認出生日期唔帶 `extra.dob`；卡上出生日期同包內已確認出生日期唔同 → 計入 `card_name_conflict`（全人降 low）。② 英文名比對放寬（只用於卡 vs 包內一致性；銀行配對用嘅 `sameEnglishTokens` 不變）：中文名兩邊都有而且一致 → 唔理英文名差異；英文接受縮寫（只比首字母，CHAN T M ≈ CHAN TAI MAN）同連寫（TAIMAN ≈ TAI MAN），token 數同姓氏要相同。③ 回歸測試固定已知水平：隨機 7 位＋(d) 結構誤收 ≤10%（修正值一律 low、唔獨力採用）。

**TE-5 同名現有保安員要人決定**：補咗姓名（或包內本身有姓名）之後，系統有同名（中文姓名相同）現有保安員而冇硬證據（match 規則「淨姓名對到→人手」）時，題卡喺同一張卡顯示候選卡（名、有冇身份證／出生日期、工號、建立日期、最近出更月份）同兩個掣：「係同一人，連結並補資料」／「唔係，建新人」；撳後自動重預覽，再一撳「確認寫入」。連結＝寫入身份證號／姓名／出生日期到該 guard（覆蓋現有唔同值要「保安員個人資料:update」，否則只補空欄）；建新人＝照建。身份檢查照舊（該 guard 已有另一身份證號、身份證號屬第三者都攔）。OCR 重讀 proposals 遇呢種情況唔自動答，UI 計數「要人決定連結／建新人：N 條」，要到 /triage 人手決定。連結要「保安員個人資料:view」＋「保安員:update」（否則 403／冇連結掣），而且只可連去同名候選（伺服器重新計，揀無關保安員 400）；同名者多過 5 位只列頭 5 位（UI 提示「仲有同名者，請用搜尋確認」）。**誤連結還原**：用該題 `triage_answer` audit 嘅 `link_guard_id` 搵到被連嘅保安員，再喺該保安員嘅更新 audit（`guards` update，`before`／`after`）睇改動前值，用保安員編輯頁改返（身份證號／出生日期／姓名），冇自動撤銷。

**TE-7 空資料題卡 fallback**：題目人（例如 `extract_fail`）導入包冇讀到任何欄、冇工號、冇 ext 時，「導入包內嘅資料」改顯示「導入包冇讀到呢位嘅任何資料」＋原因人話＋來源文件資訊（頁數、各類頁數；package person 新增可選 `docInfo:{pageCount,pagesByKind,fileExts?}`，`06-build-package.ts` 下次建包會帶出，舊包冇就唔顯示）＋下一步（補交身份證副本／入職表再導入，或人手輸入）；部分欄有值時 missing 欄顯示「—（未讀到）」而唔係隱藏；裁圖區冇圖顯示「冇裁圖（文件讀唔到）」。所有 reason code 有人話 label（`src/lib/triage/reason-labels.ts`，測試掃原始碼確保冇漏；「其他原因」只對真未知 code）。

**TE-7 追查線索（老闆要求）**：本機 `20-triage-evidence.ts` 對抽取失敗人（rating fail，或六個身份欄全空而且冇工號）① manifest 加 `people[].doc_ref:{file_name,page_count,pages_by_kind}`（來源檔案線索；file_name 係 Drive 檔名，可能含人名，屬題目資料級，唔入 ai schema）——伺服器寫入該人所有 open／skipped 題嘅 `evidence.doc_ref`（只補唔覆蓋；回應計 `doc_refs_set`），題卡 fallback 區顯示「檔案：<檔名>（N 頁：入職表 1、…）」；② **整頁原稿暫存圖**：加旗 `--full-pages-for-failed`（預設關）——對上述失敗人將每頁（空白頁跳過、每人 ≤8 頁）渲染成 JPEG（長邊 ≤1600、`-strip`、≤400 KB，質素梯級下調；壓唔到計 `full_pages_skipped`），manifest `field:"page"`、`doc_kind:"full_page"`、`page_no`、priority 1。全無身份證號／工號嘅人用 `match.package_key`（包內 key）配對（伺服器用同一 `serverPersonKey` 推 personKey；hkid／工號有值時唔採用）。跑法：`npx tsx scripts/staff-import/20-triage-evidence.ts … --full-pages-for-failed`，之後照常 /triage「⋯ → 上載覆核裁圖」。**私隱／限制**（plan §14）：只限抽取失敗人；加密（同欄位裁圖 AES-256-GCM）、答題即刪（`requiredFieldsFor` 全欄 missing 嘅建人／核對類題型加 `page`）、跳過題 ≤30 日、最長 180 日；只有同時有「保安員個人資料:view」＋「保安員銀行資料:view」嘅人睇到（整頁可能有相片、銀行資料）——其他人題卡顯示「有 N 頁原稿，需最高權限查看」，GET 圖 403；每人 ≤8 頁另計（唔食 18 張裁圖額度）；摺埋「原稿頁（N）」撳開先載入（no-store）。

**TE-7.2（production 對照）**：① `people[].doc_ref` 現在隨「有該人圖」嘅**每個** zip 一齊放（冇圖嘅人放第一個 zip）——以前淨放第一個 zip，只上載部分 zip 就寫唔到 doc_ref（題目 `evidence.doc_ref` 係 null）。② production session 係舊 package 建，題目 person key（24 hex，伺服器派生）同本機 package key（`06-build-package` 每次 `randomUUID()`）唔同；冇工號／身份證嘅孤兒失敗人要用對照表：`--person-key-map map.json`，格式 `{ "<本機 person key>": { "prod_key": "<24hex>", "doc_ids": ["<docId>", …] } }`（只含 UUID／hash，無 PII）。對 map 內嘅人：用 `doc_ids` 搵文件（覆蓋預設工號鏈接）、docRef／全部頁由 doc_ids 帶出、manifest `items[].match` 同 `people[].match` 帶 `prod_person_key`（有 map 就算評級唔係 fail 都出整頁＋doc_ref）。伺服器 `match.prod_person_key`：只對 match 冇 hkid／工號嘅人、題目 evidence 身份集合為空先生效（key 等於題目 personKey，或經 serverPersonKey 推得嘅 key），仍要題型需要 page；有工號嘅題用 prod key 配對會計 skipped_identity_mismatch。

**TE-8 printed 防誤中**（老闆個案：證書序號 `QATW1026240` 內嘅 `TW102624(0)` checksum 巧合通過，被當成身份證號）：腳本＋導入 extract／aggregate／TE-4 重讀共用規則 ① **token 邊界**：HKID 候選前後唔可以緊貼英數字（括號 check digit 本身係邊界）；② **label 優先**：同行或緊貼上一行（淨 label）有身份證 label（身份證號碼／身份證／I.D. Card No／ID No／HKID／Identity Card）嘅候選排先，每頁淨出 label 候選；冇 label 先退到有括號 check digit 嘅無 label 候選（唔收純英數串）；③ **跨頁多個唔同值**→ 整個 printed 來源跳過（`printed_multiple`；導入 `hkid_printed_multiple`），一致先出（label 行優先，最多 2 張）；④ 裁圖由 label 起裁到號碼尾（label 喺上一行就兩行聯合）。**全庫自檢**：`npx tsx scripts/staff-import/21-printed-audit.ts --package … --person-fields … --extract … --out data/…/printed-audit.json`（`--dry` 合成 fixture）——對所有人（非身份證頁 OCR 行）比較新舊規則，console 只計數（舊規則候選嵌喺長 token／冇 label／新舊唔同／多值衝突），`--out` 列受影響 personKey＋docId（俾你重出 zip）。**取代上載**：zip manifest 頂層 `replace:[{doc_kind:"printed",field:"hkid"}]`——對 manifest 入面有圖嘅每個人，同欄同 doc_kind 嘅舊圖（sha 唔喺今次 manifest）軟刪（audit `triage_evidence_withdraw` 記圖 id＋`replaced_by_upload`；dry run 回 `would_withdraw`），再收新圖。**錯圖撤回**：題卡每張裁圖「呢張圖錯／唔相關」（要「導入分診:update」）→ `POST /api/triage/evidence-images/:id/withdraw {reason:"wrong"|"unrelated"}`，軟刪（bytes 清空、DTO／GET 唔再回），重上載同 sha 計 `skipped_withdrawn`。**注意**：導入 extract 規則只對下次導入生效；已存在嘅錯 printed 圖要用取代上載清走。

**TE-9 身份證號屬系統內現有保安員（同一人分裂成兩條，例如冇名冇工號嘅孤兒文件人）**：輸入（或建議）嘅身份證號按 canonical（唔理括號／大小寫／空格寫法）完全等於系統內**唯一一位**現有保安員、而佢唔喺題目候選時，預覽唔再直接攔，改回 `needs_decision { reason:"hkid_matches_existing_guard", candidates:[該保安員卡（標 same_hkid「身份證號相同」）], options:["link","skip"] }`——**唔准建新人**（`extra.create_new` → 400；冇連結直接答 → 422）；題卡候選卡有「係同一人，連結並補資料」一撳連結（要「保安員個人資料:view」＋「保安員:update」，否則 options 淨 skip）；link 經現有 `extra.link_guard_id`（同名**或**身份證號相同嘅保安員先可連），答題後圖即刪（M5）；同一號碼屬兩位保安員（資料異常，寫法唔同）→ 422 人話「請先處理重複保安員」。OCR 重讀 proposals：hkid 建議（含 printed_only 低信心）等於一位現有保安員嘅號碼 → 唔自動答，計 `skipped_needs_decision`。**範圍說明**：連結會將該孤兒題嘅答案（身份證號／補填欄位）寫入現有保安員；孤兒文件本身冇獨立「保安員附件」資料表，所以冇另外「掛文件」——證據圖按答題即刪不變式清走。

**TE-9.1**：① 連結時輸入嘅姓名同目標保安員現有姓名唔同 → 預覽加 note「輸入嘅姓名同現有紀錄唔同，連結後保留現有姓名（請再核對係咪同一人）」（按實際寫入變更：會覆蓋就講「將覆蓋」）；② 同一身份證號屬兩位保安員（資料異常）→ 預覽回人話＋導航卡 `impact.nav {label:"去處理重複保安員", href:"/guards"}`（只對有「保安員個人資料:view」者；**href 唔帶身份證號**——個人資料唔放 URL，卡上提供「複製身份證號」去 /guards 搜尋），題卡顯示一撳去處理；直接答仍 422。

**TE-10 中文名裁圖切字（卡好細時 OCR 行 box 漏尾字）**：身份證左欄文字欄（中文姓名／英文姓名／出生日期）裁圖右邊界唔再止於 OCR 行 box——延伸到「相片左緣（同相片垂直重疊先算）」或「同一行下一個 OCR 行左邊」（取較近）減 0.3×行厚；有預期字數（package 該欄值：中文字數×1 em、英文字母數×0.55 em）就只延伸到預期字數×字寬（＋0.3×行厚）。硬性尺寸上限（capBox）長度改為 max(行長＋1.2×行厚, 預期字數×字寬＋0.6×行厚)；相片 barrier 仍成立。入職表姓名欄：值後冇其他 OCR 行時右界亦按預期字數延伸（有下一個 label／OCR 行就止於佢）；嵌入卡同身份證路徑。**Vision 驗證**：中文姓名裁圖讀數字數少過包內字數 → `name_truncated`（唔再因 2/3 重疊 ≥0.5 通過）：按缺少字數延伸右界重裁一次再驗，仍少字就跳過（計 `name_truncated`，唔出斷字圖）。**自檢**：`npx tsx scripts/staff-import/22-name-crop-audit.ts --package … --person-fields … --extract … --out data/…/name-crop-audit.json`（`--dry` 合成 fixture）——有身份證頁嘅人入面 OCR 中文名行字數少過包內字數嘅人數同分佈（少 1／2／3+ 字），console 只計數，--out 列 personKey＋docId（俾你重出裁圖）。**題卡 409**：預覽後資料變咗（同一人／同一保安員另一題先答咗）→ 確認時自動重新預覽一次，顯示「資料啱啱更新咗，已重新預覽，請再確認」，再撳確認即可；重新預覽仍失敗先顯示原本紅字。

**TE-11 讀啱晒就唔應該出題（證件為準）**：A 身份證英文名換行（卡好細時續行）——`extractIdCard` 將「英文名行之下 ≤1.3×行高、左對齊（x 差 ≤0.5 行高）、Title-case／大寫 token、未到出生日期／簽發 label」嘅下一行（最多 3 行）接成一個值；裁圖取兩行聯合 box（相片 barrier 照舊）；Vision 驗證英文名：讀數 token 數要 ≥ max(包內, 入職表 formNameEn 等候選) 先通過，否則 `name_truncated`→向下延伸一行重裁一次，仍少就跳過。B proposals「證件為準」：`name_not_confirmed` 卡讀數（two_reads、confidence high、doc id_card、冇 card_name_conflict／printed_card_conflict）同包內唔一致 → `enter_name`（中文名）＋`extra.name_en`（卡英文名，包內英文名未確認先帶；server 新增 enter_name 容許帶 extra.name_en）自動答；`hkid_not_confirmed` 卡 hkid checksum 過＋high 同包內唔同 → `enter_hkid`；身份決定（號碼屬現有保安員／同名候選）照舊由 preview 留人（skipped_needs_decision）；medium／low／arbiter 照舊留人；field_review 照舊。C import 規則（下次導入先生效）：身份證兩讀一致即 confirmed（source id_card），入職表 formNameEn／檔名／名單唔一致只係資訊、唔阻 confirmed；新增防漏字：Vision 中文名字數少過身份證頁 OCR 字數（`nameZh_vision_short`）／英文名 token 數少過 OCR（`nameEn_vision_short`）→ review。**自檢**：`npx tsx scripts/staff-import/23-auto-close-audit.ts --package … --proposals data/…/proposals.json --out data/…/auto-close-audit.json`（`--dry`）——按題型統計按 B 規則可自動關閉嘅題數（console 只計數；C 要重新導入先見到，唔喺度模擬）。

**TE-11.1**：重讀 proposals 嘅 confidence 改為「證件為準」——身份證頁（id_card／嵌入卡）欄位兩讀一致（basis two_reads；hkid checksum、dob 曆法已喺 normalizeField 驗過）＝**high**，唔需要入職表交叉一致或印刷佐證；入職表同卡唔一致只帶 flag `form_differs`（資訊／中等警告，唔降級）；印刷佐證一致加 `printed_corroborated`（資訊）。照舊留人（medium／low）：印刷同卡唔一致（`printed_card_conflict`）、`card_name_conflict`、仲裁（arbiter）介入、兩讀唔一致；非身份證來源（電話／地址）照舊交叉一致先 high。23 自檢同此規則（卡 two_reads＋form 唔一致→可自動關閉；printed conflict→留人）。

**TE-11.2 錯人卡防線（整頁身份證＋嵌入卡兩條路徑）**：重讀腳本按入職表差異分級卡 proposals：(a) 輕微差異——入職表中文名同卡上中文字元重疊 ≥0.5，或英文 looseEnglishNameMatch 一致（任一達標）→ 維持 high＋`form_differs`，自動答；(b) 完全唔相似——入職表有中文或英文名但兩者都唔達標，或入職表出生日期已讀到而同卡唔同 → **medium＋`form_conflict`**，留人；(c) 入職表冇可比姓名 → 要打字名單（U Team／Maxwell／DB 按工號或電話對到）姓名同卡一致（`--crosscheck data/…/crosscheck.json`，需導入抽取中文名＝今次卡讀數）或印刷佐證一致（printed_corroborated）先 high，否則 **medium＋`card_unverified`**。入職表英文名來自導入抽取 aux.formNameEn（重讀入職表只讀中文名／HKID／出生日期）。舊「卡 cross differs 一律當錯人卡降 low」已由呢個分級取代（嵌入卡路徑仍保留卡姓名 vs 包內姓名、打字名單 mismatch 嘅 card_name_conflict 防線）。server 旗標枚舉加 `form_conflict`／`card_unverified`；自動答嘅題 `triage_answer` audit 記 `answered_via=ocr_reread` ＋ `answered_flags`（淨旗標）。console 計數加「入職表輕微差異／完全唔相似／冇名而冇名單佐證」；23 自檢加「靠卡修正但入職表完全唔相似而留人」人數。

**TE-11.3 兄弟姊妹證件夾錯**：分級收緊——(a) 中英文兩邊都可比：兩樣都要過（中文字元重疊 ≥0.5；英文 looseEnglishNameMatch，或入職表 token 係卡 token 子集＝入職表漏咗中間名）先算輕微差異（high＋form_differs），任一唔過＝conflict（medium＋form_conflict，例：卡「陳大明／CHAN TAI MING」vs 入職表「陳大文／CHAN TAI MAN」）；(b) 只得中文可比而唔完全相同（例如差 1 字）→ 要硬證據先 high：入職表手寫 hkid（formReads／aux.formHkid，checksum 過）＝卡 hkid、或印刷佐證一致、或打字名單按工號／電話對到而名單姓名＝卡姓名；冇硬證據 → medium＋form_differs（留人，console「中文差字冇硬證據」）；(c) 完全相同／空白差異 → high。23 自檢加「中文差 1 字而冇硬證據留人」人數。

**TE-11.4 proposals 套用 skipped_invalid 診斷**：proposals 回應加 `invalid_reasons:{原因:條數}`（`preview:<原因碼／人話首句>`＝預覽已唔可寫入；`submit:<狀態>:<code>`＝commit 被拒（TE-11.5：唔再記訊息——訊息可能帶電話／工號原值）；全部固定碼，唔記任何值，單位＝建議條數）同 `resubmitted`（commit 遇 409「資料中途變咗」而自動重新預覽再答一次嘅題數）；/triage「導入 OCR 重讀建議」對話框顯示原因清單。注意：dry run 只逐題預覽（唔寫入），套用時逐題「預覽→即刻確認」，前一題寫入可令後一題（例如同一 hkid／同一保安員嘅重複記錄、同一人另一題）狀態改變——所以 dry 計數只係估計；以 `invalid_reasons` 為準追查。
**TE-11.5**：預覽／commit 指紋穩定——`loadCtx` 全部查詢加穩定 orderBy（id），`fpNormalize` 對陣列做標準排序（行序唔同唔再令預覽同 commit 指紋唔一致而 409，Opus 認為係「第一題成功、其餘 409」嘅最可能根因）；proposals 以 questionId 去重（同一題經 person_key 同推導 key 各配一次→只答一次，後者計 `skipped_duplicate_question`）。
```
   TE-2：對每個人**所有非 confirmed 欄**（review／missing／absent）＋入職日期出圖，唔理 OCR 讀到讀唔到值；每頁（唔理導入分類）搵夾喺牌照頁等嘅嵌入式身份證同證書頁印刷嘅身份證號；**每欄上限 3 張、每人 18 張（原 2／12）**。伺服器只收仍有 open／skipped 題需要嘅欄，其餘 `skipped_not_needed`。身份證圖一律即時由原 PDF 頁裁（號碼區／中文姓名區／英文姓名區／出生日期區各自裁，**避開相片區**；認唔出卡面就唔裁）；電話／住址證明優先用現成單欄裁圖，冇就用 OCR 幾何即時裁；入職表其他欄用 label 行（best effort，只作 priority 2）。縮至長邊 ≤800px、JPEG、`-strip`（剝 EXIF／APPn）、≤120 KB。輸出 `--out/triage-evidence-001.zip…`（每 zip ≤300 張／≤7 MB；entry 名＝圖 sha256 前 32 位；manifest 每張帶 `field`／`doc_kind`／`priority`／`match`，`match` 同圖由同一條 package 記錄產生）。console 只有計數。`--out` 必須喺 `data/` 下。
   **Vision 驗證（TE-1.7）**：每張裁圖裁完用本機 Apple Vision（`vision-ocr.swift`，離線；預設編譯到 os.tmpdir，要 swiftc；可 `--vision-bin`）讀一次同 package 該欄預期值比對（號碼／電話／日期 ≥0.7、姓名 ≥0.5、地址 ≥0.4），低過門檻跳過（`value_mismatch`＝裁錯欄／錯人／抬頭）；方向由 `.fast` 識別級別判斷（對方向敏感；`.accurate` 四個方向都讀到同一串字，所以唔能靠它揀方向），純中文裁圖分唔出 180°／側躺 90°／270°（`orientation_unknown` 跳過，其餘靠版面推算 prior）。Vision 讀出嘅文字只喺記憶體比對，唔寫 log／檔案；manifest 帶 `verify_score`。冇 swiftc 自動 no-verify（或 `--no-verify`）。**`data/ops/` 備份要納入保留政策**（zip 內係明文 JPEG，補做完要刪）。
3. **上載**：`/triage` → 保安員證件資料導入嗰張卡 →「⋯」→「上載覆核裁圖」→ 揀 zip → 自動 dry run（檔內幾張／配對幾題／可儲存幾張／各跳過原因）→ 確認「確認儲存 N 張」。分批（約 600 張＝3–4 個 zip）逐個上載；重覆上載同一 zip 安全（`skipped_duplicate`）。
4. **首批人手抽查 10 題（M7）**：上載後喺題卡抽 10 題，對住圖睇人↔圖有冇對錯（伺服器只驗 manifest 身份同題目 evidence 一致，驗唔到圖內容）；有錯就停手回報，唔好繼續答。
5. **私隱／運維**：DB 備份／dump 內只有密文（`SESSION_SECRET` 輪換後舊圖解唔開＝當搵唔到，題目 key 輪換時舊圖亦會隨 supersede 刪走）；hard delete 後磁碟空間要 VACUUM／WAL／快照先真正清走。全表大小告警：>200 MB 要查（正常 <20 MB）。`ai.audit_log` 已排除本表，`zoikan_ai_ro` 讀唔到。

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
- **群組列表空（「同步群組」後群組 0 個，訊息清單見「（未同步群組）」）**：WAHA NOWEB engine 預設 `config.noweb.store.enabled=false`，**呢個係建 session 時先決定**——冇 store 時 `GET /api/{session}/groups` 回空；要開 store 就要改 session config 後 **logout 再重新掃 QR**。部分 NOWEB 版本回應係以 jid 做 key 嘅 object map（唔係 array），系統三種形狀（array／`{groups:[]}`／jid map）都接受。系統已有後備（WA-6）：撳「同步群組」時，WAHA 列表之後再由已收訊息（`whatsapp_messages.chat_jid` 以 `@g.us` 結尾而 `whatsapp_groups` 冇）補群——`kind=ignored`、群名「未命名群組（尾 6 位 jid）」、`label_locked=false`；之後 WAHA 列表有名會自動改名，老闆亦可喺群組行／綁定設定直接改名（改咗即 `label_locked=true`，同步唔再覆蓋）。我哋唔會呼叫 `POST /api/{session}/groups/refresh`（WAHA 文件警告 rate-overlimit）。
- **同步群組失敗原因分類**（WA-6）：群組請求加 `?exclude=participants`、timeout 20 秒（session 狀態仍 5 秒）。WAHA 列表失敗唔令 sync 失敗：照樣由訊息補群，回 200＋`waha_error { kind, status?, code, message }`——`timeout`（`waha_timeout`，群組太多或 WAHA 忙）、`http_error`（`waha_http_error`，帶 HTTP status）、`bad_response`（`waha_bad_response`）、`unreachable`（`waha_unavailable`）、`not_configured`（`waha_not_configured`）；server 一行 log `[whatsapp] group sync failed kind=… status=…`（唔含 URL／key／內容），audit `whatsapp_group_sync_failed`（after 只有 kind／status）。
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

### TE-11.6 指紋差異診斷＋生成值正規化
- 預覽／commit 指紋改用 `fingerprintInput`：本次 run 新生成嘅 row id（create 嗰筆 rowId）喺任何位置出現都換成穩定佔位 `<new#n>`；key 以 `xxxAt`／`xxx_at` 結尾嘅時間戳唔入指紋（原有 id／guardId／createdAt 等照舊剔除）。
- commit 時 `preview_hash` 409 會帶 `details.diff_paths`（對比預覽暫存嘅指紋輸入，只路徑＋類型 `:value/:type/:missing/.length`，冇值），`invalid_reasons` 顯示為 `submit:409:conflict:<path>[,<path>]`（最多 3 條）。預覽輸入暫存喺 server 記憶體 10 分鐘；跨 instance／重啟會顯示 `preview_not_cached`。

### TE-12 重讀 proposals 缺口
- `19-triage-reread` 的 proposals.json `summary.persons[]`＝逐人診斷（person_key、staff_numbers、每個覆核欄 status／reason／confidence／flags，唔記值）；console 只計數。reason：`proposed`／`no_read`／`wrong_source`／`not_confirmed`／`invalid_format`／`typed_list_disagrees`／`no_docs`／`read_failed`。
- 打字名單唔一致（`mismatch_*`）唔再阻擋身份證頁 two_reads 一致嘅姓名／hkid／出生日期：照出建議並加 flag `typed_list_differs`；有硬證據（入職表手寫 hkid＝卡、印刷佐證、工號／電話名單對到）先 high，否則 medium（唔自動答）。電話／地址（非證件來源）同仲裁介入欄照舊阻擋。
- 仲裁同意讀 A（`arbiter_agree_a`）改出 medium 預填建議（flag `arbiter_agree_a`，唔自動答）。server proposals schema 加咗兩個 flag。
- `24-open-gap-audit.ts --open-questions <json> --package … --proposals … --out data/…`：未答題清單（person_key、staff_numbers、kind、review_fields，無值）逐題分類 auto_answerable／proposal_not_auto／wrong_field／no_proposal（帶逐欄原因）／no_docs／person_unmatched／kind_unsupported。
- TE-12.1：`typed_list_differs` 要升 high 只認獨立於文件包嘅證據（按工號／電話對到嘅打字名單姓名＝今次卡讀數）；入職表手寫 hkid／印刷佐證同卡同源，整包配錯人時會互相一致，唔計 → medium 留人。`typed_list_differs` 本身改用今次卡讀數同 package 該欄（打字名單）值重新比較：一致＝OCR 讀錯已修正，high 唔加旗。
- TE-12.2：刪走「卡讀數＝package 值就當已修正」捷徑（package 值本身由文件讀出，可能係配錯人嘅卡）；有 mismatch_* 一律 typed_list_differs，high 只靠 listOk（--crosscheck 名單按工號／電話 match 且導入抽取姓名＝今次卡讀數；中文 normZh、英文 looseEnglishNameMatch）。冇 --crosscheck＝全部 medium。

## EMP-P1 回填更次工號歸屬（2026-10）

```
npm run db:backfill-shift-staff-numbers                    # dry-run（預設）：逐月逐類計數，唔寫
npm run db:backfill-shift-staff-numbers -- --apply         # 真係寫
npm run db:backfill-shift-staff-numbers -- --month 2026-08 # 只做某月（可重複 --month）
```
- 規則同 API 寫入點一致（上載證據 `roster_file`（經 `provenance.row_id` 對 `roster_upload_rows.staff_no_raw`）→ 長工 B07 嘅 MG 卡 `longterm` → 盤 `staff_scheme`＋期間 `range`／`sole`）；`ambiguous`／`unresolved` 唔寫。逐月一行：掃描、roster_file、longterm、range、sole、unresolved、ambiguous、會寫／已寫。
- 未鎖月：直接寫 `shift_records` 三個新欄（`staff_number_source` 加 `backfill:` 前綴；raw SQL 只更新三欄，**唔觸發 `updated_at`、唔掂任何金額欄**）。已鎖月（`month_closes.locked_at`）：`shift_records` 一欄都唔寫，歸屬寫 `shift_record_staff_attributions` 側表。
- 冪等（只處理未有歸屬嘅非作廢更次）；每次 `--apply` 寫一條 audit summary（`action=backfill_shift_staff_numbers`，只有逐月計數，唔逐條）。
- 先去「盤」設定頁設好各盤 `staff_scheme`（U／MP）、並補齊人嘅 MP／MG 卡及入職／離職日期，再回填，`range`／`sole` 先會有結果；盤未設定 scheme 嘅更次只有 `roster_file`／`longterm` 兩條路。
- Gate 跑法備註（worktree）：`gate:locked-months` 要 `data/`、`tools/importer/out`、`tools/importer/venv` 三個 gitignored 資源（symlink 返主 repo）；缺 venv 會令 `gate:reports (b3)` SKIP 同長工分攤總額由 897652.35 變 899945（環境差異，唔係代碼）。
- EMP-P1.1 補充：(1) 長工歸屬只認結算單位＝`internal_longterm`（B07）；未結算（`settlement_broker_id` null）嘅更次唔掛 MG 卡，待一鍵結算補結算單位時順便補。長工 MG 卡後備（current）只限張卡冇日期，或 workDate 落喺佢 `valid_from`～`valid_to` 內，否則 `unresolved`（入職前嘅更次唔會掛去之後先發嘅卡，亦唔會永久寫入鎖月側表）。(2) 回填每批 UPDATE 都帶 `NOT EXISTS (month_closes … locked_at IS NOT NULL)`，跑緊期間有人鎖月，後面批次 0 寫入。(3) `no_staff_number_count` 只計「盤已設 `staff_scheme` 或 B07 長工」而推唔到嘅格；盤未設 scheme 嘅格唔計。

## EMP-P2 糧按工號卡分組（2026-10-20）

- 糧單以「工號卡」為最細單位：同一人同月有 MP 更同 U 更，出糧單合併做同一份，但分開兩行列明（逐人糧單）。要睇準，更次要有工號卡歸屬：先去「盤」設定頁設好各盤 `staff_scheme`、補齊人嘅 U／MP／MG 卡，再跑回填（`npm run db:backfill-shift-staff-numbers`，見 EMP-P1 回填）；未標工號嘅更次會歸「未標工號」一行，月結診斷有「未標工號更次」同「盤未設工號體系」兩條直達卡。
- U＝Wilson 盤（登記工號），**出糧全部係在勤**（老闆 2026-10-20 更正；舊 migration 種子 U＝wilson 已由 `20261028000000_emp_p2_2_payer_fix` 更正，只改 U 行設定）。逐人糧單「出糧方」全部在勤，另有「出糧途徑」欄（經雞頭／在勤直接／未歸屬）講錢點到人手。
- 出糧方按體系：設定頁「工號體系」（`/settings/staff-schemes`，老闆）改 U／MP／MG／MW 嘅顯示名、出糧方、出糧方式；唔寫死。
- 長工頂位規則（老闆 2026-10-20 拍板）：長工用 U／MP 卡開散更唔計頂位津貼（散更糧已出）。2026-10-01（`LONGTERM_SCATTER_EFFECTIVE_FROM`，`src/lib/longterm-payroll/shift-classify.ts`；10 月係第一個肯定未鎖嘅月，9 月如已出糧唔郁）起生效，看更次 `staff_scheme`；7／8／9 月行舊邏輯。規則只適用於「settlement 有值而且唔係 B07」嘅更（B07 更永遠係自己崗位）；10 月起更次要有 `staff_scheme`（盤已設 scheme 或回填）規則先會生效；冇 scheme 嘅更次照舊跟 settlement。要改生效日只改該常數＋api.md／本段文字。
- 逐人糧單「個人金額」唔含雞頭費；雞頭費另欄顯示、唔入個人 total；長工毛額（MG 行）另行獨立小計，見長工糧表。
- 改 `staff_schemes`（出糧方／出糧方式／顯示名）會即時反映喺所有月份嘅逐人糧單（顯示層），唔影響金額。
- Gate 備註：每雞頭 sheet 行數會變（每人每卡一行），`糧明細總表(按雞頭)`／`buildPayrollTotals` 數字不變（`perf:snapshot` 的 payroll 欄位逐項相同）。

## EMP-P3 長工糧改讀 MG 卡日期（2026-10）

- 生效：2026-10 起（`LONGTERM_CARD_DATES_EFFECTIVE_FROM`，`src/lib/longterm-payroll/employment-period.ts`）；7／8／9 月永遠讀人卡，已鎖月重算數字不變。10 月前建議先跑對拍：`npm run db:longterm-card-dates-diff -- --out data/longterm-card-dates-diff.json`，睇 mismatch／rehire_suspected／card_no_dates 嘅人，由 office 補 MG 卡入職／離職日（工號卡抽屜），補完人卡兩欄會自動鏡像。
- 離職再入職：第二段開新 MG 卡（唔好改舊卡）——舊卡「結束」填離職日＋原因 resigned，再開新卡填入職日；系統由卡鏈偵測（有更早、resigned 嘅鏈）→ 當第二段聘用出糧（warning `rehire_detected`），病假／年假以新段 0 開局。換號（replaces_current）唔係再入職：新卡日期欄叫「換號生效日」，唔會改寫入職日。
- 人卡表格唔可以再直接改有日期 current MG 卡嘅人嘅入職／離職日（409 `use_staff_number_card`）——要喺工號卡「結束卡」（離職日＋原因）或開新卡。Maxwell 離職名單最後一日若屬上一段（早過現行聘用段起點）會警告 `leaver_date_before_segment` 並唔結束卡。
- 鏡像規則見 api.md「EMP-P3」：只睇長工體系卡；卡全部冇日期就唔郁人卡值。
- P3.2：Maxwell 離職名單只睇「最後一日」早過卡 valid_from／人卡 hire／合約鏈起點先當上一段（唔結束卡）；導入入職日差幾日唔阻結束卡（只出 `[import_hire_date_differs]` 提示）。鏡像改咗人卡日期會喺工號卡操作後即時顯示 hint（`hire_date_mirrored`／`leave_date_mirrored`／`leave_date_overwritten_by_card`）；**未鎖月份重算會跟新人卡值，已鎖月不變（接受）**。上線前對拍腳本睇 `resigned_without_valid_to`，補晒 valid_to 先令再入職判斷準確。
- 警告：長工糧 `warnings` 會出 `[rehire_suspected]`（任何月份）、`[card_guard_date_mismatch]`／`[rehire_detected]`（10 月起）。


- EMP-P2.3：逐人糧單／by_card 聚合**剔出**客戶自己嘅人（結算單位 kind=external，settlementType=none，唔入糧）——唔計人數、唔出行；獨立計數 `GET /api/reports/payroll?view=person` 回應 `external_shifts`（客戶自己人 N 更，唔適用）。LINK 盤（`sites.guards_paid_by_client`）更次即使有舊 snapshot 都唔入 wage／fee／total（SQL `FILTER (WHERE NOT guards_paid_by_client)`），仍計更數並加備註「LINK 盤更數 N（唔計價）」。

## HIST-1 歷史月份更表上載＋假期結餘回填（2026-10）

目的：老闆唔俾現成病假結餘數，會逐步上載 2026-07 之前月份嘅更表，由系統由更表計返長工病假／年假結餘。

**核實結果（舊月份上載點處理）**：roster-upload（`service.ts` `processRosterUpload`、`reconcile-apply.ts`、`lock-precondition.ts`）對月份冇下限、唔要求 `month_closes` 行存在（冇行＝未鎖）；`lock-precondition` 對 2026-08 前月份直接放行；介紹費自動計（`REFERRAL_FEE_AUTOCOMPUTE_MIN_MONTH=2026-08`）只喺一鍵結算入面跑，早過起計月份唔重算。**唯一會自動撞板嘅副作用**係排程：`auto_one_click`（每 5 分鐘）對「任何未鎖、有 parsed 上載」嘅月份自動跑一鍵結算（含長工糧、月結），舊月份上載後靜置 10 分鐘就會被觸發；另外 `nightly_month_health`／`longterm_input_drafts` 對本月＋上月、待對數總覽 `pending-summary`（冇指定月份）會涵蓋。所以要標記。

**歷史月份標記**：`month_closes.historical Boolean @default(false)`（migration `20261029000000_hist1_month_close_historical`，純加欄）。建立：`POST /api/month-closes { month:"2026-05", historical:true }`（`糧務:create`）；該月已有 month_closes 行而未鎖、冇一鍵結算 run、冇長工糧 run → 就地標記（200）；已鎖或做過月結／糧 → 409。標記後該月：
- 可以照常上載更表、對數、套用（落更 `shift_records`，含 leave SL／AL／SH；leave 本身無 snapshot）；
- `POST /api/month-close/one-click`、`POST /api/month-closes/:id/lock`、`POST /api/month-closes/:id/generate`、`GET /api/reports/month-health`、`GET /api/diagnostics/month`、長工糧計算（`recomputeLongtermPayroll`）一律 409 `historical_month`；
- 排程 `auto_one_click`（summary.skipped=`historical`）、`nightly_month_health`、`longterm_input_drafts` 跳過；`pending-summary` 冇帶 month 嘅總覽唔計（明確指定該月照出）。
- 介紹費、糧、鎖月流程唔會跑。標記冇「取消」API（要取消搵管理員改 DB）。ops digest 只睇當月起計三個月，唔受影響。

**流程**：(1) 對每個舊月份 `POST /api/month-closes {historical:true}`；(2) 逐盤上載該月更表、對數套用；(3) 全部上載完，`npx tsx scripts/db/leave-opening-from-rosters.ts --as-of 2026-06 --out data/leave-opening.json`（dry-run，預設）睇差異清單；(4) 確認後加 `--apply` 寫入。

**結餘腳本** `scripts/db/leave-opening-from-rosters.ts`（`npm run db:leave-opening-from-rosters -- --as-of 2026-06`）：
- 對象＝長工（有未作廢長工合約，或有長工體系（`staff_schemes.is_longterm`，出廠 MG）工號卡）；
- 計算（截至 as-of 月尾含）：AL＝不同 AL 日子數；SL＝SL 日子按連續曆日分段，逐段按 compute.ts 規則模擬（段開始日累積結餘 `slAccrued(入職日, 段開始日)`＝做滿 1 個月先儲、每月 2 日、上限 120，減已用；結餘 ≥ 段日數＝有薪 4/5 食結餘，否則無薪唔食）。**假設**：歷史月份冇醫生紙人手確認，一律當已確認（同 P17.1 `SL_CONFIRMED_SHORT_PAID`）；RD／OFF 夾中間唔橋接；WhatsApp 未批核更唔計；入職日用 `guards.hire_date`（EMP-P3 `resolveLongtermPeriod` 未合併；合併後可換成 helper，冇入職日標 `no_hire_date`，slAccrued 當 0）。
- 寫入（`--apply`）`guard_leave_balances (guardId, year=as-of 年)`：`alTaken`／`slTaken`＝截至 as-of 月尾累積（as-of 之後月份計糧讀呢兩欄做 opening）、`alTakenOpening`／`slTakenOpening`＝截至 as-of 前一個月月尾累積（同月重算用）、`slAccrued`＝as-of 月尾累積結餘、`asOfMonth`＝as-of 月。只喺該 guard 該 year 行 `asOfMonth` 為 null 或早過 as-of 先寫；冇行就建（全部歸零就唔建）；asOfMonth ≥ as-of（計糧已推進，例如已計 7／8／9 月）一律唔郁，只喺差異清單 `skip_existing_newer` 列出。冪等；每次 `--apply` 一條 audit summary（`action=backfill_leave_opening`，只有月份＋計數）。
- 輸出：console 計數；`--out`（限 `data/` 或 `out/`）JSON 只有 `guard_id`＋數字＋月份，每人 `computed` vs `existing` 同 `diffs`（欄位 → [現有, 計算]），用嚟同銀行差額（8 月 −3,936.43、9 月 +1,287.97）對返；`flags`：`no_hire_date`、`sl_unpaid_segments:N`。
- 已計過 7／8／9 月嘅現有環境：`guard_leave_balances` 2026 行 `asOfMonth` 已係 9 月，腳本唔會覆蓋，只出差異清單俾人手判斷（要改需先處理已計月份，見 `recomputeLongtermPayroll` 「later asOfMonth」保護）。

### HIST-1.1 補充（Opus 驗收後）

- **歷史標記限制**：`HIST_MAX_MONTH = 2026-07-01`（`src/lib/month-close/historical.ts`）——只可標**早過** 2026-07-01 嘅月份（7 月起係正式月結月份）。建新行同就地標記兩條路都喺 tx 內攞一鍵結算 advisory lock（`ONE_CLICK_ADVISORY_LOCK_KEY`，同 `POST /api/month-close/one-click` 共用；one-click 開 run 嗰個 tx 拎鎖後再確認唔係歷史月份），並檢查：未鎖、冇一鍵結算 run、冇未作廢長工糧 run（已作廢嘅唔擋）。違反 → 409。
- **取消標記**：`PATCH /api/month-closes/:id { "historical": false }`（老闆專用，要「月結鎖定解鎖:void」；寫 audit；其他 body 400；本身唔係歷史月份 409）。
- **結餘合併模式** `--merge-into-existing`：（HIST-1.2 起限 as-of ≤ 2026-06、增量合併，見下）已有較新結餘行（`asOfMonth` > as-of，例如已計 7／8／9 月）嘅人，將 as-of 前歷史累積**加落**現有行嘅 `alTaken`／`slTaken`／`alTakenOpening`／`slTakenOpening`（`slAccrued` 按入職日重算到該行 `asOfMonth` 月尾，`asOfMonth` 不變）。每人合併後寫 audit `backfill_leave_opening_merge`（`row_id`＝guardId，`after.as_of`），再跑查 audit，已合併 → `already_merged`（唔會雙重加）。dry-run 的 `diffs` 列每人前後值。**只影響下一次重算（10 月起）；7／8／9 月已付數字唔郁。因結餘變化，個別 SL 段「有薪／無薪」判斷可能改變——要老闆知。**
- `--recompute-same-as-of`：已有行 `asOfMonth` 剛好＝as-of（上次腳本寫嘅）→ 覆蓋重算（補上載咗更多舊更表之後用）。差異清單標籤 `skip_existing_newer` 改名 `skip_existing_newer_or_equal`（asOfMonth ≥ as-of 且無對應旗標）。
- **SL 累積口徑（《僱傭條例》）**：`compute.ts` `slAccruedStatute`＝做滿 1 個月先儲、**首 12 個月每月 2 日、之後每月 4 日**、累積上限 120。`SL_ACCRUAL_EFFECTIVE_FROM = 2026-10-01`：`slAccrued(入職日, asOf)` 當 `asOf` 早過生效日照舊每月 2 日到頂 120（7／8／9 月已出糧 gate 不變），≥ 生效日用條例口徑。HIST-1 腳本計歷史累積一律用條例口徑（係重建真實結餘）。⚠ 注意：老闆 2026-09-28（WP-BOSS5 決定 4）曾確認「每月累積 2 日」，現按驗收意見改為條例口徑 10 月起生效，請老闆確認。
- 備註：`tests/emp-p1-backfill.test.ts` 「第一批同第二批之間鎖月」測試 flaky 根因＝回填腳本按 id（隨機 uuid）升序逐批掃所有月份，`--month` 篩選喺掃咗之後先做，第一批可能係其他月份更次（0 寫入）；舊測試固定喺 batch 0 後鎖月，約 1/6 機率 8 月一條都未寫。腳本本身語意正確，已修正測試（8 月寫到第一條後先鎖月）。

### HIST-1.2 補充（合併模式防重複）

- `--merge-into-existing` 只可 **as-of < `HIST_MAX_MONTH`（即 ≤ 2026-06）**；as-of ≥ 2026-07 直接拒絕（錯誤：只可用於 as-of 早過 2026-07）——7 月起嘅更次已經計入現有結餘行，再加會雙重計數。
- **增量合併**：每個 guard 合併後 audit（`backfill_leave_opening_merge`）記低 `after.as_of` 同當時累積 `cum.al`／`cum.sl`。再跑時：新 as-of 較後 → 只加「上次 as-of 之後至今次 as-of」嘅增量（今次累積 − 上次累積）；新 as-of ≤ 上次 → `already_merged`。例：先 as-of 2026-05 再 as-of 2026-06 → 5 月只加一次。四個欄位（`alTaken`／`slTaken`／`alTakenOpening`／`slTakenOpening`）加同一個增量（歷史全部喺現有行起算月份之前，所以 opening 都加全數而唔係「前一個月」累積）。
- 合併後 `slAccrued` 口徑：歷史段（入職日至 as-of 月尾）用條例口徑（`slAccruedStatute`），as-of 之後至現有行 `asOfMonth` 月尾按舊口徑每月 2 日（7／8／9 月實際計糧用嘅口徑），按月分段，封頂 120。

## SITE-SCHEME-1 盤工號體系預設建議（2026-10）

老闆唔想逐個盤揀體系。流程：
1. 盤頁（`/sites`）頂見「未設體系 N 個盤」卡 → 「一頁設定」（月結健康 `site_no_staff_scheme` 嘅直達連結亦指去 `/sites/staff-scheme-prefill`）。
2. 清單每行：盤名／客戶／建議體系（下拉可改 U／MP）／理由。建議規則（`src/lib/sites/staff-scheme-prefill.ts` `proposeStaffScheme`）：客戶名／客戶組／盤名／別名任何一個（大小寫、全半形唔分）含 `wilson` 或 `威信` → **U**，否則 **MP**；LINK 盤（`guards_paid_by_client`）照客戶判（Wilson 旗下 → U）。已設 `staff_scheme` 嘅盤唔會出現、唔會郁。
3. 撳「全部套用」→ `POST /api/sites/staff-scheme-prefill { apply:true, overrides?:[{site_id, scheme}] }`（要「盤:update」）：只寫未設定嘅盤（`UPDATE … WHERE staff_scheme IS NULL`，重覆撳冪等）；audit 一條 summary（`site_staff_scheme_prefill`，只有計數）。
4. 寫完即刻對該批盤嘅更次補推導工號歸屬（`backfillSiteStaffNumbers`，重用 EMP-P1「盤 scheme＋期間」規則 range／sole）：**只填 `staff_number_id IS NULL` 而且冇側表歸屬嘅 shift／ot**；未鎖月直接寫三個歸屬欄（唔掂金額、唔觸發 updated_at），已鎖月寫 `shift_record_staff_attributions` 側表；冇法分（多張冇日期卡／唯一卡唔包日期）唔推。回應 `backfilled`（實際寫入數）＋ `backfill.{written_direct, written_side_table, unresolved}`。老闆一撳，歸屬即刻有。
- 注意：回應 `by_scheme` 係 `[{scheme,count}]` 陣列（物件 key U／MP 會被 snake_case 轉壞）。單個盤逐個改體系仍可喺盤編輯抽屜做（唔會自動補推導，要補請用呢頁或 `npm run db:backfill-shift-staff-numbers`）。

### SITE-SCHEME-1.1（盤體系預設建議補充）

- **只對有更次嘅盤出建議**：`GET /api/sites/staff-scheme-prefill` 回 `proposals`（有 shift／ot 更次，而且至少一更係非 external 結算單位）、`not_applicable`（有更次但結算單位全部係 external＝客戶自己人，唔出建議、唔可套用，UI 列喺「唔適用」區）、`no_shifts`（完全冇更次嘅未設盤，只報數量）。
- **UI 預設唔剔**：每行逐個剔，或「全選建議 U」／「全選建議 MP」，再「套用已剔」＝`POST {apply:true, site_ids:[…], overrides?}`（只寫已剔、屬 proposals、仍未設定嘅盤；冇傳 `site_ids`＝全部 proposals，舊 client 相容）。
- **補推導改背景（揀咗 `after()`＋`job_runs`，最簡單可靠）**：寫 `staff_scheme` 仍同步（一個 tx）；歸屬補推導用 Next `after()` 喺 response 之後行，進度記喺現有 `job_runs`（jobKey `site_scheme_backfill`）；POST 回 **202**＋`job_id`，頁面每 2 秒輪詢 `GET …/staff-scheme-prefill?job=<id>`（`running`｜`ok`｜`error`＋summary 計數 `backfilled`／`unresolved`／`written_direct`／`written_side_table`）。卡死（running 超過 1 小時）由 scheduler runner 標 `error stale_running`。冇 Next request context（測試）→ 同步行完，202 回應已帶最終 `status`／`summary`。結果 notice：「已設定 N 個盤；補歸屬 M 更；仲有 K 更推唔到（人冇對應體系嘅工號卡）」，連去 `/month-close` 月結健康「未標工號」卡跟進。
- **改體系後重推導**：盤編輯抽屜改 `staff_scheme`（設成非空值而且真係變咗）→ `PATCH /api/sites/:id` 啟動同一個背景 job（mode reinfer），回應 additive `reinfer { job_id, note }`：對該盤 `staff_number_source IN ('site_scheme','backfill:range','backfill:sole')` 且**未鎖月**嘅更次清走三個歸屬欄再按新體系重推（手動／payload／roster_file／longterm 歸屬唔郁）；**已鎖月**（shift_records 同側表）唔郁，job summary `locked_kept` 報有幾多更要人手處理；audit `site_staff_scheme_reinfer`（只有計數）。

### AI-PII-2.3

- gross-margin `sites[].shiftTypes` 排序改用穩定業務欄（code → label → otHours → kind → revenue → cost → shifts），**唔用 UUID**（先前 tie-breaker 用 shiftTypeId，每次 DB 唔同令 snapshot 次序漂移）。
- 對數頁「相似保安員」名冊（`loadGuardDirectory`）加 `include_inactive=1`，離職者（status inactive）標「已離職」（`guardStatusLabel`）。
- HIST merge：as-of 年份冇結餘行而較後年份有行（`!b` 且 later-year）→ 同樣 `merge_rejected_different_year`（唔建 as-of 年份嘅行）。

### S-batch-1021：保安員狀態「已離職」(left) 同「作廢」(inactive) 分開

- `guards.status`（enum `ActiveStatus`）加值 `left`（migration `20261031000000_guard_status_left`，純加 enum 值，現有 `inactive` 行唔改）。`inactive`＝作廢／停用（void route 寫）；`left`＝已離職（人卡鏡像 `syncLegacyGuardEmploymentColumns` 同夜間 `flipLeftGuards` 寫，只由 `active` 轉）。
- 「非在職」判斷：server 端全部用 `status: "active"` 過濾（列表預設隱藏、`include_inactive=1` 先帶 left＋inactive、勤工獎／雞頭 dashboard／長工草稿等），自動包 left；client 端 `!== "inactive"` 位（更表揀人選單、價目表揀人）已改為同時排除 left。「恢復」（unvoid）對 inactive 同 left 都出現。
- 對數 label（`guardStatusLabel`）：left→「已離職」、inactive→「已停用」；列表狀態 pill 同。
- 舊資料：現有已離職但仍係 `inactive` 嘅行唔會自動改成 left（唔改現有資料）；下次鏡像／人手唔會再轉。需要時人手或另寫 backfill。

### S-batch-1021：背景 job 體驗／細項

- **盤體系補推導／重推 job（`job_runs.job_key = site_scheme_backfill`）**：失敗 summary 而家係 `{ error, error_code, message }`——`error_code`＝`err.name`，`message`＝`error_code`（S-batch-2：錯誤訊息文字一律唔存，避免夾人名／電話）。UI 輪詢最多 10 分鐘；仍 running 顯示「可能已中斷，可重新套用」（補推導只填空位，重做安全）。scheduler `sweepStaleRuns`：呢類 job running 超過 **15 分鐘**即標 `error / stale_running`（其他 job 仍 1 小時）。
- **補推導 unresolved 連結**：`/month-close?month=YYYY-MM#health-shifts_no_staff_number`（月份＝job summary `unresolved_by_month` 推唔到最多嗰個月，冇就當月）——直達月結健康「未標工號」卡（MonthHealthCard 按 hash 切去該項嘅級別 tab 並捲到卡）。
- **HKID 配對 index**：migration `20261031010000_guards_hkid_canon_index` 加 `guards_hkid_canon_idx` ON `upper(regexp_replace(hkid,'[^A-Za-z0-9]','','g'))`（`storedPhonesForHkid` 用同一表達式；普通 `CREATE INDEX IF NOT EXISTS`，CONCURRENTLY 唔可以喺 migration 交易內）。
- **OCR 電話 reason 口徑依賴導入預覽權限**：stage b 嘅 `phone_differs_from_list`／`phone_no_independent_source` 會透露「該 HKID 喺系統有冇保安員」（OCR-6.3 殘餘 oracle）；目前只有「安員批量導入:create」可用。**收緊導入預覽權限時要統一 reason**（例如兩者都回 `phone_no_independent_source`），免得權限同口徑唔一致。

- **S-batch-2**：gross-margin `sites[].missingSalaryGuardRefs` 改穩定排序（code-point 升序）。

### TE-13：「同一工號／電話出現喺多個人」題卡

- `evidence.shared_with[]`（generator 由 `noOwners`／`telOwners` 反查，只放狀態同工號：`person_key`／姓名／`hkid_status`／`has_docs`／`doc_count`／`staff_numbers`／`tel_status`，**唔放 HKID／電話值**）。`view.ts` 輸出 `evidence.shared_with` + `shared_staff_numbers`：姓名冇「保安員個人資料:view」＝null＋`name_hidden`；`question_id` 由同 session 同 kind、`personKey` 相同嘅題反查。舊題（冇 `shared_with`）題卡照舊。
- 題卡頂部白話「工號 U01xxx 同時出現喺 N 個人身上，請揀邊個先係真正用呢個工號」，列出每個人（本人標「（呢條題嘅人）」），「去嗰條題」只喺嗰條題已載入隊列時出。選項：「工號／電話係呢個人嘅（其他人唔用）」＝keep；「…唔係呢個人嘅（由呢個人剔走）」＝drop_shared。
- 空人後備放寬：所有個人欄 missing 就顯示「導入包只讀到呢位嘅工號（嚟自打字名單／更表），冇任何文件」＋原因＋檔案資訊（唔再逐行「—（未讀到）」）；爭議類 kind 嘅「冇裁圖」改「呢類題目唔需要裁圖」。

### TE-13 追加：ghost person 自動併入

- **ghost**＝由銀行戶口等文件產生嘅空記錄：`rating=fail` 或 reasons 含 `no_id_page`、七個個人欄全部 missing、冇 ext（牌照／平安咭／QAS／銀行／緊急聯絡人／入職日期）、有工號，而且**每個工號都只同同一個身份已確認（hkid confirmed 且有效）嘅包內 person 共用**，該工號喺打字名單嘅 HKID（package person 可選欄 `listHkids`：`{工號: canonical HKID}`，由 `package-v3.ts` 按 typed-sources 填；冇就當無矛盾）同真人一致（`findGhostPersons`，`src/lib/guards/import/package.ts`）。
- 效果：`packageConflicts` 唔再計 ghost 工號為共用；preview 評估 reasons 加 `dropped_ghost`（「由文件產生嘅空記錄，已自動併入…」）；apply 唔處理 ghost（唔建人、`persons_total` 唔計）；分診 generator 唔為 ghost 出題，真人嘅題 evidence 帶 `note`（「由銀行戶口文件產生嘅空記錄，已自動併入 U01095」）同合併後嘅 `docInfo`（頁數／各類頁數）。兩個真人共用、名單 HKID 唔一致、真人身份未確認 → 照舊出題（用新題卡列晒共用者）。
- **production 舊題收題**：`POST /api/triage/sessions/:id/proposals`（含 `?dry_run=1`）開頭會對 session 內仍 open 嘅 `staffno_shared_by_persons` 題跑同一條 ghost 規則（用題目 evidence 內嘅 person；舊題冇 `listHkids` 就當無矛盾），符合嘅 ghost 題同「淨係因 ghost 而共用」嘅真人題標 `superseded`；回應 counts 加 `ghost_questions_closed`（dry＝會收嘅題數，唔寫 DB）。真人另有其他衝突（電話共用／重複身份證等）就唔郁。亦可重新上載同一個包（新規則下會作廢舊題）。
- `24-open-gap-audit` 暫未加 ghost 分類（audit 輸入冇值，睇唔到個人欄／ghost 狀態）；要睇有幾多條會被收，用 proposals dry run 嘅 `ghost_questions_closed`。

### TE-13.1：共用工號／電話題「兩個選項都卡死」修正

- 問題：人冇 confirmed 身份證（例：只有電話＋工號），`drop_shared`（剔走爭議工號／電話）之後行 create 路徑，要 HKID confirmed → 擋；`keep` 同樣擋。
- 修正：`resolveAnswer` 新 outcome `mode: "dropped"`——`drop_shared` 而人冇 confirmed 有效身份證**而且題目冇 link 目標（targetGuardId）** → 答案接受、唔寫任何嘢（唔建人）、題目 `answered`（`apply_result_json.outcome = "dropped"`）、audit `triage_answer`（option＝drop_shared、outcome＝dropped、writes＝false）；預覽 `can_confirm=true`，summary「已剔走爭議工號／電話；呢筆記錄冇身份資料，唔會建人」，唔觸發 `needs_decision`。有 confirmed 身份證（或有 link 目標）照舊行 create／link。
- `keep` 對冇身份證嘅人保持擋，`reason_text`＝「要先輸入身份證號先可以建人…」；兩種 kind 對冇 confirmed 身份證嘅人加 `enter_hkid` 輸入選項（`input: "hkid"`）。已存在嘅舊題 options 唔含 `enter_hkid`，重新 apply 同一個包（作廢舊題重出）先會有。
- 唯讀自檢：`24-open-gap-audit` 新增 class `drop_shared_stuck`（共用題而包內個人冇 confirmed 有效身份證；reason `hkid_missing`／`hkid_not_confirmed`）。未答題匯出每條可加 `id`，輸出行會帶返 `id`，`summary.by_category.drop_shared_stuck` 即題數。
