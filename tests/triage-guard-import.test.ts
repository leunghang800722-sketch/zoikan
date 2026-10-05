// WP-AI-OPS §28.4：導入後對話式分診（規則出題／冪等／權限／預覽＝寫入／唯一性／跳過／audit）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「導入測試員X」）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { POST as reassignRoute } from "@/app/api/triage/sessions/[id]/reassign/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import { draftGuardImportQuestions } from "@/lib/triage/generators/guard-import";
import { getNavLinks, groupNavLinks } from "@/lib/rbac/nav";
import { MODULES, ROLE_NAMES, isGrantedByDefault, isHardDenied, type Module, type RoleName } from "@/lib/rbac/matrix";
import type { CurrentSession } from "@/lib/auth/current-session";

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
  conflicts?: string[];
  rating?: "auto_ok" | "review" | "fail";
  addr?: string | null;
  dob?: string | null;
  dobStatus?: St;
}
function person(o: P): PackagePerson {
  const hk = o.hkid === undefined ? H[0]! : o.hkid;
  return {
    key: personKeyForHkid(hk ?? `none-${o.name ?? "x"}-${(o.nos ?? []).join("")}`),
    hkid: F(hk, o.hkidStatus ?? "confirmed"),
    nameZh: F(o.name ?? "導入測試員甲", o.nameStatus ?? "confirmed"),
    nameEn: F("TEST AYUEN KAP", "review"),
    dateOfBirth: o.dob === null ? F(null, "missing") : F(o.dob ?? "1990-05-06", o.dobStatus ?? "confirmed"),
    sex: F("M", "confirmed"),
    phone: F(o.tel === undefined ? null : o.tel, "confirmed"),
    address: o.addr === null ? F(null, "missing") : { ...F(o.addr ?? "測試道123號測試大廈4樓A室", "review") },
    staffNumbers: (o.nos ?? []).map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })),
    rating: o.rating ?? "auto_ok",
    reasons: [],
    conflicts: o.conflicts ?? [],
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[]) => ({ version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons });

