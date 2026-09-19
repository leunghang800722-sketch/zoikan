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
// §8 M1：validTo 用 HK 曆日（邊界：UTC 16:30＝HK 翌日）
// §9 M2：雞頭 PATCH/POST 帶 staff_no*／PATCH .../staff-numbers/:numberId
//    撞號 → 403／409 一律冇 guard_id；內部角色 409 仍然有
// §10 S1：staff_no 只收 U、staff_no_mw 只收 MG/MW
// §11 S2：number 正規化（去晒空白）＋格式 regex
// §12 S3/S4：syncLegacyStaffNoColumns 唔抹走「新表冇對應」嘅 legacy 值
// §13 S5：sia_permit_expiry/type 讀取時現算（唔信 DB 陳舊值）
// §14 S6：雞頭讀 .../staff-numbers 窄版 DTO（冇 note/source/created_by）
// §15 S7：GET /api/guards?q= 搵到 former 號，標 former_number_hit
// §16 附帶：牌照/平安卡/入離職日期 nullable（PATCH null 清空）
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { TEST_USER_TEL } from "./fixtures/test-users";
import { GET as guardDetail, PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { GET as guardList, POST as guardCreate } from "@/app/api/guards/route";
import { GET as staffNumbersList, POST as staffNumberCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as staffNumberUpdate } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { deriveSiaPermitExpiry, upsertCurrentStaffNumber } from "@/lib/guards/staff-numbers";

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

describe("WP-STAFFNO §8（M1）：validTo 用 HK 曆日，唔會早一日", () => {
  let fx: Wp2Fixture;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("邊界：now=UTC 16:30（即 HK 已經踏入翌日 00:30）→ 轉 former 嘅 validTo 要係 HK 嗰個新曆日", async () => {
    await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardA.id, scheme: "U", number: "U91001", source: "test" }));
    const now = new Date("2026-09-19T16:30:00.000Z"); // HK = 2026-09-20 00:30
    const result = await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardA.id, scheme: "U", number: "U91002", source: "test", now }));
    const validToStr = result.convertedFormer!.after.validTo!.toISOString().slice(0, 10);
    // 舊版 bug：hkDayStartUtc("2026-09-20") = 2026-09-19T16:00:00Z，存落
    // @db.Date 會變 2026-09-19（早咗一日）。啱嘅答案要係 HK 今日本身。
    expect(validToStr).toBe("2026-09-20");
  });

  it("一般情況（now 喺 HK 曆日中段）→ validTo 都係 HK 今日", async () => {
    await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardA.id, scheme: "U", number: "U91003", source: "test" }));
    const now = new Date("2026-09-19T04:00:00.000Z"); // HK = 2026-09-19 12:00
    const result = await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardA.id, scheme: "U", number: "U91004", source: "test", now }));
    expect(result.convertedFormer!.after.validTo!.toISOString().slice(0, 10)).toBe("2026-09-19");
  });
});

describe("WP-STAFFNO §9（M2）：雞頭寫 staff_no*／409 guard_id 白名單", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("(a) 雞頭 PATCH /api/guards/:id 帶 staff_no → 403，回應冇任何 guard_id", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, brokerACookie, "PATCH", { staff_no: "U91100" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(403);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("guard_id");
  });

  it("(a) 雞頭 PATCH 帶 staff_no_mw → 403", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, brokerACookie, "PATCH", { staff_no_mw: "MG91101" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(403);
  });

  it("(a) 雞頭 POST /api/guards 帶 staff_no → 403", async () => {
    const res = await guardCreate(
      req("http://test.local/api/guards", brokerACookie, "POST", { staff_no: "U91102", name_zh: "測試", employment_type: "cash_casual" }),
    );
    expect(res.status).toBe(403);
  });

  it("(a) 雞頭 PATCH 帶普通欄（冇 staff_no）→ 唔會因為呢個修復被額外擋（開咗「自己安員:update」之後照樣 200）", async () => {
    // 「自己安員:update」出廠 off（雞頭預設淨係讀自己名冊，見矩陣）——
    // 要模擬老闆已經開咗呢個基本閘嘅狀態，先可以驗證 M2a 呢個修復（擋
    // `staff_no`／`staff_no_mw`）冇連累埋普通欄一齊被擋（同
    // wp-pii-field-groups.test.ts 會計銀行戶口嗰個 test 一致手法）。
    const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "自己安員", action: "update" } } });
    await prisma.rolePermission.update({
      where: { roleId_permissionId: { roleId: fx.roleIds["雞頭"], permissionId: permission.id } },
      data: { granted: true },
    });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, brokerACookie, "PATCH", { tel: "61112222" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
  });

  it("(b) 內部角色 PATCH .../staff-numbers/:numberId 撞號 → 409 仍然帶 guard_id", async () => {
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardB.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91103" }), {
      params: Promise.resolve({ id: fx.guardB.id }),
    });
    const created = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91104" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row = (await created.json()) as { id: string };
    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, ownerCookie, "PATCH", { number: "MP91103" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { guard_id?: string };
    expect(body.guard_id).toBe(fx.guardB.id);
  });
});

