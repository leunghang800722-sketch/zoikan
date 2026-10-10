// 糧明細頁面——薄 server wrapper，主要邏輯喺 client component
// `PayrollReportClient`。WP-PRICE：`canReprice`（「出街價:update」）要
// server component 查一次 permission 先傳落去，先做到「重新計價」掣
// 「有權先顯示」（同 src/app/(app)/rate-cards/page.tsx 一樣嘅 pattern）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { PayrollReportClient } from "./PayrollReportClient";

export default async function PayrollReportPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const canReprice = await hasPermission(session, "出街價", "update");
  return <PayrollReportClient canReprice={canReprice} />;
}
