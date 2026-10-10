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
  guardId: string | null; // 保安員登入先有值（P1 唔用，預留）
  payoutApprovalLimit: string | null; // Decimal 轉 string 存，用時再 parse
  tokenVersion: number; // Opus 驗收殘留1：session 作廢——每請求同 DB users.token_version 核對
  loggedInAt: string; // ISO——絕對上限由此起計，續期唔改
  renewedAt?: string; // ISO——最近一次簽發 cookie 時間；舊格式 cookie 冇呢欄（當 loggedInAt）
}

export const SESSION_COOKIE_NAME = "zoikan_session";
export const DEFAULT_SESSION_IDLE_DAYS = 30;
export const DEFAULT_SESSION_ABSOLUTE_DAYS = 90;
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24; // 距上次簽發 ≥24 小時先續期
const DAY = 60 * 60 * 24;

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg); // 唔印值
}

function readIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
}

/** 閒置期限／絕對上限（秒）。env SESSION_IDLE_DAYS（整數 1–90）、
 * SESSION_ABSOLUTE_DAYS（整數，≥ idle 且 ≤180）；非法值用預設並 warn 一次（唔印值）。 */
export function getSessionTtlConfig(): { idleSeconds: number; absoluteSeconds: number; idleDays: number; absoluteDays: number } {
  let idleDays = DEFAULT_SESSION_IDLE_DAYS;
  const i = readIntEnv("SESSION_IDLE_DAYS");
  if (i !== null) {
    if (Number.isInteger(i) && i >= 1 && i <= 90) idleDays = i;
    else warnOnce("idle", "SESSION_IDLE_DAYS 非法（要整數 1–90），改用預設");
  }
  let absoluteDays = Math.max(DEFAULT_SESSION_ABSOLUTE_DAYS, idleDays);
  const a = readIntEnv("SESSION_ABSOLUTE_DAYS");
  if (a !== null) {
    if (Number.isInteger(a) && a >= idleDays && a <= 180) absoluteDays = a;
    else warnOnce("absolute", "SESSION_ABSOLUTE_DAYS 非法（要整數、≥ idle 且 ≤180），改用預設");
  }
  return { idleSeconds: idleDays * DAY, absoluteSeconds: absoluteDays * DAY, idleDays, absoluteDays };
}

/** 測試用：重置「只 warn 一次」狀態 */
export function _resetSessionTtlWarnings(): void {
  warned.clear();
}

/** 距絕對上限仲剩幾多秒（≤0＝已過） */
export function absoluteRemainingSeconds(data: Pick<SessionData, "loggedInAt">, nowMs = Date.now()): number {
  const t = Date.parse(data.loggedInAt);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((t + getSessionTtlConfig().absoluteSeconds * 1000 - nowMs) / 1000);
}

/** 呢個 session 係咪到咗續期時間（renewedAt 缺＝舊格式，即刻續） */
export function needsRenewal(data: SessionData, nowMs = Date.now()): boolean {
  const t = Date.parse(data.renewedAt ?? "");
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= SESSION_RENEW_AFTER_SECONDS * 1000;
}

function sessionPassword(): string {
  const pwd = process.env.SESSION_SECRET;
  if (!pwd || pwd.length < 32) {
    throw new Error(
      "SESSION_SECRET 未設定或長度不足 32 字符——喺 .env 設定一個 ≥32 字符嘅隨機字串（見 .env.example）",
    );
  }
  return pwd;
}

export async function sealSession(data: SessionData, ttlSeconds?: number): Promise<string> {
  const raw = ttlSeconds ?? getSessionTtlConfig().idleSeconds;
  const ttl = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : getSessionTtlConfig().idleSeconds; // 防呆：唔會產生冇到期時間嘅 seal
  return sealData(data, { password: sessionPassword(), ttl });
}

/** unseal＋基本檢查（userId、絕對上限）。seal 過期／篡改／過絕對上限一律 null。
 * 注意：unseal 睇 seal 內嵌嘅到期時間，舊 12 小時 seal 照舊按自己到期。 */
export async function unsealSessionCookie(raw: string): Promise<SessionData | null> {
  try {
    const data = await unsealData<Partial<SessionData>>(raw, { password: sessionPassword(), ttl: getSessionTtlConfig().idleSeconds });
    if (!data.userId) return null;
    if (absoluteRemainingSeconds(data as SessionData) <= 0) return null;
    return data as SessionData;
  } catch {
    return null;
  }
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
  return unsealSessionCookie(raw); // seal 過期/篡改/密碼唔啱/過絕對上限——當未登入處理
}

/** 簽發（登入）或續期 cookie。maxAge＝seal ttl＝min(idle, 距絕對上限剩餘)，
 * 即 cookie 永遠唔會活過絕對上限。冇 renewedAt 時填而家。 */
export async function setSessionCookie(res: NextResponse, data: SessionData): Promise<void> {
  const now = Date.now();
  const ttl = Math.max(1, Math.min(getSessionTtlConfig().idleSeconds, absoluteRemainingSeconds(data, now)));
  const withRenewed: SessionData = { ...data, renewedAt: new Date(now).toISOString() };
  const sealed = await sealSession(withRenewed, ttl);
  res.cookies.set(SESSION_COOKIE_NAME, sealed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ttl,
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
