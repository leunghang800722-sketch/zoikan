// WP-PHASE3 Opus 5.5 驗收修正回歸：
// §1 長工崗位盤：同一盤生效期重疊 409、終止日早過生效日 400
// §2 guards PATCH 介紹雞頭／簽證形式贊助雞頭：唔存在 400、B07 400、
//    舊值原樣送返唔擋
// §3 轉長工：連撳兩次唔會建兩份合約
// §4 複製上月卡：已作廢卡／早過上月底已完嘅卡唔複製
// §5 自動補價（reconcile-all）：OT 記錄補 null；子盤記錄都會補
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as postsCreate, GET as postsList } from "@/app/api/guards/[id]/longterm-posts/route";
import { PATCH as postsUpdate } from "@/app/api/guards/[id]/longterm-posts/[postId]/route";
import { POST as convertToLongterm } from "@/app/api/guards/[id]/convert-to-longterm/route";
import { PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { POST as copyLastMonth } from "@/app/api/rate-cards/copy-last-month/route";
import { repriceMonthForSites } from "@/lib/pricing/reprice";
import { runReconcileAllForMonth } from "@/lib/roster-upload/reconcile-all";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}
const aug = (d: number) => new Date(Date.UTC(2026, 7, d));

let fx: Wp2Fixture;
let owner: string;
beforeEach(async () => {
  await clearAll();
  fx = await seedWp2Fixture();
  owner = await sessionCookieForUser(fx.userIds["老闆"]);
});

async function createPost(body: Record<string, unknown>) {
  return postsCreate(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, owner, "POST", body), { params: Promise.resolve({ id: fx.guardA.id }) });
}

