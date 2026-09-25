// RBAC 權限矩陣——依據《在勤系統設計文件v1.0》§5.0、§5.1。
//
// P1-WP2 Opus 對抗式驗收 C3 裁定：module 粒度太粗（一格「價目」/「系統」/
// 「報表」蓋住幾條性質完全唔同嘅設計表行，令「主管預設睇唔到收客價」
// 呢類設計本意冇辦法用純 module×action 表達）。呢一版拆細做 19 個
// module × 5 個 action = 95 個 permission，逐個 module 上面嘅註解引用返
// 《設計文件》§5.1 表入面嗰一行原文，方便 Opus 逐格核對。
//
//   - GRANT ("✓")：seed 時 role_permissions.granted = true
//   - OFF   ("○")：seed 時 role_permissions.granted = false（老闆可以之後
//                   喺角色權限管理畫面逐格開，見 /api/roles/:id/permissions）
//   - DENY  ("✗")：硬性禁止——role_permissions 呢行**唔存在**，加上
//                   requirePermission() runtime hard-deny check 雙重保證
//                   （見 requirePermission.ts）。自訂角色（is_custom=true）
//                   用 role.base_role（唔係 role.name）查呢個矩陣——複製
//                   之後改名唔會逃過硬性禁止（Opus 驗收殘留2）。
//
// 「N/A」（呢個 module 對呢個 action 冇對應嘅實際能力，例如報表冇
// create/update/void、操作紀錄冇 create/update/void）一律填 deny——唔係
// 業務限制，純粹「呢個組合根本唔存在」，冇 route 會 check 呢啲格。