describe("WP-STAFFNO §10（S1）：legacy 欄 scheme 校驗", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("staff_no 帶 MP 開頭 → 400，提示用「員工編號」區", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no: "MP91200" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("員工編號");
  });

  it("staff_no_mw 帶 U 開頭 → 400", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no_mw: "U91201" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(400);
  });

  it("staff_no_mw 帶 MW 開頭 → 照樣 work（MG／MW 都收）", async () => {
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { staff_no_mw: "MW91202" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
  });

  it("「員工編號」區（POST .../staff-numbers）唔受呢個限制——MP 一樣 work", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91203" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
  });
});

describe("WP-STAFFNO §11（S2）：number 正規化＋格式 regex", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("中間夾空白（U 9130 0）正規化之後去晒空白，存落去嘅係冇空白版本", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U 913 00" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { number: string };
    expect(body.number).toBe("U91300");
  });

  it("含唔啱嘅符號（U91301@）→ 400", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U91301@" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("總長超過 20 位 → 400", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: `U${"9".repeat(20)}` }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("帶連字符（合法字符）→ 照樣 work", async () => {
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP-9130-2" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
  });
});

describe("WP-STAFFNO §12（S3/S4）：syncLegacyStaffNoColumns 唔抹走「新表冇對應」嘅 legacy 值", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("guard 嘅 staff_no=00500（migration 跳過、新表冇 U 行），加一個 MP 號之後 staff_no 仍然係 00500", async () => {
    // 模擬 migration 跳過咗嘅狀態：guards.staff_no 有值，但
    // guard_staff_numbers 完全冇呢個 guard 嘅任何 U 行。
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { staffNo: "00500" } });
    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91400" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBe("00500"); // 冇被靜靜哋抹走做 null
  });

  it("對照組：guard 有真正 U 行嘅情況，加返第二個 U 之後舊 staff_no 正常同步（唔係恆常唔改）", async () => {
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U91401" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    await staffNumberCreate(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U91402" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.staffNo).toBe("U91402"); // 同步到最新現用
  });
});

