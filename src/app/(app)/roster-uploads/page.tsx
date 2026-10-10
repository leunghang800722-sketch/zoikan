// P3-3.5：「更表上載」頁 server wrapper——按 grants 決定有冇「未配對保安員修復」tab（淨係老闆：
// 「安員配對修復:view」），再 render client 頁（`RosterUploadsClient`，tab 由 `?tab=fix` 驅動）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getViewGrants } from "@/lib/rbac/nav";
import RosterUploadsClient from "./RosterUploadsClient";

export default async function RosterUploadsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const grants = await getViewGrants(session);
  return <RosterUploadsClient canFix={!!grants["安員配對修復"]} />;
}