export const MODULES = [
  "更表",
  "配額",
  "審批",
  "收客價", // 拆自舊「價目」——設計文件§5.1「睇收客價、毛利、月結總表」「改收客價」
  "出街價", // 拆自舊「價目」——「睇出街價（全部雞頭）」「睇自己出街價」「改出街價」
  "盤",
  "安員",
  "自己安員", // 新增——雞頭端「自己安員名冊管理」（設計文件§6.2），同內部角色用嘅「安員」分開
  "雞頭",
  "糧務", // 「入盤支出/收入」「入安員糧/生成糧務批次」
  "批核糧務批次", // 拆自舊「糧務」void——設計文件§5.1「批核糧務批次」
  // 拆自舊「糧務」void——設計文件§5.1「月結鎖定/解鎖」。規劃裁定（Opus
  // 對抗式驗收第三輪，應修）：呢個 module 淨係管「寫入」（lock/unlock，
  // POST /api/month-closes/:id/lock、/unlock）；「讀」（邊個月鎖咗，
  // GET /api/month-closes）改用「更表」module 嘅 view（主管出廠有
  // 更表:view 冇糧務:view，但都應該見到邊個月鎖咗，先知自己仲改唔改得
  // 更表/日常操作——呢個屬於「更表」關注面，唔係「糧務」金錢關注面）。
  "月結鎖定解鎖",
  "用戶管理", // 拆自舊「系統」——「用戶管理、角色權限管理」
  "操作紀錄", // 拆自舊「系統」——「睇操作紀錄」
  "毛利即時表", // 報表逐份獨立一行（設計文件§5.0「每份報表獨立一行權限」）
  "尚欠總覽",
  "月結總表",
  "糧明細",
  "更表匯出",
  "個人資料", // P3 新增——設計文件「改自己個人資料 全部✓」，change-password／自己 display 資料用呢格，五角色皆✓
  // WP-PII（老闆 2026-09-17 拍板）——保安員身份證／出生日期／地址／
  // 緊急聯絡人／Blacklist check。同「個人資料」（改自己）分開——呢個
  // module 管嘅係「睇/改邊個保安員嘅呢批敏感個人資料」，一個獨立資源
  // field group（見 src/lib/api/field-groups.ts GUARD_PII_FIELDS），
  // 唔可以借用「個人資料」（嗰格五角色皆✓，語意完全唔同）。牌照（號碼／
  // 類別／到期日）、平安卡、入職／離職日期唔喺呢個 module——跟現有
  // 「安員」module（主管出廠已經有，即老闆話嘅「主管睇部分」）。
  "安員個人資料",
  // WP-PII——保安員銀行戶口（銀行／戶口號碼／收款人名）。獨立於
  // 「安員個人資料」——老闆話「主管睇部分」冇提銀行，呢個 module 主管
  // 出廠硬性拒（同雞頭／安員一致），淨係老闆／會計見得到。
  "安員銀行資料",
  // WP-AI1 新增（老闆 2026-09-12 產品要求）——側欄 AI 助手（唯讀，讀操作
  // 說明＋讀真實系統數據答問題）嘅基本進入權。淨係 view 有意義（助手本身
  // 冚死唔可以寫入，冇 create/update/void/export 呢類概念）；雞頭／安員
  // 硬性禁止——同「呢個 module 硬性拒絕嘅角色連 AI 助手都攞唔到」直接對應
  // requirePermission(req, "助手", "view") 喺 chat route 嘅第一道閘。
  "助手",
  // WP-ROSTER-UPLOAD Phase A（老闆 2026-09-21/23 拍板，§15）——會計／
  // 老闆每月上載嘅、每個盤自己嘅更表檔案（xlsx），係計糧嘅 authoritative
  // source（唔係雞頭／同事喺系統自己報更嗰啲）。老闆 2026-09-23 明文答
  // 「上載權限：會計、主管、老闆」三類——雞頭／安員硬性拒（檔案含逐行
  // 姓名／電話／工號原文，同 WP-PII 級別一致，雞頭連自己嗰盤嘅上載都
  // 見唔到）。
  "更表上載",
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ["view", "create", "update", "void", "export"] as const;
export type Action = (typeof ACTIONS)[number];

export const ROLE_NAMES = ["老闆", "主管", "會計", "雞頭", "安員"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export type Cell = "grant" | "off" | "deny";
export type ModuleRow = Record<Action, Cell>;
export type RoleMatrix = Record<Module, ModuleRow>;

function row(view: Cell, create: Cell, update: Cell, del: Cell, exp: Cell): ModuleRow {
  return { view, create, update, void: del, export: exp };
}

const G: Cell = "grant";
const O: Cell = "off";
const D: Cell = "deny";

// 「單一設計表行」module（審批／批核糧務批次／月結鎖定解鎖／自己安員…）
// 用嚟將一個 ✓/○/✗ 值套用到成行 5 個 action（呢啲 module 冇實際
// create/void 呢類細分概念，統一套用先貼近設計文件原意，唔會拆到失真）。
function uniformRow(cell: Cell): ModuleRow {
  return row(cell, cell, cell, cell, cell);
}
// N/A：呢個 module 根本冇對應 route 會 check 呢個 action（例如報表冇
// create/update/void；操作紀錄冇 create/update/void）。
const NA: Cell = D;

// ---------------------------------------------------------------------------
// 老闆：設計文件§5.1 全部行都係✓
// ---------------------------------------------------------------------------
const OWNER: RoleMatrix = {
  更表: row(G, G, G, G, G), // 睇全部盤更表／排更改更／雞頭配額內填人(N/A於內部角色)／審批／派配額加減盤改更別／安排公司兵長工——全部✓
  配額: row(G, G, G, G, G),
  審批: row(G, NA, G, NA, G), // 審批雞頭排更 ✓（view=睇待審／update=批核）
  收客價: row(G, G, G, NA, G), // 睇收客價、毛利、月結總表✓；改收客價✓
  出街價: row(G, G, G, G, G), // 睇出街價✓；改出街價✓
  盤: row(G, G, G, G, G), // 派配額、加減盤、改更別結構✓
  安員: row(G, G, G, G, G), // 加減安員、改安員資料✓；睇聯絡資料✓
  自己安員: row(NA, NA, NA, NA, NA), // 內部角色用「安員」，呢個 module 淨係雞頭用
  雞頭: row(G, G, G, G, G),
  糧務: row(G, G, G, G, G), // 入盤支出/收入✓；入安員糧/生成批次✓；M4：void 跟 update（老闆=✓）
  批核糧務批次: uniformRow(G), // 批核糧務批次✓
  月結鎖定解鎖: uniformRow(G), // 月結鎖定/解鎖✓
  用戶管理: row(G, G, G, G, G), // 用戶管理、角色權限管理✓
  操作紀錄: row(G, NA, NA, NA, G), // 睇操作紀錄✓
  毛利即時表: row(G, NA, NA, NA, G),
  尚欠總覽: row(G, NA, NA, NA, G),
  月結總表: row(G, NA, NA, NA, G),
  糧明細: row(G, NA, NA, NA, G),
  更表匯出: row(G, NA, NA, NA, G),
  個人資料: row(G, NA, G, NA, NA), // 改自己個人資料✓
  安員個人資料: row(G, NA, G, NA, NA), // WP-PII：老闆全睇全改
  安員銀行資料: row(G, NA, G, NA, NA), // WP-PII：老闆全睇全改
  助手: row(G, NA, NA, NA, NA), // WP-AI1：老闆✓——view 有意義，其餘 N/A
  更表上載: row(G, G, G, G, NA), // WP-ROSTER-UPLOAD：老闆上載/睇/PATCH（人手指定盤）全部✓；WP-UPLOAD-VOID：作廢✓（會計/主管/老闆三類）
};

// ---------------------------------------------------------------------------
// 主管
// ---------------------------------------------------------------------------
const SUPERVISOR: RoleMatrix = {
  更表: row(G, G, G, G, G), // 睇全部盤更表✓／排更改更✓／審批✓／派配額加減盤改更別✓／安排公司兵長工✓
  配額: row(G, G, G, O, G),
  審批: row(G, NA, G, NA, G), // 審批雞頭排更 ✓
  收客價: row(O, O, O, NA, O), // C3：主管預設**睇唔到**收客價（設計文件「睇收客價、毛利、月結總表」主管=○）；改收客價 ○
  出街價: row(G, O, O, O, G), // 睇出街價（全部雞頭）✓；改出街價 ○
  盤: row(G, G, G, O, G), // 派配額、加減盤、改更別結構 ✓
  安員: row(G, G, G, G, G), // 加減安員、改安員資料 ✓；睇聯絡資料 ✓
  自己安員: row(NA, NA, NA, NA, NA),
  雞頭: row(G, O, O, O, G),
  糧務: uniformRow(O), // P3：主管糧務 view/export 同糧明細一致（跟§5.1糧務嗰行）；入支出/入糧本身已經○；void 跟 update（M4）
  批核糧務批次: uniformRow(D), // 批核糧務批次 ✗（硬性——設計文件明文）
  月結鎖定解鎖: uniformRow(D), // 月結鎖定/解鎖 ✗（硬性）
  用戶管理: uniformRow(D), // 用戶管理、角色權限管理 ✗（硬性）
  操作紀錄: row(O, NA, NA, NA, O), // 睇操作紀錄 ○
  毛利即時表: row(O, NA, NA, NA, O), // 屬於「睇…毛利…」條款，主管○
  尚欠總覽: row(G, NA, NA, NA, G), // 尚欠總覽冇財務敏感度，開俾全部主管（設計文件§6.1「開俾全部主管」例句）
  月結總表: row(O, NA, NA, NA, O), // 含毛利／營業額，主管○
  糧明細: row(O, NA, NA, NA, O),
  更表匯出: row(G, NA, NA, NA, G),
  個人資料: row(G, NA, G, NA, NA),
  // WP-PII：老闆話「主管睇部分」——牌照/平安卡/入職離職日期跟「安員」
  // module（主管出廠已經有），但身份證/出生日期/地址/緊急聯絡人/
  // Blacklist 出廠關（○，老闆可以開）；銀行戶口主管硬性拒（✗）。
  安員個人資料: row(O, NA, O, NA, NA),
  安員銀行資料: uniformRow(D),
  助手: row(G, NA, NA, NA, NA), // WP-AI1：主管✓
  更表上載: row(G, G, G, G, NA), // WP-ROSTER-UPLOAD：老闆 2026-09-23 明文「會計、主管、老闆」三類可以上載；WP-UPLOAD-VOID：作廢✓
};

// ---------------------------------------------------------------------------
// 會計
// ---------------------------------------------------------------------------
const ACCOUNTANT: RoleMatrix = {
  更表: row(G, O, O, O, G),
  配額: row(G, O, O, O, G),
  審批: row(O, NA, O, NA, O), // C3：會計「審批」改 ○（view/update 都預設關，老闆可開）；P3：export 都改○（原本錯畀✓）
  收客價: row(G, O, O, NA, G), // 睇收客價、毛利、月結總表 ✓；改收客價 ○
  出街價: row(G, O, O, O, G), // 睇出街價 ✓；改出街價 ○
  盤: row(G, O, O, O, G),
  安員: row(G, O, O, O, G),
  自己安員: row(NA, NA, NA, NA, NA),
  雞頭: row(G, O, O, O, G),
  糧務: row(G, G, G, G, G), // 入盤支出/收入 ✓；入安員糧/生成批次 ✓；M4：void 跟 update（會計=✓）
  批核糧務批次: uniformRow(O), // 批核糧務批次 ○(高級)
  月結鎖定解鎖: uniformRow(O), // 月結鎖定/解鎖 ○(高級)
  用戶管理: uniformRow(D), // 用戶管理、角色權限管理 ✗
  操作紀錄: row(O, NA, NA, NA, O), // 睇操作紀錄 ○
  毛利即時表: row(G, NA, NA, NA, G),
  尚欠總覽: row(G, NA, NA, NA, G),
  月結總表: row(G, NA, NA, NA, G),
  糧明細: row(G, NA, NA, NA, G),
  更表匯出: row(G, NA, NA, NA, G),
  個人資料: row(G, NA, G, NA, NA),
  安員個人資料: row(G, NA, G, NA, NA), // WP-PII：老闆話「會計全睇」
  安員銀行資料: row(G, NA, G, NA, NA), // WP-PII：老闆話「會計全睇」
  助手: row(G, NA, NA, NA, NA), // WP-AI1：會計✓
  更表上載: row(G, G, G, G, NA), // WP-ROSTER-UPLOAD：老闆 2026-09-23 明文「會計、主管、老闆」三類可以上載；WP-UPLOAD-VOID：作廢✓
};

// ---------------------------------------------------------------------------
// 雞頭
// C3：更表:update 改硬性✗；安員:view 改○（預設關，睇唔到全公司安員名冊）；
// 新增「自己安員」module 取代原本靠「安員」module 開嘅「限自己安員」——
// §6.2 雞頭端「自己安員名冊管理」用呢個。
// 硬性規則1：回應永遠冇 client_rate／毛利／其他 broker 數據——收客價
// module 全硬性拒（連 view 都唔比），呢個先係「雞頭見唔到 client_rate」
// 嘅第一層防線（第二層係 broker-isolation.ts 嘅 response scrub/白名單
// serializer，defense-in-depth）。
// ---------------------------------------------------------------------------
const BROKER: RoleMatrix = {
  更表: row(G, G, D, D, O), // 睇自己雞頭安員更表✓；雞頭配額內填人✓；改更 C3 硬性✗；void✗；export○
  配額: row(G, D, D, D, O),
  審批: uniformRow(D), // 審批雞頭排更 ✗（硬性）
  收客價: uniformRow(D), // 硬性規則1——client_rate 連 view 都唔畀
  出街價: row(G, D, D, D, G), // 睇自己出街價同應收金額✓；改出街價✗
  盤: uniformRow(D), // 盤管理與雞頭角色無關——硬性拒絕
  安員: row(O, D, D, D, O), // C3：安員:view 改○（預設關，唔開放全公司安員名冊）
  // P3：自己安員 view 保留✓——規劃裁定：§5.1 表原文「限自己安員」係○
  // （即人事表入面「加減安員」嗰行嘅雞頭欄○(限自己安員)），但呢個格
  // 對應嘅係§6.2「雞頭端…自己安員名冊管理」呢個獨立畫面嘅**基本進入
  // 權**，off 咗雞頭端就連自己安員都睇唔到，令個 PWA 用唔到；query-scope
  // 層（scopeGuardWhere）已經保證佢淨係見到自己安員，所以呢度保留✓
  // 唔算違反隔離原意，純粹「呢格嘅粒度同 §5.1 原表格格對唔上」，特此
  // 記錄偏離原因。void 改 ○（P3，跟返「限自己安員」嘅○精神，容許老闆
  // 開放俾雞頭自己 void 錯手加嘅安員）。
  自己安員: row(G, O, O, O, O),
  雞頭: row(G, D, D, D, G), // 睇自己資料✓
  糧務: uniformRow(D),
  批核糧務批次: uniformRow(D),
  月結鎖定解鎖: uniformRow(D),
  用戶管理: uniformRow(D),
  操作紀錄: uniformRow(D),
  毛利即時表: uniformRow(D),
  尚欠總覽: uniformRow(D),
  月結總表: uniformRow(D),
  糧明細: uniformRow(D),
  更表匯出: row(D, NA, NA, NA, O), // P3：export 同更表:export 一致（兩者○）
  個人資料: row(G, NA, G, NA, NA),
  // WP-PII：雞頭硬性拒（老闆決定「雞頭淨係見自己啲人電話」——GUARD_
  // BROKER_FIELDS 白名單本身冇加任何新欄，呢兩個 module 對雞頭嚟講純粹
  // defense-in-depth，雞頭連 route 都行「自己安員」module，唔會撞到
  // 呢兩格，但仍然硬性拒絕，唔留任何開放嘅可能）。
  安員個人資料: uniformRow(D),
  安員銀行資料: uniformRow(D),
  助手: uniformRow(D), // WP-AI1：硬性禁止——雞頭永遠唔可以用 AI 助手（老闆 2026-09-12 明文）
  更表上載: uniformRow(D), // WP-ROSTER-UPLOAD：硬性拒——雞頭連自己嗰盤嘅上載都見唔到（老闆「上載權限：會計、主管、老闆」三類）
};

// ---------------------------------------------------------------------------
// 安員：P1 明確唔做安員端（設計文件§6.4／§7 屬 P4），全部硬性拒絕。
// ---------------------------------------------------------------------------
const GUARD_SELF: RoleMatrix = {
  更表: uniformRow(D),
  配額: uniformRow(D),
  審批: uniformRow(D),
  收客價: uniformRow(D),
  出街價: uniformRow(D),
  盤: uniformRow(D),
  安員: uniformRow(D),
  自己安員: uniformRow(D),
  雞頭: uniformRow(D),
  糧務: uniformRow(D),
  批核糧務批次: uniformRow(D),
  月結鎖定解鎖: uniformRow(D),
  用戶管理: uniformRow(D),
  操作紀錄: uniformRow(D),
  毛利即時表: uniformRow(D),
  尚欠總覽: uniformRow(D),
  月結總表: uniformRow(D),
  糧明細: uniformRow(D),
  更表匯出: uniformRow(D),
  個人資料: row(G, NA, G, NA, NA), // 「改自己個人資料」P4 都適用（change-password 呢個 P1 就有）
  安員個人資料: uniformRow(D), // WP-PII：安員硬性拒（P1 都唔做安員端，跟返成頁硬性拒絕嘅精神）
  安員銀行資料: uniformRow(D), // WP-PII：安員硬性拒
  助手: uniformRow(D), // WP-AI1：硬性禁止——安員永遠唔可以用 AI 助手（老闆 2026-09-12 明文）
  更表上載: uniformRow(D), // WP-ROSTER-UPLOAD：硬性拒
};

export const DEFAULT_MATRIX: Record<RoleName, RoleMatrix> = {
  老闆: OWNER,
  主管: SUPERVISOR,
  會計: ACCOUNTANT,
  雞頭: BROKER,
  安員: GUARD_SELF,
};

export function cellFor(role: RoleName, mod: Module, action: Action): Cell {
  return DEFAULT_MATRIX[role][mod][action];
}

export function isHardDenied(role: RoleName, mod: Module, action: Action): boolean {
  return cellFor(role, mod, action) === "deny";
}

export function isGrantedByDefault(role: RoleName, mod: Module, action: Action): boolean {
  return cellFor(role, mod, action) === "grant";
}
