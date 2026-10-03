// WP-STAFF-IMPORT B3：證件資料批量導入（match／package／apply／preview／RBAC）。
// 全部合成資料（合法 check digit hkid 由 helper 計、91234567 系列電話、「導入測試員甲」）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { buildDbIndex, decideMatch, type DbGuard, type MatchInput } from "@/lib/guards/import/match";
import { hashPackage, packageConflicts, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { maskHkidImport, maskTelImport, maskAddressImport } from "@/lib/guards/import/text";
import { POST as previewRoute } from "@/app/api/guards/import/preview/route";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const H1 = mkHkid("A", "123456"); // A1234563
const H2 = mkHkid("B", "234567");
const H3 = mkHkid("C", "345678");
const H4 = mkHkid("D", "456789");

type St = "confirmed" | "review" | "missing";
const F = (value: string | null, status: St) => (value ? { value, status } : { value: null, status: "missing" as St });

function person(over: Partial<Pick<PackagePerson, "key">> & { hkid?: string; name?: string; tel?: string | null; addr?: string | null; nos?: string[]; telStatus?: St; hkidStatus?: St; nameStatus?: St; addrSource?: "address_proof" | "application_form" }): PackagePerson {
  const hk = over.hkid ?? H1;
  return {
    key: personKeyForHkid(hk),
    hkid: F(hk, over.hkidStatus ?? "confirmed"),
    nameZh: F(over.name ?? "導入測試員甲", over.nameStatus ?? "confirmed"),
    nameEn: F("TEST AYUEN KAP", "review"),
    dateOfBirth: F("1990-05-06", "confirmed"),
    sex: F("M", "confirmed"),
    phone: over.tel === null ? F(null, "missing") : F(over.tel ?? "91234567", over.telStatus ?? "confirmed"),
    address: over.addr === null ? F(null, "missing") : { ...F(over.addr ?? "測試道123號測試大廈4樓A室", "review"), ...(over.addrSource ? { source: over.addrSource } : {}) },
    staffNumbers: (over.nos ?? ["U90001"]).map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })),
    rating: "auto_ok",
    reasons: [],
    conflicts: [],
    ...(over.key ? { key: over.key } : {}),
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[]) => ({ version: 2 as const, generatedAt: "2026-10-03T00:00:00.000Z", persons });

describe("masking／package／match 純函數", () => {
  it("遮罩：hkid 頭 1 尾 2、電話尾 3、地址頭 3", () => {
    expect(maskHkidImport(H1)).toBe(`A*****${H1.slice(-2)}`);
    expect(maskTelImport("91234567")).toBe("*****567");
    expect(maskAddressImport("測試道123號")).toBe("測試道…");
  });
  it("導入包 schema：version 2、逐欄 status；壞格式拒收", () => {
    expect(importPackageSchema.safeParse(pkgOf([person({})])).success).toBe(true);
    expect(importPackageSchema.safeParse({ ...pkgOf([]), version: 1 }).success).toBe(false);
    const bad = pkgOf([{ ...person({}), phone: { value: "1", status: "maybe" } } as unknown as PackagePerson]);
    expect(importPackageSchema.safeParse(bad).success).toBe(false);
  });
  it("包內衝突：同電話兩個人／同工號兩個人／重複 hkid", () => {
    const a = person({ hkid: H1, tel: "91234567", nos: ["U90001"] });
    const b = person({ hkid: H2, tel: "91234567", nos: ["U90001"] });
    const c = person({ hkid: H3, tel: "61234567", nos: ["U90003"] });
    const m = packageConflicts([a, b, c]);
    expect(m.get(a.key)).toEqual(expect.arrayContaining(["dup_tel_across_persons", "staffno_shared_by_persons"]));
    expect(m.get(c.key)).toBeUndefined();
    const d = packageConflicts([a, { ...a }]);
    expect(d.get(a.key)).toEqual(expect.arrayContaining(["duplicate_hkid_in_package", "duplicate_key_in_package"]));
  });
  it("decideMatch：hkid→工號→電話→姓名；理由碼", () => {
    const dbg: DbGuard[] = [
      { id: "g1", nameZh: "測試甲", hkid: H1, tels: ["91234567"], staffNos: ["U00001"] },
      { id: "g2", nameZh: "測試乙", hkid: null, tels: ["61234567"], staffNos: ["U00002"] },
      { id: "g3", nameZh: "測試丙", hkid: H3, tels: [], staffNos: [] },
    ];
    const db = buildDbIndex(dbg);
    const base: MatchInput = { staffNos: [], hkid: null, hkidValid: true, nameZh: null, phone: null, grade: "auto_ok", gradeReasons: [] };
    expect(decideMatch({ ...base, hkid: H1 }, db)).toMatchObject({ action: "link", guardId: "g1" });
    expect(decideMatch({ ...base, hkid: H2, staffNos: ["u00002"] }, db)).toMatchObject({ action: "link", guardId: "g2" });
    expect(decideMatch({ ...base, hkid: H1, staffNos: ["U00002"] }, db)).toMatchObject({ action: "conflict", reasons: ["hkid_vs_staffno_differ"] });
    expect(decideMatch({ ...base, hkid: H4, phone: "91234567" }, db)).toMatchObject({ action: "conflict", reasons: ["tel_guard_has_other_hkid"] });
    expect(decideMatch({ ...base, hkid: H2, phone: "61234567", nameZh: "測試乙" }, db)).toMatchObject({ action: "link", guardId: "g2" });
    expect(decideMatch({ ...base, hkid: H4, nameZh: "測試丙" }, db)).toMatchObject({ action: "needs_review", reasons: ["name_only_candidate"] });
    expect(decideMatch({ ...base, hkid: H4, nameZh: "測試新" }, db)).toMatchObject({ action: "create" });
    expect(decideMatch({ ...base, hkid: H1 }, db, ["dup_tel_across_persons"])).toMatchObject({ action: "conflict" });
    expect(decideMatch({ ...base, hkid: null, hkidValid: false, grade: "fail" }, db)).toMatchObject({ action: "needs_review" });
  });
});

