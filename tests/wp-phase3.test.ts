// WP-PHASE3（§20.4 Phase 3，老闆 2026-09-27 指令）：長工／價卡日常維護
// 做入系統——保安員抽屜「長工」區、「轉長工」一步動作、價目卡「複製上月
// 卡到本月」。
//
// §1 guard_longterm_posts CRUD（GET/POST/PATCH）＋RBAC（老闆／主管可
//    寫，雞頭硬性 403，會計出廠冇「保安員:update」403）
// §2 guards PATCH referral_broker_id／visa_sponsored_by_broker_id——寫入
//    ／清空／雞頭結構性睇唔到
// §3 POST /api/guards/:id/convert-to-longterm——一步轉長工（employment_
//    type＋崗位盤＋介紹雞頭＋合約），冇「長工糧」權限降級（唔擋，只警告）
// §4 POST /api/rate-cards/copy-last-month——複製上月卡到本月：預覽／
//    確認／冪等／排除規則（special／guard 級／LINK 盤／已有本月卡）
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as postsList, POST as postsCreate } from "@/app/api/guards/[id]/longterm-posts/route";
import { PATCH as postsUpdate } from "@/app/api/guards/[id]/longterm-posts/[postId]/route";
import { POST as convertToLongterm } from "@/app/api/guards/[id]/convert-to-longterm/route";
import { PATCH as guardUpdate, GET as guardDetail } from "@/app/api/guards/[id]/route";
import { POST as copyLastMonth } from "@/app/api/rate-cards/copy-last-month/route";
import type { Prisma } from "@prisma/client";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-PHASE3 §1：guard_longterm_posts CRUD + RBAC", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("老闆 POST 新增崗位盤 → 201，GET 見到；PATCH 終止（effective_to）", async () => {
    const created = await postsCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, ownerCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; site_id: string };
    expect(createdBody.site_id).toBe(fx.site.id);

    const list = await postsList(req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{ id: string; effective_to: string | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.effective_to).toBeNull();

    const patched = await postsUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts/${createdBody.id}`, ownerCookie, "PATCH", { effective_to: "2026-08-31" }),
      { params: Promise.resolve({ id: fx.guardA.id, postId: createdBody.id }) },
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { effective_to: string | null };
    expect(patchedBody.effective_to).toBe("2026-08-31T00:00:00.000Z");

    const audits = await prisma.auditLog.findMany({ where: { tableName: "guard_longterm_posts", rowId: createdBody.id } });
    expect(audits.some((a) => a.action === "create")).toBe(true);
    expect(audits.some((a) => a.action === "update")).toBe(true);
  });

  it("主管出廠有「保安員:update」→ POST 一樣 201", async () => {
    const res = await postsCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, supervisorCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
  });

  it("會計出廠冇「保安員:update」（off）→ POST 403", async () => {
    const res = await postsCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, accountantCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("雞頭 POST/PATCH 一律 403（硬性，唔靠矩陣個 cell）", async () => {
    const res = await postsCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, brokerCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("盤唔存在 → 404", async () => {
    const res = await postsCreate(
      req(`http://test.local/api/guards/${fx.guardA.id}/longterm-posts`, ownerCookie, "POST", { site_id: "00000000-0000-0000-0000-000000000000", effective_from: "2026-08-01" }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("WP-PHASE3 §2：guards PATCH referral_broker_id／visa_sponsored_by_broker_id", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("老闆 PATCH 設定＋GET 見到；再 PATCH null 清空", async () => {
    const patched = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { referral_broker_id: fx.brokerA.id, visa_sponsored_by_broker_id: fx.brokerB.id }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(patched.status).toBe(200);
    const detail = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    const body = (await detail.json()) as { referral_broker_id: string | null; visa_sponsored_by_broker_id: string | null };
    expect(body.referral_broker_id).toBe(fx.brokerA.id);
    expect(body.visa_sponsored_by_broker_id).toBe(fx.brokerB.id);

    const cleared = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { referral_broker_id: null }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(cleared.status).toBe(200);
    const detail2 = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    const body2 = (await detail2.json()) as { referral_broker_id: string | null; visa_sponsored_by_broker_id: string | null };
    expect(body2.referral_broker_id).toBeNull();
    expect(body2.visa_sponsored_by_broker_id).toBe(fx.brokerB.id); // 冇夾落 body 嘅欄唔變

    // 結構性：呢兩個 key 唔會喺 wire 用 undefined 表達「清空」——一定
    // 明確存返 null（`toGuardFullDTO()` 白名單 pass-through）。
    expect(Object.prototype.hasOwnProperty.call(body2, "referral_broker_id")).toBe(true);
  });

  it("雞頭讀自己保安員——結構性見唔到呢兩欄（GUARD_BROKER_FIELDS 冇加）", async () => {
    await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, await sessionCookieForUser(fx.userIds["老闆"]), "PATCH", { referral_broker_id: fx.brokerA.id }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const detail = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, brokerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Record<string, unknown>;
    expect("referral_broker_id" in body).toBe(false);
    expect("visa_sponsored_by_broker_id" in body).toBe(false);
  });
});

