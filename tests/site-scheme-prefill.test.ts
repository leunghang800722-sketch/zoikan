// SITE-SCHEME-1：盤工號體系預設建議（純函數）＋ API（權限／冪等／只寫未設定）＋ 套用後對更次補推導工號歸屬（只填空位）。假資料。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { proposeStaffScheme } from "@/lib/sites/staff-scheme-prefill";
import { GET as prefillGet, POST as prefillPost } from "@/app/api/sites/staff-scheme-prefill/route";
import { PATCH as sitePatch } from "@/app/api/sites/[id]/route";

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
  let extBroker: { id: string };
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.site.updateMany({ data: { staffScheme: "MP" } }); // fixture 盤先全部設好，下面逐個起未設定嘅
    extBroker = await prisma.broker.create({ data: { code: "T-EXT-PF", name: "測試客戶自己人", kind: "external", settlementType: "none", createdBy: "t" } });
  });
  const get = (c: string, qs = "") => prefillGet(new Request(`http://test.local/api/sites/staff-scheme-prefill${qs}`, { headers: { cookie: c } }));
  const post = (c: string, body: unknown) => prefillPost(new Request("http://test.local/api/sites/staff-scheme-prefill", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }));
  /** 起一個盤＋一個更別；withShift 預設落 1 更（結算單位 TEST-BA）。 */
  const mkSite = async (name: string, client: string, over: Record<string, unknown> = {}, shifts: Array<{ day: number; broker?: string | null }> = [{ day: 3 }]) => {
    const site = await prisma.site.create({ data: { canonicalName: name, clientName: client, billingModel: "per_shift", createdBy: "t", ...over } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
    const g = await prisma.guard.create({ data: { nameZh: `測試${name}`, employmentType: "cash_casual", createdBy: "t" } });
    for (const sh of shifts) await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, sh.day)), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: sh.broker === undefined ? fx.brokerA.id : sh.broker, recordType: "shift", createdBy: "t" } });
    return { site, st, guard: g };
  };

  it("權限：雞頭 403（GET／POST）；老闆 200；body 唔係 {apply:true} → 400", async () => {
    const broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await get(broker)).status).toBe(403);
    expect((await post(broker, { apply: true })).status).toBe(403);
    expect((await get(cookie)).status).toBe(200);
    expect((await post(cookie, { apply: false })).status).toBe(400);
    expect((await post(cookie, {})).status).toBe(400);
    expect((await post(cookie, { apply: true, overrides: [{ site_id: "x", scheme: "MG" }] })).status).toBe(400);
  });

  it("SITE-SCHEME-1.1：只對有更次嘅盤出建議；全部 external 結算嘅盤列喺 not_applicable；冇更次嘅盤唔列（no_shifts）；已設／ended 唔列", async () => {
    const w = await mkSite("測試威信盤", "Wilson Guard");
    const o = await mkSite("測試其他盤", "測試客戶乙");
    const l = await mkSite("測試LINK盤", "wilson link", { guardsPaidByClient: true });
    const ext = await mkSite("測試客戶自己人盤", "測試客戶外", {}, [{ day: 3, broker: extBroker.id }, { day: 4, broker: extBroker.id }]);
    const mixed = await mkSite("測試混合盤", "測試客戶混", {}, [{ day: 3, broker: extBroker.id }, { day: 4 }]);
    await prisma.site.create({ data: { canonicalName: "測試冇更盤", clientName: "Wilson X", billingModel: "per_shift", createdBy: "t" } });
    await mkSite("測試已結束盤", "Wilson Old", { status: "ended" });
    await mkSite("測試已設盤", "Wilson Set", { staffScheme: "MP" });
    const g = (await (await get(cookie)).json()) as { count: number; proposals: Array<{ site_id: string; proposed_scheme: string; shifts: number }>; not_applicable: Array<{ site_id: string; shifts: number }>; no_shifts: number };
    expect(Object.fromEntries(g.proposals.map((p) => [p.site_id, p.proposed_scheme]))).toEqual({ [w.site.id]: "U", [o.site.id]: "MP", [l.site.id]: "U", [mixed.site.id]: "MP" });
    expect(g.not_applicable).toEqual([expect.objectContaining({ site_id: ext.site.id, shifts: 2 })]);
    expect(g.no_shifts).toBe(1);
    // external 盤唔可套用（site_ids 指住佢亦唔寫）
    const r = (await (await post(cookie, { apply: true, site_ids: [ext.site.id] })).json()) as { applied: number; skipped_not_applicable: number };
    expect(r).toMatchObject({ applied: 0, skipped_not_applicable: 1, job_id: null });
    expect((await prisma.site.findUniqueOrThrow({ where: { id: ext.site.id } })).staffScheme).toBeNull();
  });

  it("POST：只套用已剔（site_ids）嘅 proposals、overrides 覆寫、已設定嘅盤唔郁；回 202＋job_id；冪等；audit summary", async () => {
    const w = await mkSite("測試威信盤", "Wilson Guard");
    const o = await mkSite("測試其他盤", "測試客戶乙");
    const forced = await mkSite("測試改體系盤", "測試客戶丙");
    const setAlready = await mkSite("測試已設盤", "Wilson Set", { staffScheme: "MP" });
    const res = await post(cookie, { apply: true, site_ids: [w.site.id, forced.site.id, setAlready.site.id], overrides: [{ site_id: forced.site.id, scheme: "U" }] });
    expect(res.status).toBe(202);
    const r = (await res.json()) as { applied: number; skipped_not_applicable: number; by_scheme: Array<{ scheme: string; count: number }>; job_id: string; status: string };
    expect(r).toMatchObject({ applied: 2, skipped_not_applicable: 1, by_scheme: [{ scheme: "U", count: 2 }, { scheme: "MP", count: 0 }] });
    expect(typeof r.job_id).toBe("string");
    const after = Object.fromEntries((await prisma.site.findMany({ where: { id: { in: [w.site.id, o.site.id, forced.site.id, setAlready.site.id] } } })).map((s) => [s.id, s.staffScheme]));
    expect(after).toEqual({ [w.site.id]: "U", [o.site.id]: null, [forced.site.id]: "U", [setAlready.site.id]: "MP" }); // 冇剔嘅 o 唔郁
    // 冇傳 site_ids＝全部 proposals（舊 client 相容）；之後再撳冇嘢可寫
    const rest = await post(cookie, { apply: true });
    expect(((await rest.json()) as { applied: number }).applied).toBe(1);
    const again = await post(cookie, { apply: true });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ applied: 0, job_id: null });
    expect(await prisma.auditLog.count({ where: { action: "site_staff_scheme_prefill" } })).toBe(2);
  });

  it("補推導背景 job（job_runs）：轉 running→ok，summary 帶 backfilled／unresolved；GET ?job= 輪詢；只填空位、鎖月寫側表、冇法分唔推", async () => {
    const { site, st, guard: gOne } = await mkSite("測試威信補推導盤", "Wilson Guard", {}, []);
    const gTwo = await prisma.guard.create({ data: { nameZh: "測試乙補", employmentType: "cash_casual", createdBy: "t" } });
    const cardU = await prisma.guardStaffNumber.create({ data: { guardId: gOne.id, scheme: "U", number: "U99981", status: "current" } });
    const cardMP = await prisma.guardStaffNumber.create({ data: { guardId: gOne.id, scheme: "MP", number: "MP99981", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: gTwo.id, scheme: "U", number: "U99982", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: gTwo.id, scheme: "U", number: "U99983", status: "former" } });
    const rec = (guardId: string, d: Date, extra: Record<string, unknown> = {}) => prisma.shiftRecord.create({ data: { workDate: d, siteId: site.id, shiftTypeId: st.id, guardId, settlementBrokerId: fx.brokerA.id, recordType: "shift", createdBy: "t", ...extra } });
    const open = await rec(gOne.id, new Date(Date.UTC(2026, 7, 5)));
    const keep = await rec(gOne.id, new Date(Date.UTC(2026, 7, 6)), { staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "manual" });
    const locked = await rec(gOne.id, new Date(Date.UTC(2026, 5, 10)));
    const amb = await rec(gTwo.id, new Date(Date.UTC(2026, 7, 7)));
    const res = await post(cookie, { apply: true, site_ids: [site.id] });
    expect(res.status).toBe(202);
    const r = (await res.json()) as { job_id: string; status: string; summary: { backfilled: number; written_direct: number; written_side_table: number; unresolved: number } };
    expect(r.status).toBe("ok"); // 測試冇 Next request context → 同步行完
    expect(r.summary).toMatchObject({ backfilled: 2, written_direct: 1, written_side_table: 1, unresolved: 1 });
    const job = (await (await get(cookie, `?job=${r.job_id}`)).json()) as { job: { status: string; summary: { unresolved: number } } };
    expect(job.job).toMatchObject({ status: "ok", summary: { unresolved: 1 } });
    expect((await get(cookie, "?job=nope")).status).toBe(404);
    const re = (id: string) => prisma.shiftRecord.findUniqueOrThrow({ where: { id }, include: { staffAttribution: true } });
    expect(await re(open.id)).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "backfill:sole" });
    expect(await re(keep.id)).toMatchObject({ staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "manual" });
    const lk = await re(locked.id);
    expect(lk.staffNumberId).toBeNull();
    expect(lk.staffAttribution).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U" });
    expect((await re(amb.id)).staffNumberId).toBeNull();
  });

  it("改體系後重推導（PATCH /api/sites/:id）：未鎖月自動推導歸屬清走再按新體系重推；手動歸屬／已鎖月（含側表）唔郁；寫 audit；回 reinfer.job_id", async () => {
    const { site, st, guard: g } = await mkSite("測試改體系重推導盤", "測試客戶", { staffScheme: "U" }, []);
    const cardU = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "U", number: "U99991", status: "current" } });
    const cardMP = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MP", number: "MP99991", status: "current" } });
    const rec = (d: Date, extra: Record<string, unknown>) => prisma.shiftRecord.create({ data: { workDate: d, siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: fx.brokerA.id, recordType: "shift", createdBy: "t", ...extra } });
    const auto = await rec(new Date(Date.UTC(2026, 7, 5)), { staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "site_scheme" });
    const manual = await rec(new Date(Date.UTC(2026, 7, 6)), { staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "manual" });
    const lockedAuto = await rec(new Date(Date.UTC(2026, 5, 10)), { staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "backfill:sole" });
    const patch = await sitePatch(new Request(`http://test.local/api/sites/${site.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ staff_scheme: "MP" }) }), { params: Promise.resolve({ id: site.id }) });
    expect(patch.status).toBe(200);
    const pj = (await patch.json()) as { staff_scheme: string; reinfer?: { job_id: string; note: string } };
    expect(pj.staff_scheme).toBe("MP");
    expect(pj.reinfer?.note).toContain("已鎖月");
    const re = (id: string) => prisma.shiftRecord.findUniqueOrThrow({ where: { id } });
    expect(await re(auto.id)).toMatchObject({ staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "backfill:sole" }); // 清走再按 MP 重推
    expect(await re(manual.id)).toMatchObject({ staffNumberId: cardU.id, staffNumberSource: "manual" });
    expect(await re(lockedAuto.id)).toMatchObject({ staffNumberId: cardU.id, staffNumberSource: "backfill:sole" }); // 已鎖月唔郁
    const audit = await prisma.auditLog.findFirst({ where: { action: "site_staff_scheme_reinfer", rowId: site.id } });
    expect(audit!.after).toMatchObject({ cleared: 1, backfilled: 1, locked_kept: 1 });
    const job = await prisma.jobRun.findUniqueOrThrow({ where: { id: pj.reinfer!.job_id } });
    expect(job).toMatchObject({ status: "ok", jobKey: "site_scheme_backfill" });
    // 改其他欄（體系冇變）→ 冇 reinfer
    const p2 = await sitePatch(new Request(`http://test.local/api/sites/${site.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ staff_scheme: "MP" }) }), { params: Promise.resolve({ id: site.id }) });
    expect(((await p2.json()) as { reinfer?: unknown }).reinfer).toBeUndefined();
  });
});
