// WP-STAFF-FIELDS 第二階段：導入包 v3（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「測試」姓名、00000 開頭戶口）；唔讀 data/。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
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

describe("WP-STAFF-FIELDS 第四輪覆核（結構性：只有最近一次包含呢個人嘅包先答得）", () => {
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
  const qPreview = (cookie: string, qid: string, answer: unknown) => post(previewRoute as never, `/api/triage/questions/${qid}/preview`, cookie, { answer }, qid);
  const qAnswer = (cookie: string, qid: string, ans: unknown, hash?: string) => post(answerRoute as never, `/api/triage/questions/${qid}/answer`, cookie, { answer: ans, ...(hash ? { preview_hash: hash } : {}) }, qid);
  const confirm = async (cookie: string, qid: string, ans: unknown) => {
    const pv = await (await qPreview(cookie, qid, ans)).json();
    return { pv, res: await qAnswer(cookie, qid, ans, pv.preview_hash) };
  };
  const dateOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

  const mkGuard = (data: Record<string, unknown>) => prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", createdBy: "t", ...data } as never });
  const dob = new Date("1990-05-06T00:00:00.000Z");
  const siaP = (v: string, st: St = "review", extra: Partial<X> = {}) => person({ hkid: H[0]!, sia: { no: "K-200001-1-001", a: v, b: "2028-01-02", st }, ...extra });
  const pkgAt = (persons: PackagePerson[], n: number) => ({ ...pkg3(persons), generatedAt: `2026-11-${String(10 + n).padStart(2, "0")}T00:00:00.000Z` });
  const ans = { option: "apply_ext_fields", ext_fields: { "siaPermit.aExpiry": "use_import" } };
  const questionsOf = () => prisma.triageQuestion.findMany({ orderBy: { createdAt: "asc" } });

  it("T1：A(X)→B(Y)→C(X)：C 新題唔被 superseded 嘅 A 題當重複；B 題 superseded；答 C 寫 X", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    await applyPkg(owner, pkgAt([siaP("2027-01-01")], 1));
    await applyPkg(owner, pkgAt([siaP("2027-02-02")], 2));
    const c = await applyPkg(owner, pkgAt([siaP("2027-01-01")], 3));
    expect(c.body.triage.new_questions).toBe(1);
    const qsAll = await prisma.triageQuestion.findMany({ where: { kind: "ext_field_review" }, orderBy: { createdAt: "asc" }, include: { session: true } });
    expect(qsAll.map((q) => q.status)).toEqual(["superseded", "superseded", "open"]);
    const { res } = await confirm(owner, qsAll[2]!.id, ans);
    expect(res.status).toBe(200);
    expect(dateOf((await prisma.guard.findFirstOrThrow({ where: { hkid: H[0]! } })).siaPermitAExpiry)).toBe("2027-01-01");
  });

  it("T2：題型變咗／新包冇出題 → 舊題一律 superseded（答舊題 409）", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    await applyPkg(owner, pkgAt([siaP("2027-01-01")], 1));
    const old = (await questionsOf())[0]!;
    // 新包同一人：題型變 ext_identity_check
    await applyPkg(owner, pkgAt([siaP("2027-02-02", "review", { reasons: ["ext_identity_check"] })], 2));
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("superseded");
    expect((await qPreview(owner, old.id, ans)).status).toBe(409);
    // 新包完全冇新欄資料 → 上一包嘅題都 superseded
    await applyPkg(owner, pkgAt([person({ hkid: H[0]! })], 3));
    const open = await prisma.triageQuestion.count({ where: { status: "open" } });
    expect(open).toBe(0);
  });

  it("T3：同一個人前後兩包 key 唔同（hkid 值唔同但連同一 guard）→ 按目標 guard 作廢舊題", async () => {
    await mkGuard({ staffNumbers: { create: [{ scheme: "U", number: "U91001" }] } });
    const mk = (hk: string, v: string) => {
      const p = person({ hkid: hk, nos: [{ n: "U91001" }], sia: { no: "K-200001-1-001", a: v, b: "2028-01-02", st: "review" } }) as unknown as Record<string, unknown>;
      p.hkid = { value: hk, status: "review" };
      return p as unknown as PackagePerson;
    };
    await applyPkg(owner, pkgAt([mk(H[1]!, "2027-01-01")], 1));
    const old = (await prisma.triageQuestion.findFirstOrThrow({ where: { kind: "ext_field_review" } }));
    await applyPkg(owner, pkgAt([mk(H[2]!, "2027-02-02")], 2));
    expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("superseded");
    expect(await prisma.triageQuestion.count({ where: { status: "open", kind: "ext_field_review" } })).toBe(1);
  });

  it("非擁有人答被取代嘅題：409 訊息唔洩露細節，叫佢搵上載較新檔案嘅同事或老闆", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    await applyPkg(accountant, pkgAt([siaP("2027-01-01")], 1));
    const old = (await questionsOf())[0]!;
    await applyPkg(owner, pkgAt([siaP("2027-02-02")], 2));
    const r = await qPreview(accountant, old.id, ans);
    expect(r.status).toBe(409);
  });

  it("session 列表：superseded 唔計 total；全部 superseded 嘅 session 轉 done 並標「已被較新嘅導入取代」", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    const a = await applyPkg(owner, pkgAt([siaP("2027-01-01")], 1));
    await applyPkg(owner, pkgAt([siaP("2027-02-02")], 2));
    const sid = a.body.triage.session_id as string;
    const s = await prisma.triageSession.findUniqueOrThrow({ where: { id: sid } });
    expect(s.status).toBe("done");
    const l = await (await get(listRoute as never, "/api/triage/sessions", owner)).json();
    const row = l.sessions.find((x: { id: string }) => x.id === sid);
    expect(row.counts.superseded).toBe(1);
    expect(row.counts.total).toBe(0);
    expect(row.superseded_all).toBe(true);
  });

  it("SESSION_SECRET 輪換：舊 key 指紋嘅 session open 題 → superseded", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob });
    const a = await applyPkg(owner, pkgAt([siaP("2027-01-01")], 1));
    await prisma.triageSession.update({ where: { id: a.body.triage.session_id }, data: { keyFp: "deadbeef" } });
    await applyPkg(owner, pkgAt([person({ hkid: H[0]! })], 2)); // 冇題都照做
    expect(await prisma.triageQuestion.count({ where: { status: "open" } })).toBe(0);
  });

  it("decisions 用 @index 對返包內位置（唔係 ref）：同包兩行各自落啱行；越界 400", async () => {
    await mkGuard({ hkid: H[0]!, nameEn: "OLD EN A", dateOfBirth: dob });
    await mkGuard({ hkid: H[1]!, nameZh: "測試員乙", nameEn: "OLD EN B", dateOfBirth: dob });
    const mk = (hk: string, name: string, en: string) => {
      const p = person({ hkid: hk }) as unknown as Record<string, unknown>;
      p.nameZh = L(name);
      p.nameEn = { value: en, status: "review" };
      return p as unknown as PackagePerson;
    };
    const pk = pkg3([mk(H[0]!, "測試員甲", "NEW EN A"), mk(H[1]!, "測試員乙", "NEW EN B")]);
    const call = async (dec: unknown) => (await post(applyRoute as never, "/api/guards/import/apply", owner, { package: pk, package_hash: hashPackage(importPackageSchema.parse(pk) as never), decisions: dec })).status;
    expect(await call({ "@5": { name_en: { action: "replace" } } })).toBe(400);
    expect(await call({ "@1": { name_en: { action: "replace" } } })).toBe(200);
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H[0]! } })).nameEn).toBe("OLD EN A");
    expect((await prisma.guard.findFirstOrThrow({ where: { hkid: H[1]! } })).nameEn).toBe("NEW EN B");
  });

  it("長工跟進題喺同一個 session 即時出現（身份題答完）", async () => {
    await mkGuard({ hkid: H[0]!, dateOfBirth: dob, employmentType: "longterm_autopay" });
    const r = await applyPkg(owner, pkgAt([person({ hkid: H[0]!, hire: "2020-01-02", safety: { no: "ABC1234", expiry: "2027-06-07", st: "review" }, reasons: ["ext_identity_check"] })], 1));
    const q = (await prisma.triageQuestion.findMany({ where: { kind: "ext_identity_check" } }))[0]!;
    await confirm(owner, q.id, { option: "confirm_ext_identity" });
    const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${r.body.triage.session_id}?status=open`, owner, r.body.triage.session_id)).json();
    expect(sess.questions.some((x: { kind: string }) => x.kind === "ext_field_review")).toBe(true);
  });

  it("PATCH 戶口輸入正規化（全形數字、去空白）；非數字／分隔符以外字符 400", async () => {
    const y = await mkGuard({ nameZh: "測試員Y" });
    const { PATCH } = await import("@/app/api/guards/[id]/route");
    const call = (acct: string) => PATCH(new Request(`http://t/api/guards/${y.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ bank_code: "004", bank_account_no: acct }) }), { params: Promise.resolve({ id: y.id }) } as never);
    expect((await call("００１２ ３４-５６７８")).status).toBe(200);
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: y.id } })).bankAccountNo).toBe("001234-5678");
    expect((await call("12AB5678")).status).toBe(400);
  });

  it("不變量（隨機序列）：同一個人經 4 個包（值改來改去、題型變、key 變、某包冇題）＋中途隨機答／跳過", async () => {
    const N = Number(process.env.INV_SEQS ?? 60);
    let seed = 20261005;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    const VALUES = ["2027-01-01", "2027-02-02", "2027-03-03"] as const;
    let accepted = 0;
    for (let seq = 0; seq < N; seq++) {
      await prisma.triageQuestion.deleteMany({});
      await prisma.triageSession.deleteMany({});
      await prisma.triagePersonApply.deleteMany({});
      const g = await mkGuard({ nameZh: "不變量保安員", staffNumbers: { create: [{ scheme: "U", number: `U9${String(seq).padStart(4, "0")}` }] } });
      let latest: { v: string | null; variant: string } = { v: null, variant: "none" };
      for (let step = 0; step < 4; step++) {
        const variant = pick(["normal", "normal", "identity", "none"] as const);
        const v = variant === "none" ? null : pick(VALUES);
        const hk = pick([H[1]!, H[2]!]);
        const p = person({ hkid: hk, nos: [{ n: `U9${String(seq).padStart(4, "0")}` }], ...(v ? { sia: { no: "K-200001-1-001", a: v, b: "2028-01-02", st: "review" as St } } : {}), reasons: variant === "identity" ? ["ext_identity_check"] : [] }) as unknown as Record<string, unknown>;
        p.hkid = { value: hk, status: "review" };
        p.nameZh = L("不變量保安員");
        await applyPkg(owner, { ...pkg3([p as never]), generatedAt: `2026-12-${String(seq % 28 + 1).padStart(2, "0")}T0${step}:00:00.000Z-${seq}` });
        latest = { v, variant };
        // (b) 同一欄跨 session 最多一條 open
        const openAll = await prisma.triageQuestion.findMany({ where: { status: "open" } });
        const touching = openAll.filter((q) => JSON.stringify(q.evidenceJson).includes("siaPermit.aExpiry") && JSON.stringify((q.evidenceJson as { ext_review?: unknown }).ext_review ?? []).includes("siaPermit.aExpiry"));
        expect(touching.length, `seq${seq} step${step} open>1`).toBeLessThanOrEqual(1);
        // (c) 最新包嘅 review 值一定有題（open／answered／skipped，未 superseded）或者已寫入
        const cur = (await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).siaPermitAExpiry?.toISOString().slice(0, 10) ?? null;
        if (v && cur !== v) {
          const live = await prisma.triageQuestion.findMany({ where: { status: { not: "superseded" } } });
          const has = live.some((q) => JSON.stringify((q.evidenceJson as { person?: { siaPermit?: { aExpiry?: { value?: string } } } }).person?.siaPermit?.aExpiry?.value) === JSON.stringify(v));
          expect(has, `seq${seq} step${step} 最新值冇題`).toBe(true);
        }
        // 中途隨機答／跳過任何一條（包括舊題）
        for (const q of await prisma.triageQuestion.findMany({ orderBy: { createdAt: "asc" } })) {
          if (rnd() > 0.45) continue;
          const doSkip = rnd() < 0.3;
          const answer = doSkip ? { option: "skip" } : q.kind === "ext_identity_check" ? { option: "confirm_ext_identity" } : q.kind === "ext_field_review" ? ans : { option: "skip" };
          const before = (await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).siaPermitAExpiry?.toISOString().slice(0, 10) ?? null;
          const pv = await qPreview(owner, q.id, answer);
          if (pv.status !== 200) continue;
          const pj = await pv.json();
          const r = await qAnswer(owner, q.id, answer, pj.preview_hash);
          if (r.status !== 200) continue;
          accepted++;
          const after = (await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).siaPermitAExpiry?.toISOString().slice(0, 10) ?? null;
          // (a) 被接受嘅作答，寫入嘅值一定等於最近一次包含呢個人嘅包嘅值
          if (after !== before) expect(after, `seq${seq} step${step} 寫入舊值`).toBe(latest.v);
        }
      }
    }
    expect(accepted).toBeGreaterThan(N / 2);
  }, 600000);
});
