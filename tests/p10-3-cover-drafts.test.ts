// P10.3：頂位草稿——按價目表生成（金額＝逐更價之和、證據冇姓名）、無價唔生成＋通知（無 PII）、已確認唔郁、
// 鎖月唔生成、冪等、更表改→更新未確認草稿、會計刪走唔再出、草稿對 Gross 零影響（確認後先加）、job 整合、已確認頂位津貼令草稿唔出。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { sessionCookieForUser } from "./fixtures/wp2-fixture";
import { buildLongtermPayrollInputs } from "@/lib/longterm-payroll/aggregate";
import { generateCoverDrafts, COVER_DRAFT_SOURCE } from "@/lib/longterm-payroll/cover-drafts";
import { runLongtermInputDrafts } from "@/lib/jobs/longterm-input-drafts";
import { ensureSystemUser } from "@/lib/system-user";
import { assertNoPii } from "@/lib/notify/create";
import { PATCH as patchInput, DELETE as deleteInput } from "@/app/api/longterm/inputs/[id]/route";
import { p10Base, mkLongterm, shiftAt, coverInput, D, AUG_MONTH, type P10Base } from "./p10-helpers";

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

const NOW = new Date("2026-09-05T13:30:00.000Z");
async function rate(b: P10Base, site: keyof P10Base["sites"], grade: string, amount: number, from = "2020-01-01") {
  return prisma.coverShiftRate.create({ data: { siteId: b.sites[site].id, grade, amount, effectiveFrom: new Date(`${from}T00:00:00Z`), createdBy: b.actorUserId } });
}
const drafts = (guardId: string) => prisma.longtermPayrollInput.findMany({ where: { guardId, status: "draft", voidedAt: null, draftSource: COVER_DRAFT_SOURCE } });

