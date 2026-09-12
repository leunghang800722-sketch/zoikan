// Opus 對抗式驗收殘留3：users 回應白名單——password_hash／otp_secret
// 一律唔出街（連俾有「用戶管理」權限嘅老闆都唔出，otp_secret 係伺服器
// 內部密鑰，唔係「畀有權限嘅人睇」嘅嘢）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as usersList } from "@/app/api/users/route";
import { GET as userGetOne } from "@/app/api/users/[id]/route";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

describe("WP2 殘留3：users 回應剝走 password_hash/otp_secret", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    // 確保呢個用戶嘅 otp_secret 有值（雖然 WP2 唔寫入，但用 raw update 模擬
    // 「萬一將來有值」都要剝走，唔可以淨係靠「而家啱啱好係 null」蒙混過關）。
    await prisma.user.update({ where: { id: fx.userIds["老闆"] }, data: { otpSecret: "should-never-leak-secret" } });
  });

  it("GET /api/users list：password_hash/otp_secret 完全唔存在（唔係得個 null）", async () => {
    const res = await usersList(req("http://test.local/api/users", ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect("password_hash" in row).toBe(false);
      expect("otp_secret" in row).toBe(false);
    }
  });

  it("GET /api/users/:id：password_hash/otp_secret 完全唔存在", async () => {
    const res = await userGetOne(req(`http://test.local/api/users/${fx.userIds["老闆"]}`, ownerCookie), {
      params: Promise.resolve({ id: fx.userIds["老闆"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("password_hash" in body).toBe(false);
    expect("otp_secret" in body).toBe(false);
    // 其他用戶管理欄（failed_attempts/locked_until）留喺度冇問題——呢個
    // route 本身已經要求「用戶管理」權限，唔係公開 endpoint。
    expect("failed_attempts" in body).toBe(true);
    expect("token_version" in body).toBe(true);
  });
});
