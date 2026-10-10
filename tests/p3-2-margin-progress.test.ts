// P3-2.2：首頁毛利卡拆月級 API——數字＝buildGrossMargin(month).totals；日級可唔帶毛利；
// 每次即時重計（資料一改，下一個 request 即反映，冇 cache）。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { buildGrossMargin } from "@/lib/reports/gross-margin";
import { GET as marginProgress } from "@/app/api/reports/margin-progress/route";
import { GET as shortfall } from "@/app/api/reports/shortfall/route";

const req = (url: string, cookie: string) => new Request(url, { headers: { cookie } });

describe("P3-2.2 margin-progress／日級 shortfall 拆分", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("margin-progress 數字＝buildGrossMargin(month).totals，且同舊 shortfall 內嵌 month_progress 一樣", async () => {
    const gm = await buildGrossMargin(new Date(Date.UTC(2026, 7, 1)));
    const res = await marginProgress(req("http://t/api/reports/margin-progress?month=2026-08", cookie));
    expect(res.status).toBe(200);
    const mp = await res.json();
    expect(mp.month).toBe("2026-08");
    expect(mp.revenue).toBe(gm.totals.revenue);
    expect(mp.cost).toBe(gm.totals.cost);
    expect(mp.profit).toBe(gm.totals.profit);
    expect(mp.margin_pct).toBe(gm.totals.marginPct);
    expect(mp.threshold_pct).toBe(gm.thresholdPct);
    expect(mp.below_threshold_site_count).toBe(gm.sites.filter((s) => s.belowThreshold).length);

    const old = (await (await shortfall(req("http://t/api/reports/shortfall?date=2026-08-15", cookie))).json());
    expect(old.month_progress).toEqual(mp);
  });

  it("include_margin=0：日級 shape 照舊但冇 month_progress", async () => {
    const full = (await (await shortfall(req("http://t/api/reports/shortfall?date=2026-08-01", cookie))).json());
    const day = (await (await shortfall(req("http://t/api/reports/shortfall?date=2026-08-01&include_margin=0", cookie))).json());
    expect("month_progress" in day).toBe(false);
    const rest: Record<string, unknown> = { ...full };
    delete rest.month_progress;
    expect(day).toEqual(rest);
  });

  it("冇 cache：改數據後下一個 request 即時反映", async () => {
    const r1 = (await (await marginProgress(req("http://t/api/reports/margin-progress?month=2026-08", cookie))).json());
    await prisma.shiftRecord.update({ where: { id: fx.shiftRecordA.id }, data: { clientRateSnapshot: 123456 } });
    const r2 = (await (await marginProgress(req("http://t/api/reports/margin-progress?month=2026-08", cookie))).json());
    expect(r2.revenue).not.toBe(r1.revenue);
    const gm = await buildGrossMargin(new Date(Date.UTC(2026, 7, 1)));
    expect(r2.revenue).toBe(gm.totals.revenue);
  });

  it("month 格式錯 → 400", async () => {
    const res = await marginProgress(req("http://t/api/reports/margin-progress?month=abc", cookie));
    expect(res.status).toBe(400);
  });
});
