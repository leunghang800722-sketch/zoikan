// WP-PII（老闆 2026-09-17 拍板）：保安員個人資料欄位＋權限。
//
// 1. 矩陣出廠值——「保安員個人資料」／「保安員銀行資料」兩個新 module 逐格
//    對照老闆決定原文（老闆/會計全睇、主管睇部分、雞頭/保安員硬性拒；
//    銀行資料主管都係硬性拒）。呢部分純粹讀 DEFAULT_MATRIX，唔使 DB。
// 2. field-group gate（GET /api/guards list/detail）逐角色。
// 3. PATCH 權限——身份證/銀行 field group 冇對應 update 權限 → 403，
//    DB 唔變；牌照（跟「保安員」module）唔受呢兩個新 field group 影響。
// 4. audit_log before/after 同讀出嗰陣一樣要經 field-group gate 遮。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";
import { DEFAULT_MATRIX } from "@/lib/rbac/matrix";

import { GET as guardsList } from "@/app/api/guards/route";
import { GET as guardDetail, PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { GET as auditLogGet } from "@/app/api/audit-log/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const PII_KEYS = ["hkid", "date_of_birth", "address", "emergency_contact_name", "emergency_contact_tel", "blacklist_check_result", "blacklist_check_date"];
const BANK_KEYS = ["bank_name", "bank_account_no", "bank_payee_name"];
const LICENCE_KEYS = ["sia_permit_no", "sia_permit_type", "sia_permit_a_expiry", "sia_permit_b_expiry", "safety_card_no", "safety_card_expiry", "hire_date", "leave_date"];

describe("WP-PII §1：矩陣出廠值——保安員個人資料／保安員銀行資料", () => {
  it("老闆：兩個 module view/update 都 grant", () => {
    expect(DEFAULT_MATRIX.老闆.安員個人資料.view).toBe("grant");
    expect(DEFAULT_MATRIX.老闆.安員個人資料.update).toBe("grant");
    expect(DEFAULT_MATRIX.老闆.安員銀行資料.view).toBe("grant");
    expect(DEFAULT_MATRIX.老闆.安員銀行資料.update).toBe("grant");
  });

  it("會計：兩個 module view/update 都 grant（老闆話「會計全睇」）", () => {
    expect(DEFAULT_MATRIX.會計.安員個人資料.view).toBe("grant");
    expect(DEFAULT_MATRIX.會計.安員個人資料.update).toBe("grant");
    expect(DEFAULT_MATRIX.會計.安員銀行資料.view).toBe("grant");
    expect(DEFAULT_MATRIX.會計.安員銀行資料.update).toBe("grant");
  });

  it("主管：保安員個人資料出廠關（老闆可以開）；保安員銀行資料硬性拒", () => {
    expect(DEFAULT_MATRIX.主管.安員個人資料.view).toBe("off");
    expect(DEFAULT_MATRIX.主管.安員個人資料.update).toBe("off");
    expect(DEFAULT_MATRIX.主管.安員銀行資料.view).toBe("deny");
    expect(DEFAULT_MATRIX.主管.安員銀行資料.update).toBe("deny");
  });

  it("雞頭／保安員：兩個 module 全部 action 硬性拒", () => {
    for (const role of ["雞頭", "安員"] as const) {
      for (const action of ["view", "create", "update", "void", "export"] as const) {
        expect(DEFAULT_MATRIX[role].安員個人資料[action]).toBe("deny");
        expect(DEFAULT_MATRIX[role].安員銀行資料[action]).toBe("deny");
      }
    }
  });
});

describe("WP-PII §2：field-group gate——GET /api/guards", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerACookie: string;
  let guardSelfCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardSelfCookie = await sessionCookieForUser(fx.userIds["安員"]);

    // 落一啲 PII/銀行測試值（老闆有齊晒權限，直接經 API 寫，順便驗證
    // 老闆寫得入）。
    const patchRes = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", {
        hkid: "A123456(3)",
        date_of_birth: "1990-01-01",
        address: "測試地址",
        emergency_contact_name: "測試聯絡人",
        emergency_contact_tel: "61000099",
        blacklist_check_result: "clear",
        blacklist_check_date: "2026-01-01",
        bank_name: "測試銀行",
        bank_account_no: "123-456789-001",
        bank_payee_name: "測試保安員甲",
        sia_permit_no: "SIA-TEST-01",
        // WP-STAFFNO：`sia_permit_type` 而家係衍生值（唔可以直接寫），
        // 用甲類到期日代替去 exercise 同一組「牌照跟保安員 module」欄。
        sia_permit_a_expiry: "2028-01-01",
        safety_card_no: "SAFE-TEST-01",
        safety_card_expiry: "2027-01-01",
        hire_date: "2020-01-01",
      }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(patchRes.status).toBe(200);
  });

  it("老闆：列表 hkid 遮罩（A123***(3)），牌照欄見到；銀行/地址/出生日期/緊急聯絡人/Blacklist 列表結構上唔回（應修 4，唔係俾 gate 剝——只詳情先有）", async () => {
    const listRes = await guardsList(req("http://test.local/api/guards", ownerCookie));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { rows: Array<Record<string, unknown>> };
    const row = body.rows.find((r) => r.id === fx.guardA.id)!;
    expect(row.hkid).toBe("A123***(3)");
    expect(row.sia_permit_no).toBe("SIA-TEST-01");
    for (const k of ["bank_name", "bank_account_no", "bank_payee_name", "address", "date_of_birth", "emergency_contact_name", "emergency_contact_tel", "blacklist_check_result", "blacklist_check_date"]) {
      expect(row).not.toHaveProperty(k);
    }
  });

  it("老闆：單項詳情 hkid 見全號（未遮罩），銀行/PII 全部欄都見到（詳情唔受列表最小化影響）", async () => {
    const detailRes = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(detailRes.status).toBe(200);
    const body = (await detailRes.json()) as Record<string, unknown>;
    expect(body.hkid).toBe("A1234563"); // WP-STAFF-IMPORT B1：入庫 canonical
    expect(body.bank_name).toBe("測試銀行");
    expect(body.address).toBe("測試地址");
  });

  it("會計：列表遮罩 hkid、銀行/地址等一樣列表唔回；詳情全見，同老闆一致", async () => {
    const listRes = await guardsList(req("http://test.local/api/guards", accountantCookie));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { rows: Array<Record<string, unknown>> };
    const row = body.rows.find((r) => r.id === fx.guardA.id)!;
    expect(row.hkid).toBe("A123***(3)");
    expect(row).not.toHaveProperty("bank_name");

    const detailRes = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, accountantCookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(detail.hkid).toBe("A1234563");
    expect(detail.bank_name).toBe("測試銀行");
  });

  it("主管（出廠）：見牌照（保安員 module），零命中身份證/銀行 PII 欄", async () => {
    const listRes = await guardsList(req("http://test.local/api/guards", supervisorCookie));
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(findKeysDeep(json, [...PII_KEYS, ...BANK_KEYS])).toEqual([]);

    const detailRes = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(findKeysDeep(detailJson, [...PII_KEYS, ...BANK_KEYS])).toEqual([]);
    expect((detailJson as Record<string, unknown>).sia_permit_no).toBe("SIA-TEST-01");
  });

  it("雞頭（自己保安員）：GUARD_BROKER_FIELDS 白名單——零命中全部 16 個新欄", async () => {
    const listRes = await guardsList(req("http://test.local/api/guards", brokerACookie));
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(findKeysDeep(json, [...PII_KEYS, ...BANK_KEYS, ...LICENCE_KEYS])).toEqual([]);
  });

  it("保安員角色：GET /api/guards 403（「保安員」module 對保安員角色硬性拒，同呢個 WP 無關但一致覆蓋）", async () => {
    const res = await guardsList(req("http://test.local/api/guards", guardSelfCookie));
    expect(res.status).toBe(403);
  });
});