describe("導入 API", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let supervisor: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
  });
  const call = (route: typeof previewRoute, cookie: string, body: unknown) => {
    const b = body as { package?: unknown; package_hash?: string };
    const withHash = route === applyRoute && b.package && b.package_hash === undefined ? { ...b, package_hash: hashPackage(importPackageSchema.parse(b.package)) } : body;
    return route(new Request("http://t/api/guards/import/x", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(withHash) }));
  };

  it("RBAC：主管 403（preview／apply）；老闆 200", async () => {
    const pkg = pkgOf([person({})]);
    expect((await call(previewRoute, supervisor, { package: pkg })).status).toBe(403);
    expect((await call(applyRoute, supervisor, { package: pkg })).status).toBe(403);
    expect((await call(previewRoute, owner, { package: pkg })).status).toBe(200);
  });

  it("RBAC：主管就算開晒「安員」create＋「安員個人資料」view／update，仍然 403（安員批量導入淨係老闆，硬性拒）", async () => {
    for (const [module, action] of [["安員", "create"], ["安員個人資料", "view"], ["安員個人資料", "update"]] as const) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module, action } } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: perm.id } },
        update: { granted: true },
        create: { roleId: fx.roleIds["主管"], permissionId: perm.id, granted: true },
      });
    }
    expect((await call(previewRoute, supervisor, { package: pkgOf([person({})]) })).status).toBe(403);
    expect((await call(applyRoute, supervisor, { package: pkgOf([person({})]) })).status).toBe(403);
  });

  it("自訂角色（base＝主管，開晒相關權限）對 preview／apply 仍然 403", async () => {
    const custom = await prisma.role.create({ data: { name: "測試自訂主管", baseRole: "主管", isCustom: true, createdBy: "t" } });
    const perms = await prisma.permission.findMany({ where: { OR: [{ module: "安員批量導入" }, { module: "安員" }, { module: "安員個人資料" }] } });
    for (const pm of perms) await prisma.rolePermission.create({ data: { roleId: custom.id, permissionId: pm.id, granted: true } });
    const supUserId = fx.userIds["主管"];
    await prisma.user.update({ where: { id: supUserId }, data: { roleId: custom.id, tokenVersion: { increment: 1 } } });
    const cookie = await sessionCookieForUser(supUserId);
    expect((await call(previewRoute, cookie, { package: pkgOf([person({})]) })).status).toBe(403);
    expect((await call(applyRoute, cookie, { package: pkgOf([person({})]) })).status).toBe(403);
    // 還原（唔留自訂角色，免影響其他測試）
    await prisma.user.update({ where: { id: supUserId }, data: { roleId: fx.roleIds["主管"], tokenVersion: { increment: 1 } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: custom.id } });
    await prisma.role.delete({ where: { id: custom.id } });
  });

  it("壞導入包 → 400，訊息唔帶值", async () => {
    const res = await call(previewRoute, owner, { package: { version: 2, generatedAt: "x", persons: [{ key: "k", hkid: { value: H1, status: "zzz" } }] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(H1);
  });

  it("preview：逐欄＋逐人兩組統計；回應內 hkid／電話／地址已遮罩", async () => {
    const p1 = person({ hkid: H1, tel: "91234567", nos: ["U90001"] });
    const p2 = person({ hkid: H2, name: "導入測試員乙", tel: null, addr: null, nos: ["U90002"], key: personKeyForHkid(H2) });
    const res = await call(previewRoute, owner, { package: pkgOf([p1, p2]) });
    const text = await res.text();
    for (const secret of [H1, H2, "91234567", "測試道123號測試大廈4樓A室"]) expect(text).not.toContain(secret);
    const body = JSON.parse(text);
    expect(body.person_stats).toMatchObject({ create: 2, link: 0, conflict: 0, needs_review: 0 });
    expect(body.field_stats.hkid).toEqual({ confirmed: 2, review: 0, missing: 0 });
    expect(body.field_stats.name_zh).toEqual({ confirmed: 2, review: 0, missing: 0 });
    expect(body.field_stats.phone).toEqual({ confirmed: 1, review: 0, missing: 1 });
    expect(body.auto_apply.guards_to_create).toBe(2);
    expect(body.rows[0].hkid_masked).toBe(`A*****${H1.slice(-2)}`);
    // preview 唔寫 DB
    expect(await prisma.guard.count({ where: { hkid: H1 } })).toBe(0);
  });

  it("apply 自動：create 只寫 confirmed 欄（姓名 confirmed）；冪等", async () => {
    const pkg = pkgOf([person({ hkid: H1, tel: "91234567", nos: ["U90001"] })]);
    const r1 = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r1.outcomes.created).toBe(1);
    expect(r1.guards_created).toBe(1);
    expect(r1.phones_added).toBe(1);
    expect(r1.staff_numbers_added).toBe(1);
    expect(r1.addresses_added).toBe(0);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H1 }, include: { phones: true, staffNumbers: true, addresses: true } });
    expect(g.nameZh).toBe("導入測試員甲");
    expect(g.identityReviewFields).toEqual([]);
    expect(g.nameEn).toBeNull(); // review 欄唔寫
    expect(g.dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-05-06");
    expect(g.phones.map((p) => [p.tel, p.source, p.isPrimary])).toEqual([["91234567", "application_form", true]]);
    expect(g.staffNumbers.map((s) => s.number)).toEqual(["U90001"]);
    expect(g.addresses.length).toBe(0);
    expect(g.tel).toBe("91234567");
    // audit
    expect(await prisma.auditLog.count({ where: { tableName: "guards", rowId: g.id, action: "create" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tableName: "guard_phones", rowId: g.phones[0]!.id, action: "create" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tableName: "guard_import", action: "guard_import_apply" } })).toBeGreaterThanOrEqual(1);
    // 重跑冪等
    const r2 = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r2.outcomes).toMatchObject({ created: 0, linked: 1 });
    expect(r2.guards_created).toBe(0);
    expect(r2.phones_added).toBe(0);
    expect(r2.staff_numbers_added).toBe(0);
    expect(await prisma.guard.count({ where: { hkid: H1 } })).toBe(1);
    expect(await prisma.guardPhone.count({ where: { tel: "91234567" } })).toBe(1);
  });

  it("link：淨補空欄，現值唔同入 conflict 唔覆蓋；工號對到先 link", async () => {
    const existing = await prisma.guard.create({ data: { nameZh: "測試現有名", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: existing.id, scheme: "U", number: "U90001", status: "current" } });
    await prisma.guard.update({ where: { id: existing.id }, data: { nameEn: "EXISTING NAME" } });
    const pkg = pkgOf([person({ hkid: H1, name: "導入測試員甲", tel: "91234567", nos: ["U90001"] })]);
    const r = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r.outcomes.linked).toBe(1);
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: existing.id } });
    expect(g.hkid).toBe(H1); // 補空欄
    expect(g.nameZh).toBe("測試現有名"); // 唔覆蓋
    expect(g.nameEn).toBe("EXISTING NAME");
    expect(g.dateOfBirth).not.toBeNull();
    expect(await prisma.guardPhone.count({ where: { guardId: existing.id } })).toBe(1);
  });

  it("conflict／needs_review 唔寫入：hkid 同工號指向唔同人；電話屬另一人；淨姓名候選", async () => {
    const a = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", hkid: H3, createdBy: "t" } });
    const b = await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: b.id, scheme: "U", number: "U90002", status: "current" } });
    await prisma.guardPhone.create({ data: { guardId: b.id, tel: "61234567", isPrimary: true } });
    await prisma.guard.create({ data: { nameZh: "測試同名", employmentType: "cash_casual", createdBy: "t" } });
    const pkg = pkgOf([
      person({ hkid: H3, name: "測試甲", tel: "51234567", nos: ["U90002"] }), // hkid→a 工號→b
      person({ hkid: H2, name: "測試新人", tel: "61234567", nos: ["U90077"] }), // 電話屬 b，b 冇 hkid → 姓名唔同 → needs_review
      person({ hkid: H4, name: "測試同名", tel: "41234567", nos: ["U90088"] }), // 淨姓名
    ]);
    const prev = await (await call(previewRoute, owner, { package: pkg })).json();
    expect(prev.person_stats).toMatchObject({ conflict: 1, needs_review: 2, create: 0, link: 0 });
    const before = await prisma.guard.count();
    const r = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r.outcomes).toMatchObject({ conflict: 1, needs_review: 2, created: 0, linked: 0 });
    expect(await prisma.guard.count()).toBe(before);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: a.id } })).hkid).toBe(H3);
    expect(await prisma.guardPhone.count({ where: { tel: "51234567" } })).toBe(0);
  });

  it("包內同電話兩個人 → 兩個都 conflict，唔建", async () => {
    const pkg = pkgOf([person({ hkid: H1, tel: "91234567", nos: ["U90001"] }), person({ hkid: H2, tel: "91234567", nos: ["U90002"], key: personKeyForHkid(H2) })]);
    const r = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r.outcomes.conflict).toBe(2);
    expect(await prisma.guard.count({ where: { hkid: { in: [H1, H2] } } })).toBe(0);
  });

  it("電話 review（唔 confirmed）唔寫、唔用嚟對齊；hkid 未 confirmed 唔建人", async () => {
    const r1 = await (await call(applyRoute, owner, { package: pkgOf([person({ hkid: H1, telStatus: "review" })]) })).json();
    expect(r1.outcomes.created).toBe(1);
    expect(r1.phones_added).toBe(0);
    const r2 = await (await call(applyRoute, owner, { package: pkgOf([person({ hkid: H2, hkidStatus: "review", key: personKeyForHkid(H2), nos: ["U90002"], tel: "61234567" })]) })).json();
    expect(r2.outcomes).toMatchObject({ created: 0, needs_review: 1 });
  });

  it("姓名未 confirmed：自動路徑唔建人（needs_review／name_not_confirmed）；覆核揀「確認／改正後確認／照建但標待核對」先建", async () => {
    const mk = (hk: string, nm: string) => person({ hkid: hk, key: personKeyForHkid(hk), name: nm, nameStatus: "review", nos: [`U9${hk.slice(1, 5)}`], tel: `6${hk.slice(2, 8)}` });
    const pA = mk(H1, "導入測試員甲");
    const pB = mk(H2, "導入測試員乙");
    const pC = mk(H3, "導入測試員丙");
    const pkg = pkgOf([pA, pB, pC]);
    const pv = await (await call(previewRoute, owner, { package: pkg })).json();
    expect(pv.person_stats).toMatchObject({ create: 0, needs_review: 3 });
    expect(pv.rows[0].reasons).toContain("name_not_confirmed");
    expect(pv.auto_apply.persons).toBe(0);
    const r0 = await (await call(applyRoute, owner, { package: pkg })).json();
    expect(r0.outcomes).toMatchObject({ created: 0, needs_review: 3 });
    expect(await prisma.guard.count({ where: { hkid: { in: [H1, H2, H3] } } })).toBe(0);
    // skip 都唔建
    const rs = await (await call(applyRoute, owner, { package: pkg, decisions: { [pA.key]: { name_zh: { action: "skip" } } } })).json();
    expect(rs.outcomes.needs_review).toBe(1);
    expect(await prisma.guard.count({ where: { hkid: H1 } })).toBe(0);
    // confirm → 建、冇待核對
    await call(applyRoute, owner, { package: pkg, decisions: { [pA.key]: { name_zh: { action: "confirm" } } } });
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H1 } })).identityReviewFields).toEqual([]);
    // 改正後確認 → 用改正嘅名
    await call(applyRoute, owner, { package: pkg, decisions: { [pB.key]: { name_zh: { action: "replace", value: "導入測試員乙改" } } } });
    const gB = await prisma.guard.findFirstOrThrow({ where: { hkid: H2 } });
    expect(gB.nameZh).toBe("導入測試員乙改");
    expect(gB.identityReviewFields).toEqual([]);
    // 照建但標待核對
    await call(applyRoute, owner, { package: pkg, decisions: { [pC.key]: { name_zh: { action: "keep_pending" } } } });
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H3 } })).identityReviewFields).toEqual(["name_zh"]);
  });

  it("地址來源：申請表地址寫 guard_addresses.source=application_form；舊包冇 source 當 address_proof；preview 帶 address_source", async () => {
    const pkg = pkgOf([person({ hkid: H4, tel: "91234567", nos: ["U90004"], addrSource: "application_form" })]);
    const key = pkg.persons[0]!.key;
    const pv = await (await call(previewRoute, owner, { package: pkg })).json();
    expect(pv.rows[0].address_source).toBe("application_form");
    const r = await (await call(applyRoute, owner, { package: pkg, decisions: { [key]: { address: { action: "confirm" } } } })).json();
    expect(r.addresses_added).toBe(1);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H4 }, include: { addresses: true } });
    expect(g.addresses[0]!.source).toBe("application_form");
    const old = pkgOf([person({ hkid: H3, tel: "61234567", nos: ["U90003"] })]);
    expect((await (await call(previewRoute, owner, { package: old })).json()).rows[0].address_source).toBe("address_proof");
    expect(importPackageSchema.safeParse(pkgOf([{ ...person({}), address: { value: "x", status: "review", source: "other" } } as unknown as PackagePerson])).success).toBe(false);
  });

  it("覆核決定：確認地址／改正後確認姓名（清待核對）／略過；link 唔覆蓋除非 replace", async () => {
    const pkg = pkgOf([person({ hkid: H1, tel: "91234567", nos: ["U90001"], nameStatus: "review" })]);
    const key = pkg.persons[0]!.key;
    await call(applyRoute, owner, { package: pkg, decisions: { [key]: { name_zh: { action: "keep_pending" } } } });
    const g0 = await prisma.guard.findFirstOrThrow({ where: { hkid: H1 } });
    expect(g0.identityReviewFields).toEqual(["name_zh"]);

    const r1 = await (await call(applyRoute, owner, { package: pkg, decisions: { [key]: { address: { action: "confirm" }, name_en: { action: "skip" } } } })).json();
    expect(r1.addresses_added).toBe(1);
    const addr = await prisma.guardAddress.findFirstOrThrow({ where: { guardId: g0.id } });
    expect(addr.source).toBe("address_proof");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).nameEn).toBeNull();

    // 改正後確認姓名 → 覆蓋＋清待核對
    const r2 = await (await call(applyRoute, owner, { package: pkg, decisions: { [key]: { name_zh: { action: "replace", value: "導入測試員甲改" } } } })).json();
    expect(r2.fields_written.name_zh).toBe(1);
    const g1 = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
    expect(g1.nameZh).toBe("導入測試員甲改");
    expect(g1.identityReviewFields).toEqual([]);
    expect(await prisma.auditLog.count({ where: { tableName: "guards", rowId: g0.id, action: "update" } })).toBeGreaterThanOrEqual(1);

    // confirm 但現值唔同 → conflict 唔覆蓋；地址已有唔同 → conflict
    const r3 = await (await call(applyRoute, owner, { package: pkg, decisions: { [key]: { name_zh: { action: "confirm" }, address: { action: "confirm", value: "完全唔同嘅測試地址9號" } } } })).json();
    expect(r3.field_conflicts).toBe(2);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).nameZh).toBe("導入測試員甲改");
    expect(await prisma.guardAddress.count({ where: { guardId: g0.id } })).toBe(1);
  });

  it("package_hash：preview 回傳；apply 帶錯或冇帶 → 409／400，唔寫入", async () => {
    const pkg = pkgOf([person({})]);
    const pv = await (await call(previewRoute, owner, { package: pkg })).json();
    expect(pv.package_hash).toBe(hashPackage(pkg));
    const wrong = await call(applyRoute, owner, { package: pkg, package_hash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect((await call(applyRoute, owner, { package: pkg, package_hash: "short" })).status).toBe(400);
    expect(await prisma.guard.count({ where: { hkid: H1 } })).toBe(0);
    const tampered = pkgOf([person({ name: "被改過" })]);
    expect((await call(applyRoute, owner, { package: tampered, package_hash: pv.package_hash })).status).toBe(409);
    expect((await call(applyRoute, owner, { package: pkg, package_hash: pv.package_hash })).status).toBe(200);
  });

  it("hkid status≠confirmed：唔做 hkid 層 link；同 hkid 嘅現有 guard 唔會被 link，無其他鍵 → needs_review", async () => {
    await prisma.guard.create({ data: { nameZh: "導入測試現有", employmentType: "cash_casual", hkid: H1, createdBy: "t" } });
    const dbg: DbGuard[] = [{ id: "g1", nameZh: "導入測試現有", hkid: H1, tels: [], staffNos: ["U00001"] }];
    const db = buildDbIndex(dbg);
    const base: MatchInput = { staffNos: [], hkid: H1, hkidValid: true, hkidConfirmed: false, nameZh: null, phone: null, grade: "auto_ok", gradeReasons: [] };
    expect(decideMatch(base, db)).toMatchObject({ action: "needs_review", reasons: ["hkid_not_confirmed_no_other_key"] });
    expect(decideMatch({ ...base, staffNos: ["U00001"] }, db)).toMatchObject({ action: "link", guardId: "g1", basis: ["staff_no"] });
  });

  it("person_keys 限定範圍", async () => {
    const p1 = person({ hkid: H1, nos: ["U90001"], tel: "91234567" });
    const p2 = person({ hkid: H2, nos: ["U90002"], tel: "61234567", key: personKeyForHkid(H2) });
    const r = await (await call(applyRoute, owner, { package: pkgOf([p1, p2]), person_keys: [p2.key] })).json();
    expect(r.persons_total).toBe(1);
    expect(await prisma.guard.count({ where: { hkid: H1 } })).toBe(0);
    expect(await prisma.guard.count({ where: { hkid: H2 } })).toBe(1);
  });

  it("識別狀態：導入後 DB unique index／重複身份證仍然擋", async () => {
    await call(applyRoute, owner, { package: pkgOf([person({ hkid: H1 })]) });
    await expect(prisma.guard.create({ data: { nameZh: "測試重複", employmentType: "cash_casual", hkid: H1, createdBy: "t" } })).rejects.toThrow();
  });
});

