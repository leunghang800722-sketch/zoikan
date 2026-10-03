import { getSessionTtlConfig } from "@/lib/auth/session";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic"; // 登入頁顯示嘅日數跟 runtime env

export default function LoginPage() {
  return <LoginClient idleDays={getSessionTtlConfig().idleDays} />;
}
