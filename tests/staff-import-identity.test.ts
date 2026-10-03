// WP-STAFF-IMPORT Stage B1：身份證＋電話唯一識別（純函數、API 409／400、migration 冪等）。
// 全部合成資料（合法 check digit 例 A123456(3)、91234567、識別測試員甲）。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { canonicalHkid, hkidCheckDigitValid, normalizeTelHk, identityStatus, hashIdentityValue } from "@/lib/guards/identity";
import { canonicalHkid as canonicalFromGuardFix } from "@/lib/guard-fix/sources";
import { maskHkid } from "@/lib/api/guard-pii";
import { GET as listGuards, POST as createGuard } from "@/app/api/guards/route";
import { GET as getGuard, PATCH as patchGuard } from "@/app/api/guards/[id]/route";
import { POST as addPhone } from "@/app/api/guards/[id]/phones/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("identity 純函數", () => {
  it("canonicalHkid：大寫、去括號／空格／全形；guard-fix re-export 同一個", () => {
    expect(canonicalHkid("a123456(3)")).toBe("A1234563");
    expect(canonicalHkid(" A123456（3） ")).toBe("A1234563");
    expect(canonicalHkid("A1234563")).toBe("A1234563");
    expect(canonicalHkid("XYZ")).toBeNull();
    expect(canonicalHkid(null)).toBeNull();
    expect(canonicalFromGuardFix).toBe(canonicalHkid);
  });
  it("hkidCheckDigitValid：A123456(3) 合法、A123456(7) 唔合法；雙字母前綴", () => {
    expect(hkidCheckDigitValid("A123456(3)")).toBe(true);
    expect(hkidCheckDigitValid("A1234563")).toBe(true);
    expect(hkidCheckDigitValid("A123456(7)")).toBe(false);
    expect(hkidCheckDigitValid("")).toBe(false);
    // WX123456(?)：由公式計出嚟嘅 check digit
    const base = "WX123456";
    const ok = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].filter((c) => hkidCheckDigitValid(base + c));
    expect(ok.length).toBe(1);
  });
  it("normalizeTelHk：去空白／連字符、+852／852／00852 前綴", () => {
    expect(normalizeTelHk("9123 4567")).toBe("91234567");
    expect(normalizeTelHk("+852 9123-4567")).toBe("91234567");
    expect(normalizeTelHk("85291234567")).toBe("91234567");
    expect(normalizeTelHk("0085291234567")).toBe("91234567");
    expect(normalizeTelHk("abc")).toBeNull();
    expect(normalizeTelHk("")).toBeNull();
  });
  it("identityStatus 四種狀態", () => {
    expect(identityStatus({ hkid: "A1234563", tel: "91234567" })).toBe("complete");
    expect(identityStatus({ hkid: null, tel: "91234567" })).toBe("missing_hkid");
    expect(identityStatus({ hkid: "A1234563", tel: null })).toBe("missing_tel");
    expect(identityStatus({ hkid: "", tel: " " })).toBe("missing_both");
  });
  it("maskHkid 收 canonical 同帶括號兩種", () => {
    expect(maskHkid("A1234563")).toBe("A123***(3)");
    expect(maskHkid("A123456(3)")).toBe("A123***(3)");
    expect(maskHkid("???")).toBe("***");
  });
});

