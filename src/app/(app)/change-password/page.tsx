// P2-C：改密碼頁（README §20）——頂資訊橫幅（藍）「首次登入請先設定新
// 密碼。」只喺 `session.mustChangePwd` 為 true 先顯示；呢個 flag 之前
// 淨係 `(app)/layout.tsx` 讀去驅動 `MustChangePwdGate`（跳轉用），呢頁
// 本身冇讀過。改做 server component 直接攞 session（同首頁 `page.tsx`
// 一樣做法，唯讀，冇改 API），再傳落去 client 表單 component。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function ChangePasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  // P7.1：內部角色（老闆／主管／會計）可以設通知電郵；首次強制改密碼期間 API 擋住其他 endpoint，所以暫時唔顯示。
  const internal = session.baseRole === "老闆" || session.baseRole === "主管" || session.baseRole === "會計";
  return <ChangePasswordForm mustChangePwd={session.mustChangePwd} notifyUserId={internal && !session.mustChangePwd ? session.userId : undefined} />;
}
