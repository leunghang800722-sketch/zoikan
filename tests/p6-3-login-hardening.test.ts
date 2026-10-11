// P6.3（H8）：登入原子計數、按 IP 限速、鎖定／未註冊／密碼錯統一 401。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL, TEST_USER_PASSWORD } from "./fixtures/test-users";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { resetLoginRateLimit, checkLoginAllowed, recordLoginFailure } from "@/lib/auth/login-rate-limit";

function loginReq(tel: string, password: string, ip?: string) {
  return new Request("http://test.local/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify({ tel, password }),
  });
}

describe("P6.3：登入保護", () => {
  let fx: Wp2Fixture;
  let ownerTel: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerTel = TEST_USER_TEL["老闆"];
    resetLoginRateLimit();
  });

  it("並發 20 個錯密碼請求：全部 401；只有 ≤5 個真係被驗（其餘冇驗密碼），帳號鎖定", async () => {
    const since = new Date(Date.now() - 1000);
    const results = await Promise.all(Array.from({ length: 20 }, () => loginPOST(loginReq(ownerTel, "wrong-password-x"))));
    expect(results.every((r) => r.status === 401)).toBe(true);
    // 真係被驗過密碼嘅請求 = 有預留到序號 1..5（audit after.attempts ≤ 5 且冇 over_attempt_quota／鎖定中標記）
    const audits = await prisma.auditLog.findMany({ where: { actorUserId: fx.userIds["老闆"], action: { in: ["login_failed", "login_locked"] }, createdAt: { gte: since } } });
    const verified = audits.filter((a) => {
      const after = a.after as { attempts?: number; reason?: string } | null;
      return typeof after?.attempts === "number" && after.attempts <= 5 && !after.reason;
    }).length;
    expect(verified).toBeLessThanOrEqual(5);
    expect(verified).toBeGreaterThan(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    expect(user.lockedUntil).not.toBeNull();
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // 鎖定後，連正確密碼都 401
    const after = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD));
    expect(after.status).toBe(401);
  });

  it("未註冊電話／密碼錯／已鎖定：status 同 body 完全一致（401「電話或密碼錯誤」）", async () => {
    const unknown = await loginPOST(loginReq("99999999", "whatever-pw1"));
    const wrong = await loginPOST(loginReq(ownerTel, "wrong-password-x"));
    for (let i = 0; i < 5; i++) await loginPOST(loginReq(ownerTel, "wrong-password-x"));
    const locked = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD));
    const bodies = await Promise.all([unknown, wrong, locked].map(async (r) => ({ status: r.status, body: await r.json() })));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ status: 401, body: { error: "invalid_credentials", message: "電話或密碼錯誤" } });
    // 鎖定狀態只記 audit
    expect(await prisma.auditLog.count({ where: { actorUserId: fx.userIds["老闆"], action: "login_locked" } })).toBeGreaterThan(0);
  });

  it("成功登入 reset 失敗計數", async () => {
    await loginPOST(loginReq(ownerTel, "wrong-password-x"));
    await loginPOST(loginReq(ownerTel, "wrong-password-x"));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } })).failedAttempts).toBe(2);
    const ok = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD));
    expect(ok.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } })).failedAttempts).toBe(0);
  });

  it("按 IP 限速：同一 IP 失敗 10 次後第 11 個請求 429＋Retry-After（連正確密碼都唔驗）；其他 IP 唔受影響", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await loginPOST(loginReq(`9000000${i}`, "whatever-pw1", "203.0.113.7")); // 未註冊電話，唔觸發帳號鎖
      expect(r.status).toBe(401);
    }
    const blocked = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD, "203.0.113.7"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("too_many_requests");
    const other = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD, "203.0.113.8"));
    expect(other.status).toBe(200);
  });

  it("成功登入唔扣 IP token（同一 IP 連續登入 15 次都得）", async () => {
    for (let i = 0; i < 15; i++) {
      const r = await loginPOST(loginReq(ownerTel, TEST_USER_PASSWORD, "198.51.100.1"));
      expect(r.status).toBe(200);
    }
  });

  it("token bucket 隨時間補充；全局上限", () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) recordLoginFailure("1.1.1.1", t0);
    expect(checkLoginAllowed("1.1.1.1", t0).ok).toBe(false);
    expect(checkLoginAllowed("1.1.1.1", t0 + 6_100).ok).toBe(true); // 每分鐘 10 個 → 6 秒補 1 個
    resetLoginRateLimit();
    let denied = 0;
    for (let i = 0; i < 400; i++) if (!checkLoginAllowed(null, t0).ok) denied++;
    expect(denied).toBeGreaterThan(0);
  });
});
