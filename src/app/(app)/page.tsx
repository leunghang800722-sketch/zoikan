// P1-執行計劃.md §4 WP4 item 2：首頁改做尚欠 Dashboard（設計文件§6.1
// 第 1 項「總覽 Dashboard：今日各盤出勤 vs 所需（尚欠即時標紅）、待審批
// 數、本月毛利進度」）。「尚欠總覽」module 對雞頭/安員係硬性 ✗
// （matrix.ts），呢兩個角色淨係見返原本嗰版快速連結卡片，唔會打一個
// 一定 403 嘅 API。
import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/current-session";
import { redirect } from "next/navigation";
import ShortfallDashboard from "./ShortfallDashboard";

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">歡迎返嚟，{session.name}</h1>
        <p className="text-sm text-gray-500">{session.roleName}——{canViewShortfall ? "今日尚欠情況一覽。" : "快速連結見下面。"}</p>
      </div>
      {canViewShortfall ? (
        <ShortfallDashboard />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {CARDS.map((c) => (
            <Link key={c.href} href={c.href} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:border-gray-400 hover:shadow">
              <div className="font-medium text-gray-900">{c.label}</div>
              <div className="mt-1 text-xs text-gray-500">{c.desc}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
