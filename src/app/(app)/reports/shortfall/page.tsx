// P2-WP-R3：尚欠總覽頁（README §15，同首頁 §02 共用 ShortfallDashboard，
// 只有 kicker／H1 唔同——見該 component 註解）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import ShortfallDashboard from "../../ShortfallDashboard";
import { getViewGrants } from "@/lib/rbac/nav";
import { shortfallCardVisibility } from "@/lib/ui/shortfall-cards";

export default async function ShortfallPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const cards = shortfallCardVisibility(await getViewGrants(session));
  return <ShortfallDashboard variant="overview" userName={session.name} roleLabel={session.roleName} showApprovals={cards.showApprovals} showMargin={cards.showMargin} />;
}
