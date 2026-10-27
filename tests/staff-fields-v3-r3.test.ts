// WP-STAFF-FIELDS 第二階段：導入包 v3（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「測試」姓名、00000 開頭戶口）；唔讀 data/。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { createHash } from "node:crypto";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as previewImportRoute } from "@/app/api/guards/import/preview/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { POST as reassignRoute } from "@/app/api/triage/sessions/[id]/reassign/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const H = Array.from({ length: 8 }, (_, i) => mkHkid(String.fromCharCode(75 + i), `20000${i % 10}`));

type St = "confirmed" | "review" | "missing";
const L = (value: string | null, status: St = "confirmed") => (value ? { value, status } : { value: null, status: "missing" as St });

const ACCT = "000012345678";
const PAYEE = "TEST PAYEE ONE";

interface X {
  hkid?: string;
  key?: string;
  nos?: { n: string; hire?: string | null; hireSt?: St }[];
  sia?: { no?: string | null; a?: string | null; b?: string | null; st?: St };
  safety?: { no?: string | null; expiry?: string | null; st?: St };
  qas?: { issue?: string | null; expiry?: string | null; st?: St };
  bank?: { code?: string; name?: string; acct?: string; payee?: string; st?: St } | null;
  contacts?: { name: string | null; rel?: string | null; tel: string | null; st?: St }[];
  hire?: string | null;
  reasons?: string[];
}
function person(x: X = {}): PackagePerson {
  const hk = x.hkid ?? H[0]!;
  const p: Record<string, unknown> = {
    key: x.key ?? personKeyForHkid(hk),
    hkid: L(hk),
    nameZh: L("測試員甲"),
    nameEn: L(null),
    dateOfBirth: L("1990-05-06"),
    sex: L(null),
    phone: L(null),
    address: L(null),
    staffNumbers: (x.nos ?? []).map((n) => ({ scheme: n.n.match(/^[A-Z]+/)![0], number: n.n, ...(n.hire ? { hireDate: L(n.hire, n.hireSt ?? "confirmed") } : {}) })),
    rating: "auto_ok",
    reasons: x.reasons ?? [],
  };
  if (x.sia) p.siaPermit = { no: L(x.sia.no ?? null, x.sia.st), aExpiry: L(x.sia.a ?? null, x.sia.st), bExpiry: L(x.sia.b ?? null, x.sia.st) };
  if (x.safety) p.safetyCard = { no: L(x.safety.no ?? null, x.safety.st), expiry: L(x.safety.expiry ?? null, x.safety.st) };
  if (x.qas) p.qas = { issueDate: L(x.qas.issue ?? null, x.qas.st), expiryDate: L(x.qas.expiry ?? null, x.qas.st) };
  if (x.bank) p.bank = { code: L(x.bank.code ?? "004", x.bank.st), name: L(x.bank.name ?? "匯豐銀行", x.bank.st), accountNo: L(x.bank.acct ?? ACCT, x.bank.st), payeeName: L(x.bank.payee ?? PAYEE, x.bank.st) };
  if (x.contacts) p.emergencyContacts = x.contacts.map((c) => ({ name: L(c.name, c.st), relationship: L(c.rel ?? null, c.st), tel: L(c.tel, c.st) }));
  if (x.hire !== undefined) p.hireDate = L(x.hire);
  return p as unknown as PackagePerson;
}
/** response 動態 key 一律用陣列（snake_case 轉換會改 key），測試用呢個攞返 record。 */
const rec = <T extends { key: string }>(arr: T[] | undefined, pick: (x: T) => unknown): Record<string, unknown> => Object.fromEntries((arr ?? []).map((x) => [x.key, pick(x)]));
const outs = (a: { key: string; outcome: string }[] | undefined) => rec(a, (x) => x.outcome);
const pkg3 = (persons: PackagePerson[], unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string }[]) => ({
  version: 3 as const,
  generatedAt: "2026-10-05T00:00:00.000Z",
  persons,
  ...(unassigned ? { unassignedBankAccounts: unassigned } : {}),
});

