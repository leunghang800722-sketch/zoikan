# API 清單（P1-WP2，含 Opus 對抗式驗收 C1–C4＋殘留 1–6 加固後版本）

> 呢個檔案本身唔准有真名／工號／電話（PDPO）。全部 API 一律 App Router
> route handler（`src/app/api/**/route.ts`），**request body 同 response
> body 一律 snake_case**（`{ client_rate, work_date, source_role_id, … }`）
> ——request body 由 `src/lib/api/schemas.ts` 嘅 zod schema 逐個 route
> 驗證（全部 `.strict()`，見下面「欄位命名」一節），response 由
> `camelToSnakeDeep()` 統一轉。未登入回 401；冇權限／硬性
> 禁止回 403（並寫 `audit_log`）；月份鎖定寫入回 403
> （`{ error: "month_locked" }`）；輸入驗證失敗回 400
> （`{ error: "bad_request", message: "輸入驗證失敗：…" }`）。

## 欄位命名（body casing）

- **Response body**：一律 snake_case（`client_rate`、`work_date`、
  `base_role`…），由 `ok()`（`src/lib/api/http.ts`）統一經
  `camelToSnakeDeep()` 轉。
- **Request body（全部 route）**：一律 snake_case（`work_date`、
  `effective_from`、`site_id`、`role_id`…），對應 `src/lib/api/
  schemas.ts` 嘅 zod schema（全部 `.strict()`）——傳一個 camelCase
  舊 key（例如 `workDate`）會俾 zod 當「未知欄位」拒絕，回 400（Opus
  對抗式驗收第三輪：「API 契約統一」，唔再有 camelCase／snake_case
  混寫嘅例外資源）。

## 認證

| Method | Path | 權限 | 說明 |
|---|---|---|---|
| POST | `/api/auth/login` | 公開 | `{ tel, password }`；錯5次鎖15分鐘；登入IP記audit |
| POST | `/api/auth/logout` | 已登入 | 清 session cookie **並 bump `users.token_version`**（舊 cookie 即刻失效，唔淨係靠清 cookie） |
| POST | `/api/auth/change-password` | 已登入 | `{ old_password, new_password }`；管理角色強制強密碼；bump token_version（重新 issue 帶新 version 嘅 cookie，唔踢走緊用緊嗰個 session） |

**Session 作廢（Opus 驗收殘留1）**：`users.token_version`——logout／
改密碼／改角色（`role_id`）／改雞頭（`broker_id`）／void user 全部
bump；`requireSession()`（`src/lib/rbac/requirePermission.ts`）每個
request 都同 DB 現值核對一次（一條 `SELECT token_version, status`），
唔啱就當未登入（401）。

## RBAC 矩陣（24 module × 5 action，Opus 驗收 C3 拆細版 + P3/WP-AI1/WP-PII/WP-ROSTER-UPLOAD 加）

單一事實來源：`src/lib/rbac/matrix.ts`。由舊版 10 module 拆細做 19 個，
P3 加咗`個人資料`、WP-AI1 加咗`助手`、WP-PII（老闆 2026-09-17 拍板）加咗
`安員個人資料`／`安員銀行資料`，WP-ROSTER-UPLOAD（老闆 2026-09-21/23
拍板）加咗`更表上載`，而家 24 個，逐個對應《設計文件》§5.1
表入面唔同粒度嘅行（詳細逐格對照見 README-P1.md「RBAC：module ×
action 矩陣」一節）：

`更表`／`配額`／`審批`／**`收客價`**／**`出街價`**（拆自舊「價目」）／
`盤`／`安員`／**`自己安員`**（新增，雞頭專用）／`雞頭`／`糧務`／
**`批核糧務批次`**／**`月結鎖定解鎖`**（拆自舊「糧務」void）／
**`用戶管理`**／**`操作紀錄`**（拆自舊「系統」）／**`毛利即時表`**／
**`尚欠總覽`**／**`月結總表`**／**`糧明細`**／**`更表匯出`**（拆自舊
「報表」，每份報表獨立一行權限，設計文件§5.0）／**`個人資料`**（P3）／
**`安員個人資料`**（WP-PII，管保安員身份證／出生日期／地址／緊急聯絡
人／Blacklist check——老闆／會計全睇、主管出廠關（老闆可以開）、雞頭／
安員硬性禁止）／**`安員銀行資料`**（WP-PII，管保安員銀行／戶口號碼／
收款人名——老闆／會計全睇、主管／雞頭／安員硬性禁止）／**`助手`**
（WP-AI1，側欄 AI 助手，雞頭／安員硬性禁止，見
[`docs/ai-assistant.md`](ai-assistant.md)）／**`更表上載`**
（WP-ROSTER-UPLOAD Phase A，管逐盤更表檔案上載——老闆／主管／會計 G，
雞頭／安員硬性禁止）。

**自訂角色（Opus 驗收殘留2）**：`roles.base_role`——複製一個出廠角色
時寫死（`POST /api/roles`），**唔可以再改**；硬性 deny 矩陣查詢一律用
`session.baseRole`（唔係顯示用嘅 `roleName`），所以複製「雞頭」再改名
做「高級雞頭」都逃唔過雞頭嘅硬性禁止。未知 `base_role`（理論上唔應該
出現）一律當最嚴處理（`requireSession()` 直接 403）。

## 資源 CRUD

除咗 `audit_log`（只讀）同 `month_closes`（**冇 void/unvoid**，用
lock/unlock 代替），其餘資源一律：
- `GET /api/<resource>`　list　— `<module>:view`
- `POST /api/<resource>`　create　— `<module>:create`
- `GET /api/<resource>/:id`　get　— `<module>:view`
- `PATCH /api/<resource>/:id`　update　— `<module>:update`
- `POST /api/<resource>/:id/void`　void（強制 `{ reason }`，zod
  `VoidReasonSchema`）— `<module>:void`
- `POST /api/<resource>/:id/unvoid`　解除作廢 — `<module>:void`（矩陣
  冇獨立 unvoid action，同 void 共用）

**`roles` 冇 `/unvoid`**——自訂角色一旦 void 咗就係終態，冇 API 可以
解除（同五個出廠角色一開始就唔准 void 呢個保護分開睇：void 咗嘅自訂
角色如果要復用，要老闆直接查 DB 或者 P3 先補呢個 endpoint）。

