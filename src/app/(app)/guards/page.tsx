// A3（Opus 整合驗收）：server component 攞 session 決定 `isBroker`，
// 交俾 `GuardsClient` 決定頁首 kicker（雞頭「我的」／內部角色「主檔」，
// 跟 `src/lib/rbac/nav.ts` 導航分組）——同 `src/app/(app)/my-receivable/
// page.tsx` 同一個 pattern。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { GuardsClient } from "./GuardsClient";

export default async function GuardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <GuardsClient isBroker={session.baseRole === "雞頭"} />;
}
