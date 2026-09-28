// WP-LTSHIFT（老闆 2026-09-26 §2）：長工結算單位判斷——純函數
// `resolveLongtermSettlement()` 單元測試（冇 DB 依賴，快）；DB helper
// `loadActiveLongtermPosts()`／`inferGuardMonthlyTopSite()`／
// `findInternalLongtermBrokerId()` 另外用真 DB fixture 測（同
// tests/settlement-broker-fallback.test.ts 一致手法）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import {
  resolveLongtermSettlement,
  isLongtermEmploymentType,
  findInternalLongtermBrokerId,
  loadActiveLongtermPosts,
  inferGuardMonthlyTopSite,
  inferReferralBrokerFromRosters,
} from "@/lib/pricing/longterm-settlement";

describe("isLongtermEmploymentType", () => {
  it("longterm_ 開頭先算長工", () => {
    expect(isLongtermEmploymentType("longterm_autopay")).toBe(true);
    expect(isLongtermEmploymentType("cash_casual")).toBe(false);
    expect(isLongtermEmploymentType("external")).toBe(false);
    expect(isLongtermEmploymentType(null)).toBe(false);
    expect(isLongtermEmploymentType(undefined)).toBe(false);
  });
});

describe("resolveLongtermSettlement", () => {
  const base = {
    employmentType: "longterm_autopay",
    visaSponsoredByBrokerId: null as string | null,
    effectiveSiteId: "site-a",
    parentSiteId: null as string | null,
    rosterBrokerId: "broker-k",
    activePostSiteIds: new Set<string>(),
    monthlyTopSite: null as { siteId: string; ratio: number } | null,
  };

  it("唔係長工——直接回 null，caller 行返舊 fallback 鏈", () => {
    expect(resolveLongtermSettlement({ ...base, employmentType: "cash_casual" })).toBeNull();
  });

  it("簽證形式長工——永遠當贊助雞頭散更，唔理崗位盤", () => {
    const r = resolveLongtermSettlement({ ...base, visaSponsoredByBrokerId: "broker-visa", activePostSiteIds: new Set(["site-b"]) });
    expect(r).toEqual({ settlementBrokerId: "broker-visa", operationalBrokerId: "broker-visa", reason: "visa_sponsor", warning: null });
  });

  it("規則 1：呢更所在盤喺生效崗位盤入面——結算單位交返 caller 補 B07，operational 保留更表雞頭碼", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(["site-a"]) });
    expect(r).not.toBeNull();
    expect(r!.settlementBrokerId).toBeNull(); // caller 補 internalLongtermBrokerId
    expect(r!.operationalBrokerId).toBe("broker-k");
    expect(r!.reason).toBe("longterm_post");
    expect(r!.warning).toBeNull();
  });

  it("規則 1（母盤）：崗位登記喺母盤，呢更喺子盤——一樣算喺崗位盤", () => {
    const r = resolveLongtermSettlement({ ...base, effectiveSiteId: "site-child", parentSiteId: "site-a", activePostSiteIds: new Set(["site-a"]) });
    expect(r!.reason).toBe("longterm_post");
  });

  it("規則 2：有崗位但呢更唔喺崗位盤——跟更表雞頭碼幫雞頭頂散更，有 warning", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(["site-b"]) });
    expect(r).toEqual({
      settlementBrokerId: "broker-k",
      operationalBrokerId: "broker-k",
      reason: "longterm_non_post_broker",
      warning: "長工頂雞頭更：安員有登記崗位盤，但呢更唔喺崗位盤，跟更表雞頭碼幫雞頭頂散更",
    });
  });

  it("規則 2 邊緣情況：有崗位但唔喺呢個盤，而且冇雞頭碼欄——settlement/operational 都係 null（caller 跌返舊 fallback 鏈）", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(["site-b"]), rosterBrokerId: null });
    expect(r!.settlementBrokerId).toBeNull();
    expect(r!.operationalBrokerId).toBeNull();
    expect(r!.reason).toBe("longterm_non_post_broker");
  });

  it("規則 3：冇任何崗位記錄，本月占比 ≥50% 命中呢個盤——當崗位盤（B07），warning 提示已自動建立", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(), monthlyTopSite: { siteId: "site-a", ratio: 0.75 } });
    expect(r!.settlementBrokerId).toBeNull();
    expect(r!.operationalBrokerId).toBe("broker-k");
    expect(r!.reason).toBe("longterm_inferred_post");
    expect(r!.inferredPostSiteId).toBe("site-a");
    expect(r!.inferredPostRatio).toBe(0.75);
    expect(r!.warning).toContain("已自動建立崗位記錄");
  });

  it("規則 3：冇任何崗位記錄，占比 ≥50% 但命中另一個盤——呢更跟更表雞頭碼", () => {
    const r = resolveLongtermSettlement({ ...base, effectiveSiteId: "site-a", activePostSiteIds: new Set(), monthlyTopSite: { siteId: "site-z", ratio: 0.9 } });
    expect(r!.reason).toBe("longterm_inferred_post");
    expect(r!.warning).toContain("推算為另一個盤");
  });

  it("規則 3（保守預設）：推算唔到（占比 <50% 或者冇資料）——保守全部當長工更 B07，唔畀雞頭錢", () => {
    const r1 = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(), monthlyTopSite: { siteId: "site-a", ratio: 0.4 } });
    expect(r1!.reason).toBe("longterm_dispersed_b07");
    expect(r1!.settlementBrokerId).toBeNull(); // caller 補 B07
    const r2 = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(), monthlyTopSite: null });
    expect(r2!.reason).toBe("longterm_dispersed_b07");
  });

  it("驗收（Opus 5.5）：本月有 Postorder（權威）、冇任何（非推算）崗位——唔推算，跟更表雞頭碼頂散更（就算占比 ≥50%）", () => {
    const r = resolveLongtermSettlement({ ...base, monthlyTopSite: { siteId: "site-a", ratio: 1 }, postorderAuthoritative: true });
    expect(r?.reason).toBe("longterm_no_post_postorder");
    expect(r?.settlementBrokerId).toBe("broker-k");
    expect(r?.operationalBrokerId).toBe("broker-k");
    expect(r?.inferredPostSiteId).toBeUndefined();
  });

  it("驗收（Opus 5.5）：Postorder 權威但更表冇雞頭碼——settlement null（caller 跌返舊 fallback 鏈）", () => {
    const r = resolveLongtermSettlement({ ...base, rosterBrokerId: null, postorderAuthoritative: true });
    expect(r?.reason).toBe("longterm_no_post_postorder");
    expect(r?.settlementBrokerId).toBeNull();
  });

  it("驗收（Opus 5.5）：Postorder 權威、有崗位喺呢個盤——照舊 B07", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(["site-a"]), postorderAuthoritative: true });
    expect(r?.reason).toBe("longterm_post");
  });

  it("恰好 50% 算過咗（>=）", () => {
    const r = resolveLongtermSettlement({ ...base, activePostSiteIds: new Set(), monthlyTopSite: { siteId: "site-a", ratio: 0.5 } });
    expect(r!.reason).toBe("longterm_inferred_post");
  });
});

