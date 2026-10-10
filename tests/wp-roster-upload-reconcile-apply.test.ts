// WP-ROSTER-UPLOAD Phase B-1 驗收（Opus 5.5，2026-09-24）：對數套用
// （`applyReconcileDecisions()`）寫入語意 integration test——之前淨係得
// 純函數單元測試＋e2e 一條快樂路徑，寫入 `shift_records`（糧單依據）逐
// 類語意、transaction／savepoint、冪等、鎖月、子盤、LINK 盤全部冇
// vitest 覆蓋。
//
// 直接起 `roster_uploads`／`roster_upload_rows`（唔經 xlsx 解析）——對數
// 引擎只讀 DB，咁樣可以精準砌出子盤／OT／leave／重複行等情景。鐵則：
// 全部合成資料（測試保安員甲乙丙丁、TEST-* 雞頭碼）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { applyReconcileDecisions, type ReconcileActionInput } from "@/lib/roster-upload/reconcile-apply";
import { reconcileUpload, type ReconcileItem } from "@/lib/roster-upload/reconcile";
import { resolveShiftPricing } from "@/lib/pricing/resolve-rate";
import { buildPayrollTotals } from "@/lib/reports/payroll";
import { buildMyReceivable } from "@/lib/reports/my-receivable";
import { GET as getReconcile } from "@/app/api/roster-uploads/[id]/reconcile/route";
import { POST as postApply } from "@/app/api/roster-uploads/[id]/reconcile/apply/route";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

type RowSpec = {
  guardId?: string | null;
  date?: Date;
  shiftTypeId?: string | null;
  codeKind?: "shift" | "ot" | "leave";
  rawCode?: string;
  settlementBrokerId?: string | null;
  brokerCodeRaw?: string | null;
  resolvedSiteId?: string | null;
  subSiteName?: string | null;
  rowIndex?: number;
  hours?: number | null;
};

let fileSeq = 0;
async function mkUpload(fx: Wp2Fixture, rows: RowSpec[], opts: { siteId?: string | null; month?: Date; version?: number; status?: "parsed" | "superseded" } = {}) {
  const siteId = opts.siteId === undefined ? fx.site.id : opts.siteId;
  fileSeq += 1;
  const up = await prisma.rosterUpload.create({
    data: {
      month: opts.month ?? aug(1),
      siteId,
      siteNameRaw: "測試盤WP2",
      uploaderUserId: fx.userIds["老闆"],
      fileName: `reconcile-apply-${fileSeq}.xlsx`,
      fileSha256: `sha-${fileSeq}`,
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      version: opts.version ?? 1,
      status: opts.status ?? "parsed",
    },
  });
  let i = 0;
  for (const r of rows) {
    i += 1;
    await prisma.rosterUploadRow.create({
      data: {
        uploadId: up.id,
        rowIndex: r.rowIndex ?? i,
        workDate: r.date ?? aug(2),
        rawCode: r.rawCode ?? "N",
        codeKind: r.codeKind ?? "shift",
        shiftTypeId: r.shiftTypeId === undefined ? fx.shiftType.id : r.shiftTypeId,
        resolvedSiteId: r.resolvedSiteId === undefined ? siteId : r.resolvedSiteId,
        subSiteName: r.subSiteName ?? null,
        guardId: r.guardId === undefined ? fx.guardA.id : r.guardId,
        guardMatch: "by_staff_no",
        settlementBrokerId: r.settlementBrokerId === undefined ? fx.brokerA.id : r.settlementBrokerId,
        brokerCodeRaw: r.brokerCodeRaw === undefined ? "TEST-BA" : r.brokerCodeRaw,
        hours: r.hours ?? null,
      },
    });
  }
  return up;
}

async function applyAll(fx: Wp2Fixture, uploadId: string, pick: (i: ReconcileItem) => ReconcileActionInput["action"] | null) {
  const { items } = await reconcileUpload(uploadId);
  const actions = items.flatMap((i) => {
    const a = pick(i);
    return a ? [{ key: i.key, action: a, reason: a === "exception" ? "測試原因" : undefined }] : [];
  });
  return applyReconcileDecisions({ uploadId, actions, actorUserId: fx.userIds["老闆"], ip: null });
}

