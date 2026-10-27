// TR-1：POST /api/triage/sessions/:id/proposals（OCR 重讀建議導入）。全部合成資料（假名／合法 check digit 假 HKID／9100xxxx）。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as proposalsRoute } from "@/app/api/triage/sessions/[id]/proposals/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
import { dispOf, planForQuestion, proposalsBodySchema, submitReason, type Proposal } from "@/lib/triage/proposals";
import { fingerprintInput, fpDiffPaths, fpNormalize } from "@/lib/guards/import/apply";
import { createHash } from "node:crypto";
import { BadRequest, Conflict, Forbidden } from "@/lib/api/errors";
import { insertEvidenceImage, inspectImage } from "@/lib/triage/evidence-images";
import { fakeJpeg } from "./lib/te1-images";

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
      const tel = fakeTel();
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

  it("TR-2 field_review 只有部分欄有建議 → 答有建議嘅欄＋同 tx 開剩餘欄跟進題；重覆上載冪等", async () => {
    const { pc, sid } = await seed();
    const old = await qOf("field_review");
    const dry = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU")], true);
    expect(dry.body).toMatchObject({ dry_run: true, matched_questions: 1, applied: 1, applied_partial: 1, follow_up_created: 1, skipped_partial: 0 });
    expect(await prisma.triageQuestion.count({ where: { groupKey: `${old.groupKey}:rest` } })).toBe(0);
    const r = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU")]);
    expect(r.body).toMatchObject({ dry_run: false, applied: 1, applied_partial: 1, follow_up_created: 1 });
    const done = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: old.id } });
    expect(done.status).toBe("answered");
    expect(Object.keys((done.answerJson as { fields: object }).fields)).toEqual(["nameEn"]);
    const rest = await prisma.triageQuestion.findFirstOrThrow({ where: { groupKey: `${old.groupKey}:rest` } });
    expect(rest.title).toBe(`${old.title}（剩餘欄位）`);
    expect(rest).toMatchObject({ status: "open", kind: "field_review", personKey: old.personKey, sessionId: sid, sort: old.sort, targetGuardId: old.targetGuardId });
    expect((rest.evidenceJson as { review_fields: { field: string }[] }).review_fields.map((x) => x.field)).toEqual(["address"]);
    expect((rest.evidenceJson as { person: { key: string } }).person.key).toBe((old.evidenceJson as { person: { key: string } }).person.key);
    // 再上載同一建議：舊題已答；跟進題只覆核 address → nameEn 唔屬任何 open 題 → no-op，唔重覆開
    const again = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU")]);
    expect(again.body).toMatchObject({ applied: 0, follow_up_created: 0, skipped_field_not_under_review: 1 });
    expect(await prisma.triageQuestion.count({ where: { groupKey: `${old.groupKey}:rest` } })).toBe(1);
    // 剩餘欄之後有建議 → 答 rest 題（全覆蓋，唔再開跟進）
    const second = await send(accountant, sid, [prop(pc.key, "address", "改正地址456號")]);
    expect(second.body).toMatchObject({ applied: 1, applied_partial: 0, follow_up_created: 0 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: rest.id } })).status).toBe("answered");
    // 冪等：同 groupKey 已存在（任何狀態）就唔重覆開
    await prisma.triageQuestion.update({ where: { id: old.id }, data: { status: "open", answeredAt: null, answeredBy: null } });
    const dup = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU")]);
    expect(dup.body).toMatchObject({ applied_partial: 1, follow_up_created: 0 });
    expect(await prisma.triageQuestion.count({ where: { groupKey: `${old.groupKey}:rest` } })).toBe(1);
  });

  it("TR-2 全部覆核欄有建議 → 照舊一題答晒（唔開跟進）", async () => {
    const { pc, sid } = await seed();
    const r = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST CHAU"), prop(pc.key, "address", "改正地址456號")]);
    expect(r.body).toMatchObject({ applied: 1, applied_partial: 0, follow_up_created: 0 });
    expect(await prisma.triageQuestion.count({ where: { groupKey: { endsWith: ":rest" } } })).toBe(0);
  });

  it("TR-2 field_review 覆核欄含 phone：phone 格式唔合法 → 其餘欄答，phone 留跟進題並計 skipped_invalid", () => {
    const ev = { v: 1, person: person({ hkid: H[1] }), reasons: [], candidate_guard_ids: [], review_fields: [{ field: "nameEn", check: "fill" }, { field: "phone", check: "fill" }] };
    const q = { kind: "field_review", evidenceJson: ev as never, optionsJson: [{ id: "apply_fields", label: "x" }] as never };
    const p = planForQuestion(q, new Map([["nameEn", "A B"], ["phone", "12"]]) as never);
    expect(p).toMatchObject({ type: "answer", fields: ["nameEn"], rest: ["phone"], invalidFields: ["phone"], answer: { option: "apply_fields", fields: { nameEn: { action: "confirm", value: "A B" } } } });
    expect(planForQuestion(q, new Map([["phone", "12"]]) as never)).toMatchObject({ type: "skip", disp: "skipped_invalid" });
  });

  it("name_not_confirmed／hkid_not_confirmed：值同題目 evidence 唔一致 → skipped_field_mismatch（只接受「確認」）", async () => {
    const { pa, pb, sid } = await seed();
    const r = await send(accountant, sid, [prop(pa.key, "nameZh", "另一個名"), prop(pb.key, "hkid", H[3]!), prop(pb.key, "nameZh", "導入測試員乙")]);
    expect(r.body).toMatchObject({ applied: 0, skipped_field_mismatch: 3, skipped_value_mismatch: 2, skipped_field_not_under_review: 1 });
    expect((await qOf("name_not_confirmed")).status).toBe("open");
    expect((await qOf("hkid_not_confirmed")).status).toBe("open");
  });

  it("kind 過濾／personKey 唔對：（TE-4：no_id_card 已支援，淨姓名冇 hkid＝唔屬覆核欄）；未知 key（skipped_no_question）；欄位不在覆核欄（field_mismatch）", async () => {
    const { pc, pn, sid } = await seed();
    const r = await send(accountant, sid, [prop(pn.key, "nameZh", "導入測試員無證", { match: { hkid: null, staff_numbers: ["U90003"] } }), prop("00000000-0000-4000-8000-0000000000aa", "nameZh", "冇呢個人"), prop(pc.key, "phone", "91000012")]);
    expect(r.body).toMatchObject({ applied: 0, skipped_kind: 0, skipped_no_question: 1, skipped_field_mismatch: 2, skipped_field_not_under_review: 2, skipped_value_mismatch: 0 });
  });

  it("同人同欄多個唔同值 → skipped_invalid（唔猜）；格式唔合法（dob）→ skipped_invalid；相同重複值當一條", async () => {
    const { pc, sid } = await seed();
    const r1 = await send(accountant, sid, [prop(pc.key, "nameEn", "TEST A"), prop(pc.key, "nameEn", "TEST B"), prop(pc.key, "address", "改正地址456號")], true);
    expect(r1.body).toMatchObject({ applied: 1, applied_partial: 1, skipped_invalid: 2, skipped_partial: 0 });
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
    expect((await send(accountant, sid, [prop(uuid2, "nameZh", "導入測試員無證", { match: { hkid: null, staff_numbers: ["U90003"] } })], true)).body).toMatchObject({ skipped_field_not_under_review: 1 });
  });

  it("N1 身份檢查：match 同題目 evidence 唔一致（身份證／工號）→ skipped_identity_mismatch；冇 match 而 key 只撞 personKey 但 evidence 唔對亦擋；一致先過", async () => {
    const { pa, sid } = await seed();
    const uuid = "11111111-2222-4333-8444-555555555555";
    const ok = { hkid: H[1]!, staff_numbers: ["U90001"] };
    // 推導 key 唔等於題目 personKey（hkid 對唔上）
    expect((await send(accountant, sid, [prop(uuid, "nameZh", "導入測試員甲", { match: { hkid: H[2]!, staff_numbers: ["U90001"] } })], true)).body).toMatchObject({ applied: 0, skipped_identity_mismatch: 1 });
    // key 對得上但工號集合唔同（身份證有 → key 由身份證推，工號唔入 key，但 evidence 工號唔一致）
    expect((await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲", { match: { hkid: H[1]!, staff_numbers: ["U90001", "U99999"] } })], true)).body).toMatchObject({ applied: 0, skipped_identity_mismatch: 1 });
    expect((await send(accountant, sid, [prop(uuid, "nameZh", "導入測試員甲", { match: ok })], true)).body).toMatchObject({ applied: 1, skipped_identity_mismatch: 0 });
    // 冇 match：person_key 直接等於 evidence.person.key 先過；evidence 冇 person.key（舊／缺）→ 擋
    expect((await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲")], true)).body).toMatchObject({ applied: 1 });
    const q = await qOf("name_not_confirmed");
    const ev = q.evidenceJson as { person: Record<string, unknown> };
    await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, person: { ...ev.person, key: "other" } } as never } });
    expect((await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲")], true)).body).toMatchObject({ applied: 0, skipped_identity_mismatch: 1 });
  });

  it("N4 OCR 重讀答嘅題 audit manual_confirmed=false；N3 session 列表帶 can_answer", async () => {
    const { pa, sid } = await seed();
    await send(accountant, sid, [prop(pa.key, "nameZh", "導入測試員甲")]);
    const q = await qOf("name_not_confirmed");
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: q.id } });
    expect((a.after as { manual_confirmed?: boolean }).manual_confirmed).toBe(false);
    const list = await (await listRoute(new Request("http://t/api/triage/sessions?mine=1", { headers: { cookie: accountant } }))).json();
    expect(list.can_answer).toBe(true);
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
    expect(planForQuestion(fr, m([["nameEn", "A B"]]))).toMatchObject({ type: "answer", fields: ["nameEn"], rest: ["phone"] });
    expect(planForQuestion(fr, m([["nameEn", "A B"], ["phone", "12"]]))).toMatchObject({ type: "answer", fields: ["nameEn"], rest: ["phone"], invalidFields: ["phone"] });
    expect(planForQuestion(fr, m([["nameEn", "A B"], ["phone", "91000001"]]))).toMatchObject({ type: "answer", answer: { option: "apply_fields", fields: { nameEn: { action: "confirm", value: "A B" }, phone: { action: "confirm", value: "91000001" } } } });
    expect(planForQuestion(fr, m([["address", "x"]]))).toEqual({ type: "none" });
    const nn = q("name_not_confirmed", ev(), ["use_package_name", "skip"]);
    expect(planForQuestion(nn, m([["nameZh", "導入 測試員甲"]]))).toMatchObject({ type: "answer", answer: { option: "use_package_name" } });
    expect(planForQuestion(nn, m([["nameZh", "冇關係"]]))).toMatchObject({ type: "skip", disp: "skipped_value_mismatch" });
    expect(planForQuestion(nn, m([["hkid", H[1]!]]))).toEqual({ type: "none" });
    const hk = q("hkid_not_confirmed", ev(), ["use_package_hkid", "skip"]);
    expect(planForQuestion(hk, m([["hkid", H[1]!.toLowerCase()]]))).toMatchObject({ type: "answer", answer: { option: "use_package_hkid" } });
    expect(planForQuestion(q("no_id_card", ev(), []), m([["nameZh", "x"]]))).toEqual({ type: "none" });
    expect(planForQuestion(q("tel_only_candidate", ev(), []), m([["nameZh", "x"]]))).toEqual({ type: "none" });
  });

  it("proposalsBodySchema：額外頂層 summary 收得；proposal 多餘欄／缺欄拒", () => {
    const ok = { version: 1, summary: { anything: 1 }, proposals: [prop("k", "phone", "91000001", { doc: "onboarding_form", basis: "arbiter", confidence: "high" })] };
    expect(proposalsBodySchema.safeParse(ok).success).toBe(true);
    expect(proposalsBodySchema.safeParse({ version: 1, proposals: [{ ...ok.proposals[0], extra: 1 }] }).success).toBe(false);
    expect(proposalsBodySchema.safeParse({ version: 2, proposals: [] }).success).toBe(false);
  });

  it("TE-4 no_id_card：嵌入卡 hkid＋姓名＋出生日期 → enter_hkid 帶 extra 建檔；low 信心唔自動答；號碼已屬他人 → skipped_needs_decision（TE-9）", async () => {
    const { pn, pa, sid } = await seed(); // 丑（H[12]）已建檔
    const match = { hkid: null, staff_numbers: ["U90003"] };
    // 無名無證：把 no_id_card 人嘅包內姓名清走，模擬 create_no_name（用 evidence 改）
    const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { kind: "no_id_card" } });
    const ev = qn.evidenceJson as { person: Record<string, unknown> };
    ev.person.nameZh = { value: null, status: "missing" };
    ev.person.nameEn = { value: null, status: "missing" };
    ev.person.dateOfBirth = { value: null, status: "missing" }; // TE-4.2：已確認出生日期唔會被卡覆蓋，所以清走先測補 dob
    await prisma.triageQuestion.update({ where: { id: qn.id }, data: { evidenceJson: ev as never } });
    const NEW = mkHkid("W", "300001");
    // (1) low 信心 → skipped_low_confidence，唔寫
    const low = await send(accountant, sid, [prop(pn.key, "hkid", NEW, { match, confidence: "low", flags: ["printed_card_conflict"] })]);
    expect(low.body).toMatchObject({ applied: 0, skipped_low_confidence: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).status).toBe("open");
    // (1b) TE-9：low 信心（printed_only）但號碼等於系統內一位現有保安員 → 要人一撳連結，計 skipped_needs_decision（唔計低信心）
    const lowOwner = await send(accountant, sid, [prop(pn.key, "hkid", H[12]!, { match, confidence: "low", flags: ["printed_only"] })]);
    expect(lowOwner.body).toMatchObject({ applied: 0, skipped_needs_decision: 1, skipped_low_confidence: 0 });
    // (2) 號碼已屬他人（甲嘅 hkid）→ 身份對唔上，唔寫
    const other = await send(accountant, sid, [prop(pn.key, "hkid", H[12]!, { match }), prop(pn.key, "nameZh", "補名測試員", { match })]);
    expect(other.body).toMatchObject({ applied: 0, skipped_needs_decision: 2 }); // TE-9：號碼屬系統內一位現有保安員 → 要人一撳連結
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H[12]! }, select: { nameZh: true } })).nameZh).toBe("導入測試員丑"); // 丑嘅檔案冇被碰
    // (3) 正常：hkid＋姓名＋出生日期 → 一次過建檔，冇需要人手補姓名
    const ok = await send(accountant, sid, [prop(pn.key, "hkid", NEW, { match, confidence: "high", flags: ["embedded_card", "printed_corroborated"] }), prop(pn.key, "nameZh", "補名測試員", { match }), prop(pn.key, "nameEn", "BO MING", { match }), prop(pn.key, "dateOfBirth", "1991-02-03", { match })]);
    expect(ok.body).toMatchObject({ applied: 1, errors: 0 });
    const q2 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
    expect(q2.status).toBe("answered");
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: NEW }, select: { nameZh: true, nameEn: true, dateOfBirth: true } });
    expect(g.nameZh).toBe("補名測試員");
    expect(g.nameEn).toBe("BO MING");
    expect(g.dateOfBirth?.toISOString().slice(0, 10)).toBe("1991-02-03");
    const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: qn.id } });
    expect((au.after as { extra_names?: string[] }).extra_names).toEqual(["name_zh", "name_en", "dob"]);
    expect(JSON.stringify(ok.body)).not.toContain("補名測試員");
    void pa;
  });
  it("TE-5：同名現有保安員（needs_decision）→ proposals 唔自動答，計 skipped_needs_decision；唔按姓名自動連結", async () => {
    const { pn, sid } = await seed();
    const g = await prisma.guard.create({ data: { nameZh: "補名測試員甲", employmentType: "cash_casual", createdBy: "t" } });
    const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { kind: "no_id_card" } });
    const ev = qn.evidenceJson as { person: Record<string, unknown> };
    ev.person.nameZh = { value: null, status: "missing" };
    ev.person.nameEn = { value: null, status: "missing" };
    await prisma.triageQuestion.update({ where: { id: qn.id }, data: { evidenceJson: ev as never } });
    const match = { hkid: null, staff_numbers: ["U90003"] };
    const NEW = mkHkid("W", "400001");
    const r = await send(accountant, sid, [prop(pn.key, "hkid", NEW, { match }), prop(pn.key, "nameZh", "補名測試員甲", { match })]);
    expect(r.body).toMatchObject({ applied: 0, skipped_needs_decision: 2, errors: 0 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).status).toBe("open");
    expect(await prisma.guard.findUniqueOrThrow({ where: { id: g.id }, select: { hkid: true } })).toEqual({ hkid: null });
  });
  it("TE-11 證件為準：name_not_confirmed 卡 high 同包內唔一致 → enter_name＋extra.name_en 自動答（建檔用卡上名）、圖答題即刪（M5）；medium 留人", async () => {
    const { pa, pb, sid } = await seed();
    const qa = await qOf("name_not_confirmed");
    const plain = fakeJpeg(320, 80, { seed: 951 });
    await insertEvidenceImage(prisma, { sessionId: sid, questionId: null, personKey: qa.personKey!, guardId: null, field: "name_zh", docKind: "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
    const matchA = { hkid: pa.hkid.value, staff_numbers: pa.staffNumbers.map((n) => n.number) };
    // medium → 留人
    const med = await send(accountant, sid, [prop(pa.key, "nameZh", "卡上正確姓名甲", { match: matchA, confidence: "medium" })]);
    expect(med.body).toMatchObject({ applied: 0, skipped_value_mismatch: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qa.id } })).status).toBe("open");
    // high → 卡為準自動答
    const r = await send(accountant, sid, [prop(pa.key, "nameZh", "卡上正確姓名甲", { match: matchA, confidence: "high", flags: ["form_differs"] }), prop(pa.key, "nameEn", "CARD TRUE NAME", { match: matchA, confidence: "high" })]);
    expect(r.body).toMatchObject({ applied: 1, errors: 0 });
    const qa2 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qa.id } });
    expect(qa2.status).toBe("answered");
    expect((qa2.answerJson as { source?: string }).source).toBe("ocr_reread");
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: pa.hkid.value! }, select: { nameZh: true, nameEn: true } });
    expect(g.nameZh).toBe("卡上正確姓名甲");
    expect(g.nameEn).toBe("CARD TRUE NAME");
    // S2：自動答嘅題 audit 記 answered_via＋旗標（淨旗標，唔記值）
    const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: qa.id } });
    expect(au.after).toMatchObject({ answered_via: "ocr_reread", answered_flags: ["form_differs"] });
    expect(JSON.stringify(au.after)).not.toContain("卡上正確姓名甲");
    expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid, personKey: qa.personKey! } })).toBe(0); // M5
    void pb;
  });

  it("TE-11 證件為準：hkid_not_confirmed 卡 hkid（checksum 過、high）同包內唔同 → enter_hkid 自動答；medium 留人", async () => {
    const { pb, sid } = await seed();
    const qb = await qOf("hkid_not_confirmed");
    const matchB = { hkid: pb.hkid.value, staff_numbers: pb.staffNumbers.map((n) => n.number) };
    const NEW = mkHkid("V", "500001");
    const med = await send(accountant, sid, [prop(pb.key, "hkid", NEW, { match: matchB, confidence: "medium" })]);
    expect(med.body).toMatchObject({ applied: 0, skipped_value_mismatch: 1 });
    // 身份決定照舊：卡 hkid 屬系統內另一位現有保安員 → needs_decision 留人（唔自動連／唔自動答）
    const other = await prisma.guard.create({ data: { nameZh: "卡號持有人丙", employmentType: "cash_casual", hkid: NEW, createdBy: "t" } });
    const held = await send(accountant, sid, [prop(pb.key, "hkid", NEW, { match: matchB, confidence: "high" })]);
    expect(held.body).toMatchObject({ applied: 0, skipped_needs_decision: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qb.id } })).status).toBe("open");
    await prisma.guard.delete({ where: { id: other.id } });
    const r = await send(accountant, sid, [prop(pb.key, "hkid", NEW, { match: matchB, confidence: "high" })]);
    expect(r.body).toMatchObject({ applied: 1 });
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qb.id } })).status).toBe("answered");
    expect(await prisma.guard.count({ where: { hkid: NEW } })).toBe(1);
  });
  it("TE-11.4 invalid_reasons：skipped_invalid 唔吞——preview 唔可寫入記原因（唔記值）；dry 同 apply 同一批計數一致", async () => {
    const { pn, sid } = await seed();
    const match = { hkid: null, staff_numbers: ["U90003"] };
    const DUP = mkHkid("T", "900001");
    // 同一個身份證號（canonical）屬兩位保安員（寫法唔同）→ preview 唔可寫入（資料異常）
    await prisma.guard.create({ data: { nameZh: "重複號碼甲", employmentType: "cash_casual", hkid: DUP, createdBy: "t" } });
    await prisma.guard.create({ data: { nameZh: "重複號碼乙", employmentType: "cash_casual", hkid: `${DUP.slice(0, -1)}(${DUP.slice(-1)})`, createdBy: "t" } });
    const props = [prop(pn.key, "hkid", DUP, { match, confidence: "high" })];
    const dry = await send(accountant, sid, props, true);
    const real = await send(accountant, sid, props);
    expect(real.body.applied).toBe(dry.body.applied);
    expect(real.body.skipped_invalid).toBe(1);
    expect(Object.keys(real.body.invalid_reasons)).toHaveLength(1);
    expect(Object.keys(real.body.invalid_reasons)[0]).toMatch(/^preview:/);
    expect(real.body.invalid_reasons).toEqual(dry.body.invalid_reasons);
    expect(JSON.stringify(real.body)).not.toContain(DUP);
    expect(JSON.stringify(real.body)).not.toContain("重複號碼");
  });

  it("TE-11.4 同一人兩條題（name_not_confirmed＋hkid_not_confirmed 各一人）順序自動答：dry 同 apply 計數相同、兩題都 answered", async () => {
    const { pa, pb, sid } = await seed();
    const ma = { hkid: pa.hkid.value, staff_numbers: pa.staffNumbers.map((n) => n.number) };
    const mb = { hkid: pb.hkid.value, staff_numbers: pb.staffNumbers.map((n) => n.number) };
    const NEW = mkHkid("U", "700001");
    const props = [
      prop(pa.key, "nameZh", "卡上正確姓名甲", { match: ma, confidence: "high" }),
      prop(pa.key, "nameEn", "CARD TRUE NAME", { match: ma, confidence: "high" }),
      prop(pb.key, "hkid", NEW, { match: mb, confidence: "high" }),
    ];
    const dry = await send(accountant, sid, props, true);
    const real = await send(accountant, sid, props);
    expect(dry.body).toMatchObject({ applied: 2, skipped_invalid: 0, errors: 0 });
    expect(real.body).toMatchObject({ applied: dry.body.applied, skipped_invalid: 0, errors: 0, resubmitted: 0 });
    expect(real.body.invalid_reasons).toEqual({});
    for (const kind of ["name_not_confirmed", "hkid_not_confirmed"]) expect((await qOf(kind)).status).toBe("answered");
  });
  it("TE-11.5 M1：submitReason 只記 status＋code，唔帶訊息（訊息可能含電話／工號原值）", () => {
    const r = submitReason(BadRequest("電話 91234567 格式唔啱；工號 U90001 重複"));
    expect(r).toBe("submit:400:bad_request");
    expect(r).not.toMatch(/\d{4}|U9/);
    expect(submitReason(Conflict("資料中途變咗"))).toBe("submit:409:conflict");
    expect(submitReason(new Error("x"))).toBe("submit:error");
  });

  it("TE-11.5 指紋穩定：fpNormalize 對陣列做標準排序——同一內容打亂次序（含巢狀）指紋相同；內容唔同指紋唔同", () => {
    const fp = (v: unknown) => createHash("sha256").update(JSON.stringify(fpNormalize(v))).digest("hex");
    const a = { res: { fields: { a: 1 }, ext: [{ k: "x", v: 1 }, { k: "y", v: 2 }, { k: "z", v: 3 }] }, changes: [{ table: "guards", after: { tels: ["91000001", "91000002"], addrs: ["甲", "乙", "丙"] } }, { table: "guard_phones", after: { tel: "91000003" } }] };
    const b = { changes: [{ after: { addrs: ["丙", "甲", "乙"], tels: ["91000002", "91000001"] }, table: "guards" }, { after: { tel: "91000003" }, table: "guard_phones" }].reverse(), res: { ext: [{ v: 3, k: "z" }, { k: "x", v: 1 }, { k: "y", v: 2 }], fields: { a: 1 } } };
    expect(fp(a)).toBe(fp(b));
    expect(fp(a)).not.toBe(fp({ ...a, res: { ...a.res, ext: a.res.ext.slice(1) } }));
    expect(fp([1, 2, 3])).toBe(fp([3, 1, 2]));
    expect(fp([{ id: "x", n: 2 }, { id: "y", n: 1 }])).toBe(fp([{ id: "q", n: 1 }, { id: "r", n: 2 }])); // id 被剝走後只比內容
  });

  it("TE-11.5 去重：同一條題經兩個 person_key（本機 key 同推導 key）各配一次——只答一次，後者計 skipped_duplicate_question；dry 同 apply 一致，apply 冇 409", async () => {
    const { pa, sid } = await seed();
    const ma = { hkid: pa.hkid.value, staff_numbers: pa.staffNumbers.map((n) => n.number) };
    const props = [
      prop(pa.key, "nameZh", "卡上正確姓名甲", { match: ma, confidence: "high" }),
      prop("00000000-0000-4000-8000-0000000000bb", "nameZh", "卡上正確姓名甲", { match: ma, confidence: "high" }), // 另一個本機 key，推導後係同一條題
    ];
    const dry = await send(accountant, sid, props, true);
    const real = await send(accountant, sid, props);
    expect(dry.body).toMatchObject({ applied: 1, skipped_duplicate_question: 1, skipped_invalid: 0 });
    expect(real.body).toMatchObject({ applied: 1, skipped_duplicate_question: 1, skipped_invalid: 0, errors: 0 });
    expect(real.body.invalid_reasons).toEqual({});
    expect((await qOf("name_not_confirmed")).status).toBe("answered");
  });
  it("TE-11.6 fingerprintInput：生成 id／FK／時間戳唔入指紋；同結構兩次必相等；fpDiffPaths 只回路徑＋類型", () => {
    const res = { key: "k", outcome: "created", reasons: [], fields: {}, staff_numbers_added: 1, staff_numbers_skipped: 0, phones_added: 0, addresses_added: 0 } as unknown as Parameters<typeof fingerprintInput>[0];
    const mk = (gid: string, sid: string, ts: string) => [
      { table: "guards", action: "create", rowId: gid, before: null, after: { id: gid, nameZh: "甲", hireDate: "2026-01-01", confirmedAt: ts, createdAt: ts } },
      { table: "guard_staff_numbers", action: "create", rowId: sid, before: null, after: { id: sid, guardRef: gid, number: "A1", confirmed_at: ts } },
      { table: "guard_staff_numbers", action: "update", rowId: sid, before: { guardRef: gid }, after: { number: "A1" } },
    ];
    const a = fingerprintInput(res, mk("g-aaa", "s-aaa", "2026-10-01T00:00:00Z"));
    const b = fingerprintInput(res, mk("g-bbb", "s-bbb", "2026-10-02T09:09:09Z"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toContain("g-aaa");
    // 真有內容差異仍然分得出，而且 diff 只講路徑＋類型
    const c = fingerprintInput(res, mk("g-ccc", "s-ccc", "x").map((x, i) => (i === 0 ? { ...x, after: { ...(x.after as object), nameZh: "乙" } } : x)));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    const paths = fpDiffPaths(a, c);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^changes\[\d\]\.after\.nameZh:value$/);
    expect(paths.join()).not.toContain("乙");
    expect(fpDiffPaths({ x: [1, 2] }, { x: [1] })).toEqual(["x.length"]);
    expect(fpDiffPaths({ x: 1 }, { y: 1 })).toEqual(["x:missing", "y:missing"]);
    expect(fpDiffPaths({ x: 1 }, { x: "1" })).toEqual(["x:type"]);
    expect(submitReason(Object.assign(Conflict("x", { field: "preview_hash", diff_paths: ["res.reasons.length", "bad value!", "changes[1].after.a:value", "a", "b"] }), {}))).toBe("submit:409:conflict:res.reasons.length,changes[1].after.a:value,a");
  });

  it("TE-11.6 同一答案連續預覽兩次（獨立 resolve）：preview_hash 相同（create／enter_hkid／review 姓名）", async () => {
    const pk = person({ hkid: mkHkid("R", "910001"), hkidStatus: "review", name: "待核姓名一", nameStatus: "review", nos: ["U91001"], tel: "91000091" });
    const r0 = await applyPkg(accountant, [pk]);
    const sid = r0.body.triage.session_id as string;
    const m = { hkid: pk.hkid.value, staff_numbers: pk.staffNumbers.map((n) => n.number) };
    const props = [prop(pk.key, "hkid", mkHkid("R", "910002"), { match: m, confidence: "high" })];
    const dry1 = await send(accountant, sid, props, true);
    const dry2 = await send(accountant, sid, props, true);
    expect(dry1.body.applied).toBe(1);
    expect(dry2.body.applied).toBe(1);
    const real = await send(accountant, sid, props);
    expect(real.body.applied).toBe(1);
    expect(real.body.invalid_reasons).toEqual({});
  });
});