describe("WP-STAFFNO §13（S5）：sia_permit_expiry/type 讀取時現算", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("DB 舊衍生值陳舊（滿70歲之後冇再 PATCH 過）——GET 詳情照樣用返啱嘅現算值（乙類當失效）", async () => {
    await prisma.guard.update({
      where: { id: fx.guardA.id },
      data: {
        dateOfBirth: new Date("1950-01-01T00:00:00.000Z"), // 76 歲 @ 今日
        siaPermitAExpiry: null,
        siaPermitBExpiry: new Date("2030-01-01T00:00:00.000Z"),
        // 模擬 DB 陳舊值（未 recompute）：舊版仲話有 B。
        siaPermitType: "B",
        siaPermitExpiry: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const res = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    const body = (await res.json()) as { sia_permit_type: string | null; sia_permit_expiry: string | null };
    expect(body.sia_permit_type).toBeNull();
    expect(body.sia_permit_expiry).toBeNull();
  });

  it("列表 GET /api/guards 一樣讀取時現算（唔淨係詳情）", async () => {
    await prisma.guard.update({
      where: { id: fx.guardA.id },
      data: {
        dateOfBirth: new Date("1950-01-01T00:00:00.000Z"),
        siaPermitAExpiry: null,
        siaPermitBExpiry: new Date("2030-01-01T00:00:00.000Z"),
        siaPermitType: "B",
        siaPermitExpiry: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const res = await guardList(req("http://test.local/api/guards?take=500", ownerCookie));
    const body = (await res.json()) as { rows: Array<{ id: string; sia_permit_type: string | null }> };
    const row = body.rows.find((r) => r.id === fx.guardA.id);
    expect(row?.sia_permit_type).toBeNull();
  });
});

describe("WP-STAFFNO §14（S6）：雞頭讀 .../staff-numbers 窄版 DTO", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("雞頭見到 id/scheme/number/status/valid_from/valid_to，冇 note/source/created_by", async () => {
    await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91500", note: "內部備註唔應該漏俾雞頭" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, brokerACookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.number === "MP91500")!;
    expect(row).toBeDefined();
    expect("note" in row).toBe(false);
    expect("source" in row).toBe(false);
    expect("created_by" in row).toBe(false);
    expect("scheme" in row).toBe(true);
    expect("status" in row).toBe(true);
  });

  it("內部角色照樣見全欄（包括 note）", async () => {
    await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91501", note: "備註" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const res = await staffNumbersList(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.number === "MP91501")!;
    expect(row.note).toBe("備註");
  });
});

describe("WP-STAFFNO §15（S7）：GET /api/guards?q= 搵到 former 號", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("former 號（已經摺埋）一樣搵到，並標 former_number_hit", async () => {
    const created = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "MP", number: "MP91600" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row = (await created.json()) as { id: string };
    await staffNumberUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, ownerCookie, "PATCH", { status: "former" }), {
      params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }),
    });
    const res = await guardList(req("http://test.local/api/guards?q=MP91600", ownerCookie));
    const body = (await res.json()) as { rows: Array<{ id: string; former_number_hit?: boolean }> };
    expect(body.rows.map((r) => r.id)).toContain(fx.guardA.id);
    const hit = body.rows.find((r) => r.id === fx.guardA.id)!;
    expect(hit.former_number_hit).toBe(true);
  });

  it("q 搵唔到嘅字串——total=0，唔會報錯", async () => {
    const res = await guardList(req("http://test.local/api/guards?q=冇呢個人冇呢個號ZZZZ", ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it("q 搵姓名一樣得", async () => {
    const res = await guardList(req(`http://test.local/api/guards?q=${encodeURIComponent(fx.guardA.name)}`, ownerCookie));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toContain(fx.guardA.id);
  });
});

describe("WP-STAFFNO §16（附帶）：牌照/平安卡/入離職日期 nullable（PATCH null 清空）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("PATCH sia_permit_a_expiry=null 清空已填嘅日期（唔會變 1970-01-01）", async () => {
    await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { sia_permit_a_expiry: "2027-06-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { sia_permit_a_expiry: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.siaPermitAExpiry).toBeNull();
  });

  it("PATCH hire_date=null 清空", async () => {
    await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { hire_date: "2020-01-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { hire_date: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.hireDate).toBeNull();
  });

  // 應修 2（Opus 驗收第二輪）：`date_of_birth`／`blacklist_check_date`
  // 補埋 nullableDateOnly，跟上面幾個日期欄一致。
  it("PATCH date_of_birth=null 清空", async () => {
    await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { date_of_birth: "1990-01-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { date_of_birth: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.dateOfBirth).toBeNull();
  });

  it("PATCH blacklist_check_date=null 清空", async () => {
    await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { blacklist_check_date: "2024-01-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { blacklist_check_date: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.blacklistCheckDate).toBeNull();
  });

  // 應修 2：staff-numbers PATCH 嘅 valid_from／valid_to／note 一樣
  // nullable——former 行清 valid_to 一樣容許。
  it("PATCH .../staff-numbers/:numberId 用 null 清走 note／valid_from／valid_to", async () => {
    const created = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", {
        scheme: "MP",
        number: "MP91700",
        valid_from: "2026-01-01",
        note: "起草備註",
      }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    const row = (await created.json()) as { id: string };
    // 先轉做 former，並且填一個 valid_to（模擬「former 行清 valid_to」
    // 嗰個場景——呢個 route 冇「轉 former 自動帶 valid_to」嘅邏輯，人手
    // PATCH 填先有值）。
    await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, ownerCookie, "PATCH", { status: "former", valid_to: "2026-02-01" }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }) },
    );
    const afterFormer = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterFormer.validTo).not.toBeNull();

    const res = await staffNumberUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers/${row.id}`, ownerCookie, "PATCH", {
        valid_from: null,
        valid_to: null,
        note: null,
      }),
      { params: Promise.resolve({ id: fx.guardA.id, numberId: row.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.validFrom).toBeNull();
    expect(after.validTo).toBeNull(); // former 行清 valid_to 一樣容許
    expect(after.note).toBeNull();
  });
});

describe("WP-STAFFNO §17（必修1b/c）：a/b 都 null 嘅舊值 guard——讀取層／recompute script 安全閥", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  const legacyExpiry = new Date("2027-03-01T00:00:00.000Z");

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    // 模擬 migration backfill 唔到（或者人手都未補）嘅舊值狀態：
    // a／b 兩個新欄都係 null，但舊 `sia_permit_expiry`／`sia_permit_type`
    // 仲存住有效資料。
    await prisma.guard.update({
      where: { id: fx.guardA.id },
      data: { siaPermitAExpiry: null, siaPermitBExpiry: null, siaPermitExpiry: legacyExpiry, siaPermitType: "A" },
    });
  });

  it("GET 詳情——a/b 都 null 唔會用現算值（{null,null}）覆蓋舊 sia_permit_expiry/type", async () => {
    const res = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    const body = (await res.json()) as { sia_permit_expiry: string | null; sia_permit_type: string | null };
    expect(body.sia_permit_expiry).toBe(legacyExpiry.toISOString());
    expect(body.sia_permit_type).toBe("A");
  });

  it("GET 列表——一樣見到舊值（唔淨係詳情）", async () => {
    const res = await guardList(req("http://test.local/api/guards?take=500", ownerCookie));
    const body = (await res.json()) as { rows: Array<{ id: string; sia_permit_expiry: string | null; sia_permit_type: string | null }> };
    const row = body.rows.find((r) => r.id === fx.guardA.id);
    expect(row?.sia_permit_expiry).toBe(legacyExpiry.toISOString());
    expect(row?.sia_permit_type).toBe("A");
  });

  it("GET 列表 ?expiring_within_days= 一樣用返舊值做篩選（唔會因為現算 null 就漏篩）", async () => {
    const days = Math.ceil((legacyExpiry.getTime() - Date.now()) / 86_400_000) + 5;
    const res = await guardList(req(`http://test.local/api/guards?expiring_within_days=${days}`, ownerCookie));
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toContain(fx.guardA.id);
  });

  it("recompute script（recomputePermitDerived）跑完 DB 值不變——a/b 都 null 完全跳過，唔覆蓋、唔寫 audit", async () => {
    const { recomputePermitDerived } = await import("../scripts/db/recompute-permit-derived");
    const beforeCount = await prisma.auditLog.count({ where: { tableName: "guards", action: "recompute_permit_derived" } });
    const result = await recomputePermitDerived();
    expect(result.skippedBothNull).toBeGreaterThanOrEqual(1);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.siaPermitExpiry?.toISOString()).toBe(legacyExpiry.toISOString());
    expect(guard.siaPermitType).toBe("A");
    const afterCount = await prisma.auditLog.count({ where: { tableName: "guards", action: "recompute_permit_derived" } });
    expect(afterCount).toBe(beforeCount); // 完全冇寫任何 audit（冇更新任何嘢）
  });

  it("recompute script——對照組：a 有值但陳舊（乙類啱啱滿70歲、冇甲類）→ 允許轉做 null，並寫 audit_log", async () => {
    await prisma.guard.update({
      where: { id: fx.guardA.id },
      data: {
        dateOfBirth: new Date("1950-01-01T00:00:00.000Z"), // 76 歲
        siaPermitAExpiry: null,
        siaPermitBExpiry: new Date("2030-01-01T00:00:00.000Z"), // 有 b，冇 a——唔屬於「a/b 都 null」
        siaPermitExpiry: new Date("2030-01-01T00:00:00.000Z"), // 陳舊：仲話有效
        siaPermitType: "B",
      },
    });
    const { recomputePermitDerived } = await import("../scripts/db/recompute-permit-derived");
    const result = await recomputePermitDerived();
    expect(result.updated).toBeGreaterThanOrEqual(1);
    const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guard.siaPermitExpiry).toBeNull(); // 乙類滿70歲失效，合法轉做 null
    expect(guard.siaPermitType).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { tableName: "guards", rowId: fx.guardA.id, action: "recompute_permit_derived" } });
    expect(logs.length).toBe(1); // 呢種合法嘅 非null→null 轉變都要留底
  });
});

