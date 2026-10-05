// WP-GUARD-OCR §29（Opus 覆核 Major-A）：預留式配額唔佔長連線——連線池只有 5 條、模型慢 6 秒，
// 同一用戶同時 6 個 OCR 請求都唔會 500，其他 query 唔被拖慢。
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("OCR 配額：連線池壓力", () => {
  let prisma: typeof import("./lib/db").prisma;
  let fx: import("./fixtures/wp2-fixture").Wp2Fixture;
  let cookie: string;
  let userId: string;
  let ocrRoute: typeof import("@/app/api/guards/ocr/read/route").POST;
  let setClient: typeof import("@/lib/guards/ocr/vision-client").setVisionClientForTests;
  const savedUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    // 必須喺任何 Prisma client 建立之前設定連線池
    const u = new URL(process.env.DATABASE_URL!);
    u.searchParams.set("connection_limit", "5");
    u.searchParams.set("pool_timeout", "10");
    process.env.DATABASE_URL = u.toString();
    prisma = (await import("./lib/db")).prisma;
    const { clearAll } = await import("./lib/db");
    const { seedWp2Fixture, sessionCookieForUser } = await import("./fixtures/wp2-fixture");
    await clearAll();
    fx = await seedWp2Fixture();
    const tel = `6${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    userId = (await prisma.user.create({ data: { name: "測試會計池", tel, passwordHash: "x", roleId: fx.roleIds["會計"], createdBy: "t" } })).id;
    cookie = await sessionCookieForUser(userId);
    ocrRoute = (await import("@/app/api/guards/ocr/read/route")).POST;
    setClient = (await import("@/lib/guards/ocr/vision-client")).setVisionClientForTests;
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    setClient(null);
    if (savedUrl) process.env.DATABASE_URL = savedUrl;
  });

  it("connection_limit=5、模型慢 6 秒、同一用戶同時 6 個 OCR：冇 500，其他 query <1 秒", async () => {
    setClient({
      model: "fake-slow",
      async complete() {
        await new Promise((r) => setTimeout(r, 6000));
        return { text: JSON.stringify({ name_zh: "陳大文", name_en: "CHAN TAI MAN", hkid: "A123456(3)", dob: "15-03-1988", sex: "M" }), promptTokens: 1, completionTokens: 1 };
      },
    });
    const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
    const body = JSON.stringify({ documents: [{ type: "id_card", full: IMG, tiles: [IMG] }] });
    const reqs = Array.from({ length: 6 }, () => ocrRoute(new Request("http://t/api/guards/ocr/read", { method: "POST", headers: { "content-type": "application/json", cookie }, body })));
    await new Promise((r) => setTimeout(r, 1500)); // 6 個請求都已過咗預留、而家喺等模型
    const t0 = Date.now();
    await prisma.user.count();
    const probeMs = Date.now() - t0;
    const res = await Promise.all(reqs);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(probeMs).toBeLessThan(1000);
    expect(await prisma.auditLog.count({ where: { actorUserId: userId, action: "guard_quota_reserve" } })).toBe(6);
  }, 40000);
});
