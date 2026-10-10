// WP-ROSTER-UPLOAD Phase B-1（B1-2）：`GET /api/roster-uploads/pending-summary`
// ——「通知會計」最簡單做法：逐盤列已上載（status=parsed）但仲有非
// match 項未有決定嘅數量。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as pendingSummary } from "@/app/api/roster-uploads/pending-summary/route";

function req(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

describe("WP-ROSTER-UPLOAD Phase B-1（B1-2）：pending-summary", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭 403", async () => {
    const res = await pendingSummary(req("http://test.local/api/roster-uploads/pending-summary?month=2026-08", brokerCookie));
    expect(res.status).toBe(403);
  });

  it("有 parsed 上載＋roster_only 行未處理 → entries 列出嚟", async () => {
    const upload = await prisma.rosterUpload.create({
      data: {
        month: fx.unlockedMonth,
        siteId: fx.site.id,
        siteNameRaw: fx.site.name,
        uploaderUserId: fx.userIds["老闆"]!,
        fileName: "pending-test.xlsx",
        fileSha256: "p".repeat(64),
        fileBytes: Buffer.from("x"),
        fileSize: 1,
        status: "parsed",
        createdBy: fx.userIds["老闆"]!,
      },
    });
    await prisma.rosterUploadRow.create({
      data: {
        uploadId: upload.id,
        rowIndex: 1,
        workDate: fx.unlockedMonth,
        rawCode: "N",
        codeKind: "shift",
        shiftTypeId: fx.shiftType.id,
        resolvedSiteId: fx.site.id,
        guardId: fx.guardA.id,
        guardMatch: "by_staff_no",
      },
    });

    const res = await pendingSummary(req(`http://test.local/api/roster-uploads/pending-summary?month=2026-08`, ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; entries: { site_id: string; pending_count: number }[] };
    expect(body.total).toBeGreaterThan(0);
    expect(body.entries.some((e) => e.site_id === fx.site.id && e.pending_count > 0)).toBe(true);

    // 驗收（Opus 5.5）：`months=0`＝所有月份——首頁卡喺 9 月都要見到 8 月未對完嘅上載。
    // P3-1.5：唔帶 month 預設只計本月＋上月（`months=2`），要睇全部月份用 `?months=0`（窗口行為見 tests/p3-1-pending-summary.test.ts）。
    const all = await pendingSummary(req(`http://test.local/api/roster-uploads/pending-summary?months=0`, ownerCookie));
    const allBody = (await all.json()) as { entries: { upload_id: string; month: string }[] };
    expect(allBody.entries.some((e) => e.upload_id === upload.id && e.month === "2026-08")).toBe(true);
    // 另一個月份篩走。
    const sep = await pendingSummary(req(`http://test.local/api/roster-uploads/pending-summary?month=2026-09`, ownerCookie));
    expect(((await sep.json()) as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("冇 parsed 上載 → entries 空", async () => {
    const res = await pendingSummary(req("http://test.local/api/roster-uploads/pending-summary?month=2026-08", ownerCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; entries: unknown[] };
    expect(body.total).toBe(0);
    expect(body.entries).toHaveLength(0);
  });
});
