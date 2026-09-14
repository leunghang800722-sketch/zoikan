// P1-執行計劃.md §4 WP4 item 2／P2-WP-R3：首頁改做尚欠 Dashboard（README
// §02＝§15「尚欠總覽」；§25 雞頭首頁；§21 手機）。「尚欠總覽」module 對
// 雞頭/安員係硬性 ✗（matrix.ts），呢兩個角色唔會打一個一定 403 嘅
// API——雞頭有自己專用嘅 `BrokerDashboard`（`GET /api/dashboard/broker`
// ＋ `GET /api/reports/my-receivable`）；安員／自訂角色見返原本嗰版快速
// 連結卡片，換做 `KpiCard` 新樣式。
import { getCurrentSession } from "@/lib/auth/current-session";
import { redirect } from "next/navigation";
import ShortfallDashboard from "./ShortfallDashboard";
import BrokerDashboard from "./BrokerDashboard";
import { KpiCard } from "@/components/ui/KpiCard";
import { PageHeader } from "@/components/ui/PageHeader";

const CARDS = [
  { href: "/roster", label: "更表", desc: "揀盤揀月，開更表編輯器" },
  { href: "/quotas", label: "配額", desc: "雞頭每月配額" },
  { href: "/my-receivable", label: "本月應收", desc: "自己更數×出街價" },
  { href: "/guards", label: "保安員", desc: "自己保安員名冊" },
];

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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={`歡迎返嚟，${session.name}`} subtitle={`${session.roleName}——快速連結見下面。`} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {CARDS.map((c) => (
          <KpiCard key={c.href} label="快速連結" value={c.label} note={c.desc} href={c.href} />
        ))}
      </div>
    </div>
  );
}
