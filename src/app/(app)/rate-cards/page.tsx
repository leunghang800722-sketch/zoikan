// A3（Opus 整合驗收）：server component 攞 session 決定 `isBroker`，
// 交俾 `RateCardsClient` 決定頁首 kicker（雞頭「我的」／內部角色
// 「主檔」，跟 `src/lib/rbac/nav.ts` 導航分組）——同 `src/app/(app)/
// my-receivable/page.tsx` 同一個 pattern。
//
// WP-PRICE：`canReprice`（「出街價:update」）——「重新計价」掣要有權先
// 顯示，同 payroll/roster 頁一樣做法。
// WP-PHASE3（§20.4 Phase 3 item 3）：`canCopyLastMonth`（「出街價:
// create」）——「複製上月卡到本月」會建新 `rate_cards` 行，跟 `POST
// /api/rate-cards` 一致嘅 create 權限（唔係 update，複製出嚟嘅係新行）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { RateCardsClient } from "./RateCardsClient";

export default async function RateCardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const [canReprice, canCopyLastMonth] = await Promise.all([
    hasPermission(session, "出街價", "update"),
    hasPermission(session, "出街價", "create"),
  ]);
  return <RateCardsClient isBroker={session.baseRole === "雞頭"} canReprice={canReprice} canCopyLastMonth={canCopyLastMonth} />;
}
