// P3-3：server wrapper——傳 `isBoss`（強制鎖定淨係老闆；API 一樣只准 baseRole 老闆）落 client 頁。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import MonthCloseClient from "./MonthCloseClient";

export default async function MonthClosePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <MonthCloseClient isBoss={session.baseRole === "老闆"} />;
}
