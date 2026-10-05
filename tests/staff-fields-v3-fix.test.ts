// WP-STAFF-FIELDS 第二階段：導入包 v3（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「測試」姓名、00000 開頭戶口）；唔讀 data/。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as previewImportRoute } from "@/app/api/guards/import/preview/route";
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
const ACCT2 = "000087654321";
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
const checks = (a: { key: string; check: string }[] | undefined) => rec(a, (x) => x.check);
const pkg3 = (persons: PackagePerson[], unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string }[]) => ({
  version: 3 as const,
  generatedAt: "2026-10-05T00:00:00.000Z",
  persons,
  ...(unassigned ? { unassignedBankAccounts: unassigned } : {}),
});

describe("WP-STAFF-FIELDS 第二階段：Opus 驗收修正（B1／M1–M7／Minor）", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;

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

  describe("B1：打字名單 only 嘅人", () => {
    const full: X = { nos: [{ n: "U77001" }], sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, bank: {} };
    const mkWithNo = (g: Record<string, unknown>) => mkGuard({ ...g, staffNumbers: { create: [{ scheme: "U", number: "U77001" }] } });

    it("(c) 姓名唔同、淨靠工號 link → 新欄全部唔寫（包括銀行），出 ext_identity_check", async () => {
      const g = await mkWithNo({ nameZh: "測試員其他" });
      const r = await applyPkg(owner, pkg3([typedPerson(full, H[2]!)]));
      expect(Object.values(outs(r.body.results[0].ext))).toEqual(expect.arrayContaining(["held"]));
      expect(Object.values(outs(r.body.results[0].ext)).every((o) => o === "held")).toBe(true);
      const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
      expect([a.siaPermitNo, a.bankAccountNo]).toEqual([null, null]);
      expect(await prisma.triageQuestion.count({ where: { kind: "ext_identity_check" } })).toBe(1);
    });
    it("(c) DB 身份證同名單唔同 → 衝突（唔寫）", async () => {
      await mkWithNo({ hkid: H[3]! });
      const r = await applyPkg(owner, pkg3([typedPerson(full, H[2]!)]));
      expect(r.body.results[0].outcome).toBe("conflict");
      expect(await prisma.guard.count({ where: { bankAccountNo: { not: null } } })).toBe(0);
    });
    it("(a) DB 身份證同名單完全相同 → 全部 confirmed 新欄（包括銀行）自動寫", async () => {
      const g = await mkWithNo({ hkid: H[2]! });
      await applyPkg(owner, pkg3([typedPerson(full, H[2]!, "測試員唔同名")]));
      const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
      expect([a.siaPermitNo, a.bankAccountNo]).toEqual(["K-200001-1-001", ACCT]);
    });
    it("(b) 靠工號 link、DB 冇身份證、中文姓名完全相同 → 非銀行自動寫，銀行出 bank_review 要人確認", async () => {
      const g = await mkWithNo({ nameZh: "測試員甲" });
      const r = await applyPkg(owner, pkg3([typedPerson(full, H[2]!)]));
      const o = outs(r.body.results[0].ext);
      expect(o).toMatchObject({ "siaPermit.no": "written", bank: "held" });
      const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
      expect([a.siaPermitNo, a.bankAccountNo]).toEqual(["K-200001-1-001", null]);
      const q = (await qs("bank_review"))[0]!;
      expect(q).toBeTruthy();
      const { res } = await confirm(owner, q.id, { option: "apply_ext_fields", ext_fields: { bank: "use_import" } });
      expect(res.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).bankAccountNo).toBe(ACCT);
    });
    it("有文件嘅人：basis 冇身份證相同（淨工號 link）→ 銀行唔自動寫，出 bank_review；身份證相同照寫", async () => {
      const g = await mkWithNo({ nameZh: "測試員甲" }); // DB 冇 hkid → 淨工號 link
      const p = person({ ...full, hkid: H[4]! });
      const r = await applyPkg(owner, pkg3([p]));
      expect(outs(r.body.results[0].ext).bank).toBe("held");
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).bankAccountNo).toBeNull();
      expect(await prisma.triageQuestion.count({ where: { kind: "bank_review" } })).toBe(1);
    });
    it("ext_identity_check 由冇銀行 update 嘅人答：銀行唔寫，留 bank_review；寫入目標鎖定題目建立時嘅 guard", async () => {
      const g = await mkWithNo({ nameZh: "測試員其他" });
      const r = await applyPkg(owner, pkg3([typedPerson(full, H[2]!)]));
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "update" } }, data: { granted: false } });
      const sid = r.body.triage.session_id as string;
      await post(reassignRoute as never, `/api/triage/sessions/${sid}/reassign`, owner, { owner_user_id: fx.userIds["會計"] }, sid);
      // 之後另一個同名安員出現（唔好令目標變）
      await mkGuard({ nameZh: "測試員甲", staffNumbers: { create: [{ scheme: "MP", number: "MP77002" }] } });
      const q = (await qs("ext_identity_check"))[0]!;
      const { res } = await confirm(accountant, q.id, { option: "confirm_ext_identity" });
      expect(res.status).toBe(200);
      const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
      expect([a.siaPermitNo, a.bankAccountNo]).toEqual(["K-200001-1-001", null]);
      expect(await prisma.triageQuestion.count({ where: { kind: "bank_review", status: "open" } })).toBe(1);
    });
  });

  describe("M1：同一個戶口唔可以屬於兩個安員", () => {
    it("自動路徑：戶口已屬另一位 → conflict、出 bank_review、唔寫；冇 bank view 嘅回應唔露原因", async () => {
      await mkGuard({ nameZh: "測試員Z", bankCode: "004", bankName: "匯豐銀行", bankAccountNo: ACCT, bankPayeeName: PAYEE });
      await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      const r = await applyPkg(owner, pkg3([person({ bank: { acct: ACCT } })]));
      expect(outs(r.body.results[0].ext).bank).toBe("conflict");
      expect(r.body.results[0].reasons).toContain("bank_acct_belongs_to_other");
      expect(await prisma.guard.count({ where: { bankAccountNo: ACCT } })).toBe(1);
      expect(await prisma.triageQuestion.count({ where: { kind: "bank_review" } })).toBe(1);
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
      const r2 = await applyPkg(accountant, pkg3([person({ bank: { acct: ACCT } })]));
      expect(JSON.stringify(r2.body)).not.toContain("bank_acct_belongs_to_other");
    });
    it("分診路徑：assign_bank 去已被用嘅戶口 → 預覽 can_confirm=false、強行確認 422", async () => {
      const x = await mkGuard({ nameZh: "測試員X", nameEn: "ONE TEST PAYEE", employmentType: "longterm_autopay" });
      await applyPkg(owner, pkg3([], [{ key: "pe:004:5678", bankCode: "004", accountNo: ACCT, payeeName: "TEST ONE PAYEE" }]));
      const q = (await qs("bank_identity_unknown"))[0]!;
      // 開咗題之後，戶口被另一位安員用咗
      await mkGuard({ nameZh: "測試員Z", bankCode: "004", bankName: "匯豐銀行", bankAccountNo: ACCT, bankPayeeName: PAYEE });
      const ans = { option: "assign_bank", guard_id: x.id };
      const pv = await (await qPreview(owner, q.id, ans)).json();
      expect(pv.impact.can_confirm).toBe(false);
      expect((await qAnswer(owner, q.id, ans, pv.preview_hash)).status).toBe(422);
      expect(await prisma.guard.count({ where: { bankAccountNo: ACCT } })).toBe(1);
    });
    it("並發：兩個請求同時將同一戶口派俾兩個人，只可以一個成功", async () => {
      const x = await mkGuard({ nameZh: "測試員X", nameEn: "ONE TEST PAYEE", employmentType: "longterm_autopay" });
      const y = await mkGuard({ nameZh: "測試員Y", nameEn: "ONE TEST PAYEE", employmentType: "longterm_autopay" });
      const u = [{ key: "pe:004:5678", bankCode: "004", accountNo: ACCT, payeeName: "TEST ONE PAYEE" }];
      await applyPkg(owner, pkg3([], u));
      await applyPkg(owner, { ...pkg3([], u), generatedAt: "2026-10-06T00:00:00.000Z" }); // 第二個 session（M4 去重會令佢唔出題→直接複製題目）
      let qsList = await qs("bank_identity_unknown");
      if (qsList.length < 2) {
        const q0 = qsList[0]!;
        const s2 = await prisma.triageSession.create({ data: { sourceType: "guard_import", sourceRef: "other-hash", ownerUserId: q0.sessionId ? (await prisma.triageSession.findUniqueOrThrow({ where: { id: q0.sessionId } })).ownerUserId : "x", createdBy: "t", statsJson: {} } });
        await prisma.triageQuestion.create({ data: { sessionId: s2.id, kind: q0.kind, groupKey: q0.groupKey, sort: q0.sort, title: q0.title, evidenceJson: q0.evidenceJson as never, optionsJson: q0.optionsJson as never } });
        qsList = await qs("bank_identity_unknown");
      }
      const run = async (q: (typeof qsList)[number], gid: string) => {
        const ans = { option: "assign_bank", guard_id: gid, confirm_identity: true };
        const pv = await (await qPreview(owner, q.id, ans)).json();
        return (await qAnswer(owner, q.id, ans, pv.preview_hash)).status;
      };
      // 先各自取得預覽（此刻戶口未被用），再同時確認
      const ans = (gid: string) => ({ option: "assign_bank", guard_id: gid, confirm_identity: true });
      const pvs = await Promise.all([qPreview(owner, qsList[0]!.id, ans(x.id)).then((r) => r.json()), qPreview(owner, qsList[1]!.id, ans(y.id)).then((r) => r.json())]);
      const sts = await Promise.all([qAnswer(owner, qsList[0]!.id, ans(x.id), pvs[0].preview_hash).then((r) => r.status), qAnswer(owner, qsList[1]!.id, ans(y.id), pvs[1].preview_hash).then((r) => r.status)]);
      void run;
      expect(sts.filter((s) => s === 200)).toHaveLength(1);
      expect(await prisma.guard.count({ where: { bankAccountNo: ACCT } })).toBe(1);
    });
  });

  describe("M2：bank replace 一律四欄一齊", () => {
    it("包內銀行四欄唔齊 → replace／確認 422（唔砌半套戶口）；自動路徑唔寫", async () => {
      const g = await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), bankCode: "024", bankName: "恒生銀行", bankAccountNo: ACCT2, bankPayeeName: PAYEE });
      const p = person({ bank: { st: "review" } }) as unknown as { bank: { payeeName: unknown } };
      p.bank.payeeName = L(null);
      await applyPkg(owner, pkg3([p as never]));
      const q = (await qs("bank_review"))[0]!;
      const ans = { option: "apply_ext_fields", ext_fields: { bank: "use_import" }, replace_existing: true };
      const r = await qPreview(owner, q.id, ans);
      expect(r.status).toBe(422);
      const a = await prisma.guard.findUniqueOrThrow({ where: { id: g.id } });
      expect([a.bankCode, a.bankAccountNo, a.bankPayeeName]).toEqual(["024", ACCT2, PAYEE]);
    });
  });

  describe("M3：差分", () => {
    it("(a) 冇 PII view：decisions.ext emergency replace 估中 vs 估錯同一結果；含 decisions.ext 嘅請求計配額", async () => {
      const g = await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      await prisma.guardEmergencyContact.create({ data: { guardId: g.id, name: "測試聯絡人甲", tel: "91000011", createdBy: "t" } as never });
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: { in: ["view", "update"] } } }, data: { granted: false } });
      const run = async (tel: string) => {
        const pk = pkg3([person({ contacts: [{ name: "測試聯絡人乙", tel }] })]);
        const key = (pk.persons[0] as unknown as { key: string }).key;
        const res = await post(applyRoute as never, "/api/guards/import/apply", accountant, { package: pk, package_hash: hashPackage(importPackageSchema.parse(pk) as never), decisions: { [key]: { ext: { "emergency.1": "replace" } } } });
        return { status: res.status, body: JSON.stringify({ ...(await res.json()), triage: null }) };
      };
      const hit = await run("91000011");
      const miss = await run("91000022");
      expect(hit.status).toBe(miss.status);
      expect(hit.body).toBe(miss.body);
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: g.id } })).toBe(1);
      // 配額：decisions.ext 都寫預留行
      const reserves = await prisma.auditLog.count({ where: { action: "guard_quota_reserve", actorUserId: fx.userIds["會計"] } });
      expect(reserves).toBeGreaterThanOrEqual(2);
    });
    it("(a) 冇 PII view：自動 apply 估中（同一聯絡人）vs 估錯，出題數一樣", async () => {
      const g = await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      await prisma.guardEmergencyContact.create({ data: { guardId: g.id, name: "測試聯絡人甲", tel: "91000011", createdBy: "t" } as never });
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: "view" } }, data: { granted: false } });
      const res: unknown[] = [];
      for (const [name, tel] of [["測試聯絡人甲", "91000011"], ["測試聯絡人戊", "91000019"]] as const) {
        await prisma.triageQuestion.deleteMany({});
        await prisma.triageSession.deleteMany({});
        const r = await applyPkg(accountant, pkg3([person({ contacts: [{ name, tel }] })]));
        res.push([r.body.triage?.new_questions ?? null, r.body.triage?.important_open ?? null, r.body.triage?.supplementary_open ?? null]);
      }
      expect(res[0]).toEqual(res[1]);
    });
    it("(b) 有銀行 update 冇 view：bank_review 預覽（估啱／估錯）整個回應一樣", async () => {
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
      const g = await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), bankCode: "004", bankName: "匯豐銀行", bankAccountNo: ACCT, bankPayeeName: PAYEE });
      const pvs: string[] = [];
      for (const acct of [ACCT, ACCT2]) {
        await prisma.guard.update({ where: { id: g.id }, data: { bankAccountNo: ACCT } });
        await prisma.triageQuestion.deleteMany({});
        await prisma.triageSession.deleteMany({});
        await applyPkg(accountant, pkg3([person({ bank: { acct } })]));
        const q = (await qs("bank_review"))[0]!;
        const pv = await (await qPreview(accountant, q.id, { option: "apply_ext_fields", ext_fields: { bank: "use_import" }, replace_existing: true })).json();
        delete pv.preview_hash;
        pvs.push(JSON.stringify(pv));
      }
      expect(pvs[0]).toBe(pvs[1]);
      // 冇明確取代（replace_existing）→ 一律 422（唔視乎現值）
      const q = (await qs("bank_review"))[0]!;
      expect((await qPreview(accountant, q.id, { option: "apply_ext_fields", ext_fields: { bank: "use_import" } })).status).toBe(422);
    });
  });

  describe("M4：跨 session 去重", () => {
    it("v2 apply→答一題→v3 apply：已答嗰題唔再出；v2 類新題數只計真係新嘅人", async () => {
      await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      const mk2 = (hk: string, key: string, en: string): Record<string, unknown> => {
        const b = person({ hkid: hk, key }) as unknown as Record<string, unknown>;
        b.nameEn = { value: en, status: "review" };
        b.nameZh = L(`測試員${key}`);
        return b;
      };
      const base = [mk2(H[0]!, "k1", "ONE EN"), mk2(H[5]!, "k2", "TWO EN")];
      const v2 = { version: 2 as const, generatedAt: "x", persons: base };
      const r2 = await post(applyRoute as never, "/api/guards/import/apply", owner, { package: v2, package_hash: hashPackage(importPackageSchema.parse(v2) as never) });
      expect(r2.status).toBe(200);
      const fr = await qs("field_review");
      expect(fr.length).toBeGreaterThanOrEqual(1);
      const first = fr[0]!;
      const { res } = await confirm(owner, first.id, { option: "apply_fields", fields: { nameEn: { action: "confirm" } } });
      expect(res.status).toBe(200);
      const answeredKey = first.groupKey;
      const before = await prisma.triageQuestion.count();
      // v3：同樣兩人（穩定 key）＋ 多一個新人
      const p3 = [...base.map((b) => ({ ...b, siaPermit: { no: L("K-200001-1-001"), aExpiry: L("2027-03-04"), bExpiry: L("2028-01-02") } })), mk2(H[6]!, "k3", "THREE EN")];
      const r3 = await applyPkg(owner, pkg3(p3 as never));
      const after = await prisma.triageQuestion.findMany({ where: { kind: "field_review" } });
      expect(after.filter((q) => q.groupKey === answeredKey)).toHaveLength(1); // 已答嗰條冇重出
      expect(after.some((q) => q.groupKey === "k3")).toBe(true); // 新人先出新題
      expect(r3.body.triage.new_questions).toBeLessThanOrEqual(2);
      expect(await prisma.triageQuestion.count()).toBeLessThanOrEqual(before + 2);
    });
  });

  describe("M7 同 Minor", () => {
    it("single_ocr 包唔准帶 v3 欄（400）", async () => {
      const so = { ...pkg3([person({ bank: {} })]), source: "single_ocr" };
      expect((await previewPkg(owner, so as never)).status).toBe(400);
    });
    it("v2 hashPackage 黃金值（欄位次序固定）", () => {
      const v2 = importPackageSchema.parse({
        version: 2,
        generatedAt: "2026-01-01T00:00:00.000Z",
        persons: [{ key: "k", hkid: { value: null, status: "missing" }, nameZh: { value: "測試", status: "confirmed" }, nameEn: { value: null, status: "missing" }, dateOfBirth: { value: null, status: "missing" }, sex: { value: null, status: "missing" }, phone: { value: null, status: "missing" }, address: { value: null, status: "missing" }, staffNumbers: [{ scheme: "U", number: "U1" }], rating: "review", reasons: [] }],
      });
      expect(hashPackage(v2 as never)).toBe("d6e3186d03b8c150aa55faad4f213ee6c2aa8f1379933bdb38a1cf90b07f652c");
    });
    it("冇銀行 view：候選卡唔顯示「已有銀行戶口」；有 view 先顯示", async () => {
      const x = await mkGuard({ nameZh: "測試員X", nameEn: "ONE TEST PAYEE", bankCode: "024", bankAccountNo: ACCT2, bankPayeeName: PAYEE });
      await applyPkg(owner, pkg3([], [{ key: "pe:004:5678", bankCode: "004", accountNo: ACCT, payeeName: "TEST ONE PAYEE" }]));
      const q = (await qs("bank_identity_unknown"))[0]!;
      const view = async (c: string) => JSON.stringify(await (await get(sessionRoute as never, `/api/triage/sessions/${q.sessionId}`, c, q.sessionId)).json());
      expect(await view(owner)).toContain('"has":true');
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
      await prisma.triageSession.update({ where: { id: q.sessionId }, data: { ownerUserId: fx.userIds["會計"] } });
      const t = await view(accountant);
      expect(t).not.toContain('"has"');
      expect(t).not.toContain(x.id.slice(0, 0) + "tail4");
    });
    it("聯絡人「關係」冇 PII view 遮罩", async () => {
      await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      const r = await applyPkg(owner, pkg3([person({ contacts: [{ name: "測試聯絡人甲", rel: "朋友甲", tel: "91000011", st: "review" }] })]));
      const sid = r.body.triage.session_id as string;
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: "view" } }, data: { granted: false } });
      await post(reassignRoute as never, `/api/triage/sessions/${sid}/reassign`, owner, { owner_user_id: fx.userIds["會計"] }, sid);
      const t = JSON.stringify(await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, accountant, sid)).json());
      expect(t).not.toContain("朋友甲");
      expect(t).not.toContain("測試聯絡人甲");
    });
    it("逐工號入職日期：工號屬另一個人 → 預覽顯示 not_stored（同寫入一致：唔會寫）", async () => {
      await mkGuard({ nameZh: "測試員其他", staffNumbers: { create: [{ scheme: "U", number: "U55001" }] } });
      await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z") });
      const pk = pkg3([person({ nos: [{ n: "U55001", hire: "2020-01-02" }] })]);
      const pv = await previewPkg(owner, pk);
      expect(checks(pv.body.rows[0].ext)["staffHire.U55001"] ?? checks(pv.body.rows[0].ext)["staff_hire.U55001"]).toBe("not_stored");
      expect(pv.body.ext_stats.to_write.find((w: { key: string }) => w.key === "staffHire")).toBeUndefined();
    });
    it("長工：人層面入職日期唔自動寫（長工糧讀 guards.hire_date），出 ext_field_review；非長工照寫", async () => {
      const lt = await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), employmentType: "longterm_autopay" });
      const r = await applyPkg(owner, pkg3([person({ hire: "2020-01-02", nos: [{ n: "U66001", hire: "2020-01-02" }] })]));
      expect(outs(r.body.results[0].ext).hireDate).toBe("held");
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: lt.id } })).hireDate).toBeNull();
      expect(outs(r.body.results[0].ext)["staffHire.U66001"]).toBe("written"); // valid_from 長工糧冇讀
      const q = (await qs("ext_field_review"))[0]!;
      expect(q).toBeTruthy();
      await confirm(owner, q.id, { option: "apply_ext_fields", ext_fields: { hireDate: "use_import" } });
      expect(dateOf((await prisma.guard.findUniqueOrThrow({ where: { id: lt.id } })).hireDate)).toBe("2020-01-02");
    });
    it("audit 摘要唔含 ext_conflicts", async () => {
      await mkGuard({ hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), safetyCardNo: "OLD0001" });
      await applyPkg(owner, pkg3([person({ safety: { no: "NEW9999", expiry: "2027-06-07" } })]));
      const sums = await prisma.auditLog.findMany({ where: { tableName: "guard_import", action: "guard_import_apply" }, orderBy: { createdAt: "desc" }, take: 1 });
      expect(JSON.stringify(sums)).not.toContain("ext_conflicts");
    });
  });
});