describe("出生日期驗證（M2）", () => {
  let owner: string;
  beforeEach(async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const callApply = (body: { package: unknown; decisions?: unknown }) =>
    applyRoute(new Request("http://t/api/guards/import/apply", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ ...body, package_hash: hashPackage(importPackageSchema.parse(body.package)) }) }));

  it("1980-02-30、1920、過年輕 → invalid_date，唔寫日期；guard 照建", async () => {
    for (const [i, dob] of ["1980-02-30", "1920-01-01", `${new Date().getUTCFullYear() - 10}-01-01`, "1980-13-01"].entries()) {
      const hk = [H1, H2, H3, H4][i]!;
      const p = person({ hkid: hk, key: personKeyForHkid(hk), nos: [`U9100${i}`], tel: `6123000${i}`, name: `導入測試員${"甲乙丙丁"[i]}` });
      p.dateOfBirth = { value: dob, status: "confirmed" };
      const r = await (await callApply({ package: pkgOf([p]) })).json();
      expect(r.outcomes.created).toBe(1);
      expect(r.results[0].fields.date_of_birth).toBe("invalid_date");
      expect((await prisma.guard.findFirstOrThrow({ where: { hkid: hk } })).dateOfBirth).toBeNull();
    }
  });

  it("覆核「改正後確認」輸入唔合法日期同樣拒；合法日期寫入", async () => {
    const p = person({ hkid: H1, nos: ["U91000"], tel: "61230000" });
    p.dateOfBirth = { value: "1980-02-30", status: "confirmed" };
    await callApply({ package: pkgOf([p]) });
    const bad = await (await callApply({ package: pkgOf([p]), decisions: { [p.key]: { date_of_birth: { action: "replace", value: "1981-02-29" } } } })).json();
    expect(bad.results[0].fields.date_of_birth).toBe("invalid_date");
    const good = await (await callApply({ package: pkgOf([p]), decisions: { [p.key]: { date_of_birth: { action: "replace", value: "1981-02-28" } } } })).json();
    expect(good.results[0].fields.date_of_birth).toBe("written");
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H1 } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1981-02-28");
  });
});
