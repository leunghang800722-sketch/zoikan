// A3（Opus 整合驗收）：server component 攞 session 決定 `isBroker`，
// 交俾 `RateCardsClient` 決定頁首 kicker（雞頭「我的」／內部角色
// 「主檔」，跟 `src/lib/rbac/nav.ts` 導航分組）——同 `src/app/(app)/
// my-receivable/page.tsx` 同一個 pattern。
//
// WP-PRICE：`canReprice`（「出街價:update」）——「重新計价」掣要有權先
// 顯示，同 payroll/roster 頁一樣做法。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { RateCardsClient } from "./RateCardsClient";

export default async function RateCardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const canReprice = await hasPermission(session, "出街價", "update");
  return <RateCardsClient isBroker={session.baseRole === "雞頭"} canReprice={canReprice} />;
}
