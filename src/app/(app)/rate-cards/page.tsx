// A3（Opus 整合驗收）：server component 攞 session 決定 `isBroker`，
// 交俾 `RateCardsClient` 決定頁首 kicker（雞頭「我的」／內部角色
// 「主檔」，跟 `src/lib/rbac/nav.ts` 導航分組）——同 `src/app/(app)/
// my-receivable/page.tsx` 同一個 pattern。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { RateCardsClient } from "./RateCardsClient";

export default async function RateCardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <RateCardsClient isBroker={session.baseRole === "雞頭"} />;
}
