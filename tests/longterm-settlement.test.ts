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
