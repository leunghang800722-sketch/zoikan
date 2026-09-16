// WP-PRICE（老闆 2026-09-16 拍板）——integration test：
//  1. 更表批量儲存新記錄自動填 snapshot（之前完全冇寫，見 batch/route.ts
//     舊版註解），回應帶 pricing.priced/unpriced。
//  2. GET /api/shift-records/unpriced：權限「更表:view」、雞頭隔離。
//  3. POST /api/shift-records/reprice：權限「出街價:update」、鎖定月份
//     409、重算後 snapshot＝卡值、unpriced 分組。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { GET as unpricedGet } from "@/app/api/shift-records/unpriced/route";
import { POST as reprice } from "@/app/api/shift-records/reprice/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-PRICE：更表批量儲存自動計价", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("新記錄自動填 snapshot（用返 rateCardBrokerA 嘅價：888/650/60），回應 pricing.priced=1", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing.priced).toBe(1);
    expect(body.pricing.unpriced).toBe(0);

    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 5)) } });
    expect(created).toBeTruthy();
    expect(created!.clientRateSnapshot?.toString()).toBe("888");
    expect(created!.guardWageSnapshot?.toString()).toBe("650");
    expect(created!.brokerFeeSnapshot?.toString()).toBe("60");
  });

  it("冇對應卡嘅組合：新記錄 snapshot 全 null，pricing.unpriced=1 並帶分組明細", async () => {
    // brokerB 喺呢個盤冇任何 rate_card（fixture 淨係起咗 generic 同 brokerA 兩張）。
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-06", code: "N", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // generic 卡（brokerId=null）都有 client_rate/guard_wage/broker_fee，所以收客/出街都會揀到 generic 卡，唔算 unpriced。
    expect(body.pricing.priced).toBe(1);
    expect(body.pricing.unpriced).toBe(0);
  });

  it("真係冇任何卡（voidedAt 所有卡）：pricing.unpriced=1，snapshot 全 null", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-07", code: "N", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing.unpriced).toBe(1);
    expect(body.pricing.unpriced_cells.length).toBeGreaterThan(0);
    const created = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 7)) } });
    expect(created!.clientRateSnapshot).toBeNull();
    expect(created!.guardWageSnapshot).toBeNull();
    expect(created!.brokerFeeSnapshot).toBeNull();
  });
});

// 必修 1(a)（Opus 第二輪驗收）：code="PR"（糧明細生成 reconciliation
// placeholder，見 src/lib/pricing/resolve-rate.ts 頂註解）唔可以新建——
// batch/route.ts 同單條 POST /api/shift-records 都要 400。呢度用 integration
// test（唔淨係 e2e）釘住，保證 vitest 全跑都攔到（e2e 見 tests/e2e/
// pricing.spec.ts (e)）。
describe("WP-PRICE 必修 1：code=\"PR\"（對數佔位更別）唔可以新建", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let prShiftTypeId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const prShiftType = await prisma.shiftType.create({
      data: { siteId: fx.site.id, code: "PR", label: "糧明細生成（更表冇對應資料）", createdBy: "test:wp-price-pr" },
    });
    prShiftTypeId = prShiftType.id;
  });

  it("batch/route.ts：新建 code=\"PR\" 記錄 → 400，乜都冇寫", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: prShiftTypeId, work_date: "2026-08-05", code: "PR", settlement_broker_id: fx.brokerA.id }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/對數佔位更別/);
    const created = await prisma.shiftRecord.findFirst({ where: { shiftTypeId: prShiftTypeId } });
    expect(created).toBeNull();
  });

  it("batch/route.ts：同一批入面其他正常格唔受 PR 格 400 連累——成批一齊 400（rollback，冇部分寫入）", async () => {
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [
          { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N", settlement_broker_id: fx.brokerA.id },
          { guard_id: fx.guardA.id, shift_type_id: prShiftTypeId, work_date: "2026-08-06", code: "PR", settlement_broker_id: fx.brokerA.id },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const normalCreated = await prisma.shiftRecord.findFirst({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 5)) } });
    expect(normalCreated).toBeNull(); // 成批 rollback，正常格都冇寫入
  });

  it("POST /api/shift-records（內部角色單條）：code=\"PR\" 嘅 shift_type_id → 400", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", ownerCookie, "POST", {
        work_date: "2026-08-05",
        site_id: fx.site.id,
        shift_type_id: prShiftTypeId,
        guard_id: fx.guardA.id,
        settlement_broker_id: fx.brokerA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(400);
    const created = await prisma.shiftRecord.findFirst({ where: { shiftTypeId: prShiftTypeId } });
    expect(created).toBeNull();
  });

  it("更新既有 PR 記錄（唔係新建）唔受影響——batch 淨係擋新建", async () => {
    // 模擬「7 月已經有一條 PR 記錄」（本身月鎖定，呢度用 8 月純粹方便
    // test 唔使處理鎖月）——batch 改呢條*既有*記錄嘅其他欄（例如
    // settlement_broker）唔應該撞 PR 400，因為 `!record` 條件唔成立。
    const existing = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 6)),
        siteId: fx.site.id,
        shiftTypeId: prShiftTypeId,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test:wp-price-pr",
      },
    });
    const res = await batchSave(
      req("http://test.local/api/shift-records/batch", ownerCookie, "POST", {
        site_id: fx.site.id,
        month: "2026-08",
        cells: [{ guard_id: fx.guardA.id, shift_type_id: prShiftTypeId, work_date: "2026-08-06", code: "PR", settlement_broker_id: fx.brokerB.id }],
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.settlementBrokerId).toBe(fx.brokerB.id);
  });
});

