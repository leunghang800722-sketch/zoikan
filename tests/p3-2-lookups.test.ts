// P3-2.4：輕量 guards（?fields=lite）、daily-requirements 日期範圍、前端 lookup cache。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { GET as guardsGet } from "@/app/api/guards/route";
import { GET as dailyGet } from "@/app/api/daily-requirements/route";
import { cachedLookup, invalidateLookups, isLookupWritePath, setLookupScope, LOOKUP_TTL_MS } from "@/lib/ui/lookup-cache";
import { cachedGetAll, cachedRows } from "@/lib/ui/lookups";

const req = (url: string, cookie: string) => new Request(url, { headers: { cookie } });

describe("P3-2.4 GET /api/guards?fields=lite", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hkid: "A1234567", tel: "61234567", bankName: "BANK", bankAccountNo: "123456789", monthlySalary: 17000, address: "ADDR", dateOfBirth: new Date("1980-01-01") } });
  });

  for (const role of ["老闆", "主管", "會計"] as const) {
    it(`${role}：只回 lite 欄位，唔帶電話／證件／銀行／月薪／地址／出生日期`, async () => {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      const res = await guardsGet(req("http://t/api/guards?fields=lite&include_inactive=1", cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows.length).toBeGreaterThan(0);
      const allowed = new Set(["id", "staff_no", "name_zh", "name_en", "status", "default_broker_id", "default_broker_code", "sia_permit_expiry", "staff_numbers"]);
      for (const r of body.rows) for (const k of Object.keys(r)) expect(allowed.has(k), `unexpected key ${k}`).toBe(true);
      const txt = JSON.stringify(body);
      for (const needle of ["A1234567", "61234567", "BANK", "123456789", "ADDR", "1980-01-01", "17000"]) expect(txt).not.toContain(needle);
      const g = body.rows.find((r: { id: string }) => r.id === fx.guardA.id);
      expect(g.name_zh).toBeTruthy();
      expect(g.default_broker_code).toBe((await prisma.broker.findUniqueOrThrow({ where: { id: g.default_broker_id } })).code);
    });
  }

  it("雞頭 session 照舊隔離（只見自己嘅保安員）且唔帶 PII", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const res = await guardsGet(req("http://t/api/guards?fields=lite", cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.guardA.id);
    expect(ids).not.toContain(fx.guardB.id);
    expect(JSON.stringify(body)).not.toContain("A1234567");
  });

  it("冇 fields 參數：舊 shape 不變（仍帶 tel 等）", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const body = await (await guardsGet(req("http://t/api/guards", cookie))).json();
    expect("tel" in body.rows[0]).toBe(true);
    expect("employment_type" in body.rows[0]).toBe(true);
  });

  it("lite 回應 bytes 遠細過完整列表", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const full = JSON.stringify(await (await guardsGet(req("http://t/api/guards", cookie))).json()).length;
    const lite = JSON.stringify(await (await guardsGet(req("http://t/api/guards?fields=lite", cookie))).json()).length;
    expect(lite).toBeLessThan(full * 0.6);
  });
});

describe("P3-2.4 daily-requirements 日期範圍", () => {
  it("work_date_from／to 只回範圍內；唔帶參數＝全部（舊行為）", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    await prisma.dailyRequirement.create({ data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, workDate: new Date(Date.UTC(2026, 8, 3)), headcountRequired: 2, createdBy: "t" } });
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const all = await (await dailyGet(req(`http://t/api/daily-requirements?site_id=${fx.site.id}`, cookie))).json();
    const aug = await (await dailyGet(req(`http://t/api/daily-requirements?site_id=${fx.site.id}&work_date_from=2026-08-01&work_date_to=2026-08-31`, cookie))).json();
    expect(all.rows.length).toBe(aug.rows.length + 1);
    for (const r of aug.rows) expect(r.work_date.slice(0, 7)).toBe("2026-08");
  });
});