describe("guards API：身份證／電話唯一", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let supervisor: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
  });

  async function mk(extra: Record<string, unknown>) {
    const res = await createGuard(req("http://t/api/guards", owner, "POST", { name_zh: "識別測試員甲", employment_type: "cash_casual", ...extra }));
    return res;
  }

  it("POST 帶 hkid（括號寫法）→ 存 canonical；冇身份證又冇電話都唔擋", async () => {
    const r1 = await mk({ hkid: "a123456(3)" });
    expect(r1.status).toBe(201);
    const id = (await r1.json()).id as string;
    expect((await prisma.guard.findUniqueOrThrow({ where: { id } })).hkid).toBe("A1234563");
    const r2 = await mk({ name_zh: "識別測試員乙" });
    expect(r2.status).toBe(201);
    expect((await r2.json()).identity_status).toBe("missing_both");
  });

  it("POST 重複 hkid → 409，訊息唔回顯姓名／號碼", async () => {
    await mk({ hkid: "A123456(3)" });
    const res = await mk({ name_zh: "識別測試員丙", hkid: "A1234563" });
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("識別測試員甲");
    expect(text).not.toContain("A123456");
  });

  it("POST check digit 唔啱 → 400；allow_invalid_hkid 放行（護照號）", async () => {
    expect((await mk({ hkid: "A123456(7)" })).status).toBe(400);
    expect((await mk({ hkid: "A123456(7)", allow_invalid_hkid: true })).status).toBe(201);
    expect((await mk({ name_zh: "識別測試員丁", hkid: "G12345678", allow_invalid_hkid: true })).status).toBe(201);
  });

  it("POST 重複電話 → 409（8 位／+852 寫法都擋）", async () => {
    expect((await mk({ tel: "91234567" })).status).toBe(201);
    const res = await mk({ name_zh: "識別測試員戊", tel: "+852 9123 4567" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("91234567");
  });

  it("PATCH hkid：改成別人嘅 → 409；改成自己現值（括號寫法）→ 200 唔驗；check digit 唔啱 → 400", async () => {
    const a = await (await mk({ hkid: "A123456(3)" })).json();
    const b = await (await mk({ name_zh: "識別測試員乙" })).json();
    const dup = await patchGuard(req(`http://t/api/guards/${b.id}`, owner, "PATCH", { hkid: "A123456(3)" }), ctx(b.id));
    expect(dup.status).toBe(409);
    const bad = await patchGuard(req(`http://t/api/guards/${b.id}`, owner, "PATCH", { hkid: "B123456(7)" }), ctx(b.id));
    expect(bad.status).toBe(400);
    const same = await patchGuard(req(`http://t/api/guards/${a.id}`, owner, "PATCH", { hkid: "A123456(3)" }), ctx(a.id));
    expect(same.status).toBe(200);
    // 舊髒值（check digit 唔啱）保持原值唔鎖死儲存
    await prisma.guard.update({ where: { id: b.id }, data: { hkid: "B1234567" } });
    const keep = await patchGuard(req(`http://t/api/guards/${b.id}`, owner, "PATCH", { hkid: "B123456(7)", name_en: "Test B" }), ctx(b.id));
    expect(keep.status).toBe(200);
  });

  it("PATCH tel 同 phones POST：重複 → 409", async () => {
    const a = await (await mk({ tel: "91234567" })).json();
    const b = await (await mk({ name_zh: "識別測試員乙", tel: "61234567" })).json();
    const r1 = await patchGuard(req(`http://t/api/guards/${b.id}`, owner, "PATCH", { tel: "91234567" }), ctx(b.id));
    expect(r1.status).toBe(409);
    const r2 = await addPhone(req(`http://t/api/guards/${b.id}/phones`, owner, "POST", { tel: "9123-4567" }), ctx(b.id));
    expect(r2.status).toBe(409);
    const r3 = await addPhone(req(`http://t/api/guards/${a.id}/phones`, owner, "POST", { tel: "51234567" }), ctx(a.id));
    expect(r3.status).toBe(201);
  });

  it("DB unique index 存在（race 時 DB 都擋）", async () => {
    await prisma.guard.create({ data: { nameZh: "識別測試員甲", employmentType: "cash_casual", hkid: "A1234563", createdBy: "t" } });
    await expect(prisma.guard.create({ data: { nameZh: "識別測試員乙", employmentType: "cash_casual", hkid: "A1234563", createdBy: "t" } })).rejects.toThrow();
  });

  it("列表 identity 篩選＋identity_status；詳情有 identity_status", async () => {
    await mk({ hkid: "A123456(3)", tel: "91234567" });
    await mk({ name_zh: "識別測試員乙", tel: "61234567" });
    await mk({ name_zh: "識別測試員丙", hkid: "G12345678", allow_invalid_hkid: true });
    const all = await (await listGuards(req("http://t/api/guards?take=100&include_inactive=1", owner))).json();
    const st = Object.fromEntries(all.rows.filter((r: { name_zh: string }) => r.name_zh.startsWith("識別測試員")).map((r: { name_zh: string; identity_status: string }) => [r.name_zh, r.identity_status]));
    expect(st["識別測試員甲"]).toBe("complete");
    expect(st["識別測試員乙"]).toBe("missing_hkid");
    expect(st["識別測試員丙"]).toBe("missing_tel");
    const mh = await (await listGuards(req("http://t/api/guards?take=100&identity=missing_hkid", owner))).json();
    expect(mh.rows.map((r: { name_zh: string }) => r.name_zh)).toContain("識別測試員乙");
    expect(mh.rows.map((r: { name_zh: string }) => r.name_zh)).not.toContain("識別測試員甲");
    expect(mh.rows.map((r: { name_zh: string }) => r.name_zh)).not.toContain("識別測試員丙");
    const mt = await (await listGuards(req("http://t/api/guards?take=100&identity=missing_tel", owner))).json();
    expect(mt.rows.some((r: { name_zh: string }) => r.name_zh === "識別測試員丙")).toBe(true);
    expect((await listGuards(req("http://t/api/guards?identity=zzz", owner))).status).toBe(400);
    const any = await (await listGuards(req("http://t/api/guards?take=100&identity=missing_any", owner))).json();
    expect(any.rows.length).toBeGreaterThanOrEqual(2);
    const detail = await (await getGuard(req(`http://t/api/guards/${all.rows.find((r: { name_zh: string }) => r.name_zh === "識別測試員乙").id}`, owner), ctx(all.rows.find((r: { name_zh: string }) => r.name_zh === "識別測試員乙").id))).json();
    expect(detail.identity_status).toBe("missing_hkid");
  });

  it("主管冇「安員個人資料」權限：POST 帶 hkid → 403", async () => {
    const res = await createGuard(req("http://t/api/guards", supervisor, "POST", { name_zh: "識別測試員甲", employment_type: "cash_casual", hkid: "A123456(3)" }));
    expect(res.status).toBe(403);
  });
});

