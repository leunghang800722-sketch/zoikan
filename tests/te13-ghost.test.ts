// TE-13 追加：ghost person（由銀行戶口等文件產生嘅空記錄）自動併入真人。全部合成資料。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { findGhostPersons, hashPackage, importPackageSchema, personKeyForHkid, packageConflicts, type PackagePerson } from "@/lib/guards/import/package";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import { draftGuardImportQuestions } from "@/lib/triage/generators/guard-import";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as ghostCloseRoute } from "@/app/api/triage/sessions/[id]/ghost-close/route";
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

const withList = (nos: string[], hk: string) => ({ listHkids: Object.fromEntries(nos.map((n) => [n, hk])) });

describe("findGhostPersons／packageConflicts（TE-13.2：Opus 五個 probe）", () => {
  const r = () => real(personKeyForHkid(HK), HK, ["U91001"]);
  it("probe 5：淨銀行文件＋名單 HKID 一致 → 併入；packageConflicts 唔再報共用", () => {
    const g = ghost("pkg-g", ["U91001"], withList(["U91001"], HK));
    expect([...findGhostPersons([r(), g])]).toEqual([["pkg-g", { mergedInto: r().key, staffNumbers: expect.any(Array) }]]);
    expect(packageConflicts([r(), g]).get(r().key)).toBeUndefined();
    expect(packageConflicts([r(), g]).get("pkg-g")).toBeUndefined();
  });
  it("probe 1：淨銀行文件但冇名單 HKID → 唔併（舊包），只喺 suspect 模式標疑似", () => {
    const g = ghost("pkg-g", ["U91001"]);
    expect(findGhostPersons([r(), g]).size).toBe(0);
    expect(findGhostPersons([r(), g], { suspect: true }).size).toBe(1);
    expect(packageConflicts([r(), g]).get(r().key)).toContain("staffno_shared_by_persons");
  });
  it("probe 2／3：有入職表頁，或身份證＋入職表頁 → 唔係 ghost（即使名單一致）", () => {
    const L = withList(["U91001"], HK);
    expect(findGhostPersons([r(), ghost("g2", ["U91001"], { ...L, docInfo: { pageCount: 3, pagesByKind: { application_form: 3 } } })], { suspect: true }).size).toBe(0);
    expect(findGhostPersons([r(), ghost("g3", ["U91001"], { ...L, docInfo: { pageCount: 4, pagesByKind: { id_card: 1, application_form: 3 } } })], { suspect: true }).size).toBe(0);
    expect(findGhostPersons([r(), ghost("g5", ["U91001"], { ...L, docInfo: { pageCount: 1, pagesByKind: { printed: 1 } } })], { suspect: true }).size).toBe(0); // TE-13.3：printed 頁（可能係印刷證件副本）唔當 ghost
    expect(findGhostPersons([r(), ghost("g6", ["U91001"], { ...L, docInfo: { pageCount: 2, pagesByKind: { bank: 1, printed: 1 } } })], { suspect: true }).size).toBe(0);
    expect(findGhostPersons([r(), ghost("g4", ["U91001"], { ...L, docInfo: undefined })], { suspect: true }).size).toBe(0); // 冇文件資訊＝唔當 ghost
  });
  it("probe 4：名單 HKID 係另一人 → 唔併（連 suspect 都唔係）", () => {
    expect(findGhostPersons([r(), ghost("g", ["U91001"], withList(["U91001"], HK2))], { suspect: true }).size).toBe(0);
  });
  it("其他唔符合條件：兩個真人共用／真人身份未確認／ghost 有個人欄或 ext／另一工號冇真人", () => {
    const L = withList(["U91001"], HK);
    const r1 = real("r1", HK, ["U91001"]);
    const r2 = real("r2", HK2, ["U91001"]);
    expect(findGhostPersons([r1, r2, ghost("g", ["U91001"], L)]).size).toBe(0);
    expect(findGhostPersons([real("r", HK, ["U91001"], { hkid: F(HK, "review") }), ghost("g", ["U91001"], L)]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001"], { ...L, phone: F("90000011") })]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001"], { ...L, bank: { code: F("024"), name: F(null), accountNo: F("123456789"), payeeName: F("TEST") } as never })]).size).toBe(0);
    expect(findGhostPersons([r1, ghost("g", ["U91001", "U91009"], withList(["U91001", "U91009"], HK))]).size).toBe(0);
    expect(packageConflicts([r1, r2, ghost("g", ["U91001"], L)]).get("r1")).toContain("staffno_shared_by_persons");
  });
});

