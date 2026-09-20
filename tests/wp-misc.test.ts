// WP-MISC（老闆 2026-09-20 拍板）——一個 migration 做晒兩個決定（A 佔位
// 記錄標記老闆已取消，唔喺呢個 branch 出現）：
//   A. QAS（基本保安訓練證書）日期——`qas_issue_date`（完成日期）／
//      `qas_expiry_date`（到期日，如有），跟「安員」module，納入 90 日
//      內到期高亮。
//   C. LINK（TKO Gateway 厚A/B/C）——`sites.guards_paid_by_client`：呢類
//      盤嘅保安員由客戶直接出糧，我哋淨係收每月服務費，唔逐更計客價／
//      工資、唔算「未定价」、reprice／batch save 唔寫 snapshot（已有值
//      唔清）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { POST as reprice } from "@/app/api/shift-records/reprice/route";
import { GET as unpricedGet } from "@/app/api/shift-records/unpriced/route";
import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { POST as approveRecord } from "@/app/api/shift-records/[id]/approve/route";
import { PATCH as sitePatch } from "@/app/api/sites/[id]/route";
import { GET as guardGet, PATCH as guardPatch } from "@/app/api/guards/[id]/route";
import { GET as guardsListGet } from "@/app/api/guards/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-MISC A：QAS（基本保安訓練證書）日期", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("PATCH /api/guards/:id 可以寫 qas_issue_date／qas_expiry_date，GET 讀返", async () => {
    const res = await guardPatch(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { qas_issue_date: "2024-01-15", qas_expiry_date: "2026-10-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qas_issue_date).toContain("2024-01-15");
    expect(body.qas_expiry_date).toContain("2026-10-01");

    const getRes = await guardGet(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "GET"), { params: Promise.resolve({ id: fx.guardA.id }) });
    const getBody = await getRes.json();
    expect(getBody.qas_issue_date).toContain("2024-01-15");
    expect(getBody.qas_expiry_date).toContain("2026-10-01");
  });

  it("PATCH null 清得走已填嘅 QAS 日期", async () => {
    await guardPatch(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { qas_expiry_date: "2026-10-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardPatch(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { qas_expiry_date: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qas_expiry_date).toBeNull();
  });

  it("GET /api/guards?expiring_within_days= 一齊計 QAS 到期日（同牌照／平安卡一致口徑）", async () => {
    // guardA 淨係 QAS 30 日內到期（牌照／平安卡完全未填）——冇呢個欄
    // 一齊計就搵唔到呢個 guard。
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await guardPatch(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { qas_expiry_date: soon }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardsListGet(req("http://test.local/api/guards?expiring_within_days=90", ownerCookie, "GET"));
    const body = await res.json();
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(fx.guardA.id);
  });

  it("QAS 到期日已過期／90 日外唔會誤入 expiring_within_days 篩選", async () => {
    const far = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    await guardPatch(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { qas_expiry_date: far }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res = await guardsListGet(req("http://test.local/api/guards?expiring_within_days=90", ownerCookie, "GET"));
    const body = await res.json();
    const ids = body.rows.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(fx.guardA.id);
  });
});

describe("WP-MISC C：LINK（客戶直接出糧）嘅盤——guards_paid_by_client", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("PATCH /api/sites/:id 可以切換 guards_paid_by_client（跟「盤」module update）", async () => {
    const res = await sitePatch(req(`http://test.local/api/sites/${fx.site.id}`, ownerCookie, "PATCH", { guards_paid_by_client: true }), {
      params: Promise.resolve({ id: fx.site.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guards_paid_by_client).toBe(true);
  });

  it("guards_paid_by_client=true：batch save 新記錄唔寫 snapshot（就算有夾中嘅通用卡）", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    // fx.rateCardGeneric（clientRate=999/guardWage=700/brokerFee=50）本身
    // 夾得中呢個 site×shiftType 組合——冇呢個 gate 嘅話 resolver 會計到價。
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-09", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // 老闆拍板：呢類盤嘅更一律唔算未定价（payout 同 client 都唔算）。
    expect(body.pricing.unpriced).toBe(0);
    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 9)) } });
    expect(created).toBeTruthy();
    expect(created!.clientRateSnapshot).toBeNull();
    expect(created!.guardWageSnapshot).toBeNull();
    expect(created!.brokerFeeSnapshot).toBeNull();
  });

  it("guards_paid_by_client=true：batch save 唔清走已有嘅 snapshot（保守，reprice/batch 都唔掂）", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    // fx.shiftRecordA 已經有 snapshot（999/700/50，喺 fixture 起嗰陣，
    // 模擬「未拍板之前已經有嘅舊資料」）——batch save 改呢一格另一個
    // 唔相干嘅屬性（settlement_broker 不變，code 唔變），唔應該清走。
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    // shiftRecordA 本身係 7 月（work_date 2026-08-01 用嘅係 fixture 入面
    // Aug 1 記錄——見 seedWp2Fixture shiftRecordA workDate=2026-08-01）。
    const after = await prisma.shiftRecord.findUnique({ where: { id: fx.shiftRecordA.id } });
    expect(after!.clientRateSnapshot?.toString()).toBe("999");
    expect(after!.guardWageSnapshot?.toString()).toBe("700");
    expect(after!.brokerFeeSnapshot?.toString()).toBe("50");
  });

  it("guards_paid_by_client=true：GET /api/shift-records/unpriced 唔計呢個盤（就算 snapshot 全 null）", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 15)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test:wp-misc",
      },
    });
    const res = await unpricedGet(req("http://test.local/api/shift-records/unpriced?month=2026-08", ownerCookie, "GET"));
    const body = await res.json();
    const siteGroups = body.groups.filter((g: { site_id: string }) => g.site_id === fx.site.id);
    expect(siteGroups.length).toBe(0);
  });

  it("guards_paid_by_client=true：reprice（dry_run:false）對呢個盤完全唔掂，changed=0", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    // 起一條「明顯過時」嘅 snapshot（同 rate_cards 現值唔一致）——如果冇
    // gate，reprice 會將佢追返做 999/700/50（rateCardGeneric 嘅值）。
    const stale = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 20)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "confirmed",
        clientRateSnapshot: 1,
        guardWageSnapshot: 1,
        brokerFeeSnapshot: 1,
        createdBy: "test:wp-misc",
      },
    });
    const res = await reprice(
      req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", site_id: fx.site.id, dry_run: false }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(0);
    const after = await prisma.shiftRecord.findUnique({ where: { id: stale.id } });
    expect(after!.clientRateSnapshot?.toString()).toBe("1");
    expect(after!.guardWageSnapshot?.toString()).toBe("1");
    expect(after!.brokerFeeSnapshot?.toString()).toBe("1");
  });

  it("guards_paid_by_client=false（其他盤）：一切行為不變——batch save 照計价，reprice 照追", async () => {
    // 冇拍板嘅盤（fx.site 保持預設 false）——確保呢個 gate 淨係影響開咗
    // flag 嘅盤，唔會誤傷其他盤嘅現有行為（同 gate:pricing 7 月 0 差異
    // 呼應）。
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-09", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing.priced).toBe(1);
    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 9)) } });
    expect(created!.clientRateSnapshot?.toString()).toBe("888"); // rateCardBrokerA（更具體）
  });

  // WP-MISC Opus 應修（P0 同一輪覆核，A2）：approve 路徑、單筆 POST
  // （內部＋雞頭）、flag true→false 後行為——之前淨係測咗 batch save／
  // reprice／unpriced，呢三個路徑一齊有同一個 gate（見各自檔案
  // 「WP-MISC」註解），冇獨立測過。
  it("guards_paid_by_client=true：approve 路徑唔會幫 pending_approval 記錄補計 snapshot（就算有夾中嘅通用卡）", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    const pending = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 2)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "pending_approval",
        createdBy: "test:wp-misc",
      },
    });
    const res = await approveRecord(req(`http://test.local/api/shift-records/${pending.id}/approve`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: pending.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("confirmed");
    expect(body.client_rate_snapshot).toBeNull();
    expect(body.guard_wage_snapshot).toBeNull();
    expect(body.broker_fee_snapshot).toBeNull();
  });

  it("guards_paid_by_client=true：單筆 POST /api/shift-records（內部角色）新記錄唔寫 snapshot", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-03",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        settlement_broker_id: fx.brokerA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_rate_snapshot).toBeNull();
    expect(body.guard_wage_snapshot).toBeNull();
    expect(body.broker_fee_snapshot).toBeNull();
  });

  it("guards_paid_by_client=true：單筆 POST /api/shift-records（雞頭角色）新記錄唔寫 snapshot", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerCookie, "POST", {
        work_date: "2026-08-04",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id, // fx.guardA.default_broker_id = brokerA，先過得到雞頭嘅歸屬檢查
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // 雞頭角色 DTO 白名單（SHIFT_RECORD_BROKER_FIELDS）本身唔含
    // client_rate_snapshot（雞頭永遠見唔到收客價，同 guards_paid_by_
    // client 呢個 flag 無關）——呢個 key 應該完全唔存在，唔係 null。
    expect(body.client_rate_snapshot).toBeUndefined();
    expect(body.guard_wage_snapshot).toBeNull();
    expect(body.broker_fee_snapshot).toBeNull();
  });

  it("guards_paid_by_client：true→false 之後即刻生效——切走 flag 嗰刻之後嘅 batch save 照計价（gate 即時跟 site 現值，唔係俾之前嗰次讀取快取住）", async () => {
    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: true } });
    const resOn = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-11", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(resOn.status).toBe(200);
    const createdOn = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 11)) } });
    expect(createdOn!.clientRateSnapshot).toBeNull();

    await prisma.site.update({ where: { id: fx.site.id }, data: { guardsPaidByClient: false } });
    const resOff = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-12", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(resOff.status).toBe(200);
    const bodyOff = await resOff.json();
    expect(bodyOff.pricing.priced).toBe(1);
    const createdOff = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 12)) } });
    expect(createdOff!.clientRateSnapshot?.toString()).toBe("888"); // rateCardBrokerA（更具體），flag 關咗即刻照計价
  });
});

