// P14.2：人手輸入批量導入（配對／冪等／鎖月 403／overlap 逐行列明／dry_run）＋按月生成草稿（老闆／鎖月／job lock 並發）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as bulk } from "@/app/api/longterm/inputs/bulk/route";
import { POST as createInput } from "@/app/api/longterm/inputs/route";
import { POST as generate } from "@/app/api/longterm/inputs/drafts/generate/route";
import { withJobLock } from "@/lib/scheduler/lock";
import { LONGTERM_INPUT_DRAFTS_KEY } from "@/lib/jobs/longterm-input-drafts";

function req(url: string, cookie: string, body?: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("P14.2 bulk inputs", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  let a: { id: string };
  let month: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    month = fx.unlockedMonth.toISOString().slice(0, 10);
    a = await prisma.guard.create({ data: { nameZh: "測試甲", nameEn: "Test Alpha", staffNoMw: "MG9601", employmentType: "longterm_autopay", createdBy: "test" } });
    await prisma.guard.create({ data: { nameZh: "測試乙", nameEn: "Test  Bravo", staffNo: "U9602", employmentType: "longterm_autopay", createdBy: "test" } });
  });

  const rows = () => [
    { staff_no_mw: "mg9601", kind: "special_allowance", amount: 500, note: "勤工" }, // 工號（大小寫）
    { name_en: "TEST-BRAVO", kind: "deduction", amount: 100 }, // 英文名 normalize
    { name_zh: "測試甲", kind: "leave", date_from: `${month.slice(0, 7)}-05`, date_to: `${month.slice(0, 7)}-06`, doctor_note_verified: true }, // 中文名
    { name_en: "NOBODY", kind: "uniform", amount: 50 }, // 配唔到
    { kind: "uniform", amount: 1 }, // 冇識別
    { staff_no: "U9602", kind: "other_allowance" }, // 缺金額 → invalid
  ];

  it("逐行配對、寫 confirmed（來源 bulk_import）、回應唔含姓名", async () => {
    const res = await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: rows() }));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ created: 3, skipped_duplicate: 0, matched: 4 });
    expect(j.unmatched).toEqual([
      { row: 4, reason: "no_match" },
      { row: 5, reason: "no_identifier" },
    ]);
    expect(j.invalid).toEqual([{ row: 6, reason: "呢個種類要帶金額" }]);
    expect(JSON.stringify(j)).not.toMatch(/測試|Alpha|Bravo|NOBODY/);
    const inputs = await prisma.longtermPayrollInput.findMany({ where: { draftSource: "bulk_import" } });
    expect(inputs).toHaveLength(3);
    expect(inputs.every((i) => i.status === "confirmed" && i.confirmedBy === fx.userIds["老闆"])).toBe(true);
    const audits = await prisma.auditLog.count({ where: { tableName: "longterm_payroll_inputs", action: "create", rowId: { in: inputs.map((i) => i.id) } } });
    expect(audits).toBe(3);
  });

  it("冪等：重跑全部 skipped_duplicate，唔重複建", async () => {
    await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: rows() }));
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", accountant, { month, rows: rows() }))).json();
    expect(j.created).toBe(0);
    expect(j.skipped_duplicate).toBe(3);
    expect(await prisma.longtermPayrollInput.count()).toBe(3);
    // 作廢咗嘅唔算重複
    await prisma.longtermPayrollInput.updateMany({ where: { kind: "deduction" }, data: { voidedAt: new Date() } });
    const k = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: rows() }))).json();
    expect(k.created).toBe(1);
  });

  it("病假段重疊已確認段 → 逐行列入 overlaps，其餘照寫（唔整批失敗）；批內重疊亦擋", async () => {
    await prisma.longtermPayrollInput.create({ data: { month: fx.unlockedMonth, guardId: a.id, kind: "leave", dateFrom: `${month.slice(0, 7)}-10`, dateTo: `${month.slice(0, 7)}-12`, status: "confirmed", createdBy: "t" } });
    const ym = month.slice(0, 7);
    const j = await (
      await bulk(
        req("http://t/api/longterm/inputs/bulk", owner, {
          month,
          rows: [
            { staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-11`, date_to: `${ym}-13` }, // 撞 DB
            { staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-20`, date_to: `${ym}-21` }, // OK
            { staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-21`, date_to: `${ym}-22` }, // 撞批內
            { staff_no_mw: "MG9601", kind: "uniform", amount: 5 },
          ],
        }),
      )
    ).json();
    expect(j.overlaps).toEqual([
      { row: 1, reason: "同已確認病假段重疊" },
      { row: 3, reason: "同已確認病假段重疊" },
    ]);
    expect(j.created).toBe(2);
  });

  it("鎖月 403（唔寫任何行）；主管 403；rows>500 400；dry_run 唔寫入", async () => {
    const locked = await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month: fx.lockedMonth.toISOString().slice(0, 10), rows: rows() }));
    expect(locked.status).toBe(403);
    expect((await bulk(req("http://t/api/longterm/inputs/bulk", supervisor, { month, rows: rows() }))).status).toBe(403);
    const many = Array.from({ length: 501 }, () => ({ staff_no: "U9602", kind: "uniform", amount: 1 }));
    expect((await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: many }))).status).toBe(400);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
    const dry = await bulk(req("http://t/api/longterm/inputs/bulk?dry_run=1", owner, { month, rows: rows() }));
    expect(dry.status).toBe(200);
    const dj = await dry.json();
    expect(dj).toMatchObject({ dry_run: true, created: 3, matched: 4 });
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
  });

  it("M2：同人同段已有 draft → 直接確認（唔新增重複行）、計入 confirmed_existing_draft、audit confirm；重做變 skipped_duplicate；dry_run 只預覽", async () => {
    const ym = month.slice(0, 7);
    const draft = await prisma.longtermPayrollInput.create({ data: { month: fx.unlockedMonth, guardId: a.id, kind: "leave", dateFrom: `${ym}-05`, dateTo: `${ym}-06`, status: "draft", draftSource: "roster_leave:SL", note: "草稿", createdBy: "t" } });
    const body = { month, rows: [{ staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-05`, date_to: `${ym}-06`, doctor_note_verified: true }] };
    const dry = await (await bulk(req("http://t/api/longterm/inputs/bulk?dry_run=1", owner, body))).json();
    expect(dry).toMatchObject({ confirmed_existing_draft: 1, created: 0, skipped_duplicate: 0 });
    expect((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("draft");
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, body))).json();
    expect(j).toMatchObject({ confirmed_existing_draft: 1, created: 0, skipped_duplicate: 0 });
    const after = await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after).toMatchObject({ status: "confirmed", confirmedBy: fx.userIds["老闆"], doctorNoteVerified: true });
    expect(after.note).toContain("批量導入確認");
    expect(await prisma.longtermPayrollInput.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { tableName: "longterm_payroll_inputs", action: "confirm", rowId: draft.id } })).toBe(1);
    const again = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, body))).json();
    expect(again).toMatchObject({ confirmed_existing_draft: 0, skipped_duplicate: 1 });
  });

  it("(ii)b：date_from > date_to、跨月段 → 批量 invalid、單筆 400", async () => {
    const ym = month.slice(0, 7);
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: [
      { staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-10`, date_to: `${ym}-09` },
      { staff_no_mw: "MG9601", kind: "leave", date_from: `${ym}-28`, date_to: "2099-01-02" },
      { staff_no_mw: "MG9601", kind: "leave", date_from: "2020-01-05" },
    ] }))).json();
    expect(j.invalid).toHaveLength(3);
    expect(j.created).toBe(0);
    const single = await createInput(req("http://t/api/longterm/inputs", owner, { month, guard_id: a.id, kind: "leave", date_from: `${ym}-10`, date_to: `${ym}-09` }));
    expect(single.status).toBe(400);
  });

  it("撞名（兩個 guard 同英文名）→ ambiguous，唔估", async () => {
    await prisma.guard.create({ data: { nameZh: "測試丙", nameEn: "Test Alpha", employmentType: "longterm_autopay", createdBy: "test" } });
    const j = await (await bulk(req("http://t/api/longterm/inputs/bulk", owner, { month, rows: [{ name_en: "TEST ALPHA", kind: "uniform", amount: 1 }] }))).json();
    expect(j.unmatched).toEqual([{ row: 1, reason: "ambiguous" }]);
    expect(j.created).toBe(0);
  });

  it("drafts/generate：老闆先得；會計 403；鎖月 403；job lock 被佔 409；成功回 counts", async () => {
    const url = `http://t/api/longterm/inputs/drafts/generate?month=${month.slice(0, 7)}`;
    expect((await generate(req(url, accountant))).status).toBe(403);
    expect((await generate(req(`http://t/api/longterm/inputs/drafts/generate?month=${fx.lockedMonth.toISOString().slice(0, 7)}`, owner))).status).toBe(403);
    expect((await generate(req("http://t/api/longterm/inputs/drafts/generate", owner))).status).toBe(400);
    const ok = await generate(req(url, owner));
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.draft).toMatchObject({ locked: false, created: 0 });
    expect(j.month).toBe(month.slice(0, 7));
    const au = await prisma.auditLog.findFirst({ where: { action: "trigger_drafts_generate" } });
    expect(au?.actorUserId).toBe(fx.userIds["老闆"]);
    // 並發：另一方持有 lock → 409
    let status = 0;
    await withJobLock(LONGTERM_INPUT_DRAFTS_KEY, async () => {
      status = (await generate(req(url, owner))).status;
    });
    expect(status).toBe(409);
  });
});