describe("generateCoverDrafts", () => {
  it("有價生成：金額＝逐更價之和（IC／兵分價）；證據有日期／盤 id／單價、冇姓名；冪等", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    await rate(b, "C", "IC", 250);
    const g = await mkLongterm(b, "測試長工甲");
    await shiftAt(b, g.id, "A", D(8, 1), { own: true });
    await shiftAt(b, g.id, "B", D(8, 3));
    await shiftAt(b, g.id, "B", D(8, 4));
    await shiftAt(b, g.id, "C", D(8, 5), { ic: true });
    const r1 = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r1).toMatchObject({ created: 1, updated: 0, unpriced: [], locked: false });
    const [d] = await drafts(g.id);
    expect(Number(d!.amount)).toBe(650);
    expect(d!.kind).toBe("other_allowance");
    expect(d!.note).toContain("頂位");
    const ev = d!.draftEvidence as { lines: { date: string; site_id: string; amount: number }[]; shifts: number };
    expect(ev.shifts).toBe(3);
    expect(ev.lines.map((l) => [l.date, l.amount])).toEqual([["2026-08-03", 200], ["2026-08-04", 200], ["2026-08-05", 250]]);
    expect(JSON.stringify(d)).not.toContain("測試長工甲");
    const r2 = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r2.created + r2.updated + r2.voided).toBe(0);
    expect(await drafts(g.id)).toHaveLength(1);
  });

  it("無價嘅 (盤,職級) 唔生成並回報；部分有價只計有價嗰啲；生效日前嘅更唔用新價", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200, "2026-08-10"); // 8/10 先生效
    const g = await mkLongterm(b, "測試長工乙");
    await shiftAt(b, g.id, "B", D(8, 3)); // 生效前＝無價
    await shiftAt(b, g.id, "B", D(8, 12));
    await shiftAt(b, g.id, "E", D(8, 13)); // 盤 E 無價
    const r = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r.unpriced.map((u) => [u.site_id, u.grade, u.shifts]).sort()).toEqual([[b.sites.B.id, "兵", 1], [b.sites.E.id, "兵", 1]].sort());
    expect(Number((await drafts(g.id))[0]!.amount)).toBe(200);
    // 全部無價 → 一條都冇
    const b2 = await p10Base();
    const g2 = await mkLongterm(b2, "測試長工丙");
    await shiftAt(b2, g2.id, "B", D(8, 3));
    const r2 = await generateCoverDrafts(AUG_MONTH, b2.actorUserId);
    expect(r2.created).toBe(0);
    expect(r2.unpriced).toHaveLength(1);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
  });

  it("草稿對 Gross 零影響；確認後 Gross 加金額；已確認唔郁（更表變只回報唔改）；已確認後唔再出新草稿", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    const g = await mkLongterm(b, "測試長工丁");
    for (const d of [3, 4]) await shiftAt(b, g.id, "B", D(8, d));
    const before = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    const withDraft = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(withDraft.gross).toBe(before.gross);
    expect(withDraft.otherAllowance).toBe(0);
    const owner = await sessionCookieForUser(b.fx.userIds["老闆"]);
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const [d] = await drafts(g.id);
    const res = await patchInput(new Request(`http://x/api/longterm/inputs/${d!.id}`, { method: "PATCH", headers: { cookie: acct, "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) }), { params: Promise.resolve({ id: d!.id }) });
    expect(res.status).toBe(200);
    const confirmed = (await buildLongtermPayrollInputs(AUG_MONTH)).lines[0]!;
    expect(confirmed.otherAllowance).toBe(400);
    expect(round(confirmed.gross - before.gross)).toBe(400);
    // 更表加一更＋價目表變：已確認唔郁，亦唔另開草稿
    await shiftAt(b, g.id, "B", D(8, 5));
    const r = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r.created + r.updated + r.voided).toBe(0);
    expect(r.skipped_confirmed).toBe(1);
    expect(Number((await prisma.longtermPayrollInput.findUniqueOrThrow({ where: { id: d!.id } })).amount)).toBe(200 * 2);
    void owner;
  });

  it("手動已確認嘅頂位津貼（note 含頂位）令草稿唔出；冇標頂位嘅其他津貼唔影響", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    const g1 = await mkLongterm(b, "測試長工戊");
    const g2 = await mkLongterm(b, "測試長工己");
    await shiftAt(b, g1.id, "B", D(8, 3));
    await shiftAt(b, g2.id, "B", D(8, 3));
    await coverInput(b, g1.id, AUG_MONTH, 180, "頂位津貼");
    await coverInput(b, g2.id, AUG_MONTH, 50, "其他津貼");
    const r = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r.created).toBe(1);
    expect(r.skipped_confirmed).toBe(1);
    expect(await drafts(g1.id)).toHaveLength(0);
    expect(await drafts(g2.id)).toHaveLength(1);
  });

  it("更表改→更新未確認草稿；更表冇頂位更→作廢草稿；會計改過金額唔覆蓋；會計刪走同一組證據唔再出", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    const g = await mkLongterm(b, "測試長工庚");
    await shiftAt(b, g.id, "B", D(8, 3));
    await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    const s2 = await shiftAt(b, g.id, "B", D(8, 4));
    const r = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r.updated).toBe(1);
    expect(Number((await drafts(g.id))[0]!.amount)).toBe(400);
    // 價目表改價（新增一行更高嘅生效價）→ 草稿跟住更新
    await rate(b, "B", "兵", 300, "2026-08-04");
    await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(Number((await drafts(g.id))[0]!.amount)).toBe(500);
    // 會計改金額（PATCH 標 edited）→ 之後更表再變都唔覆蓋
    const acct = await sessionCookieForUser(b.fx.userIds["會計"]);
    const [d] = await drafts(g.id);
    await patchInput(new Request(`http://x/api/longterm/inputs/${d!.id}`, { method: "PATCH", headers: { cookie: acct, "content-type": "application/json" }, body: JSON.stringify({ amount: 480 }) }), { params: Promise.resolve({ id: d!.id }) });
    await prisma.shiftRecord.delete({ where: { id: s2.id } });
    const r2 = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r2.created + r2.updated + r2.voided).toBe(0);
    expect(Number((await drafts(g.id))[0]!.amount)).toBe(480);
  });

  it("會計刪走（人手作廢）→ 同一組證據唔再出；更表冇咗頂位更→系統作廢未改草稿", async () => {
    const b2 = await p10Base();
    await rate(b2, "B", "兵", 200);
    const g2 = await mkLongterm(b2, "測試長工辛");
    await shiftAt(b2, g2.id, "B", D(8, 3));
    await generateCoverDrafts(AUG_MONTH, b2.actorUserId);
    const acct2 = await sessionCookieForUser(b2.fx.userIds["會計"]);
    const [d2] = await drafts(g2.id);
    expect((await deleteInput(new Request(`http://x/api/longterm/inputs/${d2!.id}`, { method: "DELETE", headers: { cookie: acct2 } }), { params: Promise.resolve({ id: d2!.id }) })).status).toBe(200);
    const r3 = await generateCoverDrafts(AUG_MONTH, b2.actorUserId);
    expect(r3.created).toBe(0);
    expect(r3.rejected_skipped).toBe(1);
    // 另一個人：草稿未改，更表冇咗頂位更→系統作廢
    const g3 = await mkLongterm(b2, "測試長工壬子");
    const sh = await shiftAt(b2, g3.id, "B", D(8, 6));
    await generateCoverDrafts(AUG_MONTH, b2.actorUserId);
    expect(await drafts(g3.id)).toHaveLength(1);
    await prisma.shiftRecord.delete({ where: { id: sh.id } });
    const r4 = await generateCoverDrafts(AUG_MONTH, b2.actorUserId);
    expect(r4.voided).toBe(1);
    expect(await drafts(g3.id)).toHaveLength(0);
  });

  it("鎖月唔生成；簽證長工唔生成", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    const g = await mkLongterm(b, "測試長工壬");
    const visa = await mkLongterm(b, "測試簽證", { visa: true });
    for (const x of [g, visa]) await shiftAt(b, x.id, "B", D(8, 3));
    await prisma.monthClose.create({ data: { month: AUG_MONTH, lockedAt: new Date(), lockedBy: b.actorUserId } });
    const r = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r.locked).toBe(true);
    expect(await prisma.longtermPayrollInput.count()).toBe(0);
    await prisma.monthClose.deleteMany({});
    const r2 = await generateCoverDrafts(AUG_MONTH, b.actorUserId);
    expect(r2.created).toBe(1);
    expect(await drafts(visa.id)).toHaveLength(0);
  });
});

