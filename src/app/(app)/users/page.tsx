// A2（Opus 驗收）：用戶頁要知道「邊行係我自己」先可以隱藏自己嗰行嘅
// 「重設密碼」掣——改做 server component 直接攞 session（同
// `change-password/page.tsx` 一樣做法，唯讀，冇改 API），將
// `session.userId` 傳落去 client 表格 component。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { UsersPageClient } from "./UsersPageClient";

export default async function UsersPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return <UsersPageClient currentUserId={session.userId} />;
}
