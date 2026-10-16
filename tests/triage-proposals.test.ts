// TR-1：POST /api/triage/sessions/:id/proposals（OCR 重讀建議導入）。全部合成資料（假名／合法 check digit 假 HKID／9100xxxx）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as proposalsRoute } from "@/app/api/triage/sessions/[id]/proposals/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
import { dispOf, planForQuestion, proposalsBodySchema, type Proposal } from "@/lib/triage/proposals";
import { BadRequest, Conflict, Forbidden } from "@/lib/api/errors";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const H = Array.from({ length: 14 }, (_, i) => mkHkid(String.fromCharCode(65 + i), `10000${i % 10}`));

type St = "confirmed" | "review" | "missing";
const F = (value: string | null, status: St) => (value ? { value, status } : { value: null, status: "missing" as St });
interface P {
  hkid?: string | null;
  hkidStatus?: St;
  name?: string;
  nameStatus?: St;
  tel?: string | null;
  nos?: string[];
  rating?: "auto_ok" | "review" | "fail";
}
function person(o: P): PackagePerson {
  const hk = o.hkid === undefined ? H[0]! : o.hkid;
  return {
    key: personKeyForHkid(hk ?? `none-${o.name ?? "x"}-${(o.nos ?? []).join("")}`),
    hkid: F(hk, o.hkidStatus ?? "confirmed"),
    nameZh: F(o.name ?? "導入測試員甲", o.nameStatus ?? "confirmed"),
    nameEn: F("TEST AYUEN KAP", "review"),
    dateOfBirth: F("1990-05-06", "confirmed"),
    sex: F("M", "confirmed"),
    phone: F(o.tel === undefined ? null : o.tel, "confirmed"),
    address: { ...F("測試道123號測試大廈4樓A室", "review") },
    staffNumbers: (o.nos ?? []).map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })),
    rating: o.rating ?? "auto_ok",
    reasons: [],
    conflicts: [],
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[]) => ({ version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons });

const prop = (person_key: string, field: Proposal["field"], value: string, over: Partial<Proposal> = {}): Proposal => ({ person_key, field, value, basis: "two_reads", doc: field === "address" ? "address_proof" : "id_card", confidence: "medium", ...over });

