// WP-STAFF-FIELDS 第二階段：導入包 v3（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「測試」姓名、00000 開頭戶口）；唔讀 data/。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as previewImportRoute } from "@/app/api/guards/import/preview/route";
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
const pkg3 = (persons: PackagePerson[], unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string }[]) => ({
  version: 3 as const,
  generatedAt: "2026-10-05T00:00:00.000Z",
  persons,
  ...(unassigned ? { unassignedBankAccounts: unassigned } : {}),
});

describe("WP-STAFF-FIELDS 第五輪覆核（簡化：作廢＋重新出題，冇搬移／重開）", () => {
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
  const applyPkg = async (cookie: string, pkg: ReturnType<typeof pkg3>) => {
    const res = await post(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg) as never) });
    return { status: res.status, body: await res.json() };
  };
  const qPreview = (cookie: string, qid: string, answer: unknown) => post(previewRoute as never, `/api/triage/questions/${qid}/preview`, cookie, { answer }, qid);
  const qAnswer = (cookie: string, qid: string, ans: unknown, hash?: string) => post(answerRoute as never, `/api/triage/questions/${qid}/answer`, cookie, { answer: ans, ...(hash ? { preview_hash: hash } : {}) }, qid);
  const confirm = async (cookie: string, qid: string, ans: unknown) => {
    const pv = await (await qPreview(cookie, qid, ans)).json();
    return { pv, res: await qAnswer(cookie, qid, ans, pv.preview_hash) };
  };

  const mkG = (data: Record<string, unknown>) => prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", createdBy: "t", ...data } as never });
  const dobD = new Date("1990-05-06T00:00:00.000Z");

  it("F1：A 姓名 review＋牌照 X → B 同人牌照 Y：答姓名題建人，牌照＝Y（唔係舊 X）", async () => {
    const mk = (no: string, gen: string) => {
      const p = person({ sia: { no, a: "2027-03-04", b: "2028-01-02" } }) as unknown as Record<string, unknown>;
      p.nameZh = { value: "測試員甲", status: "review" };
      p.reasons = ["name_not_confirmed"];
      return { ...pkg3([p as never]), generatedAt: gen };
    };
    await applyPkg(owner, mk("K-200001-1-001", "2026-10-01T00:00:00.000Z"));
    const first = (await prisma.triageQuestion.findMany({ where: { kind: "name_not_confirmed" } }))[0]!;
    await applyPkg(owner, mk("K-300001-1-001", "2026-10-02T00:00:00.000Z"));
    const all = await prisma.triageQuestion.findMany({ where: { kind: "name_not_confirmed" }, orderBy: { createdAt: "asc" } });
    expect(all.map((q) => q.status)).toEqual(["superseded", "open"]);
    expect((await qPreview(owner, first.id, { option: "use_package_name" })).status).toBe(409);
    const { res } = await confirm(owner, all[1]!.id, { option: "use_package_name" });
    expect(res.status).toBe(200);
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H[0]! } })).siaPermitNo).toBe("K-300001-1-001");
  });

  it("F2：A(X)→B(Y)→C(X)→再 apply A：最新包 A 嘅 review 值有 open 題", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD });
    const mk = (no: string, gen: string) => ({ ...pkg3([person({ sia: { no, a: "2027-03-04", b: "2028-01-02", st: "review" } })]), generatedAt: gen });
    await applyPkg(owner, mk("K-200001-1-001", "2026-10-01T00:00:00.000Z"));
    await applyPkg(owner, mk("K-300001-1-001", "2026-10-02T00:00:00.000Z"));
    await applyPkg(owner, mk("K-200001-1-001", "2026-10-03T00:00:00.000Z"));
    await applyPkg(owner, mk("K-200001-1-001", "2026-10-01T00:00:00.000Z"));
    const open = await prisma.triageQuestion.findMany({ where: { status: "open", kind: "ext_field_review" } });
    expect(open).toHaveLength(1);
    expect(JSON.stringify(open[0]!.evidenceJson)).toContain("K-200001-1-001");
  });

  it("F3：有身份證→冇身份證淨靠工號：舊題答唔到（409），唔寫舊值", async () => {
    const g = await mkG({ hkid: H[0]!, dateOfBirth: dobD, staffNumbers: { create: [{ scheme: "U", number: "U93001" }] } });
    const withHk = (v: string, gen: string) => ({ ...pkg3([person({ nos: [{ n: "U93001" }], sia: { no: v, a: "2027-03-04", b: "2028-01-02", st: "review" } })]), generatedAt: gen });
    await applyPkg(owner, withHk("K-200001-1-001", "2026-10-01T00:00:00.000Z"));
    const old = (await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" } }))[0]!;
    const noHk = (() => {
      const p = person({ nos: [{ n: "U93001" }], sia: { no: "K-300001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } }) as unknown as Record<string, unknown>;
      p.hkid = { value: null, status: "missing" };
      return { ...pkg3([p as never]), generatedAt: "2026-10-02T00:00:00.000Z" };
    })();
    await applyPkg(owner, noHk);
    const st = (await prisma.triageQuestion.findUniqueOrThrow({ where: { id: old.id } })).status;
    const r = await qPreview(owner, old.id, { option: "apply_ext_fields", ext_fields: { "siaPermit.no": "use_import" } });
    expect(st === "superseded" || r.status === 409).toBe(true);
    expect(r.status).toBe(409);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).siaPermitNo).toBeNull();
  });

  it("M1（取消搬移）：會計上載→老闆上載同值新包：舊題 superseded（會計答 409），老闆 session 有全新 open 題（新 row）", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD });
    const mk = (gen: string) => ({ ...pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } })]), generatedAt: gen });
    await applyPkg(accountant, mk("2026-10-01T00:00:00.000Z"));
    const old = (await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" } }))[0]!;
    await applyPkg(owner, mk("2026-10-02T00:00:00.000Z"));
    const all = await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" }, include: { session: true }, orderBy: { createdAt: "asc" } });
    expect(all.map((q) => q.status)).toEqual(["superseded", "open"]);
    expect(all[1]!.id).not.toBe(old.id); // 新 row，唔搬移
    expect(all[1]!.session.ownerUserId).toBe(fx.userIds["老闆"]);
    expect((await qPreview(accountant, old.id, { option: "apply_ext_fields", ext_fields: { "siaPermit.no": "use_import" } })).status).toBe(409);
  });

  it("同一包再 apply：已答嘅題唔重出；open 題數同內容一樣（作廢＋重出，id 可變）", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD });
    const p = pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } }), person({ hkid: H[1]!, key: "k2", sia: { no: "K-300001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } })]);
    await mkG({ nameZh: "測試員乙", hkid: H[1]!, dateOfBirth: dobD });
    await applyPkg(owner, p);
    const qs0 = await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review", status: "open" } });
    expect(qs0).toHaveLength(2);
    await qAnswer(owner, qs0[0]!.id, { option: "skip" });
    const before = JSON.stringify((await prisma.triageQuestion.findMany({ where: { status: "open" } })).map((q) => q.evidenceJson).sort());
    const r = await applyPkg(owner, p);
    expect(r.status).toBe(200);
    const open = await prisma.triageQuestion.findMany({ where: { status: "open" } });
    expect(open).toHaveLength(1);
    expect(JSON.stringify(open.map((q) => q.evidenceJson).sort())).toBe(before);
    expect(await prisma.triageQuestion.count({ where: { status: "skipped" } })).toBe(1);
  });

  it("(d) 冇銀行段嘅包（v2／v3 冇銀行／single_ocr）唔會令 open bank_* 題消失；有銀行段先作廢重出", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD, bankCode: "024", bankName: "恒生銀行", bankAccountNo: "000087654321", bankPayeeName: "TEST PAYEE ONE" });
    await applyPkg(owner, { ...pkg3([person({ bank: {} })]), generatedAt: "2026-10-01T00:00:00.000Z" });
    const bq = async () => prisma.triageQuestion.count({ where: { status: "open", kind: "bank_review" } });
    expect(await bq()).toBe(1);
    await applyPkg(owner, { ...pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" } })]), generatedAt: "2026-10-02T00:00:00.000Z" });
    expect(await bq()).toBe(1);
    const v2p = { version: 2 as const, generatedAt: "2026-10-03T00:00:00.000Z", persons: [{ ...(person() as object), staffNumbers: [] }] };
    await post(applyRoute as never, "/api/guards/import/apply", owner, { package: v2p, package_hash: hashPackage(importPackageSchema.parse(v2p) as never) });
    expect(await bq()).toBe(1);
    await applyPkg(owner, { ...pkg3([person({ bank: {} })]), generatedAt: "2026-10-04T00:00:00.000Z" });
    expect(await bq()).toBe(1); // 作廢重出，仍然得 1 條 open
    expect(await prisma.triageQuestion.count({ where: { kind: "bank_review", status: "superseded" } })).toBe(1);
  });

  it("F：triage_person_applies 寫入唔受呼叫者「導入分診:view」影響（冇權限者上載都記）", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD });
    await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "導入分診", action: "view" } }, data: { granted: false } });
    await applyPkg(accountant, { ...pkg3([person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" } })]), generatedAt: "2026-10-01T00:00:00.000Z" });
    expect(await prisma.triagePersonApply.count()).toBeGreaterThan(0);
  });

  it("@index 嚴格：^@(0|[1-9]\\d*)$；@01／@-1／@x／@1.0／__proto__／constructor 一律 400；@index 同包內 key 撞 400", async () => {
    await mkG({ hkid: H[0]!, dateOfBirth: dobD });
    const a = person({ key: "ka" }) as unknown as Record<string, unknown>;
    a.address = { value: "測試地址甲", status: "review" };
    const pk = pkg3([a as never]);
    const h = hashPackage(importPackageSchema.parse(pk) as never);
    const call = async (dec: unknown) => (await post(applyRoute as never, "/api/guards/import/apply", owner, { package: pk, package_hash: h, decisions: dec })).status;
    for (const k of ["@01", "@-1", "@x", "@1.0", "@ 0", "@", "@5"]) expect(await call({ [k]: { address: { action: "skip" } } }), k).toBe(400);
    expect(await call(JSON.parse('{"__proto__":{"address":{"action":"skip"}}}')), "__proto__").toBe(400);
    expect(await call({ constructor: { address: { action: "skip" } } }), "constructor").toBe(400);
    expect(await call({ "@0": { address: { action: "skip" } }, ka: { address: { action: "confirm" } } })).toBe(400);
    expect(await call({ "@0": { address: { action: "skip" } } })).toBe(200);
  });

  it("不變量（Opus 序列攻擊擴充：同包再 apply／有冇身份證交替／v2 v3 冇銀行段交錯／兩個上載者／並發）", async () => {
    const SEQ = Number(process.env.FUZZ_SEQ ?? 25), STEPS = Number(process.env.FUZZ_STEPS ?? 9);
    let seed = Number(process.env.FUZZ_SEED ?? 12345);
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const SIA = ["K-200001-1-001", "K-300001-1-001", "K-400001-1-001"] as const;
    const EN = ["TEST NAME ONE", "TEST NAME TWO"] as const;
    const viol: string[] = [];
    const stats: Record<string, number> = {};
    const inc = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
    for (let s = 0; s < SEQ; s++) {
      await clearAll(); await prisma.triageQuestion.deleteMany({}); await prisma.$executeRawUnsafe(`DELETE FROM triage_person_applies`); await prisma.triageSession.deleteMany({});
      fx = await seedWp2Fixture();
      const mkUser = async (role: "會計" | "主管") => (await prisma.user.create({ data: { name: `測試${role}新`, tel: `6${String(Math.floor(rnd() * 1e7)).padStart(7, "0")}`, passwordHash: "x", roleId: fx.roleIds[role], createdBy: "t" } })).id;
      fx.userIds["會計"] = await mkUser("會計");
      owner = await sessionCookieForUser(fx.userIds["老闆"]); accountant = await sessionCookieForUser(fx.userIds["會計"]);
      const g = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), createdBy: "t", staffNumbers: { create: [{ scheme: "U", number: "U93001" }, { scheme: "MP", number: "MP93001" }] } } as never });
      type LV = { sia: string | null; en: string | null; linked: boolean; v3?: boolean; dup?: boolean };
      let latest: LV | null = null; let latestV3: LV | null = null;
      let gen = 0;
      const log: string[] = [];
      const mkPkg = () => {
        const v3 = rnd() < 0.75;
        const keyMode = pick(["hk", "hk", "nohk1", "nohk2"] as const);
        const dup = rnd() < 0.1;
        const sia = v3 && rnd() < 0.8 ? pick(SIA) : null;
        const bank = v3 && rnd() < 0.35;
        const en = rnd() < 0.6 ? pick(EN) : null;
        const mkP = (k: string) => {
          const p = person({ key: k, hkid: H[0]!, nos: keyMode === "nohk1" ? [{ n: "U93001" }] : [{ n: "U93001" }, { n: "MP93001" }], ...(sia ? { sia: { no: sia, a: "2027-03-04", b: "2028-01-02", st: "review" } } : {}), ...(bank ? { bank: { acct: "000099990001", st: "review" } } : {}) }) as unknown as Record<string, unknown>;
          if (keyMode !== "hk") p.hkid = { value: null, status: "missing" };
          p.nameEn = en ? { value: en, status: "review" } : { value: null, status: "missing" };
          return p;
        };
        const persons0 = 0; void persons0;
        const persons = dup ? [mkP(`k${gen}a`), mkP(`k${gen}b`)] : [mkP(`k${gen}`)];
        gen++;
        const base = { generatedAt: `2026-10-0${1 + (gen % 9)}T0${gen % 10}:00:00.000Z`, persons };
        return { pkg: v3 ? { version: 3 as const, ...base } : { version: 2 as const, ...base }, vals: { sia, en, linked: keyMode === "hk", v3, dup }, bank, desc: `${v3 ? "v3" : "v2"}/${keyMode}/${sia ? SIA.indexOf(sia) : "-"}/${en ? EN.indexOf(en) : "-"}${dup ? "/dup" : ""}` };
      };
      let lastM: ReturnType<typeof mkPkg> | null = null;
      let concurrentNow = false; // 並發步驟入面，另一個請求可能同時答咗 bank 題，唔計 (d)
      const doApply = async (who: string) => {
        const m = lastM && rnd() < 0.2 ? lastM : mkPkg(); // 20%：同一包再 apply
        lastM = m;
        const openBank = () => prisma.triageQuestion.count({ where: { status: "open", kind: { in: ["bank_review", "bank_identity_unknown"] } } });
        const bankBefore = await openBank();
        const cookie = who === "acc" ? accountant : owner;
        const pv = await post(previewImportRoute as never, "/api/guards/import/preview", cookie, { package: m.pkg });
        const pj = await pv.json();
        const r = await post(applyRoute as never, "/api/guards/import/apply", cookie, { package: m.pkg, package_hash: pj.package_hash });
        log.push(`apply ${who} ${m.desc} ${r.status}`);
        // (d) 冇銀行段嘅包唔會令 open bank_* 題數減少
        if (!concurrentNow && r.status === 200 && !m.bank && (await openBank()) < bankBefore) viol.push(`seq${s} (d) bank open ${bankBefore}->${await openBank()} by no-bank pkg :: ${log.join(" | ")}`);
        if (r.status === 200) { latest = m.vals; if (m.vals.v3) latestV3 = m.vals; }
        return m;
      };
      const field = (q: { kind: string; evidenceJson: unknown }) => { const e = q.evidenceJson as { ext_review?: { key: string }[]; review_fields?: { field: string }[]; person?: { siaPermit?: { no?: { value: string } }; nameEn?: { value: string } } }; const f: string[] = []; if ((e.ext_review ?? []).some((x) => x.key === "siaPermit.no")) f.push("sia"); if ((e.review_fields ?? []).some((x) => x.field === "nameEn")) f.push("en"); return { f, sia: e.person?.siaPermit?.no?.value ?? null, en: e.person?.nameEn?.value ?? null }; };
      const doAnswer = async (skip: boolean) => {
        const open = await prisma.triageQuestion.findMany({ where: { status: "open" }, include: { session: true } });
        if (!open.length) return null;
        const q = pick(open);
        const fi = field(q);
        const cookie = q.session.ownerUserId === fx.userIds["會計"] ? pick([accountant, owner]) : owner;
        let ans: unknown;
        if (skip) ans = { option: "skip" };
        else if (q.kind === "ext_field_review" || q.kind === "ext_field_conflict") ans = { option: "apply_ext_fields", ext_fields: Object.fromEntries(((q.evidenceJson as { ext_review: { key: string }[] }).ext_review).map((x) => [x.key, "use_import"])) };
        else if (q.kind === "field_review") ans = { option: "apply_fields", fields: Object.fromEntries(((q.evidenceJson as { review_fields: { field: string }[] }).review_fields).map((x) => [x.field, { action: "replace" }])) };
        else ans = { option: "skip" };
        const before = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
        const pv = await qPreview(cookie, q.id, ans);
        const pj = await pv.json();
        let st = pv.status;
        if (pv.status === 200) st = (await qAnswer(cookie, q.id, ans, pj.preview_hash)).status;
        const after = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
        log.push(`answer ${q.kind} ${JSON.stringify(fi.f)} ${skip ? "skip" : "go"} ${pv.status}/${st}`);
        return { st, fi, before, after, q };
      };
      const checkWrite = (r: Awaited<ReturnType<typeof doAnswer>>, allowedEn: (LV | null)[], allowedSia: (LV | null)[]) => {
        const allowed = allowedEn;
        const tag = allowed.some((l) => l && !l.linked) ? "[latest-unlinked]" : allowed.some((l) => l?.dup) ? "[latest-dup]" : "[latest-linked]";
        if (!r || r.st !== 200) return;
        if (r.after.siaPermitNo !== r.before.siaPermitNo) { inc("write_sia"); if (!allowedSia.some((l) => l && l.sia === r.after.siaPermitNo)) viol.push(`${allowedSia.some((l) => l && !l.linked) ? "[latestV3-unlinked]" : allowedSia.some((l) => l?.dup) ? "[latestV3-dup]" : "[latestV3-linked]"} seq${s} (a) sia written ${SIA.indexOf(r.after.siaPermitNo as never)} latest=${JSON.stringify(allowedSia.map((l) => l?.sia ? SIA.indexOf(l.sia as never) : null))} :: ${log.join(" | ")}`); }
        if (r.after.nameEn !== r.before.nameEn) { inc("write_en"); if (!allowed.some((l) => l && l.en === r.after.nameEn)) viol.push(`${tag} seq${s} (a) en written ${EN.indexOf(r.after.nameEn as never)} latest=${JSON.stringify(allowed.map((l) => l?.en ? EN.indexOf(l.en as never) : null))} :: ${log.join(" | ")}`); }
      };
      const checkInv = async () => {
        const open = await prisma.triageQuestion.findMany({ where: { status: "open" } });
        const per: Record<string, number> = {};
        for (const q of open) for (const f of field(q).f) per[f] = (per[f] ?? 0) + 1;
        for (const [f, n] of Object.entries(per)) if (n > 1) viol.push(`seq${s} (b) ${f} open=${n} :: ${log.join(" | ")}`);
        // (c)
        const cur = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
        if (latest?.sia && latest.linked && !latest.dup && cur.siaPermitNo !== latest.sia) {
          const all = await prisma.triageQuestion.findMany({ where: { status: { in: ["open", "answered", "skipped"] } } });
          const covered = all.some((q) => { const fi = field(q); return fi.f.includes("sia") && fi.sia === latest!.sia && (q.status === "open" || q.status === "skipped" || q.status === "answered"); });
          const openCovered = open.some((q) => { const fi = field(q); return fi.f.includes("sia") && fi.sia === latest!.sia; });
          if (!covered) viol.push(`seq${s} (c) latest sia ${SIA.indexOf(latest.sia as never)} not asked :: ${log.join(" | ")}`);
          else if (!openCovered) inc("c_dedup_by_answered_or_skipped");
        }
      };
      for (let t = 0; t < STEPS; t++) {
        const r = rnd();
        if (t === 0 || r < 0.35) { await doApply(rnd() < 0.3 ? "acc" : "owner"); await checkInv(); }
        else if (r < 0.65) { const a = await doAnswer(false); checkWrite(a, [latest], [latestV3]); await checkInv(); }
        else if (r < 0.75) { await doAnswer(true); await checkInv(); }
        else if (r < 0.85) {
          const sess = await prisma.triageSession.findMany();
          if (sess.length) { const ss = pick(sess); const to = pick([fx.userIds["會計"], fx.userIds["老闆"]]); const rr = await post(reassignRoute as never, `/api/triage/sessions/${ss.id}/reassign`, owner, { owner_user_id: to }, ss.id); log.push(`reassign ${rr.status}`); }
        } else {
          const prev = latest, prevV3 = latestV3;
          concurrentNow = true;
          const [, a] = await Promise.all([doApply("owner"), doAnswer(false)]);
          concurrentNow = false;
          inc("concurrent");
          checkWrite(a, [prev, latest], [prevV3, latestV3]);
          await checkInv();
        }
      }
      inc("seq");
    }
    const cls: Record<string, number> = {}; for (const v of viol) { const k = v.replace(/ seq\d+/, "").split(" ").slice(0, 3).join(" "); cls[k] = (cls[k] ?? 0) + 1; }
    console.log("FUZZ stats", JSON.stringify(stats), "violations", viol.length, JSON.stringify(cls));
    expect(viol, JSON.stringify(cls) + " :: " + (viol[0] ?? "")).toEqual([]);
    const seen = new Set<string>(); const uniq = viol.filter((v) => { const k = v.replace(/ seq\d+/, "").split(" ").slice(0, 3).join(" "); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const v of uniq.slice(0, 6)) console.log("VIOL", v.slice(0, 1500));
  }, 600000);
});