describe("migration 20261003000000_wp_staff_import_identity：冪等＋重複入 conflicts 唔建 index", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "prisma/migrations/20261003000000_wp_staff_import_identity/migration.sql"), "utf8");
  async function runMigration() {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }
  async function indexExists(name: string) {
    const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${name}'`);
    return r[0]!.n > 0;
  }
  beforeEach(async () => {
    await clearAll();
  });

  it("重跑冪等；backfill 正規化；冇重複 → index 在", async () => {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS guards_hkid_key`);
    await prisma.guard.create({ data: { nameZh: "識別測試員甲", employmentType: "cash_casual", hkid: "a123456（3）", createdBy: "t" } });
    await prisma.guard.create({ data: { nameZh: "識別測試員乙", employmentType: "cash_casual", hkid: "G12345678", createdBy: "t" } });
    await runMigration();
    await runMigration();
    const gs = await prisma.guard.findMany({ orderBy: { createdAt: "asc" } });
    expect(gs.map((g) => g.hkid)).toEqual(["A1234563", "G12345678"]);
    expect(await indexExists("guards_hkid_key")).toBe(true);
    expect(await indexExists("guard_phones_tel_key")).toBe(true);
  });

  it("ai.audit_log view 排除 guard_identity_conflicts", async () => {
    const r = await prisma.$queryRawUnsafe<Array<{ d: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS d`);
    expect(r[0]!.d).toContain("guard_identity_conflicts");
  });

  it("有重複 hkid／電話：寫入 conflicts（hash，唔存明文）、唔建 index、唔 abort", async () => {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS guards_hkid_key`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS guard_phones_tel_key`);
    const a = await prisma.guard.create({ data: { nameZh: "識別測試員甲", employmentType: "cash_casual", hkid: "A1234563", createdBy: "t" } });
    const b = await prisma.guard.create({ data: { nameZh: "識別測試員乙", employmentType: "cash_casual", hkid: "A1234563", createdBy: "t" } });
    await prisma.guardPhone.create({ data: { guardId: a.id, tel: "91234567", isPrimary: true } });
    await prisma.guardPhone.create({ data: { guardId: b.id, tel: "91234567", isPrimary: true } });
    await runMigration();
    await runMigration();
    const rows = await prisma.guardIdentityConflict.findMany({ orderBy: { kind: "asc" } });
    expect(rows.map((r) => r.kind)).toEqual(["dup_hkid", "dup_tel"]);
    expect(rows[0]!.valueHash).toBe(hashIdentityValue("A1234563"));
    expect(rows[0]!.guardIds.sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(rows)).not.toContain("A1234563");
    expect(JSON.stringify(rows)).not.toContain("91234567");
    expect(await indexExists("guards_hkid_key")).toBe(false);
    expect(await indexExists("guard_phones_tel_key")).toBe(false);
    // app 層照擋
    const owner = await (async () => { const fx = await seedWp2Fixture(); return sessionCookieForUser(fx.userIds["老闆"]); })();
    const res = await createGuard(req("http://t/api/guards", owner, "POST", { name_zh: "識別測試員丙", employment_type: "cash_casual", hkid: "A123456(3)" }));
    expect(res.status).toBe(409);
    // 還原：清走重複，重跑 migration 令 index 回來
    await clearAll();
    await runMigration();
    expect(await indexExists("guards_hkid_key")).toBe(true);
    expect(await indexExists("guard_phones_tel_key")).toBe(true);
  });
});

