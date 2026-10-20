// SITE-SCHEME-1：盤工號體系預設建議（純函數）＋ API（權限／冪等／只寫未設定）＋ 套用後對更次補推導工號歸屬（只填空位）。假資料。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { proposeStaffScheme } from "@/lib/sites/staff-scheme-prefill";
import { GET as prefillGet, POST as prefillPost } from "@/app/api/sites/staff-scheme-prefill/route";

const base = { canonicalName: "測試某某盤", clientName: "測試客戶", clientGroup: null, aliases: [] as string[] };

describe("proposeStaffScheme（純函數）", () => {
  it("Wilson／威信（大小寫、全半形唔分）喺客戶名／客戶組／盤名／別名任何一個 → U；否則 MP", () => {
    expect(proposeStaffScheme({ ...base, clientName: "Wilson Guard" })).toMatchObject({ scheme: "U", matchedField: "client_name" });
    expect(proposeStaffScheme({ ...base, clientName: "WILSON" })?.scheme).toBe("U");
    expect(proposeStaffScheme({ ...base, clientName: "ＷＩＬＳＯＮ 保安" })?.scheme).toBe("U"); // 全形
    expect(proposeStaffScheme({ ...base, clientName: "威信物業管理" })?.scheme).toBe("U");
    expect(proposeStaffScheme({ ...base, clientGroup: "Wilson Group" })).toMatchObject({ scheme: "U", matchedField: "client_group" });
    expect(proposeStaffScheme({ ...base, canonicalName: "威信 Wilson 大廈" })).toMatchObject({ scheme: "U", matchedField: "canonical_name" });
    expect(proposeStaffScheme({ ...base, aliases: ["甲盤", "wilson patrol"] })).toMatchObject({ scheme: "U", matchedField: "aliases" });
    const mp = proposeStaffScheme(base)!;
    expect(mp).toMatchObject({ scheme: "MP", matchedField: null });
    expect(mp.reason).toContain("MP");
  });
  it("LINK 盤（guards_paid_by_client）照客戶判：Wilson 旗下 → U，其他 → MP；已設 staff_scheme 嘅盤唔動（null）", () => {
    expect(proposeStaffScheme({ ...base, clientName: "Wilson Link", guardsPaidByClient: true })?.reason).toContain("LINK");
    expect(proposeStaffScheme({ ...base, clientName: "Wilson Link", guardsPaidByClient: true })?.scheme).toBe("U");
    expect(proposeStaffScheme({ ...base, guardsPaidByClient: true })?.scheme).toBe("MP");
    expect(proposeStaffScheme({ ...base, clientName: "Wilson", staffScheme: "MP" })).toBeNull();
    expect(proposeStaffScheme({ ...base, staffScheme: "U" })).toBeNull();
  });
});

