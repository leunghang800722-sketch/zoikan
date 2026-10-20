// EMP-P1 第 2 部分：更次工號歸屬——resolver 五條路徑（payload／roster_file／longterm／site_scheme／null）＋ambiguous，
// 同五個寫入點（batch／單筆 POST+重用／更表對數 apply／一鍵結算 undo／seed）、更表匯出跟盤 scheme、上載工號對比、盤 staff_scheme API。
// 合成資料（測試甲乙／U9xxxx／MG9xxx／MP9xxxx），唔讀 data/。純歸屬資訊，唔掂任何金額欄。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { aug, sep, mkBroker, mkGuard, SEPT } from "./lib/one-click-auto";
import { POST as batchSave } from "@/app/api/shift-records/batch/route";
import { POST as recordCreate } from "@/app/api/shift-records/route";
import { GET as rosterStaffNumbers } from "@/app/api/sites/[id]/roster-staff-numbers/route";
import { PATCH as sitePatch } from "@/app/api/sites/[id]/route";
import { resolveFromCards, resolveShiftStaffNumbers, shouldWriteStaffNumber, type ShiftStaffItem } from "@/lib/shift-records/staff-number";
import { applyReconcileDecisions } from "@/lib/roster-upload/reconcile-apply";
import { reconcileUpload } from "@/lib/roster-upload/reconcile";
import { buildGuardMatchIndex, staffNoCardHit } from "@/lib/roster-upload/match";
import { AutoCollector } from "@/lib/month-close/auto/context";
import { runAutoSettlement } from "@/lib/month-close/auto/settlement";
import { undoAutoChanges } from "@/lib/month-close/auto/undo";
import { buildRosterWorkbookForSite } from "@/lib/roster-export";
import { createSiteStaffNoResolver } from "@/lib/guards/site-staff-no";
import { seedShiftStaffNumbers } from "../scripts/seed/lib/shift-staff-numbers";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const card = (id: string, scheme: string, over: Partial<{ status: "current" | "former"; validFrom: string | null; validTo: string | null; number: string }> = {}) => ({
  id,
  guardId: "g",
  scheme,
  number: over.number ?? `${scheme}${id}`,
  status: over.status ?? ("current" as const),
  validFrom: over.validFrom === undefined ? null : over.validFrom ? d(over.validFrom) : null,
  validTo: over.validTo === undefined ? null : over.validTo ? d(over.validTo) : null,
});
const base = { workDate: d("2026-08-10"), isLongterm: false, siteScheme: null as string | null };

