// Opus 對抗式驗收 S2/S3/S5/S6/S7（應修）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";

import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { POST as dailyReqCreate } from "@/app/api/daily-requirements/route";
import { PATCH as permissionsPatch } from "@/app/api/roles/[id]/permissions/route";
import { GET as assignmentsList, POST as assignmentCreate } from "@/app/api/broker-site-assignments/route";
import { DELETE as assignmentDelete } from "@/app/api/broker-site-assignments/[id]/route";
import { POST as userCreate } from "@/app/api/users/route";
import { PATCH as userUpdate } from "@/app/api/users/[id]/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 S2：shift_type.site_id 要同 site_id 一致", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("shift-records create：shift_type 屬於另一個盤 → 400", async () => {
    const otherSite = await prisma.site.create({ data: { canonicalName: "S2測試盤", clientName: "客", billingModel: "per_shift", createdBy: "test" } });
    const otherShiftType = await prisma.shiftType.create({ data: { siteId: otherSite.id, code: "N2", createdBy: "test" } });
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-10",
        site_id: fx.site.id, // 同 shift_type 唔同盤
        shift_type_id: otherShiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("daily-requirements create：shift_type 屬於另一個盤 → 400", async () => {
    const otherSite = await prisma.site.create({ data: { canonicalName: "S2測試盤2", clientName: "客", billingModel: "per_shift", createdBy: "test" } });
    const otherShiftType = await prisma.shiftType.create({ data: { siteId: otherSite.id, code: "N3", createdBy: "test" } });
    const res = await dailyReqCreate(
      req("http://test.local/api/daily-requirements", ownerCookie, "POST", {
        site_id: fx.site.id,
        shift_type_id: otherShiftType.id,
        work_date: "2026-08-10",
        headcount_required: 2,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("WP2 S3：parent_shift_id 驗證", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;
  let brokerBUserId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const brokerBUser = await prisma.user.findFirstOrThrow({ where: { brokerId: fx.brokerB.id } });
    brokerBUserId = brokerBUser.id;
  });

  it("parent_shift_id 要同一個 guard/site/settlement broker，唔啱 → 400", async () => {
    // shiftRecordB 嘅 guard/settlement 同 guardA 唔同
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-13",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "ot",
        ot_hours: 2,
        parent_shift_id: fx.shiftRecordB.id, // guardB 嘅更次，同 guardA 唔啱
      }),
    );
    expect(res.status).toBe(400);
  });

  it("雞頭引用另一個雞頭嘅 parent_shift_id（存在但唔屬於自己）→ 404，唔係 403（唔好漏對方存在）", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-14",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "ot",
        ot_hours: 1,
        parent_shift_id: fx.shiftRecordB.id, // 屬於 brokerB
      }),
    );
    expect(res.status).toBe(404);
    void brokerBUserId;
  });

  it("雞頭引用自己嘅更次做 parent（同 guard/site）→ 成功", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-15",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "ot",
        ot_hours: 1,
        parent_shift_id: fx.shiftRecordA.id, // 屬於 brokerA，同一個 guard/site
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("WP2 S5：roles/permissions PATCH 先驗 permission 存在", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("「報表:view」（C3 已拆走嘅舊 module）→ 400，唔係 500", async () => {
    const res = await permissionsPatch(
      req(`http://test.local/api/roles/${fx.roleIds["雞頭"]}/permissions`, ownerCookie, "PATCH", {
        changes: [{ module: "報表", action: "view", granted: true }],
      }),
      { params: Promise.resolve({ id: fx.roleIds["雞頭"] }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("WP2 S6：broker_site_assignments 管理 API", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭 GET 淨係見自己嘅 assignment", async () => {
    const res = await assignmentsList(req("http://test.local/api/broker-site-assignments", brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ broker_id: string }> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) expect(row.broker_id).toBe(fx.brokerA.id);
  });

  it("雞頭 POST 開自己嘅 assignment → 403（配額:create 硬性 deny）", async () => {
    const res = await assignmentCreate(
      req("http://test.local/api/broker-site-assignments", brokerACookie, "POST", {
        broker_id: fx.brokerA.id,
        site_id: fx.siteUnassigned.id,
        month: "2026-08-01",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("老闆 POST 幫雞頭A 開 siteUnassigned 嘅 8 月配額，之後開更成功；DELETE 之後又拒返", async () => {
    const createRes = await assignmentCreate(
      req("http://test.local/api/broker-site-assignments", ownerCookie, "POST", {
        broker_id: fx.brokerA.id,
        site_id: fx.siteUnassigned.id,
        month: "2026-08-01",
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const shiftTypeForUnassigned = await prisma.shiftType.create({ data: { siteId: fx.siteUnassigned.id, code: "N-UA", createdBy: "test" } });
    const shiftRes = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-16",
        site_id: fx.siteUnassigned.id,
        shift_type_id: shiftTypeForUnassigned.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(shiftRes.status).toBe(201);

    const deleteRes = await assignmentDelete(req(`http://test.local/api/broker-site-assignments/${created.id}`, ownerCookie, "DELETE"), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(deleteRes.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "broker_site_assignments", rowId: created.id, action: "void" } });
    expect(audit).toBeTruthy();

    const shiftRes2 = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-17",
        site_id: fx.siteUnassigned.id,
        shift_type_id: shiftTypeForUnassigned.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(shiftRes2.status).toBe(403);
  });
});

describe("WP2 S7：users broker_id 一定要指向 kind='broker'", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("create user 掛 internal_cash 嘅 broker_id → 400", async () => {
    const res = await userCreate(
      req("http://test.local/api/users", ownerCookie, "POST", {
        name: "測試S7",
        tel: "97000001",
        password: "Passw0rdX",
        role_id: fx.roleIds["雞頭"],
        broker_id: fx.brokerInternal.id, // kind=internal_cash
      }),
    );
    expect(res.status).toBe(400);
  });

  it("create user 掛 kind='broker' 嘅 broker_id → 成功", async () => {
    const res = await userCreate(
      req("http://test.local/api/users", ownerCookie, "POST", {
        name: "測試S7b",
        tel: "97000002",
        password: "Passw0rdX",
        role_id: fx.roleIds["雞頭"],
        broker_id: fx.brokerB.id,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("update user 改去 internal_cash 嘅 broker_id → 400", async () => {
    const res = await userUpdate(req(`http://test.local/api/users/${fx.userIds["雞頭"]}`, ownerCookie, "PATCH", { broker_id: fx.brokerInternal.id }), {
      params: Promise.resolve({ id: fx.userIds["雞頭"] }),
    });
    expect(res.status).toBe(400);
  });
});
