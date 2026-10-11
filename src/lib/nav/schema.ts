// P3-3.1：導覽列單一真相（NAV_SCHEMA）。
//
// 以前導覽「邊條連結／分咩組／頁首 kicker」散喺三個地方（`rbac/nav.ts` 嘅
// push()＋兩份分組表、`ui/nav-active.ts` 嘅 kicker 對照、各頁手寫
// `PageHeader kicker=`），改一處易漏兩處。呢個檔係 client-safe（冇 DB／
// next/headers），三樣全部由呢度派生：
//   - `getNavLinks()`／`groupNavLinks()`（`@/lib/rbac/nav`）：顯示與否仍由
//     `grants[module]` 決定（權限邏輯不變），呢度只係列「有咩連結、屬邊組、
//     用邊個 module」。
//   - `isLinkActive()`（`@/lib/ui/nav-active`）：active 判斷。
//   - `kickerFor()`：頁首 kicker＝該 href 所屬組名（導覽拎走咗嘅頁用 EXTRA_KICKERS）。
// 純顯示層：唔改任何 API、權限矩陣或計算。
import type { Module } from "@/lib/rbac/matrix";

const INTERNAL_GROUPS = ["", "排更", "對數", "月結", "資料", "設定"] as const;
const BROKER_GROUPS = ["", "排更", "我的"] as const;

export type BadgeKey = "approvals" | "triage" | "feedback" | "notifications";

export interface NavSchemaEntry {
  href: string;
  label: string;
  /** 組名；空字串＝冇組標題（頂部「首頁」）。 */
  group: string;
  /** 頁首 kicker（通常＝組名；報表頁寫「月結 › 報表」）。 */
  kicker: string;
  /** 顯示條件：`grants[module]` 為 true（「always」＝凡已登入都見）。數組＝任一個 grant 就顯示。 */
  module: Module | Module[] | "always";
  /** module 係數組時：邊個 module 無 grant 就改連去邊條 href（保持有權限先見得到嘅頁）。 */
  hrefByModule?: Partial<Record<Module, string>>;
  /** 額外條件（例：現場意見只限老闆）。 */
  onlyBaseRole?: string;
  badge?: BadgeKey;
}

export const INTERNAL_NAV: NavSchemaEntry[] = [
  // P7.1：「首頁」badge＝未讀通知數
  { href: "/", label: "首頁", group: "", kicker: "", module: "always", badge: "notifications" },
  { href: "/roster", label: "更表", group: "排更", kicker: "排更", module: "更表" },
  { href: "/quotas", label: "配額", group: "排更", kicker: "排更", module: "配額" },
  { href: "/approvals", label: "審批", group: "排更", kicker: "排更", module: "審批", badge: "approvals" },
  { href: "/roster-uploads", label: "更表上載", group: "對數", kicker: "對數", module: "更表上載" },
  { href: "/roster-uploads?tab=fix", label: "未配對保安員修復", group: "對數", kicker: "對數", module: "安員配對修復" },
  { href: "/month-close", label: "一鍵結算", group: "月結", kicker: "月結", module: "一鍵結算" },
  { href: "/triage", label: "待答問題", group: "月結", kicker: "月結", module: "導入分診", badge: "triage" },
  {
    href: "/reports/monthly-close",
    label: "報表",
    group: "月結",
    kicker: "月結 › 報表",
    module: ["月結總表", "毛利即時表", "糧明細", "長工糧"],
    hrefByModule: { 毛利即時表: "/reports/gross-margin", 糧明細: "/reports/payroll", 長工糧: "/reports/longterm-payroll" },
  },
  { href: "/sites", label: "盤", group: "資料", kicker: "資料", module: "盤" },
  { href: "/guards", label: "保安員", group: "資料", kicker: "資料", module: "安員" },
  { href: "/brokers", label: "雞頭", group: "資料", kicker: "資料", module: "雞頭" },
  { href: "/rate-cards", label: "價目", group: "資料", kicker: "資料", module: "出街價" },
  { href: "/users", label: "用戶", group: "設定", kicker: "設定", module: "用戶管理" },
  { href: "/roles", label: "角色權限", group: "設定", kicker: "設定", module: "用戶管理" },
  { href: "/audit-log", label: "操作紀錄", group: "設定", kicker: "設定", module: "操作紀錄" },
  // 現場意見：「助手」module（雞頭／保安員硬性冇）＋淨係老闆（同 `src/app/api/feedback/**` 嘅 assertBoss 一致）。
  { href: "/feedback", label: "現場意見", group: "設定", kicker: "設定", module: "助手", onlyBaseRole: "老闆", badge: "feedback" },
  // P7.1：排程 job（開關／時間表／立即跑）——老闆專用，無新 RBAC module（API 同頁面用 baseRole 判斷）。
  { href: "/settings/jobs", label: "自動排程", group: "設定", kicker: "設定", module: "always", onlyBaseRole: "老闆" },
];

export const BROKER_NAV: NavSchemaEntry[] = [
  { href: "/", label: "首頁", group: "", kicker: "", module: "always", badge: "notifications" },
  { href: "/roster", label: "更表", group: "排更", kicker: "排更", module: "更表" },
  { href: "/quotas", label: "配額", group: "排更", kicker: "排更", module: "配額" },
  { href: "/my-receivable", label: "本月應收", group: "我的", kicker: "我的", module: "出街價" },
  { href: "/guards", label: "我的保安員", group: "我的", kicker: "我的", module: "自己安員" },
  { href: "/rate-cards", label: "價目", group: "我的", kicker: "我的", module: "出街價" },
];

/** 導覽拎走（或唔喺導覽）但頁首仍要有 kicker 嘅頁。 */
const EXTRA_KICKERS: Record<string, string> = {
  "/guards/import": "資料",
  "/guards/new-from-docs": "資料",
  "/month-close/files": "月結",
  "/reports/gross-margin": "月結 › 報表",
  "/reports/payroll": "月結 › 報表",
  "/reports/longterm-payroll": "月結 › 報表",
  "/reports/ops-digest": "月結 › 報表",
  "/roster-uploads/reconcile": "對數",
  "/feedback/detail": "設定",
  "/settings/cover-rates": "設定",
  "/settings/cover-rates/infer": "設定",
  "/change-password": "帳號",
  "/notifications": "帳號",
};

/** 內部角色「導覽拎走」嘅 href：保持可用（redirect 或照 render），唔出現喺導覽。 */
export const OFF_NAV_PATHS = ["/reports/shortfall", "/guard-fix", "/guards/import", "/guards/new-from-docs", "/reports/gross-margin", "/reports/payroll", "/reports/longterm-payroll", "/reports/ops-digest"] as const;

export function schemaFor(baseRole: string): NavSchemaEntry[] {
  return baseRole === "雞頭" ? BROKER_NAV : INTERNAL_NAV;
}

export function groupOrderFor(baseRole: string): readonly string[] {
  return baseRole === "雞頭" ? BROKER_GROUPS : INTERNAL_GROUPS;
}

/** 頁首 kicker：跟導覽組名。`isBroker` 揀雞頭／內部版本。搵唔到回空字串。 */
export function kickerFor(href: string, isBroker = false): string {
  const hit = (isBroker ? BROKER_NAV : INTERNAL_NAV).find((e) => e.href === href);
  if (hit) return hit.kicker;
  if (href in EXTRA_KICKERS) return EXTRA_KICKERS[href]!;
  const other = (isBroker ? INTERNAL_NAV : BROKER_NAV).find((e) => e.href === href);
  return other?.kicker ?? "";
}