describe("EMP-P1 resolveFromCards（純函數：第 2–4 步）", () => {
  it("2 更表檔工號對中任何一張卡（含已取消）→ roster_file；優先過盤 scheme", () => {
    const cards = [card("1", "U", { number: "U90001" }), card("2", "MP", { number: "MP90002", status: "former", validTo: "2026-01-31" })];
    expect(resolveFromCards(cards, { ...base, siteScheme: "U", rosterStaffNoRaw: " mp 90002 " })).toMatchObject({ method: "roster_file", card: { id: "2" } });
    expect(resolveFromCards(cards, { ...base, rosterStaffNoRaw: "U99999" }).method).toBe("unresolved"); // 對唔中 → 繼續後面步驟 → 無 scheme → 無
  });
  it("3 長工（B07）→ MG 卡：期間內（有日期）優先，否則 current；冇 MG 卡 → 跌落盤 scheme", () => {
    const cards = [card("a", "MG", { status: "former", validFrom: "2026-01-01", validTo: "2026-06-30", number: "MG90001" }), card("b", "MG", { validFrom: "2026-07-01", number: "MG90002" })];
    expect(resolveFromCards(cards, { ...base, isLongterm: true, workDate: d("2026-03-01") })).toMatchObject({ method: "longterm", card: { id: "a" } });
    expect(resolveFromCards(cards, { ...base, isLongterm: true, workDate: d("2026-08-10") })).toMatchObject({ method: "longterm", card: { id: "b" } });
    const undatedCurrent = [card("c", "MG")];
    expect(resolveFromCards(undatedCurrent, { ...base, isLongterm: true })).toMatchObject({ method: "longterm", card: { id: "c" } });
    expect(resolveFromCards([card("u", "U")], { ...base, isLongterm: true, siteScheme: "U" })).toMatchObject({ method: "sole", card: { id: "u" } });
    const overlap = [card("x", "MG", { validFrom: "2026-01-01" }), card("y", "MG", { validFrom: "2026-02-01" })];
    expect(resolveFromCards(overlap, { ...base, isLongterm: true }).method).toBe("ambiguous");
  });
  it("4 盤 scheme：期間內剛好一張 → range；冇日期而得一張 → sole；多於一張冇法分 → ambiguous；唯一一張有日期但唔包 workDate → unresolved；盤未設定 → unresolved", () => {
    const two = [card("p", "MP", { status: "former", validFrom: "2026-01-01", validTo: "2026-07-31", number: "MP90011" }), card("q", "MP", { validFrom: "2026-08-01", number: "MP90012" })];
    expect(resolveFromCards(two, { ...base, siteScheme: "MP", workDate: d("2026-07-15") })).toMatchObject({ method: "range", card: { id: "p" } });
    expect(resolveFromCards(two, { ...base, siteScheme: "MP", workDate: d("2026-08-15") })).toMatchObject({ method: "range", card: { id: "q" } });
    expect(resolveFromCards([card("s", "MP")], { ...base, siteScheme: "MP" })).toMatchObject({ method: "sole" });
    expect(resolveFromCards([card("s1", "MP"), card("s2", "MP", { status: "former" })], { ...base, siteScheme: "MP" }).method).toBe("ambiguous");
    expect(resolveFromCards([card("o", "MP", { validFrom: "2026-09-01" })], { ...base, siteScheme: "MP" }).method).toBe("unresolved");
    expect(resolveFromCards([card("n", "MP")], { ...base, siteScheme: null }).method).toBe("unresolved");
    expect(resolveFromCards([card("z", "U")], { ...base, siteScheme: "MP" }).method).toBe("unresolved"); // 唔借別個 scheme 充數
  });
  it("EMP-P1.1 M2：長工 current MG 後備只限冇日期或 workDate 落喺期間內——入職前嘅更次唔掛去之後先發嘅卡", () => {
    // (a) current MG 09-01 起，workDate 08-15 → unresolved
    expect(resolveFromCards([card("m", "MG", { validFrom: "2026-09-01", number: "MG90701" })], { ...base, isLongterm: true, workDate: d("2026-08-15") }).method).toBe("unresolved");
    // (b) former MG 01-01~03-31 ＋ current MG 09-01 起，workDate 05-15（兩張都唔包）→ unresolved
    const two = [card("f", "MG", { status: "former", validFrom: "2026-01-01", validTo: "2026-03-31", number: "MG90702" }), card("g", "MG", { validFrom: "2026-09-01", number: "MG90703" })];
    expect(resolveFromCards(two, { ...base, isLongterm: true, workDate: d("2026-05-15") }).method).toBe("unresolved");
    // 對照：workDate 落喺 current 期間內／current 冇日期 → 照用
    expect(resolveFromCards([card("m", "MG", { validFrom: "2026-09-01" })], { ...base, isLongterm: true, workDate: d("2026-09-10") })).toMatchObject({ method: "longterm", card: { id: "m" } });
    expect(resolveFromCards([card("n", "MG")], { ...base, isLongterm: true, workDate: d("2026-01-10") })).toMatchObject({ method: "longterm", card: { id: "n" } });
  });
  it("shouldWriteStaffNumber：冇舊值就寫；已有歸屬只有 payload／roster_file 先覆寫；同一張卡唔寫", () => {
    const r = (source: "payload" | "roster_file" | "longterm" | "site_scheme") => ({ staffNumberId: "n", scheme: "U", source });
    expect(shouldWriteStaffNumber({ staffNumberId: null }, r("site_scheme"))).toBe(true);
    expect(shouldWriteStaffNumber({ staffNumberId: "old" }, r("site_scheme"))).toBe(false);
    expect(shouldWriteStaffNumber({ staffNumberId: "old" }, r("roster_file"))).toBe(true);
    expect(shouldWriteStaffNumber({ staffNumberId: "n" }, r("payload"))).toBe(false);
    expect(shouldWriteStaffNumber({ staffNumberId: null }, null)).toBe(false);
  });
});