describe("GET/POST /api/sites/staff-scheme-prefill", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.site.updateMany({ data: { staffScheme: "MP" } }); // fixture 盤先全部設好，下面逐個起未設定嘅
  });
  const get = (c: string) => prefillGet(new Request("http://test.local/api/sites/staff-scheme-prefill", { headers: { cookie: c } }));
  const post = (c: string, body: unknown) => prefillPost(new Request("http://test.local/api/sites/staff-scheme-prefill", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }));
  const mkSite = (name: string, client: string, over: Record<string, unknown> = {}) => prisma.site.create({ data: { canonicalName: name, clientName: client, billingModel: "per_shift", createdBy: "t", ...over } });

  it("權限：雞頭 403（GET／POST）；老闆 200；body 唔係 {apply:true} → 400", async () => {
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await get(broker)).status).toBe(403);
    expect((await post(broker, { apply: true })).status).toBe(403);
    expect((await get(cookie)).status).toBe(200);
    expect((await post(cookie, { apply: false })).status).toBe(400);
    expect((await post(cookie, {})).status).toBe(400);
    expect((await post(cookie, { apply: true, overrides: [{ site_id: "x", scheme: "MG" }] })).status).toBe(400);
  });

  it("GET 只列未設定（非 ended）嘅盤＋建議＋理由；POST 套用：只寫未設定、overrides 覆寫、已設定嘅盤唔郁、冪等、audit 一條 summary", async () => {
    const w = await mkSite("測試威信盤", "Wilson Guard");
    const o = await mkSite("測試其他盤", "測試客戶乙");
    const l = await mkSite("測試LINK盤", "wilson link", { guardsPaidByClient: true });
    const forced = await mkSite("測試改體系盤", "測試客戶丙");
    const ended = await mkSite("測試已結束盤", "Wilson Old", { status: "ended" });
    const setAlready = await mkSite("測試已設盤", "Wilson Set", { staffScheme: "MP" });
    const g = (await (await get(cookie)).json()) as { count: number; proposals: Array<{ site_id: string; proposed_scheme: string; reason: string }> };
    expect(g.proposals.map((p) => p.site_id).sort()).toEqual([w.id, o.id, l.id, forced.id].sort());
    expect(Object.fromEntries(g.proposals.map((p) => [p.site_id, p.proposed_scheme]))).toEqual({ [w.id]: "U", [o.id]: "MP", [l.id]: "U", [forced.id]: "MP" });
    const r = (await (await post(cookie, { apply: true, overrides: [{ site_id: forced.id, scheme: "U" }, { site_id: setAlready.id, scheme: "U" }] })).json()) as { applied: number; skipped_already_set: number; by_scheme: Array<{ scheme: string; count: number }> };
    expect(r).toMatchObject({ applied: 4, skipped_already_set: 1, by_scheme: [{ scheme: "U", count: 3 }, { scheme: "MP", count: 1 }] });
    const after = Object.fromEntries((await prisma.site.findMany({ where: { id: { in: [w.id, o.id, l.id, forced.id, ended.id, setAlready.id] } } })).map((s) => [s.id, s.staffScheme]));
    expect(after).toEqual({ [w.id]: "U", [o.id]: "MP", [l.id]: "U", [forced.id]: "U", [ended.id]: null, [setAlready.id]: "MP" });
    const again = (await (await post(cookie, { apply: true })).json()) as { applied: number; backfilled: number };
    expect(again).toMatchObject({ applied: 0, backfilled: 0 }); // 冪等
    expect((await prisma.site.findUniqueOrThrow({ where: { id: w.id } })).staffScheme).toBe("U");
    expect(await prisma.auditLog.count({ where: { action: "site_staff_scheme_prefill" } })).toBe(1); // 真係有寫入先有一條 summary（冇嘢可寫嘅重覆套用唔寫 audit）
  });

  it("套用後即刻補推導更次工號歸屬：只填空位（已有歸屬唔改）；未鎖月直接寫、已鎖月寫側表；冇法分（兩張冇日期 U 卡）唔推；再套用 0", async () => {
    const site = await mkSite("測試威信補推導盤", "Wilson Guard");
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    const mk = (n: string) => prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", createdBy: "t" } });
    const gOne = await mk("測試甲補");
    const gTwo = await mk("測試乙補"); // 兩張冇日期 U 卡 → ambiguous
    const cardU = await prisma.guardStaffNumber.create({ data: { guardId: gOne.id, scheme: "U", number: "U99981", status: "current" } });
    const cardMP = await prisma.guardStaffNumber.create({ data: { guardId: gOne.id, scheme: "MP", number: "MP99981", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: gTwo.id, scheme: "U", number: "U99982", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: gTwo.id, scheme: "U", number: "U99983", status: "former" } });
    const rec = (guardId: string, d: Date, extra: Record<string, unknown> = {}) =>
      prisma.shiftRecord.create({ data: { workDate: d, siteId: site.id, shiftTypeId: st.id, guardId, recordType: "shift", createdBy: "t", ...extra } });
    const open = await rec(gOne.id, new Date(Date.UTC(2026, 7, 5))); // 8 月（未鎖）空位
    const keep = await rec(gOne.id, new Date(Date.UTC(2026, 7, 6)), { staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "manual" }); // 已有歸屬
    const locked = await rec(gOne.id, new Date(Date.UTC(2026, 5, 10))); // 6 月（fixture 已鎖）
    const amb = await rec(gTwo.id, new Date(Date.UTC(2026, 7, 7)));
    const r = (await (await post(cookie, { apply: true })).json()) as { applied: number; backfilled: number; backfill: { written_direct: number; written_side_table: number; unresolved: number } };
    expect(r.applied).toBe(1);
    expect(r.backfill).toMatchObject({ written_direct: 1, written_side_table: 1, unresolved: 1 });
    expect(r.backfilled).toBe(2);
    const re = (id: string) => prisma.shiftRecord.findUniqueOrThrow({ where: { id }, include: { staffAttribution: true } });
    expect(await re(open.id)).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "backfill:sole" });
    expect(await re(keep.id)).toMatchObject({ staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "manual" }); // 唔改
    const lk = await re(locked.id);
    expect(lk.staffNumberId).toBeNull(); // 已鎖月：shift_records 本身一欄都唔寫
    expect(lk.staffAttribution).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U" });
    expect((await re(amb.id)).staffNumberId).toBeNull();
    // 再套用：冇未設定盤，補推導 0
    expect((await (await post(cookie, { apply: true })).json()) as { backfilled: number }).toMatchObject({ backfilled: 0 });
  });
});
