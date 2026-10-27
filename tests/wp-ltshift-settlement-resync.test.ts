// WP-LTSHIFT §19 交付 C：`recomputeSettlement(uploadId)`——直接掃呢張
// 上載盤（含子盤）＋月份 scope 入面已寫入嘅 shift_records（唔靠更表
// 行配對），對長工格重新跑 `resolveLongtermSettlement()`，settlement／
// operational 有變就 UPDATE 落去（唔換 row id）。
import { fakeTel } from "./helpers/fake-tel";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { recomputeSettlement } from "@/lib/roster-upload/settlement-resync";

describe("recomputeSettlement", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function makeBroker(code: string, kind: "broker" | "internal_longterm" = "broker") {
    return prisma.broker.create({ data: { code, name: `測試${code}`, kind, settlementType: kind === "internal_longterm" ? "salary" : "cash", createdBy: "test:settlement-resync" } });
  }
  async function makeSite(name: string) {
    return prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:settlement-resync" } });
  }
  async function makeGuard(employmentType: "cash_casual" | "longterm_autopay" = "longterm_autopay") {
    return prisma.guard.create({ data: { nameZh: "測試長工", employmentType, createdBy: "test:settlement-resync" } });
  }
  async function makeUploader() {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    return prisma.user.create({ data: { name: "測試上載人", tel: fakeTel(), passwordHash: "x", roleId: role.id, createdBy: "test" } });
  }
  async function makeUpload(siteId: string, uploaderId: string) {
    return prisma.rosterUpload.create({
      data: { month: new Date("2026-08-01"), siteId, siteNameRaw: "test", uploaderUserId: uploaderId, fileName: "test.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 },
    });
  }
  async function makeShiftType(siteId: string) {
    return prisma.shiftType.create({ data: { siteId, code: "N", label: "測試更", hours: 12, createdBy: "test:settlement-resync" } });
  }

  it("冇 guard_longterm_posts 時：長工格保守全部歸 B07（longterm_dispersed_b07）", async () => {
    const k = await makeBroker("TEST-K");
    const b07 = await makeBroker("TEST-B07", "internal_longterm");
    const site = await makeSite("測試盤");
    const guard = await makeGuard();
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    // 舊記錄：一開始跟緊更表雞頭碼（K），未經 WP-LTSHIFT 判斷。
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: k.id, operationalBrokerId: k.id },
    });

    const result = await recomputeSettlement(upload.id);
    expect(result.longtermScanned).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.changes[0]!.reason).toBe("longterm_dispersed_b07");

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.settlementBrokerId).toBe(b07.id);
    expect(after.operationalBrokerId).toBe(k.id); // operational 保留雞頭碼做成本桶
  });

  it("加咗 guard_longterm_posts 之後重算：B07 格照舊、operational 唔變（冪等，changed=0）", async () => {
    const k = await makeBroker("TEST-K2");
    await makeBroker("TEST-B072", "internal_longterm");
    const site = await makeSite("測試盤2");
    const guard = await makeGuard();
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: k.id, operationalBrokerId: k.id },
    });

    const r1 = await recomputeSettlement(upload.id);
    expect(r1.changed).toBe(1);
    expect(r1.changes[0]!.reason).toBe("longterm_post");

    const r2 = await recomputeSettlement(upload.id);
    expect(r2.changed).toBe(0); // 已經啱，冪等唔再改

    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.operationalBrokerId).toBe(k.id);
  });

  it("非長工保安員嘅 shift_record 唔郁（唔關 WP-LTSHIFT 事）", async () => {
    const k = await makeBroker("TEST-K3");
    const site = await makeSite("測試盤3");
    const guard = await makeGuard("cash_casual");
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: k.id, operationalBrokerId: k.id },
    });
    const result = await recomputeSettlement(upload.id);
    expect(result.longtermScanned).toBe(0);
    expect(result.changed).toBe(0);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.settlementBrokerId).toBe(k.id);
  });

  it("驗收（Opus 5.5）：本月有 Postorder（權威）——推算崗位（inferred）唔算、唔再推算；B07 格改返更表雞頭碼，而且重新定價（唔係留低 B07 冇外判價）", async () => {
    const k = await makeBroker("TEST-K5");
    await makeBroker("TEST-B075", "internal_longterm");
    const site = await makeSite("測試盤5");
    const guard = await makeGuard();
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, brokerId: k.id, clientRate: 900, guardWage: 850, payoutRate: 850, billingModel: "per_shift", effectiveFrom: new Date("2026-08-01"), createdBy: "test" } });
    // 之前（未有 Postorder）逐盤套用留低：推算崗位＋B07、冇外判價。
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "inferred", createdBy: "test" } });
    const b07 = await prisma.broker.findFirstOrThrow({ where: { code: "TEST-B075" } });
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: b07.id, operationalBrokerId: k.id, clientRateSnapshot: 900, guardWageSnapshot: null },
    });
    const po = await prisma.postorderUpload.create({ data: { month: new Date("2026-08-01"), uploaderId: uploader.id, fileName: "po.xlsm", fileSha256: "x", fileBytes: Buffer.from("x"), fileSize: 1, rowCount: 0, status: "parsed" } });
    // 淨係上載、未套用 guard-fix 計劃——唔當權威（仲係跟推算崗位 B07，唔郁）。
    expect((await recomputeSettlement(upload.id)).changed).toBe(0);
    const staffList = await prisma.staffListUpload.create({ data: { uploaderId: uploader.id, fileName: "u.xlsx", fileSha256: "u", fileBytes: Buffer.from("u"), fileSize: 1, rowCount: 0 } });
    await prisma.guardFixRun.create({ data: { month: new Date("2026-08-01"), staffListUploadId: staffList.id, postorderUploadId: po.id, createdById: uploader.id, planJson: {}, summaryJson: {}, status: "applied" } });

    const r = await recomputeSettlement(upload.id);
    expect(r.changed).toBe(1);
    expect(r.changes[0]!.reason).toBe("longterm_no_post_postorder");
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.settlementBrokerId).toBe(k.id);
    expect(after.operationalBrokerId).toBe(k.id);
    expect(Number(after.guardWageSnapshot)).toBe(850); // 重新定價
    expect(Number(after.clientRateSnapshot)).toBe(900);
    // 冪等
    expect((await recomputeSettlement(upload.id)).changed).toBe(0);
  });

  it("驗收（Opus 5.5）：K→B07 重新定價——B07 格 guard_wage 清走（8 月起 broker_fee 都唔寫）", async () => {
    const k = await makeBroker("TEST-K6");
    const b07 = await makeBroker("TEST-B076", "internal_longterm");
    const site = await makeSite("測試盤6");
    const guard = await makeGuard();
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, clientRate: 900, guardWage: 850, brokerFee: 30, payoutRate: 880, billingModel: "per_shift", effectiveFrom: new Date("2026-08-01"), createdBy: "test" } });
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: k.id, operationalBrokerId: k.id, clientRateSnapshot: 900, guardWageSnapshot: 850, brokerFeeSnapshot: 30 },
    });
    const r = await recomputeSettlement(upload.id);
    expect(r.changed).toBe(1);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.settlementBrokerId).toBe(b07.id);
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
    expect(Number(after.clientRateSnapshot)).toBe(900);
  });

  it("驗收（Opus 5.5）：B07 格結算單位冇變、但帶住舊版寫落嘅 guard_wage／broker_fee——8 月起一樣清走", async () => {
    const k = await makeBroker("TEST-K7");
    const b07 = await makeBroker("TEST-B077", "internal_longterm");
    const site = await makeSite("測試盤7");
    const guard = await makeGuard();
    const st = await makeShiftType(site.id);
    const uploader = await makeUploader();
    const upload = await makeUpload(site.id, uploader.id);
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const sr = await prisma.shiftRecord.create({
      data: { workDate: new Date("2026-08-05"), siteId: site.id, shiftTypeId: st.id, guardId: guard.id, settlementBrokerId: b07.id, operationalBrokerId: k.id, guardWageSnapshot: 850, brokerFeeSnapshot: 30 },
    });
    const r = await recomputeSettlement(upload.id);
    expect(r.changed).toBe(1);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sr.id } });
    expect(after.settlementBrokerId).toBe(b07.id);
    expect(after.guardWageSnapshot).toBeNull();
    expect(after.brokerFeeSnapshot).toBeNull();
    expect((await recomputeSettlement(upload.id)).changed).toBe(0);
  });

  it("上載未定盤（site_id null）——冇嘢好重算，返 0", async () => {
    const uploader = await makeUploader();
    const upload = await prisma.rosterUpload.create({
      data: { month: new Date("2026-08-01"), siteId: null, siteNameRaw: "未定盤", uploaderUserId: uploader.id, fileName: "test.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 },
    });
    const result = await recomputeSettlement(upload.id);
    expect(result).toEqual({ scanned: 0, longtermScanned: 0, changed: 0, changes: [] });
  });
});
