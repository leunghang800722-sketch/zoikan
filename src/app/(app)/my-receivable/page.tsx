// P2-B：本月應收（README §11）——雞頭專用頁，但老闆／會計／主管（有
// 「出街價:view」）可以帶 ?broker= 預覽（見
// src/app/api/reports/my-receivable/route.ts 註解）。呢度跟
// ShortfallDashboard.tsx／BrokerDashboard.tsx 同一個 pattern：server
// component 攞 session 決定 `isBroker`／`roleLabel`，交俾 client
// component 做互動。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { uiLabel } from "@/lib/ui/format";
import { MyReceivableClient } from "./MyReceivableClient";

export default async function MyReceivablePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <MyReceivableClient isBroker={session.baseRole === "雞頭"} roleLabel={uiLabel(session.roleName)} />;
}
