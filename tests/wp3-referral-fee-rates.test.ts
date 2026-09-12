// P1-WP3（E）：referral_fee_rates（雞頭介紹費率）CRUD——`雞頭` module；
// 雞頭 GET 只見自己、create/update/void 硬性 deny；月鎖以 `month` 判斷；
// partial unique（broker_id, month, site_id null）撞 → 409。同
// tests/wp3-quotas-approval-batch.test.ts 用同一份 wp2-fixture。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listRates, POST as createRate } from "@/app/api/referral-fee-rates/route";
import { GET as getRate, PATCH as patchRate } from "@/app/api/referral-fee-rates/[id]/route";
import { POST as voidRate } from "@/app/api/referral-fee-rates/[id]/void/route";
import { POST as unvoidRate } from "@/app/api/referral-fee-rates/[id]/unvoid/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const MONTH = "2026-08"; // fx.unlockedMonth

describe("P1-WP3（E）：referral_fee_rates", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerACookie: string;
  let brokerBCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    brokerBCookie = await sessionCookieForUser((await prisma.user.findFirstOrThrow({ where: { brokerId: fx.brokerB.id } })).id);
  });

  it("老闆開全盤預設費率（site_id 留空）→ 201", async () => {
    const res = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.broker_id).toBe(fx.brokerA.id);
    expect(body.site_id).toBeNull();
    expect(Number(body.fee_per_shift)).toBe(50);
  });

  it("雞頭自己 create → 403（硬性 deny）", async () => {
    const res = await createRate(req("http://test.local/api/referral-fee-rates", brokerACookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    expect(res.status).toBe(403);
  });

  it("主管 create → 403（雞頭 module 出廠 create=○ off，唔係硬性 deny，但預設都用唔到）", async () => {
    const res = await createRate(req("http://test.local/api/referral-fee-rates", supervisorCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    expect(res.status).toBe(403);
  });

  it("broker_id 唔存在 → 400", async () => {
    const res = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: "00000000-0000-0000-0000-000000000000", month: MONTH, fee_per_shift: 50 }));
    expect(res.status).toBe(400);
  });

  it("同一雞頭同一月兩行 site_id=null（預設費率）→ 第二次 409（partial unique）", async () => {
    const first = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    expect(first.status).toBe(201);
    const dup = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 60 }));
    expect(dup.status).toBe(409);
  });

  it("同一雞頭＋同一盤＋同一月兩行 → 第二次 409（標準 unique）；唔同盤（site_id 唔同）唔撞", async () => {
    const first = await createRate(
      req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, site_id: fx.site.id, month: MONTH, fee_per_shift: 50 }),
    );
    expect(first.status).toBe(201);
    const dup = await createRate(
      req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, site_id: fx.site.id, month: MONTH, fee_per_shift: 55 }),
    );
    expect(dup.status).toBe(409);

    // 唔同 site_id（null vs fx.site.id）唔會撞——一個係全盤預設，一個係指定盤覆蓋。
    const generic = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 45 }));
    expect(generic.status).toBe(201);
  });

  it("雞頭 GET 只見自己嘅費率行", async () => {
    await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerB.id, month: MONTH, fee_per_shift: 70 }));

    const asA = await listRates(req("http://test.local/api/referral-fee-rates", brokerACookie, "GET"));
    const bodyA = await asA.json();
    expect(bodyA.rows.length).toBe(1);
    expect(bodyA.rows[0].broker_id).toBe(fx.brokerA.id);
    expect(Number(bodyA.rows[0].fee_per_shift)).toBe(50);

    const asOwner = await listRates(req("http://test.local/api/referral-fee-rates", ownerCookie, "GET"));
    const bodyOwner = await asOwner.json();
    expect(bodyOwner.rows.length).toBe(2);
  });

  it("雞頭 GET 單一一條唔屬於自己嘅費率行 → 404（scope）", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerB.id, month: MONTH, fee_per_shift: 70 }));
    const { id } = await created.json();
    const res = await getRate(req(`http://test.local/api/referral-fee-rates/${id}`, brokerACookie, "GET"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);

    // 雞頭 B 自己嗰行就見得到
    const resB = await getRate(req(`http://test.local/api/referral-fee-rates/${id}`, brokerBCookie, "GET"), { params: Promise.resolve({ id }) });
    expect(resB.status).toBe(200);
  });

  it("雞頭 GET/自己嗰行見到 fee_per_shift（同 rate_cards 嘅 payout_rate 一致，唔經出街價 field-group gate）", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 88 }));
    const { id } = await created.json();
    const res = await getRate(req(`http://test.local/api/referral-fee-rates/${id}`, brokerACookie, "GET"), { params: Promise.resolve({ id }) });
    const body = await res.json();
    expect(Number(body.fee_per_shift)).toBe(88);
  });

  it("雞頭 PATCH/void 自己嘅費率行 → 403（硬性 deny）", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    const { id } = await created.json();
    const patchRes = await patchRate(req(`http://test.local/api/referral-fee-rates/${id}`, brokerACookie, "PATCH", { fee_per_shift: 99 }), { params: Promise.resolve({ id }) });
    expect(patchRes.status).toBe(403);
    const voidRes = await voidRate(req(`http://test.local/api/referral-fee-rates/${id}/void`, brokerACookie, "POST", { reason: "test" }), { params: Promise.resolve({ id }) });
    expect(voidRes.status).toBe(403);
  });

  it("老闆 PATCH fee_per_shift；void 附原因＋audit；unvoid", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    const { id } = await created.json();

    const patched = await patchRate(req(`http://test.local/api/referral-fee-rates/${id}`, ownerCookie, "PATCH", { fee_per_shift: 65 }), { params: Promise.resolve({ id }) });
    expect(patched.status).toBe(200);
    expect(Number((await patched.json()).fee_per_shift)).toBe(65);

    const voided = await voidRate(req(`http://test.local/api/referral-fee-rates/${id}/void`, ownerCookie, "POST", { reason: "測試作廢" }), { params: Promise.resolve({ id }) });
    expect(voided.status).toBe(200);
    expect((await voided.json()).voided_at).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({ where: { tableName: "referral_fee_rates", rowId: id, action: "void" }, orderBy: { createdAt: "desc" } });
    expect((auditRow!.after as Record<string, unknown>).void_reason).toBe("測試作廢");
    // N1：audit before/after 經 DTO 轉換，真係存到 fee_per_shift（唔係淨係 {id}）。
    expect(Number((auditRow!.after as Record<string, unknown>).fee_per_shift)).toBe(65);

    const unvoided = await unvoidRate(req(`http://test.local/api/referral-fee-rates/${id}/unvoid`, ownerCookie, "POST"), { params: Promise.resolve({ id }) });
    expect(unvoided.status).toBe(200);
    expect((await unvoided.json()).voided_at).toBeNull();
  });

  it("void 冇填 reason → 400", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 50 }));
    const { id } = await created.json();
    const res = await voidRate(req(`http://test.local/api/referral-fee-rates/${id}/void`, ownerCookie, "POST", {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("鎖定月份（2026-06）create → 403 Locked", async () => {
    const res = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: "2026-06", fee_per_shift: 50 }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("month_locked");
  });

  it("鎖定月份 PATCH/void 已存在嘅行 → 403 Locked", async () => {
    // 喺未鎖嘅月開一行，之後鎖定嗰個月先 PATCH/void——月鎖用嗰行本身嘅 month（before.month），唔係 request 帶嘅月。
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: "2026-06", fee_per_shift: 1 }));
    // 上面 2026-06 已經鎖咗，create 本身應該已經俾 Locked 擋（同上一個 test 一致）；呢度直接用 DB 建一行繞過 API create，專測 PATCH/void 嘅月鎖檢查。
    expect(created.status).toBe(403);

    const row = await prisma.referralFeeRate.create({
      data: { brokerId: fx.brokerA.id, month: fx.lockedMonth, feePerShift: 1, createdBy: "test" },
    });
    const patchRes = await patchRate(req(`http://test.local/api/referral-fee-rates/${row.id}`, ownerCookie, "PATCH", { fee_per_shift: 2 }), { params: Promise.resolve({ id: row.id }) });
    expect(patchRes.status).toBe(403);
    const voidRes = await voidRate(req(`http://test.local/api/referral-fee-rates/${row.id}/void`, ownerCookie, "POST", { reason: "x" }), { params: Promise.resolve({ id: row.id }) });
    expect(voidRes.status).toBe(403);
  });

  it("會計冇「出街價:view」→ list/get 見唔到 fee_per_shift（field-group gate，內部角色一致對待）", async () => {
    const created = await createRate(req("http://test.local/api/referral-fee-rates", ownerCookie, "POST", { broker_id: fx.brokerA.id, month: MONTH, fee_per_shift: 77 }));
    const { id } = await created.json();

    // 會計出廠矩陣「出街價」view=grant，所以呢度模擬冇呢個權限嘅情況：
    // 直接關咗會計角色嘅「出街價:view」先再 GET。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "出街價", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["會計"], permissionId: permission.id } },
      data: { granted: false },
    });

    const res = await getRate(req(`http://test.local/api/referral-fee-rates/${id}`, accountantCookie, "GET"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect("fee_per_shift" in body).toBe(false);
    expect(body.broker_id).toBe(fx.brokerA.id);
  });
});
