// TE-13 追加：ghost person（由銀行戶口等文件產生嘅空記錄）自動併入真人。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { findGhostPersons, hashPackage, importPackageSchema, personKeyForHkid, packageConflicts, type PackagePerson } from "@/lib/guards/import/package";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import { draftGuardImportQuestions } from "@/lib/triage/generators/guard-import";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as proposalsRoute } from "@/app/api/triage/sessions/[id]/proposals/route";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const HK = mkHkid("Q", "700001");
const HK2 = mkHkid("R", "700002");
type St = "confirmed" | "review" | "missing";
const F = (v: string | null, s: St = "confirmed") => (v ? { value: v, status: s } : { value: null, status: "missing" as St });
function real(key: string, hkid: string, nos: string[], over: Partial<PackagePerson> = {}): PackagePerson {
  return {
    key, hkid: F(hkid), nameZh: F("導入測試員甲", "review"), nameEn: F(null), dateOfBirth: F(null), sex: F(null), phone: F(null), address: F(null),
    staffNumbers: nos.map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })), rating: "review", reasons: [], docInfo: { pageCount: 4, pagesByKind: { id_card: 1 } },
    ...over,
  } as PackagePerson;
}
function ghost(key: string, nos: string[], over: Partial<PackagePerson> = {}): PackagePerson {
  return {
    key, hkid: F(null), nameZh: F(null), nameEn: F(null), dateOfBirth: F(null), sex: F(null), phone: F(null), address: F(null),
    staffNumbers: nos.map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })), rating: "fail", reasons: ["no_id_page", "hkid_missing", "name_missing"], docInfo: { pageCount: 1, pagesByKind: { bank: 1 } },
    ...over,
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[]) => ({ version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons });
async function drafts(persons: PackagePerson[]) {
  const pkg = pkgOf(persons);
  const { evals } = await evaluateImportPackage(pkg as never);
  return draftGuardImportQuestions(pkg as never, evals);
}

describe("findGhostPersons／packageConflicts", () => {
  it("ghost 只同一個身份已確認真人共用 → 併入；packageConflicts 唔再報共用", () => {
    const r = real(personKeyForHkid(HK), HK, ["U91001"]);
    const g = ghost("pkg-g", ["U91001"]);
    expect([...findGhostPersons([r, g])]).toEqual([["pkg-g", { mergedInto: r.key, staffNumbers: expect.any(Array) }]]);
    expect(packageConflicts([r, g]).get(r.key)).toBeUndefined();
    expect(packageConflicts([r, g]).get("pkg-g")).toBeUndefined();
  });
  it("唔符合條件就唔係 ghost：兩個真人共用／真人身份未確認／ghost 有 ext 或個人欄／名單 HKID 唔一致", () => {
    const r1 = real("r1", HK, ["U91001"]);
    const r2 = real("r2", HK2, ["U91001"]);
    expect(findGhostPersons([r1, r2, ghost("g", ["U91001"])]).size).toBe(0); // 兩個真人
    expect(findGhostPersons([real("r", HK, ["U91001"], { hkid: F(HK, "review") }), ghost("g", ["U91001"])]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001"], { phone: F("91000011") })]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001"], { bank: { code: F("024"), name: F(null), accountNo: F("123456789"), payeeName: F("TEST") } as never })]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001", "U91009"])]).size).toBe(0); // 另一個工號冇真人
    expect(findGhostPersons([r1, ghost("g", ["U91001"], { listHkids: { U91001: HK2 } })]).size).toBe(0); // 名單 HKID 唔一致
    expect(findGhostPersons([real("r", HK, ["U91001"], { listHkids: { U91001: HK } }), ghost("g", ["U91001"], { listHkids: { U91001: HK } })]).size).toBe(1); // 一致
    expect(packageConflicts([r1, r2, ghost("g", ["U91001"])]).get("r1")).toContain("staffno_shared_by_persons");
  });
});

