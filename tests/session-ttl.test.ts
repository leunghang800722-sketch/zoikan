// WP-SESSION-TTL：滑動閒置期限＋絕對上限＋續期（合成資料）
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sealData } from "iron-session";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, TEST_PASSWORD, type Wp2Fixture } from "./fixtures/wp2-fixture";
import {
  getSessionFromRequest,
  getSessionTtlConfig,
  sealSession,
  _resetSessionTtlWarnings,
  SESSION_COOKIE_NAME,
  type SessionData,
} from "@/lib/auth/session";
import { requireSession } from "@/lib/rbac/requirePermission";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as refreshPOST } from "@/app/api/auth/refresh/route";
import { bumpTokenVersion } from "@/lib/auth/token-version";

const DAY = 86400;
const H = 3600;

function maxAge(res: Response): number {
  const m = /Max-Age=(\d+)/i.exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error("冇 Max-Age");
  return Number(m[1]);
}
function cookieOf(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
const req = (url: string, cookie?: string, method = "GET") => new Request(`http://test.local${url}`, { method, headers: cookie ? { cookie } : {} });

describe("WP-SESSION-TTL", () => {
  let fx: Wp2Fixture;
  let ownerTel: string;
  let base: SessionData;

  beforeEach(async () => {
    delete process.env.SESSION_IDLE_DAYS;
    delete process.env.SESSION_ABSOLUTE_DAYS;
    _resetSessionTtlWarnings();
    await clearAll();
    fx = await seedWp2Fixture();
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    ownerTel = owner.tel;
    base = {
      userId: owner.id, tel: owner.tel, name: "測試老闆", roleId: fx.roleIds["老闆"], roleName: "老闆", baseRole: "老闆",
      brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: owner.tokenVersion,
      loggedInAt: new Date().toISOString(),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SESSION_IDLE_DAYS;
    delete process.env.SESSION_ABSOLUTE_DAYS;
  });

  async function login(): Promise<Response> {
    return loginPOST(new Request("http://test.local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify({ tel: ownerTel, password: TEST_PASSWORD }),
    }));
  }

  it("新登入 cookie maxAge＝idle（預設 30 日），帶 renewedAt", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(maxAge(res)).toBe(30 * DAY);
    const s = await getSessionFromRequest(req("/x", cookieOf(res)));
    expect(s?.renewedAt).toBeTruthy();
  });

  it("<24h 唔續期（冇 set-cookie）", async () => {
    const c = cookieOf(await login());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 23 * H * 1000);
    const res = await refreshPOST(req("/api/auth/refresh", c, "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renewed: false });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("≥24h 續期：loggedInAt、tokenVersion 不變，新 maxAge＝idle", async () => {
    const c = cookieOf(await login());
    const orig = (await getSessionFromRequest(req("/x", c)))!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * H * 1000);
    const res = await refreshPOST(req("/api/auth/refresh", c, "POST"));
    expect(await res.json()).toEqual({ renewed: true });
    expect(maxAge(res)).toBe(30 * DAY);
    const renewed = (await getSessionFromRequest(req("/x", cookieOf(res))))!;
    expect(renewed.loggedInAt).toBe(orig.loggedInAt);
    expect(renewed.tokenVersion).toBe(orig.tokenVersion);
    expect(Date.parse(renewed.renewedAt!)).toBeGreaterThan(Date.parse(orig.renewedAt!));
    // 續期後即刻再 refresh 唔會再簽
    const again = await refreshPOST(req("/api/auth/refresh", cookieOf(res), "POST"));
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("冇登入 refresh：401 且無 cookie", async () => {
    const res = await refreshPOST(req("/api/auth/refresh", undefined, "POST"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("過絕對上限：401，唔續期", async () => {
    const c = cookieOf(await login());
    vi.useFakeTimers({ toFake: ["Date"] });
    // 每 20 日續一次，行到 day 91
    let cookie = c;
    for (const d of [20, 40, 60, 80]) {
      vi.setSystemTime(Date.now() + 20 * DAY * 1000);
      const r = await refreshPOST(req("/api/auth/refresh", cookie, "POST"));
      expect(r.status, `day ${d}`).toBe(200);
      cookie = cookieOf(r);
    }
    // day 80：剩 10 日，cookie maxAge 被絕對上限壓住
    vi.setSystemTime(Date.now() + 11 * DAY * 1000); // day 91
    expect(await getSessionFromRequest(req("/x", cookie))).toBeNull();
    await expect(requireSession(req("/x", cookie))).rejects.toMatchObject({ status: 401 });
    const r = await refreshPOST(req("/api/auth/refresh", cookie, "POST"));
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("接近絕對上限時續期嘅 maxAge 被壓到剩餘時間", async () => {
    const loggedInAt = new Date(Date.now() - 85 * DAY * 1000).toISOString();
    const sealed = await sealSession({ ...base, loggedInAt, renewedAt: loggedInAt }, 10 * DAY);
    const r = await refreshPOST(req("/api/auth/refresh", `${SESSION_COOKIE_NAME}=${encodeURIComponent(sealed)}`, "POST"));
    expect(await r.json()).toEqual({ renewed: true });
    expect(maxAge(r)).toBeGreaterThan(4.9 * DAY);
    expect(maxAge(r)).toBeLessThanOrEqual(5 * DAY);
  });

  it("token_version bump 後舊 cookie（包括續期過嘅）401，refresh 唔續", async () => {
    const c = cookieOf(await login());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * H * 1000);
    const renewed = cookieOf(await refreshPOST(req("/api/auth/refresh", c, "POST")));
    await bumpTokenVersion(base.userId);
    await expect(requireSession(req("/x", c))).rejects.toMatchObject({ status: 401 });
    await expect(requireSession(req("/x", renewed))).rejects.toMatchObject({ status: 401 });
    vi.setSystemTime(Date.now() + 25 * H * 1000);
    const r = await refreshPOST(req("/api/auth/refresh", renewed, "POST"));
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("用戶停用後 refresh 唔續", async () => {
    const c = cookieOf(await login());
    await prisma.user.update({ where: { id: base.userId }, data: { status: "inactive" } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * H * 1000);
    const r = await refreshPOST(req("/api/auth/refresh", c, "POST"));
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("舊格式 cookie（冇 renewedAt、12 小時 seal）有效期內照用，並即時續成新期限", async () => {
    const legacy = await sealData(base, { password: process.env.SESSION_SECRET!, ttl: 12 * H });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(legacy)}`;
    const s = await getSessionFromRequest(req("/x", cookie));
    expect(s?.userId).toBe(base.userId);
    expect(s?.renewedAt).toBeUndefined();
    await expect(requireSession(req("/x", cookie))).resolves.toBeTruthy();
    const r = await refreshPOST(req("/api/auth/refresh", cookie, "POST"));
    expect(await r.json()).toEqual({ renewed: true });
    expect(maxAge(r)).toBe(30 * DAY);
    // 舊 seal 過咗 12 小時（無續期）照舊失效
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 13 * H * 1000);
    expect(await getSessionFromRequest(req("/x", cookie))).toBeNull();
  });

  it("sealSession 預設 ttl＝idle：29 日仍有效，31 日失效", async () => {
    const sealed = await sealSession({ ...base, renewedAt: base.loggedInAt });
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sealed)}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 29 * DAY * 1000);
    expect(await getSessionFromRequest(req("/x", cookie))).not.toBeNull();
    vi.setSystemTime(Date.now() + 2 * DAY * 1000);
    expect(await getSessionFromRequest(req("/x", cookie))).toBeNull();
  });

  describe("env 覆蓋", () => {
    it("合法值生效", () => {
      process.env.SESSION_IDLE_DAYS = "7";
      process.env.SESSION_ABSOLUTE_DAYS = "14";
      const c = getSessionTtlConfig();
      expect(c.idleSeconds).toBe(7 * DAY);
      expect(c.absoluteSeconds).toBe(14 * DAY);
    });
    it("非法值用預設，warn 一次且唔印值", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.SESSION_IDLE_DAYS = "999";
      process.env.SESSION_ABSOLUTE_DAYS = "abc";
      for (let i = 0; i < 3; i++) {
        const c = getSessionTtlConfig();
        expect(c.idleDays).toBe(30);
        expect(c.absoluteDays).toBe(90);
      }
      expect(warn).toHaveBeenCalledTimes(2);
      for (const call of warn.mock.calls) expect(String(call[0])).not.toMatch(/999|abc/);
    });
    it("absolute < idle 或 >180 非法", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.SESSION_IDLE_DAYS = "60";
      process.env.SESSION_ABSOLUTE_DAYS = "30";
      expect(getSessionTtlConfig().absoluteDays).toBe(90);
      _resetSessionTtlWarnings();
      process.env.SESSION_ABSOLUTE_DAYS = "181";
      expect(getSessionTtlConfig().absoluteDays).toBe(90);
    });
  });
});