describe("longterm-settlement DB helpers", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function makeBroker(code: string, kind: "broker" | "internal_longterm" = "broker", status: "active" | "inactive" = "active") {
    return prisma.broker.create({ data: { code, name: `測試${code}`, kind, settlementType: kind === "internal_longterm" ? "salary" : "cash", status, createdBy: "test:longterm-settlement" } });
  }
  async function makeSite(name: string, parentSiteId: string | null = null) {
    return prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", billingModel: "per_shift", parentSiteId, createdBy: "test:longterm-settlement" } });
  }
  async function makeGuard(employmentType: "cash_casual" | "longterm_autopay" = "longterm_autopay") {
    return prisma.guard.create({ data: { nameZh: "測試安員", employmentType, createdBy: "test:longterm-settlement" } });
  }

  it("findInternalLongtermBrokerId：唔存在就 null；有就揀 active、code 最細嗰個", async () => {
    expect(await findInternalLongtermBrokerId(prisma)).toBeNull();
    await makeBroker("B99", "internal_longterm", "inactive");
    expect(await findInternalLongtermBrokerId(prisma)).toBeNull(); // inactive 唔計
    const active = await makeBroker("B07", "internal_longterm", "active");
    expect(await findInternalLongtermBrokerId(prisma)).toBe(active.id);
  });

  it("loadActiveLongtermPosts：只計未作廢、生效日期覆蓋 asOf 嘅記錄", async () => {
    const site = await makeSite("測試盤A");
    const guard = await makeGuard();
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-07-01"), effectiveTo: null, source: "manual", createdBy: "test" } });
    const voidedSite = await makeSite("已作廢盤");
    const voided = await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: voidedSite.id, effectiveFrom: new Date("2026-07-01"), source: "manual", createdBy: "test" } });
    await prisma.guardLongtermPost.update({ where: { id: voided.id }, data: { voidedAt: new Date() } });
    const expiredSite = await makeSite("已過期盤");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: expiredSite.id, effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-02-28"), source: "manual", createdBy: "test" } });

    const map = await loadActiveLongtermPosts([guard.id], new Date("2026-08-15"), prisma);
    expect([...(map.get(guard.id) ?? [])]).toEqual([site.id]);
  });

  it("驗收（Opus 5.5）：loadActiveLongtermPosts——崗位喺構造盤（activity_proxy_site_id）就連 proxy 盤都算；excludeInferred（Postorder 生效）淨係計 manual，唔計 inferred／july_backfill", async () => {
    const real = await makeSite("實際記更盤");
    const billing = await prisma.site.create({ data: { canonicalName: "構造月費盤", clientName: "測試客戶", billingModel: "per_shift", activityProxySiteId: real.id, createdBy: "test" } });
    const guard = await makeGuard();
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: billing.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const other = await makeSite("推算盤");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: other.id, effectiveFrom: new Date("2026-08-01"), source: "inferred", createdBy: "test" } });
    const julySite = await makeSite("七月反推盤");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: julySite.id, effectiveFrom: new Date("2026-07-01"), source: "july_backfill", createdBy: "test" } });

    const all = await loadActiveLongtermPosts([guard.id], new Date("2026-08-15"), prisma);
    expect([...(all.get(guard.id) ?? [])].sort()).toEqual([billing.id, real.id, other.id, julySite.id].sort());
    const noInferred = await loadActiveLongtermPosts([guard.id], new Date("2026-08-15"), prisma, { excludeInferred: true });
    expect([...(noInferred.get(guard.id) ?? [])].sort()).toEqual([billing.id, real.id].sort());
  });

  it("inferGuardMonthlyTopSite：跨多張上載計占比，摺埋母盤", async () => {
    const parentSite = await makeSite("母盤");
    const childSite = await makeSite("子盤", parentSite.id);
    const otherSite = await makeSite("另一個盤");
    const guard = await makeGuard();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const uploader = await prisma.user.create({ data: { name: "測試上載人", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });

    async function makeUpload(siteId: string) {
      return prisma.rosterUpload.create({
        data: {
          month: new Date("2026-08-01"),
          siteId,
          siteNameRaw: "test",
          uploaderUserId: uploader.id,
          fileName: "test.xlsx",
          fileSha256: `sha-${siteId}-${Math.random()}`,
          fileBytes: Buffer.from("x"),
          fileSize: 1,
        },
      });
    }
    async function makeRow(uploadId: string, resolvedSiteId: string | null, day: number) {
      return prisma.rosterUploadRow.create({
        data: {
          uploadId,
          rowIndex: day,
          workDate: new Date(`2026-08-${String(day).padStart(2, "0")}`),
          rawCode: "N",
          codeKind: "shift",
          resolvedSiteId,
          guardId: guard.id,
        },
      });
    }

    const parentUpload = await makeUpload(parentSite.id);
    const childUpload = await makeUpload(childSite.id);
    const otherUpload = await makeUpload(otherSite.id);
    // 母盤 3 行（resolvedSiteId null，跌返 upload.siteId=parentSite）＋
    // 子盤 2 行（resolvedSiteId=childSite）＝摺埋做母盤 5 行；另一個盤 3
    // 行——5/8=62.5% ≥50%，命中母盤。
    for (let d = 1; d <= 3; d++) await makeRow(parentUpload.id, null, d);
    for (let d = 4; d <= 5; d++) await makeRow(childUpload.id, childSite.id, d);
    for (let d = 6; d <= 8; d++) await makeRow(otherUpload.id, otherSite.id, d);

    const result = await inferGuardMonthlyTopSite([guard.id], new Date("2026-08-01"), prisma);
    const top = result.get(guard.id);
    expect(top?.siteId).toBe(parentSite.id);
    expect(top?.ratio).toBeCloseTo(5 / 8, 5);
  });
});

