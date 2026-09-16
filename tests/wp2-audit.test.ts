// P1-WP2 §D audit test：每次寫入 exactly one audit row；改 rate_card 冇
// audit → test fail（呢個檔案就係確保佢唔會 fail）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as rateCardCreate } from "@/app/api/rate-cards/route";
import { PATCH as rateCardUpdate } from "@/app/api/rate-cards/[id]/route";
import { POST as rateCardVoid } from "@/app/api/rate-cards/[id]/void/route";
import { POST as guardVoid } from "@/app/api/guards/[id]/void/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("WP2 audit_log middleware", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("新增 rate_card 寫 exactly 1 條 audit_log(action=create, table=rate_cards)", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "rate_cards", action: "create" } });
    const res = await rateCardCreate(
      req("http://test.local/api/rate-cards", ownerCookie, "POST", {
        site_id: fx.site.id,
        effective_from: "2026-08-01",
        billing_model: "per_shift",
        client_rate: 1000,
        guard_wage: 700,
        broker_fee: 60,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const after = await prisma.auditLog.count({ where: { tableName: "rate_cards", action: "create" } });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({ where: { tableName: "rate_cards", rowId: body.id, action: "create" } });
    expect(row?.actorUserId).toBe(fx.userIds["老闆"]);
    expect(row?.after).toBeTruthy();
  });

  it("改 rate_card（含 client_rate）強制留痕：exactly 1 條 audit_log(action=update)，before/after 都有齊", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "rate_cards", action: "update" } });
    const res = await rateCardUpdate(
      req(`http://test.local/api/rate-cards/${fx.rateCardGeneric.id}`, ownerCookie, "PATCH", { client_rate: 1200 }),
      { params: Promise.resolve({ id: fx.rateCardGeneric.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.auditLog.count({ where: { tableName: "rate_cards", action: "update" } });
    expect(after).toBe(before + 1); // 冇 audit 呢個 assertion 就會 fail

    const row = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "rate_cards", rowId: fx.rateCardGeneric.id, action: "update" } });
    // N1(a)（Opus 對抗式驗收第三輪）：writeAudit() 而家自動經
    // table_name → DTO 對照表（src/lib/api/audit-dto.ts）先存，DTO 出嚟
    // 嘅 key 一律 snake_case（同 API wire format 一致），唔再係原始
    // Prisma camelCase row。
    expect((row.before as { client_rate: string }).client_rate).toBe("999");
    expect((row.after as { client_rate: string }).client_rate).toBe("1200");
  });

  it("void rate_card：exactly 1 條 audit_log(action=void)，原因留喺 after.void_reason", async () => {
    const res = await rateCardVoid(req(`http://test.local/api/rate-cards/${fx.rateCardGeneric.id}`, ownerCookie, "POST", { reason: "打錯價" }), {
      params: Promise.resolve({ id: fx.rateCardGeneric.id }),
    });
    expect(res.status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "rate_cards", rowId: fx.rateCardGeneric.id, action: "void" } });
    expect((row.after as { void_reason: string }).void_reason).toBe("打錯價");

    const count = await prisma.auditLog.count({ where: { tableName: "rate_cards", rowId: fx.rateCardGeneric.id, action: "void" } });
    expect(count).toBe(1);
  });

  it("作廢冇填原因：400，唔會有 void audit row", async () => {
    const before = await prisma.auditLog.count({ where: { tableName: "guards", action: "void" } });
    const res = await guardVoid(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "POST", {}), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
    const after = await prisma.auditLog.count({ where: { tableName: "guards", action: "void" } });
    expect(after).toBe(before);
  });
});