describe("WP-STAFF-FIELDS 第三輪覆核（R1–R5／Minor）", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;

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
  });

  const post = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id?: string) =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: id ?? "x" }) } as never);
  const get = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, id?: string) =>
    route(new Request(`http://t${url}`, { headers: { cookie } }), { params: Promise.resolve({ id: id ?? "x" }) } as never);
  const applyPkg = async (cookie: string, pkg: ReturnType<typeof pkg3>) => {
    const res = await post(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg) as never) });
    return { status: res.status, body: await res.json() };
  };
  const previewPkg = async (cookie: string, pkg: ReturnType<typeof pkg3>) => {
    const res = await post(previewImportRoute as never, "/api/guards/import/preview", cookie, { package: pkg });
    return { status: res.status, body: await res.json() };
  };
  const qs = (kind: string) => prisma.triageQuestion.findMany({ where: { kind }, orderBy: { sort: "asc" } });
  const qPreview = (cookie: string, qid: string, answer: unknown) => post(previewRoute as never, `/api/triage/questions/${qid}/preview`, cookie, { answer }, qid);
  const qAnswer = (cookie: string, qid: string, ans: unknown, hash?: string) => post(answerRoute as never, `/api/triage/questions/${qid}/answer`, cookie, { answer: ans, ...(hash ? { preview_hash: hash } : {}) }, qid);
  const confirm = async (cookie: string, qid: string, ans: unknown) => {
    const pv = await (await qPreview(cookie, qid, ans)).json();
    return { pv, res: await qAnswer(cookie, qid, ans, pv.preview_hash) };
  };
  const dateOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

  const typedPerson = (x: X, hkidValue: string | null, name = "測試員甲") => {
    const p = person({ ...x, reasons: [...(x.reasons ?? []), "typed_list_only_person"] }) as unknown as Record<string, unknown>;
    p.hkid = hkidValue ? { value: hkidValue, status: "review" } : L(null);
    p.nameZh = { value: name, status: "review" };
    return p as unknown as PackagePerson;
  };
  const mkGuard = (data: Record<string, unknown>) => prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", createdBy: "t", ...data } as never });
  const dob = new Date("1990-05-06T00:00:00.000Z");

  it("R1：包 A 的 review 題未答，包 B 改值 → 舊題 superseded（唔計待答、預覽／作答 409）；答新題先寫新值；並發新題出現 commit 都擋", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    const pa = pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } })]);
    await applyPkg(owner, pa);
    const oldQ = (await qs("ext_field_review"))[0]!;
    const pb = { ...pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-05-05", b: "2028-01-02", st: "review" } })]), generatedAt: "2026-10-06T00:00:00.000Z" };
    await applyPkg(owner, pb);
    const rows = await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["superseded", "open"]);
    const ans = { option: "apply_ext_fields", ext_fields: { "siaPermit.aExpiry": "use_import" } };
    expect((await qPreview(owner, oldQ.id, ans)).status).toBe(409);
    expect((await qAnswer(owner, oldQ.id, ans, "0".repeat(64))).status).toBe(409);
    const list = await (await get(sessionRoute as never, `/api/triage/sessions/${oldQ.sessionId}`, owner, oldQ.sessionId)).json();
    expect(JSON.stringify(list)).toContain("superseded");
    const { res } = await confirm(owner, rows[1]!.id, ans);
    expect(res.status).toBe(200);
    expect(dateOf((await prisma.guard.findFirstOrThrow({ where: { hkid: H[0]! } })).siaPermitAExpiry)).toBe("2027-05-05");
    // 並發：答題 commit 時查到較新嘅同 group_key＋kind 題 → 409
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    await prisma.guard.updateMany({ where: { hkid: H[0]! }, data: { siaPermitAExpiry: null, siaPermitBExpiry: null, siaPermitNo: null } });
    await applyPkg(owner, pa);
    const q1 = (await qs("ext_field_review"))[0]!;
    const pv = await (await qPreview(owner, q1.id, ans)).json();
    await prisma.triagePersonApply.create({ data: { personKey: q1.personKey!, guardId: q1.targetGuardId, sourceRef: "newer-pkg", isV3: true } });
    expect((await qAnswer(owner, q1.id, ans, pv.preview_hash)).status).toBe(409);
  });

  it("R2：有文件＋長工＋ext_identity_check＋confirmed hireDate → 身份確認後補開入職日期題；跳過就唔開", async () => {
    const g = await mkGuard({ hkid: H[0]!, dateOfBirth: dob, employmentType: "longterm_autopay" });
    const mkP = () => person({ hire: "2020-01-02", safety: { no: "ABC1234", expiry: "2027-06-07", st: "review" }, reasons: ["ext_identity_check"] });
    await applyPkg(owner, pkg3([mkP()]));
    const q = (await qs("ext_identity_check"))[0]!;
    expect(q).toBeTruthy();
    const { res } = await confirm(owner, q.id, { option: "confirm_ext_identity" });
    expect(res.status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate).toBeNull();
    const fq = (await qs("ext_field_review")).find((x) => JSON.stringify(x.evidenceJson).includes("hireDate"));
    expect(fq).toBeTruthy();
    // 跳過身份題 → 唔開跟進題
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    await applyPkg(owner, { ...pkg3([mkP()]), generatedAt: "2026-10-09T00:00:00.000Z" });
    const q2 = (await qs("ext_identity_check"))[0]!;
    await qAnswer(owner, q2.id, { option: "skip" });
    expect(await prisma.triageQuestion.count({ where: { kind: "ext_field_review" } })).toBe(0);
  });

  it("R2b：view 回 held 原因 code（longterm_hire_date／identity／bank），冇值", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob, employmentType: "longterm_autopay" });
    const r = await applyPkg(owner, pkg3([person({ hire: "2020-01-02" })]));
    const sid = r.body.triage.session_id as string;
    const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).json();
    const er = sess.questions.find((q: { kind: string }) => q.kind === "ext_field_review").evidence.ext_review;
    expect(er.find((x: { key: string }) => x.key === "hireDate").held).toBe("longterm_hire_date");
  });

  it("R3：冇 PII view 讀者嘅回應／audit／ai.audit_log 搵唔到包內 key 或 sha1／sha256(身份證)；group_key 唔係 sha1(身份證)", async () => {
    await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: "view" } }, data: { granted: false } });
    const hk = H[3]!;
    const secretKey = "pkgkey-SECRETKEY-98765";
    await mkGuard({ hkid: hk, dateOfBirth: dob });
    const p = person({ hkid: hk, key: secretKey, sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } });
    const pkg = pkg3([p]);
    const pv = await previewPkg(accountant, pkg);
    const ap = await applyPkg(accountant, pkg);
    const sid = ap.body.triage.session_id as string;
    const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, accountant, sid)).json();
    const lst = await (await get(listRoute as never, "/api/triage/sessions?mine=1", accountant)).json();
    const q = (await qs("ext_field_review"))[0]!;
    const qp = await (await qPreview(accountant, q.id, { option: "apply_ext_fields", ext_fields: { "siaPermit.aExpiry": "skip" } })).json();
    const sha1 = createHash("sha1").update(hk).digest("hex");
    const sha256typed = createHash("sha256").update(`typed_list|${hk}`).digest("hex");
    const all = JSON.stringify([pv.body, ap.body, sess, lst, qp]) + JSON.stringify(await prisma.auditLog.findMany({ where: { tableName: { in: ["guard_import", "triage_questions", "triage_sessions"] } } })) + JSON.stringify(await prisma.$queryRaw`SELECT before, after FROM ai.audit_log`);
    for (const needle of [secretKey, sha1.slice(0, 12), sha256typed.slice(0, 12), createHash("sha256").update(hk).digest("hex").slice(0, 12)]) expect(all, needle).not.toContain(needle);
    const rows = await prisma.triageQuestion.findMany({});
    expect(rows.every((r) => !r.groupKey.includes(secretKey) && !r.groupKey.includes(sha1.slice(0, 12)))).toBe(true);
    expect(rows.every((r) => !JSON.stringify(r.evidenceJson).includes(secretKey))).toBe(true);
    // 穩定：同一個人換包內 key 再上載 → group_key 一樣（伺服器 HMAC(身份證)）
    const p2 = person({ hkid: hk, key: "another-key-2", sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } });
    await applyPkg(owner, { ...pkg3([p2]), generatedAt: "2026-10-06T00:00:00.000Z" });
    const keys = new Set((await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" } })).map((r) => r.groupKey));
    expect(keys.size).toBe(1);
  });

  it("R4：ext_identity_check 銀行四欄唔齊 → 其他欄照寫，銀行當 skip（留 bank_review＋bank_incomplete）", async () => {
    const g = await mkGuard({ nameZh: "測試員其他", staffNumbers: { create: [{ scheme: "U", number: "U77001" }] } });
    const tp = typedPerson({ nos: [{ n: "U77001" }], sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, bank: {} }, H[2]!) as unknown as { bank: { payeeName: unknown } };
    tp.bank.payeeName = L(null);
    await applyPkg(owner, pkg3([tp as never]));
    const q = (await qs("ext_identity_check"))[0]!;
    const { res } = await confirm(owner, q.id, { option: "confirm_ext_identity" });
    expect(res.status).toBe(200);
    const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
    expect([a.siaPermitNo, a.bankAccountNo]).toEqual(["K-200001-1-001", null]);
    const bq = (await qs("bank_review"))[0]!;
    expect(JSON.stringify(bq.evidenceJson)).toContain("bank_incomplete");
  });

  it("R5：現有戶口有分隔符／空格都查到重複（導入同 PATCH）；PATCH 只改銀行編號都查重", async () => {
    await mkGuard({ nameZh: "測試員Z", bankCode: "004", bankName: "匯豐銀行", bankAccountNo: "0000-1234 5678", bankPayeeName: PAYEE });
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    const r = await applyPkg(owner, pkg3([person({ bank: { acct: ACCT } })]));
    expect(outs(r.body.results[0].ext).bank).toBe("conflict");
    expect(await prisma.guard.count({ where: { bankAccountNo: { not: null } } })).toBe(1);
    // PATCH 只改銀行編號：y 現有戶口同 z 一樣數字但另一間銀行 → 改成同一銀行編號即撞
    const y = await mkGuard({ nameZh: "測試員Y", bankCode: "024", bankName: "恒生銀行", bankAccountNo: "000012345678", bankPayeeName: PAYEE });
    const { PATCH } = await import("@/app/api/guards/[id]/route");
    const res = await PATCH(new Request(`http://t/api/guards/${y.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ bank_code: "004" }) }), { params: Promise.resolve({ id: y.id }) } as never);
    expect(res.status).toBe(409);
  });

  it("Minor：批量 decisions.ext 對長工 hireDate 只准 skip（其他逐人 overwrite_forbidden）", async () => {
    const g = await mkGuard({ hkid: H[0]!, dateOfBirth: dob, employmentType: "longterm_autopay" });
    const pk = pkg3([person({ hire: "2020-01-02" })]);
    const key = (pk.persons[0] as unknown as { key: string }).key;
    const run = async (a: string) => {
      const res = await post(applyRoute as never, "/api/guards/import/apply", owner, { package: pk, package_hash: hashPackage(importPackageSchema.parse(pk) as never), decisions: { [key]: { ext: { hireDate: a } } } });
      return (await res.json()) as { results: { reasons: string[] }[]; overwrite_blocked: number };
    };
    const r = await run("replace");
    expect(r.results[0]!.reasons).toContain("overwrite_forbidden");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate).toBeNull();
    await run("skip");
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).hireDate).toBeNull();
  });

  it("Minor：hold_override 標埋聯絡人／逐工號入職日期 audit", async () => {
    const g = await mkGuard({ nameZh: "測試員其他", staffNumbers: { create: [{ scheme: "U", number: "U77001" }] } });
    await applyPkg(owner, pkg3([typedPerson({ nos: [{ n: "U77001", hire: "2020-01-02" }], contacts: [{ name: "測試聯絡人甲", tel: "91000011" }] }, H[2]!)]));
    const q = (await qs("ext_identity_check"))[0]!;
    await confirm(owner, q.id, { option: "confirm_ext_identity" });
    const c = await prisma.auditLog.findMany({ where: { tableName: "guard_emergency_contacts" }, orderBy: { createdAt: "desc" }, take: 1 });
    const n = await prisma.auditLog.findMany({ where: { tableName: "guard_staff_numbers", action: "update" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect((c[0]!.after as Record<string, unknown>).hold_override).toBe(true);
    expect((n[0]!.after as Record<string, unknown>).hold_override).toBe(true);
    void g;
  });

  it("Minor：冇 view 上載者自動寫完唔會即時出假衝突題", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: "view" } }, data: { granted: false } });
    const r = await applyPkg(accountant, pkg3([person({ contacts: [{ name: "測試聯絡人甲", tel: "91000011" }] })]));
    expect(await prisma.guardEmergencyContact.count()).toBe(1);
    expect(r.body.triage?.new_questions ?? 0).toBe(0);
  });

  it("Minor：hire_date_import_notice 只喺 hire_date 真係嚟自導入嗰筆 audit", async () => {
    const g = await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    await applyPkg(owner, pkg3([person({ hire: "2020-01-02" })]));
    const { PATCH } = await import("@/app/api/guards/[id]/route");
    await PATCH(new Request(`http://t/api/guards/${g.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ hire_date: "2021-03-04" }) }), { params: Promise.resolve({ id: g.id }) } as never);
    const { POST } = await import("@/app/api/guards/[id]/convert-to-longterm/route");
    const res = await POST(new Request(`http://t/api/guards/${g.id}/convert-to-longterm`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ site_id: fx.site.id, effective_from: "2030-01-01", monthly_salary: 15000 }) }), { params: Promise.resolve({ id: g.id }) } as never);
    expect((await res.json()).hire_date_import_notice).toBeNull();
  });

  it("Minor：restricted 題唔計入冇權限者 badge", async () => {
    await mkGuard({ nameZh: "測試員其他", staffNumbers: { create: [{ scheme: "U", number: "U77001" }] } });
    await applyPkg(owner, pkg3([typedPerson({ nos: [{ n: "U77001" }], sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" } }, H[2]!)]));
    const sid = (await prisma.triageSession.findFirstOrThrow({})).id;
    await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員", action: "update" } }, data: { granted: false } });
    await post(reassignRoute as never, `/api/triage/sessions/${sid}/reassign`, owner, { owner_user_id: fx.userIds["會計"] }, sid);
    const l = await (await get(listRoute as never, "/api/triage/sessions?mine=1", accountant)).json();
    expect(l.open_total).toBe(0);
  });
});
