// P1-WP2 §D 認證測試：錯密碼鎖定、弱密碼拒、session 過期、login/logout/
// change-password 全流程（經真正 route handler，唔 mock）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, TEST_PASSWORD, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { getSessionFromRequest, sealSession, SESSION_COOKIE_NAME, getSessionTtlConfig } from "@/lib/auth/session";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as changePasswordPOST } from "@/app/api/auth/change-password/route";

function loginRequest(tel: string, password: string) {
  return new Request("http://test.local/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
    body: JSON.stringify({ tel, password }),
  });
}

function extractSetCookie(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("冇 set-cookie header");
  return raw.split(";")[0]!; // "zoikan_session=xxx"
}

describe("WP2 認證", () => {
  let fx: Wp2Fixture;
  let ownerTel: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    ownerTel = owner.tel;
  });

  it("電話+密碼登入成功會設 HTTP-only session cookie，並寫 audit action=login", async () => {
    const res = await loginPOST(loginRequest(ownerTel, TEST_PASSWORD));
    expect(res.status).toBe(200);
    const cookie = extractSetCookie(res);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");

    const req2 = new Request("http://test.local/x", { headers: { cookie } });
    const session = await getSessionFromRequest(req2);
    expect(session?.roleName).toBe("老闆");
    expect(session?.tel).toBe(ownerTel);

    const audit = await prisma.auditLog.findFirst({ where: { action: "login", actorUserId: fx.userIds["老闆"] } });
    expect(audit).toBeTruthy();
    expect(audit?.ip).toBe("10.0.0.1");
  });

  it("密碼錯回 401，唔設 cookie", async () => {
    const res = await loginPOST(loginRequest(ownerTel, "wrong-password"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("連續 5 次密碼錯會鎖定帳號 15 分鐘（423），鎖定期內即使密碼啱都拒", async () => {
    for (let i = 0; i < 5; i++) {
      await loginPOST(loginRequest(ownerTel, "wrong-password"));
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    expect(user.lockedUntil).toBeTruthy();

    const res = await loginPOST(loginRequest(ownerTel, TEST_PASSWORD));
    expect(res.status).toBe(423);

    const lockedAudit = await prisma.auditLog.findFirst({ where: { action: "login_locked", actorUserId: fx.userIds["老闆"] } });
    expect(lockedAudit).toBeTruthy();
  });

  it("改密碼——管理角色（老闆/主管/會計）強制強密碼", async () => {
    const loginRes = await loginPOST(loginRequest(ownerTel, TEST_PASSWORD));
    const cookie = extractSetCookie(loginRes);

    const weakReq = new Request("http://test.local/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ old_password: TEST_PASSWORD, new_password: "abc" }),
    });
    const weakRes = await changePasswordPOST(weakReq);
    expect(weakRes.status).toBe(400);

    const strongReq = new Request("http://test.local/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ old_password: TEST_PASSWORD, new_password: "NewStrongPwd9" }),
    });
    const strongRes = await changePasswordPOST(strongReq);
    expect(strongRes.status).toBe(200);

    // 新密碼可以登入
    const reLogin = await loginPOST(loginRequest(ownerTel, "NewStrongPwd9"));
    expect(reLogin.status).toBe(200);
  });

  it("雞頭角色改密碼唔強制強密碼規則（只要求最少 6 字符）", async () => {
    const brokerUser = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["雞頭"] } });
    const loginRes = await loginPOST(loginRequest(brokerUser.tel, TEST_PASSWORD));
    const cookie = extractSetCookie(loginRes);
    const req = new Request("http://test.local/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ old_password: TEST_PASSWORD, new_password: "abcdef" }),
    });
    const res = await changePasswordPOST(req);
    expect(res.status).toBe(200);
  });

  it("logout 清 cookie 並寫 audit action=logout", async () => {
    const loginRes = await loginPOST(loginRequest(ownerTel, TEST_PASSWORD));
    const cookie = extractSetCookie(loginRes);
    const res = await logoutPOST(new Request("http://test.local/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

    const audit = await prisma.auditLog.findFirst({ where: { action: "logout", actorUserId: fx.userIds["老闆"] } });
    expect(audit).toBeTruthy();
  });

  it("session 過期（閒置 TTL）：過咗期嘅 cookie 當未登入處理", async () => {
    // iron-session 內置 60 秒 clock-skew 容忍度（unsealData 對「Expired
    // seal」呢類錯誤本身就唔拋錯，靜靜咁回一個冇 userId 嘅空物件——設計
    // 原意係「過期＝當冇 session」，唔係拋錯）。src/lib/auth/session.ts
    // 嘅 getSessionFromRequest() 就係靠呢個行為（見 `!data.userId` 個
    // check）判斷「session 過期／未登入」，呢度用 vi.setSystemTime 跳到
    // TTL 之後嚟驗證呢個判斷實際生效，唔使真係等 12 個鐘。
    const sealed = await sealSession({
      userId: fx.userIds["老闆"],
      tel: ownerTel,
      name: "測試老闆",
      roleId: fx.roleIds["老闆"],
      roleName: "老闆",
      baseRole: "老闆",
      brokerId: null,
      guardId: null,
      payoutApprovalLimit: null,
      tokenVersion: 1,
      loggedInAt: new Date().toISOString(),
    });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sealed)}`;

    // 未過期之前讀得到
    const stillValid = await getSessionFromRequest(new Request("http://test.local/x", { headers: { cookie } }));
    expect(stillValid?.userId).toBe(fx.userIds["老闆"]);

    const realNow = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(realNow + (getSessionTtlConfig().idleSeconds + 61) * 1000); // TTL + clock-skew + buffer
      const expired = await getSessionFromRequest(new Request("http://test.local/x", { headers: { cookie } }));
      expect(expired).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
