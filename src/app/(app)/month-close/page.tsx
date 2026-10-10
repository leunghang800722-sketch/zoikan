// P3-3：server wrapper——傳 `isBoss`（強制鎖定淨係老闆；API 一樣只准 baseRole 老闆）落 client 頁。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import MonthCloseClient from "./MonthCloseClient";

export default async function MonthClosePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  // 解鎖要「月結鎖定解鎖:void」（同 lock／unlock API 一樣）——冇權就唔出解鎖輸入。
  const canUnlock = await hasPermission(session as unknown as AuthedSession, "月結鎖定解鎖", "void");
  return <MonthCloseClient isBoss={session.baseRole === "老闆"} canUnlock={canUnlock} />;
}
