// P1-WP3：quotas CRUD／雞頭隔離／月鎖；審批狀態機（approve/reject）；
// 更表批量儲存（batch，含 rollback）；months/open（複製上月結構）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as quotasList, POST as quotasCreate } from "@/app/api/quotas/route";
import { GET as quotaGet, PATCH as quotaPatch } from "@/app/api/quotas/[id]/route";
import { POST as quotaVoid } from "@/app/api/quotas/[id]/void/route";
import { GET as shiftRecordsList, POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { POST as approve } from "@/app/api/shift-records/[id]/approve/route";
import { POST as reject } from "@/app/api/shift-records/[id]/reject/route";
import { POST as batchWrite } from "@/app/api/shift-records/batch/route";
import { POST as monthOpen } from "@/app/api/months/[month]/open/route";
import { GET as shiftTypesList } from "@/app/api/shift-types/route";
import { GET as sitesList } from "@/app/api/sites/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const MONTH = "2026-08"; // fx.unlockedMonth

describe("P1-WP3：quotas", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("主管派配額 → 201；雞頭自己 create → 403（硬性）", async () => {
    const res = await quotasCreate(
      req("http://test.local/api/quotas", supervisorCookie, "POST", {
        month: MONTH,
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        broker_id: fx.brokerA.id,
        target_shifts: 10,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.target_shifts).toBe(10);
    expect(body.broker_id).toBe(fx.brokerA.id);

    const brokerTry = await quotasCreate(
      req("http://test.local/api/quotas", brokerACookie, "POST", { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerA.id, target_shifts: 5 }),
    );
    expect(brokerTry.status).toBe(403);
  });

  it("重複 (month,site,shift_type,broker) → 409", async () => {
    const data = { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerA.id, target_shifts: 10 };
    const first = await quotasCreate(req("http://test.local/api/quotas", supervisorCookie, "POST", data));
    expect(first.status).toBe(201);
    const dup = await quotasCreate(req("http://test.local/api/quotas", supervisorCookie, "POST", data));
    expect(dup.status).toBe(409);
  });

  it("shift_type_id 唔屬於 site_id → 400", async () => {
    const otherSite = await prisma.site.create({ data: { canonicalName: "測試盤WP3-other", clientName: "x", billingModel: "per_shift", createdBy: "test" } });
    const res = await quotasCreate(
      req("http://test.local/api/quotas", supervisorCookie, "POST", { month: MONTH, site_id: otherSite.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerA.id, target_shifts: 1 }),
    );
    expect(res.status).toBe(400);
  });

  it("雞頭 GET 只見自己嘅配額", async () => {
    await quotasCreate(req("http://test.local/api/quotas", supervisorCookie, "POST", { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerA.id, target_shifts: 8 }));
    await quotasCreate(req("http://test.local/api/quotas", supervisorCookie, "POST", { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerB.id, target_shifts: 12 }));

    const asA = await quotasList(req("http://test.local/api/quotas", brokerACookie, "GET"));
    const bodyA = await asA.json();
    expect(bodyA.rows.length).toBe(1);
    expect(bodyA.rows[0].broker_id).toBe(fx.brokerA.id);

    const asOwner = await quotasList(req("http://test.local/api/quotas", ownerCookie, "GET"));
    const bodyOwner = await asOwner.json();
    expect(bodyOwner.rows.length).toBe(2);
  });

  it("雞頭 GET 單一一條唔屬於自己嘅配額 → 404（scope）", async () => {
    const created = await quotasCreate(
      req("http://test.local/api/quotas", supervisorCookie, "POST", { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerB.id, target_shifts: 8 }),
    );
    const { id } = await created.json();
    const res = await quotaGet(req(`http://test.local/api/quotas/${id}`, brokerACookie, "GET"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it("PATCH target_shifts；void 附原因", async () => {
    const created = await quotasCreate(
      req("http://test.local/api/quotas", supervisorCookie, "POST", { month: MONTH, site_id: fx.site.id, shift_type_id: fx.shiftType.id, broker_id: fx.brokerA.id, target_shifts: 8 }),
    );
    const { id } = await created.json();
    const patched = await quotaPatch(req(`http://test.local/api/quotas/${id}`, supervisorCookie, "PATCH", { target_shifts: 20 }), { params: Promise.resolve({ id }) });
    expect(patched.status).toBe(200);
    expect((await patched.json()).target_shifts).toBe(20);

    const voided = await quotaVoid(req(`http://test.local/api/quotas/${id}/void`, ownerCookie, "POST", { reason: "測試作廢" }), { params: Promise.resolve({ id }) });
    expect(voided.status).toBe(200);
    expect((await voided.json()).voided_at).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({ where: { tableName: "quotas", rowId: id, action: "void" }, orderBy: { createdAt: "desc" } });
    expect((auditRow!.after as Record<string, unknown>).void_reason).toBe("測試作廢");
  });

  it("鎖定月份寫配額 → 403 Locked", async () => {
    const res = await quotasCreate(
      req("http://test.local/api/quotas", supervisorCookie, "POST", {
        month: "2026-06",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        broker_id: fx.brokerA.id,
        target_shifts: 1,
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("month_locked");
  });
});

describe("P1-WP3：審批（approve/reject）", () => {
  let fx: Wp2Fixture;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    await prisma.broker.update({ where: { id: fx.brokerA.id }, data: { requiresApproval: true } });
  });

  async function createPendingViaBroker(day: string) {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: day,
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending_approval");
    return body.id as string;
  }

  it("requires_approval=true 嘅雞頭開更 → pending_approval；GET ?status=pending_approval 見到", async () => {
    const id = await createPendingViaBroker("2026-08-15");
    const list = await shiftRecordsList(req("http://test.local/api/shift-records?status=pending_approval", supervisorCookie, "GET"));
    const body = await list.json();
    expect(body.rows.some((r: { id: string }) => r.id === id)).toBe(true);
  });

  it("主管批 pending_approval → confirmed；再批一次 → 409", async () => {
    const id = await createPendingViaBroker("2026-08-16");
    const res = await approve(req(`http://test.local/api/shift-records/${id}/approve`, supervisorCookie, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("confirmed");

    const again = await approve(req(`http://test.local/api/shift-records/${id}/approve`, supervisorCookie, "POST"), { params: Promise.resolve({ id }) });
    expect(again.status).toBe(409);
  });

  it("主管退回（附原因）→ draft；audit 記低 reject_reason", async () => {
    const id = await createPendingViaBroker("2026-08-17");
    const res = await reject(req(`http://test.local/api/shift-records/${id}/reject`, supervisorCookie, "POST", { reason: "更別填錯" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("draft");

    const auditRow = await prisma.auditLog.findFirst({ where: { tableName: "shift_records", rowId: id, action: "update" }, orderBy: { createdAt: "desc" } });
    expect((auditRow!.after as Record<string, unknown>).reject_reason).toBe("更別填錯");
  });

  it("退回冇填 reason → 400", async () => {
    const id = await createPendingViaBroker("2026-08-18");
    const res = await reject(req(`http://test.local/api/shift-records/${id}/reject`, supervisorCookie, "POST", {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("雞頭自己批/退回 → 403（審批硬性 deny）", async () => {
    const id = await createPendingViaBroker("2026-08-19");
    const res = await approve(req(`http://test.local/api/shift-records/${id}/approve`, brokerACookie, "POST"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(403);
  });
});

describe("P1-WP3：更表批量儲存（batch）", () => {
  let fx: Wp2Fixture;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭（requires_approval=false）填自己一格 → confirmed", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].action).toBe("created");
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: body.results[0].id } });
    expect(created.status).toBe("confirmed");
    expect(created.recordType).toBe("shift");
  });

  it("雞頭填請假代號 AL → leave 記錄", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-06", code: "AL" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: body.results[0].id } });
    expect(created.recordType).toBe("leave");
    expect(created.leaveCode).toBe("AL");
  });

  it("雞頭改自己已 confirmed 嘅格 → 重入 pending_approval（設計文件§4.2）", async () => {
    // fx.shiftRecordA 已經係 confirmed（work_date 2026-08-01, guardA, brokerA）
    const before = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(before.status).toBe("confirmed");
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: "AL" }],
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.status).toBe("pending_approval");
    expect(after.leaveCode).toBe("AL");
  });

  it("清一格未確認嘅（draft/pending）自己記錄 → cancelled", async () => {
    await prisma.broker.update({ where: { id: fx.brokerA.id }, data: { requiresApproval: true } });
    const create = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-07", code: "N" }],
      }),
    );
    const createdId = (await create.json()).results[0].id;
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: createdId } })).status).toBe("pending_approval");

    const clear = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-07", code: null }],
      }),
    );
    expect(clear.status).toBe(200);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: createdId } })).status).toBe("cancelled");
  });

  it("雞頭清一格已 confirmed 嘅格 → 403（要主管用 void）", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: null }],
      }),
    );
    expect(res.status).toBe(403);
  });

  it("code 同呢行更別／請假代號都對唔上 → 400，rollback（成批冇寫入）", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-08", code: "N" }, // 呢格自己啱
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-09", code: "ZZZ" }, // 呢格唔啱
        ],
      }),
    );
    expect(res.status).toBe(400);
    const count = await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 7, 8)) } });
    expect(count).toBe(0); // 第一格都冇寫入——成批 rollback
  });

  it("雞頭幫外人（guardB）開格 → 403 rollback", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-10", code: "N" },
          { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-10", code: "N" },
        ],
      }),
    );
    expect(res.status).toBe(403);
    const count = await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 7, 10)) } });
    expect(count).toBe(0);
  });

  it("同一批入面兩個一模一樣嘅 cell（同一 guard+day+更別）撞 DB unique → 409 rollback", async () => {
    // 兩個 cell 喺 validate 階段都見唔到對方（DB 未寫），plan 都變成
    // upsert-create；transaction 入面第二個 create 先撞 P2002——成個
    // transaction rollback，兩個都冇落到 DB。
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-21", code: "N" },
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-21", code: "N" },
        ],
      }),
    );
    expect(res.status).toBe(409);
    const count = await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 7, 21)) } });
    expect(count).toBe(0);

    // audit_log 唔准留低「孤兒」記錄——rollback 咗嘅嘢唔應該喺 audit_log
    // 留低任何痕跡（writeAudit 一定要等 transaction 真係 commit 咗先叫，
    // 唔可以喺 $transaction callback 入面直接叫，否則佢用緊嘅係外層
    // `prisma`唔係`tx`，rollback 唔到）。
    const createAudits = await prisma.auditLog.findMany({ where: { tableName: "shift_records", action: "create" } });
    const orphanAudit = createAudits.find((a) => String((a.after as Record<string, unknown> | null)?.work_date ?? "").startsWith("2026-08-21"));
    expect(orphanAudit).toBeUndefined();
  });

  it("鎖定月份寫 batch → 403 Locked，rollback", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", supervisorCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-06",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-06-05", code: "N" }],
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("month_locked");
  });

  it("主管（內部角色）填人 → confirmed，settlement broker default 用 guard.default_broker_id", async () => {
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", supervisorCookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-12", code: "N" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: body.results[0].id } });
    expect(created.status).toBe("confirmed");
    expect(created.settlementBrokerId).toBe(fx.brokerA.id);
  });

  it("超配額會出黃警示（warnings，唔擋寫入）", async () => {
    await prisma.quota.create({
      data: { month: new Date(Date.UTC(2026, 7, 1)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, targetShifts: 1, createdBy: "test" },
    });
    // shiftRecordA 本身已經計 1 條（fx fixture 2026-08-01），呢度再加一條就超配額
    const res = await batchWrite(
      req("http://test.local/api/shift-records/batch", brokerACookie, "POST", {
        site_id: fx.site.id,
        month: MONTH,
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-20", code: "N" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.some((w: string) => w.includes("超配額"))).toBe(true);
  });
});

describe("P1-WP3：months/open（開新月份，複製上月結構）", () => {
  let fx: Wp2Fixture;
  let supervisorCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    await prisma.quota.create({
      data: { month: fx.unlockedMonth, siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, targetShifts: 15, createdBy: "test" },
    });
  });

  it("主管開 2026-09（上月=2026-08 有 assignments/quotas/daily_requirements）→ 全部複製", async () => {
    const res = await monthOpen(req("http://test.local/api/months/2026-09/open", supervisorCookie, "POST", {}), { params: Promise.resolve({ month: "2026-09" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.broker_site_assignments_created).toBe(2); // brokerA + brokerB
    expect(body.quotas_created).toBe(1);
    expect(body.daily_requirements_created).toBe(1);

    const sept = new Date(Date.UTC(2026, 8, 1));
    const assignCount = await prisma.brokerSiteAssignment.count({ where: { month: sept, siteId: fx.site.id } });
    expect(assignCount).toBe(2);
    const quotaRow = await prisma.quota.findFirst({ where: { month: sept, siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id } });
    expect(quotaRow?.targetShifts).toBe(15);
    const drRow = await prisma.dailyRequirement.findFirst({ where: { siteId: fx.site.id, workDate: new Date(Date.UTC(2026, 8, 1)) } });
    expect(drRow?.headcountRequired).toBe(3);
  });

  it("再開一次（幂等）→ created counts 為 0（已存在跳過）", async () => {
    await monthOpen(req("http://test.local/api/months/2026-09/open", supervisorCookie, "POST", {}), { params: Promise.resolve({ month: "2026-09" }) });
    const res2 = await monthOpen(req("http://test.local/api/months/2026-09/open", supervisorCookie, "POST", {}), { params: Promise.resolve({ month: "2026-09" }) });
    const body2 = await res2.json();
    expect(body2.broker_site_assignments_created).toBe(0);
    expect(body2.quotas_created).toBe(0);
    expect(body2.daily_requirements_created).toBe(0);
  });

  it("雞頭開新月份 → 403", async () => {
    const res = await monthOpen(req("http://test.local/api/months/2026-09/open", brokerACookie, "POST", {}), { params: Promise.resolve({ month: "2026-09" }) });
    expect(res.status).toBe(403);
  });

  it("目標月份已鎖定 → 403 Locked", async () => {
    const res = await monthOpen(req("http://test.local/api/months/2026-06/open", supervisorCookie, "POST", {}), { params: Promise.resolve({ month: "2026-06" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("month_locked");
  });
});

describe("P1-WP3：雞頭讀取 shift-types／sites（更表編輯器要用，「盤」module 硬性 deny 之下嘅 module resolver 例外）", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭 GET shift-types 見到自己有份嘅盤，唔含 createdBy/voidedBy", async () => {
    const res = await shiftTypesList(req(`http://test.local/api/shift-types?site_id=${fx.site.id}`, brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows[0].code).toBe("N");
    expect("created_by" in body.rows[0]).toBe(false);
    expect("voided_by" in body.rows[0]).toBe(false);
  });

  it("雞頭 GET shift-types 見唔到冇份嘅盤", async () => {
    const res = await shiftTypesList(req(`http://test.local/api/shift-types?site_id=${fx.siteUnassigned.id}`, brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBe(0);
  });

  it("雞頭 GET sites 見到自己有份嘅盤，冇 monthly_fee/client_group 呢類財務／後台欄", async () => {
    const res = await sitesList(req("http://test.local/api/sites", brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const own = body.rows.find((r: { id: string }) => r.id === fx.site.id);
    expect(own).toBeTruthy();
    expect(own.canonical_name).toBe(fx.site.name);
    expect("monthly_fee" in own).toBe(false);
    expect("client_group" in own).toBe(false);
    expect(body.rows.some((r: { id: string }) => r.id === fx.siteUnassigned.id)).toBe(false);
  });
});
