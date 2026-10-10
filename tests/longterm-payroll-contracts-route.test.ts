// WP-LTPAY §21 任務 5d：`GET/POST/PATCH /api/longterm/contracts`
// integration test（人手合約管理——「Maxwell 導入」已經有獨立
// tests/longterm-payroll-import-route.test.ts，呢個檔案專門測人手 CRUD）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listContracts, POST as createContract } from "@/app/api/longterm/contracts/route";
import { GET as getContract, PATCH as patchContract } from "@/app/api/longterm/contracts/[id]/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("/api/longterm/contracts", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let guardId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    const guard = await prisma.guard.create({ data: { nameZh: "測試長工-contracts", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } });
    guardId = guard.id;
  });

  it("主管 403（module「長工糧」硬性拒）", async () => {
    const res = await listContracts(req("http://test.local/api/longterm/contracts", supervisorCookie));
    expect(res.status).toBe(403);
  });

  it("老闆新增合約成功，source 恆 manual（唔可以自稱 maxwell_import）", async () => {
    const res = await createContract(
      req("http://test.local/api/longterm/contracts", ownerCookie, "POST", {
        guard_id: guardId,
        effective_from: "2026-08-01",
        monthly_salary: 15500,
        annual_leave_days: 7,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toBe("manual");
    expect(body.guard_id).toBe(guardId);
  });

  it("GET 列表 join 埋保安員姓名／工號", async () => {
    await createContract(req("http://test.local/api/longterm/contracts", ownerCookie, "POST", { guard_id: guardId, effective_from: "2026-08-01", monthly_salary: 15500 }));
    const res = await listContracts(req("http://test.local/api/longterm/contracts", ownerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].guard_name).toBe("測試長工-contracts");
  });

  it("PATCH 編輯月薪／終止日；voided:true 作廢", async () => {
    const createRes = await createContract(
      req("http://test.local/api/longterm/contracts", ownerCookie, "POST", { guard_id: guardId, effective_from: "2026-08-01", monthly_salary: 15500 }),
    );
    const created = await createRes.json();

    const patchRes = await patchContract(req(`http://test.local/api/longterm/contracts/${created.id}`, ownerCookie, "PATCH", { monthly_salary: 16000 }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(patchRes.status).toBe(200);
    expect(Number((await patchRes.json()).monthly_salary)).toBe(16000);

    const voidRes = await patchContract(req(`http://test.local/api/longterm/contracts/${created.id}`, ownerCookie, "PATCH", { voided: true }), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(voidRes.status).toBe(200);
    const row = await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.voidedAt).not.toBeNull();
  });

  it("GET /:id 搵唔到 → 404", async () => {
    const res = await getContract(req("http://test.local/api/longterm/contracts/00000000-0000-0000-0000-000000000000", ownerCookie), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("生效區間覆蓋咗鎖定月份 → 403（Locked，同 rate_cards 一致 pattern）", async () => {
    const res = await createContract(
      req("http://test.local/api/longterm/contracts", ownerCookie, "POST", {
        guard_id: guardId,
        effective_from: "2026-06-01",
        effective_to: "2026-06-30",
        monthly_salary: 15500,
      }),
    );
    expect(res.status).toBe(403);
  });
});
