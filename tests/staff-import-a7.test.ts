// WP-STAFF-IMPORT A7：name_only_candidate 輔助判斷 (a)–(e)。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { buildDbIndex, decideMatch, rosterHasStaffNo, type DbGuard, type MatchInput, type RosterEvidence } from "@/lib/guards/import/match";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as previewRoute } from "@/app/api/guards/import/preview/route";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  return base + ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
}
const H1 = mkHkid("A", "123456");
const H2 = mkHkid("B", "234567");

const NAME = "名測試員甲";
const guard = (o: Partial<DbGuard> = {}): DbGuard => ({ id: "g1", nameZh: NAME, hkid: null, tels: [], staffNos: [], dob: null, ...o });
const base: MatchInput = { staffNos: ["U70001"], hkid: H1, hkidValid: true, hkidConfirmed: true, nameZh: NAME, nameConfirmed: true, phone: null, dob: null, grade: "auto_ok", gradeReasons: [] };
const run = (g: DbGuard[], i: Partial<MatchInput>, roster?: Map<string, RosterEvidence>) => decideMatch({ ...base, ...i }, buildDbIndex(g, roster));

describe("name_only 輔助判斷", () => {
  it("(a) G 有另一 hkid：導入者 hkid confirmed → create（same_name_different_hkid）", () => {
    const r = run([guard({ hkid: H2 })], {});
    expect(r).toMatchObject({ action: "create", guardId: null });
    expect(r.reasons).toContain("same_name_different_hkid");
    // 即使 dob 相同、更表有佐證，(a) 優先
    const ros = new Map([["g1", { staffNoRaws: ["U70001"], telRaws: [] }]]);
    expect(run([guard({ hkid: H2, dob: "1990-05-06" })], { dob: "1990-05-06" }, ros).action).toBe("create");
  });
  it("(a') G 有另一 hkid、導入者 hkid 未 confirmed → 唔 link，needs_review guard_has_other_hkid_unconfirmed（dob／更表佐證都唔得）", () => {
    const ros = new Map([["g1", { staffNoRaws: ["U70001"], telRaws: [] }]]);
    const r = run([guard({ hkid: H2, dob: "1990-05-06" })], { hkidConfirmed: false, dob: "1990-05-06" }, ros);
    expect(r).toMatchObject({ action: "needs_review", guardId: null });
    expect(r.reasons).toEqual(["guard_has_other_hkid_unconfirmed"]);
  });
  it("(b) dob 相同（導入者 dob confirmed＋nameZh confirmed）→ link name_dob；唔同 → needs_review（唔自動 create）；其中一邊冇 → 跌落下一層", () => {
    expect(run([guard({ dob: "1990-05-06" })], { dob: "1990-05-06" })).toMatchObject({ action: "link", guardId: "g1", basis: ["name_dob"] });
    const d = run([guard({ dob: "1990-05-06" })], { dob: "1991-01-01" });
    expect(d).toMatchObject({ action: "needs_review", guardId: null });
    expect(d.reasons).toEqual(["same_name_different_dob"]);
    expect(run([guard({ dob: "1990-05-06" })], { dob: null }).reasons).toContain("name_only_candidate");
    expect(run([guard({ dob: null })], { dob: "1990-05-06" }).reasons).toContain("name_only_candidate");
  });
  it("(b)(c) 導入者 nameZh 未 confirmed → 唔做輔助 link", () => {
    const ros = new Map([["g1", { staffNoRaws: ["U70001"], telRaws: [] }]]);
    expect(run([guard({ dob: "1990-05-06" })], { dob: "1990-05-06", nameConfirmed: false }, ros)).toMatchObject({ action: "needs_review", reasons: ["name_only_candidate"] });
    expect(run([guard()], { nameConfirmed: false }, ros).action).toBe("needs_review");
    expect(run([guard({ dob: "1990-05-06" })], { dob: "1991-01-01", nameConfirmed: false }).reasons).toEqual(["name_only_candidate"]);
  });
  it("(c) 更表佐證：工號（正規化＋邊界）或電話", () => {
    const ros = (staffNoRaws: string[], telRaws: string[] = []) => new Map([["g1", { staffNoRaws, telRaws }]]);
    expect(run([guard()], {}, ros(["u 70001"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], {}, ros(["MP55 / U70001"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], {}, ros(["U700015"])).action).toBe("needs_review");
    expect(run([guard()], { phone: "91234567" }, ros([], ["9123 4567"]))).toMatchObject({ action: "link", basis: ["name_roster_evidence"] });
    expect(run([guard()], { phone: "91234567" }, ros([], ["91234568"])).action).toBe("needs_review");
    expect(run([guard()], { phone: null }, ros([], ["91234567"])).action).toBe("needs_review");
    expect(rosterHasStaffNo(["U1"], ["U10"])).toBe(false);
  });
  it("(d) 英文名唔再係自動 link 依據", () => {
    const g = { ...guard(), nameEn: "CHAN TAI MAN" } as DbGuard;
    expect(run([g], { ...({ nameEn: "TAI MAN CHAN" } as object) })).toMatchObject({ action: "needs_review", reasons: ["name_only_candidate"] });
  });
  it("(e) 全部冇 → needs_review name_only_candidate；多候選仍 name_multi_candidate；冇同名 → create", () => {
    expect(run([guard()], {})).toMatchObject({ action: "needs_review", guardId: null, reasons: ["name_only_candidate"] });
    expect(run([guard(), guard({ id: "g2" })], {}).reasons).toEqual(["name_multi_candidate"]);
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
  const row = (uploadId: string, guardMatch: "by_name" | "by_staff_no" | "by_name_tel" | "ambiguous" = "by_staff_no", matchBasis: string | null = "staff_no") =>
    prisma.rosterUploadRow.create({ data: { uploadId, rowIndex: 1, workDate: new Date("2026-10-02T00:00:00.000Z"), rawCode: "D", codeKind: "shift", guardId: fx.guardA.id, guardMatch, matchBasis, staffNoRaw: "u70001" } });

  it("冇佐證 → needs_review；作廢上載唔計；by_name／ambiguous 行唔算佐證；by_staff_no／by_name_tel 行 → link＋basis", async () => {
    expect((await preview()).action).toBe("needs_review");
    await row((await upload(true, "sha-a7-void")).id);
    expect((await preview()).action).toBe("needs_review");
    const ok = await upload(false, "sha-a7-ok");
    await row(ok.id, "by_name", "name_only");
    expect((await preview()).action).toBe("needs_review");
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: ok.id } });
    await row(ok.id, "ambiguous", null);
    expect((await preview()).action).toBe("needs_review");
    await prisma.rosterUploadRow.deleteMany({ where: { uploadId: ok.id } });
    await row(ok.id, "by_name_tel", "name_tel");
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