describe("WP-AI-OPS §28.4 導入後對話式分診", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  let broker: string;
  let guardCk: string;

  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    fx = await seedWp2Fixture();
    // 每個 test 用全新嘅會計／主管（非老闆每日導入次數按 audit 計，全局固定用戶會跨 test 累積）
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
    guardCk = await sessionCookieForUser(fx.userIds["安員"]);
  });

  const post = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id?: string) =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: id ?? "x" }) } as never);
  const get = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, id?: string) =>
    route(new Request(`http://t${url}`, { headers: { cookie } }), { params: Promise.resolve({ id: id ?? "x" }) } as never);

  const applyPkg = async (cookie: string, persons: PackagePerson[]) => {
    const pkg = pkgOf(persons);
    const res = await post(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) });
    return { status: res.status, body: await res.json(), pkg };
  };
  const qOfKind = async (kind: string) => {
    const q = await prisma.triageQuestion.findFirst({ where: { kind }, orderBy: { sort: "asc" } });
    expect(q, `kind ${kind}`).not.toBeNull();
    return q!;
  };
  const preview = (cookie: string, qid: string, answer: unknown) => post(previewRoute as never, `/api/triage/questions/${qid}/preview`, cookie, { answer }, qid);
  const answer = (cookie: string, qid: string, ans: unknown, hash?: string) => post(answerRoute as never, `/api/triage/questions/${qid}/answer`, cookie, { answer: ans, ...(hash ? { preview_hash: hash } : {}) }, qid);
  const confirm = async (cookie: string, qid: string, ans: unknown) => {
    const pv = await (await preview(cookie, qid, ans)).json();
    return { pv, res: await answer(cookie, qid, ans, pv.preview_hash) };
  };

  async function seedMixed() {
    const gName = await prisma.guard.create({ data: { nameZh: "導入測試員丙", employmentType: "cash_casual", createdBy: "t" } });
    const gTel = await prisma.guard.create({ data: { nameZh: "測試另一名", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardPhone.create({ data: { guardId: gTel.id, tel: "91000005", isPrimary: true } });
    const gDb = await prisma.guard.create({ data: { nameZh: "測試現有戊", employmentType: "cash_casual", hkid: H[11]!, createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: gDb.id, scheme: "U", number: "U90010", status: "current" } });
    const persons = [
      person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"], tel: "91000001" }), // name_not_confirmed
      person({ hkid: H[2], hkidStatus: "review", name: "導入測試員乙", nos: ["U90002"] }), // hkid_not_confirmed
      person({ hkid: null, name: "導入測試員無證", nos: ["U90003"], rating: "fail" }), // no_id_card
      person({ hkid: H[3], name: "導入測試員丙", nos: ["U90004"], tel: "91000004" }), // name_only_candidate
      person({ hkid: H[4], name: "導入測試員丁", nos: ["U90005"], tel: "91000005" }), // tel_only_candidate
      person({ hkid: H[5], name: "導入測試員己", nos: ["U90006"], tel: "91000006" }), // staffno shared
      person({ hkid: H[6], name: "導入測試員庚", nos: ["U90006"], tel: "91000007" }),
      person({ hkid: H[7], name: "導入測試員辛", nos: ["U90007"], tel: "91000009" }), // tel shared
      person({ hkid: H[8], name: "導入測試員壬", nos: ["U90008"], tel: "91000009" }),
      person({ hkid: H[9], name: "導入測試員癸", nos: ["U90009"], conflicts: ["group_name_differs"] }), // group_name_differs
      person({ hkid: H[10], name: "導入測試員子", nos: ["U90010"] }), // db_conflict（工號屬另一 hkid）
      person({ hkid: H[12], name: "導入測試員丑", nos: ["U90012"], tel: "91000012" }), // 自動建 → field_review
    ];
    return { persons, gName, gTel, gDb };
  }

  it("出題：各類別齊（規則產生）；自動項照常寫入；回傳 triage 摘要；題目 payload 唔含 hkid 以外多餘欄", async () => {
    const { persons } = await seedMixed();
    const r = await applyPkg(accountant, persons);
    expect(r.status).toBe(200);
    expect(r.body.triage.session_id).toBeTruthy();
    const qs = await prisma.triageQuestion.findMany({});
    const kinds = qs.map((q) => q.kind).sort();
    expect(kinds).toEqual(
      [
        "name_not_confirmed",
        "hkid_not_confirmed",
        "no_id_card",
        "name_only_candidate",
        "tel_only_candidate",
        "staffno_shared_by_persons",
        "staffno_shared_by_persons",
        "dup_tel_across_persons",
        "dup_tel_across_persons",
        "group_name_differs",
        "db_conflict",
        "field_review",
      ].sort(),
    );
    expect(r.body.triage.open_questions).toBe(12);
    expect(r.body.triage.total_questions).toBe(12);
    // 自動項已寫入（H12 被建）；有問題嘅人冇被自動建
    expect(await prisma.guard.count({ where: { hkid: H[12] } })).toBe(1);
    expect(await prisma.guard.count({ where: { hkid: H[1] } })).toBe(0);
    expect(await prisma.guard.count({ where: { hkid: H[5] } })).toBe(0);
    const s = await prisma.triageSession.findFirstOrThrow({});
    expect(s.ownerUserId).toBe(fx.userIds["會計"]);
    expect(s.sourceType).toBe("guard_import");
    // 每題都有「跳過」選項；link 選項帶候選
    for (const q of qs) expect((q.optionsJson as { id: string }[]).some((o) => o.id === "skip")).toBe(true);
    const nameOnly = await qOfKind("name_only_candidate");
    expect((nameOnly.optionsJson as { id: string }[]).map((o) => o.id)).toEqual(["link", "create_new", "skip"]);
  });

  it("冪等：同一個 package_hash 再上載唔重複開 session／題目；已答嘅唔再出", async () => {
    const { persons } = await seedMixed();
    const r1 = await applyPkg(accountant, persons);
    const n1 = await prisma.triageQuestion.count();
    const r2 = await applyPkg(accountant, persons);
    expect(r2.body.triage.session_id).toBe(r1.body.triage.session_id);
    expect(await prisma.triageSession.count()).toBe(1);
    expect(await prisma.triageQuestion.count()).toBe(n1);
    // 答一條 → 再上載 → 仍然 answered，總數不變
    const q = await qOfKind("name_not_confirmed");
    const { res } = await confirm(accountant, q.id, { option: "use_package_name" });
    expect(res.status).toBe(200);
    const r3 = await applyPkg(accountant, persons);
    expect(await prisma.triageQuestion.count()).toBe(n1);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
    expect(r3.body.triage.new_questions).toBe(0);
    expect(r3.body.triage.open_questions).toBe(r1.body.triage.open_questions - 1);
  });

  it("generator 純函數：冇需要人手嘅人唔出題", () => {
    expect(draftGuardImportQuestions(pkgOf([]), [])).toEqual([]);
  });

  it("權限：會計／主管只見自己嗰批；攞人哋 session／question 回 403；老闆見全部；轉交；雞頭／安員 403", async () => {
    const a = await applyPkg(accountant, [person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] })]);
    const b = await applyPkg(supervisor, [person({ hkid: H[2], name: "導入測試員乙", nameStatus: "review", nos: ["U90002"] })]);
    const sa = a.body.triage.session_id as string;
    const sb = b.body.triage.session_id as string;
    expect(sa).not.toBe(sb);
    const listA = await (await get(listRoute as never, "/api/triage/sessions?mine=1", accountant)).json();
    expect(listA.sessions.map((s: { id: string }) => s.id)).toEqual([sa]);
    expect(listA.open_total).toBe(1);
    const listBoss = await (await get(listRoute as never, "/api/triage/sessions", owner)).json();
    expect(listBoss.sessions.map((s: { id: string }) => s.id).sort()).toEqual([sa, sb].sort());
    expect(listBoss.open_total).toBe(2);
    // 他人 session
    expect((await get(sessionRoute as never, `/api/triage/sessions/${sb}`, accountant, sb)).status).toBe(403);
    expect((await get(sessionRoute as never, `/api/triage/sessions/${sa}`, supervisor, sa)).status).toBe(403);
    expect((await get(sessionRoute as never, `/api/triage/sessions/${sa}`, owner, sa)).status).toBe(200);
    expect((await get(sessionRoute as never, `/api/triage/sessions/${"00000000-0000-4000-8000-000000000000"}`, owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const qb = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sb } });
    expect((await preview(accountant, qb.id, { option: "skip" })).status).toBe(403);
    expect((await answer(accountant, qb.id, { option: "skip" })).status).toBe(403);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qb.id } })).status).toBe("open");
    // 非老闆轉交 403
    expect((await post(reassignRoute as never, `/api/triage/sessions/${sa}/reassign`, accountant, { owner_user_id: fx.userIds["主管"] }, sa)).status).toBe(403);
    // 轉交對象唔合資格（雞頭）→ 400
    expect((await post(reassignRoute as never, `/api/triage/sessions/${sa}/reassign`, owner, { owner_user_id: fx.userIds["雞頭"] }, sa)).status).toBe(400);
    // 老闆轉交 sa 俾主管
    expect((await post(reassignRoute as never, `/api/triage/sessions/${sa}/reassign`, owner, { owner_user_id: fx.userIds["主管"] }, sa)).status).toBe(200);
    expect((await get(sessionRoute as never, `/api/triage/sessions/${sa}`, supervisor, sa)).status).toBe(200);
    expect((await get(sessionRoute as never, `/api/triage/sessions/${sa}`, accountant, sa)).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: "triage_reassign", rowId: sa } })).toBe(1);
    // 雞頭／安員
    for (const c of [broker, guardCk]) {
      expect((await get(listRoute as never, "/api/triage/sessions", c)).status).toBe(403);
      expect((await get(sessionRoute as never, `/api/triage/sessions/${sa}`, c, sa)).status).toBe(403);
      expect((await preview(c, qb.id, { option: "skip" })).status).toBe(403);
      expect((await post(reassignRoute as never, `/api/triage/sessions/${sa}/reassign`, c, { owner_user_id: fx.userIds["主管"] }, sa)).status).toBe(403);
    }
  });

  it("遮罩：冇「安員個人資料」權限（主管出廠）睇唔到完整 hkid／出生日期／地址；有權限（會計）睇到", async () => {
    const pk = [person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"], tel: "91000001" })];
    const a = await applyPkg(accountant, pk);
    const sid = a.body.triage.session_id as string;
    await prisma.triageSession.update({ where: { id: sid }, data: { ownerUserId: fx.userIds["主管"] } });
    const supText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    for (const secret of [H[1]!, "1990-05-06", "測試道123號測試大廈4樓A室", "91000001"]) expect(supText).not.toContain(secret);
    expect(supText).toContain("導入測試員甲");
    const bossText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).text();
    for (const secret of [H[1]!, "1990-05-06", "測試道123號測試大廈4樓A室"]) expect(bossText).toContain(secret);
    // 影響預覽同樣遮罩
    const q = await qOfKind("name_not_confirmed");
    const pvSup = await (await preview(supervisor, q.id, { option: "use_package_name" })).text();
    expect(pvSup).not.toContain(H[1]!);
    expect(pvSup).not.toContain("1990-05-06");
  });

  it("預覽＝實際寫入：預覽唔寫任何嘢；確認後寫入同預覽一致；只寫 confirmed 欄；audit 記邊個答；已答唔可以再套用", async () => {
    const { persons, gName } = await seedMixed();
    await applyPkg(accountant, persons);
    const q = await qOfKind("name_only_candidate");
    const ans = { option: "link", guard_id: gName.id };
    const guardsBefore = await prisma.guard.count();
    const auditBefore = await prisma.auditLog.count();
    const pv = await (await preview(accountant, q.id, ans)).json();
    expect(pv.writes).toBe(true);
    expect(pv.impact.can_confirm).toBe(true);
    expect(pv.impact.changes.find((c: { table: string }) => c.table === "guards")).toBeTruthy();
    expect(await prisma.guard.count()).toBe(guardsBefore);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gName.id } })).hkid).toBeNull();
    // 冇 hash／錯 hash → 唔寫
    expect((await answer(accountant, q.id, ans)).status).toBe(400);
    expect((await answer(accountant, q.id, ans, "a".repeat(64))).status).toBe(409);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gName.id } })).hkid).toBeNull();
    // 確認
    const res = await answer(accountant, q.id, ans, pv.preview_hash);
    expect(res.status).toBe(200);
    const g = await prisma.guard.findUniqueOrThrow({ where: { id: gName.id }, include: { phones: true, staffNumbers: true } });
    expect(g.hkid).toBe(H[3]); // 補空欄
    expect(g.nameZh).toBe("導入測試員丙");
    expect(g.dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-05-06");
    expect(g.nameEn).toBeNull(); // review 欄唔寫
    expect(g.phones.map((p) => p.tel)).toEqual(["91000004"]);
    expect(g.staffNumbers.map((s) => s.number)).toEqual(["U90004"]);
    const row = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.status).toBe("answered");
    expect(row.answeredBy).toBe(fx.userIds["會計"]);
    expect(await prisma.auditLog.count({ where: { action: "triage_answer", rowId: q.id, actorUserId: fx.userIds["會計"] } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tableName: "guards", rowId: g.id, action: "update", actorUserId: fx.userIds["會計"] } })).toBe(1);
    // 已答唔可以重複套用
    expect((await answer(accountant, q.id, ans, pv.preview_hash)).status).toBe(409);
    expect((await preview(accountant, q.id, ans)).status).toBe(409);
    expect(await prisma.guard.count()).toBe(guardsBefore);
    // audit 內冇 PII
    const aud = await prisma.auditLog.findMany({ where: { action: "triage_answer" } });
    expect(JSON.stringify(aud)).not.toContain(H[3]!);
  });

  it("資料中途變咗：確認時指紋唔一致 → 409、不寫入、題目仍然 open", async () => {
    const { persons, gName } = await seedMixed();
    await applyPkg(accountant, persons);
    const q = await qOfKind("name_only_candidate");
    const ans = { option: "link", guard_id: gName.id };
    const pv = await (await preview(accountant, q.id, ans)).json();
    // 預覽之後有人手改咗該安員：加咗另一個電話（影響會變）／改咗出生日期
    await prisma.guard.update({ where: { id: gName.id }, data: { dateOfBirth: new Date("1985-01-01T00:00:00.000Z") } });
    const res = await answer(accountant, q.id, ans, pv.preview_hash);
    expect(res.status).toBe(409);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gName.id } })).hkid).toBeNull();
    expect(await prisma.guardPhone.count({ where: { guardId: gName.id } })).toBe(0);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("open");
    // 重新預覽就得
    const pv2 = await (await preview(accountant, q.id, ans)).json();
    expect(pv2.preview_hash).not.toBe(pv.preview_hash);
    expect((await answer(accountant, q.id, ans, pv2.preview_hash)).status).toBe(200);
    // 現有出生日期唔覆蓋
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gName.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-01-01");
  });

  it("唯一性：身份證已屬另一安員 → 預覽 can_confirm=false，強行確認 422／409，不寫入；唔合法 hkid 400；電話撞號只標 conflict", async () => {
    const { persons } = await seedMixed();
    await applyPkg(accountant, persons);
    const other = await prisma.guard.create({ data: { nameZh: "測試持有人", employmentType: "cash_casual", hkid: H[13]!, createdBy: "t" } });
    const q = await qOfKind("hkid_not_confirmed");
    // 唔合法
    expect((await preview(accountant, q.id, { option: "enter_hkid", value: "Z9999999" })).status).toBe(400);
    // Minor-1：hkid 屬「非候選」現有安員，姓名唔同 → 422（留返人手）
    const r422 = await preview(accountant, q.id, { option: "enter_hkid", value: H[13]! });
    expect(r422.status).toBe(422);
    expect(await prisma.guard.count({ where: { hkid: H[13] } })).toBe(1);
    // 姓名完全相同先准，並帶警告
    await prisma.guard.update({ where: { id: other.id }, data: { nameZh: "導入測試員乙" } });
    const pv = await (await preview(accountant, q.id, { option: "enter_hkid", value: H[13]! })).json();
    expect(pv.impact.notes.join()).toContain("唔喺候選名單");
    expect(pv.writes).toBe(true); // 連去 hkid 擁有人（唔會建重複）
    expect(await prisma.guard.count({ where: { hkid: H[13] } })).toBe(1);
    await answer(accountant, q.id, { option: "enter_hkid", value: H[13]! }, pv.preview_hash);
    expect(await prisma.guard.count({ where: { hkid: H[13] } })).toBe(1);
    expect(await prisma.guardStaffNumber.count({ where: { guardId: other.id, number: "U90002" } })).toBe(1);
    // forced create 但 hkid 已屬他人 → 唔准
    const q2 = await qOfKind("name_only_candidate");
    await prisma.guard.update({ where: { id: other.id }, data: { hkid: H[3] } }); // 令 H3 已有主
    const pv2 = await (await preview(accountant, q2.id, { option: "create_new" })).json();
    expect(pv2.writes).toBe(false);
    expect(pv2.impact.can_confirm).toBe(false);
    const res = await answer(accountant, q2.id, { option: "create_new" }, pv2.preview_hash);
    expect(res.status).toBe(422);
    expect(await prisma.guard.count({ where: { hkid: H[3] } })).toBe(1);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q2.id } })).status).toBe("open");
  });

  it("link 選項只可以揀候選；link 去 hkid 矛盾嘅人 → 唔寫", async () => {
    const { persons, gName } = await seedMixed();
    await applyPkg(accountant, persons);
    const q = await qOfKind("name_only_candidate");
    const stranger = await prisma.guard.create({ data: { nameZh: "測試路人", employmentType: "cash_casual", createdBy: "t" } });
    expect((await preview(accountant, q.id, { option: "link", guard_id: stranger.id })).status).toBe(400);
    // 候選本身有另一個 hkid（預覽後被人手加）→ conflict，唔寫
    await prisma.guard.update({ where: { id: gName.id }, data: { hkid: H[13] } });
    const pv = await (await preview(accountant, q.id, { option: "link", guard_id: gName.id })).json();
    expect(pv.writes).toBe(false);
    expect((await answer(accountant, q.id, { option: "link", guard_id: gName.id }, pv.preview_hash)).status).toBe(422);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gName.id } })).hkid).toBe(H[13]);
  });

  it("新開一個（create_new）：姓名未確認自動標待核對；hkid 未確認 → enter_hkid 後行同一條建人路徑", async () => {
    const { persons } = await seedMixed();
    await applyPkg(accountant, persons);
    const qa = await qOfKind("name_only_candidate");
    expect((await confirm(accountant, qa.id, { option: "create_new" })).res.status).toBe(200);
    const created = await prisma.guard.findFirstOrThrow({ where: { hkid: H[3] } });
    expect(created.nameZh).toBe("導入測試員丙");
    // 姓名未確認 → keep_pending
    const qn = await qOfKind("name_not_confirmed");
    const r = await confirm(accountant, qn.id, { option: "keep_pending" });
    expect(r.res.status).toBe(200);
    const g1 = await prisma.guard.findFirstOrThrow({ where: { hkid: H[1] } });
    expect(g1.identityReviewFields).toEqual(["name_zh"]);
    // hkid 未確認 + 輸入
    const qh = await qOfKind("hkid_not_confirmed");
    expect((await confirm(accountant, qh.id, { option: "use_package_hkid" })).res.status).toBe(200);
    const g2 = await prisma.guard.findFirstOrThrow({ where: { hkid: H[2] } });
    expect(g2.nameZh).toBe("導入測試員乙");
    // 冇身份證 → 輸入合法 hkid
    const qi = await qOfKind("no_id_card");
    expect((await confirm(accountant, qi.id, { option: "enter_hkid", value: ` ${H[13]!.slice(0, 7)}(${H[13]!.slice(7)}) ` })).res.status).toBe(200);
    expect(await prisma.guard.count({ where: { hkid: H[13] } })).toBe(1);
  });

  it("工號／電話共用：drop_shared 唔寫爭議工號；keep 照包內；跳過留返人手", async () => {
    const { persons } = await seedMixed();
    await applyPkg(accountant, persons);
    const qs = await prisma.triageQuestion.findMany({ where: { kind: "staffno_shared_by_persons" }, orderBy: { sort: "asc" } });
    expect(qs.length).toBe(2);
    expect((await confirm(accountant, qs[0]!.id, { option: "drop_shared" })).res.status).toBe(200);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H[5] }, include: { staffNumbers: true } });
    expect(g.staffNumbers.length).toBe(0);
    expect((await confirm(accountant, qs[1]!.id, { option: "keep" })).res.status).toBe(200);
    const g2 = await prisma.guard.findFirstOrThrow({ where: { hkid: H[6] }, include: { staffNumbers: true } });
    expect(g2.staffNumbers.map((s) => s.number)).toEqual(["U90006"]);
    // 電話共用：第一個 keep 寫入；第二個 keep 被唯一性擋住（唔重複）
    const ts = await prisma.triageQuestion.findMany({ where: { kind: "dup_tel_across_persons" }, orderBy: { sort: "asc" } });
    expect((await confirm(accountant, ts[0]!.id, { option: "keep" })).res.status).toBe(200);
    // 第二個人：電話已屬第一個人（唔同 hkid）→ keep 唔會寫（唯一性），要揀 drop_shared
    const second = await confirm(accountant, ts[1]!.id, { option: "keep" });
    expect(second.pv.writes).toBe(false);
    expect(second.res.status).toBe(422);
    expect((await confirm(accountant, ts[1]!.id, { option: "drop_shared" })).res.status).toBe(200);
    expect(await prisma.guardPhone.count({ where: { tel: "91000009" } })).toBe(1);
    // group_name_differs：用導入包姓名
    const gq = await qOfKind("group_name_differs");
    expect((await confirm(accountant, gq.id, { option: "use_package_name" })).res.status).toBe(200);
    expect(await prisma.guard.count({ where: { hkid: H[9] } })).toBe(1);
  });

  it("db_conflict 只可以跳過；不合法選項 400", async () => {
    const { persons } = await seedMixed();
    await applyPkg(accountant, persons);
    const q = await qOfKind("db_conflict");
    expect((await preview(accountant, q.id, { option: "keep" })).status).toBe(400);
    expect((await preview(accountant, q.id, { option: "create_new" })).status).toBe(400);
    expect((await preview(accountant, q.id, { option: "zzz" })).status).toBe(400);
    expect((await answer(accountant, q.id, { option: "skip" })).status).toBe(200);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("skipped");
  });

  it("逐欄 review：確認／改正／略過；地址寫入；唔合法值 400；全部答晒 session done；跳過 audit", async () => {
    const r = await applyPkg(accountant, [person({ hkid: H[12], name: "導入測試員丑", nos: ["U90012"], tel: "91000012" })]);
    expect(r.body.triage.open_questions).toBe(1);
    const q = await qOfKind("field_review");
    const ev = q.evidenceJson as { review_fields: { field: string }[] };
    expect(ev.review_fields.map((f) => f.field).sort()).toEqual(["address", "nameEn"]);
    // 唔屬於呢題嘅欄／唔合法值
    expect((await preview(accountant, q.id, { option: "apply_fields", fields: { phone: { action: "confirm" } } })).status).toBe(400);
    expect((await preview(accountant, q.id, { option: "apply_fields", fields: {} })).status).toBe(400);
    const ans = { option: "apply_fields", fields: { address: { action: "confirm", value: "改正地址456號" }, nameEn: { action: "skip" } } };
    const pv = await (await preview(accountant, q.id, ans)).json();
    expect(pv.writes).toBe(true);
    expect(pv.impact.field_outcomes.map((x: { field: string; outcome: string }) => `${x.field}:${x.outcome}`)).toContain("address:會寫入");
    expect((await answer(accountant, q.id, ans, pv.preview_hash)).status).toBe(200);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H[12] }, include: { addresses: true } });
    expect(g.addresses.map((a) => [a.address, a.source])).toEqual([["改正地址456號", "address_proof"]]);
    expect(g.nameEn).toBeNull();
    const s = await prisma.triageSession.findFirstOrThrow({});
    expect(s.status).toBe("done");
    expect(s.completedAt).not.toBeNull();
  });

  it("跳過：唔寫任何嘢，只標 skipped＋audit；跳過嘅可以之後再答", async () => {
    const { persons, gName } = await seedMixed();
    await applyPkg(accountant, persons);
    const q = await qOfKind("name_only_candidate");
    const before = await prisma.guard.count();
    const res = await answer(accountant, q.id, { option: "skip" });
    expect(res.status).toBe(200);
    expect(await prisma.guard.count()).toBe(before);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("skipped");
    expect(await prisma.auditLog.count({ where: { action: "triage_answer", rowId: q.id } })).toBe(1);
    const { res: res2 } = await confirm(accountant, q.id, { option: "link", guard_id: gName.id });
    expect(res2.status).toBe(200);
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("answered");
  });

  it("冇題目就唔開 session；ai.audit_log 唔含 triage 表嘅 audit；triage 表唔喺 ai schema", async () => {
    const r = await applyPkg(accountant, [person({ hkid: H[1], name: "導入測試員甲", addr: null, nos: ["U90001"], tel: "91000001" }), ]);
    // nameEn 係 review → 仍然會有 field_review；改用冇 review 欄嘅人
    void r;
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    const p = person({ hkid: H[2], name: "導入測試員乙", addr: null, nos: ["U90002"], tel: "91000002" });
    p.nameEn = F(null, "missing") as never;
    const r2 = await applyPkg(accountant, [p]);
    expect(r2.body.triage).toBeNull();
    expect(await prisma.triageSession.count()).toBe(0);
    const tbl = await prisma.$queryRaw<{ table_schema: string }[]>`SELECT table_schema FROM information_schema.tables WHERE table_name IN ('triage_sessions','triage_questions')`;
    expect(tbl.map((t) => t.table_schema)).toEqual(["public", "public"]);
    const views = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema = 'ai' AND view_definition ILIKE '%triage%'`;
    // ai.audit_log 本身以 NOT IN 排除 triage 表（定義內出現 triage 字眼）；冇其他 ai view 提及
    expect(views[0]!.n).toBe(1);
  });

  it("矩陣：導入分診／安員批量導入——老闆／會計／主管出廠 grant；雞頭／安員硬性拒", () => {
    for (const mod of ["導入分診", "安員批量導入"] as const) {
      for (const role of ["老闆", "會計", "主管"] as RoleName[]) {
        expect(isGrantedByDefault(role, mod, "view")).toBe(true);
        expect(isGrantedByDefault(role, mod, "update")).toBe(true);
      }
      for (const role of ["雞頭", "安員"] as RoleName[]) for (const a of ["view", "create", "update", "void", "export"] as const) expect(isHardDenied(role, mod, a)).toBe(true);
    }
  });

  it("導航：會計／主管見到「證件資料導入」「待答問題」；「每月修正摘要」跟月結總表 view；雞頭見唔到", async () => {
    const allGrants = Object.fromEntries(MODULES.map((m) => [m, true])) as Record<Module, boolean>;
    const mk = (baseRole: RoleName) => ({ userId: "u", roleId: "r", roleName: baseRole, baseRole, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString(), mustChangePwd: false }) as unknown as CurrentSession;
    for (const role of ["會計", "主管"] as RoleName[]) {
      const grants = Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault(role, m, "view")])) as Record<Module, boolean>;
      const hrefs = (await getNavLinks(mk(role), grants)).map((l) => l.href);
      expect(hrefs).toContain("/triage");
      expect(hrefs).toContain("/guards/import");
      // 每月修正摘要＝module「月結總表」view：會計出廠有、主管出廠關（老闆可開）
      expect(hrefs.includes("/reports/ops-digest")).toBe(role === "會計");
    }
    const links = await getNavLinks(mk("老闆"), allGrants);
    const groups = groupNavLinks("老闆", links);
    expect(groups.some((g) => g.title === "其他")).toBe(false); // 新連結都已入分組
    void ROLE_NAMES;
    const brokerGrants = Object.fromEntries(MODULES.map((m) => [m, isGrantedByDefault("雞頭", m, "view")])) as Record<Module, boolean>;
    const brokerHrefs = (await getNavLinks(mk("雞頭"), brokerGrants)).map((l) => l.href);
    for (const h of ["/triage", "/guards/import", "/reports/ops-digest"]) expect(brokerHrefs).not.toContain(h);
  });

  // ---------------------------------------------------------------------------
  // 驗收修正（Opus 5.5）
  // ---------------------------------------------------------------------------
  const SECRETS = (h: string) => [h, "1990-05-06", "91000004", "測試道123號測試大廈4樓A室", "改正地址456號"];

  it("Blocker-1：主管上載、老闆答 link → 主管讀 session／list 都冇未遮罩 hkid／出生日期／電話／地址；老闆讀到完整", async () => {
    const gName = await prisma.guard.create({ data: { nameZh: "導入測試員丙", employmentType: "cash_casual", createdBy: "t" } });
    const a = await applyPkg(supervisor, [person({ hkid: H[3], name: "導入測試員丙", nos: ["U90004"], tel: "91000004" })]);
    const sid = a.body.triage.session_id as string;
    const q = await qOfKind("name_only_candidate");
    const { res } = await confirm(owner, q.id, { option: "link", guard_id: gName.id });
    expect(res.status).toBe(200);
    const supText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    for (const secret of SECRETS(H[3]!)) expect(supText).not.toContain(secret);
    const supBody = JSON.parse(supText);
    expect(supBody.questions[0].impact.summary.length).toBeGreaterThan(0); // 仍然有 impact，只係遮罩
    expect(JSON.stringify(supBody.questions[0].impact)).not.toContain(gName.id); // guard_id 對冇 PII view 嘅人剝走
    const bossText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).text();
    expect(bossText).toContain(H[3]!);
    // 答題回應本身（主管視角）亦冇
    const q2 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(JSON.stringify(q2.impactJson)).toContain(H[3]!); // DB 存原始值（受權限保護）
  });

  it("Blocker-1：會計答、老闆轉交主管 → 主管讀唔到未遮罩值", async () => {
    const gName = await prisma.guard.create({ data: { nameZh: "導入測試員丙", employmentType: "cash_casual", createdBy: "t" } });
    const a = await applyPkg(accountant, [person({ hkid: H[3], name: "導入測試員丙", nos: ["U90004"], tel: "91000004" })]);
    const sid = a.body.triage.session_id as string;
    const q = await qOfKind("name_only_candidate");
    const { res } = await confirm(accountant, q.id, { option: "link", guard_id: gName.id });
    expect(res.status).toBe(200);
    const accText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, accountant, sid)).text();
    expect(accText).toContain(H[3]!);
    expect((await post(reassignRoute as never, `/api/triage/sessions/${sid}/reassign`, owner, { owner_user_id: fx.userIds["主管"] }, sid)).status).toBe(200);
    const supText = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    for (const secret of SECRETS(H[3]!)) expect(supText).not.toContain(secret);
  });

  it("Major-1(a)：冇「安員個人資料:view」，導入 preview／apply 回應剝走逐欄現值比較；有權限照舊", async () => {
    await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    const pkg = pkgOf([person({ hkid: H[1], name: "導入測試員甲", nos: ["U90001"] })]);
    const call = (c: string) => post((async (r: Request) => (await import("@/app/api/guards/import/preview/route")).POST(r)) as never, "/api/guards/import/preview", c, { package: pkg });
    const sup = await (await call(supervisor)).json();
    const acc = await (await call(accountant)).json();
    expect(sup.rows[0].fields.hkid.check).toBe("hidden");
    expect(acc.rows[0].fields.hkid.check).toBe("same");
    const ap = await applyPkg(supervisor, pkg.persons);
    expect(ap.body.results[0].fields.hkid).toBe("not_written");
  });

  it("Major-1(b)：冇「安員個人資料:update」唔准覆蓋現有唔同出生日期／地址（403、題目 open、冇寫入）；老闆可以", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, dateOfBirth: new Date("1985-01-01T00:00:00.000Z"), createdBy: "t" } });
    const a = await applyPkg(supervisor, [person({ hkid: H[1], name: "導入測試員甲", nos: ["U90001"], dobStatus: "review" })]);
    expect(a.body.triage.open_questions).toBe(1);
    const q = await qOfKind("field_review");
    const ans = { option: "apply_fields", fields: { dateOfBirth: { action: "replace", value: "1990-05-06" } } };
    const r = await preview(supervisor, q.id, ans);
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).toContain("安員個人資料修改權限");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-01-01");
    // 確認包內值（唔覆蓋）主管得
    const ok = await confirm(supervisor, q.id, { option: "apply_fields", fields: { nameEn: { action: "skip" }, dateOfBirth: { action: "confirm" } } });
    expect(ok.res.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-01-01"); // 現值唔同 → conflict 唔覆蓋
  });

  it("Major-1(b)：老闆可以 replace；apply 帶 decisions replace 出生日期，主管 403、老闆 200", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, dateOfBirth: new Date("1985-01-01T00:00:00.000Z"), createdBy: "t" } });
    const p = person({ hkid: H[1], name: "導入測試員甲", nos: ["U90001"], dobStatus: "review" });
    const a = await applyPkg(accountant, [p]);
    expect(a.body.triage.open_questions).toBe(1);
    const q = await qOfKind("field_review");
    const { res } = await confirm(owner, q.id, { option: "apply_fields", fields: { dateOfBirth: { action: "replace", value: "1990-05-06" } } });
    expect(res.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-05-06");
    const pkg = pkgOf([p]);
    const body = { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions: { [p.key]: { date_of_birth: { action: "replace", value: "1999-01-01" } } } };
    const blocked = await post(applyRoute as never, "/api/guards/import/apply", supervisor, body);
    expect(blocked.status).toBe(200); // 逐人標記，唔再成個請求 403
    expect(JSON.stringify((await blocked.json()).results)).toContain("overwrite_forbidden");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-05-06");
    expect((await post(applyRoute as never, "/api/guards/import/apply", owner, body)).status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).dateOfBirth?.toISOString().slice(0, 10)).toBe("1999-01-01");
  });

  it("Major-1(c)：非老闆每包最多 500 人（preview／apply 400）；老闆唔受限", async () => {
    const many = Array.from({ length: 501 }, (_, i) => {
      const hk = mkHkid("K", String(100000 + i));
      return person({ hkid: hk, name: `導入測試員${i}`, nos: [] });
    });
    const pkg = pkgOf(many);
    const pv = (c: string) => post((async (r: Request) => (await import("@/app/api/guards/import/preview/route")).POST(r)) as never, "/api/guards/import/preview", c, { package: pkg });
    expect((await pv(accountant)).status).toBe(400);
    expect((await pv(supervisor)).status).toBe(400);
    expect((await post(applyRoute as never, "/api/guards/import/apply", accountant, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) })).status).toBe(400);
    expect((await pv(owner)).status).toBe(200);
  }, 60000);

  it("Minor-3：第二個用戶上載同一個包 → triage 回 owned_by_other，唔回 session 內容；新題入咗第一個擁有人嘅 session", async () => {
    const pk = [person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] })];
    const a = await applyPkg(accountant, pk);
    const b = await applyPkg(supervisor, pk);
    expect(b.body.triage).toEqual({ owned_by_other: true, new_questions: 0 });
    expect(a.body.triage.session_id).toBeTruthy();
    expect(await prisma.triageSession.count()).toBe(1);
  });

  it("兩層：要人手／衝突（重要）先，補充資料（field_review）後；badge／open_total 淨計重要", async () => {
    const { persons } = await seedMixed();
    const r = await applyPkg(accountant, persons);
    expect(r.body.triage.important_open).toBe(11);
    expect(r.body.triage.supplementary_open).toBe(1);
    const sid = r.body.triage.session_id as string;
    const body = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}?status=open`, accountant, sid)).json();
    expect(body.questions[body.questions.length - 1].kind).toBe("field_review");
    expect(body.questions.slice(0, -1).every((x: { kind: string }) => x.kind !== "field_review")).toBe(true);
    expect(body.session.counts).toMatchObject({ important_open: 11, supplementary_open: 1, open: 12 });
    const list = await (await get(listRoute as never, "/api/triage/sessions?mine=1", accountant)).json();
    expect(list.open_total).toBe(11);
    expect(list.open_supplementary).toBe(1);
    expect(list.sessions[0].counts).toMatchObject({ important_open: 11, supplementary_open: 1 });
  });

  // ---------------------------------------------------------------------------
  // 第二輪覆核修正
  // ---------------------------------------------------------------------------
  const previewRoute0 = async (c: string, pkg: unknown) => (await import("@/app/api/guards/import/preview/route")).POST(new Request("http://t/api/guards/import/preview", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify({ package: pkg }) }));

  it("M1a-1：冇 PII view 用現有 hkid＋錯名查唔到現有姓名（只回旗、basis 只回類別）；同名先回；有 PII view 照舊", async () => {
    await prisma.guard.create({ data: { nameZh: "測試現有甲", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    const wrong = pkgOf([person({ hkid: H[1], name: "導入測試員錯", nos: [] })]);
    const sup = await (await previewRoute0(supervisor, wrong)).text();
    expect(sup).not.toContain("測試現有甲");
    const sb = JSON.parse(sup);
    expect(sb.rows[0].current_name_zh).toBeNull();
    expect(sb.rows[0].current_name_hidden).toBe(true);
    expect(sb.rows[0].basis).not.toContain("hkid");
    expect(sb.rows[0].basis).toContain("identity_key");
    const acc = JSON.parse(await (await previewRoute0(accountant, wrong)).text());
    expect(acc.rows[0].current_name_zh).toBe("測試現有甲");
    expect(acc.rows[0].basis).toContain("hkid");
    const same = JSON.parse(await (await previewRoute0(supervisor, pkgOf([person({ hkid: H[1], name: "測試現有甲", nos: [] })]))).text());
    expect(same.rows[0].current_name_zh).toBe("測試現有甲");
    expect(same.rows[0].current_name_hidden).toBe(false);
  });

  it("M1a-1：分診候選——經 hkid 對中而姓名唔同嘅現有安員，冇 PII view 唔回名；經工號對中嘅照顯示", async () => {
    await prisma.guard.create({ data: { nameZh: "測試甲現有", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    const b = await prisma.guard.create({ data: { nameZh: "測試乙現有", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: b.id, scheme: "U", number: "U90020", status: "current" } });
    const a = await applyPkg(supervisor, [person({ hkid: H[1], name: "導入測試員錯", nos: ["U90020"] })]);
    const sid = a.body.triage.session_id as string;
    const q = await qOfKind("db_conflict");
    expect(q).toBeTruthy();
    const text = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    expect(text).not.toContain("測試甲現有");
    expect(text).toContain("測試乙現有");
    const boss = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).text();
    expect(boss).toContain("測試甲現有");
  });

  it("M1a-2：冇「安員個人資料:update」改正有現值嘅出生日期，新值＝現值／≠現值都係 403（無現值先可補）；outcome 只分已補上／冇寫入", async () => {
    await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, dateOfBirth: new Date("1985-01-01T00:00:00.000Z"), createdBy: "t" } });
    await prisma.guard.create({ data: { nameZh: "導入測試員乙", employmentType: "cash_casual", hkid: H[2]!, createdBy: "t" } });
    await applyPkg(supervisor, [person({ hkid: H[1], name: "導入測試員甲", nos: ["U90001"], dobStatus: "review" }), person({ hkid: H[2], name: "導入測試員乙", nos: ["U90002"], dobStatus: "review" })]);
    const qs = await prisma.triageQuestion.findMany({ where: { kind: "field_review" }, orderBy: { sort: "asc" } });
    expect(qs.length).toBe(2);
    const withDob = qs[0]!;
    const noDob = qs[1]!;
    for (const v of ["1985-01-01", "1990-05-06", "1999-09-09"]) {
      expect((await preview(supervisor, withDob.id, { option: "apply_fields", fields: { dateOfBirth: { action: "replace", value: v } } })).status).toBe(403);
    }
    expect((await preview(supervisor, noDob.id, { option: "apply_fields", fields: { dateOfBirth: { action: "replace", value: "1999-09-09" } } })).status).toBe(200);
    const outcome = async (c: string, q: { id: string }) => (await (await preview(c, q.id, { option: "apply_fields", fields: { dateOfBirth: { action: "confirm" } } })).json()).impact.field_outcomes.find((x: { field: string }) => x.field === "dateOfBirth").outcome;
    expect(await outcome(supervisor, withDob)).toBe("冇寫入（已有資料）");
    expect(await outcome(supervisor, noDob)).toBe("會補上（原本空）");
    expect(await outcome(owner, withDob)).toContain("唔同");
  });

  it("第 3 點：姓名 replace 要「安員:update」——會計 403、主管 200；批量導入 decisions 同樣", async () => {
    const ga = await prisma.guard.create({ data: { nameZh: "測試舊名甲", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    const gb = await prisma.guard.create({ data: { nameZh: "測試舊名乙", employmentType: "cash_casual", hkid: H[2]!, createdBy: "t" } });
    await applyPkg(accountant, [person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] })]);
    await applyPkg(supervisor, [person({ hkid: H[2], name: "導入測試員乙", nameStatus: "review", nos: ["U90002"] })]);
    const qa = await prisma.triageQuestion.findFirstOrThrow({ where: { session: { ownerUserId: fx.userIds["會計"] }, kind: "field_review" } });
    const qb = await prisma.triageQuestion.findFirstOrThrow({ where: { session: { ownerUserId: fx.userIds["主管"] }, kind: "field_review" } });
    const ans = { option: "apply_fields", fields: { nameZh: { action: "replace" } } };
    expect((await preview(accountant, qa.id, ans)).status).toBe(403);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: ga.id } })).nameZh).toBe("測試舊名甲");
    const ok = await confirm(supervisor, qb.id, ans);
    expect(ok.res.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gb.id } })).nameZh).toBe("導入測試員乙");
    const p = person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] });
    const pkg = pkgOf([p]);
    const body = { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions: { [p.key]: { name_zh: { action: "replace" } } } };
    const r = await post(applyRoute as never, "/api/guards/import/apply", accountant, body);
    expect(r.status).toBe(200);
    expect(JSON.stringify((await r.json()).results)).toContain("overwrite_forbidden");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: ga.id } })).nameZh).toBe("測試舊名甲");
  });

  it("硬標記：經導入／分診寫嘅 guards audit 帶 after.import_via（guard_import／triage）", async () => {
    await applyPkg(owner, [person({ hkid: H[12], name: "導入測試員丑", nos: ["U90012"] })]);
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H[12] } });
    const a1 = await prisma.auditLog.findFirstOrThrow({ where: { tableName: "guards", rowId: g.id, action: "create" } });
    expect((a1.after as Record<string, unknown>).import_via).toBe("guard_import");
    const q = await qOfKind("field_review");
    const { res } = await confirm(owner, q.id, { option: "apply_fields", fields: { nameEn: { action: "confirm" } } });
    expect(res.status).toBe(200);
    const ups = await prisma.auditLog.findMany({ where: { tableName: "guards", rowId: g.id, action: "update" } });
    expect(ups.length).toBeGreaterThan(0);
    for (const u of ups) expect((u.after as Record<string, unknown>).import_via).toBe("triage");
    // PII 唔因標記入到 ai.audit_log
    const ai = await prisma.$queryRaw<{ after: unknown }[]>`SELECT after FROM ai.audit_log WHERE table_name = 'guards' AND row_id = ${g.id}`;
    expect(JSON.stringify(ai)).not.toContain(H[12]!);
  });

  // ---------------------------------------------------------------------------
  // 第三輪覆核：結構性封死
  // ---------------------------------------------------------------------------
  const EXIST = { tel: "91000077", addr: "現有地址1號", en: "EXISTING EN", dob: "1985-01-01" };
  async function seedExisting() {
    const g = await prisma.guard.create({ data: { nameZh: "導入測試員甲", nameEn: EXIST.en, employmentType: "cash_casual", hkid: H[1]!, dateOfBirth: new Date(`${EXIST.dob}T00:00:00.000Z`), createdBy: "t" } });
    await prisma.guardPhone.create({ data: { guardId: g.id, tel: EXIST.tel, isPrimary: true } });
    await prisma.guardAddress.create({ data: { guardId: g.id, address: EXIST.addr, isPrimary: true } });
    return g;
  }
  type DV = { dob: string; addr: string; tel: string; en: string };
  const RIGHT: DV = { dob: EXIST.dob, addr: EXIST.addr, tel: EXIST.tel, en: EXIST.en };
  const WRONG: Record<string, DV> = {
    dob: { ...RIGHT, dob: "1999-09-09" },
    addr: { ...RIGHT, addr: "別處地址2號" },
    tel: { ...RIGHT, tel: "91000088" },
    en: { ...RIGHT, en: "OTHER EN" },
  };
  const dp = (v: DV, st: St): PackagePerson => {
    const p = person({ hkid: H[1], name: "導入測試員甲", nos: [] });
    p.nameEn = F(v.en, st) as never;
    p.dateOfBirth = F(v.dob, st) as never;
    p.phone = F(v.tel, st) as never;
    p.address = { ...F(v.addr, st) } as never;
    return p;
  };
  // 因輸入而異嘅欄（上載者自己提交嘅值嘅回顯／hash）——差分比較時明確豁免
  const stripPreview = (b: Record<string, unknown>) => {
    const c = JSON.parse(JSON.stringify(b)) as { package_hash?: string; rows: Record<string, unknown>[] };
    delete c.package_hash; // 由輸入包決定
    for (const r of c.rows) for (const k of ["name_en", "phone_masked", "address_masked"]) delete r[k]; // 上載者自己提交嘅值
    return c;
  };

  it("差分（核心）：冇 PII view 嘅主管，preview 估啱／估錯（出生日期、地址、電話、英文名）整個回應 JSON 一樣；有 PII view 嘅會計睇到分別", async () => {
    await seedExisting();
    const base = stripPreview(await (await previewRoute0(supervisor, pkgOf([dp(RIGHT, "confirmed")]))).json());
    for (const [f, v] of Object.entries(WRONG)) {
      const got = stripPreview(await (await previewRoute0(supervisor, pkgOf([dp(v, "confirmed")]))).json());
      expect(got, `preview ${f}`).toEqual(base);
    }
    const accRight = await (await previewRoute0(accountant, pkgOf([dp(RIGHT, "confirmed")]))).json();
    const accWrong = await (await previewRoute0(accountant, pkgOf([dp(WRONG.dob!, "confirmed")]))).json();
    expect(accRight.auto_apply.field_conflicts).toBe(0);
    expect(accWrong.auto_apply.field_conflicts).toBeGreaterThan(0);
  });

  it("差分（核心）：apply（自動項）估啱／估錯整個回應一樣（豁免：triage.session_id）；帶 decisions 嘅 apply 亦一樣", async () => {
    await seedExisting();
    const strip = (b: Record<string, unknown>) => {
      const c = JSON.parse(JSON.stringify(b)) as { triage?: { session_id?: string } | null; counts_hidden?: boolean };
      if (c.triage) delete c.triage.session_id;
      return c;
    };
    const base = strip((await applyPkg(supervisor, [dp(RIGHT, "confirmed")])).body);
    expect(base.counts_hidden).toBe(true);
    for (const [f, v] of Object.entries(WRONG)) expect(strip((await applyPkg(supervisor, [dp(v, "confirmed")])).body), `apply ${f}`).toEqual(base);
    // decisions（confirm 出生日期／地址／電話／英文名）
    const decide = async (v: DV) => {
      const p = dp(v, "review");
      const pkg = pkgOf([p]);
      const dec = { [p.key]: { date_of_birth: { action: "confirm" }, address: { action: "confirm" }, phone: { action: "confirm" }, name_en: { action: "confirm" } } };
      const res = await post(applyRoute as never, "/api/guards/import/apply", supervisor, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions: dec });
      expect(res.status).toBe(200);
      return strip(await res.json());
    };
    const dBase = await decide(RIGHT);
    for (const [f, v] of Object.entries(WRONG)) expect(await decide(v), `decisions ${f}`).toEqual(dBase);
    // 現有資料冇被改
    const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H[1] }, include: { phones: true, addresses: true } });
    expect(g.phones.map((p) => p.tel)).toEqual([EXIST.tel]);
    expect(g.addresses.length).toBe(1);
    expect(g.nameEn).toBe(EXIST.en);
    expect(g.dateOfBirth?.toISOString().slice(0, 10)).toBe(EXIST.dob);
  });

  it("差分（核心）：分診 preview／session 回應估啱／估錯一樣（豁免：evidence.person 回顯上載者自己提交嘅值、preview_hash、題目／session id）", async () => {
    await seedExisting();
    const ans = { option: "apply_fields", fields: { dateOfBirth: { action: "confirm" }, address: { action: "confirm" }, phone: { action: "confirm" }, nameEn: { action: "confirm" } } };
    const run = async (v: DV) => {
      const a = await applyPkg(supervisor, [dp(v, "review")]);
      const sid = a.body.triage.session_id as string;
      const triage = { open: a.body.triage.open_questions, total: a.body.triage.total_questions, important: a.body.triage.important_open, supp: a.body.triage.supplementary_open };
      const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).json();
      const q = sess.questions[0];
      const pv = await (await preview(supervisor, q.id, ans)).json();
      delete pv.preview_hash;
      return { triage, counts: sess.session.counts, review_fields: q.evidence.review_fields, options: q.options, candidates: q.evidence.candidates, reasons: q.evidence.reasons, pv };
    };
    const base = await run(RIGHT);
    expect(base.triage.total).toBe(1);
    for (const [f, v] of Object.entries(WRONG)) expect(await run(v), `triage ${f}`).toEqual(base);
  });

  it("Major-B：現有中文姓名欄係英文字母——錯名／空白名隱藏，完全相同先顯示（preview 同分診候選）", async () => {
    await prisma.guard.create({ data: { nameZh: "ABC Real", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    for (const wrong of ["XYZ Wrong", "   "]) {
      const p = person({ hkid: H[1], name: "導入測試員甲", nos: [] });
      p.nameZh = { value: wrong, status: "confirmed" } as never;
      const t = await (await previewRoute0(supervisor, pkgOf([p]))).text();
      expect(t).not.toContain("ABC Real");
      expect(JSON.parse(t).rows[0].current_name_hidden).toBe(true);
    }
    const ok = person({ hkid: H[1], name: "導入測試員甲", nos: [] });
    ok.nameZh = { value: " abc real ", status: "confirmed" } as never;
    expect(JSON.parse(await (await previewRoute0(supervisor, pkgOf([ok]))).text()).rows[0].current_name_zh).toBe("ABC Real");
    expect((await import("@/lib/guards/import/text")).sameNameStrict("", "")).toBe(false);
    expect((await import("@/lib/guards/import/text")).sameNameStrict(null, " ")).toBe(false);
  });

  it("Major-B：分診候選——現有姓名係英文字母，錯名隱藏", async () => {
    await prisma.guard.create({ data: { nameZh: "ABC Real", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    const b = await prisma.guard.create({ data: { nameZh: "測試乙現有", employmentType: "cash_casual", createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: b.id, scheme: "U", number: "U90020", status: "current" } });
    const p = person({ hkid: H[1], name: "導入測試員錯", nos: ["U90020"] });
    const a = await applyPkg(supervisor, [p]);
    const sid = a.body.triage.session_id as string;
    const text = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    expect(text).not.toContain("ABC Real");
    expect(text).toContain("測試乙現有");
  });

  it("限額：非老闆每 24 小時 preview＋apply 最多 20 次（429）；preview 寫 audit（冇 PII）；decisions 覆核 apply 同分診作答唔計；老闆唔受限", async () => {
    const pk = pkgOf([person({ hkid: H[1], name: "導入測試員甲", nos: [] })]);
    for (let i = 0; i < 20; i++) expect((await previewRoute0(supervisor, pk)).status).toBe(200);
    const r = await previewRoute0(supervisor, pk);
    expect(r.status).toBe(429);
    expect(JSON.stringify(await r.json())).toContain("今日導入次數已達上限");
    expect((await post(applyRoute as never, "/api/guards/import/apply", supervisor, { package: pk, package_hash: hashPackage(importPackageSchema.parse(pk)) })).status).toBe(429);
    // 覆核 decisions 嘅 apply 唔受限
    const p = pk.persons[0]!;
    expect((await post(applyRoute as never, "/api/guards/import/apply", supervisor, { package: pk, package_hash: hashPackage(importPackageSchema.parse(pk)), decisions: { [p.key]: { name_en: { action: "skip" } } } })).status).toBe(200);
    // 老闆唔受限
    for (let i = 0; i < 22; i++) expect((await previewRoute0(owner, pk)).status).toBe(200);
    const aud = await prisma.auditLog.findMany({ where: { action: "guard_import_preview", actorUserId: fx.userIds["主管"] } });
    expect(aud.length).toBe(20);
    expect(JSON.stringify(aud)).not.toContain(H[1]!);
    // ai.audit_log 冇 PII
    const ai = await prisma.$queryRaw<{ after: unknown }[]>`SELECT after FROM ai.audit_log WHERE action = 'guard_import_preview' LIMIT 5`;
    expect(JSON.stringify(ai)).not.toContain(H[1]!);
    // 其他用戶唔受影響
    expect((await previewRoute0(accountant, pk)).status).toBe(200);
  });

  it("補空欄：冇「安員:update」嘅會計，英文名現有係空→改正後確認得；現有非空→403", async () => {
    const g1 = await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
    await prisma.guard.create({ data: { nameZh: "導入測試員乙", nameEn: "HAS EN", employmentType: "cash_casual", hkid: H[2]!, createdBy: "t" } });
    const a = await applyPkg(accountant, [person({ hkid: H[1], name: "導入測試員甲", nos: ["U90001"] }), person({ hkid: H[2], name: "導入測試員乙", nos: ["U90002"] })]);
    expect(a.body.triage.open_questions).toBe(2);
    const qs = await prisma.triageQuestion.findMany({ where: { kind: "field_review" }, orderBy: { sort: "asc" } });
    const ans = { option: "apply_fields", fields: { nameEn: { action: "replace", value: "NEW EN" } } };
    const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${a.body.triage.session_id}`, accountant, a.body.triage.session_id)).json();
    const checkOf = (id: string) => sess.questions.find((q: { id: string }) => q.id === id).evidence.review_fields.find((f: { field: string }) => f.field === "nameEn").check;
    expect(qs.map((q) => checkOf(q.id)).sort()).toEqual(["differs", "fill"].sort());
    const fillQ = qs.find((q) => checkOf(q.id) === "fill")!;
    const hasQ = qs.find((q) => checkOf(q.id) === "differs")!;
    expect((await preview(accountant, hasQ.id, ans)).status).toBe(403);
    expect((await confirm(accountant, fillQ.id, ans)).res.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g1.id } })).nameEn).toBe("NEW EN");
  });

  it("reason code 中文標籤：未知 code 顯示「其他原因」，唔露英文碼", async () => {
    const { reasonLabel } = await import("@/components/TriageDialog");
    for (const c of ["name_differs_from_guard", "same_name_different_hkid", "tel_only_candidate", "staffno_shared_by_persons", "hkid_belongs_to_other_guard"]) expect(reasonLabel(c)).not.toBe("其他原因");
    expect(reasonLabel("some_unknown_code")).toBe("其他原因");
  });

  // ---------------------------------------------------------------------------
  // 上線後跟進（Opus 第四輪 4 個 Minor）
  // ---------------------------------------------------------------------------
  it("Minor-1：分診 session GET 嘅 evidence.reasons，冇 PII view 剝走 name_differs_from_guard；有 PII view 照回", async () => {
    const a = await applyPkg(supervisor, [person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] })]);
    const sid = a.body.triage.session_id as string;
    const q = await qOfKind("name_not_confirmed");
    const ev = q.evidenceJson as { reasons: string[] };
    await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, reasons: [...ev.reasons, "name_differs_from_guard"] } } });
    const sup = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).text();
    expect(sup).not.toContain("name_differs_from_guard");
    const boss = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).text();
    expect(boss).toContain("name_differs_from_guard");
  });

  it("Minor-2：批量導入 decisions replace 只擋「覆蓋現有非空值」；補空欄得；被擋嘅人標 overwrite_forbidden（回 200），唔取決於新值", async () => {
    const mk = async (hk: string, over: { nameEn?: string; addr?: string }) => {
      const g = await prisma.guard.create({ data: { nameZh: "導入測試員甲", nameEn: over.nameEn ?? null, employmentType: "cash_casual", hkid: hk, createdBy: "t" } });
      if (over.addr) await prisma.guardAddress.create({ data: { guardId: g.id, address: over.addr, isPrimary: true } });
      return g;
    };
    const gEmpty = await mk(H[1]!, {});
    const gFull = await mk(H[2]!, { nameEn: "HAS EN", addr: "現有地址1號" });
    const run = async (cookie: string, hk: string, nm: string, dec: Record<string, unknown>) => {
      const p = person({ hkid: hk, name: nm, nos: [] });
      const pkg = pkgOf([p]);
      return post(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions: { [p.key]: dec } });
    };
    // 補空欄：冇「安員個人資料:update」嘅主管補空地址得；冇「安員:update」嘅會計補空英文名得
    expect((await run(supervisor, H[1]!, "導入測試員甲", { address: { action: "replace", value: "新地址9號" } })).status).toBe(200);
    expect(await prisma.guardAddress.count({ where: { guardId: gEmpty.id } })).toBe(1);
    expect((await run(accountant, H[1]!, "導入測試員甲", { name_en: { action: "replace", value: "FILLED EN" } })).status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gEmpty.id } })).nameEn).toBe("FILLED EN");
    // 覆蓋現有非空值：403，唔理新值同現值一樣定唔同
    const reasonsOf = async (res: Response) => {
      expect(res.status).toBe(200);
      const b = await res.json();
      return { reasons: b.results[0].reasons, outcome: b.results[0].outcome, blocked: b.overwrite_blocked };
    };
    const addr = [await reasonsOf(await run(supervisor, H[2]!, "導入測試員甲", { address: { action: "replace", value: "現有地址1號" } })), await reasonsOf(await run(supervisor, H[2]!, "導入測試員甲", { address: { action: "replace", value: "別處地址2號" } }))];
    expect(addr[0]).toEqual(addr[1]); // 新值同現值一樣／唔一樣，結果完全相同
    expect(addr[0]).toMatchObject({ reasons: ["overwrite_forbidden"], outcome: "needs_review", blocked: 1 });
    const en = [await reasonsOf(await run(accountant, H[2]!, "導入測試員甲", { name_en: { action: "replace", value: "HAS EN" } })), await reasonsOf(await run(accountant, H[2]!, "導入測試員甲", { name_en: { action: "replace", value: "OTHER EN" } }))];
    expect(en[0]).toEqual(en[1]);
    expect(en[0].reasons).toEqual(["overwrite_forbidden"]);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: gFull.id } })).nameEn).toBe("HAS EN");
    expect(await prisma.guardAddress.count({ where: { guardId: gFull.id } })).toBe(1);
  });

  it("Minor-3：每日限額視窗唔受 session 時區影響（UTC／Asia/Hong_Kong 一致：17 小時前計入、25 小時前唔計；限額只數預留行）", async () => {
    const { countReservations, QUOTA_RESERVE_ACTION, NON_BOSS_MAX_RUNS_PER_DAY } = await import("@/lib/guards/import/limits");
    const seed = async (userId: string, hoursAgo: number) => {
      const t = new Date(Date.now() - hoursAgo * 3600_000);
      for (let i = 0; i < NON_BOSS_MAX_RUNS_PER_DAY; i++) await prisma.auditLog.create({ data: { actorUserId: userId, tableName: "guard_quota", rowId: userId, action: QUOTA_RESERVE_ACTION, createdAt: t, after: { kind: "batch", request_id: "t" } } });
    };
    const mkU = async () => (await prisma.user.create({ data: { name: "限額測試", tel: `7${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, passwordHash: "x", roleId: fx.roleIds["會計"], createdBy: "t" } })).id;
    const recent = await mkU();
    const old = await mkU();
    await seed(recent, 17);
    await seed(old, 25);
    for (const tz of ["UTC", "Asia/Hong_Kong", "America/Los_Angeles"]) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`);
        expect(await countReservations(tx, recent, "batch"), tz).toBe(NON_BOSS_MAX_RUNS_PER_DAY);
        expect(await countReservations(tx, old, "batch"), tz).toBe(0);
      });
    }
  });

  it("Minor-4：冇 SESSION_SECRET 唔 fallback 固定 key，預覽直接 throw，唔會用弱 key 簽 hash", async () => {
    const gName = await prisma.guard.create({ data: { nameZh: "導入測試員丙", employmentType: "cash_casual", createdBy: "t" } });
    await applyPkg(accountant, [person({ hkid: H[3], name: "導入測試員丙", nos: ["U90004"] })]);
    const q = await qOfKind("name_only_candidate");
    const { previewAnswer } = await import("@/lib/triage/apply");
    const actor = { userId: fx.userIds["會計"], baseRole: "會計" } as never;
    const caps = { pii: true, piiUpdate: true, guardUpdate: true };
    const ans = { option: "link", guard_id: gName.id };
    expect((await previewAnswer(actor, q, ans, caps, null)).preview_hash).toHaveLength(64);
    const saved = process.env.SESSION_SECRET;
    try {
      delete process.env.SESSION_SECRET;
      await expect(previewAnswer(actor, q, ans, caps, null)).rejects.toThrow(/SESSION_SECRET/);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });

  it("逐人標記：>25 人、被擋嘅人喺第 2 批——前後嘅人照常寫入、被擋嗰個全部唔寫、回 200、summary audit 有 1 條帶被擋計數", async () => {
    const N = 30;
    const BLOCK = 27;
    const ps: PackagePerson[] = [];
    const guards: string[] = [];
    for (let i = 0; i < N; i++) {
      const hk = mkHkid("M", String(100000 + i));
      const g = await prisma.guard.create({ data: { nameZh: `導入測試員${i}`, employmentType: "cash_casual", hkid: hk, createdBy: "t" } });
      if (i === BLOCK) await prisma.guardAddress.create({ data: { guardId: g.id, address: "現有地址1號", isPrimary: true } });
      guards.push(g.id);
      ps.push(person({ hkid: hk, name: `導入測試員${i}`, nos: [] }));
    }
    const pkg = pkgOf(ps);
    const decisions = Object.fromEntries(ps.map((p) => [p.key, { name_en: { action: "replace", value: "NEW EN" }, address: { action: "replace", value: "新地址9號" } }]));
    const res = await post(applyRoute as never, "/api/guards/import/apply", supervisor, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.overwrite_blocked).toBe(1);
    expect(b.outcomes).toMatchObject({ linked: N - 1, needs_review: 1 });
    expect(b.results[BLOCK].reasons).toEqual(["overwrite_forbidden"]);
    for (let i = 0; i < N; i++) {
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: guards[i]! }, include: { addresses: true } });
      if (i === BLOCK) {
        expect(g.nameEn).toBeNull(); // 同一個人其中一個決定被擋 → 全部唔寫
        expect(g.addresses.map((a) => a.address)).toEqual(["現有地址1號"]);
      } else {
        expect(g.nameEn).toBe("NEW EN");
        expect(g.addresses.map((a) => a.address)).toEqual(["新地址9號"]);
      }
    }
    const sums = await prisma.auditLog.findMany({ where: { action: "guard_import_apply", actorUserId: fx.userIds["主管"] } });
    expect(sums.length).toBe(1);
    expect(sums[0]!.after).toMatchObject({ overwrite_blocked: 1, persons: N });
    expect(b.guards_updated).toBe(N - 1);
  }, 60000);

  it("逐人標記：被擋嘅 reason 對冇 PII view 嘅人亦只取決於現值係咪非空（新值一樣／唔一樣回應相同）", async () => {
    await prisma.guard.create({ data: { nameZh: "導入測試員甲", employmentType: "cash_casual", hkid: H[1]!, dateOfBirth: new Date("1985-01-01T00:00:00.000Z"), createdBy: "t" } });
    const run = async (v: string) => {
      const p = person({ hkid: H[1], name: "導入測試員甲", nos: [] });
      const pkg = pkgOf([p]);
      const r = await post(applyRoute as never, "/api/guards/import/apply", supervisor, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)), decisions: { [p.key]: { date_of_birth: { action: "replace", value: v } } } });
      expect(r.status).toBe(200);
      const b = await r.json();
      delete b.triage;
      return b;
    };
    expect(await run("1985-01-01")).toEqual(await run("1999-09-09"));
  });
});
