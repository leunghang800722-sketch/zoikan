// Opus 對抗式驗收殘留1：session 作廢——users.token_version，logout／改
// 密碼／改角色／改broker／void user 全部 bump；每請求核 version（一次
// DB 查，見 requireSession()）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { requireSession } from "@/lib/rbac/requirePermission";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { PATCH as userUpdate } from "@/app/api/users/[id]/route";
import { POST as userVoid } from "@/app/api/users/[id]/void/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 殘留1：session 作廢（token_version）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("登出後舊 cookie 401（唔止清 cookie，DB token_version 都 bump 咗）", async () => {
    // 登出之前：舊 cookie 用得
    const before = await requireSession(req("http://test.local/x", ownerCookie));
    expect(before.userId).toBe(fx.userIds["老闆"]);

    const logoutRes = await logoutPOST(req("http://test.local/api/auth/logout", ownerCookie, "POST"));
    expect(logoutRes.status).toBe(200);

    // 登出之後：即使攞返同一份（未過期嘅）舊 cookie 再用都要 401
    await expect(requireSession(req("http://test.local/x", ownerCookie))).rejects.toMatchObject({ status: 401 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    expect(user.tokenVersion).toBeGreaterThan(1);
  });

  it("void user 之後舊 cookie 401", async () => {
    const targetCookie = await sessionCookieForUser(fx.userIds["主管"]);
    await requireSession(req("http://test.local/x", targetCookie)); // 未 void 之前用得

    const voidRes = await userVoid(req(`http://test.local/api/users/${fx.userIds["主管"]}`, ownerCookie, "POST", { reason: "測試停用" }), {
      params: Promise.resolve({ id: fx.userIds["主管"] }),
    });
    expect(voidRes.status).toBe(200);

    await expect(requireSession(req("http://test.local/x", targetCookie))).rejects.toMatchObject({ status: 401 });
  });

  it("改角色（role_id）之後舊 cookie 401", async () => {
    const targetUserId = fx.userIds["會計"];
    const targetCookie = await sessionCookieForUser(targetUserId);
    await requireSession(req("http://test.local/x", targetCookie));

    const res = await userUpdate(
      req(`http://test.local/api/users/${targetUserId}`, ownerCookie, "PATCH", { role_id: fx.roleIds["主管"] }),
      { params: Promise.resolve({ id: targetUserId }) },
    );
    expect(res.status).toBe(200);

    await expect(requireSession(req("http://test.local/x", targetCookie))).rejects.toMatchObject({ status: 401 });
  });

  it("改 broker_id 之後舊 cookie 401", async () => {
    const targetUserId = fx.userIds["雞頭"]; // 掛緊 brokerA
    const targetCookie = await sessionCookieForUser(targetUserId);
    await requireSession(req("http://test.local/x", targetCookie));

    const res = await userUpdate(
      req(`http://test.local/api/users/${targetUserId}`, ownerCookie, "PATCH", { broker_id: fx.brokerB.id }),
      { params: Promise.resolve({ id: targetUserId }) },
    );
    expect(res.status).toBe(200);

    await expect(requireSession(req("http://test.local/x", targetCookie))).rejects.toMatchObject({ status: 401 });
  });

  it("改密碼之後：當前 request 重新 issue 嘅 cookie 用得（唔踢自己），但舊 cookie 唔用得", async () => {
    // 登入攞返一個「真正經 /api/auth/login」嘅 cookie（sessionCookieForUser
    // 係直接 seal，冇經 login route；呢度想測 change-password 之後
    // response 新 cookie 嘅行為，所以用返 login 拎一個起始 cookie）。
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds["老闆"] } });
    const loginRes = await loginPOST(
      new Request("http://test.local/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tel: owner.tel, password: "Fixture0Pwd" }),
      }),
    );
    const oldCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const { POST: changePasswordPOST } = await import("@/app/api/auth/change-password/route");
    const changeRes = await changePasswordPOST(
      req("http://test.local/api/auth/change-password", oldCookie, "POST", { old_password: "Fixture0Pwd", new_password: "NewStrongPwd9" }),
    );
    expect(changeRes.status).toBe(200);
    const newCookie = changeRes.headers.get("set-cookie")!.split(";")[0]!;

    // 舊 cookie（改密碼之前個 seal）唔用得
    await expect(requireSession(req("http://test.local/x", oldCookie))).rejects.toMatchObject({ status: 401 });
    // response 帶返嘅新 cookie 用得（冇即刻踢走緊用緊嗰個 session）
    const s = await requireSession(req("http://test.local/x", newCookie));
    expect(s.userId).toBe(fx.userIds["老闆"]);
  });
});