describe("job 整合", () => {
  it("有價→草稿通知會計；無價→通知「N 個盤／職級未有頂位價，去設定 ›」（老闆＋會計、無 PII、不重複）；audit by_job／系統帳號", async () => {
    const b = await p10Base();
    await rate(b, "B", "兵", 200);
    const g = await mkLongterm(b, "測試長工癸");
    await shiftAt(b, g.id, "B", D(8, 3));
    await shiftAt(b, g.id, "C", D(8, 4));
    await shiftAt(b, g.id, "E", D(8, 5));
    const r = await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect(r.status).toBe("ok");
    const ns = await prisma.appNotification.findMany();
    const missing = ns.find((n) => n.kind === "cover_rates_missing")!;
    expect(missing.body).toBe("2 個盤／職級未有頂位價，去設定 ›");
    expect(missing.href).toBe("/settings/cover-rates");
    expect(missing.audience).toEqual(["老闆", "會計"]);
    const cd = ns.find((n) => n.kind === "longterm_drafts" && n.title.includes("頂位"))!;
    expect(cd.audience).toEqual(["會計"]);
    for (const n of ns) {
      expect(() => assertNoPii(n.title, n.body)).not.toThrow();
      expect(n.title + n.body).not.toContain("測試");
    }
    const sysId = await ensureSystemUser();
    const [d] = await drafts(g.id);
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "longterm_payroll_inputs", rowId: d!.id, action: "create" } });
    expect(audit?.actorUserId).toBe(sysId);
    expect((audit?.after as Record<string, unknown>).by_job).toBe("longterm_input_drafts");
    const n0 = await prisma.appNotification.count();
    const r2 = await runLongtermInputDrafts(NOW, [AUG_MONTH]);
    expect(r2.status).toBe("skipped");
    expect(await prisma.appNotification.count()).toBe(n0);
    // M3：缺價組合集合不變、只係更數增加（第二日）→ 唔再推缺價通知
    await shiftAt(b, g.id, "C", D(8, 20));
    await shiftAt(b, g.id, "E", D(8, 21));
    await runLongtermInputDrafts(new Date("2026-09-06T13:30:00.000Z"), [AUG_MONTH]);
    expect(await prisma.appNotification.count({ where: { kind: "cover_rates_missing" } })).toBe(1);
    // 缺價組合增加（新盤 B 嘅 IC 無價）先再推
    await shiftAt(b, g.id, "C", D(8, 22), { ic: true });
    await runLongtermInputDrafts(new Date("2026-09-07T13:30:00.000Z"), [AUG_MONTH]);
    expect(await prisma.appNotification.count({ where: { kind: "cover_rates_missing" } })).toBe(2);
    const sum = r.summary as { months: Record<string, { cover: { created: number; unpriced: unknown[] } }> };
    expect(sum.months["2026-08"]!.cover.created).toBe(1);
    expect(sum.months["2026-08"]!.cover.unpriced).toHaveLength(2);
  });
});

const round = (n: number) => Math.round(n * 100) / 100;