describe("WP-PII §3：PATCH 權限", () => {
  let fx: Wp2Fixture;
  let supervisorCookie: string;
  let accountantCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
  });

  // WP-PII（Opus 驗收必修 2）：「主管/會計改保安員 403 回歸」——主管出廠
  // 「出街價:view」係 grant（見得到 monthly_salary）但「出街價:update」
  // 係 off（改唔到）。前端編輯抽屜帶返成個 form（包括冇改嘅
  // monthly_salary）一齊送，之前一見到 body 有 monthly_salary 呢粒
  // key 就當「想寫」，唔理值有冇變一律 403——連淨係想改姓名都被拒。
  it("主管改有月薪保安員嘅姓名（monthly_salary 值冇變一齊送）→ 200，月薪不變", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { monthlySalary: 8000 } });
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { name_zh: "改咗個名", monthly_salary: 8000 }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.nameZh).toBe("改咗個名");
    expect(after.monthlySalary?.toString()).toBe("8000");
  });

  it("主管真係改月薪（值唔同）→ 403，DB 不變（出街價:update 主管出廠 off）", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { monthlySalary: 8000 } });
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { monthly_salary: 9000 }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.monthlySalary?.toString()).toBe("8000");
  });

  it("主管 PATCH 身份證 → 403，DB 不變", async () => {
    const before = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { hkid: "A123456(3)" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(403);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.hkid).toBe(before.hkid);
  });

  it("Opus 覆核 M1（oracle）：主管冇「保安員個人資料:view」——PATCH hkid 就算同現值一樣都要 403，唔准變成猜中／猜錯嘅回應碼 oracle", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hkid: "A123456(3)", bankAccountNo: "123-456789-001" } });
    try {
      for (const guess of ["A123456(3)", "B999888(1)"]) {
        const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { hkid: guess }), {
          params: Promise.resolve({ id: fx.guardA.id }),
        });
        expect(res.status, `guess=${guess}`).toBe(403);
      }
      const resBank = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { bank_account_no: "123-456789-001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(resBank.status).toBe(403);
    } finally {
      await prisma.guard.update({ where: { id: fx.guardA.id }, data: { hkid: null, bankAccountNo: null } });
    }
  });

  async function setAccountantGuardUpdate(granted: boolean) {
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "安員", action: "update" } } });
    await prisma.rolePermission.update({ where: { roleId_permissionId: { roleId: fx.roleIds["會計"], permissionId: permission.id } }, data: { granted } });
  }

  it("Opus 覆核 S1：戶口號碼係字串，「000123456」同「123456」係兩個唔同戶口——會計（有權）改咗要真係寫入", async () => {
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { bankAccountNo: "123456" } });
    await setAccountantGuardUpdate(true);
    try {
      const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, accountantCookie, "PATCH", { bank_account_no: "000123456" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(200);
      const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(after.bankAccountNo).toBe("000123456");
    } finally {
      await setAccountantGuardUpdate(false);
      await prisma.guard.update({ where: { id: fx.guardA.id }, data: { bankAccountNo: null } });
    }
  });

  it("主管 PATCH 牌照號碼 → 200（跟「保安員」module，主管出廠有）", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { sia_permit_no: "SIA-999" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.siaPermitNo).toBe("SIA-999");
  });

  it("會計 PATCH 銀行戶口 → 200（老闆話「會計全睇」，保安員銀行資料:update=grant）", async () => {
    // 會計出廠「保安員」module 本身 update=off（會計預設淨係睇保安員名冊，
    // 唔開放改任何欄——呢個係 PATCH /api/guards route 嘅*基本*進入權，
    // 同「保安員銀行資料」field-group gate 係兩層唔同嘅閘，見 route.ts
    // `guardModule()` + `assertFieldGroupWritable()`）。老闆話「會計全
    // 睇」銀行資料，指嘅係銀行呢組欄嘅 field-level 權限（矩陣已經係
    // grant）；要實際改到（包括銀行戶口），仲要老闆喺角色權限頁開埋
    // 「保安員:update」呢個基本閘先——呢度模擬「老闆已經開咗」嗰個狀態，
    // 專登驗證開咗之後，銀行 field-group grant 真係生效（唔係測緊
    // 「會計出廠即刻改得到」）。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "安員", action: "update" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["會計"], permissionId: permission.id } },
      data: { granted: true },
    });
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, accountantCookie, "PATCH", { bank_name: "會計改嘅銀行" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.bankName).toBe("會計改嘅銀行");
  });

  it("會計出廠（未開「保安員:update」）：PATCH 銀行戶口 → 403（基本閘未開，field-group grant 都冇用）", async () => {
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, accountantCookie, "PATCH", { bank_name: "唔應該成功" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("主管 PATCH 銀行戶口 → 403，DB 不變（保安員銀行資料主管硬性拒）", async () => {
    const before = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, supervisorCookie, "PATCH", { bank_name: "主管想改" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
    const after = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(after.bankName).toBe(before.bankName);
  });

  it("hkid 格式唔啱（唔跟 A123456(3)）→ 400（B1：格式／check digit 改喺 route 層驗，先過權限）", async () => {
    const ownerC = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerC, "PATCH", { hkid: "唔啱格式" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
  });
});

describe("WP-PII §4：audit_log before/after 同讀出嗰陣一樣要經 field-group gate", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
  });

  it("老闆 PATCH 帶 hkid+bank_name（經 API 寫，audit_log 有完整 DTO）；主管讀 audit-log 零命中呢兩組欄", async () => {
    const patchRes = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { hkid: "A123456(3)", bank_name: "測試銀行" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(patchRes.status).toBe(200);

    // 主管出廠冇「操作紀錄:view」，手動開返嚟先入得 audit-log route——
    // 呢個 test 專登想證明「就算有咗操作紀錄:view，冇保安員個人資料/保安員
    // 銀行資料:view 都照樣剝」，同 wp2-m1-m5 嗰個 test 一致做法。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "操作紀錄", action: "view" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["主管"], permissionId: permission.id } },
      data: { granted: true },
    });
    const res = await auditLogGet(req("http://test.local/api/audit-log", supervisorCookie));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(findKeysDeep(json, [...PII_KEYS, ...BANK_KEYS])).toEqual([]);
  });
});