describe("generator：ghost 自動併入", () => {
  beforeEach(clearAll);
  it("ghost 唔出題；真人唔再有共用題但帶併入說明＋合併文件頁數", async () => {
    const r = real(personKeyForHkid(HK), HK, ["U91001"]);
    const ds = await drafts([r, ghost("pkg-g", ["U91001"])]);
    expect(ds.filter((d) => d.kind === "staffno_shared_by_persons")).toHaveLength(0);
    expect(ds.every((d) => d.evidence.person.staffNumbers.length > 0 && d.evidence.person.nameZh.value !== null)).toBe(true); // 冇 ghost 嘅題
    const nameQ = ds.find((d) => d.kind === "name_not_confirmed")!;
    expect(nameQ.evidence.note).toBe("由銀行戶口文件產生嘅空記錄，已自動併入 U91001");
    expect(nameQ.evidence.person.docInfo).toMatchObject({ pageCount: 5, pagesByKind: { id_card: 1, bank: 1 } });
  });
  it("兩個真人共用照出題（帶 shared_with）；名單 HKID 唔一致照出題", async () => {
    const ds = await drafts([real("r1", HK, ["U91001"]), real("r2", HK2, ["U91001"]), ghost("g", ["U91001"])]);
    const sh = ds.filter((d) => d.kind === "staffno_shared_by_persons");
    expect(sh.length).toBeGreaterThanOrEqual(2);
    expect(sh[0]!.evidence.shared_with!.length).toBeGreaterThanOrEqual(1);
    const ds2 = await drafts([real("r", HK, ["U91001"]), ghost("g", ["U91001"], { listHkids: { U91001: HK2 } })]);
    expect(ds2.filter((d) => d.kind === "staffno_shared_by_persons").length).toBe(2);
    const ghostQ = ds2.find((d) => d.kind === "staffno_shared_by_persons" && d.evidence.person.nameZh.value === null)!;
    expect(ghostQ.evidence.shared_with![0]).toMatchObject({ hkid_status: "confirmed", staff_numbers: ["U91001"] });
  });
});

describe("apply／舊題收題", () => {
  let owner: string;
  let accountant: string;
  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    const fx = await seedWp2Fixture();
    const tel = `6${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const u = await prisma.user.create({ data: { name: "測試會計新", tel, passwordHash: "x", roleId: fx.roleIds["會計"], createdBy: "t" } });
    accountant = await sessionCookieForUser(u.id);
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const call = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id = "x") =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
  const apply = async (persons: PackagePerson[]) => {
    const pkg = pkgOf(persons);
    const res = await call(applyRoute as never, "/api/guards/import/apply", accountant, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) });
    return { status: res.status, body: await res.json() };
  };

  it("apply：ghost 唔建人唔出共用題；真人照常處理", async () => {
    const r = await apply([real(personKeyForHkid(HK), HK, ["U91001"]), ghost("pkg-g", ["U91001"])]);
    expect(r.status).toBe(200);
    expect(await prisma.triageQuestion.count({ where: { kind: "staffno_shared_by_persons" } })).toBe(0);
    expect(r.body.persons_total).toBe(1); // ghost 唔計
  });

  it("production 舊題：兩條 open 共用題（ghost＋真人）→ proposals dry 計數唔郁 DB、apply 收埋兩條並完結 session", async () => {
    // 先用唔符合 ghost 條件嘅版本（ghost rating review、冇 no_id_page）apply，得到真實流程出嘅兩條共用題
    const a = await apply([real(personKeyForHkid(HK), HK, ["U91001"]), ghost("pkg-g", ["U91001"], { rating: "review", reasons: [] })]);
    expect(a.status).toBe(200);
    const qs = await prisma.triageQuestion.findMany({ where: { kind: "staffno_shared_by_persons" } });
    expect(qs).toHaveLength(2);
    // 模擬 production 舊題：ghost 嗰條 evidence 實際係 fail／no_id_page 嘅空記錄
    for (const q of qs) {
      const ev = q.evidenceJson as unknown as { person: PackagePerson };
      if (ev.person.nameZh.value === null) await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, person: { ...ev.person, rating: "fail", reasons: ["no_id_page"] } } as never } });
    }
    const sid = qs[0]!.sessionId;
    const dry = await (await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals?dry_run=1`, accountant, { version: 1, proposals: [] }, sid)).json();
    expect(dry.ghost_questions_closed).toBe(2);
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "open", kind: "staffno_shared_by_persons" } })).toBe(2);
    const live = await (await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals`, accountant, { version: 1, proposals: [] }, sid)).json();
    expect(live.ghost_questions_closed).toBe(2);
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "superseded", kind: "staffno_shared_by_persons" } })).toBe(2);
    void owner;
  });
});
