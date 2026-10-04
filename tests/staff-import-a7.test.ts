// WP-STAFF-IMPORT A7：name_only_candidate 輔助判斷 (a)–(e)。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { buildDbIndex, decideMatch, enNameKey, rosterHasStaffNo, type DbGuard, type MatchInput, type RosterEvidence } from "@/lib/guards/import/match";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as previewRoute } from "@/app/api/guards/import/preview/route";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  return base + ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
}
const H1 = mkHkid("A", "123456");
const H2 = mkHkid("B", "234567");

const NAME = "名測試員甲";
const guard = (o: Partial<DbGuard> = {}): DbGuard => ({ id: "g1", nameZh: NAME, hkid: null, tels: [], staffNos: [], dob: null, nameEn: null, ...o });
const base: MatchInput = { staffNos: ["U70001"], hkid: H1, hkidValid: true, hkidConfirmed: true, nameZh: NAME, phone: null, dob: null, nameEn: null, grade: "auto_ok", gradeReasons: [] };
const run = (g: DbGuard[], i: Partial<MatchInput>, roster?: Map<string, RosterEvidence>) => decideMatch({ ...base, ...i }, buildDbIndex(g, roster));

describe("name_only 輔助判斷", () => {
  it("(a) G 有 hkid 且同導入者 confirmed hkid 唔同 → create，same_name_different_hkid；hkid 未 confirmed 就唔用呢條", () => {
    const r = run([guard({ hkid: H2 })], {});
    expect(r).toMatchObject({ action: "create", guardId: null });
    expect(r.reasons).toContain("same_name_different_hkid");
    // 即使 dob 相同，(a) 優先
    expect(run([guard({ hkid: H2, dob: "1990-05-06" })], { dob: "1990-05-06" }).action).toBe("create");
    const unconf = run([guard({ hkid: H2 })], { hkidConfirmed: false });
    expect(unconf.action).toBe("needs_review");
    expect(unconf.reasons).toContain("name_only_candidate");
  });
  it("(b) dob 相同 → link name_dob；唔同 → create same_name_different_dob；導入者 dob 無 → 跌落下一層", () => {
    expect(run([guard({ dob: "1990-05-06" })], { dob: "1990-05-06" })).toMatchObject({ action: "link", guardId: "g1", basis: ["name_dob"] });
    const d = run([guard({ dob: "1990-05-06" })], { dob: "1991-01-01" });
    expect(d.action).toBe("create");
    expect(d.reasons).toContain("same_name_different_dob");
    expect(run([guard({ dob: "1990-05-06" })], { dob: null }).reasons).toContain("name_only_candidate");
    expect(run([guard({ dob: null })], { dob: "1990-05-06" }).reasons).toContain("name_only_candidate");
    // dob 唔同但 hkid 未 confirmed → 唔准 create
    const x = run([guard({ dob: "1990-05-06" })], { dob: "1991-01-01", hkidConfirmed: false });
    expect(x.action).toBe("needs_review");
  });
  it("(c) 更表佐證：工號（正規化＋邊界）或電話", () => {
    const ros = (staffNoRaws: string[], telRaws: string[] = []) => new Map([["g1", { staffNoRaws, telRaws }]]);
    expect(run([guard()], {}, ros(["u 70001"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], {}, ros(["MP55 / U70001"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], {}, ros(["U700015"])).action).toBe("needs_review"); // 邊界：U70001 唔撞 U700015
    expect(run([guard()], { phone: "91234567" }, ros([], ["9123 4567"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], { phone: "91234567" }, ros([], ["91234568"])).action).toBe("needs_review");
    expect(run([guard()], { phone: null }, ros([], ["91234567"])).action).toBe("needs_review");
    expect(rosterHasStaffNo(["U1"], ["U10"])).toBe(false);
  });
  it("(d) 英文名（忽略大小寫／逗號／空白／次序）相同 → link name_en；單一 token 唔算", () => {
    expect(run([guard({ nameEn: "Chan, Tai  Man" })], { nameEn: "TAI MAN CHAN" })).toMatchObject({ action: "link", basis: ["name_en"] });
    expect(run([guard({ nameEn: "CHAN" })], { nameEn: "chan" }).action).toBe("needs_review");
    expect(run([guard({ nameEn: "CHAN TAI MAN" })], { nameEn: "CHAN TAI MING" }).action).toBe("needs_review");
    expect(enNameKey("A, B")).toBe("A B");
  });
  it("(e) 全部冇 → needs_review name_only_candidate；多候選仍 name_multi_candidate", () => {
    expect(run([guard()], {})).toMatchObject({ action: "needs_review", guardId: null, reasons: ["name_only_candidate"] });
    expect(run([guard(), guard({ id: "g2" })], {}).reasons).toEqual(["name_multi_candidate"]);
  });
  it("link 後 candidates 仍係該 guard；冇同名 → create", () => {
    expect(run([], {})).toMatchObject({ action: "create" });
  });
});

describe("preview 預載更表佐證（未作廢上載）", () => {
  let fx: Wp2Fixture;
  let owner: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const pkgPerson = (): PackagePerson =>
    ({
      key: personKeyForHkid(H1),
      hkid: { value: H1, status: "confirmed" },
      nameZh: { value: "測試安員甲", status: "confirmed" },
      nameEn: { value: null, status: "missing" },
      dateOfBirth: { value: null, status: "missing" },
      sex: { value: null, status: "missing" },
      phone: { value: null, status: "missing" },
      address: { value: null, status: "missing" },
      staffNumbers: [{ scheme: "U", number: "U70001" }],
      rating: "auto_ok",
      reasons: [],
      conflicts: [],
    }) as PackagePerson;
  const preview = async () => {
    const pkg = { version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons: [pkgPerson()] };
    const res = await previewRoute(new Request("http://t/x", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ package: pkg }) }));
    expect(hashPackage(importPackageSchema.parse(pkg))).toBeTruthy();
    return (await res.json()).rows[0];
  };
  const upload = (voided: boolean, sha: string) =>
    prisma.rosterUpload.create({
      data: { month: new Date("2026-10-01T00:00:00.000Z"), siteId: fx.site.id, siteNameRaw: "測試盤", uploaderUserId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: sha, fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed", ...(voided ? { voidedAt: new Date() } : {}) },
    });
  const row = (uploadId: string) =>
    prisma.rosterUploadRow.create({ data: { uploadId, rowIndex: 1, workDate: new Date("2026-10-02T00:00:00.000Z"), rawCode: "D", codeKind: "shift", guardId: fx.guardA.id, guardMatch: "by_name", matchBasis: "name_only", staffNoRaw: "u70001" } });

  it("冇佐證 → needs_review；有效上載有佐證 → link＋basis；作廢上載唔計", async () => {
    expect((await preview()).action).toBe("needs_review");
    await row((await upload(true, "sha-a7-void")).id);
    expect((await preview()).action).toBe("needs_review");
    await row((await upload(false, "sha-a7-ok")).id);
    const r = await preview();
    expect(r).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(r.current_name_zh).toBe("測試安員甲");
  });
  it("G 有另一 hkid → create 路徑，reason same_name_different_hkid", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hkid: H2 } });
    const r = await preview();
    expect(r.action).toBe("create");
    expect(r.reasons).toContain("same_name_different_hkid");
  });
});
