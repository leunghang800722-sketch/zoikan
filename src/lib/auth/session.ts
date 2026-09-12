// Session：iron-session 嘅低層 seal/unseal API（唔用 next/headers 嘅
// cookies()——嗰個依賴 Next server 嘅 request-scoped AsyncLocalStorage，
// 出咗實際 Next 請求生命週期就用唔到，會令 route handler 冇辦法喺 Vitest
// 入面直接調用嚟做 integration test。改用標準 Request/NextResponse 嘅
// cookie API，route handler 就係一個純函數 (Request) => Response，
// production 同 test 行為一致。
import { sealData, unsealData } from "iron-session";
import type { NextResponse } from "next/server";

export interface SessionData {
  userId: string;
  tel: string;
  name: string;
  roleId: string;
  roleName: string; // 顯示名——可以係自訂角色（例：「高級雞頭」）
  baseRole: string; // Opus 驗收殘留2：硬性 deny 矩陣查詢用呢個（複製來源，五個出廠角色=自己個name），唔用 roleName
  brokerId: string | null; // 雞頭登入先有值
  guardId: string | null; // 安員登入先有值（P1 唔用，預留）
  payoutApprovalLimit: string | null; // Decimal 轉 string 存，用時再 parse
  tokenVersion: number; // Opus 驗收殘留1：session 作廢——每請求同 DB users.token_version 核對
  loggedInAt: string; // ISO
}

export const SESSION_COOKIE_NAME = "zoikan_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 小時
const TTL_SECONDS = SESSION_TTL_SECONDS;

function sessionPassword(): string {
  const pwd = process.env.SESSION_SECRET;
  if (!pwd || pwd.length < 32) {
    throw new Error(
      "SESSION_SECRET 未設定或長度不足 32 字符——喺 .env 設定一個 ≥32 字符嘅隨機字串（見 .env.example）",
    );
  }
  return pwd;
}

export async function sealSession(data: SessionData): Promise<string> {
  return sealData(data, { password: sessionPassword(), ttl: TTL_SECONDS });
}

function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export async function getSessionFromRequest(req: Request): Promise<SessionData | null> {
  const raw = readCookieValue(req.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (!raw) return null;
  try {
    const data = await unsealData<Partial<SessionData>>(raw, { password: sessionPassword(), ttl: TTL_SECONDS });
    if (!data.userId) return null;
    return data as SessionData;
  } catch {
    return null; // seal 過期/篡改/密碼唔啱——當未登入處理
  }
}

export async function setSessionCookie(res: NextResponse, data: SessionData): Promise<void> {
  const sealed = await sealSession(data);
  res.cookies.set(SESSION_COOKIE_NAME, sealed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/",
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
}