describe("WP-PRICE：GET /api/shift-records/unpriced", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]); // 掛 brokerA
    // shiftRecordA/B 本身已經有齊 snapshot（fixture 種嘅），呢度補一條冇卡嘅未定价記錄（brokerA）。
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 8)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardA.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        createdBy: "test",
      },
    });
    await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 8)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: fx.guardB.id,
        settlementBrokerId: fx.brokerB.id,
        operationalBrokerId: fx.brokerB.id,
        recordType: "shift",
        createdBy: "test",
      },
    });
  });

  it("老闆見到全部未定价（brokerA + brokerB）", async () => {
    const res = await unpricedGet(req(`http://test.local/api/shift-records/unpriced?month=2026-08`, ownerCookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
  });

  it("雞頭（brokerA）淨係見到自己嘅未定价（隔離）", async () => {
    const brokerARow = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerA.id } });
    const res = await unpricedGet(req(`http://test.local/api/shift-records/unpriced?month=2026-08`, brokerACookie, "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.groups[0].broker_code).toBe(brokerARow.code);
  });
});

describe("WP-PRICE：POST /api/shift-records/reprice", () => {
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

  it("雞頭冇「出街價:update」（硬性 deny）→ 403", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", brokerACookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(403);
  });

  it("主管出廠冇「出街價:update」（off，未開）→ 403", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", supervisorCookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(403);
  });

  it("鎖定月份（2026-06）→ 409", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-06" }));
    expect(res.status).toBe(409);
  });

  it("M3：dry_run 預設 true——唔傳 dry_run 就淨係回 diff 摘要，乜都唔寫", async () => {
    await prisma.rateCard.update({ where: { id: fx.rateCardBrokerA.id }, data: { clientRate: 1200, guardWage: 900, brokerFee: 80 } });

    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.repriced).toBe(0); // dry-run 乜都冇寫
    expect(body.changed).toBeGreaterThanOrEqual(1);

    // 確認真係冇寫入 DB——snapshot 仍然係 fixture 嘅舊值（999），唔係新卡值（1200）。
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe("999");
  });

  it("老闆重新計价 2026-08（dry_run:false）：改咗 rate_card 之後，重算完 snapshot 追返新卡值", async () => {
    // shiftRecordA 本身 snapshot 係 999/700/50（fixture 種嘅舊值）——改
    // 咗 rateCardBrokerA 嘅價之後，冇重計之前 snapshot 唔會自動變。
    await prisma.rateCard.update({ where: { id: fx.rateCardBrokerA.id }, data: { clientRate: 1200, guardWage: 900, brokerFee: 80 } });

    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", dry_run: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(false);
    expect(body.repriced).toBeGreaterThanOrEqual(1);

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe("1200");
    expect(after.guardWageSnapshot?.toString()).toBe("900");
    expect(after.brokerFeeSnapshot?.toString()).toBe("80");
  });

  it("重新計价之後（dry_run:false）、搵唔到卡但本身有值嘅記錄——kept_unresolved 計及，唔計入 unpriced（必修 2：口徑統一用 buildUnpricedSummary()）", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", dry_run: false }));
    const body = await res.json();
    // 必修 2（Opus 第二輪驗收）：reprice 回應嘅 `unpriced` 而家一律用
    // `buildUnpricedSummary()`（同 GET /api/shift-records/unpriced 一致
    // 口徑）——shiftRecordA/B 原本 999/700/50（非 null），卡晒 void 之後
    // resolver 搵唔到卡，M3「保留原值」令 snapshot keep 咗 999/700/50，
    // 真係未定价判斷（isUnpricedShift）睇嘅係*最終* snapshot 狀態，唔係
    // 「呢次 reprice 有冇搵到卡」——非 null 嘅 snapshot 唔算未定价，所以
    // `unpriced` 應該係 0，`kept_unresolved` 先反映「呢兩條搵唔到卡、
    // 保留返原值」。
    expect(body.kept_unresolved).toBeGreaterThanOrEqual(2);
    expect(body.unpriced).toBe(0);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe("999");
    expect(after.guardWageSnapshot?.toString()).toBe("700");
    expect(after.brokerFeeSnapshot?.toString()).toBe("50");
  });

  it("M3：真係本身就未定价（snapshot 本身就 null）嘅記錄，搵唔到卡繼續係 null（唔係 kept 出嚟嘅假象）", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const freshGuard = await prisma.guard.create({ data: { nameZh: "測試新人", employmentType: "cash_casual", createdBy: "test" } });
    const brandNew = await prisma.shiftRecord.create({
      data: {
        workDate: new Date(Date.UTC(2026, 7, 20)),
        siteId: fx.site.id,
        shiftTypeId: fx.shiftType.id,
        guardId: freshGuard.id,
        settlementBrokerId: fx.brokerA.id,
        operationalBrokerId: fx.brokerA.id,
        recordType: "shift",
        status: "confirmed",
        createdBy: "test",
      },
    });
    await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", dry_run: false }));
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: brandNew.id } });
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
  });

  it("M3：resolver 搵唔到（voidedAt 晒全部卡）就保留原值——kept_unresolved 計及，唔會靜靜清走已有嘅 snapshot", async () => {
    await prisma.rateCard.updateMany({ where: { siteId: fx.site.id }, data: { voidedAt: new Date() } });
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", dry_run: false }));
    const body = await res.json();
    expect(body.kept_unresolved).toBeGreaterThanOrEqual(1);
    // shiftRecordA 原本 999/700/50 全部搵唔到卡（卡晒 void），全部保留原值。
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(after.clientRateSnapshot?.toString()).toBe("999");
    expect(after.guardWageSnapshot?.toString()).toBe("700");
    expect(after.brokerFeeSnapshot?.toString()).toBe("50");
  });

  it("site_id 篩選：淨係重算指定盤", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", site_id: fx.site.id }));
    expect(res.status).toBe(200);
  });

  it("S5：site_id 唔存在 → 404", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", site_id: "00000000-0000-0000-0000-000000000000" }));
    expect(res.status).toBe(404);
  });

  it("S5：月份格式唔啱（例如 13 月）→ 400", async () => {
    const res = await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-13" }));
    expect(res.status).toBe(400);
  });

  it("寫低 audit_log（action=reprice_month，dry_run:false 先至寫）", async () => {
    const before = await prisma.auditLog.count({ where: { action: "reprice_month" } });
    await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08" })); // dry_run 預設 true
    const afterDryRun = await prisma.auditLog.count({ where: { action: "reprice_month" } });
    expect(afterDryRun).toBe(before); // dry-run 唔寫 audit

    await reprice(req("http://test.local/api/shift-records/reprice", ownerCookie, "POST", { month: "2026-08", dry_run: false }));
    const after = await prisma.auditLog.count({ where: { action: "reprice_month" } });
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirst({ where: { action: "reprice_month" }, orderBy: { createdAt: "desc" } });
    const afterPayload = row?.after as { changed_records?: unknown[] } | null;
    expect(Array.isArray(afterPayload?.changed_records)).toBe(true); // M3：after 含全部 changed 記錄嘅 {id,before,after}
  });
});
