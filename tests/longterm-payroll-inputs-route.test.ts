// WP-LTPAY §21 任務 5d：`GET/POST/PATCH/DELETE /api/longterm/inputs`
// integration test——RBAC（module「長工糧」同「安員銀行資料」一致粒度）＋
// 月鎖後唯讀＋作廢（軟刪）行為。合成安員／合約（PDPO：冇真名/真工號）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listInputs, POST as createInput } from "@/app/api/longterm/inputs/route";
import { PATCH as patchInput, DELETE as deleteInput } from "@/app/api/longterm/inputs/[id]/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("/api/longterm/inputs", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let accountantCookie: string;
  let supervisorCookie: string;
  let brokerCookie: string;
  let guardSelfCookie: string;
  let guardId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardSelfCookie = await sessionCookieForUser(fx.userIds["安員"]);

    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-inputs", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    guardId = guard.id;
    await prisma.guardLongtermContract.create({
      data: { guardId, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: fx.userIds["老闆"] },
    });
  });

  it("主管／雞頭／安員 GET/POST 一律 403（同安員銀行資料一致粒度）", async () => {
    for (const cookie of [supervisorCookie, brokerCookie, guardSelfCookie]) {
      const getRes = await listInputs(req("http://test.local/api/longterm/inputs", cookie));
      expect(getRes.status).toBe(403);
      const postRes = await createInput(
        req("http://test.local/api/longterm/inputs", cookie, "POST", { month: "2026-08-01", guard_id: guardId, kind: "special_allowance", amount: 500 }),
      );
      expect(postRes.status).toBe(403);
    }
  });

  it("老闆新增津貼項成功，GET 列出（join 埋安員姓名）", async () => {
    const createRes = await createInput(
      req("http://test.local/api/longterm/inputs", ownerCookie, "POST", { month: "2026-08-01", guard_id: guardId, kind: "special_allowance", amount: 500, note: "測試勤工獎" }),
    );
    expect(createRes.status).toBe(201);

    const listRes = await listInputs(req("http://test.local/api/longterm/inputs?month=2026-08", ownerCookie));
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].guard_name).toBe("測試長工-inputs");
    expect(Number(body.rows[0].amount)).toBe(500);
  });

  it("會計都可以新增（任務書：老闆／會計一致粒度）", async () => {
    const res = await createInput(
      req("http://test.local/api/longterm/inputs", accountantCookie, "POST", { month: "2026-08-01", guard_id: guardId, kind: "deduction", amount: 100 }),
    );
    expect(res.status).toBe(201);
  });

  it("kind=leave 冇 date_from → 400", async () => {
    const res = await createInput(req("http://test.local/api/longterm/inputs", ownerCookie, "POST", { month: "2026-08-01", guard_id: guardId, kind: "leave" }));
    expect(res.status).toBe(400);
  });

  it("PATCH 編輯／DELETE 作廢（軟刪，唔係真刪）", async () => {
    const createRes = await createInput(
      req("http://test.local/api/longterm/inputs", ownerCookie, "POST", { month: "2026-08-01", guard_id: guardId, kind: "uniform", amount: 200 }),
    );
    const created = await createRes.json();

    const patchRes = await patchInput(req(`http://test.local/api/longterm/inputs/${created.id}`, ownerCookie, "PATCH", { amount: 250 }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(patchRes.status).toBe(200);
    expect(Number((await patchRes.json()).amount)).toBe(250);

    const deleteRes = await deleteInput(req(`http://test.local/api/longterm/inputs/${created.id}`, ownerCookie, "DELETE"), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(deleteRes.status).toBe(200);

    const row = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.voidedAt).not.toBeNull(); // 軟刪，行仲喺度

    // 已作廢再 PATCH → 409
    const patchAfterVoid = await patchInput(req(`http://test.local/api/longterm/inputs/${created.id}`, ownerCookie, "PATCH", { amount: 999 }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(patchAfterVoid.status).toBe(409);
  });

  it("月鎖後——POST/PATCH/DELETE 一律 403（Locked），GET 讀取唔受影響", async () => {
    const createRes = await createInput(
      req("http://test.local/api/longterm/inputs", ownerCookie, "POST", { month: fx.unlockedMonth.toISOString(), guard_id: guardId, kind: "uniform", amount: 200 }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    // 手動搬去鎖定咗嘅月份，模擬「呢個月已經鎖咗先嚟改」嘅情境
    await prisma.longtermPayrollInput.update({ where: { id: created.id }, data: { month: fx.lockedMonth } });

    const lockedPost = await createInput(
      req("http://test.local/api/longterm/inputs", ownerCookie, "POST", { month: fx.lockedMonth.toISOString(), guard_id: guardId, kind: "uniform", amount: 1 }),
    );
    expect(lockedPost.status).toBe(403);

    const lockedPatch = await patchInput(req(`http://test.local/api/longterm/inputs/${created.id}`, ownerCookie, "PATCH", { amount: 1 }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(lockedPatch.status).toBe(403);

    const lockedDelete = await deleteInput(req(`http://test.local/api/longterm/inputs/${created.id}`, ownerCookie, "DELETE"), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(lockedDelete.status).toBe(403);

    const getRes = await listInputs(req("http://test.local/api/longterm/inputs?month=2026-06", ownerCookie));
    expect(getRes.status).toBe(200);
  });
});