describe("P3-2.4 前端 lookup cache", () => {
  beforeEach(() => invalidateLookups());

  it("同 key 60 s 內只 load 一次；TTL 後重 load；invalidate 即作廢；失敗唔記", async () => {
    let t = 1_000;
    const now = () => t;
    const load = vi.fn(async () => ({ n: load.mock.calls.length }));
    const a = await cachedLookup("k", load, now);
    const b = await cachedLookup("k", load, now);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    t += LOOKUP_TTL_MS - 1;
    await cachedLookup("k", load, now);
    expect(load).toHaveBeenCalledTimes(1);
    t += 2;
    await cachedLookup("k", load, now);
    expect(load).toHaveBeenCalledTimes(2);
    invalidateLookups();
    await cachedLookup("k", load, now);
    expect(load).toHaveBeenCalledTimes(3);

    const bad = vi.fn(async () => {
      throw new Error("x");
    });
    await expect(cachedLookup("bad", bad, now)).rejects.toThrow();
    await expect(cachedLookup("bad", bad, now)).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("相關資源寫入路徑會作廢；其他唔會", () => {
    for (const p of ["/api/guards", "/api/guards/abc", "/api/sites/x", "/api/brokers", "/api/shift-types", "/api/broker-site-assignments", "/api/month-closes/1/lock"]) expect(isLookupWritePath(p)).toBe(true);
    for (const p of ["/api/shift-records/batch", "/api/rate-cards", "/api/quotas", "/api/ai/chat"]) expect(isLookupWritePath(p)).toBe(false);
  });
});

describe("驗收修正：lookup cache 形狀一致＋綁用戶", () => {
  let calls: string[];
  let owner = "boss";
  beforeEach(() => {
    invalidateLookups();
    setLookupScope("u1");
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const u = new URL(url, "http://t");
        const rows = [{ id: `${owner}-${u.pathname}` }];
        return new Response(JSON.stringify({ rows, total: 1, skip: 0, take: 500 }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("先 lookups（cachedGetAll）後 editor（cachedRows）：同一 key，editor 攞到 array、冇多打 API", async () => {
    const a = await cachedGetAll<{ id: string }>("/api/brokers");
    expect(a.ok && Array.isArray(a.data.rows)).toBe(true);
    const rows = await cachedRows<{ id: string }>("/api/brokers");
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["boss-/api/brokers"]);
    expect(calls).toHaveLength(1);
  });

  it("先 editor（cachedRows）後 lookups（cachedGetAll）：lookups 攞到 ApiResult 形狀（有 .ok／.data.rows）、冇多打 API", async () => {
    const rows = await cachedRows<{ id: string }>("/api/guards?fields=lite");
    expect(rows).toHaveLength(1);
    const res = await cachedGetAll<{ id: string }>("/api/guards?fields=lite");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(calls).toHaveLength(1);
  });

  it("cachedRows 失敗拋 ApiClientError，且失敗唔記", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden", message: "冇權限" }), { status: 403 })));
    await expect(cachedRows("/api/brokers")).rejects.toMatchObject({ status: 403 });
    await expect(cachedRows("/api/brokers")).rejects.toMatchObject({ status: 403 });
  });

  it("登出→登入另一用戶（scope 改變）後 cache miss，唔會攞到上一個用戶嘅資料", async () => {
    owner = "boss";
    const first = await cachedRows<{ id: string }>("/api/brokers");
    expect(first[0]!.id).toContain("boss");
    setLookupScope("u2"); // 另一用戶登入（LookupScope 於 layout render 時設定）
    owner = "broker";
    const second = await cachedRows<{ id: string }>("/api/brokers");
    expect(second[0]!.id).toContain("broker");
    expect(calls).toHaveLength(2);
    setLookupScope("u2"); // 同一用戶唔清
    await cachedRows("/api/brokers");
    expect(calls).toHaveLength(2);
  });

  it("invalidateLookups（登出／登入成功時 call）後 cache miss", async () => {
    await cachedRows("/api/sites");
    invalidateLookups();
    await cachedRows("/api/sites");
    expect(calls).toHaveLength(2);
  });
});

describe("驗收修正：daily-requirements 日期格式驗證", () => {
  it("亂填 work_date_from／to → 400（唔係 500）", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    for (const q of ["work_date_from=abc", "work_date_to=2026-13-45", "work_date_from=2026-8-1"]) {
      const res = await dailyGet(req(`http://t/api/daily-requirements?site_id=${fx.site.id}&${q}`, cookie));
      expect(res.status, q).toBe(400);
    }
    expect((await dailyGet(req(`http://t/api/daily-requirements?site_id=${fx.site.id}&work_date_from=2026-08-01`, cookie))).status).toBe(200);
  });
});
