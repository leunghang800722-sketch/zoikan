// P1-執行計劃.md §4 WP4 item 2／P2-WP-R3：首頁改做尚欠 Dashboard（README
// §02＝§15「尚欠總覽」；§25 雞頭首頁；§21 手機）。「尚欠總覽」module 對
// 雞頭/保安員係硬性 ✗（matrix.ts），呢兩個角色唔會打一個一定 403 嘅
// API——雞頭有自己專用嘅 `BrokerDashboard`（`GET /api/dashboard/broker`
// ＋ `GET /api/reports/my-receivable`）；保安員／自訂角色見返快速連結卡。
//
// B11 驗收修正：呢個 fallback 分支原本用一個寫死嘅 `CARDS`（更表／配額／
// 本月應收／保安員）＋大數 `KpiCard` 樣式——寫死嘅連結完全冇考慮呢個
// session 實際有冇權限（例如出廠「保安員」角色呢 4 個 module 全部硬性
// 禁止，寫死版會出 4 張撳落去實際上一定 403 嘅卡）。改用同
// `(app)/layout.tsx` 側欄一致嘅 `getNavLinks(session, grants)`
// 過濾出嚟嘅連結（唯一嘅權限真相來源），並換做 README §「保安員／其他
// 角色首頁快速連結」寫嘅細卡樣式（標題 500/13.5px＋副行 11.5px
// `#64748b`＋「›」，白卡圓角 8px padding 12px 16px），唔再用
// `KpiCard`（嗰個係大數樣式，唔啱呢種純導航連結）。
import { getCurrentSession } from "@/lib/auth/current-session";
import { redirect } from "next/navigation";
import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import ShortfallDashboard from "./ShortfallDashboard";
import BrokerDashboard from "./BrokerDashboard";
import { PageHeader } from "@/components/ui/PageHeader";
import { getNavLinks, getViewGrants } from "@/lib/rbac/nav";
import { shortfallCardVisibility } from "@/lib/ui/shortfall-cards";
import { HomeInbox } from "@/components/home/HomeInbox";
import { getPendingCounts } from "@/lib/rbac/pending-counts";
import { countOpenFor } from "@/lib/triage/session";

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
  "/users": "用戶帳號管理",
  "/roles": "角色權限矩陣",
  "/audit-log": "操作紀錄（唯讀）",
  "/guards/import": "上載導入包，補保安員證件資料",
  "/triage": "導入後要人手決定嘅項目",
  "/reports/ops-digest": "每月修正類別、重複出現嘅問題",
};

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const canViewShortfall = session.baseRole === "老闆" || session.baseRole === "主管" || session.baseRole === "會計";
  const isBroker = session.baseRole === "雞頭";

  if (canViewShortfall) {
    const grants = await getViewGrants(session);
    const cards = shortfallCardVisibility(grants);
    // P3-3.3：待辦收件箱——審批數同 layout 側欄 badge 共用同一次查詢（react cache，參數一致）；
    // 待答數 `countOpenFor` 亦 cache。其餘（未對數／月結進度／要老闆決定）喺 client 按 grants 唯讀 fetch。
    const showFeedback = grants["助手"] && session.baseRole === "老闆";
    const [pendingCounts, triageOpen] = await Promise.all([
      getPendingCounts(!!grants["審批"], showFeedback),
      grants["導入分診"] ? countOpenFor(session) : Promise.resolve(0),
    ]);
    return (
      <div className="flex flex-col gap-4">
        <HomeInbox
          approvals={cards.showApprovals ? pendingCounts.approvals : null}
          triage={grants["導入分診"] ? triageOpen : null}
          canRosterUploads={!!grants["更表上載"]}
          canMonthClose={!!grants["一鍵結算"]}
          canGuardFix={!!grants["安員配對修復"]}
        />
        <ShortfallDashboard userName={session.name} roleLabel={session.roleName} showMargin={cards.showMargin} />
      </div>
    );
  }

  if (isBroker) {
    return <BrokerDashboard userName={session.name} />;
  }

  // P3-3.7：保安員（base role「安員」）登入見說明頁——系統功能稍後開放。
  if (session.baseRole === "安員") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={`你好，${session.name}`} />
        <div data-testid="guard-landing" className="rounded-lg border border-zk-border bg-white px-5 py-6 text-[14px] leading-relaxed text-zk-text">
          <p>你嘅帳號係保安員帳號，系統功能稍後開放。如要改密碼請按下面。</p>
          <div className="mt-4 flex items-center gap-4 text-[13.5px]">
            <Link href="/change-password" className="font-semibold text-zk-primary underline">
              改密碼
            </Link>
            <LogoutButton className="p-0 text-[13.5px] font-semibold text-zk-text-secondary underline underline-offset-2 hover:text-zk-text" />
          </div>
        </div>
      </div>
    );
  }

  // 其他自訂角色：快速連結卡——只顯示 `getNavLinks()` 判過權限嘅
  // 連結（排走「/」首頁本身，因為就係呢一頁）。
  const grants = await getViewGrants(session);
  const links = (await getNavLinks(session, grants)).filter((l) => l.href !== "/");

  // P2-C §4：零連結時（例如出廠「保安員」角色全部 module 都硬性禁止）副題
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
