// P6.4 / H10：must_change_pwd=true 嘅 session 只准 change-password／logout／refresh，其餘 API 403 must_change_pwd。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_PASSWORD } from "./fixtures/test-users";
import { GET as sitesGET } from "@/app/api/sites/route";
import { POST as changePwdPOST } from "@/app/api/auth/change-password/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as refreshPOST } from "@/app/api/auth/refresh/route";

describe("P6.4 / H10：must_change_pwd API 層強制", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const get = (url: string) => new Request(url, { headers: { cookie } });

  it("mustChangePwd=false：一般 API 照常", async () => {
    expect((await sitesGET(get("http://test.local/api/sites"))).status).toBe(200);
  });

  it("mustChangePwd=true：一般 API → 403 must_change_pwd", async () => {
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { mustChangePwd: true } });
    const res = await sitesGET(get("http://test.local/api/sites"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("must_change_pwd");
  });

  it("mustChangePwd=true：change-password 照准，改完密碼後 flag 清走、其他 API 回復", async () => {
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { mustChangePwd: true } });
    const res = await changePwdPOST(
      new Request("http://test.local/api/auth/change-password", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ old_password: TEST_USER_PASSWORD, new_password: "BrandNewPwd77" }) }),
    );
    expect(res.status).toBe(200);
    const newCookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } })).mustChangePwd).toBe(false);
    expect((await sitesGET(new Request("http://test.local/api/sites", { headers: { cookie: newCookie } }))).status).toBe(200);
  });

  it("mustChangePwd=true：logout／refresh 唔受影響（唔返 must_change_pwd）", async () => {
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { mustChangePwd: true } });
    const refresh = await refreshPOST(new Request("http://test.local/api/auth/refresh", { method: "POST", headers: { cookie } }));
    expect(refresh.status).not.toBe(403);
    const logout = await logoutPOST(new Request("http://test.local/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(logout.status).not.toBe(403);
  });
});
