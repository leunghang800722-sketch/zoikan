// P10.1：頂位津貼價目表——lookupRate（生效價、母盤 fallback、effective_to）、API 權限（老闆改／會計睇／雞頭 403）、
// 鎖月擋（新增／改額／作廢）、重複 409、作廢後同日可復用、audit、改價＝新增一行（舊價保留）。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { sessionCookieForUser } from "./fixtures/wp2-fixture";
import { lookupRate, loadActiveRates } from "@/lib/longterm-payroll/cover-rates";
import { GET as listRoute, POST as createRoute } from "@/app/api/longterm/cover-rates/route";
import { PATCH as patchRoute } from "@/app/api/longterm/cover-rates/[id]/route";
import { p10Base, D } from "./p10-helpers";

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

const r = (id: string, siteId: string, grade: string, amount: number, from: string, to: string | null = null) => ({ id, siteId, grade, amount, effectiveFrom: from, effectiveTo: to });

describe("lookupRate", () => {
  const rates = [r("1", "s", "兵", 100, "2026-01-01"), r("2", "s", "兵", 120, "2026-09-01"), r("3", "s", "IC", 200, "2026-01-01", "2026-06-30"), r("4", "parent", "兵", 90, "2026-01-01")];
  it("取 effectiveFrom<=日期 最大者；舊日期用舊價", () => {
    expect(lookupRate(rates, "s", null, "兵", "2026-08-31")!.amount).toBe(100);
    expect(lookupRate(rates, "s", null, "兵", "2026-09-01")!.amount).toBe(120);
    expect(lookupRate(rates, "s", null, "兵", "2025-12-31")).toBeNull();
  });
  it("effective_to 過咗＝冇價；母盤 fallback；另一職級唔串", () => {
    expect(lookupRate(rates, "s", null, "IC", "2026-07-01")).toBeNull();
    expect(lookupRate(rates, "s", null, "IC", "2026-06-30")!.amount).toBe(200);
    expect(lookupRate(rates, "child", "parent", "兵", "2026-08-01")!.amount).toBe(90);
    expect(lookupRate(rates, "child", "parent", "IC", "2026-08-01")).toBeNull();
  });
});

describe("cover-rates API", () => {
  it("權限：老闆新增／改額／作廢；會計只可睇（寫 403）；雞頭 403；改價＝新增一行舊價保留", async () => {
    const b = await p10Base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const broker = await sessionCookieForUser(b.fx.userIds["雞頭"]);
    const post = (cookie: string, body: unknown) => createRoute(new Request("http://x/api/longterm/cover-rates", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const patch = (cookie: string, id: string, body: unknown) => patchRoute(new Request(`http://x/api/longterm/cover-rates/${id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    const list = (cookie: string, q = "") => listRoute(new Request(`http://x/api/longterm/cover-rates${q}`, { headers: { cookie } }));
    const body = { site_id: b.sites.B.id, grade: "兵", amount: 200, effective_from: "2026-10-01" };

    expect((await post(acct, body)).status).toBe(403);
    expect((await post(broker, body)).status).toBe(403);
    const created = await post(owner, body);
    expect(created.status).toBe(201);
    const row = await created.json();
    expect(Number(row.amount)).toBe(200);
    expect((await post(owner, body)).status).toBe(409); // 同盤同職級同生效日
    // 改價：新生效日新增一行
    expect((await post(owner, { ...body, amount: 250, effective_from: "2026-11-01" })).status).toBe(201);
    const l = await (await list(acct)).json();
    expect(l.rows).toHaveLength(2);
    expect(l.rows[0].site_name).toBe(b.sites.B.name);
    expect((await list(broker)).status).toBe(403);
    // 驗證：IC／兵 以外、金額 <=0
    expect((await post(owner, { ...body, grade: "SIC", effective_from: "2026-12-01" })).status).toBe(400);
    expect((await post(owner, { ...body, amount: 0, effective_from: "2026-12-01" })).status).toBe(400);
    expect((await post(owner, { ...body, site_id: "00000000-0000-0000-0000-000000000000", effective_from: "2026-12-01" })).status).toBe(400);
    // 改額／作廢
    expect((await patch(acct, row.id, { amount: 300 })).status).toBe(403);
    expect(Number((await (await patch(owner, row.id, { amount: 210 })).json()).amount)).toBe(210);
    expect((await patch(owner, row.id, {})).status).toBe(400);
    expect((await patch(owner, row.id, { void: true })).status).toBe(200);
    expect((await patch(owner, row.id, { amount: 1 })).status).toBe(409); // 已作廢
    expect((await (await list(owner)).json()).rows).toHaveLength(1);
    expect((await (await list(owner, "?include_voided=1")).json()).rows).toHaveLength(2);
    // 作廢後同日可復用
    const again = await post(owner, body);
    expect(again.status).toBe(201);
    expect((await again.json()).id).toBe(row.id);
    expect(await prisma.coverShiftRate.count()).toBe(2);
    // audit
    expect(await prisma.auditLog.count({ where: { tableName: "cover_shift_rates", action: "create" } })).toBeGreaterThanOrEqual(2);
    const voidAudit = await prisma.auditLog.findFirst({ where: { tableName: "cover_shift_rates", action: "void", rowId: row.id } });
    expect((voidAudit?.before as { amount?: unknown })?.amount).toBeDefined();
    const loaded = await loadActiveRates();
    expect(loaded.map((x) => x.amount).sort()).toEqual([200, 250]);
  });

  it("鎖月：生效區間覆蓋已鎖月份唔准新增／改額／作廢（含遠期生效日撞鎖月）", async () => {
    const b = await p10Base();
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const post = (body: unknown) => createRoute(new Request("http://x/api/longterm/cover-rates", { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const patch = (id: string, body: unknown) => patchRoute(new Request(`http://x/api/longterm/cover-rates/${id}`, { method: "PATCH", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    await prisma.monthClose.create({ data: { month: D(8, 1), lockedAt: new Date(), lockedBy: b.actorUserId } });
    const base = { site_id: b.sites.B.id, grade: "兵", amount: 200 };
    expect((await post({ ...base, effective_from: "2026-08-15" })).status).toBe(403);
    expect((await post({ ...base, effective_from: "2026-07-01", effective_to: "2026-08-31" })).status).toBe(403);
    expect(await prisma.coverShiftRate.count()).toBe(0);
    // 先建一行覆蓋將來鎖月：2026-12 → 鎖咗 12 月後，改額／作廢要擋；新增 12 月生效日亦擋
    const ok = await (await post({ ...base, effective_from: "2026-12-01" })).json();
    await prisma.monthClose.create({ data: { month: D(12, 1), lockedAt: new Date(), lockedBy: b.actorUserId } });
    expect((await patch(ok.id, { amount: 999 })).status).toBe(403);
    expect((await patch(ok.id, { void: true })).status).toBe(403);
    expect((await post({ ...base, grade: "IC", effective_from: "2026-12-01" })).status).toBe(403);
    expect(Number((await prisma.coverShiftRate.findUniqueOrThrow({ where: { id: ok.id } })).amount)).toBe(200);
    expect((await post({ ...base, effective_from: "2027-01-01" })).status).toBe(201); // 未鎖月份照寫
  });
});