// ---------------------------------------------------------------------------
// WP-REFERRAL-FALLBACK（老闆 2026-09-26 緊急）：正式站淨係得 CSV Postorder
// （冇公式，`set_referral` 計唔到），`inferReferralBrokerFromRosters()`
// 唔靠 Postorder，淨係睇更表本身嘅雞頭碼推算供應（＝介紹）雞頭。
// ---------------------------------------------------------------------------
describe("inferReferralBrokerFromRosters", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function makeBroker(code: string, kind: "broker" | "internal_cash" | "internal_longterm" = "broker") {
    return prisma.broker.create({ data: { code, name: `測試${code}`, kind, settlementType: kind === "broker" ? "cash" : "salary", createdBy: "test:referral-fallback" } });
  }
  async function makeSite(name: string) {
    return prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:referral-fallback" } });
  }
  async function makeGuard() {
    return prisma.guard.create({ data: { nameZh: "測試長工", employmentType: "longterm_autopay", createdBy: "test:referral-fallback" } });
  }
  async function makeUploader() {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    return prisma.user.create({ data: { name: "測試上載人", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
  }
  async function makeUpload(uploaderId: string, siteId: string, status: "uploaded" | "parsed" | "confirmed" | "superseded" | "voided" = "parsed") {
    return prisma.rosterUpload.create({
      data: {
        month: new Date("2026-08-01"),
        siteId,
        siteNameRaw: "test",
        uploaderUserId: uploaderId,
        fileName: "test.xlsx",
        fileSha256: `sha-${siteId}-${Math.random()}`,
        fileBytes: Buffer.from("x"),
        fileSize: 1,
        status,
      },
    });
  }
  async function makeRow(opts: { uploadId: string; guardId: string | null; resolvedSiteId: string | null; day: number; settlementBrokerId?: string | null; codeKind?: "shift" | "ot" | "leave" }) {
    return prisma.rosterUploadRow.create({
      data: {
        uploadId: opts.uploadId,
        rowIndex: opts.day,
        workDate: new Date(`2026-08-${String(opts.day).padStart(2, "0")}`),
        rawCode: "N",
        codeKind: opts.codeKind ?? "shift",
        resolvedSiteId: opts.resolvedSiteId,
        guardId: opts.guardId,
        settlementBrokerId: opts.settlementBrokerId ?? null,
      },
    });
  }

  it("冇生效崗位盤——計唔到，唔設，冇 warning", async () => {
    const guard = await makeGuard();
    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull();
    expect(r.warning).toBeNull();
  });

  it("自己崗位盤更表雞頭碼唯一——用佢", async () => {
    const site = await makeSite("測試盤A");
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerK.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerK.id);
    expect(r.warning).toBeNull();
  });

  it("多個雞頭碼但最多嗰個 ≥70%——用最多嗰個", async () => {
    const site = await makeSite("測試盤B");
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    const brokerW = await makeBroker("W");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 8; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerK.id });
    for (let d = 9; d <= 10; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerW.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerK.id); // 8/10=80% ≥70%
    expect(r.warning).toBeNull();
  });

  it("雞頭碼分散、最多嗰個 <70%——唔設，有 warning", async () => {
    const site = await makeSite("測試盤C");
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    const brokerW = await makeBroker("W");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerK.id });
    for (let d = 6; d <= 10; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerW.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull(); // 5/10=50% <70%
    expect(r.warning).not.toBeNull();
  });

  it("WP-BOSS5 §25.2：更表雞頭碼唯一但係內部現金結算單位（Y）——唔可以做介紹雞頭，唔設，有 warning", async () => {
    const site = await makeSite("測試盤Y1");
    const guard = await makeGuard();
    const brokerY = await makeBroker("Y", "internal_cash");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerY.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull();
    expect(r.reason).toMatch(/內部結算單位/);
    expect(r.warning).not.toBeNull();
  });

  it("冇雞頭碼欄——跌返 broker_site_assignments 該盤唯一雞頭", async () => {
    const site = await makeSite("測試盤D");
    const guard = await makeGuard();
    const brokerT = await makeBroker("T");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: null });
    await prisma.brokerSiteAssignment.create({ data: { brokerId: brokerT.id, siteId: site.id, month: new Date("2026-08-01"), createdBy: "test" } });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerT.id);
    expect(r.warning).toBeNull();
  });

  it("WP-BOSS5 §25.2：冇雞頭碼欄、broker_site_assignments 揀到係 B07（internal_longterm）——唔可以做介紹雞頭，唔設，有 warning", async () => {
    const site = await makeSite("測試盤D-B07");
    const guard = await makeGuard();
    const brokerB07 = await makeBroker("B07", "internal_longterm");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: null });
    await prisma.brokerSiteAssignment.create({ data: { brokerId: brokerB07.id, siteId: site.id, month: new Date("2026-08-01"), createdBy: "test" } });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull();
    expect(r.reason).toMatch(/內部結算單位/);
    expect(r.warning).not.toBeNull();
  });

  it("冇雞頭碼欄、冇 broker_site_assignments——跌返該盤其他安員 shift 行唯一雞頭", async () => {
    const site = await makeSite("測試盤E");
    const guard = await makeGuard();
    const otherGuard = await makeGuard();
    const brokerG = await makeBroker("G");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 3; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: null });
    for (let d = 4; d <= 6; d++) await makeRow({ uploadId: upload.id, guardId: otherGuard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerG.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerG.id);
    expect(r.warning).toBeNull();
  });

  it("WP-BOSS5 §25.2：冇雞頭碼欄、冇 broker_site_assignments，跌返該盤其他安員 shift 行揀到 Y（internal_cash）——唔可以做介紹雞頭，唔設，有 warning", async () => {
    const site = await makeSite("測試盤E-Y");
    const guard = await makeGuard();
    const otherGuard = await makeGuard();
    const brokerY = await makeBroker("Y", "internal_cash");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 3; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: null });
    for (let d = 4; d <= 6; d++) await makeRow({ uploadId: upload.id, guardId: otherGuard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerY.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull();
    expect(r.reason).toMatch(/內部結算單位/);
    expect(r.warning).not.toBeNull();
  });

  it("乜都對唔到——唔設，有 warning", async () => {
    const site = await makeSite("測試盤F");
    const guard = await makeGuard();
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 3; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: null });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull();
    expect(r.warning).not.toBeNull();
  });

  it("摺母盤：post 登記喺母盤，roster 行寫子盤——一樣計落去", async () => {
    const parentSite = await makeSite("母盤X");
    const childSite = await prisma.site.create({ data: { canonicalName: "子盤X", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parentSite.id, createdBy: "test" } });
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: parentSite.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, childSite.id);
    for (let d = 1; d <= 4; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: childSite.id, day: d, settlementBrokerId: brokerK.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerK.id);
  });

  it("code_kind=ot／leave 唔計（淨係 shift）", async () => {
    const site = await makeSite("測試盤G");
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    const brokerW = await makeBroker("W");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const upload = await makeUpload(uploader.id, site.id);
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerK.id });
    // OT 行寫住另一個雞頭碼——唔應該撈亂 shift 行嘅推算（淨係計 shift）。
    await makeRow({ uploadId: upload.id, guardId: guard.id, resolvedSiteId: site.id, day: 6, settlementBrokerId: brokerW.id, codeKind: "ot" });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBe(brokerK.id);
  });

  it("superseded／voided 上載唔計（唔係 active）", async () => {
    const site = await makeSite("測試盤H");
    const guard = await makeGuard();
    const brokerK = await makeBroker("K");
    await prisma.guardLongtermPost.create({ data: { guardId: guard.id, siteId: site.id, effectiveFrom: new Date("2026-08-01"), source: "manual", createdBy: "test" } });
    const uploader = await makeUploader();
    const voidedUpload = await makeUpload(uploader.id, site.id, "voided");
    for (let d = 1; d <= 5; d++) await makeRow({ uploadId: voidedUpload.id, guardId: guard.id, resolvedSiteId: site.id, day: d, settlementBrokerId: brokerK.id });

    const r = await inferReferralBrokerFromRosters(guard.id, new Date("2026-08-01"), prisma);
    expect(r.brokerId).toBeNull(); // voided 上載嘅行唔計——冇 active 更表 shift 行
  });
});