const nonMatchToRoster = (i: ReconcileItem) => (i.category === "match" || i.category === "unresolved" ? null : ("apply_roster" as const));

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(String(v));
}

describe("WP-ROSTER-UPLOAD Phase B-1 驗收：對數套用寫入語意", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("roster_only：shift／OT（掛 parent）／leave（同一行推斷更別）逐欄寫啱，snapshot 同 resolveShiftPricing 一致", async () => {
    const otType = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "OT2", label: "測試OT", hours: 2, createdBy: "t" } });
    const up = await mkUpload(fx, [
      { rowIndex: 6, date: aug(2) },
      { rowIndex: 6, date: aug(3), codeKind: "leave", rawCode: "AL", shiftTypeId: null },
      { rowIndex: 7, date: aug(2), codeKind: "ot", rawCode: "OT2", shiftTypeId: otType.id, hours: 2 },
    ]);
    const res = await applyAll(fx, up.id, nonMatchToRoster);
    expect(res.results.filter((r) => r.category === "roster_only").every((r) => r.ok)).toBe(true);

    const shift = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(2), shiftTypeId: fx.shiftType.id } } });
    expect(shift).toMatchObject({ source: "roster_upload", status: "confirmed", recordType: "shift", settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, siteId: fx.site.id });
    expect((shift.provenance as { upload_id: string; version: number }).upload_id).toBe(up.id);
    expect((shift.provenance as { row_id: string }).row_id).toBeTruthy();
    const expected = await resolveShiftPricing({ siteId: fx.site.id, shiftTypeId: fx.shiftType.id, shiftTypeCode: "N", shiftTypeBillingGroup: "per_shift", settlementBrokerId: fx.brokerA.id, brokerKind: "broker", guardId: fx.guardA.id, workDate: aug(2), isExternal: false, recordType: "shift" });
    expect([num(shift.clientRateSnapshot), num(shift.guardWageSnapshot), num(shift.brokerFeeSnapshot)]).toEqual([expected.clientRate, expected.guardWage, expected.brokerFee]);
    expect(num(shift.guardWageSnapshot)).not.toBeNull();

    const ot = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(2), shiftTypeId: otType.id } } });
    expect(ot.recordType).toBe("ot");
    expect(num(ot.otHours)).toBe(2);
    expect(ot.parentShiftId).toBe(shift.id);

    const leave = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(3), shiftTypeId: fx.shiftType.id } } });
    expect(leave).toMatchObject({ recordType: "leave", leaveCode: "AL", clientRateSnapshot: null });
  });

  it("guard_diff／shift_type_diff：舊記錄 cancelled＋新建（唔係 update 舊記錄）；settlement_diff：同一條記錄改結算單位＋重算 snapshot；system_only：cancelled", async () => {
    const dayType = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "D", label: "測試日更", hours: 12, createdBy: "t" } });
    const sysB9 = await prisma.shiftRecord.create({ data: { workDate: aug(9), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, operationalBrokerId: fx.brokerB.id } });
    const sysA10 = await prisma.shiftRecord.create({ data: { workDate: aug(10), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id } });
    const sysA11 = await prisma.shiftRecord.create({ data: { workDate: aug(11), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerB.id, operationalBrokerId: fx.brokerB.id, clientRateSnapshot: 1, guardWageSnapshot: 1, brokerFeeSnapshot: 1 } });
    const sysA12 = await prisma.shiftRecord.create({ data: { workDate: aug(12), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id } });

    const up = await mkUpload(fx, [
      { date: aug(1) }, // match 甲（fixture 8/1 甲乙都有；乙→system_only）
      { date: aug(9) }, // guard_diff（系統乙）
      { date: aug(10), shiftTypeId: dayType.id, rawCode: "D" }, // shift_type_diff
      { date: aug(11) }, // settlement_diff（系統 brokerB → 更表 brokerA）
    ]);
    const { items } = await reconcileUpload(up.id);
    const cat = (d: number) => items.filter((i) => i.workDate === `2026-08-${String(d).padStart(2, "0")}`).map((i) => i.category).sort();
    expect(cat(1)).toEqual(["match", "system_only"]);
    expect(cat(9)).toEqual(["guard_diff"]);
    expect(cat(10)).toEqual(["shift_type_diff"]);
    expect(cat(11)).toEqual(["settlement_diff"]);
    expect(cat(12)).toEqual(["system_only"]);

    const res = await applyAll(fx, up.id, nonMatchToRoster);
    expect(res.results.every((r) => r.ok)).toBe(true);

    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sysB9.id } })).status).toBe("cancelled");
    const newA9 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(9), shiftTypeId: fx.shiftType.id } } });
    expect(newA9.id).not.toBe(sysB9.id);
    expect(newA9).toMatchObject({ status: "confirmed", source: "roster_upload" });

    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sysA10.id } })).status).toBe("cancelled");
    const newD10 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(10), shiftTypeId: dayType.id } } });
    expect(newD10.status).toBe("confirmed");

    const upd11 = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sysA11.id } });
    expect(upd11).toMatchObject({ settlementBrokerId: fx.brokerA.id, operationalBrokerId: fx.brokerA.id, source: "roster_upload", status: "confirmed" });
    expect(num(upd11.guardWageSnapshot)).not.toBe(1); // 已重算（唔再係舊 1/1/1）

    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: sysA12.id } })).status).toBe("cancelled");
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordB.id } })).status).toBe("cancelled");
    expect(res.uploadStatus).toBe("confirmed");
    expect(res.pendingCount).toBe(0);

    // 糧單／雞頭應收唔計 cancelled（之前冇篩 status，「舊人＋新人」兩份都計）。
    const active = await prisma.shiftRecord.count({ where: { settlementBrokerId: fx.brokerB.id, workDate: { gte: aug(1), lte: aug(31) }, status: { not: "cancelled" } } });
    const totals = await buildPayrollTotals(aug(1));
    expect(totals.find((t) => t.brokerId === fx.brokerB.id)?.shifts ?? 0).toBe(active);
    const recv = await buildMyReceivable(fx.brokerB.id, aug(1));
    expect(recv.days.length).toBe(active);

    // 冪等：同一上載再套用——全部 match，零變動、零新 audit。
    const auditBefore = await prisma.auditLog.count({ where: { tableName: "shift_records" } });
    const { items: again } = await reconcileUpload(up.id);
    expect(again.every((i) => i.category === "match")).toBe(true);
    await applyAll(fx, up.id, () => "apply_roster");
    expect(await prisma.auditLog.count({ where: { tableName: "shift_records" } })).toBe(auditBefore);
  });

  it("keep_system／exception：唔改 shift_records，留 roster_reconcile_decisions＋audit；exception 冇原因→該項 fail", async () => {
    const up = await mkUpload(fx, [{ date: aug(2) }]);
    const { items } = await reconcileUpload(up.id);
    const ro = items.find((i) => i.category === "roster_only")!;
    const so = items.find((i) => i.category === "system_only")!;
    const res = await applyReconcileDecisions({
      uploadId: up.id,
      actions: [
        { key: ro.key, action: "exception" },
        { key: so.key, action: "keep_system" },
      ],
      actorUserId: fx.userIds["會計"],
      ip: null,
    });
    expect(res.results.find((r) => r.key === ro.key)!.ok).toBe(false);
    expect(res.results.find((r) => r.key === so.key)!.ok).toBe(true);
    expect(await prisma.shiftRecord.count({ where: { source: "roster_upload" } })).toBe(0);
    expect((await prisma.shiftRecord.findUniqueOrThrow({ where: { id: fx.shiftRecordB.id } })).status).toBe("confirmed");
    const decisions = await prisma.rosterReconcileDecision.findMany({ where: { uploadId: up.id } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "keep_system", decidedBy: fx.userIds["會計"] });
    expect(await prisma.auditLog.count({ where: { tableName: "roster_reconcile_decisions", rowId: decisions[0]!.id } })).toBe(1);
    expect(res.uploadStatus).toBe("parsed"); // roster_only 仲未處理
  });

  it("同日同更種 3 個人（更表甲乙丙、系統甲乙丁）→ match×2＋roster_only 丙＋system_only 丁，唔亂配 guard_diff", async () => {
    const guardC = await prisma.guard.create({ data: { nameZh: "測試保安員丙", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "t" } });
    const guardD = await prisma.guard.create({ data: { nameZh: "測試保安員丁", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "t" } });
    for (const g of [fx.guardA.id, fx.guardB.id, guardD.id]) {
      await prisma.shiftRecord.create({ data: { workDate: aug(12), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g, settlementBrokerId: g === fx.guardB.id ? fx.brokerB.id : fx.brokerA.id } });
    }
    const up = await mkUpload(fx, [
      { date: aug(12) },
      { date: aug(12), guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" },
      { date: aug(12), guardId: guardC.id },
    ]);
    const { items } = await reconcileUpload(up.id);
    const on12 = items.filter((i) => i.workDate === "2026-08-12");
    expect(on12.map((i) => i.category).sort()).toEqual(["match", "match", "roster_only", "system_only"]);
    expect(on12.find((i) => i.category === "roster_only")!.guardId).toBe(guardC.id);
    expect(on12.find((i) => i.category === "system_only")!.guardId).toBe(guardD.id);
  });

  it("同人同日兩更（正更＋OT）：兩條都 match，唔會誤判 shift_type_diff；更表重複行→第二行 unresolved", async () => {
    const otType = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: "OT1", label: "測試OT1", hours: 1, createdBy: "t" } });
    const parent = await prisma.shiftRecord.create({ data: { workDate: aug(13), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id } });
    await prisma.shiftRecord.create({ data: { workDate: aug(13), siteId: fx.site.id, shiftTypeId: otType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id, recordType: "ot", otHours: 1, parentShiftId: parent.id } });
    const up = await mkUpload(fx, [
      { date: aug(13) },
      { date: aug(13), codeKind: "ot", rawCode: "OT1", shiftTypeId: otType.id, hours: 1 },
      { date: aug(13) }, // 重複
    ]);
    const { items } = await reconcileUpload(up.id);
    const on13 = items.filter((i) => i.workDate === "2026-08-13");
    expect(on13.map((i) => i.category).sort()).toEqual(["match", "match", "unresolved"]);
  });

  it("WP-LTSHIFT §2：長工有登記崗位盤（喺另一個盤），呢張上載嘅盤唔喺崗位入面 → 頂雞頭更，結算單位跟更表雞頭碼；冇雞頭碼→fallback＋settlement_inferred；雞頭碼對唔到→unresolved", async () => {
    const lt = await prisma.broker.create({ data: { code: "TEST-LT", name: "測試長工單位", kind: "internal_longterm", settlementType: "autopay", isInternal: true, createdBy: "t" } });
    const longterm = await prisma.guard.create({ data: { nameZh: "測試保安員戊", employmentType: "longterm_autopay", defaultBrokerId: lt.id, createdBy: "t" } });
    // 呢個長工嘅崗位盤登記喺「另一個盤」（唔係呢張上載嘅 fx.site）——
    // 咁樣先至真係測到「有崗位但呢更唔喺崗位盤，跟更表雞頭碼」呢條規則
    // （WP-LTSHIFT §2 第 2 點）；如果冇任何崗位記錄，新第一層會用本月
    // 占比推算，單一盤 100% 會被當自己崗位（B07），唔會跟雞頭碼——呢個
    // 先係任務書要修嘅 B3 bug 本身嘅正確行為，見另一個 it()。
    const otherSite = await prisma.site.create({ data: { canonicalName: "測試保安員戊崗位盤", clientName: "測試客戶WP2", billingModel: "per_shift", createdBy: "t" } });
    await prisma.guardLongtermPost.create({ data: { guardId: longterm.id, siteId: otherSite.id, effectiveFrom: aug(1), source: "manual", createdBy: "t" } });
    const up = await mkUpload(fx, [
      { date: aug(14), guardId: longterm.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" },
      { date: aug(15), guardId: longterm.id, settlementBrokerId: null, brokerCodeRaw: null },
      { date: aug(16), guardId: longterm.id, settlementBrokerId: null, brokerCodeRaw: "ZZ-NOPE" },
    ]);
    const { items } = await reconcileUpload(up.id);
    const byDay = (d: number) => items.find((i) => i.workDate === `2026-08-${d}`)!;
    expect(byDay(14).roster).toMatchObject({ settlementBrokerId: fx.brokerB.id, operationalBrokerId: fx.brokerB.id, settlementInferred: false, settlementReason: "longterm_non_post_broker" });
    expect(byDay(15).roster?.settlementInferred).toBe(true);
    expect(byDay(16).category).toBe("unresolved");
    expect(byDay(16).unresolvedReason).toContain("雞頭碼");
  });

  it("WP-LTSHIFT §2：長工完全冇崗位記錄，本月全部行喺同一個盤（占比 100%）→ 保守自動當自己崗位，結算單位＝internal_longterm（B07），operational 保留更表雞頭碼", async () => {
    const lt = await prisma.broker.create({ data: { code: "TEST-LT2", name: "測試長工單位2", kind: "internal_longterm", settlementType: "autopay", isInternal: true, createdBy: "t" } });
    const longterm = await prisma.guard.create({ data: { nameZh: "測試保安員己", employmentType: "longterm_autopay", defaultBrokerId: lt.id, createdBy: "t" } });
    const up = await mkUpload(fx, [{ date: aug(14), guardId: longterm.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" }]);
    const { items } = await reconcileUpload(up.id);
    const item = items.find((i) => i.workDate === "2026-08-14")!;
    expect(item.roster).toMatchObject({ settlementBrokerId: lt.id, operationalBrokerId: fx.brokerB.id, settlementReason: "longterm_inferred_post" });
    const post = await prisma.guardLongtermPost.findFirst({ where: { guardId: longterm.id, siteId: fx.site.id, voidedAt: null } });
    expect(post).toBeNull(); // preview 階段（reconcileUpload）唔寫 DB，apply_roster 先 materialize
  });

  it("子盤：更表行歸子盤、系統記錄喺母盤 → 唔互相 match；子盤成月冇更表行，系統子盤記錄都列 system_only；子盤對唔到唔跌返母盤", async () => {
    const child = await prisma.site.create({ data: { canonicalName: "測試子盤甲", clientName: "測試客戶WP2", billingModel: "per_shift", parentSiteId: fx.site.id, createdBy: "t" } });
    const child2 = await prisma.site.create({ data: { canonicalName: "測試子盤乙", clientName: "測試客戶WP2", billingModel: "per_shift", parentSiteId: fx.site.id, createdBy: "t" } });
    const childType = await prisma.shiftType.create({ data: { siteId: child.id, code: "N", label: "子盤夜更", hours: 12, createdBy: "t" } });
    const child2Type = await prisma.shiftType.create({ data: { siteId: child2.id, code: "N", label: "子盤乙夜更", hours: 12, createdBy: "t" } });
    await prisma.shiftRecord.create({ data: { workDate: aug(17), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerA.id } });
    const orphan = await prisma.shiftRecord.create({ data: { workDate: aug(18), siteId: child2.id, shiftTypeId: child2Type.id, guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id } });
    const up = await mkUpload(fx, [
      { date: aug(17), resolvedSiteId: child.id, subSiteName: "測試子盤甲", shiftTypeId: childType.id },
      { date: aug(19), resolvedSiteId: null, subSiteName: "唔存在子盤", codeKind: "leave", rawCode: "AL", shiftTypeId: null },
    ]);
    const { items } = await reconcileUpload(up.id);
    const on17 = items.filter((i) => i.workDate === "2026-08-17");
    expect(on17.map((i) => `${i.category}:${i.siteId === child.id ? "child" : "parent"}`).sort()).toEqual(["roster_only:child", "system_only:parent"]);
    expect(items.find((i) => i.system?.id === orphan.id)?.category).toBe("system_only");
    const bad = items.find((i) => i.workDate === "2026-08-19")!;
    expect(bad.category).toBe("unresolved");
    expect(bad.siteId).toBeNull();
  });

  it("LINK（guards_paid_by_client）盤：roster_only 新建 snapshot 全 null；settlement_diff 保留原 snapshot", async () => {
    const link = await prisma.site.create({ data: { canonicalName: "測試LINK盤", clientName: "測試客戶LINK", billingModel: "per_shift", guardsPaidByClient: true, createdBy: "t" } });
    const st = await prisma.shiftType.create({ data: { siteId: link.id, code: "N", label: "LINK夜更", hours: 12, createdBy: "t" } });
    await prisma.rateCard.create({ data: { siteId: link.id, shiftTypeId: st.id, clientRate: 900, guardWage: 600, brokerFee: 40, payoutRate: 640, effectiveFrom: aug(1), createdBy: "t" } });
    const existing = await prisma.shiftRecord.create({ data: { workDate: aug(21), siteId: link.id, shiftTypeId: st.id, guardId: fx.guardA.id, settlementBrokerId: fx.brokerB.id, clientRateSnapshot: 5, guardWageSnapshot: 5, brokerFeeSnapshot: 5 } });
    const up = await mkUpload(fx, [{ date: aug(20), shiftTypeId: st.id }, { date: aug(21), shiftTypeId: st.id }], { siteId: link.id });
    const res = await applyAll(fx, up.id, nonMatchToRoster);
    expect(res.results.every((r) => r.ok)).toBe(true);
    const created = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: fx.guardA.id, workDate: aug(20), shiftTypeId: st.id } } });
    expect([created.clientRateSnapshot, created.guardWageSnapshot, created.brokerFeeSnapshot]).toEqual([null, null, null]);
    const upd = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: existing.id } });
    expect(upd.settlementBrokerId).toBe(fx.brokerA.id);
    expect([num(upd.clientRateSnapshot), num(upd.guardWageSnapshot), num(upd.brokerFeeSnapshot)]).toEqual([5, 5, 5]);
  });

  it("格仔日期唔係上載月份（包括已鎖月份）→ unresolved，唔會寫入另一個月", async () => {
    const up = await mkUpload(fx, [{ date: new Date(Date.UTC(2026, 5, 30)) }]);
    const { items } = await reconcileUpload(up.id);
    expect(items.find((i) => i.workDate === "2026-06-30")!.category).toBe("unresolved");
    await applyAll(fx, up.id, () => "apply_roster");
    expect(await prisma.shiftRecord.count({ where: { workDate: new Date(Date.UTC(2026, 5, 30)) } })).toBe(0);
  });

  it("一項撞 DB 錯誤（unique_violation）：其他項照 commit、回應逐項如實、冇孤兒 audit（SAVEPOINT）", async () => {
    const guardC = await prisma.guard.create({ data: { nameZh: "測試保安員丙", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "t" } });
    const up = await mkUpload(fx, [{ date: aug(2) }, { date: aug(3), guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" }, { date: aug(4), guardId: guardC.id }]);
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION zz_reconcile_test_fail() RETURNS trigger AS $$ BEGIN IF NEW.guard_id = '${fx.guardB.id}' AND NEW.work_date = DATE '2026-08-03' THEN RAISE unique_violation USING MESSAGE = 'test dup'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;`,
    );
    const t0 = new Date();
    await prisma.$executeRawUnsafe(`CREATE TRIGGER zz_reconcile_test_fail_t BEFORE INSERT ON shift_records FOR EACH ROW EXECUTE FUNCTION zz_reconcile_test_fail();`);
    try {
      const res = await applyAll(fx, up.id, (i) => (i.category === "roster_only" ? "apply_roster" : null));
      const byGuard = (g: string) => res.results.find((r) => r.key.includes(g))!;
      expect(byGuard(fx.guardA.id).ok).toBe(true);
      expect(byGuard(fx.guardB.id).ok).toBe(false);
      expect(byGuard(guardC.id).ok).toBe(true);
      const written = await prisma.shiftRecord.findMany({ where: { source: "roster_upload" }, select: { id: true, guardId: true } });
      expect(written.map((w) => w.guardId).sort()).toEqual([fx.guardA.id, guardC.id].sort());
      const createAudits = await prisma.auditLog.findMany({ where: { tableName: "shift_records", action: "create", createdAt: { gte: t0 } }, select: { rowId: true } });
      expect(createAudits.map((a) => a.rowId).sort()).toEqual(written.map((w) => w.id).sort());
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS zz_reconcile_test_fail_t ON shift_records`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS zz_reconcile_test_fail()`);
    }
  });

  it("v1 套用後上載 v2（改咗一個人）→ 淨係一項 guard_diff；套用後新記錄 provenance 指 v2", async () => {
    const guardC = await prisma.guard.create({ data: { nameZh: "測試保安員丙", employmentType: "cash_casual", defaultBrokerId: fx.brokerA.id, createdBy: "t" } });
    const v1 = await mkUpload(fx, [{ date: aug(1) }, { date: aug(1), guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" }, { date: aug(5) }]);
    await applyAll(fx, v1.id, nonMatchToRoster);
    await prisma.rosterUpload.update({ where: { id: v1.id }, data: { status: "superseded" } });
    const v2 = await mkUpload(fx, [{ date: aug(1) }, { date: aug(1), guardId: fx.guardB.id, settlementBrokerId: fx.brokerB.id, brokerCodeRaw: "TEST-BB" }, { date: aug(5), guardId: guardC.id }], { version: 2 });
    const { items } = await reconcileUpload(v2.id);
    const nonMatch = items.filter((i) => i.category !== "match");
    expect(nonMatch.map((i) => i.category)).toEqual(["guard_diff"]);
    await applyAll(fx, v2.id, nonMatchToRoster);
    const c5 = await prisma.shiftRecord.findUniqueOrThrow({ where: { guardId_workDate_shiftTypeId: { guardId: guardC.id, workDate: aug(5), shiftTypeId: fx.shiftType.id } } });
    expect((c5.provenance as { upload_id: string; version: number })).toMatchObject({ upload_id: v2.id, version: 2 });
    // superseded 嘅 v1 唔准再套用。
    await expect(applyAll(fx, v1.id, () => "apply_roster")).rejects.toThrow();
  });

  it("API：雞頭／保安員 GET reconcile、POST apply 一律 403；已鎖月份 POST apply → 403＋permission_denied audit；未指定盤 → 400", async () => {
    const up = await mkUpload(fx, [{ date: aug(2) }]);
    const ctx = { params: Promise.resolve({ id: up.id }) };
    for (const role of ["雞頭", "安員"] as const) {
      const cookie = await sessionCookieForUser(fx.userIds[role]);
      expect((await getReconcile(new Request(`http://t/api/roster-uploads/${up.id}/reconcile`, { headers: { cookie } }), ctx)).status).toBe(403);
      const post = new Request(`http://t/api/roster-uploads/${up.id}/reconcile/apply`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ actions: [{ key: "x", action: "keep_system" }] }) });
      expect((await postApply(post, ctx)).status).toBe(403);
    }

    const ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const lockedUp = await mkUpload(fx, [{ date: fx.lockedMonth }], { month: fx.lockedMonth });
    const lockedCtx = { params: Promise.resolve({ id: lockedUp.id }) };
    const lockedRes = await postApply(
      new Request(`http://t/api/roster-uploads/${lockedUp.id}/reconcile/apply`, { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ actions: [{ key: "x", action: "keep_system" }] }) }),
      lockedCtx,
    );
    expect(lockedRes.status).toBe(403);
    expect(await prisma.auditLog.count({ where: { tableName: "roster_uploads", rowId: lockedUp.id, action: "permission_denied" } })).toBe(1);

    const noSite = await mkUpload(fx, [{ date: aug(2), resolvedSiteId: null }], { siteId: null });
    const noSiteRes = await postApply(
      new Request(`http://t/api/roster-uploads/${noSite.id}/reconcile/apply`, { method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ actions: [{ key: "x", action: "keep_system" }] }) }),
      { params: Promise.resolve({ id: noSite.id }) },
    );
    expect(noSiteRes.status).toBe(400);

    // wire format：snake_case。
    const got = await getReconcile(new Request(`http://t/api/roster-uploads/${up.id}/reconcile`, { headers: { cookie: ownerCookie } }), ctx);
    const body = (await got.json()) as { summary: Record<string, unknown>; items: { rows: Record<string, unknown>[] } };
    expect(Object.keys(body.summary)).toEqual(expect.arrayContaining(["by_category", "settlement_inferred_count"]));
    expect(Object.keys(body.items.rows[0]!)).toEqual(expect.arrayContaining(["work_date", "site_id", "guard_id", "shift_type_id", "unresolved_reason"]));
  });
});
