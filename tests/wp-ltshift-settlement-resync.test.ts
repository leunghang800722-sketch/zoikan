// WP-LTSHIFT §19 交付 C：`recomputeSettlement(uploadId)`——直接掃呢張
// 上載盤（含子盤）＋月份 scope 入面已寫入嘅 shift_records（唔靠更表
// 行配對），對長工格重新跑 `resolveLongtermSettlement()`，settlement／
// operational 有變就 UPDATE 落去（唔換 row id）。
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
    return prisma.user.create({ data: { name: "測試上載人", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
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

  it("非長工安員嘅 shift_record 唔郁（唔關 WP-LTSHIFT 事）", async () => {
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

  it("上載未定盤（site_id null）——冇嘢好重算，返 0", async () => {
    const uploader = await makeUploader();
    const upload = await prisma.rosterUpload.create({
      data: { month: new Date("2026-08-01"), siteId: null, siteNameRaw: "未定盤", uploaderUserId: uploader.id, fileName: "test.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 },
    });
    const result = await recomputeSettlement(upload.id);
    expect(result).toEqual({ scanned: 0, longtermScanned: 0, changed: 0, changes: [] });
  });
});
