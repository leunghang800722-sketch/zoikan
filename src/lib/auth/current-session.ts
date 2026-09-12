// P1-WP3：Server Component／page.tsx 用嘅 session 讀取 helper。
//
// `getSessionFromRequest()`（./session.ts）刻意唔用 `next/headers`
// 嘅 `cookies()`（果個要求喺真正 Next request 生命週期入面，Vitest 直接
// 調用 route handler 就用唔到，WP2 嘅 route handler 保持純函數
// `(Request) => Response` 方便 integration test）。但 App Router 嘅
// page.tsx／layout.tsx（Server Component）冇 `Request` 物件，只有
// `next/headers`——呢個檔案專門畀 UI 頁用，唔喺 route handler／test 用。
//
// 同 `requirePermission.ts` 嘅 `requireSession()` 一樣核對 DB 現時
// `token_version`／`status`（Opus 驗收殘留1——logout/改密碼/改角色/改
// broker/void user 都會 bump，舊 cookie 要當失效），所以呢個 helper 都
// 經 DB 查詢，唔淨係 unseal cookie 就算。
import { cookies } from "next/headers";
import { unsealData } from "iron-session";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, type SessionData } from "./session";
import { ROLE_NAMES, type RoleName } from "@/lib/rbac/matrix";

function sessionPassword(): string {
  const pwd = process.env.SESSION_SECRET;
  if (!pwd || pwd.length < 32) {
    throw new Error("SESSION_SECRET 未設定或長度不足 32 字符——喺 .env 設定一個 ≥32 字符嘅隨機字串");
  }
  return pwd;
}

export interface CurrentSession extends SessionData {
  baseRole: RoleName;
}

/** 喺 Server Component（page.tsx／layout.tsx）讀取已登入用戶；未登入／
 * session 已作廢一律回 null（畫面自己決定 redirect 去 /login，唔喺呢個
 * helper 內部做 redirect，等唔同頁面可以自己決定行為）。 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;

  let data: Partial<SessionData>;
  try {
    data = await unsealData<Partial<SessionData>>(raw, { password: sessionPassword(), ttl: SESSION_TTL_SECONDS });
  } catch {
    return null;
  }
  if (!data.userId || !data.baseRole || !(ROLE_NAMES as readonly string[]).includes(data.baseRole)) return null;

  const user = await prisma.user.findUnique({ where: { id: data.userId }, select: { tokenVersion: true, status: true } });
  if (!user || user.status !== "active" || user.tokenVersion !== data.tokenVersion) return null;

  return data as CurrentSession;
}
