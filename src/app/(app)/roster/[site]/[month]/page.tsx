// 更表編輯器頁面（P1-WP3）——薄 wrapper，主要邏輯喺 client component
// `RosterEditor`（呢個 page.tsx 本身唔使 "use client"，登入殼／導航由
// `(app)/layout.tsx` 負責，呢度淨係拆返 URL 參數轉交落去）。
import RosterEditor from "./editor/RosterEditor";
// WP-PRICE：「重新計價」掣要有「出街價:update」先顯示（老闆／會計出廠
// 可以由老闆開）——同 src/app/(app)/rate-cards/page.tsx 一樣嘅 pattern，
// server component 用 session 查一次 permission，交俾 client component。
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";

export default async function RosterPage({
  params,
}: {
  params: Promise<{ site: string; month: string }>;
}) {
  const { site, month } = await params;
  const session = await getCurrentSession();
  const canReprice = session ? await hasPermission(session, "出街價", "update") : false;
  return <RosterEditor siteId={site} month={month} canReprice={canReprice} />;
}
