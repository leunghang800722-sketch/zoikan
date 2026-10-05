// WP-STAFF-FIELDS 第二階段：導入包 v3（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人／逐工號入職日期）。
// 全部合成資料（合法 check digit hkid 由 helper 計、9100xxxx 電話、「測試」姓名、00000 開頭戶口）；唔讀 data/。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, packageHasBank, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { deriveSiaPermitExpiry } from "@/lib/guards/staff-numbers";
import { evaluateExt, aggregateExt } from "@/lib/guards/import/ext";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { POST as previewImportRoute } from "@/app/api/guards/import/preview/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { GET as listRoute } from "@/app/api/triage/sessions/route";
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
const counts = (a: { key: string; count: number }[] | undefined) => rec(a, (x) => x.count);
const pkg3 = (persons: PackagePerson[], unassigned?: { key: string; bankCode: string; accountNo: string; payeeName: string }[]) => ({
  version: 3 as const,
  generatedAt: "2026-10-05T00:00:00.000Z",
  persons,
  ...(unassigned ? { unassignedBankAccounts: unassigned } : {}),
});

describe("WP-STAFF-FIELDS 第二階段：導入包 v3", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;

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
  const guardOf = (hkid: string) => prisma.guard.findFirstOrThrow({ where: { hkid }, include: { staffNumbers: true } });
  const dateOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

  // -------------------------------------------------------------------------
  describe("解析", () => {
    it("v3 合法包通過；v2 包完全不變（含 v2 拒絕任何 v3 欄）", () => {
      const p = person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, bank: {}, contacts: [{ name: "測試聯絡人甲", rel: "朋友", tel: "91000011" }], nos: [{ n: "U90001", hire: "2020-01-02" }], hire: "2020-01-02" });
      expect(importPackageSchema.safeParse(pkg3([p])).success).toBe(true);
      const v2 = { version: 2 as const, generatedAt: "x", persons: [{ ...person(), staffNumbers: [{ scheme: "U", number: "U90001" }] }] };
      expect(importPackageSchema.safeParse(v2).success).toBe(true);
      // v2 帶 v3 欄 → 拒絕
      expect(importPackageSchema.safeParse({ ...v2, persons: [{ ...v2.persons[0], bank: (p as never as { bank: unknown }).bank }] }).success).toBe(false);
      expect(importPackageSchema.safeParse({ ...v2, unassignedBankAccounts: [] }).success).toBe(false);
      // v2 逐工號 hireDate → 拒絕
      expect(importPackageSchema.safeParse({ ...v2, persons: [{ ...v2.persons[0], staffNumbers: [{ scheme: "U", number: "U90001", hireDate: L("2020-01-02") }] }] }).success).toBe(false);
    });

    it("嚴格驗證：日期曆法／範圍、電話香港格式、銀行代號、戶口只准數字、許可證格式", () => {
      const bad = (mut: (p: Record<string, unknown>) => void) => {
        const p = person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, safety: { no: "ABC1234", expiry: "2027-01-01" }, qas: { issue: "2021-01-01", expiry: "2030-01-01" }, bank: {}, contacts: [{ name: "測試聯絡人甲", tel: "91000011" }] }) as unknown as Record<string, unknown>;
        mut(p);
        return importPackageSchema.safeParse(pkg3([p as never])).success;
      };
      expect(bad(() => {})).toBe(true);
      expect(bad((p) => ((p.siaPermit as Record<string, unknown>).aExpiry = L("2027-02-30")))).toBe(false); // 曆法
      expect(bad((p) => ((p.siaPermit as Record<string, unknown>).aExpiry = L("2050-01-01")))).toBe(false); // 屆滿日範圍
      expect(bad((p) => ((p.siaPermit as Record<string, unknown>).no = L("K200001-1")))).toBe(false); // 許可證格式
      expect(bad((p) => ((p.qas as Record<string, unknown>).issueDate = L("2999-01-01")))).toBe(false); // 簽發日不可在將來
      expect(bad((p) => ((p.emergencyContacts as Record<string, unknown>[])[0]!.tel = L("12345678")))).toBe(false); // 首位 1 非香港號
      expect(bad((p) => ((p.emergencyContacts as Record<string, unknown>[])[0]!.tel = L("9100 0011")))).toBe(false); // 要純 8 位
      expect(bad((p) => ((p.bank as Record<string, unknown>).code = L("999")))).toBe(false); // 唔喺 HKICL 表
      expect(bad((p) => ((p.bank as Record<string, unknown>).accountNo = L("000-1234-5678")))).toBe(false); // 戶口只准數字
      expect(bad((p) => ((p.emergencyContacts as unknown[]).push(...Array(4).fill((p.emergencyContacts as unknown[])[0]))))).toBe(false); // 最多 4 位
      expect(importPackageSchema.safeParse(pkg3([], [{ key: "pe:1", bankCode: "999", accountNo: ACCT, payeeName: PAYEE }])).success).toBe(false);
      expect(importPackageSchema.safeParse(pkg3([], [{ key: "pe:1", bankCode: "004", accountNo: "12-34", payeeName: PAYEE }])).success).toBe(false);
    });

    it("packageHasBank：person.bank 有值或 unassignedBankAccounts 非空", () => {
      expect(packageHasBank(importPackageSchema.parse(pkg3([person()])) as never)).toBe(false);
      expect(packageHasBank(importPackageSchema.parse(pkg3([person({ bank: {} })])) as never)).toBe(true);
      expect(packageHasBank(importPackageSchema.parse(pkg3([person()], [{ key: "pe:1", bankCode: "004", accountNo: ACCT, payeeName: PAYEE }])) as never)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("寫入：新建／補空欄／衝突", () => {
    it("新建安員：新欄全部 confirmed 寫入；牌照衍生欄同 PATCH 邏輯一致；緊急聯絡人入子表並同步 legacy；逐工號入職日期", async () => {
      const p = person({
        nos: [{ n: "U90001", hire: "2021-02-03" }],
        sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" },
        safety: { no: "ABC1234", expiry: "2027-06-07" },
        qas: { issue: "2021-01-01", expiry: "2031-01-01" },
        hire: "2021-02-03",
        bank: {},
        contacts: [
          { name: "測試聯絡人甲", rel: "朋友", tel: "91000011" },
          { name: "測試聯絡人乙", rel: "家人", tel: "91000012" },
        ],
      });
      const r = await applyPkg(owner, pkg3([p]));
      expect(r.status).toBe(200);
      expect(r.body.outcomes.created).toBe(1);
      expect(counts(r.body.ext_written)).toMatchObject({ "siaPermit.no": 1, "siaPermit.aExpiry": 1, "siaPermit.bExpiry": 1, "safetyCard.no": 1, bank: 1, hireDate: 1, staffHire: 1 });
      expect(r.body.contacts_added).toBe(2);
      const g = await guardOf(H[0]!);
      expect(g.siaPermitNo).toBe("K-200001-1-001");
      expect(dateOf(g.siaPermitAExpiry)).toBe("2027-03-04");
      expect(dateOf(g.siaPermitBExpiry)).toBe("2028-01-02");
      const d = deriveSiaPermitExpiry({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry, dateOfBirth: g.dateOfBirth });
      expect(dateOf(g.siaPermitExpiry)).toBe(dateOf(d.siaPermitExpiry));
      expect(g.siaPermitType).toBe(d.siaPermitType);
      expect(g.siaPermitType).toBe("A+B");
      expect(g.safetyCardNo).toBe("ABC1234");
      expect(dateOf(g.qasIssueDate)).toBe("2021-01-01");
      expect(dateOf(g.qasExpiryDate)).toBe("2031-01-01");
      expect(dateOf(g.hireDate)).toBe("2021-02-03");
      expect([g.bankCode, g.bankName, g.bankAccountNo, g.bankPayeeName]).toEqual(["004", "匯豐銀行", ACCT, PAYEE]);
      expect(dateOf(g.staffNumbers[0]!.validFrom)).toBe("2021-02-03");
      const cs = await prisma.guardEmergencyContact.findMany({ where: { guardId: g.id }, orderBy: { sortOrder: "asc" } });
      expect(cs.map((c) => [c.name, c.relationship, c.tel, c.source])).toEqual([
        ["測試聯絡人甲", "朋友", "91000011", "staff_fields_import"],
        ["測試聯絡人乙", "家人", "91000012", "staff_fields_import"],
      ]);
      expect([g.emergencyContactName, g.emergencyContactTel]).toEqual(["測試聯絡人甲", "91000011"]); // legacy 同步＝sort_order 最細
    });

    it("乙類滿 70 歲：衍生欄同 PATCH 一致（A 單獨）；A/B 皆空 → 唔寫衍生欄", async () => {
      const old = person({ hkid: H[1]!, sia: { no: "L-200001-1-001", a: "2027-03-04", b: "2028-01-02" } });
      (old as unknown as { dateOfBirth: unknown }).dateOfBirth = L("1950-01-01");
      await applyPkg(owner, pkg3([old]));
      const g = await guardOf(H[1]!);
      const d = deriveSiaPermitExpiry({ siaPermitAExpiry: g.siaPermitAExpiry, siaPermitBExpiry: g.siaPermitBExpiry, dateOfBirth: g.dateOfBirth });
      expect(g.siaPermitType).toBe(d.siaPermitType);
      expect(g.siaPermitType).toBe("A");
      const none = person({ hkid: H[2]!, safety: { no: "ZZZ9999", expiry: null } });
      await applyPkg(owner, pkg3([none]));
      const g2 = await guardOf(H[2]!);
      expect(g2.siaPermitType).toBeNull();
      expect(g2.siaPermitExpiry).toBeNull();
    });

    it("只補空欄：現有值唔同＝conflict、唔覆蓋、出分診題（補充資料層）；相同＝same", async () => {
      const g0 = await prisma.guard.create({
        data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, siaPermitNo: "K-200001-1-001", siaPermitAExpiry: new Date("2026-12-31T00:00:00.000Z"), safetyCardNo: "OLD0001", createdBy: "t" },
      });
      const p = person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, safety: { no: "NEW9999", expiry: "2027-06-07" } });
      const r = await applyPkg(owner, pkg3([p]));
      expect(r.status).toBe(200);
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect(g.siaPermitNo).toBe("K-200001-1-001"); // same
      expect(dateOf(g.siaPermitAExpiry)).toBe("2026-12-31"); // 唔覆蓋
      expect(dateOf(g.siaPermitBExpiry)).toBe("2028-01-02"); // 補空
      expect(g.safetyCardNo).toBe("OLD0001"); // 唔覆蓋
      expect(dateOf(g.safetyCardExpiry)).toBe("2027-06-07");
      expect(g.siaPermitType).toBe("A+B"); // 衍生欄一致
      expect(dateOf(g.siaPermitExpiry)).toBe("2027-03-04".replace("2027-03-04", "2026-12-31"));
      const res = r.body.results[0];
      expect(outs(res.ext)).toMatchObject({ "siaPermit.aExpiry": "conflict", "siaPermit.no": "same", "safetyCard.expiry": "written" });
      const cq = await qs("ext_field_conflict");
      expect(cq).toHaveLength(1);
      expect((cq[0]!.evidenceJson as { ext_review: { key: string }[] }).ext_review.map((x) => x.key).sort()).toEqual(["safetyCard.no", "siaPermit.aExpiry"]);
      expect(r.body.triage.supplementary_open).toBe(1);
      expect(r.body.triage.important_open).toBe(0);
    });

    it("review 狀態唔自動寫；出 ext_field_review 題；逐欄「用導入值／保留現值／跳過」；預覽＝實際寫入", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, safetyCardNo: "OLD0001", createdBy: "t" } });
      const p = person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02", st: "review" }, safety: { no: "NEW9999", expiry: "2027-06-07", st: "review" } });
      const r = await applyPkg(owner, pkg3([p]));
      expect(r.body.ext_written).toEqual([]);
      const before = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect(before.siaPermitNo).toBeNull();
      const q = (await qs("ext_field_review"))[0]!;
      expect(q).toBeTruthy();
      const ans = { option: "apply_ext_fields", ext_fields: { "siaPermit.no": "use_import", "siaPermit.aExpiry": "use_import", "safetyCard.no": "keep_current", "safetyCard.expiry": "skip" } };
      const pv = await (await qPreview(owner, q.id, ans)).json();
      expect(pv.impact.can_confirm).toBe(true);
      const mid = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect(mid.siaPermitNo).toBeNull(); // 預覽唔寫
      const res = await qAnswer(owner, q.id, ans, pv.preview_hash);
      expect(res.status).toBe(200);
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect(g.siaPermitNo).toBe("K-200001-1-001");
      expect(dateOf(g.siaPermitAExpiry)).toBe("2027-03-04");
      expect(g.siaPermitBExpiry).toBeNull(); // 冇提到＝review 唔寫
      expect(g.safetyCardNo).toBe("OLD0001"); // 保留現值
      expect(g.safetyCardExpiry).toBeNull();
      // 已答唔再出、再答 409
      expect((await qAnswer(owner, q.id, ans, pv.preview_hash)).status).toBe(409);
    });

    it("覆蓋權：用導入值覆蓋現有非空值要「安員:update」；會計冇 → 403 唔寫；補空欄得", async () => {
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員", action: "update" } }, data: { granted: false } });
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, safetyCardNo: "OLD0001", createdBy: "t" } });
      await applyPkg(accountant, pkg3([person({ safety: { no: "NEW9999", expiry: "2027-06-07" } })]));
      const q = (await qs("ext_field_conflict"))[0]!;
      const r = await qPreview(accountant, q.id, { option: "apply_ext_fields", ext_fields: { "safetyCard.no": "use_import" } });
      expect(r.status).toBe(403);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).safetyCardNo).toBe("OLD0001");
      const ok = await confirm(owner, q.id, { option: "apply_ext_fields", ext_fields: { "safetyCard.no": "use_import" } });
      expect(ok.res.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).safetyCardNo).toBe("NEW9999");
    });

    it("冪等：同包再上載唔重複寫、唔重複出題、唔重複加聯絡人；已答／已跳過唔再出", async () => {
      await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, safetyCardNo: "OLD0001", createdBy: "t" } });
      const pkg = pkg3([person({ safety: { no: "NEW9999", expiry: "2027-06-07" }, contacts: [{ name: "測試聯絡人甲", tel: "91000011" }], hire: "2020-01-02" })]);
      const a = await applyPkg(owner, pkg);
      expect(a.body.contacts_added).toBe(1);
      const total1 = a.body.triage.total_questions;
      const b = await applyPkg(owner, pkg);
      expect(b.body.contacts_added).toBe(0);
      expect(b.body.ext_written).toEqual([]);
      expect(b.body.triage.new_questions).toBe(0);
      expect(b.body.triage.total_questions).toBe(total1);
      expect(await prisma.guardEmergencyContact.count()).toBe(1);
      // 跳過後再上載唔重出
      const q = (await qs("ext_field_conflict"))[0]!;
      expect((await qAnswer(owner, q.id, { option: "skip" })).status).toBe(200);
      const c = await applyPkg(owner, pkg);
      expect(c.body.triage.new_questions).toBe(0);
      expect(await prisma.triageQuestion.count({ where: { kind: "ext_field_conflict" } })).toBe(1);
    });

    it("逐工號入職日期：只補 valid_from 空嘅行；已有唔同值＝conflict 唔覆蓋", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, createdBy: "t" } });
      await prisma.guardStaffNumber.create({ data: { guardId: g0.id, scheme: "U", number: "U90001", status: "current" } });
      await prisma.guardStaffNumber.create({ data: { guardId: g0.id, scheme: "MP", number: "MP90002", status: "current", validFrom: new Date("2019-01-01T00:00:00.000Z") } });
      const r = await applyPkg(owner, pkg3([person({ nos: [{ n: "U90001", hire: "2020-05-06" }, { n: "MP90002", hire: "2020-05-06" }] })]));
      const rows = await prisma.guardStaffNumber.findMany({ where: { guardId: g0.id }, orderBy: { number: "asc" } });
      expect(rows.map((x) => [x.number, dateOf(x.validFrom)])).toEqual([["MP90002", "2019-01-01"], ["U90001", "2020-05-06"]]);
      expect(outs(r.body.results[0].ext)).toMatchObject({ "staffHire.U90001": "written", "staffHire.MP90002": "conflict" });
      expect(r.body.ext_conflicts).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("緊急聯絡人", () => {
    it("多值全部保留：同名同電話已存在唔重複加，其餘 confirmed 逐個加（唔因為已有其他聯絡人就出題）；同一聯絡人欄位值衝突（同電話唔同名）先出題", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, createdBy: "t" } });
      await prisma.guardEmergencyContact.create({ data: { guardId: g0.id, name: "測試聯絡人甲", tel: "91000011", relationship: "朋友", sortOrder: 0 } });
      const p = person({
        contacts: [
          { name: "測試聯絡人甲", rel: "朋友", tel: "91000011" },
          { name: "測試聯絡人乙", rel: "家人", tel: "91000012" },
          { name: "測試聯絡人丙", rel: "家人", tel: "91000013" },
          { name: "測試聯絡人丁", rel: "家人", tel: "91000011" }, // 同電話唔同名＝衝突
        ],
      });
      const r = await applyPkg(owner, pkg3([p]));
      expect(outs(r.body.results[0].ext)).toEqual({ "emergency.1": "same", "emergency.2": "written", "emergency.3": "written", "emergency.4": "conflict" });
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: g0.id } })).toBe(3);
      const q = (await qs("ext_field_conflict"))[0]!;
      expect((q.evidenceJson as { ext_review: { key: string }[] }).ext_review.map((x) => x.key)).toEqual(["emergency.4"]);
      const { res } = await confirm(owner, q.id, { option: "apply_ext_fields", ext_fields: { "emergency.4": "use_import" } });
      expect(res.status).toBe(200);
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: g0.id } })).toBe(4);
    });

    it("冇「安員個人資料:view」：已有聯絡人就唔自動加（結果同 same 睇落一樣）", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, createdBy: "t" } });
      await prisma.guardEmergencyContact.create({ data: { guardId: g0.id, name: "測試聯絡人甲", tel: "91000011", sortOrder: 0 } });
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員個人資料", action: "view" } }, data: { granted: false } });
      const run = async (c: { name: string; tel: string }) => {
        const r = await applyPkg(accountant, pkg3([person({ contacts: [c] })]));
        return outs(r.body.results[0].ext);
      };
      expect(await run({ name: "測試聯絡人甲", tel: "91000011" })).toEqual({ "emergency.1": "not_written" });
      expect(await run({ name: "測試聯絡人戊", tel: "91000019" })).toEqual({ "emergency.1": "not_written" });
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: g0.id } })).toBe(1);
    });

    it("legacy 欄有值而子表 0 行：當已有聯絡人；加新聯絡人前 legacy 值自癒搬入子表（唔丟失）", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, emergencyContactName: "測試舊聯絡人", emergencyContactTel: "91000099", createdBy: "t" } });
      const r = await applyPkg(owner, pkg3([person({ contacts: [{ name: "測試聯絡人甲", tel: "91000011" }] })]));
      expect(outs(r.body.results[0].ext)["emergency.1"]).toBe("written");
      const cs = await prisma.guardEmergencyContact.findMany({ where: { guardId: g0.id }, orderBy: { sortOrder: "asc" } });
      expect(cs.map((c) => c.name)).toEqual(["測試舊聯絡人", "測試聯絡人甲"]);
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect(g.emergencyContactName).toBe("測試舊聯絡人");
    });

    it("ext_identity_check：疑似重複／身份唔一致嘅人新欄全 review → 出重要層題；確認後只補空欄", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, createdBy: "t" } });
      const p = person({ safety: { no: "ABC1234", expiry: "2027-06-07", st: "review" }, reasons: ["ext_identity_check"] });
      const r = await applyPkg(owner, pkg3([p]));
      expect(r.body.triage.important_open).toBe(1);
      expect(await prisma.triageQuestion.count({ where: { kind: "ext_field_review" } })).toBe(0);
      const q = (await qs("ext_identity_check"))[0]!;
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).safetyCardNo).toBeNull();
      const { res } = await confirm(owner, q.id, { option: "confirm_ext_identity" });
      expect(res.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).safetyCardNo).toBe("ABC1234");
    });

    it("只自動寫 name 或 tel 至少一個 confirmed 嘅聯絡人；未 confirmed 嘅欄留空；全 review 嘅聯絡人唔自動寫、出題", async () => {
      const p = person({ contacts: [{ name: "測試聯絡人甲", rel: "朋友", tel: "91000011" }, { name: "測試聯絡人乙", rel: "家人", tel: "91000012" }] });
      const raw = p as unknown as { emergencyContacts: { name: { status: string }; relationship: { status: string }; tel: { status: string } }[] };
      raw.emergencyContacts[0]!.relationship.status = "review"; // 關係未確認
      raw.emergencyContacts[1]!.name.status = "review";
      raw.emergencyContacts[1]!.tel.status = "review"; // 全 review
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, createdBy: "t" } });
      const r = await applyPkg(owner, pkg3([p]));
      expect(outs(r.body.results[0].ext)).toEqual({ "emergency.1": "written", "emergency.2": "not_confirmed" });
      const cs = await prisma.guardEmergencyContact.findMany({ where: { guardId: g0.id } });
      expect(cs.map((c) => [c.name, c.relationship, c.tel])).toEqual([["測試聯絡人甲", null, "91000011"]]);
    });

    it("許可證號碼：有序號同冇序號兩種格式都接受", () => {
      for (const no of ["K-200001-1-001", "K-200001-1"]) expect(importPackageSchema.safeParse(pkg3([person({ sia: { no, a: "2027-03-04", b: null } })])).success).toBe(true);
    });

    it("包內兩位聯絡人同名同電話只加一次", async () => {
      await applyPkg(owner, pkg3([person({ contacts: [{ name: "測試聯絡人甲", tel: "91000011" }, { name: "測試聯絡人甲", tel: "91000011" }] })]));
      expect(await prisma.guardEmergencyContact.count()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("銀行：權限、projection、分診", () => {
    it("包內有銀行欄：冇「安員銀行資料:update」（主管）preview／apply 403 並講明；冇銀行欄的包主管照常；唔寫任何嘢", async () => {
      const withBank = pkg3([person({ bank: {} })]);
      const a = await previewPkg(supervisor, withBank);
      expect(a.status).toBe(403);
      expect(JSON.stringify(a.body)).toContain("安員銀行資料");
      const b = await applyPkg(supervisor, withBank);
      expect(b.status).toBe(403);
      expect(await prisma.guard.count({ where: { hkid: H[0]! } })).toBe(0);
      const c = await previewPkg(supervisor, pkg3([person({ safety: { no: "ABC1234" } })]));
      expect(c.status).toBe(200);
      const d = await previewPkg(supervisor, pkg3([], [{ key: "pe:1", bankCode: "004", accountNo: ACCT, payeeName: PAYEE }]));
      expect(d.status).toBe(403);
      // 會計有 update → 通過
      expect((await previewPkg(accountant, withBank)).status).toBe(200);
    });

    it("銀行只補空欄；現有戶口唔同＝conflict、唔覆蓋、出 bank_review（重要層）；review 銀行亦出 bank_review", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, bankCode: "024", bankName: "恒生銀行", bankAccountNo: ACCT2, bankPayeeName: PAYEE, createdBy: "t" } });
      const r = await applyPkg(owner, pkg3([person({ bank: {} })]));
      expect(outs(r.body.results[0].ext).bank).toBe("conflict");
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect([g.bankCode, g.bankAccountNo]).toEqual(["024", ACCT2]);
      expect(r.body.triage.important_open).toBe(1);
      const q = (await qs("bank_review"))[0]!;
      expect(q).toBeTruthy();
      // 預覽：用導入值（replace）可確認，寫入後戶口變咗
      // M2：現有戶口唔同，「用導入值」冇明確揀「取代現有戶口」→ 預覽 can_confirm=false、強行確認 422
      const noRep = { option: "apply_ext_fields", ext_fields: { bank: "use_import" } };
      const pv0 = await (await qPreview(owner, q.id, noRep)).json();
      expect(pv0.impact.can_confirm).toBe(false);
      expect((await qAnswer(owner, q.id, noRep, pv0.preview_hash)).status).toBe(422);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } })).bankAccountNo).toBe(ACCT2);
      const ans = { option: "apply_ext_fields", ext_fields: { bank: "use_import" }, replace_existing: true };
      const { res } = await confirm(owner, q.id, ans);
      expect(res.status).toBe(200);
      const after = await prisma.guard.findUniqueOrThrow({ where: { id: g0.id } });
      expect([after.bankCode, after.bankName, after.bankAccountNo, after.bankPayeeName]).toEqual(["004", "匯豐銀行", ACCT, PAYEE]); // 四欄一齊
      // review 狀態、現有戶口空
      await prisma.triageQuestion.deleteMany({});
      await prisma.triageSession.deleteMany({});
      const g1 = await prisma.guard.create({ data: { nameZh: "測試員乙", employmentType: "cash_casual", hkid: H[1]!, createdBy: "t" } });
      const rr = await applyPkg(owner, pkg3([person({ hkid: H[1]!, bank: { st: "review", acct: "000011112222" }, reasons: ["bank_copy_disagrees"] })]));
      expect(outs(rr.body.results[0].ext).bank).toBe("not_confirmed");
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g1.id } })).bankAccountNo).toBeNull();
      const q2 = (await qs("bank_review"))[0]!;
      const { res: res2 } = await confirm(owner, q2.id, { option: "apply_ext_fields", ext_fields: { bank: "use_import" } });
      expect(res2.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g1.id } })).bankAccountNo).toBe("000011112222");
    });

    it("冇「安員銀行資料:view」（update 保留）：preview／apply 估啱 vs 估錯現有戶口，整個回應深比較相同；有 view 嘅會計睇到分別", async () => {
      const g0 = await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, dateOfBirth: new Date("1990-05-06T00:00:00.000Z"), bankCode: "004", bankName: "匯豐銀行", bankAccountNo: ACCT, bankPayeeName: PAYEE, createdBy: "t" } });
      void g0;
      const right = pkg3([person({ bank: { acct: ACCT } })]);
      const wrong = pkg3([person({ bank: { acct: ACCT2 } })]);
      const accRight = await previewPkg(accountant, right);
      const accWrong = await previewPkg(accountant, wrong);
      expect(checks(accRight.body.rows[0].ext).bank).toBe("same");
      expect(checks(accWrong.body.rows[0].ext).bank).toBe("differs");
      expect(accWrong.body.ext_stats.conflicts).toBe(1);
      expect(accRight.body.ext_stats.conflicts).toBe(0);
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
      const strip = (b: Record<string, unknown>) => {
        const c = JSON.parse(JSON.stringify(b)) as { package_hash?: string; rows: Record<string, unknown>[]; triage?: { session_id?: string } | null };
        delete c.package_hash; // 由輸入包決定
        if (c.triage) delete c.triage.session_id;
        return c;
      };
      const pr = strip((await previewPkg(accountant, right)).body);
      const pw = strip((await previewPkg(accountant, wrong)).body);
      expect(pw).toEqual(pr);
      expect(checks(pr.rows[0]!.ext as never)).toMatchObject({ bank: "hidden" });
      expect(pr.rows[0]!.bank_masked).toEqual({ present: true });
      expect(JSON.stringify(pr)).not.toContain(ACCT.slice(-4));
      // apply：估啱（same）vs 估錯（conflict）回應一樣；現有戶口冇被改
      const ar = strip((await applyPkg(accountant, right)).body);
      await prisma.triageQuestion.deleteMany({}); // M4 跨 session 去重：兩次估法係同一個人同一條題，清走先比較
      await prisma.triageSession.deleteMany({});
      const aw = strip((await applyPkg(accountant, wrong)).body);
      expect(aw).toEqual(ar);
      expect((ar as { counts_hidden?: boolean }).counts_hidden).toBeUndefined(); // 有 PII view → 只遮銀行
      expect((await guardOf(H[0]!)).bankAccountNo).toBe(ACCT);
      // 分診題數亦唔洩露（冇 view 嘅上載者：銀行題一律出，唔睇同現有戶口比較）
      expect(await prisma.triageQuestion.count({ where: { kind: "bank_review" } })).toBeGreaterThan(0);
    });

    it("冇銀行 view 嘅差分：現有戶口空 vs 有戶口，唔同包結果（fill 本身係補空）——但 same／differs 唔分", async () => {
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
      await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, bankCode: "004", bankAccountNo: ACCT, bankPayeeName: PAYEE, createdBy: "t" } });
      await prisma.guard.create({ data: { nameZh: "測試員乙", employmentType: "cash_casual", hkid: H[1]!, bankCode: "024", bankAccountNo: ACCT2, bankPayeeName: PAYEE, createdBy: "t" } });
      const one = pkg3([person({ hkid: H[0]!, bank: { acct: ACCT } })]); // same
      const two = pkg3([person({ hkid: H[0]!, bank: { acct: ACCT2 } })]); // differs
      const s = (b: Record<string, unknown>) => {
        const c = JSON.parse(JSON.stringify(b)) as { package_hash?: string };
        delete c.package_hash;
        return c;
      };
      expect(s((await previewPkg(accountant, one)).body)).toEqual(s((await previewPkg(accountant, two)).body));
    });

    it("bank_review 內容：冇「安員銀行資料:update」嘅擁有人見到題目數但內容寫「要有安員銀行資料權限嘅同事處理」，且唔可以預覽／作答", async () => {
      await prisma.guard.create({ data: { nameZh: "測試員甲", employmentType: "cash_casual", hkid: H[0]!, bankCode: "024", bankAccountNo: ACCT2, bankPayeeName: PAYEE, createdBy: "t" } });
      const r = await applyPkg(owner, pkg3([person({ bank: {} })]));
      const sid = r.body.triage.session_id as string;
      await post(reassignRoute as never, `/api/triage/sessions/${sid}/reassign`, owner, { owner_user_id: fx.userIds["主管"] }, sid);
      const list = await (await get(listRoute as never, "/api/triage/sessions?mine=1", supervisor)).json();
      expect(JSON.stringify(list)).toContain('"important_open":1');
      const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, supervisor, sid)).json();
      const q = sess.questions[0];
      expect(q.restricted).toBe(true);
      expect(q.title).toContain("要有安員銀行資料權限嘅同事處理");
      expect(q.options).toEqual([]);
      expect(JSON.stringify(sess)).not.toContain(ACCT);
      expect(JSON.stringify(sess)).not.toContain(PAYEE);
      expect((await qPreview(supervisor, q.id, { option: "skip" })).status).toBe(403);
      expect((await qAnswer(supervisor, q.id, { option: "skip" })).status).toBe(403);
      // 老闆（有權限）睇到內容：全號只喺有 view 先回
      const bossSess = await (await get(sessionRoute as never, `/api/triage/sessions/${sid}`, owner, sid)).json();
      expect(bossSess.questions[0].restricted).toBeUndefined();
      expect(bossSess.questions[0].evidence.person.ext.bank.account_masked).toMatch(/\*+5678$/);
    });

    it("bank_identity_unknown：候選＝英文名 token 完全相同；題目顯示尾 4 位；揀人先預覽＝實際寫入；跳過可再答；冪等", async () => {
      const cand = await prisma.guard.create({ data: { nameZh: "測試員候選", nameEn: "ONE TEST PAYEE", employmentType: "longterm_autopay", createdBy: "t" } });
      await prisma.guard.create({ data: { nameZh: "測試員另一個", nameEn: "PAYEE TEST TWO", employmentType: "cash_casual", createdBy: "t" } });
      await prisma.guard.create({ data: { nameZh: "測試員同名但唔同", nameEn: "PAYEE TEST", employmentType: "cash_casual", createdBy: "t" } });
      const other = await prisma.guard.create({ data: { nameZh: "測試員搜尋", employmentType: "cash_casual", createdBy: "t" } });
      const pkg = pkg3([], [{ key: "pe:004:5678", bankCode: "004", accountNo: ACCT, payeeName: "TEST ONE PAYEE" }]);
      const r = await applyPkg(owner, pkg);
      expect(r.status).toBe(200);
      expect(r.body.triage.important_open).toBe(1);
      const q = (await qs("bank_identity_unknown"))[0]!;
      const ev = q.evidenceJson as { candidate_guard_ids: string[]; unassigned: { accountNo: string } };
      expect(ev.candidate_guard_ids).toEqual([cand.id]);
      const sess = await (await get(sessionRoute as never, `/api/triage/sessions/${q.sessionId}`, owner, q.sessionId)).json();
      const view = sess.questions[0];
      expect(view.evidence.unassigned.account_masked).toMatch(/\*+5678$/);
      expect(view.evidence.unassigned.payee_name).toBe("TEST ONE PAYEE");
      expect(view.evidence.candidates).toHaveLength(1);
      expect(view.options.map((o: { id: string; guard_id?: string }) => o.id)).toEqual(["assign_bank", "assign_bank", "skip"]);
      // 重複上載唔重複出題
      const again = await applyPkg(owner, pkg);
      expect(again.body.triage.new_questions).toBe(0);
      // 預覽：唔寫；揀候選
      const ans = { option: "assign_bank", guard_id: cand.id };
      const pv = await (await qPreview(owner, q.id, ans)).json();
      expect(pv.impact.can_confirm).toBe(true);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: cand.id } })).bankAccountNo).toBeNull();
      const res = await qAnswer(owner, q.id, ans, pv.preview_hash);
      expect(res.status).toBe(200);
      const g = await prisma.guard.findUniqueOrThrow({ where: { id: cand.id } });
      expect([g.bankCode, g.bankAccountNo, g.bankPayeeName, g.bankName]).toEqual(["004", ACCT, "TEST ONE PAYEE", "匯豐銀行"]);
      // 已答：再上載唔再出（戶口已屬某安員）
      const third = await applyPkg(owner, pkg);
      expect(third.body.triage.new_questions).toBe(0);
      // 搜尋其他保安員：另一條（用新 key）
      const pkgB = pkg3([], [{ key: "pe:004:4321", bankCode: "024", accountNo: ACCT2, payeeName: "NO SUCH CANDIDATE" }]);
      await applyPkg(owner, pkgB);
      const q2 = (await qs("bank_identity_unknown")).find((x) => (x.evidenceJson as { unassigned: { accountNo: string } }).unassigned.accountNo === ACCT2)!;
      expect((q2.evidenceJson as { candidate_guard_ids: string[] }).candidate_guard_ids).toEqual([]);
      // M7：搜尋揀咗英文名唔夾／唔係長工 autopay 嘅人 → 預覽警告，冇 confirm_identity 唔可以確認（server 端亦驗）
      const warn = await (await qPreview(owner, q2.id, { option: "assign_bank", guard_id: other.id })).json();
      expect(warn.impact.can_confirm).toBe(false);
      expect(JSON.stringify(warn.impact.notes)).toContain("警告");
      expect((await qAnswer(owner, q2.id, { option: "assign_bank", guard_id: other.id }, warn.preview_hash)).status).toBe(422);
      const { res: res2 } = await confirm(owner, q2.id, { option: "assign_bank", guard_id: other.id, confirm_identity: true });
      expect(res2.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: other.id } })).bankAccountNo).toBe(ACCT2);
    });

    it("bank_identity_unknown：目標已有唔同戶口 → 唔准直接覆蓋（預覽 can_confirm=false、強行確認 422）；明確揀「取代現有戶口」先寫；跳過唔寫", async () => {
      const g = await prisma.guard.create({ data: { nameZh: "測試員候選", nameEn: "ONE TEST PAYEE", employmentType: "longterm_autopay", bankCode: "024", bankAccountNo: ACCT2, bankPayeeName: "TEST ONE PAYEE", createdBy: "t" } });
      await applyPkg(owner, pkg3([], [{ key: "pe:004:5678", bankCode: "004", accountNo: ACCT, payeeName: "TEST ONE PAYEE" }]));
      const q = (await qs("bank_identity_unknown"))[0]!;
      const ans = { option: "assign_bank", guard_id: g.id };
      const pv = await (await qPreview(owner, q.id, ans)).json();
      expect(pv.impact.can_confirm).toBe(false);
      expect(JSON.stringify(pv.impact.notes)).toContain("取代現有戶口");
      expect((await qAnswer(owner, q.id, ans, pv.preview_hash)).status).toBe(422);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).bankAccountNo).toBe(ACCT2);
      expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("open");
      const rep = { ...ans, replace_existing: true };
      const pv2 = await (await qPreview(owner, q.id, rep)).json();
      expect(pv2.impact.can_confirm).toBe(true);
      // 冇 update 權（會計撤銷銀行 update＋view）→ 答唔到
      await prisma.rolePermission.updateMany({ where: { role: { name: "會計" }, permission: { module: "安員銀行資料", action: { in: ["view", "update"] } } }, data: { granted: false } });
      const sessQ = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } });
      await prisma.triageSession.update({ where: { id: sessQ.sessionId }, data: { ownerUserId: fx.userIds["會計"] } });
      expect((await qPreview(accountant, q.id, rep)).status).toBe(403);
      const res = await qAnswer(owner, q.id, rep, pv2.preview_hash);
      expect(res.status).toBe(200);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).bankAccountNo).toBe(ACCT);
    });

    it("audit：guards／導入摘要／triage audit 全部冇銀行戶口、收款人、緊急聯絡人姓名電話；ai.audit_log 亦冇", async () => {
      const g = await prisma.guard.create({ data: { nameZh: "測試員候選", nameEn: "PAYEE ONE TEST", employmentType: "cash_casual", createdBy: "t" } });
      await applyPkg(owner, pkg3([person({ hkid: H[3]!, bank: {}, contacts: [{ name: "測試聯絡人甲", rel: "朋友", tel: "91000011" }], sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, safety: { no: "ABC1234", expiry: "2027-06-07" } })], [{ key: "pe:1", bankCode: "004", accountNo: ACCT2, payeeName: "TEST ONE PAYEE" }]));
      const q = (await qs("bank_identity_unknown"))[0]!;
      await confirm(owner, q.id, { option: "assign_bank", guard_id: g.id });
      const ai = await prisma.$queryRaw<{ before: unknown; after: unknown; table_name: string }[]>`SELECT before, after, table_name FROM ai.audit_log`;
      const txt = JSON.stringify(ai);
      for (const secret of [ACCT, ACCT2, PAYEE, "TEST ONE PAYEE", "測試聯絡人甲", "91000011", "K-200001-1-001", "ABC1234"]) expect(txt, `ai.audit_log 洩露 ${secret}`).not.toContain(secret);
      // 非 guards／聯絡人表嘅 audit（導入摘要、triage）本身就冇值
      const sums = await prisma.auditLog.findMany({ where: { tableName: { in: ["guard_import", "triage_questions", "triage_sessions"] } } });
      const sumTxt = JSON.stringify(sums);
      for (const secret of [ACCT, ACCT2, PAYEE, "TEST ONE PAYEE", "測試聯絡人甲", "91000011"]) expect(sumTxt, `summary audit 洩露 ${secret}`).not.toContain(secret);
      expect(sums.some((a) => a.action === "guard_import_apply" && JSON.stringify(a.after).includes("ext_written"))).toBe(true);
      // 聯絡人 audit 有寫（內部審計用），但 ai view 排除成個表
      const cRow = await prisma.guardEmergencyContact.findFirstOrThrow({ where: { name: "測試聯絡人甲" } });
      expect(await prisma.auditLog.count({ where: { tableName: "guard_emergency_contacts", rowId: cRow.id } })).toBe(1);
      expect(ai.some((a) => a.table_name === "guard_emergency_contacts")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("評估純函數", () => {
    it("evaluateExt／aggregateExt：新建＝new；同現值＝same／fill／differs；彙總只計 confirmed 的 fill/new 同 differs", () => {
      const p = person({ sia: { no: "K-200001-1-001", a: "2027-03-04", b: "2028-01-02" }, bank: {}, contacts: [{ name: "測試聯絡人甲", tel: "91000011" }] });
      const created = evaluateExt(p, null);
      expect(created.every((i) => i.check === "new")).toBe(true);
      const snap = {
        siaPermitNo: "K200001-1-001", siaPermitA: "2027-03-04", siaPermitB: null, safetyCardNo: null, safetyCardExpiry: null, qasIssue: null, qasExpiry: null, hire: null,
        bank: { code: "004", name: null, accountNo: ACCT2, payee: null },
        contacts: [{ name: "測試聯絡人甲", tel: "91000011" }],
        staffRows: [],
        longterm: false,
      };
      const items = Object.fromEntries(evaluateExt(p, snap).map((i) => [i.key, i.check]));
      expect(items).toMatchObject({ "siaPermit.no": "same", "siaPermit.aExpiry": "same", "siaPermit.bExpiry": "fill", bank: "differs", "emergency.1": "same" });
      const agg = aggregateExt([evaluateExt(p, snap)]);
      expect(agg.conflicts).toBe(1);
      expect(counts(agg.to_write)["siaPermit.bExpiry"]).toBe(1);
    });
  });
});