describe("guard-fix create：電話撞現有 guard_phones → 跳過唔寫、guard 照建（M1）", () => {
  it("有 unique index＋撞電話：run 成功、tel_skipped_duplicate、無重複", async () => {
    const { buildGuardFixPlan } = await import("@/lib/guard-fix/plan");
    const { applyGuardFixPlan } = await import("@/lib/guard-fix/apply");
    await clearAll();
    const fx = await seedWp2Fixture();
    const month0 = new Date("2026-08-01T00:00:00.000Z");
    await prisma.rosterUpload.create({
      data: { month: month0, siteId: fx.site.id, siteNameRaw: "測試盤", uploaderUserId: fx.userIds["老闆"], fileName: "t.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
    });
    const owner = await prisma.guard.create({ data: { nameZh: "識別測試員電話主", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardPhone.create({ data: { guardId: owner.id, tel: "61230001", isPrimary: true } });
    const month = new Date("2026-08-01T00:00:00.000Z");
    const plan = await buildGuardFixPlan({ prisma, month, uTeamRows: [] }).catch(() => null);
    expect(plan).not.toBeNull();
    const base = { type: "create" as const, alias: null, secondaryTel: "61230002", hkid: null, hireDate: null, defaultBrokerCode: "X", reason: "t" };
    plan!.actions.create.push({ ...base, seq: "S1", nameZh: "識別測試員新甲", primaryTel: "61230001", uNumber: "U99001" });
    const diffs = await applyGuardFixPlan({ prisma, plan: plan!, planOnly: false, month });
    expect(diffs.create.create).toEqual(["S1"]);
    expect(diffs.create.telSkipped).toEqual(["S1:tel_skipped_duplicate"]);
    const g = await prisma.guard.findFirstOrThrow({ where: { nameZh: "識別測試員新甲" }, include: { phones: true } });
    expect(g.phones.map((p) => p.tel)).toEqual(["61230002"]);
    expect(await prisma.guardPhone.count({ where: { tel: "61230001" } })).toBe(1);
  });
});