describe("EMP-P1 寫入點", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  let cardMP: { id: string };
  let cardU: { id: string };
  const url = "http://test.local/api/shift-records/batch";
  const batch = (body: unknown, c = cookie) => batchSave(new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }));

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    // guardA：U 同 MP 各一張現用卡；guardB 冇卡
    cardU = await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "U", number: "U90101", status: "current" } });
    cardMP = await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "MP", number: "MP90101", status: "current" } });
    await prisma.site.update({ where: { id: fx.site.id }, data: { staffScheme: "MP" } });
  });

  it("batch：新建格 → 跟盤 scheme 推導（site_scheme）；已有記錄冇歸屬 → 補上；冇卡嘅人 → null 並計 no_staff_number_count", async () => {
    const res = await batch({
      site_id: fx.site.id,
      month: "2026-08",
      cells: [
        { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "N" },
        { guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-01", code: "N" }, // fixture 既有記錄
        { guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-02", code: "N" },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.no_staff_number_count).toBe(1);
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(2), shiftTypeId: fx.shiftType.id } } });
    expect(created).toMatchObject({ staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "site_scheme" });
    const existing = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } });
    expect(existing).toMatchObject({ staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "site_scheme" });
    const b = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardB.id, workDate: aug(2), shiftTypeId: fx.shiftType.id } } });
    expect(b.staffNumberId).toBeNull();
  });

  it("batch：payload 明確 staff_number_id（payload）；屬別個 guard → 400 成批 rollback；內部角色覆寫已有歸屬；雞頭 session 忽略", async () => {
    const ok = await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-03", code: "N", staff_number_id: cardU.id }] });
    expect(ok.status).toBe(200);
    const r1 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(3), shiftTypeId: fx.shiftType.id } } });
    expect(r1).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "payload" });
    // 再次儲存同一格（冇指定）→ 推算唔會蓋走已有歸屬（已有 payload 歸屬，site_scheme 推算唔覆寫）
    await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-03", code: "AL" }] });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r1.id } })).staffNumberId).toBe(cardU.id);
    // 屬別個 guard
    const bad = await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: fx.guardB.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-04", code: "N", staff_number_id: cardU.id }] });
    expect(bad.status).toBe(400);
    expect(await prisma.shiftRecord.count({ where: { guardId: fx.guardB.id, workDate: aug(4) } })).toBe(0);
    // 雞頭 session：staff_number_id 被忽略（server 推導）
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    const br = await batch({ site_id: fx.site.id, month: "2026-08", cells: [{ guard_id: fx.guardA.id, shift_type_id: fx.shiftType.id, work_date: "2026-08-05", code: "N", staff_number_id: cardU.id }] }, brokerCookie);
    expect(br.status).toBe(200);
    const r5 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(5), shiftTypeId: fx.shiftType.id } } });
    expect(r5.staffNumberSource).toBe("site_scheme");
    expect(r5.staffNumberId).toBe(cardMP.id);
  });

  it("單筆 POST /api/shift-records：新建帶歸屬；撞 cancelled 重用 → 先清三欄再按今次資料重新推導；冇卡 → no_staff_number_count", async () => {
    const post = (body: unknown) => recordCreate(new Request("http://test.local/api/shift-records", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    const r = await post({ work_date: "2026-08-12", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: fx.guardA.id, settlement_broker_id: fx.brokerA.id, operational_broker_id: fx.brokerA.id });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.no_staff_number_count).toBeUndefined();
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: j.id } });
    expect(created).toMatchObject({ staffNumberId: cardMP.id, staffNumberSource: "site_scheme" });
    // 作廢 + 手動改歸屬到 U，再 POST 同一格 → 重用：舊歸屬被清並重新推導（唔殘留 U）
    await prisma.shiftRecord.update({ where: { id: j.id }, data: { status: "cancelled", staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "manual" } });
    const again = await post({ work_date: "2026-08-12", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: fx.guardA.id, settlement_broker_id: fx.brokerA.id, operational_broker_id: fx.brokerA.id });
    expect(again.status).toBe(201);
    const reused = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: j.id } });
    expect(reused).toMatchObject({ status: "confirmed", staffNumberId: cardMP.id, staffScheme: "MP", staffNumberSource: "site_scheme" });
    // 盤唔設 scheme → 重用後歸屬被清（resetDefaults 清三欄）
    await prisma.site.update({ where: { id: fx.site.id }, data: { staffScheme: null } });
    await prisma.shiftRecord.update({ where: { id: j.id }, data: { status: "cancelled" } });
    const third = await post({ work_date: "2026-08-12", site_id: fx.site.id, shift_type_id: fx.shiftType.id, guard_id: fx.guardA.id, settlement_broker_id: fx.brokerA.id, operational_broker_id: fx.brokerA.id });
    expect((await third.json()).no_staff_number_count).toBeUndefined(); // EMP-P1.1 降噪：盤未設 scheme 唔計
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ staffNumberId: null, staffScheme: null, staffNumberSource: null });
  });

  it("更表上載對數 apply：更表檔工號對中一張卡 → roster_file（就算盤 scheme 係另一種）；settlement_diff 更新亦帶歸屬；金額欄同無此功能時一致", async () => {
    const up = await prisma.rosterUpload.create({
      data: { month: aug(1), siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: "emp-p1.xlsx", fileSha256: "sha-emp-p1", fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed" },
    });
    const mkRow = (rowIndex: number, date: Date, staffNoRaw: string | null, guardId: string = fx.guardA.id) =>
      prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex, workDate: date, rawCode: "N", codeKind: "shift", shiftTypeId: fx.shiftType.id, resolvedSiteId: fx.site.id, guardId, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerA.id, brokerCodeRaw: "TEST-BA", staffNoRaw } });
    await mkRow(1, aug(27), "u90101"); // 對中 U 卡（盤 scheme=MP，但檔案寫 U）
    await mkRow(2, aug(28), null); // 冇檔案工號 → 盤 scheme MP
    const { items } = await reconcileUpload(up.id);
    const actions = items.filter((i) => i.category === "roster_only").map((i) => ({ key: i.key, action: "apply_roster" as const }));
    expect(actions).toHaveLength(2);
    const res = await applyReconcileDecisions({ uploadId: up.id, actions, actorUserId: fx.userIds["老闆"], ip: null });
    expect(res.results.every((r) => r.ok)).toBe(true);
    const r20 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(27), shiftTypeId: fx.shiftType.id } } });
    expect(r20).toMatchObject({ staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "roster_file" });
    const r21 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(28), shiftTypeId: fx.shiftType.id } } });
    expect(r21).toMatchObject({ staffNumberId: cardMP.id, staffNumberSource: "site_scheme" });
  });

  it("一鍵結算補 B07：長工更次順便補 MG 卡歸屬；undo 一齊還原（之後被人手改過就保留）", async () => {
    const B07 = await mkBroker("SB07", "internal_longterm");
    const g = await mkGuard({ employmentType: "longterm_autopay" });
    const mg = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG90201", status: "current" } });
    const site = await prisma.site.create({ data: { canonicalName: "測試歸屬盤EMP", clientName: "測試客", billingModel: "per_shift", createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", hours: 12, createdBy: "t" } });
    const r1 = await prisma.shiftRecord.create({ data: { workDate: sep(1), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: null, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    const r2 = await prisma.shiftRecord.create({ data: { workDate: sep(2), siteId: site.id, shiftTypeId: st.id, guardId: g.id, settlementBrokerId: null, recordType: "shift", status: "confirmed", source: "roster_upload", createdBy: "t" } });
    const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const ctx = new AutoCollector(run.id, SEPT, fx.userIds["老闆"], null);
    await runAutoSettlement(ctx, SEPT);
    for (const id of [r1.id, r2.id]) {
      const row = await prisma.shiftRecord.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ settlementBrokerId: B07.id, staffNumberId: mg.id, staffScheme: "MG", staffNumberSource: "longterm" });
    }
    // r2 之後被人手改去別張卡 → undo 唔郁佢嘅歸屬
    await prisma.shiftRecord.update({ where: { id: r2.id }, data: { staffNumberId: null } });
    await prisma.monthCloseRun.update({ where: { id: run.id }, data: { status: "done" } });
    const undo = await undoAutoChanges(run.id, fx.userIds["老闆"], null);
    expect(undo.undone.settlement).toBe(2);
    expect(await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ settlementBrokerId: null, staffNumberId: null, staffScheme: null, staffNumberSource: null });
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r2.id } })).settlementBrokerId).toBeNull();
  });

  it("seed 後處理 seedShiftStaffNumbers：長工 B07 → MG；盤有 scheme → 跟盤；其餘留 null；已有歸屬唔郁", async () => {
    const B07 = await mkBroker("SB07S", "internal_longterm");
    const g = await mkGuard({ employmentType: "longterm_autopay" });
    const mg = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG90301", status: "current" } });
    const rec = await prisma.shiftRecord.create({ data: { workDate: aug(15), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, settlementBrokerId: B07.id, operationalBrokerId: B07.id, recordType: "shift", status: "confirmed", createdBy: "t" } });
    const out = await seedShiftStaffNumbers(prisma);
    expect(out.assigned).toBe(2); // fixture guardA 一更（跟盤 MP）＋長工一更；guardB 冇卡
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: rec.id } })).staffNumberId).toBe(mg.id);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordA.id } })).staffNumberId).toBe(cardMP.id);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordB.id } })).staffNumberId).toBeNull(); // guardB 冇卡
    expect(out.bySource.longterm).toBe(1);
    const again = await seedShiftStaffNumbers(prisma);
    expect(again.assigned).toBe(0); // 冪等：已有歸屬唔再掃
  });

  it("EMP-P1.1 降噪：no_staff_number_count 只計「盤已設 staff_scheme 或 B07 長工」而推唔到嘅格；盤未設 scheme 嘅唔計", async () => {
    const mk = async (siteScheme: string | null) => {
      const site = await prisma.site.create({ data: { canonicalName: `測試降噪盤${siteScheme ?? "未設"}`, clientName: "測試客", billingModel: "per_shift", staffScheme: siteScheme, createdBy: "t" } });
      const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", hours: 12, createdBy: "t" } });
      return { site, st };
    };
    const g = await mkGuard(); // 冇任何工號卡
    const unset = await mk(null);
    const r1 = await batch({ site_id: unset.site.id, month: "2026-08", cells: [{ guard_id: g.id, shift_type_id: unset.st.id, work_date: "2026-08-14", code: "N" }] });
    expect((await r1.json()).no_staff_number_count).toBe(0);
    const withScheme = await mk("MP");
    const r2 = await batch({ site_id: withScheme.site.id, month: "2026-08", cells: [{ guard_id: g.id, shift_type_id: withScheme.st.id, work_date: "2026-08-14", code: "N" }] });
    expect((await r2.json()).no_staff_number_count).toBe(1);
    // B07 長工但冇 MG 卡（盤未設 scheme）→ 都計
    const B07 = await mkBroker("SB07NZ", "internal_longterm");
    const lt = await mkGuard({ employmentType: "longterm_autopay", defaultBrokerId: B07.id });
    const r3 = await batch({ site_id: unset.site.id, month: "2026-08", cells: [{ guard_id: lt.id, shift_type_id: unset.st.id, work_date: "2026-08-14", code: "N", settlement_broker_id: B07.id }] });
    expect((await r3.json()).no_staff_number_count).toBe(1);
  });

  it("EMP-P1.1 S4：舊 PATCH /api/guards/:id 改號路徑——舊卡 end_reason 為 null（唔標 replaced），新卡仍有 predecessor", async () => {
    const { applyLegacyStaffNoPatch } = await import("@/lib/guards/staff-numbers");
    await prisma.guardStaffNumber.deleteMany({ where: { guardId: fx.guardB.id } });
    await prisma.$transaction((tx) => applyLegacyStaffNoPatch(tx, { guardId: fx.guardB.id, staffNo: "U90601" }));
    const out = await prisma.$transaction((tx) => applyLegacyStaffNoPatch(tx, { guardId: fx.guardB.id, staffNo: "U90602" }));
    const old = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "U90601" } });
    expect(old).toMatchObject({ status: "former", endReason: null });
    expect(old.validTo).not.toBeNull();
    expect(out.changes[0]!.created.predecessorId).toBe(old.id);
  });

  it("EMP-P1.1 S6：更表對數重新啟用 cancelled 記錄 → 先清三欄再按今次推導重寫（推唔到就係 null，唔殘留舊歸屬）", async () => {
    const mkUp = async (sha: string) =>
      prisma.rosterUpload.create({ data: { month: aug(1), siteId: fx.site.id, siteNameRaw: "測試盤WP2", uploaderUserId: fx.userIds["老闆"], fileName: `${sha}.xlsx`, fileSha256: sha, fileBytes: Buffer.from("x"), fileSize: 1, version: 1, status: "parsed" } });
    const up = await mkUp("sha-s6");
    // 預先有一條 cancelled 記錄，掛住 U 卡（舊歸屬）
    const old = await prisma.shiftRecord.create({ data: { workDate: aug(24), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, status: "cancelled", staffNumberId: cardU.id, staffScheme: "U", staffNumberSource: "manual", createdBy: "t" } });
    await prisma.rosterUploadRow.create({ data: { uploadId: up.id, rowIndex: 1, workDate: aug(24), rawCode: "N", codeKind: "shift", shiftTypeId: fx.shiftType.id, resolvedSiteId: fx.site.id, guardId: fx.guardA.id, guardMatch: "by_staff_no", settlementBrokerId: fx.brokerA.id, brokerCodeRaw: "TEST-BA" } });
    // 盤唔設 scheme、檔案冇工號 → 推唔到 → 舊歸屬必須被清走
    await prisma.site.update({ where: { id: fx.site.id }, data: { staffScheme: null } });
    const { items } = await reconcileUpload(up.id);
    const ro = items.filter((i) => i.category === "roster_only");
    expect(ro).toHaveLength(1);
    const res = await applyReconcileDecisions({ uploadId: up.id, actions: ro.map((i) => ({ key: i.key, action: "apply_roster" as const })), actorUserId: fx.userIds["老闆"], ip: null });
    expect(res.results.every((r) => r.ok)).toBe(true);
    const after = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.status).toBe("confirmed");
    expect(after).toMatchObject({ staffNumberId: null, staffScheme: null, staffNumberSource: null });
  });

  it("EMP-P1.1 S2：undo 刪 guard_staffno_added 工號卡——有更次引用 → skip 唔刪；冇引用 → 刪", async () => {
    const g = await mkGuard();
    const mkRun = () => prisma.monthCloseRun.create({ data: { month: SEPT, status: "done", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
    const refCard = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "U", number: "U90801", status: "current" } });
    const freeCard = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MP", number: "MP90801", status: "current" } });
    await prisma.shiftRecord.create({ data: { workDate: sep(3), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, status: "confirmed", staffNumberId: refCard.id, staffScheme: "U", staffNumberSource: "manual", createdBy: "t" } });
    const run = await mkRun();
    for (const c of [refCard, freeCard]) await prisma.monthCloseAutoChange.create({ data: { runId: run.id, kind: "guard_staffno_added", refTable: "guard_staff_numbers", refId: c.id, summary: "t", detailJson: { staffNumberId: c.id } } });
    const out = await undoAutoChanges(run.id, fx.userIds["老闆"], null);
    expect(out.skipped.map((s) => s.kind)).toEqual(["guard_staffno_added"]);
    expect(await prisma.guardStaffNumber.findUnique({ where: { id: refCard.id } })).not.toBeNull();
    expect(await prisma.guardStaffNumber.findUnique({ where: { id: freeCard.id } })).toBeNull();
  });

  it("resolveShiftStaffNumbers：explicit 屬別個 guard → 400；roster_file 經 rosterRowId；多更批量", async () => {
    const items: ShiftStaffItem[] = [{ key: "x", guardId: fx.guardB.id, siteId: fx.site.id, workDate: aug(5), explicitStaffNumberId: cardU.id }];
    await expect(resolveShiftStaffNumbers(prisma, items)).rejects.toMatchObject({ status: 400 });
    const m = await resolveShiftStaffNumbers(prisma, [
      { key: "a", guardId: fx.guardA.id, siteId: fx.site.id, workDate: aug(5) },
      { key: "b", guardId: fx.guardB.id, siteId: fx.site.id, workDate: aug(5) },
    ]);
    expect(m.get("a")?.staffNumberId).toBe(cardMP.id);
    expect(m.get("b")).toBeNull();
  });
});

