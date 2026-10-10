// Opus 對抗式驗收 C1：憑空開更＋guard嫁接防線。
// 1. 雞頭用外人 guard_id 開更 → 403，之後 GET 該 guard → 仍 404（唔會因為
//    嘗試開更就「解鎖」咗可見性）。
// 2. 雞頭喺自己冇份嘅盤（冇 broker_site_assignments）開更 → 403。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as shiftRecordCreate } from "@/app/api/shift-records/route";
import { GET as guardGetOne } from "@/app/api/guards/[id]/route";

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP2 C1：憑空開更＋guard嫁接防線", () => {
  let fx: Wp2Fixture;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("雞頭A 用 guardB（外人）嘅 guard_id 開更 → 403，唔會 201", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-10",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardB.id, // 外人——default_broker_id = brokerB，唔係 brokerA
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(403);

    // 冧唔到就真係冧唔到：DB 完全冇呢條更次
    const count = await prisma.shiftRecord.count({ where: { guardId: fx.guardB.id, workDate: new Date(Date.UTC(2026, 7, 10)) } });
    expect(count).toBe(0);
  });

  it("開更失敗之後，GET 果個外人 guard 仍然 404（冇因為嘗試開更而「解鎖」可見性）", async () => {
    await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-10",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardB.id,
        record_type: "shift",
      }),
    );
    const res = await guardGetOne(req(`http://test.local/api/guards/${fx.guardB.id}`, brokerACookie, "GET"), {
      params: Promise.resolve({ id: fx.guardB.id }),
    });
    expect(res.status).toBe(404);
  });

  it("雞頭A 喺自己冇份嘅盤（冇 broker_site_assignments）用自己保安員開更 → 403", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-10",
        site_id: fx.siteUnassigned.id, // 冇同 brokerA 有 broker_site_assignments
        shift_type_id: fx.shiftType.id, // 呢個 shift_type 掛喺 fx.site 底下，但驗證順序係先查 guard/site 歸屬，siteId 唔啱already 403
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(403);
    const count = await prisma.shiftRecord.count({ where: { siteId: fx.siteUnassigned.id } });
    expect(count).toBe(0);
  });

  it("雞頭A 用自己保安員、自己有份嘅盤開更 → 201 成功（對照組，確認前兩個 test 唔係全部都拒）", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-11",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
      }),
    );
    expect(res.status).toBe(201);
  });

  it("S1：雞頭幫自己保安員夾帶價錢欄（client_rate_snapshot）——strict schema 400 拒絕，唔係靜靜剝走", async () => {
    const res = await shiftRecordCreate(
      req("http://test.local/api/shift-records", brokerACookie, "POST", {
        work_date: "2026-08-12",
        site_id: fx.site.id,
        shift_type_id: fx.shiftType.id,
        guard_id: fx.guardA.id,
        record_type: "shift",
        client_rate_snapshot: 99999,
      }),
    );
    expect(res.status).toBe(400);
    const count = await prisma.shiftRecord.count({ where: { guardId: fx.guardA.id, workDate: new Date(Date.UTC(2026, 7, 12)) } });
    expect(count).toBe(0);
  });
});