describe("TR-1 OCR 重讀建議導入", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  let broker: string;

  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    fx = await seedWp2Fixture();
    const mkUser = async (role: "會計" | "主管") => {
      const tel = `6${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
      return (await prisma.user.create({ data: { name: `測試${role}新`, tel, passwordHash: "x", roleId: fx.roleIds[role], createdBy: "t" } })).id;
    };
    fx.userIds["會計"] = await mkUser("會計");
    fx.userIds["主管"] = await mkUser("主管");
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    broker = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  const call = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id: string, raw = false) =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: raw ? (body as string) : JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
  const applyPkg = async (cookie: string, persons: PackagePerson[]) => {
    const pkg = pkgOf(persons);
    const res = await call(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) }, "x");
    return { status: res.status, body: await res.json() };
  };
  const send = async (cookie: string, sid: string, proposals: Proposal[], dry = false) => {
    const res = await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals${dry ? "?dry_run=1" : ""}`, cookie, { version: 1, proposals }, sid);
    return { status: res.status, body: await res.json() };
  };

  /** 種子：name_not_confirmed(甲)／hkid_not_confirmed(乙)／field_review(丑：nameEn＋address)／no_id_card(無證) */
  async function seed() {
    const pa = person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"], tel: "91000001" });
    const pb = person({ hkid: H[2], hkidStatus: "review", name: "導入測試員乙", nos: ["U90002"] });
    const pc = person({ hkid: H[12], name: "導入測試員丑", nos: ["U90012"], tel: "91000012" });
    const pn = person({ hkid: null, name: "導入測試員無證", nos: ["U90003"], rating: "fail" });
    const r = await applyPkg(accountant, [pa, pb, pc, pn]);
    expect(r.status).toBe(200);
    return { pa, pb, pc, pn, sid: r.body.triage.session_id as string };
  }
  const qOf = (kind: string) => prisma.triageQuestion.findFirstOrThrow({ where: { kind } });

  it("dry_run：只計數、唔寫任何嘢（題仍 open、冇新 audit、guard 冇變）", async () => {
    const { pa, pb, pc, sid } = await seed();
    const guards = await prisma.guard.count();
    const audits = await prisma.auditLog.count();
    const r = await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲"), prop(pb.key, "hkid", H[2]!), prop(pc.key, "nameEn", "TEST CHAU"), prop(pc.key, "address", "改正地址456號")], true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dry_run: true, proposals_total: 4, matched_questions: 3, applied: 3, errors: 0, skipped_partial: 0 });
    expect(await prisma.triageQuestion.count({ where: { status: "open" } })).toBe(4);
    expect(await prisma.guard.count()).toBe(guards);
    expect(await prisma.auditLog.count()).toBe(audits);
    // 回應只有計數（冇任何欄位值）
    expect(JSON.stringify(r.body)).not.toContain("導入測試員");
  });

  it("apply：三類題逐題答；answerJson.source=ocr_reread；audit answered_via；session 卡計數；寫入走現有路徑（guard 資料）", async () => {
    const { pa, pb, pc, sid } = await seed();
    const r = await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲"), prop(pb.key, "hkid", H[2]!), prop(pc.key, "nameEn", "TEST CHAU"), prop(pc.key, "address", "改正地址456號")]);
    expect(r.body).toMatchObject({ dry_run: false, matched_questions: 3, applied: 3, errors: 0 });
    for (const kind of ["name_not_confirmed", "hkid_not_confirmed", "field_review"]) {
      const q = await qOf(kind);
      expect(q.status).toBe("answered");
      expect((q.answerJson as { source?: string }).source).toBe("ocr_reread");
      expect(q.answeredBy).toBe(fx.userIds["會計"]);
      const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: q.id } });
      expect((a.after as { answered_via?: string }).answered_via).toBe("ocr_reread");
    }
    // 現有路徑：guards audit 帶 import_via=triage
    const ga = await prisma.auditLog.findMany({ where: { tableName: "guards", action: "create" } });
    expect(ga.some((x) => (x.after as { import_via?: string }).import_via === "triage")).toBe(true);
    const gc = await prisma.guard.findFirstOrThrow({ where: { hkid: H[12] }, include: { addresses: true } });
    expect(gc.nameEn).toBe("TEST CHAU");
    expect(gc.addresses.map((x) => x.address)).toContain("改正地址456號");
    expect(await prisma.guard.count({ where: { hkid: H[1] } })).toBe(1); // 名字確認後建人
    // 整批摘要 audit（淨計數）
    const sum = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_proposals_import" } });
    expect(sum.after).toMatchObject({ applied: 3, answered_via: "ocr_reread" });
    // session 卡：OCR 重讀自動答 3 條；題 view 帶 answer.source
    const list = await (await listRoute(new Request("http://t/api/triage/sessions?mine=1", { headers: { cookie: accountant } }))).json();
    expect(list.sessions.find((x: { id: string }) => x.id === sid).ocr_reread_answered).toBe(3);
    const sv = await (await sessionRoute(new Request(`http://t/api/triage/sessions/${sid}`, { headers: { cookie: accountant } }), { params: Promise.resolve({ id: sid }) } as never)).json();
    expect(sv.questions.filter((x: { answer: { source?: string } | null }) => x.answer?.source === "ocr_reread")).toHaveLength(3);
    // 再上載同一批：全部已答 → 冇 open 題 → no_question
    const again = await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲")]);
    expect(again.body).toMatchObject({ applied: 0, skipped_no_question: 1 });
  });

  it("field_review 只有部分欄有建議 → 整題 skipped_partial（唔答，題仍 open）", async () => {
    const { pc, sid } = await seed();
    const r = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU")]);
    expect(r.body).toMatchObject({ matched_questions: 1, applied: 0, skipped_partial: 1 });
    expect((await qOf("field_review")).status).toBe("open");
  });

  it("name_not_confirmed／hkid_not_confirmed：值同題目 evidence 唔一致 → skipped_field_mismatch（只接受「確認」）", async () => {
    const { pa, pb, sid } = await seed();
    const r = await send(accountant, sid, [prop(pa.key, "nameZh", "另一個名"), prop(pb.key, "hkid", H[3]!), prop(pb.key, "nameZh", "導入測試員乙")]);
    expect(r.body).toMatchObject({ applied: 0, skipped_field_mismatch: 3 });
    expect((await qOf("name_not_confirmed")).status).toBe("open");
    expect((await qOf("hkid_not_confirmed")).status).toBe("open");
  });

  it("kind 過濾／personKey 唔對：no_id_card 等 kind 唔處理（skipped_kind）；未知 key（skipped_no_question）；欄位不在覆核欄（field_mismatch）", async () => {
    const { pc, pn, sid } = await seed();
    const r = await send(accountant, sid, [prop(pn.key, "nameZh", "導入測試員無證", { match: { hkid: null, staff_numbers: ["U90003"] } }), prop("00000000-0000-4000-8000-0000000000aa", "nameZh", "冇呢個人"), prop(pc.key, "phone", "91000012")]);
    expect(r.body).toMatchObject({ applied: 0, skipped_kind: 1, skipped_no_question: 1, skipped_field_mismatch: 1 });
  });

  it("同人同欄多個唔同值 → skipped_invalid（唔猜）；格式唔合法（dob）→ skipped_invalid；相同重複值當一條", async () => {
    const { pc, sid } = await seed();
    const r1 = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST A"), prop(pc.key, "nameEn", "TEST B"), prop(pc.key, "address", "改正地址456號")], true);
    expect(r1.body).toMatchObject({ applied: 0, skipped_invalid: 2, skipped_partial: 1 });
    const r2 = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU"), prop(pc.key, "nameEn", "TEST CHAU"), prop(pc.key, "address", "改正地址456號")], true);
    expect(r2.body).toMatchObject({ applied: 1, skipped_invalid: 0 });
  });

  it("權限：雞頭 403；他人 session 403；老闆可；非 guard_import session 400；壞格式 400；>2000 條 400", async () => {
    const { pa, sid } = await seed();
    expect((await send(broker, sid, [prop(pa.key, "nameZh", "導入測試員甲")])).status).toBe(403);
    expect((await send(supervisor, sid, [prop(pa.key, "nameZh", "導入測試員甲")])).status).toBe(403);
    expect((await send(owner, sid, [prop(pa.key, "nameZh", "導入測試員甲")], true)).status).toBe(200);
    const bad = await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals`, accountant, { version: 1, proposals: [{ person_key: "k", field: "bank", value: "x" }] }, sid);
    expect(bad.status).toBe(400);
    const notJson = await call(proposalsRoute as never, `/api/triage/sessions/${sid}/proposals`, accountant, "{oops", sid, true);
    expect(notJson.status).toBe(400);
    const many = Array.from({ length: 2001 }, (_, i) => prop(`k${i}`, "nameZh", "測試"));
    expect((await send(accountant, sid, many)).status).toBe(400);
    const other = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: "tr1-mc", ownerUserId: fx.userIds["會計"], createdBy: fx.userIds["會計"] } });
    expect((await send(accountant, other.id, [prop(pa.key, "nameZh", "導入測試員甲")])).status).toBe(400);
  });

  it("配對：包內 key 同伺服器 personKey（HMAC）唔同（生產 uuid）→ 用 match（身份證／工號）推返；冇 match 就 no_question", async () => {
    const { sid } = await seed();
    const uuid = "11111111-2222-4333-8444-555555555555";
    const withMatch = prop(uuid, "nameZh", "導入測試員甲", { match: { hkid: H[1]!, staff_numbers: ["U90001"] } });
    expect((await send(accountant, sid, [prop(uuid, "nameZh", "導入測試員甲")], true)).body).toMatchObject({ applied: 0, skipped_no_question: 1 });
    expect((await send(accountant, sid, [withMatch], true)).body).toMatchObject({ applied: 1 });
    // 無身份證者用工號推 key
    const uuid2 = "99999999-2222-4333-8444-555555555555";
    expect((await send(accountant, sid, [prop(uuid2, "nameZh", "導入測試員無證", { match: { hkid: null, staff_numbers: ["U90003"] } })], true)).body).toMatchObject({ skipped_kind: 1 });
  });

  it("restricted／錯誤分類：現有權限 403 → skipped_restricted；4xx → skipped_invalid；其他 → errors（dispOf）", () => {
    expect(dispOf(Forbidden("x"))).toBe("skipped_restricted");
    expect(dispOf(BadRequest("x"))).toBe("skipped_invalid");
    expect(dispOf(Conflict("x"))).toBe("skipped_invalid");
    expect(dispOf(new Error("boom"))).toBe("errors");
  });

  it("planForQuestion 純函數：field_review 全覆蓋／partial／invalid；name／hkid 一致才答", () => {
    const ev = (extra: object = {}) => ({ v: 1, person: person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review" }), reasons: [], candidate_guard_ids: [], ...extra });
    const q = (kind: string, evidence: object, opts: string[]) => ({ kind, evidenceJson: evidence as never, optionsJson: opts.map((id) => ({ id, label: id })) as never });
    const m = (e: [string, string][]) => new Map(e) as never;
    const fr = q("field_review", ev({ review_fields: [{ field: "nameEn", check: "fill" }, { field: "phone", check: "fill" }] }), ["apply_fields", "skip"]);
    expect(planForQuestion(fr, m([["nameEn", "A B"]]))).toMatchObject({ type: "skip", disp: "skipped_partial" });
    expect(planForQuestion(fr, m([["nameEn", "A B"], ["phone", "12"]]))).toMatchObject({ type: "skip", disp: "skipped_invalid" });
    expect(planForQuestion(fr, m([["nameEn", "A B"], ["phone", "91000001"]]))).toMatchObject({ type: "answer", answer: { option: "apply_fields", fields: { nameEn: { action: "confirm", value: "A B" }, phone: { action: "confirm", value: "91000001" } } } });
    expect(planForQuestion(fr, m([["address", "x"]]))).toEqual({ type: "none" });
    const nn = q("name_not_confirmed", ev(), ["use_package_name", "skip"]);
    expect(planForQuestion(nn, m([["nameZh", "導入 測試員甲"]]))).toMatchObject({ type: "answer", answer: { option: "use_package_name" } });
    expect(planForQuestion(nn, m([["nameZh", "冇關係"]]))).toMatchObject({ type: "skip", disp: "skipped_field_mismatch" });
    expect(planForQuestion(nn, m([["hkid", H[1]!]]))).toEqual({ type: "none" });
    const hk = q("hkid_not_confirmed", ev(), ["use_package_hkid", "skip"]);
    expect(planForQuestion(hk, m([["hkid", H[1]!.toLowerCase()]]))).toMatchObject({ type: "answer", answer: { option: "use_package_hkid" } });
    expect(planForQuestion(q("no_id_card", ev(), []), m([["nameZh", "x"]]))).toEqual({ type: "none" });
  });

  it("proposalsBodySchema：額外頂層 summary 收得；proposal 多餘欄／缺欄拒", () => {
    const ok = { version: 1, summary: { anything: 1 }, proposals: [prop("k", "phone", "91000001", { doc: "onboarding_form", basis: "arbiter", confidence: "high" })] };
    expect(proposalsBodySchema.safeParse(ok).success).toBe(true);
    expect(proposalsBodySchema.safeParse({ version: 1, proposals: [{ ...ok.proposals[0], extra: 1 }] }).success).toBe(false);
    expect(proposalsBodySchema.safeParse({ version: 2, proposals: [] }).success).toBe(false);
  });
});