describe("generator：ghost 自動併入", () => {
  beforeEach(clearAll);
  it("併入：ghost 唔出題；真人唔再有共用題，note 按實際文件種類寫＋合併頁數", async () => {
    const r = real(personKeyForHkid(HK), HK, ["U91001"]);
    const ds = await drafts([r, ghost("pkg-g", ["U91001"], withList(["U91001"], HK))]);
    expect(ds.filter((d) => d.kind === "staffno_shared_by_persons")).toHaveLength(0);
    const nameQ = ds.find((d) => d.kind === "name_not_confirmed")!;
    expect(nameQ.evidence.note).toBe("由 1 頁銀行文件產生嘅空記錄，已自動併入 U91001");
    expect(nameQ.evidence.person.docInfo).toMatchObject({ pageCount: 5, pagesByKind: { id_card: 1, bank: 1 } });
  });
  it("冇名單佐證：照出共用題，ghost 嗰條帶「疑似空記錄」提示；兩個真人共用／名單係另一人照出題", async () => {
    const ds = await drafts([real(personKeyForHkid(HK), HK, ["U91001"]), ghost("pkg-g", ["U91001"])]);
    const sh = ds.filter((d) => d.kind === "staffno_shared_by_persons");
    expect(sh).toHaveLength(2);
    const ghostQ = sh.find((d) => d.evidence.person.nameZh.value === null)!;
    expect(ghostQ.evidence.note).toBe("疑似空記錄（只有 1 頁銀行文件）：冇打字名單身份證佐證，未自動併入，請核對");
    expect(ghostQ.evidence.shared_with![0]).toMatchObject({ hkid_status: "confirmed", staff_numbers: ["U91001"] });
    const two = await drafts([real("r1", HK, ["U91001"]), real("r2", HK2, ["U91001"]), ghost("g", ["U91001"], withList(["U91001"], HK))]);
    expect(two.filter((d) => d.kind === "staffno_shared_by_persons").length).toBeGreaterThanOrEqual(2);
    const other = await drafts([real("r", HK, ["U91001"]), ghost("g", ["U91001"], withList(["U91001"], HK2))]);
    expect(other.filter((d) => d.kind === "staffno_shared_by_persons").length).toBe(2);
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
    const tel = fakeTel();
    const u = await prisma.user.create({ data: { name: "測試會計新", tel, passwordHash: "x", roleId: fx.roleIds["會計"], createdBy: "t" } });
    accountant = await sessionCookieForUser(u.id);
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const call = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id = "x") =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
  const apply = async (persons: PackagePerson[]) => {
    const pkg = { ...pkgOf(persons), version: persons.some((p) => p.listHkids) ? (3 as never) : 2 }; // listHkids 係 v3 欄
    const res = await call(applyRoute as never, "/api/guards/import/apply", accountant, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) });
    return { status: res.status, body: await res.json() };
  };

  it("apply：ghost 唔建人唔出共用題；真人照常處理", async () => {
    const r = await apply([real(personKeyForHkid(HK), HK, ["U91001"]), ghost("pkg-g", ["U91001"], withList(["U91001"], HK))]);
    expect(r.status).toBe(200);
    expect(await prisma.triageQuestion.count({ where: { kind: "staffno_shared_by_persons" } })).toBe(0);
    expect(r.body.persons_total).toBe(1); // ghost 唔計
  });

  it("production 舊題：獨立 ghost-close endpoint 預設 dry；舊題冇 listHkids 唔收；補名單佐證後 dry 列 id、dry_run=0 先真收並逐條 audit；proposals import 唔再收題", async () => {
    const a = await apply([real(personKeyForHkid(HK), HK, ["U91001"]), ghost("pkg-g", ["U91001"], { rating: "review", reasons: [] })]);
    expect(a.status).toBe(200);
    const qs = await prisma.triageQuestion.findMany({ where: { kind: "staffno_shared_by_persons" } });
    expect(qs).toHaveLength(2);
    const sid = qs[0]!.sessionId;
    const gc = async (qs2 = "") => (await call(ghostCloseRoute as never, `/api/triage/sessions/${sid}/ghost-close${qs2}`, accountant, {}, sid)).json();
    for (const q of qs) {
      const ev = q.evidenceJson as unknown as { person: PackagePerson };
      if (ev.person.nameZh.value === null) await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, person: { ...ev.person, rating: "fail", reasons: ["no_id_page"] } } as never } });
    }
    expect((await gc()).count).toBe(0); // 舊題冇 listHkids → 唔收
    for (const q of await prisma.triageQuestion.findMany({ where: { kind: "staffno_shared_by_persons" } })) {
      const ev = q.evidenceJson as unknown as { person: PackagePerson };
      await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, person: { ...ev.person, listHkids: { U91001: HK } } } as never } });
    }
    const dry = await gc(); // 冇 dry_run 參數＝預設 dry
    expect(dry).toMatchObject({ dry_run: true, count: 2 });
    expect(new Set(dry.question_ids)).toEqual(new Set(qs.map((q) => q.id)));
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "open", kind: "staffno_shared_by_persons" } })).toBe(2);
    const pr = await (await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals`, accountant, { version: 1, proposals: [] }, sid)).json();
    expect(pr.ghost_questions_closed).toBeUndefined();
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "open", kind: "staffno_shared_by_persons" } })).toBe(2);
    const live = await gc("?dry_run=0");
    expect(live).toMatchObject({ dry_run: false, count: 2 });
    expect(await prisma.triageQuestion.count({ where: { sessionId: sid, status: "superseded", kind: "staffno_shared_by_persons" } })).toBe(2);
    const audits = await prisma.auditLog.findMany({ where: { action: "triage_ghost_close" } });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.after).toMatchObject({ session_id: sid, rule: "ghost_staffno_shared_v2" });
    expect(new Set(audits.map((x) => x.rowId))).toEqual(new Set(qs.map((q) => q.id)));
    void owner;
  });
});
