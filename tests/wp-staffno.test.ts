// WP-STAFFNO（老闆 2026-09-19 拍板）：員工編號獨立表（方案 B）＋保安牌照
// 甲／乙類到期日分開存。
//
// §1 partial unique（同 scheme 兩個 current 被擋）＋number 全表 unique
// §2 POST 自動將舊 current 轉 former（response 講明＋audit_log 兩條）
// §3 legacy 欄同步（syncLegacyStaffNoColumns）＋PATCH /api/guards/:id
//    舊寫法（staff_no／staff_no_mw）仍然 work，兩邊一致
// §4 雞頭：讀自己人 200、讀人哋 404、寫 403（硬性，唔靠矩陣個 cell）
// §5 PATCH .../staff-numbers/:numberId——改 status/note/number，partial
//    unique 檢查
// §6 直接寫 sia_permit_type／sia_permit_expiry → 400
// §7 deriveSiaPermitExpiry() 真值表（只A/只B/A+B/B過期/滿70歲/冇DOB）
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL } from "./fixtures/test-users";
import { GET as guardDetail, PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { POST as guardCreate } from "@/app/api/guards/route";
import { GET as staffNumbersList, POST as staffNumberCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as staffNumberUpdate } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { deriveSiaPermitExpiry } from "@/lib/guards/staff-numbers";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

async function brokerBCookie(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_USER_TEL["雞頭B"] } });
  return sessionCookieForUser(user.id);
}

describe("WP-STAFFNO §1：partial unique + number 全表 unique", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("同一個 guard 加兩個 U 號——第二個自動將第一個轉 former，唔會出現兩個 current（partial unique 保證）", async () => {
    const res1 = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90001" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res1.status).toBe(201);
    const res2 = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90002" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { converted_former?: { number: string } };
    expect(body2.converted_former?.number).toBe("U90001");

    const currentCount = await prisma.guardStaffNumber.count({ where: { guardId: fx.guardA.id, scheme: "U", status: "current" } });
    expect(currentCount).toBe(1);
    const row1 = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "U90001" } });
    expect(row1.status).toBe("former");
    expect(row1.validTo).not.toBeNull();
  });

  it("number 已經被另一個 guard 用緊 → 409，回應帶 guard_id（唔回姓名）", async () => {
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90010" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardB.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90010" }),
      { params: Promise.resolve({ id: fx.guardB.id }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string; guard_id?: string };
    expect(body.guard_id).toBe(fx.guardA.id);
    expect(body.message).not.toContain(fx.guardA.name); // 唔回姓名
  });

  it("number 唔以 scheme 開頭 → 400", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "U90099" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("scheme 格式唔啱（5 位英文字母）→ 400（zod regex 擋）", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "ABCDE", number: "ABCDE1" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("audit_log：POST 成功寫一條 create；有自動轉 former 多一條 update", async () => {
    // audit_log 係 append-only、成個 test file 唔會清（見 tests/lib/db.ts
    // clearAll() 頂註解），呢個 describe 之前嘅 test 已經寫低咗其他
    // guard_staff_numbers audit——淨係揀呢個 test 自己起嘅兩粒 rowId，
    // 唔查成個表先唔會被之前 test 嘅殘留污染斷言。
    const res1 = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90001" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row1 = (await res1.json()) as { id: string };
    const res2 = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90002" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row2 = (await res2.json()) as { id: string };
    const logs = await prisma.auditLog.findMany({
      where: { tableName: "guard_staff_numbers", rowId: { in: [row1.id, row2.id] } },
      orderBy: { createdAt: "asc" },
    });
    expect(logs.filter((l) => l.action === "create").length).toBe(2);
    expect(logs.filter((l) => l.action === "update" && l.rowId === row1.id).length).toBe(1);
  });
});