describe("§1 長工崗位盤期間檢查", () => {
  it("同一盤重疊 409；唔同盤可以；前一條終止之後可以再加", async () => {
    const first = await createPost({ site_id: fx.site.id, effective_from: "2026-08-01" });
    expect(first.status).toBe(201);
    expect((await createPost({ site_id: fx.site.id, effective_from: "2026-09-01" })).status).toBe(409);
    expect((await createPost({ site_id: fx.siteUnassigned.id, effective_from: "2026-09-01" })).status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;
    const term = await postsUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts/${firstId}`, owner, "PATCH", { effective_to: "2026-08-31" }), {
      params: Promise.resolve({ id: fx.guardA.id, postId: firstId }),
    });
    expect(term.status).toBe(200);
    expect((await createPost({ site_id: fx.site.id, effective_from: "2026-09-01" })).status).toBe(201);
    // 再將已終止嗰條清返 effective_to（延長到無限）會撞 9 月嗰條 → 409
    const reopen = await postsUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts/${firstId}`, owner, "PATCH", { effective_to: null }), {
      params: Promise.resolve({ id: fx.guardA.id, postId: firstId }),
    });
    expect(reopen.status).toBe(409);
  });

  it("雞頭連 GET 自己安員嘅崗位盤都 403（結構性見唔到）", async () => {
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const res = await postsList(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, brokerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    expect(res.status).toBe(403);
  });

  it("終止日早過生效日 400（POST 同 PATCH）", async () => {
    expect((await createPost({ site_id: fx.site.id, effective_from: "2026-10-01", effective_to: "2026-09-30" })).status).toBe(400);
    const created = await createPost({ site_id: fx.site.id, effective_from: "2026-10-01" });
    const id = ((await created.json()) as { id: string }).id;
    const res = await postsUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts/${id}`, owner, "PATCH", { effective_to: "2026-09-27" }), {
      params: Promise.resolve({ id: fx.guardA.id, postId: id }),
    });
    expect(res.status).toBe(400);
  });
});

describe("§2 guards PATCH 介紹雞頭驗證", () => {
  const patch = (body: unknown) => guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, owner, "PATCH", body), { params: Promise.resolve({ id: fx.guardA.id }) });

  it("唔存在嘅雞頭 400（唔再 FK 500）；B07 400；正常雞頭 200", async () => {
    expect((await patch({ referral_broker_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07", name: "測試長工單位", kind: "internal_longterm", settlementType: "autopay", isInternal: true, createdBy: "test" } });
    expect((await patch({ visa_sponsored_by_broker_id: b07.id })).status).toBe(400);
    expect((await patch({ referral_broker_id: fx.brokerA.id })).status).toBe(200);
  });

  it("舊值（就算係 B07）原樣送返唔擋——淨係改其他欄", async () => {
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07", name: "測試長工單位", kind: "internal_longterm", settlementType: "autopay", isInternal: true, createdBy: "test" } });
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { referralBrokerId: b07.id } });
    expect((await patch({ referral_broker_id: b07.id, name_aliases: [] })).status).toBe(200);
  });

  it("WP-BOSS5 §25.2：referral_broker_id＝內部現金結算單位（Y）400；同一個 broker 做 visa_sponsored_by_broker_id 維持現狀（200，老闆冇講）", async () => {
    const referralRes = await patch({ referral_broker_id: fx.brokerInternal.id });
    expect(referralRes.status).toBe(400);
    const body = (await referralRes.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/內部現金結算單位/);
    expect((await patch({ visa_sponsored_by_broker_id: fx.brokerInternal.id })).status).toBe(200);
  });
});

describe("§3 轉長工合約冪等", () => {
  it("連撳兩次：第二次唔建合約，回 warning", async () => {
    const call = () =>
      convertToLongterm(req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, owner, "POST", { site_id: fx.site.id, effective_from: "2026-10-01", monthly_salary: 18000 }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
    expect((await call()).status).toBe(201);
    const second = (await (await call()).json()) as { contract: unknown; warning: string | null };
    expect(second.contract).toBeNull();
    expect(second.warning).toContain("已經有長工合約");
    expect(await prisma.guardLongtermContract.count({ where: { guardId: fx.guardA.id } })).toBe(1);
  });
});

describe("§4 複製上月卡排除", () => {
  it("已作廢／早過上月底已完嘅卡唔係候選", async () => {
    const mk = async (name: string, extra: Record<string, unknown>) => {
      const site = await prisma.site.create({ data: { canonicalName: name, clientName: name, billingModel: "per_shift", createdBy: "test" } });
      const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, clientRate: 900, guardWage: 600, effectiveFrom: aug(1), effectiveTo: aug(31), createdBy: "test", ...extra } });
      return site;
    };
    const voided = await mk("複製排除-已作廢", { voidedAt: new Date() });
    const old = await mk("複製排除-7月已完", { effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 6, 31)) });
    for (const site of [voided, old]) {
      const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", owner, "POST", { month: "2026-09", site_id: site.id }));
      expect(((await res.json()) as { count: number }).count).toBe(0);
    }
  });
});

describe("§5 自動補價：OT／子盤", () => {
  it("OT 記錄 snapshot 全 null、之後先補 OT 卡 → repriceMonthForSites 補返（WP-BOSS5 §25.1：卡金額每小時价 × otHours=3）", async () => {
    const ot = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "OT3", createdBy: "test" } });
    const rec = await prisma.shiftRecord.create({
      data: { workDate: aug(5), siteId: fx.site.id, shiftTypeId: ot.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, recordType: "ot", otHours: 3, createdBy: "test" },
    });
    await prisma.rateCard.create({ data: { siteId: fx.site.id, shiftTypeId: ot.id, clientRate: 100, guardWage: 80, effectiveFrom: aug(1), createdBy: "test" } });
    const r = await repriceMonthForSites(aug(1), [fx.site.id], fx.userIds["老闆"], null);
    expect(r.changed).toBeGreaterThanOrEqual(1);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } });
    // 卡係「每小時价」100／80，呢條記錄 otHours=3 → snapshot＝300／240（呢
    // 條記錄嘅金額，唔再係每小時价）。
    expect(Number(after.clientRateSnapshot)).toBe(300);
    expect(Number(after.guardWageSnapshot)).toBe(240);
  });

  it("上載掛母盤、格歸子盤：子盤記錄都會補價", async () => {
    const child = await prisma.site.create({ data: { canonicalName: "測試子盤", clientName: "測試子盤", billingModel: "per_shift", parentSiteId: fx.site.id, createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: child.id, code: "D", createdBy: "test" } });
    await prisma.rateCard.create({ data: { siteId: child.id, shiftTypeId: st.id, clientRate: 820, guardWage: 730, effectiveFrom: aug(1), createdBy: "test" } });
    const rec = await prisma.shiftRecord.create({
      data: { workDate: aug(9), siteId: child.id, shiftTypeId: st.id, guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, operationalBrokerId: fx.brokerB.id, recordType: "shift", createdBy: "test" },
    });
    const up = await prisma.rosterUpload.create({
      data: { month: aug(1), siteId: fx.site.id, siteNameRaw: "測試母盤", uploaderUserId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
    });
    await prisma.rosterUploadRow.create({
      data: { uploadId: up.id, rowIndex: 1, workDate: aug(9), rawCode: "D", codeKind: "shift", shiftTypeId: st.id, resolvedSiteId: child.id, guardId: fx.guardB.id, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" },
    });
    await runReconcileAllForMonth(aug(1), fx.userIds["老闆"], null);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(Number(after.clientRateSnapshot)).toBe(820);
  });
});