describe("WP-MISC migration synthetic test：`guards_paid_by_client` backfill（逐字對照 migration.sql）", () => {
  beforeEach(async () => {
    await clearAll();
  });

  // 逐字對照 prisma/migrations/20260919230718_wp_misc_qas_client_payroll_sites/
  // migration.sql 嘅 backfill UPDATE——呢個 SQL 本身冇任何複雜邏輯（純
  // canonical_name 字面比對），呢度直接喺 test 入面重跑一次驗證幾個邊界：
  // (1) 名啱嘅三個盤變 true；(2) 名唔啱（包括部份/相似）嘅盤唔變；
  // (3) 重跑安全（idempotent，第二次跑值唔變）。
  async function runBackfill(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      UPDATE "sites"
      SET "guards_paid_by_client" = true
      WHERE "canonical_name" IN ('TKO Gateway 厚A', 'TKO Gateway 厚B', 'TKO Gateway 厚C')
    `);
  }

  it("淨係嗰三個 canonical_name 先變 true，名似但唔啱嘅盤唔變", async () => {
    const names = ["TKO Gateway 厚A", "TKO Gateway 厚B", "TKO Gateway 厚C", "TKO Gateway 厚D", "TKO Gateway", "測試盤唔係LINK"];
    const created = await Promise.all(
      names.map((n) => prisma.site.create({ data: { canonicalName: n, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:wp-misc-migration" } })),
    );

    await runBackfill();

    const after = await prisma.site.findMany({ where: { id: { in: created.map((s) => s.id) } } });
    const byName = Object.fromEntries(after.map((s) => [s.canonicalName, s.guardsPaidByClient]));
    expect(byName["TKO Gateway 厚A"]).toBe(true);
    expect(byName["TKO Gateway 厚B"]).toBe(true);
    expect(byName["TKO Gateway 厚C"]).toBe(true);
    expect(byName["TKO Gateway 厚D"]).toBe(false);
    expect(byName["TKO Gateway"]).toBe(false);
    expect(byName["測試盤唔係LINK"]).toBe(false);
  });

  it("0 行夾中（呢三個盤名喺呢個 DB 唔存在）都唔會 abort——重跑安全", async () => {
    await expect(runBackfill()).resolves.not.toThrow();
    await expect(runBackfill()).resolves.not.toThrow(); // 第二次都要得
  });

  it("重跑 idempotent：已經 true 嘅再跑一次仍然係 true", async () => {
    const site = await prisma.site.create({
      data: { canonicalName: "TKO Gateway 厚A", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:wp-misc-migration" },
    });
    await runBackfill();
    await runBackfill();
    const after = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(after.guardsPaidByClient).toBe(true);
  });
});