| 資源 | Path prefix | module | 雞頭隔離 | 備註 |
|---|---|---|---|---|
| 盤 | `/api/sites` | 盤 | 冇（雞頭硬性 deny） | void→`status=ended`；`status=ended` 唔准直接 PATCH。**WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）**：`guards_paid_by_client`（`SiteCreateSchema`／`SiteUpdateSchema` 都接受，白名單 `toSiteDTO`／`toBrokerSiteDTO` 都有，冇 field-group gate，跟「盤」module 一致）——呢類盤嘅保安員由客戶直接出糧，公司淨係收每月服務費；`true` 嘅盤：更表批量儲存（`POST /api/shift-records/batch`）／`POST /api/shift-records/reprice`／`POST /api/shift-records/:id/approve`／`POST /api/shift-records` 單條建立一律**唔寫** `guard_wage_snapshot`／`broker_fee_snapshot`／`client_rate_snapshot`（新記錄保持 null，已有值唔清，保守）；`computeUnpricedSummary()`／`isUnpricedShift()`／`isClientUnpricedShift()` 一律當「唔算未定价」（payout 同 client 都唔算）；migration backfill 淨係 `canonical_name IN ('TKO Gateway 厚A','TKO Gateway 厚B','TKO Gateway 厚C')`（字面比對，其他盤等老闆確認）——`db:reset`＋`db:seed` 重新生成呢三個 site 行時 migration backfill 唔會再命中（seed 早過 migration backfill 跑嗰陣仲未有呢啲 row），所以 `scripts/seed/index.ts` `seedSites()` 都要跟一份同樣嘅硬編碼名單（`LINK_GUARDS_PAID_BY_CLIENT_NAMES`）先保證 reseed 之後呢個 flag 唔會走失。 |
| 更別 | `/api/shift-types` | 盤 | 冇（雞頭硬性 deny） | void→`voided_at`/`voided_by` |
| 安員 | `/api/guards` | **`安員`**（內部角色）／**`自己安員`**（雞頭，C3 新拆） | ✓ `scopeGuardWhere`——C1 收緊：`default_broker_id=自己` OR（有更次 AND 嗰個 site 喺 `broker_site_assignments`） | 雞頭建人自動掛自己 broker_id；void 硬性 deny；WP-PII：牌照號碼（`sia_permit_no`）／平安卡（`safety_card_no`／`safety_card_expiry`）／入職離職日期（`hire_date`／`leave_date`）跟「安員」module（PATCH-only，`GuardUpdateSchema`）；`hkid`／`date_of_birth`／`address`／`emergency_contact_name`／`emergency_contact_tel`／`blacklist_check_result`／`blacklist_check_date` 受 **`安員個人資料`** field-level gate；`bank_name`／`bank_account_no`／`bank_payee_name` 受 **`安員銀行資料`** field-level gate（`applyFieldGroupGate`/`assertFieldGroupWritable`，同「收客價／出街價」一致機制，見 `src/lib/api/field-groups.ts`）；body 帶呢兩組欄位但冇對應 `update` 權限 → 403；`hkid` 喺 **列表**一律遮罩（`A123***(7)`），單項詳情／PATCH response 有「安員個人資料:view」先見全號；建立（`POST`）唔接受 16 個 WP-PII 新欄，一律建好之後用 `PATCH` 補；`GET ?expiring_within_days=N`——篩 `sia_permit_expiry`（衍生值）或 `safety_card_expiry` N 日內（含已過期）到期。**WP-STAFFNO（老闆 2026-09-19 拍板）**：`sia_permit_a_expiry`／`sia_permit_b_expiry`（甲／乙類到期日，跟「安員」module，PATCH-only）取代單一 `sia_permit_expiry` 嘅直接寫入——`sia_permit_type`／`sia_permit_expiry` 而家係**衍生值**（`deriveSiaPermitExpiry()`，見 `src/lib/guards/staff-numbers.ts`：兩者「仍然有效（乙類過 70 歲當失效）而最早到期」嗰個；type=A／B／A+B），PATCH／POST body 帶呢兩個 key 一律 400（提示改用 a／b 欄）；改甲／乙／`date_of_birth` 任何一個都自動重算；`GET /api/guards` 列表 additive 欄 `staff_numbers`（`[{scheme,number,status}]`，淨係 current，內部角色／雞頭白名單都有）；`staff_no`／`staff_no_mw` 舊欄改做**同步顯示值**（見下面「員工編號」一行），PATCH／POST body 帶呢兩個 key（舊寫法）會轉做對 `guard_staff_numbers` 嘅 upsert，值同現值一樣（值冇變）就當冇改，唔會誤 409。**Opus 驗收修復**：(M2a) 雞頭 body 帶 `staff_no`／`staff_no_mw`（任一 key，唔理值）一律 **403**（硬性，唔靠矩陣個 cell）；(S1) `staff_no` 淨係收 `U` 開頭，`staff_no_mw` 淨係收 `MG`／`MW` 開頭，其他種類 400 並提示用「員工編號」區；(S5) `sia_permit_expiry`／`sia_permit_type` 而家**讀取時現算**（`GET`／`PATCH` response 都用 `deriveSiaPermitExpiry()` 覆蓋 DB 欄，唔再信寫入時嘅舊值——DB 欄仍然喺寫入時更新，`ai.guards` view 用緊，並由 `scripts/db/recompute-permit-derived.ts`（容器啟動跑一次，`|| warn`）校正）；`GET ?expiring_within_days=N` 一齊改用現算值（攞返可見全部 row 現算再篩再分頁，`total` 用篩選後嘅數）；(S7) `GET ?q=` server 端搜尋姓名／英文名／電話／任何 current+former 工號（雞頭 scope 照行），response additive 欄 `former_number_hit`（淨係有 `q` 先有）標「呢個結果係靠一個已取消號搵到」；(附帶) `sia_permit_a_expiry`／`sia_permit_b_expiry`／`safety_card_expiry`／`hire_date`／`leave_date` 改用 nullable schema，PATCH 傳 `null`＝清空（唔會再變 1970-01-01）。**WP-MISC（老闆 2026-09-20 拍板）**：`qas_issue_date`（QAS 完成日期）／`qas_expiry_date`（QAS 到期日，如有）——QAS＝基本保安訓練證書，來源檔個欄過去日子＝完成、未來日子＝到期，混雜咗分開兩欄存底；跟「安員」module（PATCH-only，`nullableDateOnly`，同 `safety_card_expiry` 一致層級，唔屬於 PII field-group）；`qas_expiry_date` 納入 `GET ?expiring_within_days=N` 篩選（同 `sia_permit_expiry`／`safety_card_expiry` 一齊 OR）；雞頭 DTO（`GUARD_BROKER_FIELDS`）冇呢兩個欄（同 `safety_card_expiry` 現有做法一致，雞頭見唔到） |
| 員工編號 | `/api/guards/:id/staff-numbers`、`/api/guards/:id/staff-numbers/:numberId` | **`安員`**（內部角色）／**`自己安員`**（雞頭，讀）；寫（POST/PATCH）雞頭**硬性**拒（唔靠矩陣個 cell，見 route 註解） | ✓ 同 `/api/guards/:id` 一致（先 `scopeGuardWhere` 確認個 guard 對呢個 session 可見，唔可見 404） | **WP-STAFFNO（老闆 2026-09-19 拍板，四條業務規則）**：(1) `U`＝去 Wilson 盤做散工必須有；`MP`＝去第二間公司嘅盤做散工用；`MG`＝轉咗長工（純內部出糧／行政用）；`MW`＝公司寫字樓員工編號（office staff，唔係前線保安）。(2) 更表／匯出一律顯示 U 號（`guards.staff_no`），唔顯示 `staff_no_mw`（MG／MW）。(3) 轉長工後 U／MP 繼續有效——同一人可以同時有 U／MP／MG 現用號。(4) 離職後舊編號會**取消**（`status=former`＝已取消，唔係「舊但仍生效」），再入職攞全新編號，永遠唔復用舊號——UI／API 訊息一律用「已取消」，DB 值 `former` 本身唔改。員工編號獨立表（方案 B）：同一種入面亦可能有多個號（新舊交替）。`scheme` 唔寫死 enum（zod regex 1-4 位大寫英文字母），已知 U／MP／MG／MW。`GET`：current 先、former（已取消）後。`POST { scheme, number, valid_from?, note? }`：同 scheme 已有 current → 自動轉 former／已取消（`valid_to`＝今日 HK），response 帶 `converted_former` 講明；`number` 全表 unique，已被（任何）guard 用緊 → 409 並回 `guard_id`（唔回姓名）；`number` 要以 `scheme` 開頭。`PATCH .../:numberId { status?, valid_from?, valid_to?, note?, number? }`：改 status／日期／備註；打錯用 `number` 改（同樣行 unique／prefix 檢查）；已取消嘅號改返 current 撞 partial unique（同一 guard 同一 scheme 最多一行 current）→ 409；前端「改返現用」呢個操作撳之前要求用戶 `confirm`（正常業務流程唔會用返已取消嘅號，淨係俾用戶更正撳錯）。冇硬刪。全部寫入落 `audit_log`（`table_name=guard_staff_numbers`）。任何增／改都會喺同一 transaction 內尾 call `syncLegacyStaffNoColumns()` 令 `guards.staff_no`（現用 U，冇 current 就用最近取消嗰個 U，保住歷史更表／匯出完整）／`staff_no_mw`（現用 MG，冇就現用 MW，兩者都冇 current 就用最近取消嗰個、MG 優先）保持同步——**Opus 驗收修復（S3/S4）**：`syncLegacyStaffNoColumns()` 而家淨係當呢個 guard 喺新表**有過**（current 或 former）嗰個 scheme 嘅行先會同步對應舊欄，完全冇任何行（例如舊 migration 因格式問題跳咗）就保留 `guards` 表原值，唔會靜靜哋抹走做 `null`。**Opus 驗收修復（S2）**：`number` 正規化＝trim＋大寫＋**移除所有空白**（唔淨係頭尾），格式要符合 `^[A-Z]{1,4}[0-9A-Z-]{1,16}$`（scheme 前綴 1-4 位大寫英文字母 + 1-16 位大寫英文字母／數字／連字符，總長 ≤20），唔啱 400。**Opus 驗收修復（M1）**：`valid_to`（舊 current 自動轉 former）用 HK 曆日直接起 `T00:00:00.000Z`（同 zod `dateOnly` 一致慣例），唔再用 `hkDayStartUtc()`（嗰個係俾時間範圍邊界用，寫 `@db.Date` 字面日曆日會早一日）。**Opus 驗收修復（M2b）**：409（撞號）response 帶嘅 `guard_id` detail 淨係內部角色（老闆／主管／會計）先有，雞頭一律冇（呢個 sub-resource 本身寫已經對雞頭硬性 403，呢層純粹 defense-in-depth）。**Opus 驗收修復（S6）**：雞頭 `GET` 用窄版 DTO——`id／scheme／number／status／valid_from／valid_to`，冇 `note`／`source`／`created_by`；內部角色先見全欄 |
| 電話 | `/api/guards/:id/phones`、`/api/guards/:id/phones/:phoneId` | **`安員`**（內部角色）／**`自己安員`**（雞頭，淨係讀）；寫（POST/PATCH/DELETE）雞頭**硬性**拒 | ✓ 同 `/api/guards/:id` 一致（先 `scopeGuardWhere`，唔可見 404） | **WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）**：獨立子表 `guard_phones`（同 `guard_staff_numbers` 一致「子表＋legacy 欄同步」pattern），有幾多個電話記幾多個，一個 `is_primary`。`tel` 正規化（去空白／連字符）後要符合 `^\+?[0-9]{7,15}$`（8 位香港號或者 `+` 開頭國際號）。`GET`：primary 先，跟住 `created_at` 順序；雞頭窄版 DTO（`id/tel/label/is_primary`，冇 `note`/`source`/`created_by`）。`POST { tel, label?, is_primary?, note? }`：第一行自動 primary（唔理 `is_primary`）；要求 `is_primary:true` 就自動降級舊 primary（同一 transaction）；同一個 guard 已經記錄咗嘅電話（`UNIQUE(guard_id, tel)`）→ **冪等**（唔係 409）：`is_primary:true` 就直接將嗰行設做 primary，否則原封不動兜返（避免 legacy PATCH 嘅「值冇變就當冇改」判斷追唔切「曾經記錄但而家唔係 primary」嘅舊電話，導致每次撳「儲存」都 409）。`PATCH .../:phoneId { tel?, label?, is_primary?, note? }`：改號碼會查 `UNIQUE(guard_id, tel)`，真係撞另一行先 409；`is_primary:true` 自動降級舊 primary；直接將現有 primary `is_primary:false`（冇指定第二行接手）→ 400。`DELETE .../:phoneId`：更正打錯用，刪 primary 自動升最舊一行做新 primary，淨返一行都刪走就 `guards.tel` 同步做 `null`（呢張表冇「已取消」狀態，刪咗就係冇咗，唔似員工編號咁有 former fallback）。任何增／改／刪都喺同一 transaction 內尾 call `syncLegacyGuardContactColumns()`，令 `guards.tel`（primary 電話）保持同步；`PATCH /api/guards/:id` 舊寫法帶 `tel`（值同現時 primary 唔同）會轉做「加一行並設做主要，原本嗰行保留做非主要」（`source="manual:legacy-patch(tel)"`），送空字串／`null`＝no-op（唔刪任何行）；`GET /api/guards?q=` 搵到任何一個電話（唔止 primary）。全部寫入落 `audit_log`（`table_name=guard_phones`，DELETE 用獨立嘅 `delete` action，`before`＝完整 DTO、`after`＝null）|
| 緊急聯絡人 | `/api/guards/:id/emergency-contacts`、`/api/guards/:id/emergency-contacts/:contactId` | **`安員個人資料`**（唔用 module selector——雞頭／安員出廠 `uniformRow(D)` 硬性拒，主管跟現有規則） | ✓ 同 `/api/guards/:id` 一致 | **WP-MULTI**：獨立子表 `guard_emergency_contacts`，有幾多個記幾多個，冇「主要」概念——用 `sort_order` 排先後（細嗰個排先）。`name`／`tel` 唔可以同時空（DB CHECK constraint + app 層驗證）。`GET`：跟 `sort_order` asc。`POST { name?, tel?, relationship?, sort_order?, note? }`：冇傳 `sort_order` 自動排尾（現有最大 +1）。`PATCH .../:contactId { name?, tel?, relationship?, sort_order?, note? }`：改任何欄（`sort_order` 用嚟重新排序——前端「較先」/「較後」掣同鄰居互換 `sort_order`）。`DELETE .../:contactId`：更正打錯用。任何增／改／刪都尾 call `syncLegacyGuardContactColumns()`，`guards.emergency_contact_name`／`emergency_contact_tel`＝`sort_order` 最細嗰行（冇任何行就兩個都 `null`）；`PATCH /api/guards/:id` 舊寫法帶 `emergency_contact_name`／`_tel`（任一改咗）會加一個新代表行（`sort_order`＝現有最細 - 1，令佢變新代表；冇改嗰隻用返 `before` 值一齊起，等新代表行仍然係完整一組），送空字串／`null`＝no-op。全部寫入落 `audit_log`（`table_name=guard_emergency_contacts`） |
| 地址 | `/api/guards/:id/addresses`、`/api/guards/:id/addresses/:addressId` | **`安員個人資料`**（同上，唔用 module selector） | ✓ 同 `/api/guards/:id` 一致 | **WP-MULTI（規劃師延伸，同一原則）**：獨立子表 `guard_addresses`，可以多個，一個 `is_primary`（同「電話」一致嘅 primary 手法：第一行自動 primary、`is_primary:true` 自動降級舊嗰行、DELETE primary 自動升最舊一行、淨返一行都刪走 → `guards.address` 同步做 `null`）。地址自由文字（冇格式驗證），唔准空白。`PATCH /api/guards/:id` 舊寫法帶 `address`（同現時 primary 唔同）會轉做「加一行並設做主要，原本嗰行保留」，送空字串／`null`＝no-op。全部寫入落 `audit_log`（`table_name=guard_addresses`） |
| 雞頭 | `/api/brokers` | 雞頭 | ✓ `scopeBrokerWhere`（淨見自己）+ 白名單 DTO | void→`status=inactive` |
| 價目 | `/api/rate-cards` | **`出街價`**（基本存取）+ **`收客價`**（field-level gate，C3） | ✓ `scopeRateCardWhere`——C1 加咗盤 scope（`site.brokerAssignments.some`） + 白名單 DTO | void/unvoid **C4 新加**以 `effective_from` 月份判斷鎖定；改動強制 audit；body 帶 `client_rate` 但冇「收客價」寫入權限→403 |
| 更次記錄 | `/api/shift-records` | 更表 | ✓ `scopeShiftRecordWhere` + 白名單 DTO；**C1 寫入歸屬檢查**：雞頭淨係可以幫 `default_broker_id=自己` 嘅安員、喺 `broker_site_assignments` 白名單入面嘅 (盤,月) 開更，否則 403（唔可以靠「開得到」反證有份） | 受月份鎖定；unique(guard,work_date,shift_type)違反回409；雞頭填更強制自己 broker_id、唔准夾帶價錢；**雞頭 update 而家硬性 deny（C3）**；`GET ?status=pending_approval` 審批隊列；雞頭開更視 `brokers.requires_approval` 定 `pending_approval`/`confirmed`（P1-WP3） |
| 審批 | `POST /api/shift-records/:id/approve`、`POST /api/shift-records/:id/reject` | **審批** | 冇（雞頭硬性 deny） | approve：`pending_approval`→`confirmed`，非 pending 狀態 409；reject：`{reason}` 必填，`pending_approval`→`draft`（P1-WP3） |
| 更表批量儲存 | `POST /api/shift-records/batch` | 更表（雞頭用 create；內部角色視乎新建/修改/清格細分 create/update/void） | ✓ 同單條 create 一致（C1 歸屬檢查 + query scope） | `{site_id, month, cells:[{guard_id,shift_type_id,work_date,code}]}`——逐格 validate 晒先開 transaction 寫入，任何一格 403/400 或 DB unique 衝突（409）**成批 rollback**；response 帶 `warnings`（同日多更／單月>26更／超配額／證件過期，軟警示唔擋寫入）；雞頭改自己已 `confirmed` 嘅格重入 `pending_approval`（設計文件§4.2）；雞頭清 `confirmed` 格 403（要主管用 void）（P1-WP3）。**WP-MISC（老闆 2026-09-20 拍板）**：`site.guards_paid_by_client=true`（LINK：TKO Gateway 厚A/B/C）嘅盤——「計价」段一律行「保留現有值、唔寫新 snapshot」分支，唔行 `resolveShiftPricingFromCards()`，response `pricing.unpriced` 對呢類盤永遠 0（同 `POST /api/shift-records/reprice`、`POST /api/shift-records/:id/approve`、`POST /api/shift-records` 單條建立一致 gate，見 `src/lib/pricing/resolve-rate.ts` `isUnpricedShift()`／`isClientUnpricedShift()` 嘅 `guardsPaidByClient` opts）。**Phase B-1（B1-5，WP-ATTRIB）加咗**：response 每項 `results[]` additive 欄 `settlement_inferred`（呢格結算單位冇喺 payload／現存記錉度攞到，靠 `resolveSettlementBrokerFallback()` 推算——雞頭 session 永遠 `false`）＋頂層 `settlement_inferred_count`（推算格總數），俾 RosterEditor 儲存後 toast「N 格結算單位推算，建議覆核」。 |
| 開新月份 | `POST /api/months/:month/open` | 更表:create（額外硬擋雞頭角色） | — | 複製上月 `broker_site_assignments`／`quotas`／`daily_requirements`（`shift_types` 唔跟月份，冇需要複製）；已存在嘅唔覆寫（幂等）；受目標月份鎖定（P1-WP3） |
| 配額 | `/api/quotas` | **配額** | ✓ `scopeQuotaWhere`（雞頭 GET 淨見自己）；雞頭 create/update 硬性 deny | unique(month,site_id,shift_type_id,broker_id) 違反回409；受月份鎖定；軟性限制（超配額唔擋寫入，喺 batch response 嘅 `warnings` 出黃警示）（P1-WP3） |
| 介紹費率 | `/api/referral-fee-rates` | **雞頭**（同 `/api/brokers` 共用同一個 module——出廠淨係老闆有 create/update/void grant，主管/會計出廠 ○） | ✓ `scopeReferralFeeRateWhere`（雞頭 GET 淨見自己）；雞頭 create/update/void 硬性 deny；`fee_per_shift` 受「出街價」field-level gate（內部角色冇「出街價:view」見唔到；雞頭見自己嗰行唔經呢個 gate，同 rate_cards 嘅 payout_rate 一致） | `site_id` 留空＝呢個雞頭全盤預設費率；unique(broker_id,site_id,month) 違反回409；同一雞頭同一月兩行 `site_id=null`（partial unique index）都回409；受月份鎖定（用 `month` 欄）；`brokers/page.tsx` UI 逐雞頭子表（P1-WP3 E） |
| 所需人手 | `/api/daily-requirements` | 更表 | ✓ `scopeBySiteHavingBrokerShifts`——C1 改用 `broker_site_assignments`（唔係「有冇更次」）+ 白名單 DTO | 受月份鎖定（create/update/void/**unvoid，C4 補漏**） |
| 特殊項 | `/api/special-items` | 糧務 | 冇（雞頭硬性 deny） | 受月份鎖定（用 `month` 欄，create/update/void/**unvoid，C4 補漏**）；`revenue` 受「收客價」field-level gate（C3） |
| 用戶 | `/api/users` | **`用戶管理`**（C3 拆自系統） | 冇（雞頭硬性 deny） | 回應一律剝 `password_hash`／`otp_secret`（殘留3，`toSafeUserDTO`）；create 要求強密碼（視乎目標角色）；PATCH 改 `role_id`／`broker_id` 會 bump 目標用戶 token_version（殘留1） |
| 角色 | `/api/roles` | 用戶管理 | 冇 | `POST { source_role_id, name }` 複製現有角色，`base_role` 繼承唔可改；void 淨係 `is_custom=true` 得；**冇 unvoid** |
| 角色權限矩陣 | `/api/roles/:id/permissions` | 用戶管理 | 冇 | `GET` 攞矩陣（21×5=105 格，含 `hard_denied` 旗標，用 `base_role` 判斷）；`PATCH { changes:[{module,action,granted}] }` 逐格改，硬性禁止格拒絕開（殘留6：一次 `findMany` 攞晒 permission，唔逐個 change 查） |
| 月結 | `/api/month-closes`、`/api/month-closes/roster-coverage` | 糧務（view/create）／**`月結鎖定解鎖`**（C3 拆自糧務，lock/unlock） | 冇 | `GET`/`POST`（起草月）；`POST /:id/lock`、`POST /:id/unlock`（強制 `{ reason }`）——**冇 void/unvoid**。**Phase B-1（B1-6，規則 10／§14）加咗**：`POST /:id/lock` 鎖定前檢查——該月有出更（`shift_records`／`daily_requirements`）嘅盤，冇 active 更表上載或者上載未對數完成（`status != confirmed`）→400 列出盤名清單（`checkRosterUploadCoverage()`，`src/lib/roster-upload/lock-precondition.ts`）；淨係 **2026-08 起**嘅月份檢查（7 月及更早冇更表上載，唔擋）；子盤嘅更由母盤嗰份上載覆蓋；body 帶 `force: true` 可以覆寫（**淨係 `base_role='老闆'` 先做得到，其他角色帶 `force:true` 一律 403**，同 §6.3 對數差異嘅 `override_reason` 係兩件唔同事），覆寫記落 audit（`roster_upload_force`／`roster_upload_coverage_issues`）。`GET /roster-coverage?month=`：同一個檢查嘅唯讀版（「更表」module `view`），俾月結工作台入頁就顯示清單，唔使撞 400 先知。 |
| 操作紀錄 | `/api/audit-log` | **`操作紀錄`**（C3 拆自系統） | 冇 | 只讀；`?export=1` 額外要求 `操作紀錄:export` |
| 更表上載 | `/api/roster-uploads`、`/api/roster-uploads/:id`、`/api/roster-uploads/:id/reparse` | **`更表上載`**（WP-ROSTER-UPLOAD Phase A，老闆 2026-09-21/23 拍板，§15） | 冇（雞頭／安員硬性 deny——呢個 resource 完全接觸唔到，唔止 scope） | 唔跟資源 CRUD 通用表（**冇** POST 一般 create 語意、**冇** void/unvoid——同盤同月新上載自動將舊版轉 `superseded`，冇刪除概念）。`GET ?month=YYYY-MM`（必填）：逐盤狀態（未上載／已上載 vN／解析失敗），額外列出 `unresolved_uploads`（盤名對唔到、`site_id=null` 嘅上載）。`POST`（multipart/form-data：`file`＋`month`＋`site_id` 可選）：即時存 bytes＋SHA-256→解析（`src/lib/roster-upload/parse.ts`）→對照盤/更別/安員/雞頭（`match.ts`）→存 `roster_upload_rows`；解析失敗（壞 xlsx／搵唔到 Date 表頭）唔會擋上載，`status=parse_failed`＋`parse_error`；**唔係 xlsx（非 zip、舊版 .xls）直接 400 唔存底**；檔案上限 20MB；同盤同月版本序列有 advisory lock（同時上載唔會出兩個 active）；格仔日期唔係上載月份會逐行警告＋`parse_summary.out_of_month_count`。`GET /:id`：`upload`（field-group gate 過）＋`rows`（分頁，`?guard_match=unmatched` 篩未配對）。`PATCH /:id { site_id }`：人手指定盤（`null`＝清返未指定，唔會再用盤名自動配返），目標盤呢個月已有上載嘅話 version 遞增、上載時間最新嗰個保持 active、其餘轉 `superseded`（`assignRosterUploadSite()`），之後即刻用返原檔 bytes 重新對照一次。`superseded` 嘅舊版重新解析之後仍然係 `superseded`。`POST /:id/reparse`：唔使重新上載，用返存底嘅 bytes 重新解析＋對照（例如安員名冊/更別加咗新資料之後）。**PII**：`roster_upload_rows` 嘅 `name_raw`／`tel_raw`／`staff_no_raw` 屬 **`安員個人資料`** field-level gate（`GUARD_PII_FIELDS`）——冇嗰格 view 權限嘅內部角色見唔到呢三隻欄，`code_raw`／配對結果等唔受影響。**唔寫入 `shift_records`**（Phase A 範圍明文排除，對數＋寫入係 Phase B，見 §15.3）。`file_bytes`（bytea）永遠唔會出現喺任何 API response（白名單 DTO 冇呢隻欄，連老闆都攞唔到——冇下載原檔 endpoint）。AI 隔離：`ai.*` schema 完全冇 `ai.roster_uploads`／`ai.roster_upload_rows` view；`ai.audit_log` WHERE 子句排除呢兩個 table_name（同 WP-MULTI 一致做法，見 `prisma/migrations/20260923000000_wp_roster_upload_a`）。**Phase B-0（§15.3，老闆 2026-09-23 答）加咗**：(1) 合併儲存格橫跨 N 個日期欄＝嗰 N 日每日一格同一個代號（唔再淨計左上角一格），逐格 warning「由合併格展開（第 x/N 日）」，合併範圍伸出日期欄範圍（例如連埋備註欄）另加一個警告，`parse_summary.merged_expanded_count` 記低展開咗幾多格。(2) 更別配對（`shift_type_id`）多過一個候選時用該行 `time_raw`（正規化做 `HHMM-HHMM`，`src/lib/roster-upload/time-range.ts`）收窄，一個命中先配、零個或者多過一個保留 `null`＋warning 列出候選時段（`parse_summary.ambiguous_shift_type_count`）。**補丁（WP-AUG-OPENING-2，§17.7 未修第一項）加咗第三層 rank 收窄**：「同代號」候選先用 `codeFamily()`（`match.ts`——DB `-2`/`-3` 後綴分開同一個代號嘅慣例，例如數碼港 CP5 嘅 `D`／`D-2`）湊齊全部同家族候選（淨係 rawCode 本身冇「-N」後綴先湊；更表明確寫「D-2」就淨係逐字配），time_raw 收窄之後（或者根本收窄唔到，例如候選時段字面完全一樣）仍然多過一個，用該行 `rank_raw`（NFKC＋壓空白正規化）判斷：含獨立字元組「IC」／「SIC」（前後唔黐拉丁字母，例如「早更IC」「夜Zone SIC」「保安員(IC)」；「Security Officer」唔算）→ 淨係留 `billing_group=monthly_ic` 或者 code 含「IC」嘅候選；「保安員」類（含「保安員」／「Guard」／或者唔含 IC 嘅其他寫法）→ 淨係留 `per_shift` 嘅候選；收窄剩一個先配，`parse_summary.rank_narrowed_count` 計呢類靠 rank 先配到嘅格數；仍然多過一個或者零個就照舊 `null`＋ambiguous，warning 加多句「已用 rank 收窄但仍未夠」講明試過。(3) 一檔多子盤（城巴車廠／CP5）：上載掛嘅盤如果有子盤（`sites.parent_site_id`），逐行用 `sub_site_name` 對子盤，命中就寫落新欄 `resolved_site_id`（nullable，DTO 已加白名單），更別配對跟子盤嘅 `shift_types` 範圍；對唔到子盤就 `resolved_site_id=null`＋warning，`parse_summary.unmatched_sub_site_count`。(4) `guard_match` enum 冇改（揀咗淨係加 warnings，唔加 migration）：檔案有工號但系統完全搵唔到、退用姓名/電話配到 → warning「檔案工號 X 同系統工號 Y 唔一致」；靠已取消（`guard_staff_numbers.status='former'`）舊工號配到 → warning「用已取消舊號配對」；`parse_summary.staff_no_mismatch_count`／`staleStaffNoCount`；`GET /:id` 新增 `?warning_flag=staff_no_mismatch|stale_staff_no` 篩呢兩類（`warnings::text ILIKE` 查詢，唔係 `guard_match` 欄）；**冇「安員個人資料:view」嘅角色（例如主管出廠）睇 `GET /:id` 時，warning 入面兩個工號換做「（已隱藏）」**（同 `staff_no_raw` field gate 一致，驗收 2026-09-23）。(5) 同檔重複上載：同一檔（同 SHA-256）唔擋，`POST` response（201）帶 `duplicate_of_version`（同盤同月**任何**版本、含 superseded 撞 SHA 就係最新嗰個撞到嘅 version 號，冇撞就 `null`）俾前端出提示；**更新檔嘅檔名（`file_name`，trim＋忽略大小寫）一定要同該盤同月任何現有版本（active 或 superseded）唔同——同名一律 400，錯誤訊息「更新檔嘅檔名必須同舊版唔同，請改檔名再上載」，唔存底、唔開版本**。**Phase B-1（§14.1／§15.3，B1-8 第 1/2/3 項）加咗**：(1) `PATCH /:id { site_id }` 而家同 `POST` 一樣做「目標（盤,月）組別已有同名檔→400」檢查（之前 PATCH 冇呢個檢查，改盤可以撞埋一個同名檔）。(2) 有子盤嘅上載，某行冇 `sub_site_name` → warning「未寫子盤，歸母盤，人手覆核係咪漏寫子盤」（唔擋，`resolved_site_id` 保持＝母盤）。(3) 檔案工號命中真實存在嘅安員、但呢行姓名同嗰個人唔夾 → `guard_match` 由 `by_staff_no` 改判 `ambiguous`（`guard_id=null`，唔准配）＋warning「檔案工號 X 屬另一人（姓名對唔上），唔會自動配對，人手覆核」（`?warning_flag=staff_no_belongs_to_other` 可篩；冇「安員個人資料:view」一樣會被遮）。**CP5「數據中心」指針格（B1-8 第 5 項，已知落差）**：`src/lib/roster-upload/parse.ts` 有 `applyDataCenterMarkerPointer()`（純函數，合成單元測試證明邏輯），但**冇接落 `extractSheet()` pipeline**——實測對住真實 8 月 CP5 主檔會令 `gate:roster-parse` 由 36/36 跌到 35/36（任務書寫嘅「該格之後嘅行屬數據中心子盤」propagate 規則，同兩粒真實 marker 格嘅已知正確行為唔夾），留返老闆/會計核實邊個啱先接。 |
| 更表對數 | `/api/roster-uploads/:id/reconcile`、`/api/roster-uploads/:id/reconcile/apply`、`/api/roster-uploads/pending-summary` | **`更表上載`**（WP-ROSTER-UPLOAD Phase B-1，B1-2；`view`/`update`，同上載本身共用 module——雞頭／安員硬性 deny） | 冇 | 更表 vs 系統內已報更（`shift_records status != cancelled`）對數，唔跟資源 CRUD 通用表。`GET /:id/reconcile`（`?category=` 篩其中一類、`?skip=`/`?take=`）：分類結果（純函數 `reconcileRosterUpload()`，`src/lib/roster-upload/reconcile.ts`）＋`summary.by_category` 逐類數＋`summary.settlement_inferred_count`。七類：`match`／`roster_only`（更表有系統冇）／`system_only`（系統有更表冇，列 `source`）／`guard_diff`（同日同盤同更種人唔同）／`settlement_diff`（結算單位唔同）／`shift_type_diff`（同人同日同盤更種唔同）／`unresolved`（安員/更別/子盤未配對齊，**唔可以寫入**）。逐更配對鍵＝`work_date｜resolved_site_id??site_id｜guard_id｜shift_type_id`。leave 行（B1-4）`shift_type_id` 由 `resolveLeaveShiftTypeIds()` 兩層推斷（該行 Time 欄時段夾中／同 `row_index` 多數票），兩層都推斷唔到就 `unresolved`；leave code 保留原檔字面（**唔做 OFF→RD／NPL→NL 歸一**，見下面「已知落差」）。`POST /:id/reconcile/apply { actions: [{key, action, reason?}] }`：`action` 三選一——`apply_roster`（roster_only→create；system_only→cancel；guard_diff/shift_type_diff→cancel 舊+create/reuse 新；settlement_diff→update 同一條記錄嘅結算單位＋重計 snapshot；寫入一律 `source='roster_upload'`、`provenance={upload_id,row_id,version}`、`status='confirmed'`）、`keep_system`／`exception`（`exception` 必填 `reason`，唔改 `shift_records`，upsert `roster_reconcile_decisions`——新表，已排除出 `ai.audit_log`）。一個 transaction，逐項包 `SAVEPOINT`——任何一項 DB 錯誤（例如 P2002）只 rollback 該項、其他照 commit，回應逐項如實；audit 喺 commit 之後先寫；上載未指定盤（`site_id=null`）→400；套用完之後重新分類，全部非 match 項都有結果／決定就將 `roster_uploads.status` 轉 `confirmed`，回應 `pending_count` 講仲有幾多未處理。`GET /pending-summary?month=`：「通知會計」最簡單做法（唔做 email）——逐盤列 `status=parsed` 但仲有非 match 項未有決定（扣除 keep_system／exception）嘅數量；**唔帶 `month`＝所有月份**（首頁卡用，上個月更表通常今個月先對數），entries 帶 `month`。**`unresolved` 另外包括**：格仔日期唔係上載月份、有雞頭碼但對唔到 brokers、有 `sub_site_name` 但子盤對唔到（唔跌返母盤）、更表重複行（同人同日同盤同更別第二行起）。`guard_diff` 淨係「同日同盤同更種成組一對一」先配，多人嘅剩餘分開列 roster_only／system_only。**已知落差**：(a) leave code 保留原檔字面同任務書「OFF→RD、NPL→NL」有出入，跟咗 `LeaveCode` enum 自己既有嘅設計精神（seed 一路「有原檔字面就用原檔字面」）；(b) 「該盤預設」更別冇對應概念/欄位，leave 行兩層訊號都推斷唔到就 `unresolved`，唔會估；(c) B1-5「複製上月」覆核清單（上月結算單位≠安員預設/長工掛雞頭）未實作。 |

## AI 助手（WP-AI1）

| Method | Path | 權限 | 說明 |
|---|---|---|---|
| POST | `/api/ai/chat` | **`助手`**:view（雞頭/安員硬性禁止） | `{ message }`；SSE 串流（`event: delta`／`done`／`error`）；每人每日 `AI_DAILY_LIMIT` 條（超過 429）；每條問答寫 `audit_log(table_name=ai_chat, action=ai_chat)` |
| GET | `/api/ai/conversation` | 助手:view | 攞返自己同助手嘅對話記錄（最多 30 turn） |
| DELETE | `/api/ai/conversation` | 助手:view | 清空自己嘅對話記錄 |

**架構上做唔到任何寫入／修改／部署**——四層唯讀保證＋工具清單＋輸出
過濾詳見 [`docs/ai-assistant.md`](ai-assistant.md)。

**WP-MULTI（老闆 2026-09-19 拍板）AI 隔離**：`guard_phones`／
`guard_emergency_contacts`／`guard_addresses`（電話／緊急聯絡人／地址
三張新表）——`ai.*` schema 完全冇對應嘅 `ai.guard_phones`／
`ai.guard_emergency_contacts`／`ai.guard_addresses` view（同 `guard_
staff_numbers` 一致做法），AI 助手嘅工具（`guard_lookup`／`sql_select`）
結構上接觸唔到呢三張表本身；`ai.audit_log` view（讀「邊張表邊一行點樣
改咗」嘅審計記錄）額外加咗 `WHERE table_name NOT IN ('guard_phones',
'guard_emergency_contacts', 'guard_addresses')`，等呢三張表嘅 create／
update／delete 記錄（before/after 有 tel／name／address）連 `recent_
audit`／`sql_select ai.audit_log` 都讀唔到（見
`prisma/migrations/20260919154450_wp_multi_phones_contacts_addresses`、
`tests/wp-multi-ai-isolation.test.ts`）。

## 查詢參數（list endpoint 通用）

- `skip`、`take`（分頁，`take` 上限 500）
- `include_inactive=1` / `include_voided=1`：連已停用/已作廢都攞（仍要 view 權限）
- 部分資源額外支援 `site_id`、`guard_id`、`work_date_from`/`work_date_to`（shift-records）、`month`（special-items）
- `expiring_within_days=N`（`/api/guards`，WP-PII）：篩牌照或平安卡 N 日內（含已過期）到期，非負整數，格式唔啱 400

## 硬性規則喺 API 層點實現

1. **雞頭隔離**（設計文件§5.1 硬性規則1；Opus 驗收 C1/C2 加固）：
   `src/lib/broker-isolation.ts`——三重防線：(a) **寫入歸屬檢查**
   （`assertGuardOwnedByBroker`／`assertSiteAssignedToBroker`，C1）；
   (b) query scope；(c) 白名單 DTO（`src/lib/broker-dto.ts`）+ blocklist
   scrub 雙重。見 README-P1.md 同
   `tests/wp2-broker-isolation-fuzz.test.ts`、
   `tests/wp2-c1-guard-attribution.test.ts`。
2. **同人同日同更別唯一**：`shift_records` DB unique constraint，違反
   API 回 409。
3. **audit_log 只寫入**：DB trigger 拒絕 UPDATE/DELETE/TRUNCATE，冇任何
   API 可以改/刪 audit_log。
4. **月份鎖定**（Opus 驗收 C4 補漏）：`src/lib/month-lock.ts`——
   `shift_records`／`rate_cards`（用 `effective_from`）／
   `daily_requirements`／`special_items`（用 `month`）四個資源嘅
   **create/update/void/unvoid 全部**（共 16 種寫入）寫入前一律 check，
   鎖定咗嘅月一律 403 並寫 audit。見
   `tests/wp2-c4-month-lock-writes.test.ts`（16 種寫入逐一斷言）。
   `referral_fee_rates`（用 `month` 欄，P1-WP3 E）跟同一個機制，覆蓋喺
   `tests/wp3-referral-fee-rates.test.ts`。
5. **糧務入數人≠批核人**：`src/lib/payroll-segregation.ts` 嘅
   `assertDifferentActorApprover()`——payout_batches 本身 P3 先做，WP2
   先鎖住 helper + test（`tests/wp2-payroll-segregation.test.ts`）。
6. **Input validation**（Opus 驗收殘留4）：`src/lib/api/schemas.ts`
   （zod）+ `src/lib/api/validate.ts` 嘅 `parseBody()`——每個
   create/update route 一律經 zod schema 驗證，非法 enum／日期格式
   400；`console.error`（`src/lib/api/http.ts` 嘅 `handleApiError`）
   淨係印 `ErrorName: 最後一行訊息`（≤300字符），唔會將成個 Prisma
   query payload（可能含安員個人資料）印落 server log。

## 已知限制／留返後續 session 決定

- **`data/mappings-private/` 依賴（C5）**：`npm run db:seed`／
  `npm run report:regen` 需要 gitignored 嘅 `data/mappings-private/`
  先跑得通（含真名／電話／工號，唔入 git）。冇呢個資料夾，`db:seed`
  會直接 throw 中止（刻意行為，唔係 bug），`report:regen` 部分已知落差
  比對會降級做 `info`，`tests/seed-regen-gate.test.ts`（對真實 7 月
  數據嘅 gate test）一定會紅——詳見 README-P1.md「`data/mappings-private/`
  依賴」一節。
- `roles` 冇 `/unvoid`——需要嘅話 P3 補。
- 自訂角色（`is_custom=true`）而家可以完整登入使用（`base_role` 保證
  硬性 deny 唔會逃），但角色權限管理 UI（逐格開關）淨係得 API，冇畫面
  ——WP3 先做。
- `shift_types` 嘅 `start_time`/`end_time`（`@db.Time`）經 API 寫入時
  仲未做時間字串解析（`src/lib/api/schemas.ts` 暫時淨係 `z.string()`），
  留返 WP3 更別編輯器一齊做。
- 報表 module（毛利即時表／尚欠總覽／月結總表／糧明細／更表匯出）暫時
  淨係 permission placeholder（呢句已經過時——`糧明細`／`月結總表`等
  而家已經有 `GET /api/reports/*` endpoint，呢份文件呢一節未跟返新，
  唔喺 B1-7 範圍內一併修正）。
- **WP-ROSTER-UPLOAD Phase B-1（B1-7）**：`GET /api/reports/payroll`
  additive 加咗 `source_summary`（`{roster_upload_count,
  other_source_count, unlabeled_count, by_source}`，見
  `buildPayrollSourceSummary()`，`src/lib/reports/payroll.ts`）——絕大
  部份現存 `shift_records.source` 都係 `null`（`unlabeled`），因為
  `batch/route.ts`／單筆 `POST /api/shift-records` 之前冇寫過呢個欄
  （只有 B1-2 對數套用嘅新寫入先會有 `source='roster_upload'`），呢個
  additive 欄唔改任何現有欄位／totals（7 月數字唔變，`gate:reports`／
  `gate:pricing` 全過）。`writePayrollXlsx()`／`npm run report:regen`
  出嘅 xlsx 加咗兩個新 sheet（「來源摘要」「逐更來源明細」），`out/p1/
  雞頭糧明細-regenerated.xlsx` 呢個檔案冇被 `gate:reports`／
  `scripts/report/diff.ts` 讀取比對（嗰個比對直接查 DB，見
  `diffPayroll()`），加新 sheet 唔會影響任何 gate。
- **WP-ROSTER-UPLOAD Phase B-1（B1-5，WP-ATTRIB）已知落差**：RosterEditor
  「加保安員」modal／逐行結算單位 `<select>` 嘅選項用返全公司
  `/api/brokers`（`brokerSelectOptions`），**冇**再打
  `broker_site_assignments` API 逐盤篩窄——任務書寫「該盤 broker_site_
  assignments 嘅雞頭＋公司兵＋長工單位」，而家嘅選項會多過呢個範圍（多
  過該盤有份嘅雞頭），但唔會少（唔會漏），純粹 UX 落差唔係資料完整性
  問題。**同一人同盤同月「雞頭行」同「長工行」並存**（結算單位落入行鍵
  嘅一部分）未實作——現有行鍵仍然係 `shift_type_id|guard_id`（唔含
  broker），呢個係一個較大嘅架構改動，留返下一期。

## WP-MIXED-BILLING（老闆 2026-09-24 拍板，§14 規則 5 補充、§15 8 月開盤第 2 項、§17.9）

**背景**：控制室（威信）8 月收客＝月薪崗月費 22,000 ＋ 日薪崗逐更
840×更數（試算：25 更月薪崗 + 22 更日薪崗 = 40,480，老闆拍板選項
(a)）。舊規則「一個盤有 flat 卡就淨係計 flat、唔加逐更」表達唔到呢種
「月費 + 逐更」混合，本 WP 加返。

- **報表口徑（`src/lib/reports/monthly-close.ts`、`src/lib/reports/
  gross-margin.ts`）**：site 收入 = flat 卡（或 `monthly_fee×monthly_
  posts` pro-rata fallback）+ 該盤 `shift_type.billing_group='per_shift'`
  更種嘅逐更 `client_rate_snapshot` 合計；`billing_group='monthly_ic'`
  嘅更種本身已經包喺月費，唔會加落呢個合計（`shiftAgg` 查詢本身已經
  篩 `billingGroup:'per_shift'`）。**只對 `month>=2026-08-01` 生效**
  （`MIXED_BILLING_FROM`常量）——7 月保留舊口徑（有 flat 卡就淨係計
  flat），7 月四個 gate 數字唔變（`npm run gate:reports`／
  `gate:pricing`／`gate:export`／`report:regen` 全部喺呢個改動之後跑
  過，同基線一致）。`gross-margin.ts` 唔使額外改——site 級 `revenue`
  直接沿用 `buildMonthlyClose()`（同一份 code），改咗嗰邊自動生效。
  **已知限制**：`billing_group=monthly_ic` 嘅更種嘅「成本」（guard_
  wage/broker_fee snapshot）都會被同一個 `shiftAgg` 查詢一併剔走（唔
  計入該盤 cost），同數碼港 CP5 IC 崗嘅既有做法一致（cost 唔喺呢個
  site 嘅 gross-margin 反映）——如果將來要將月薪崗嘅真實 payout cost
  計返入嚟，要拆開 revenue／cost 兩條唔同 billingGroup filter 嘅
  query，呢個 WP 冇做（超出範圍）。
- **Opus 5.5 驗收收窄（取代上面「該盤全部 per_shift 更種」嘅講法）**：
  flat 收入盤（盤級 flat 卡覆蓋該月，或者 monthly_fixed＋monthly_fee
  pro-rata）上面，per_shift 更種**淨係**喺有「逐更另收」卡（掛呢個更種或
  盤級通用、`effective_from>=2026-08-01`、覆蓋該月、`client_rate` 非 null、
  `billing_model` per_shift／null）先加 snapshot 落收入、先要求收客定价；
  否則當「已包喺月費」——唔加收入、唔標 `client_unpriced`，毛利表嗰行收入
  顯示 0（備註「收入已包喺月費」）。7 月匯入／派生卡（7/1 起）永遠唔觸發。
  判斷集中喺 `src/lib/reports/mixed-billing.ts`（`loadMixedBillingInfo()`、
  `isExplicitPerShiftType()`），`monthly-close.ts`／`gross-margin.ts`／
  `unpriced.ts`（`includedInSiteFlatFee()`、`UnpricedLookups.
  mixedBillingInfoBySiteId`）／reprice route 共用。`isClientUnpricedShift()`
  8 月起用 `opts.includedInSiteFlatFee`，冇傳就保守沿用 7 月盤層面豁免。
  開盤 plan 對 flat 收入盤唔起逐更收客卡（`scripts/opening/lib/mixed-
  billing-sites.ts` `MIXED_BILLING_SITES`＝老闆拍板嘅混合盤，暫時淨係控制
  室）。見 P2-版面重設計計劃.md §17.10。
- **OT 揀卡（Opus 5.5 驗收）**：OT 記錄淨係配 `shift_type_id` 完全相等嘅
  卡（唔准跌落 shift_type=null 嘅盤級／雞頭級／guard 級正更卡）；roster
  upload 套用（`reconcile-apply.ts`）OT 都行 resolver（之前一律 null）。
  **未決**：OT snapshot 係「每粒鐘」（毛利表 ×ot_hours）定「每條記錄」
  （糧明細／應收直接加總）——見 §17.10.2 第 3 項。
- **定價器（`src/lib/pricing/resolve-rate.ts`）**：`monthly_fixed` 盤
  上嘅 `per_shift` 更種一直都可以配到逐更卡出 `client_rate`（`isPer
  ShiftEligible()`／`specificityRank()` 從來冇睇 `site.billing_model`，
  淨係睇卡本身嘅 `billing_model`）——冇改，見
  `tests/pricing-resolve-rate.test.ts`「有 per_shift 卡就照常揀」＋
  WP-MIXED-BILLING 新增嘅兩條控制室例子測試。**有改**：
  `isClientUnpricedShift()` 嘅「盤層面豁免」（`opts.siteBillingModel
  !=='per_shift'` 就一律唔算未定价）淨係對 `2026-08-01` 之前嘅月份
  生效（`opts.month` 參數）——8 月起，一個 `monthly_fixed` 盤上嘅
  `per_shift` 更種（例：控制室日薪崗）如果冇 `client_rate_snapshot`
  就照樣算「收客价未定」，唔再因為個盤有 flat 卡就成盤豁免。**7 月
  唔受影響**：IFC／九龍企業大廈／恆星樓／屯門小欖樂怡街5號呢批 7 月
  既有嘅月費盤，per_shift 更種嘅 `client_rate_snapshot` 100% null（成
  個盤收入淨係 flat 卡，從來冇打算逐更開單）——8 月起如果呢批盤嘅
  更種繼續冇逐更卡，會開始畀「收客价未定」標記；如果呢啲更種其實
  「成個盤月費包晒、永遠唔會有逐更卡」，正確做法係將嗰個更種改做
  `billing_group=monthly_ic`（呢個 WP 冇改任何現有更種，留俾之後嘅
  WP／老闆定點做）。
- **OT（老闆 2026-09-24 答：「個個盤唔同，個個人都唔同」，系統唔准
  自動套公式計 OT 价）**：
  - `resolve-rate.ts` 嘅 `resolveShiftPricingFromCards()`：OT 記錄
    （`record_type=ot`）而家行同 shift 一樣嘅卡揀邏輯（site／broker／
    guard 級 specificity），揀嘅係掛住嗰個 OT 更種（`shift_type_id`）
    嘅卡——**卡嘅金額本身就係「每粒鐘」嘅价，唔再除 `shift_type.
    hours`**。冇卡就 `client_rate`／`guard_wage`／`broker_fee` 全部
    `null`，`unpriced:true`（`leave` 記錄維持原本一律 null 嘅行為，
    冇改）。
  - `gross-margin.ts` 嘅「parent 更 snapshot÷hours×ot_hours」公式
    fallback（同埋「OT 更種自己嘅卡÷hours」fallback）**對
    `month>=2026-08-01` 停用**（`otFormulaFallbackEnabled`）——8 月起
    直接用 OT 記錄自己嘅 `client_rate_snapshot`／`guard_wage_
    snapshot`／`broker_fee_snapshot`（已經係「每粒鐘」价）× `ot_
    hours`，收客／出街可以各自獨立有冇；完全冇任何一邊就算
    `unresolved`。**7 月唔變**（7 月 gate 用緊呢條公式）。
  - **未定价 OT**（`src/lib/pricing/unpriced.ts` 新分類
    `ot_unpriced`）：`computeUnpricedSummary()`／`buildUnpricedSummary()`
    對 `record_type=ot`、非 cancelled、完全冇任何 client/guard/fee
    snapshot 嘅記錄計入 `ot_unpriced`（同 `payout_unpriced`／
    `client_unpriced` 嗰套獨立，唔互相排斥）；`buildUnpricedSummary()`
    淨係喺 `month>=2026-08-01` 先將 OT 記錄攞埋落嚟計（`includeOt`
    gate，7 月 OT 記錄嘅 snapshot 一直由 seed 直接寫入，唔經呢個新
    分類）。`GET /api/reports/gross-margin`／`monthly-close`／
    `payroll`／`my-receivable` 四個 report endpoint response 加咗
    `ot_unpriced_count`（獨立於 `unpriced_count`，等前端頁頂顯示
    「N 條 OT 未定价」）。
  - **OT 逐盤逐人人手設卡**：系統唔會自動推斷 OT 价——要幫某個盤/某
    個 OT 更種定价，喺價目卡管理起一張 `rate_card`（`shift_type_id`
    指住嗰個 OT 更種；`broker_id`／`guard_id` 可選，愈細愈優先，同
    正更卡一致嘅 specificity 規則），`client_rate`／`guard_wage`／
    `broker_fee` 直接填「每粒鐘」嘅价。`scripts/opening/build-aug-
    plan.ts` 已經幫 HKU座頭「1Hr OT」（有 8 月試算价目資料）起咗呢
    種卡（site+shiftType 級，broker Y，84.85/73）；其餘 OT 更種
    （例：啟航1331「OT3.5」）冇試算資料可以起卡，維持未定价，等
    會計/老闆人手補。
- **開盤 script（`scripts/opening/build-aug-plan.ts`／`apply-aug-
  plan.ts`）**：
  - 控制室：8 月同時起兩個更種——per_shift「N」（日薪崗，逐更卡
    840/800）同 monthly_ic「N-IC」（月薪崗，冇逐更 client 卡，收入
    包喺 site flat 卡 22,000；出街价卡 F=800 掛住呢個新更種）。7 月
    既有嘅 `MR-` placeholder 更種唔改。**已知限制**：邊個保安員報邊
    個更種，8 月試算 `records.jsonl` 冇逐格 rank/code 欄可以自動分
    （同數碼港 CP5 嘅 rank 收窄機制唔同、用唔到），淨係靠「人」先分
    得到（25 更 vs 22 更兩個人）——要會計/主管喺更表編輯器手動幫每
    個保安員揀啱更種；`verify-aug.ts` 嘅 `verifyControlRoomMixedBilling()`
    用「模擬計算」（唔係逐格對真實 shift_records）驗證 40,480。
  - **7 月卡加 `effective_to`（老闆 2026-09-24 批准嘅唯一 7 月卡改
    動，「8 月無就加」）**：`plan.rateCards.closeJuly`（新 plan 分
    類，唔係 `create`——rate_cards 歷史係 append-only，呢個操作純粹
    幫現有卡加期限，唔改金額）——啟航1331 D@10:00 Event 發票 special
    卡 11,700、數碼港 CP5 IC 30,967.74 月費卡，兩張都加
    `effective_to=2026-07-31`。**apply 階段 double-check**：淨係 DB
    層面已經真係有對應嘅 8 月替代卡（Event K 1,350／CP5 IC flat
    18,580.65）先套用，搵唔到就 skip（維持 7 月卡原封不動），唔會
    「幫 7 月卡加期限但冇嘢頂上」。`verify-aug.ts` 嘅
    `verifyJulyCardsUnaffected()` 確認 `effective_to=2026-07-31`
    唔影響 7 月最後一日嘅定价（仍然生效），8 月 1 日起先跌出。
  - 數碼港 CP5 IC 8 月 flat 卡（18,580.65）**建卡時已經帶
    `effective_to=2026-08-31`**（`NewRateCardPlan.effectiveTo` 新
    欄，`apply-aug-plan.ts` 寫入 `rate_cards.effective_to`）——9 月起
    「正常月費」金額未定，呢個 WP 冇建 9 月卡，`plan-summary.md`／
    `needsBossReview` 提老闆/會計之後定咗先起。
  - 希慎廣場 1930-0730 更種（老闆 2026-09-24 再確認：同 1930-0930
    並存，兩個都建，卡一樣 K 1,100／1,000）——實作不變，單純由「未
    經確認嘅推斷」變「已確認」。
  - Wilson Control＝控制室、Wilson Patrol＝都會大學夜巡邏 alias——
    老闆 2026-09-24 確認（「啱」），`EXTRA_ALIASES` 由 `needsBossReview`
    移除，變定案。
  - **冪等修正**（Opus 驗收提出）：`ensureShiftType()` 揀更種嗰段—
    —apply 完之後 dev DB 同一時段可能已經有「7 月 placeholder（`MR-`/
    `PR`）+ 8 月新起嘅真代號」共存（例：控制室 MR-+N+N-IC、數碼港 CP5
    D+D-2 全部同一時段），舊版淨係揀 `exact[0]`（DB 查詢次序，唔保證
    跨 run 一致）會令重新 `build` 誤揀 placeholder 或者揀錯代號，多起
    唔必要嘅卡（實測 9 張）。而家：已知想要嘅 code（`codeHint`）就直
    接搵嗰個 code 嘅 exact match；搵唔到先排除 placeholder 代號
    （`MR-`/`PR`）揀剩低嘅；兩者都唔夠先跌落原本嘅 needsBossReview
    fallback。`apply-aug-plan.ts` 嘅 `RateCardCloseJulyPlan` 查現有
    卡／8 月替代卡都加咗 `shiftTypeStartTime` 精確辨識（同 code 但
    唔同時段嘅更種，例如啟航1331「D」有 07:30-19:30 同 10:00-19:00
    兩個）。**驗證**：`db:reset && db:seed` → `build` → `apply --plan`
    → `apply --apply` → `build`（再一次）→ `apply --plan`——全部欄位
    （盤/更種/價目卡/散工/7 月卡加期限）都係「新建 0／跳過全部」。