describe("EMP-P1 顯示／匯出／API", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { staffNo: "U90401" } });
    await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "U", number: "U90401", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "MP", number: "MP90401", status: "current" } });
    await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "MP", number: "MP90400", status: "former", validTo: d("2026-06-30"), endReason: "resigned" } });
  });

  it("createSiteStaffNoResolver：未設定／U → guards.staff_no；MP → 現用 MP 卡；冇該 scheme 卡 → 空（唔借 U 充數）", async () => {
    const A = { id: fx.guardA.id, staffNo: "U90401" };
    const B = { id: fx.guardB.id, staffNo: "U90402" };
    for (const scheme of [null, undefined, "U"]) {
      const r = createSiteStaffNoResolver(prisma, scheme);
      await r.prefetch([A.id, B.id]);
      expect(r.of(A)).toBe("U90401");
      expect(r.of(B)).toBe("U90402");
    }
    const mp = createSiteStaffNoResolver(prisma, "MP");
    await mp.prefetch([A.id, B.id]);
    expect(mp.of(A)).toBe("MP90401");
    expect(mp.of(B)).toBe("");
  });

  it("更表匯出：盤 MP → 印 MP 號；盤未設定 → 印舊值 U（gate:export 7 月盤全部未設 → 0 差異）", async () => {
    const dump = async () => {
      const { workbook } = await buildRosterWorkbookForSite(fx.site.id, aug(1), {});
      const out: string[] = [];
      workbook.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value ?? "")))));
      return out.join("|");
    };
    const unset = await dump();
    expect(unset).toContain("U90401");
    expect(unset).not.toContain("MP90401");
    await prisma.site.update({ where: { id: fx.site.id }, data: { staffScheme: "MP" } });
    const mp = await dump();
    expect(mp).toContain("MP90401");
    expect(mp).not.toContain("U90401");
  });

  it("GET /api/sites/:id/roster-staff-numbers：盤未設定 → 空；設定 MP → 該 scheme 全部卡（含已取消）；雞頭 → 空", async () => {
    const call = (c: string) => rosterStaffNumbers(new Request(`http://test.local/api/sites/${fx.site.id}/roster-staff-numbers?month=2026-08`, { headers: { cookie: c } }), { params: Promise.resolve({ id: fx.site.id }) });
    expect((await (await call(cookie)).json()).guards).toEqual([]);
    await prisma.site.update({ where: { id: fx.site.id }, data: { staffScheme: "MP" } });
    const body = await (await call(cookie)).json();
    expect(body.site_scheme).toBe("MP");
    const g = body.guards.find((x: { guard_id: string }) => x.guard_id === fx.guardA.id);
    expect(g.cards.map((c: { number: string }) => c.number).sort()).toEqual(["MP90400", "MP90401"]);
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await (await call(brokerCookie)).json()).guards).toEqual([]);
  });

  it("PATCH /api/sites/:id staff_scheme（U／MP／null；其他值 400）；DTO 回傳 staff_scheme", async () => {
    const patch = (body: unknown) => sitePatch(new Request(`http://test.local/api/sites/${fx.site.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: fx.site.id }) });
    const ok = await patch({ staff_scheme: "MP" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).staff_scheme).toBe("MP");
    expect((await prisma.site.findUniqueOrThrow({ where: { id: fx.site.id } })).staffScheme).toBe("MP");
    expect((await patch({ staff_scheme: "XX" })).status).toBe(400);
    const cleared = await patch({ staff_scheme: null });
    expect((await cleared.json()).staff_scheme).toBeNull();
  });

  it("更表上載工號對比：同該 guard 所有卡比較——對中任何一張（含已取消）都唔當唔一致", () => {
    const index = buildGuardMatchIndex({
      guards: [{ id: "g1", nameZh: "測試甲", tel: null, staffNo: "U90401", staffNoMw: null }],
      staffNumbers: [
        { number: "U90401", guardId: "g1", status: "current" },
        { number: "MP90401", guardId: "g1", status: "current" },
        { number: "MP90400", guardId: "g1", status: "former" },
      ],
      phones: [],
    });
    expect(staffNoCardHit(index, "g1", "mp 90401")).toEqual({ hit: true, former: false });
    expect(staffNoCardHit(index, "g1", "MP90400")).toEqual({ hit: true, former: true });
    expect(staffNoCardHit(index, "g1", "MP99999")).toEqual({ hit: false, former: false });
    expect(staffNoCardHit(index, "g2", "MP90401")).toEqual({ hit: false, former: false });
    expect(staffNoCardHit(index, "g1", null)).toEqual({ hit: false, former: false });
  });
});
