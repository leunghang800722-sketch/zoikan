// P1-執行計劃.md §4 WP4 item 2／P2-WP-R3：首頁改做尚欠 Dashboard（README
// §02＝§15「尚欠總覽」；§25 雞頭首頁；§21 手機）。「尚欠總覽」module 對
// 雞頭/安員係硬性 ✗（matrix.ts），呢兩個角色唔會打一個一定 403 嘅
// API——雞頭有自己專用嘅 `BrokerDashboard`（`GET /api/dashboard/broker`
// ＋ `GET /api/reports/my-receivable`）；安員／自訂角色見返快速連結卡。
//
// B11 驗收修正：呢個 fallback 分支原本用一個寫死嘅 `CARDS`（更表／配額／
// 本月應收／保安員）＋大數 `KpiCard` 樣式——寫死嘅連結完全冇考慮呢個
// session 實際有冇權限（例如出廠「安員」角色呢 4 個 module 全部硬性
// 禁止，寫死版會出 4 張撳落去實際上一定 403 嘅卡）。改用同
// `(app)/layout.tsx` 側欄一致嘅 `getNavLinks(session, grants)`
// 過濾出嚟嘅連結（唯一嘅權限真相來源），並換做 README §「安員／其他
// 角色首頁快速連結」寫嘅細卡樣式（標題 500/13.5px＋副行 11.5px
// `#64748b`＋「›」，白卡圓角 8px padding 12px 16px），唔再用
// `KpiCard`（嗰個係大數樣式，唔啱呢種純導航連結）。
import { getCurrentSession } from "@/lib/auth/current-session";
import { redirect } from "next/navigation";
import Link from "next/link";
import ShortfallDashboard from "./ShortfallDashboard";
import BrokerDashboard from "./BrokerDashboard";
import { PageHeader } from "@/components/ui/PageHeader";
import { getNavLinks, getViewGrants } from "@/lib/rbac/nav";

// 純顯示層——淨係俾呢個快速連結卡加一行副題文字，唔影響邊條連結顯示
// （顯示與否一律由 `getNavLinks()` 決定）；冇對應到嘅 href 就冇副題，
// 唔會令張卡消失。
const LINK_DESCRIPTIONS: Record<string, string> = {
  "/roster": "揀盤揀月，開更表編輯器",
  "/quotas": "雞頭每月每盤每更別配額",
  "/approvals": "雞頭排嘅更逐項確認",
  "/sites": "客戶／盤資料管理",
  "/guards": "保安員名冊",
  "/brokers": "雞頭資料管理",
  "/rate-cards": "每盤每更別嘅收客/出街價",
  "/my-receivable": "自己更數×出街價",
  "/reports/gross-margin": "全公司毛利率即時表",
  "/reports/monthly-close": "月結對數同鎖定",
  "/reports/payroll": "按雞頭出嘅糧明細",
  "/reports/shortfall": "今日各盤尚欠情況",
  "/users": "用戶帳號管理",
  "/roles": "角色權限矩陣",
  "/audit-log": "操作紀錄（唯讀）",
};

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const canViewShortfall = session.baseRole === "老闆" || session.baseRole === "主管" || session.baseRole === "會計";
  const isBroker = session.baseRole === "雞頭";

  if (canViewShortfall) {
    return <ShortfallDashboard variant="home" userName={session.name} roleLabel={session.roleName} />;
  }

  if (isBroker) {
    return <BrokerDashboard userName={session.name} />;
  }

  // 安員／其他自訂角色：快速連結卡——只顯示 `getNavLinks()` 判過權限嘅
  // 連結（排走「/」首頁本身，因為就係呢一頁）。
  const grants = await getViewGrants(session);
  const links = (await getNavLinks(session, grants)).filter((l) => l.href !== "/");

  // P2-C §4：零連結時（例如出廠「安員」角色全部 module 都硬性禁止）副題
  // 唔再寫「快速連結見下面」——下面根本冇連結，嗰句字面上係錯嘅。
  const subtitle = links.length === 0 ? "你嘅角色暫時未開任何模組權限" : `${session.roleName}——快速連結見下面。`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={`歡迎返嚟，${session.name}`} subtitle={subtitle} />
      {links.length === 0 ? (
        <div className="rounded-lg border border-zk-border bg-white px-4 py-6 text-center text-[13px] text-zk-muted">
          你嘅角色暫時未開任何模組權限，請聯絡老闆開權限。
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center justify-between gap-2 rounded-lg border border-zk-border bg-white px-4 py-3 transition-colors hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary"
            >
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium text-zk-text">{l.label}</div>
                {LINK_DESCRIPTIONS[l.href] && <div className="mt-0.5 truncate text-[11.5px] text-[#64748b]">{LINK_DESCRIPTIONS[l.href]}</div>}
              </div>
              <span className="shrink-0 text-zk-faint">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