describe("WP-STAFFNO §18（應修1）：syncLegacyStaffNoColumns P2002 → 409（唔再 500）", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("guardB 嘅舊 staff_no 仲留住「guardA 而家想攞嘅」正規化值（模擬 migration_skipped_duplicate 遺留狀態）→ POST 新工號 409，唔係 500，rollback 乾淨", async () => {
    // 模擬 migration 跳過咗嘅遺留狀態：guardB.staff_no 已經係正規化形式
    // "U99999"，但呢個值完全冇入 guard_staff_numbers 新表（新表淨係 guardA
    // 之後先起）。
    await prisma.guard.update({ where: { id: fx.guardB.id }, data: { staffNo: "U99999" } });

    const res = await staffNumberCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/staff-numbers`, ownerCookie, "POST", { scheme: "U", number: "U99999" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(409); // 唔係 500
    const body = (await res.json()) as { message: string; guard_id?: string };
    expect(body.message).toContain("舊工號欄");
    expect(body.guard_id).toBe(fx.guardB.id); // 內部角色（老闆）見到邊個 guard 攞緊
    expect(body.message).not.toContain(fx.guardB.name); // 唔回姓名

    // Transaction 要 rollback 乾淨——唔可以留低半條新表行。
    const row = await prisma.guardStaffNumber.findFirst({ where: { number: "U99999" } });
    expect(row).toBeNull();
    const guardA = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guardA.staffNo).not.toBe("U99999"); // guardA 自己個 staff_no 都冇被寫入
  });
});