describe("WP-PHASE3 §3：POST /api/guards/:id/convert-to-longterm", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let brokerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("老闆一步轉長工：employment_type／崗位盤／介紹雞頭／合約一次過建", async () => {
    const res = await convertToLongterm(
      req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, ownerCookie, "POST", {
        site_id: fx.site.id,
        effective_from: "2026-08-01",
        referral_broker_id: fx.brokerA.id,
        monthly_salary: 18000,
      }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { guard: { employment_type: string }; longterm_post: { site_id: string }; contract: { monthly_salary: string } | null; warning: string | null };
    expect(body.guard.employment_type).toBe("longterm_autopay");
    expect(body.longterm_post.site_id).toBe(fx.site.id);
    expect(body.contract).not.toBeNull();
    expect(Number(body.contract!.monthly_salary)).toBe(18000);
    expect(body.warning).toBeNull();

    const guardRow = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guardRow.employmentType).toBe("longterm_autopay");
    expect(guardRow.referralBrokerId).toBe(fx.brokerA.id);
    const posts = await prisma.guardLongtermPost.findMany({ where: { guardId: fx.guardA.id } });
    expect(posts.length).toBe(1);
    const contracts = await prisma.guardLongtermContract.findMany({ where: { guardId: fx.guardA.id } });
    expect(contracts.length).toBe(1);
  });

  it("主管冇「長工糧」權限（硬性拒）：employment_type／崗位盤建到，合約 null + warning，唔擋成個動作", async () => {
    const res = await convertToLongterm(
      req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, supervisorCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01", monthly_salary: 18000 }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { contract: unknown; warning: string | null };
    expect(body.contract).toBeNull();
    expect(body.warning).toContain("長工糧");

    const guardRow = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
    expect(guardRow.employmentType).toBe("longterm_autopay");
    const contracts = await prisma.guardLongtermContract.findMany({ where: { guardId: fx.guardA.id } });
    expect(contracts.length).toBe(0);
  });

  it("冪等：同一個盤再轉一次唔會重複建崗位盤（沿用生效嗰條）", async () => {
    await convertToLongterm(req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, ownerCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    const res2 = await convertToLongterm(req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, ownerCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-15" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { post_reused: boolean };
    expect(body2.post_reused).toBe(true);
    const posts = await prisma.guardLongtermPost.findMany({ where: { guardId: fx.guardA.id } });
    expect(posts.length).toBe(1);
  });

  it("雞頭 403（硬性——唔可以轉長工）", async () => {
    const res = await convertToLongterm(req(`http://test.local/api/guards/${fx.guardA.id}/convert-to-longterm`, brokerCookie, "POST", { site_id: fx.site.id, effective_from: "2026-08-01" }), {
      params: Promise.resolve({ id: fx.guardA.id }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WP-PHASE3 §4：POST /api/rate-cards/copy-last-month", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  const AUG_END = new Date(Date.UTC(2026, 7, 31));
  const AUG_START = new Date(Date.UTC(2026, 7, 1));

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  async function seedCard(siteName: string, extra: Partial<Prisma.RateCardUncheckedCreateInput> = {}, siteExtra: Partial<Prisma.SiteUncheckedCreateInput> = {}) {
    const site = await prisma.site.create({ data: { canonicalName: siteName, clientName: siteName, billingModel: "per_shift", createdBy: "test", ...siteExtra } });
    const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
    const card = await prisma.rateCard.create({
      data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, effectiveFrom: AUG_START, effectiveTo: AUG_END, createdBy: "test", ...extra },
    });
    return { site, shiftType, card };
  }

  it("預覽：搵到上月生效逐更卡候選，dry_run 唔寫 DB", async () => {
    const { site } = await seedCard("複製測試盤A");
    const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; candidates: Array<{ site_id: string; client_rate: string | null }> };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.candidates.some((c) => c.site_id === site.id && c.client_rate === "900")).toBe(true);
    const cardCount = await prisma.rateCard.count({ where: { siteId: site.id } });
    expect(cardCount).toBe(1); // 未寫入
  });

  it("包含雞頭專屬價（唔止通用卡）——同 one-click 嘅 findCarryoverCard() 唔同", async () => {
    const { site } = await seedCard("複製測試盤雞頭專屬", { brokerId: fx.brokerA.id });
    const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: true, site_id: site.id }));
    const body = (await res.json()) as { count: number; candidates: Array<{ broker_id: string | null }> };
    expect(body.count).toBe(1);
    expect(body.candidates[0]!.broker_id).toBe(fx.brokerA.id);
  });

  it("排除：guard 級／special／月費／LINK 盤", async () => {
    await seedCard("複製排除-guard級", { guardId: fx.guardA.id });
    await seedCard("複製排除-special", { billingModel: "special" });
    await seedCard("複製排除-月費", { billingModel: "monthly_fixed" });
    await seedCard("複製排除-LINK盤", {}, { guardsPaidByClient: true });
    const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: true }));
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  it("排除：本月已經有卡（同一 site/shiftType/broker 組合）", async () => {
    const { site, shiftType } = await seedCard("複製排除-已有本月卡");
    await prisma.rateCard.create({
      data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 950, guardWage: 620, effectiveFrom: new Date(Date.UTC(2026, 8, 1)), createdBy: "test" },
    });
    const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: true, site_id: site.id }));
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(0);
  });

  it("確認建卡：note「由上月複製」，effective_from=本月 1 日；連撳兩次第二次 0 候選（冪等）", async () => {
    const { site, shiftType } = await seedCard("複製確認盤");
    const res = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: false, site_id: site.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created_count: number };
    expect(body.created_count).toBe(1);
    const newCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, shiftTypeId: shiftType.id, effectiveFrom: new Date(Date.UTC(2026, 8, 1)) } });
    expect(newCard).not.toBeNull();
    expect(newCard?.note).toContain("由上月複製");
    expect(newCard?.source).toBe("copy_last_month");
    expect(Number(newCard?.clientRate)).toBe(900);

    const audits = await prisma.auditLog.findMany({ where: { tableName: "rate_cards", rowId: newCard!.id, action: "create" } });
    expect(audits.length).toBe(1);
    const summaryAudit = await prisma.auditLog.findFirst({ where: { tableName: "rate_cards", rowId: "copy_last_month", action: "copy_last_month" }, orderBy: { createdAt: "desc" } });
    expect(summaryAudit).not.toBeNull();

    const res2 = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: false, site_id: site.id }));
    const body2 = (await res2.json()) as { created_count: number };
    expect(body2.created_count).toBe(0);
    const cardCount = await prisma.rateCard.count({ where: { siteId: site.id } });
    expect(cardCount).toBe(2); // 上月舊卡 + 新複製嗰張，唔會再重複建
  });

  it("本月已鎖定：confirm（dry_run:false）409，preview 唔受影響", async () => {
    const { site } = await seedCard("複製鎖月盤");
    await prisma.monthClose.create({ data: { month: new Date(Date.UTC(2026, 8, 1)), lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    const previewRes = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: true, site_id: site.id }));
    expect(previewRes.status).toBe(200);
    const confirmRes = await copyLastMonth(req("http://test.local/api/rate-cards/copy-last-month", ownerCookie, "POST", { month: "2026-09", dry_run: false, site_id: site.id }));
    expect(confirmRes.status).toBe(409);
    const cardCount = await prisma.rateCard.count({ where: { siteId: site.id } });
    expect(cardCount).toBe(1); // 未寫入新卡
  });
});