describe("WP-STAFFNO §2：legacy 欄同步 + PATCH /api/guards/:id 舊寫法", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("POST 加一個 U 號 → guards.staff_no 同步更新做嗰個號", async () => {
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90020" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBe("U90020");
  });

  it("將現用 U 轉 former（冇第二個 U）→ guards.staff_no 變 null", async () => {
    const created = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U90021" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row = (await created.json()) as { id: string };
    await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, ownerCookie, "PATCH", { status: "former" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }) },
    );
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBeNull();
  });

  it("PATCH /api/guards/:id 帶 staff_no（舊寫法）仍然 work，而且新表一致（起一行 current，legacy 欄同步）", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no: "U90030" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBe("U90030");
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: fx.guardA.id, scheme: "U", status: "current" } });
    expect(row?.number).toBe("U90030");
  });

  it("PATCH /api/guards/:id 帶 staff_no_mw（舊寫法）→ 新表 scheme=MG／MW 一致", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no_mw: "MG90040" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNoMw).toBe("MG90040");
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: fx.guardA.id, scheme: "MG", status: "current" } });
    expect(row?.number).toBe("MG90040");
  });

  it("同一次 PATCH 帶 staff_no + 其他普通欄（例如 tel）→ 兩者都生效，唔會撞", async () => {
    const res = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no: "U90050", tel: "61234567" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBe("U90050");
    expect(guard.tel).toBe("61234567");
  });

  it("POST /api/guards 建立新 guard 帶 staff_no → 新表都有對應 current 行（唔淨係 PATCH 先處理）", async () => {
    const res = await guardCreate(
      req("http://test.local/api/guards", ownerCookie, "POST", {
        staff_no: "U90060",
        name_zh: "測試新安員",
        employment_type: "cash_casual",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const row = await prisma.guardStaffNumber.findFirst({ where: { guardId: body.id, scheme: "U", status: "current" } });
    expect(row?.number).toBe("U90060");
  });
});

describe("WP-STAFFNO §3：GET/PATCH .../staff-numbers/:numberId", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let numberIdCurrent: string;
  let numberIdFormer: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const first = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90100" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const firstBody = (await first.json()) as { id: string };
    numberIdFormer = firstBody.id;
    const second = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90101" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const secondBody = (await second.json()) as { id: string };
    numberIdCurrent = secondBody.id; // MP90100 而家已經轉咗 former
  });

  it("GET：current 先、former 後", async () => {
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ status: string }>;
    expect(rows[0]!.status).toBe("current");
    expect(rows[1]!.status).toBe("former");
  });

  it("將 former 改返 current，同一個 scheme 已經有另一行 current → 409", async () => {
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${numberIdFormer}`, ownerCookie, "PATCH", { status: "current" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: numberIdFormer }) },
    );
    expect(res.status).toBe(409);
  });

  it("將 current 轉 former 之後，former 先可以改返 current", async () => {
    await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${numberIdCurrent}`, ownerCookie, "PATCH", { status: "former" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: numberIdCurrent }) },
    );
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${numberIdFormer}`, ownerCookie, "PATCH", { status: "current" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: numberIdFormer }) },
    );
    expect(res.status).toBe(200);
  });

  it("打錯用 PATCH 改 number——同樣行 unique 檢查", async () => {
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardB.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90199" }), {
      params: Promise.resolve({ id: fx.guardB.id }),
    });
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${numberIdCurrent}`, ownerCookie, "PATCH", { number: "MP90199" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: numberIdCurrent }) },
    );
    expect(res.status).toBe(409);
  });

  it("改 number 但新號冇跟返 scheme 開頭 → 400", async () => {
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${numberIdCurrent}`, ownerCookie, "PATCH", { number: "U90200" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: numberIdCurrent }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("WP-STAFFNO §4：雞頭隔離——讀自己人 200、讀人哋 404、寫 403", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("雞頭A 讀自己人（guardA，掛 brokerA）→ 200", async () => {
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, brokerACookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
  });

  it("雞頭A 讀人哋（guardB，掛 brokerB）→ 404（scopeGuardWhere 隔離，唔洩漏存在與否）", async () => {
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardB.id}/staff-numbers`, brokerACookie), {
      params: Promise.resolve({ id: fx.guardB.id }),
    });
    expect(res.status).toBe(404);
  });

  it("雞頭A 幫自己人加工號 → 403（硬性——唔可以寫，唔靠矩陣「自己安員:update」出廠 off 個 cell）", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, brokerACookie, "POST", { scheme: "U", number: "U90300" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("雞頭A 幫自己人改工號 → 403", async () => {
    const created = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP90301" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row = (await created.json()) as { id: string };
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, brokerACookie, "PATCH", { note: "打錯想改" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("雞頭B（第二個雞頭）讀 guardA（brokerA 嘅人）→ 404", async () => {
    const cookie = await brokerBCookie();
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, cookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("WP-STAFFNO §5：sia_permit_type／sia_permit_expiry 直接寫 → 400", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("PATCH 帶 sia_permit_expiry → 400，提示改用 a/b 欄", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { sia_permit_expiry: "2027-01-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("sia_permit_a_expiry");
  });

  it("PATCH 帶 sia_permit_type → 400", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { sia_permit_type: "A" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/guards 帶 sia_permit_expiry → 400", async () => {
    const res = await guardCreate(
      req("http://test.local/api/guards", ownerCookie, "POST", { name_zh: "測試", employment_type: "cash_casual", sia_permit_expiry: "2027-01-01" }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH 甲／乙到期日 → sia_permit_expiry／sia_permit_type 自動重算（GET 見到衍生值）", async () => {
    await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { sia_permit_a_expiry: "2027-06-01", sia_permit_b_expiry: "2027-01-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const res = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    const body = (await res.json()) as { sia_permit_expiry: string; sia_permit_type: string };
    expect(body.sia_permit_type).toBe("A+B");
    expect(body.sia_permit_expiry.slice(0, 10)).toBe("2027-01-01"); // 較早嗰個（乙類）
  });
});

describe("WP-STAFFNO §6：deriveSiaPermitExpiry() 真值表", () => {
  const A = new Date("2027-06-01T00:00:00.000Z");
  const B = new Date("2027-01-01T00:00:00.000Z");

  it("只 A", () => {
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: A, siaPermitBExpiry: null, dateOfBirth: null });
    expect(r.siaPermitType).toBe("A");
    expect(r.siaPermitExpiry).toEqual(A);
  });

  it("只 B", () => {
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: null, siaPermitBExpiry: B, dateOfBirth: null });
    expect(r.siaPermitType).toBe("B");
    expect(r.siaPermitExpiry).toEqual(B);
  });

  it("A+B——揀較早（B）", () => {
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: A, siaPermitBExpiry: B, dateOfBirth: null });
    expect(r.siaPermitType).toBe("A+B");
    expect(r.siaPermitExpiry).toEqual(B);
  });

  it("B 過期（日期已過，但唔涉及年齡）——仲係計入 type/expiry（過期警示係另一層 pill，唔喺呢個函數剝）", () => {
    const expiredB = new Date("2020-01-01T00:00:00.000Z");
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: A, siaPermitBExpiry: expiredB, dateOfBirth: null }, new Date("2026-09-19T00:00:00.000Z"));
    expect(r.siaPermitType).toBe("A+B");
    expect(r.siaPermitExpiry).toEqual(expiredB);
  });

  it("滿 70 歲——乙類當失效，唔計入 type/expiry，淨返甲類", () => {
    const dob = new Date("1950-01-01T00:00:00.000Z"); // 76 歲 @ 2026-09-19
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: A, siaPermitBExpiry: B, dateOfBirth: dob }, new Date("2026-09-19T00:00:00.000Z"));
    expect(r.siaPermitType).toBe("A");
    expect(r.siaPermitExpiry).toEqual(A);
  });

  it("滿 70 歲、冇甲類——type/expiry 全部 null", () => {
    const dob = new Date("1950-01-01T00:00:00.000Z");
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: null, siaPermitBExpiry: B, dateOfBirth: dob }, new Date("2026-09-19T00:00:00.000Z"));
    expect(r.siaPermitType).toBeNull();
    expect(r.siaPermitExpiry).toBeNull();
  });

  it("冇出生日期——乙類正常計，唔會因為「唔知」就當失效", () => {
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: null, siaPermitBExpiry: B, dateOfBirth: null }, new Date("2026-09-19T00:00:00.000Z"));
    expect(r.siaPermitType).toBe("B");
    expect(r.siaPermitExpiry).toEqual(B);
  });

  it("未滿 70 歲——乙類正常計", () => {
    const dob = new Date("2000-01-01T00:00:00.000Z"); // 26 歲 @ 2026-09-19
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: A, siaPermitBExpiry: B, dateOfBirth: dob }, new Date("2026-09-19T00:00:00.000Z"));
    expect(r.siaPermitType).toBe("A+B");
    expect(r.siaPermitExpiry).toEqual(B);
  });

  it("冇 A 冇 B——type/expiry 全部 null", () => {
    const r = deriveSiaPermitExpiry({ siaPermitAExpiry: null, siaPermitBExpiry: null, dateOfBirth: null });
    expect(r.siaPermitType).toBeNull();
    expect(r.siaPermitExpiry).toBeNull();
  });
});
