// TE-13.1：共用工號／電話題，人冇 confirmed 身份證 → drop_shared 變 dropped（可確認、唔建人）；有身份證照舊 create；keep 無 HKID 擋＋enter_hkid 可用。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { auditOpenGap } from "../scripts/staff-import/lib/open-gap-audit";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const HK = mkHkid("S", "800001");
const HK_B = mkHkid("T", "800002");
type St = "confirmed" | "review" | "missing";
const F = (v: string | null, s: St = "confirmed") => (v ? { value: v, status: s } : { value: null, status: "missing" as St });
function person(key: string, o: { hkid?: string | null; name?: string | null; tel: string; no: string }): PackagePerson {
  return {
    key, hkid: F(o.hkid ?? null), nameZh: F(o.name ?? null), nameEn: F(null), dateOfBirth: F(null), sex: F(null), phone: F(o.tel), address: F(null),
    staffNumbers: [{ scheme: "U", number: o.no }], rating: "review", reasons: ["extract_fail", "hkid_missing", "name_missing"],
  } as PackagePerson;
}

describe("TE-13.1 drop_shared 卡死修正", () => {
  let accountant: string;
  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    const fx = await seedWp2Fixture();
    const tel = `6${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    accountant = await sessionCookieForUser((await prisma.user.create({ data: { name: "測試會計新", tel, passwordHash: "x", roleId: fx.roleIds["會計"], createdBy: "t" } })).id);
  });
  const post = (route: (r: Request, c: never) => Promise<Response>, url: string, body: unknown, id = "x") =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie: accountant }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
  const apply = async (persons: PackagePerson[]) => {
    const pkg = { version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons };
    const res = await post(applyRoute as never, "/api/guards/import/apply", { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) });
    expect(res.status).toBe(200);
  };
  const preview = async (qid: string, ans: unknown) => (await post(previewRoute as never, `/api/triage/questions/${qid}/preview`, { answer: ans }, qid)).json();
  const answer = (qid: string, ans: unknown, hash: string) => post(answerRoute as never, `/api/triage/questions/${qid}/answer`, { answer: ans, preview_hash: hash }, qid);
  const qFor = async (kind: string, no: string) => (await prisma.triageQuestion.findMany({ where: { kind } })).find((q) => JSON.stringify((q.evidenceJson as { person: { staffNumbers: unknown } }).person.staffNumbers).includes(no))!;

  it("電話共用、兩人都冇身份證：drop_shared → dropped，可確認，唔建人，題目 answered，audit 記 option", async () => {
    await apply([person("pa", { tel: "90000031", no: "U91031" }), person("pb", { tel: "90000031", no: "U91032" })]);
    const q = await qFor("dup_tel_across_persons", "U91031");
    expect((q.optionsJson as { id: string }[]).map((o) => o.id)).toEqual(expect.arrayContaining(["keep", "drop_shared", "enter_hkid"]));
    const pv = await preview(q.id, { option: "drop_shared" });
    expect(pv.impact.can_confirm).toBe(true);
    expect(pv.impact.summary[0]).toContain("唔會建人");
    expect(pv.impact.needs_decision).toBeUndefined();
    const guardsBefore = await prisma.guard.count();
    const res = await answer(q.id, { option: "drop_shared" }, pv.preview_hash);
    expect(res.status).toBe(200);
    expect(await prisma.guard.count()).toBe(guardsBefore);
    const after = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.status).toBe("answered");
    expect(after.applyResultJson).toMatchObject({ outcome: "dropped" });
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "triage_questions", rowId: q.id, action: "triage_answer" } });
    expect(audit?.after).toMatchObject({ option: "drop_shared", outcome: "dropped", writes: false });
    // preview_hash 唔啱 → 409
    const bad = await answer((await qFor("dup_tel_across_persons", "U91032")).id, { option: "drop_shared" }, "x".repeat(64));
    expect(bad.status).toBe(409);
  });

  it("keep 對冇身份證嘅人：仍然擋，講明要先輸入身份證號；enter_hkid 可用", async () => {
    await apply([person("pa", { tel: "90000033", no: "U91033" }), person("pb", { tel: "90000033", no: "U91034" })]);
    const q = await qFor("dup_tel_across_persons", "U91033");
    const pv = await preview(q.id, { option: "keep" });
    expect(pv.impact.can_confirm).toBe(false);
    expect(pv.impact.reason_text).toContain("要先輸入身份證號先可以建人");
    const pe = await preview(q.id, { option: "enter_hkid", value: HK });
    expect(pe.impact.reason_text ?? "").not.toContain("要先輸入身份證號先可以建人");
  });

  it("S3：舊題（options 冇 enter_hkid）揀 keep → reason_text 改請揀剔走或補身份證後重新導入", async () => {
    await apply([person("pa", { tel: "90000037", no: "U91037" }), person("pb", { tel: "90000037", no: "U91038" })]);
    const q = await qFor("dup_tel_across_persons", "U91037");
    await prisma.triageQuestion.update({ where: { id: q.id }, data: { optionsJson: (q.optionsJson as { id: string }[]).filter((o) => o.id !== "enter_hkid") as never } });
    const pv = await preview(q.id, { option: "keep" });
    expect(pv.impact.can_confirm).toBe(false);
    expect(pv.impact.reason_text).toBe("請揀「唔係呢個人嘅（剔走）」，或者喺人卡補身份證後重新導入");
  });

  it("有 confirmed 身份證：drop_shared 照舊行 create 路徑（唔係 dropped）", async () => {
    await apply([person("pa", { hkid: HK, name: "導入測試員甲", tel: "90000035", no: "U91035" }), person("pb", { hkid: HK_B, name: "導入測試員乙", tel: "90000035", no: "U91036" })]);
    const q = await qFor("dup_tel_across_persons", "U91035");
    expect((q.optionsJson as { id: string }[]).map((o) => o.id)).not.toContain("enter_hkid");
    const pv = await preview(q.id, { option: "drop_shared" });
    expect(pv.impact.summary[0] ?? "").not.toContain("唔會建人");
    expect(pv.impact.changes.some((c: { action: string; table: string }) => c.table === "guards" && c.action === "create")).toBe(true);
  });
});

describe("24-open-gap-audit：drop_shared_stuck", () => {
  it("共用題而包內人冇 confirmed 有效身份證 → drop_shared_stuck（帶題目 id）；有身份證 → 照舊", () => {
    const lf = (value: string | null, status: St) => ({ value, status });
    const pp = (key: string, no: string, hk: string | null, st: St) => ({ key, hkid: lf(hk, st), nameZh: lf(null, "missing"), nameEn: lf(null, "missing"), dateOfBirth: lf(null, "missing"), phone: lf(null, "missing"), address: lf(null, "missing"), staffNumbers: [{ number: no }], rating: "fail", reasons: [] }) as never;
    const rows = auditOpenGap(
      [
        { id: "q1", person_key: "x1", staff_numbers: ["U91041"], kind: "dup_tel_across_persons" },
        { id: "q2", person_key: "x2", staff_numbers: ["U91042"], kind: "staffno_shared_by_persons" },
        { id: "q3", person_key: "x3", staff_numbers: ["U91043"], kind: "staffno_shared_by_persons" },
      ],
      [pp("x1", "U91041", null, "missing"), pp("x2", "U91042", "ZZ", "review"), pp("x3", "U91043", HK, "confirmed")],
      [],
      [],
    );
    expect(rows.find((r) => r.id === "q1")).toMatchObject({ category: "drop_shared_stuck", reason: "hkid_missing" });
    expect(rows.find((r) => r.id === "q2")).toMatchObject({ category: "drop_shared_stuck", reason: "hkid_not_confirmed" });
    expect(rows.find((r) => r.id === "q3")).toMatchObject({ category: "kind_unsupported" });
  });
});
