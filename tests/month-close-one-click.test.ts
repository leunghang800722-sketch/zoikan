// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：
// integration test——RBAC、step0（上月鎖定閘／卡沿用規則／格數差警告／
// 自動建盤）、冪等、卡死重跑。鐵則：合成資料，唔用真盤/真人名（跟
// tests/fixtures/wp2-fixture.ts 一致風格）。
//
// 唔覆蓋嘅範圍（老實列出，避免睇漏）：guard-fix／reconcile-all 兩個
// step 本身已經有自己成套 integration test（wp-guard-fix-ui.test.ts／
// wp-roster-upload.test.ts 等），呢度淨係驗證 one-click job「串埋」呢
// 兩個 step 唔會拋錯、numbers 有寫入 steps_json；唔重複起一個完整 36
// 檔規模嘅端到端（嗰個留俾 dev 手動全流程驗證，見 P2 文件 §20.6）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as startOneClick, GET as listOneClick } from "@/app/api/month-close/one-click/route";
import { POST as rerunOneClick } from "@/app/api/month-close/one-click/[id]/rerun/route";
import { stepPrecheck, stepParseHealth, monthCloseRunRerunAllowed, monthCloseRunStalled, runOneClickMonthClose } from "@/lib/month-close/one-click";
import type { StepRecord } from "@/lib/month-close/types";

function reqJson(url: string, cookie: string, method = "GET", body?: unknown): Request {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const SEPT = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01——fixture 嘅 unlockedMonth（2026-08）做上個月

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 最小合成 standard layout roster xlsx（同 tests/roster-upload-parse.test.ts
 * 一致寫法），俾自動建盤之後嘅 reparseRosterUpload() 真係解析得到。 */
async function buildRosterXlsx(siteRaw: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteRaw;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(2026, 8, 1));
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = "K";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = "U91999";
  ws.getCell("E6").value = "61239999";
  ws.getCell("F6").value = "測試散工甲";
  ws.getCell("G6").value = "D";
  return toBuffer(wb);
}

async function seedRosterUpload(opts: { month: Date; siteId: string | null; siteNameRaw: string; uploaderUserId: string; fileBytes?: Buffer; status?: "parsed" | "confirmed"; parseSummary?: Record<string, unknown> }) {
  const bytes = opts.fileBytes ?? Buffer.from("fake-not-a-real-xlsx");
  return prisma.rosterUpload.create({
    data: {
      month: opts.month,
      siteId: opts.siteId,
      siteNameRaw: opts.siteNameRaw,
      uploaderUserId: opts.uploaderUserId,
      fileName: `${opts.siteNameRaw}-${opts.month.toISOString().slice(0, 7)}.xlsx`,
      fileSha256: "0".repeat(64),
      fileBytes: new Uint8Array(bytes),
      fileSize: bytes.length,
      status: opts.status ?? "parsed",
      ...(opts.parseSummary ? { parseSummary: opts.parseSummary as Prisma.InputJsonValue } : {}),
    },
  });
}

describe("WP-ONE-CLICK：一鍵全月結算", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  describe("RBAC（「一鍵結算」module）", () => {
    it("雞頭 403（POST／GET 都係）", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["雞頭"]);
      const postRes = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(postRes.status).toBe(403);
      const getRes = await listOneClick(reqJson("http://x/api/month-close/one-click?month=2026-09", cookie));
      expect(getRes.status).toBe(403);
    });

    it("安員 403", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["安員"]);
      const res = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(res.status).toBe(403);
    });

    it("主管：GET 得，POST 403（任務書「主管可 view 報告」）", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["主管"]);
      const getRes = await listOneClick(reqJson("http://x/api/month-close/one-click?month=2026-09", cookie));
      expect(getRes.status).toBe(200);
      const postRes = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(postRes.status).toBe(403);
    });

    it("老闆／會計：POST 得（202 或者 200，視乎 after() 有冇背景 context）", async () => {
      for (const role of ["老闆", "會計"] as const) {
        await clearAll();
        fx = await seedWp2Fixture();
        const cookie = await sessionCookieForUser(fx.userIds[role]);
        const res = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
        expect([200, 202]).toContain(res.status);
      }
    });
  });

  describe("step0 前置檢查：上月鎖定閘", () => {
    it("上月（8 月，fixture 已有 shift_records）未鎖 → needsHuman 列明，job 停低", async () => {
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.needsHuman.some((h) => h.includes("未鎖定"))).toBe(true);
    });

    it("透過 runOneClickMonthClose()：上月未鎖 → run 變 failed，之後嘅 step 全部 skipped", async () => {
      const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
      await runOneClickMonthClose(run.id, SEPT, fx.userIds["老闆"], null);
      const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe("failed");
      expect(after.errorMessage).toContain("未鎖定");
      const steps = after.stepsJson as unknown as StepRecord[];
      // precheck 呢一步本身冇拋錯（成功列出咗「上月未鎖定」呢個 needsHuman，
      // 呢個先係佢嘅職責），status 仍然係 done；令成個 run 變 failed 嘅係
      // runOneClickMonthClose() 睇到呢個 needsHuman 之後嘅停低判斷。
      expect(steps.find((s) => s.key === "precheck")?.status).toBe("done");
      expect(steps.find((s) => s.key === "precheck")?.needsHuman.some((h) => h.includes("未鎖定"))).toBe(true);
      expect(steps.find((s) => s.key === "report")?.status).toBe("skipped");
    });

    it("上月未鎖：即刻停低，唔會寫任何沿用卡（Opus 驗收）", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵未鎖唔寫卡盤", clientName: "一鍵未鎖唔寫卡盤", billingModel: "per_shift", createdBy: "test" } });
      const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, clientRate: 900, guardWage: 600, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: st.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.halt).toContain("上月未鎖定");
      expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(1);
    });

    it("本月已鎖：即刻停低（halt），run failed，唔寫任何嘢", async () => {
      await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
      await prisma.monthClose.create({ data: { month: SEPT, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
      const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
      await runOneClickMonthClose(run.id, SEPT, fx.userIds["老闆"], null);
      const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe("failed");
      expect(after.errorMessage).toContain("本月已鎖定");
      const steps = after.stepsJson as unknown as StepRecord[];
      expect(steps.find((s) => s.key === "guard_fix")?.status).toBe("skipped");
    });

    it("鎖定上月之後：needsHuman 唔再有「未鎖定」", async () => {
      await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.needsHuman.some((h) => h.includes("未鎖定"))).toBe(false);
    });
  });

  describe("step0：價卡沿用規則", () => {
    // Opus 驗收：上月未鎖而家即刻停低、唔寫卡——卡沿用測試要先鎖上月。
    beforeEach(async () => {
      await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
    });

    async function seedCombo(name: string, card: Partial<Prisma.RateCardUncheckedCreateInput> | null, siteExtra: Partial<Prisma.SiteUncheckedCreateInput> = {}) {
      const site = await prisma.site.create({ data: { canonicalName: name, clientName: name, billingModel: "per_shift", createdBy: "test", ...siteExtra } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      if (card) {
        await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test", ...card } as Prisma.RateCardUncheckedCreateInput });
      }
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: name, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });
      return { site, shiftType };
    }

    it("唔沿用：特殊卡（billing special）／月費卡／雞頭級卡／逐人卡／未來卡／早過上月已完嘅舊卡", async () => {
      const cases: Array<[string, Partial<Prisma.RateCardUncheckedCreateInput>]> = [
        ["一鍵唔沿用-特殊", { billingModel: "special" }],
        ["一鍵唔沿用-月費", { billingModel: "monthly_fixed" }],
        ["一鍵唔沿用-雞頭級", { brokerId: fx.brokerA.id }],
        ["一鍵唔沿用-未來卡", { effectiveFrom: new Date(Date.UTC(2026, 9, 1)), effectiveTo: null }],
        ["一鍵唔沿用-過期", { effectiveFrom: new Date(Date.UTC(2026, 4, 1)), effectiveTo: new Date(Date.UTC(2026, 5, 30)) }],
      ];
      for (const [name, card] of cases) await seedCombo(name, card);
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsCarriedOver).toBe(0);
      expect(result.numbers.cardsMissingNoCarryover).toBeGreaterThanOrEqual(5);
      const carried = await prisma.rateCard.count({ where: { source: "one_click_carryover" } });
      expect(carried).toBe(0);
    });

    it("LINK（guards_paid_by_client）盤：唔查卡、唔沿用、唔列要人手設卡", async () => {
      const { site } = await seedCombo("一鍵LINK盤", null, { guardsPaidByClient: true });
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.needsHuman.some((h) => h.includes("一鍵LINK盤"))).toBe(false);
      expect(await prisma.rateCard.count({ where: { siteId: site.id } })).toBe(0);
    });

    it("WP-PHASE3：搵到可沿用嘅上月卡——needsHuman 建議去價目卡頁「複製上月卡到本月」，唔再自動寫卡", async () => {
      await seedCombo("一鍵沿用列出盤", {});
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsCarriedOver).toBe(0);
      expect(result.numbers.cardsMissingNoCarryover).toBe(1);
      expect(result.needsHuman.some((h) => h.includes("複製上月卡到本月") && h.includes("一鍵沿用列出盤") && h.includes("900"))).toBe(true);
      const carried = await prisma.rateCard.count({ where: { source: "one_click_carryover" } });
      expect(carried).toBe(0);
    });
    it("WP-PHASE3 Opus 5.5 驗收：上月淨係有雞頭專屬卡——建議同「複製上月卡」候選一致（唔可以話冇卡要人手設）", async () => {
      await seedCombo("一鍵沿用雞頭專屬盤", { brokerId: fx.brokerA.id });
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      const line = result.needsHuman.find((h) => h.includes("一鍵沿用雞頭專屬盤"));
      expect(line).toBeDefined();
      expect(line).toContain("複製上月卡到本月");
      expect(line).not.toContain("要人手設卡（去價目卡頁）");
      expect(await prisma.rateCard.count({ where: { source: "one_click_carryover" } })).toBe(0);
    });
    it("WP-PHASE3：(盤,更種) 冇本月生效卡，但有舊卡（client_rate/guard_wage 都有值）→ 唔自動複製，淨係 needsHuman 建議", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤A", clientName: "一鍵測試盤A", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "測試夜更", createdBy: "test" } });
      const oldCard = await prisma.rateCard.create({
        data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, brokerFee: 50, payoutRate: 650, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" },
      });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({
        data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" },
      });

      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsCarriedOver).toBe(0);
      expect(result.needsHuman.some((w) => w.includes("複製上月卡到本月"))).toBe(true);

      const newCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, shiftTypeId: shiftType.id, id: { not: oldCard.id } } });
      expect(newCard).toBeNull(); // 唔再自動寫卡（Phase 3：建議＋一撳，唔係自動）
    });

    it("(盤,更種) 冇本月生效卡，亦冇可沿用嘅舊卡 → needsHuman，唔會估", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤B", clientName: "一鍵測試盤B", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "測試日更", createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({
        data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "D", codeKind: "shift", guardMatch: "unmatched" },
      });

      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsMissingNoCarryover).toBe(1);
      expect(result.needsHuman.some((h) => h.includes("要人手設卡"))).toBe(true);
      const anyCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, shiftTypeId: shiftType.id } });
      expect(anyCard).toBeNull(); // 唔准估，冇建任何卡
    });

    it("WP-PHASE3：連跑兩次 stepPrecheck 完全冇副作用（唔寫卡），兩次結果一致", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤C", clientName: "一鍵測試盤C", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });

      const first = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(first.numbers.cardsMissingNoCarryover).toBe(1);
      const second = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(second.numbers.cardsMissingNoCarryover).toBe(1);
      const cardCount = await prisma.rateCard.count({ where: { siteId: site.id, shiftTypeId: shiftType.id } });
      expect(cardCount).toBe(1); // 舊卡都冇被複製，一直得返最初嗰張
    });
  });

  describe("step1 解析健康：格數差警告＋自動建盤", () => {
    it("本月格數 vs 上月格數差 >30% → warning", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤D", clientName: "一鍵測試盤D", billingModel: "per_shift", createdBy: "test" } });
      await seedRosterUpload({ month: fx.unlockedMonth, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], status: "confirmed", parseSummary: { shiftCount: 100 } });
      await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], parseSummary: { shiftCount: 40 } });

      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.formatDiffWarnings).toBe(1);
      expect(result.warnings.some((w) => w.includes("可能截短") || w.includes("格式異常"))).toBe(true);
    });

    it("site_id=null → 自動建盤（待核，per_shift），warning 唔停", async () => {
      const bytes = await buildRosterXlsx("一鍵新盤ABC");
      await seedRosterUpload({ month: SEPT, siteId: null, siteNameRaw: "一鍵新盤ABC", uploaderUserId: fx.userIds["老闆"], fileBytes: bytes });

      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.autoBuiltSites).toBe(1);
      const newSite = await prisma.site.findUnique({ where: { canonicalName: "一鍵新盤ABC" } });
      expect(newSite).not.toBeNull();
      expect(newSite?.billingModel).toBe("per_shift");
      const upload = await prisma.rosterUpload.findFirst({ where: { siteNameRaw: "一鍵新盤ABC" } });
      expect(upload?.siteId).toBe(newSite?.id);
    });
  });

  describe("step1 自動建盤防重複（Opus 驗收）", () => {
    it("同一 run 兩個上載盤名只係全形／空白寫法唔同 → 淨係建一個盤，兩個上載都指向佢", async () => {
      const a = await buildRosterXlsx("一鍵新盤（東）");
      const b = await buildRosterXlsx("一鍵新盤 (東)");
      await seedRosterUpload({ month: SEPT, siteId: null, siteNameRaw: "一鍵新盤（東）", uploaderUserId: fx.userIds["老闆"], fileBytes: a });
      const u2 = await seedRosterUpload({ month: SEPT, siteId: null, siteNameRaw: "一鍵新盤 (東)", uploaderUserId: fx.userIds["老闆"], fileBytes: b });
      await prisma.rosterUpload.update({ where: { id: u2.id }, data: { fileName: "另一個檔名.xlsx" } });
      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.autoBuiltSites).toBe(1);
      expect(result.needsHuman.filter((h) => h.includes("待核盤")).length).toBe(1);
      const ups = await prisma.rosterUpload.findMany({ where: { month: SEPT, siteNameRaw: { startsWith: "一鍵新盤" } } });
      expect(new Set(ups.map((u) => u.siteId)).size).toBe(1);
      expect(ups[0]!.siteId).not.toBeNull();
    });

    it("盤名其實係現有盤嘅 alias → 唔建新盤，重新配返現有盤", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵現有盤", clientName: "一鍵現有盤", aliases: ["一鍵現有盤別名"], billingModel: "per_shift", createdBy: "test" } });
      const bytes = await buildRosterXlsx("一鍵現有盤別名");
      const u = await seedRosterUpload({ month: SEPT, siteId: null, siteNameRaw: "一鍵現有盤別名", uploaderUserId: fx.userIds["老闆"], fileBytes: bytes });
      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.autoBuiltSites).toBe(0);
      expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: u.id } })).siteId).toBe(site.id);
    });

    it("解析失敗嘅上載唔會攞檔名建盤", async () => {
      await prisma.rosterUpload.create({
        data: { month: SEPT, siteId: null, siteNameRaw: "壞檔.xlsx", uploaderUserId: fx.userIds["老闆"], fileName: "壞檔.xlsx", fileSha256: "1".repeat(64), fileBytes: new Uint8Array(Buffer.from("x")), fileSize: 1, status: "parse_failed" },
      });
      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.autoBuiltSites).toBe(0);
      expect(await prisma.site.findUnique({ where: { canonicalName: "壞檔.xlsx" } })).toBeNull();
      expect(result.needsHuman.some((h) => h.includes("解析失敗"))).toBe(true);
    });
  });

  describe("中途失敗注入（Opus 驗收）", () => {
    it("step4 撞正人手「重新對數全月」執行緊 → run failed、訊息清楚、之前 step 嘅寫入保留；人手嗰個完咗之後重新執行 → done", async () => {
      await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
      const site = await prisma.site.create({ data: { canonicalName: "一鍵注入盤", clientName: "一鍵注入盤", billingModel: "per_shift", createdBy: "test" } });
      const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: st.id, clientRate: 900, guardWage: 600, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: st.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });
      const manual = await prisma.reconcileAllRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["會計"] } });

      const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
      const res = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      const body = (await res.json()) as { run_id: string; status: string };
      expect(body.status).toBe("failed");
      const run = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: body.run_id } });
      expect(run.errorMessage).toContain("重新對數全月");
      expect(run.errorMessage).not.toMatch(/Invalid `prisma|\n/);
      const steps = run.stepsJson as unknown as StepRecord[];
      expect(steps.find((s) => s.key === "precheck")?.status).toBe("done");
      expect(steps.find((s) => s.key === "reconcile_apply")?.status).toBe("failed");
      expect(steps.find((s) => s.key === "report")?.status).toBe("pending");
      // WP-PHASE3：step0 而家唔再自動寫卡（建議＋一撳，見 stepPrecheck()
      // 大註解）——呢個盤冇本月卡，重新執行前後都應該係 0（唔會再靜靜
      // 幫用戶寫卡）。
      expect(await prisma.rateCard.count({ where: { siteId: site.id, source: "one_click_carryover" } })).toBe(0);

      await prisma.reconcileAllRun.update({ where: { id: manual.id }, data: { status: "done", finishedAt: new Date() } });
      const rerun = await rerunOneClick(reqJson(`http://x/api/month-close/one-click/${run.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
      expect(rerun.status).toBe(200);
      const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe("done");
      expect(after.errorMessage).toBeNull();
      expect(await prisma.rateCard.count({ where: { siteId: site.id, source: "one_click_carryover" } })).toBe(0);
      const report = after.reportJson as { lockPrecondition: { readyToLock: boolean; unpricedCount: number } };
      expect(typeof report.lockPrecondition.unpricedCount).toBe("number");
    });
  });

  describe("卡死重跑", () => {
    it("monthCloseRunStalled()：running 未夠 15 分鐘 = false，過咗 = true", () => {
      const now = new Date();
      expect(monthCloseRunStalled({ status: "running", applyStartedAt: now }, now)).toBe(false);
      const staleAt = new Date(now.getTime() - 16 * 60 * 1000);
      expect(monthCloseRunStalled({ status: "running", applyStartedAt: staleAt }, now)).toBe(true);
      expect(monthCloseRunStalled({ status: "done", applyStartedAt: staleAt }, now)).toBe(false);
    });

    it("monthCloseRunRerunAllowed()：failed 隨時得；running 淨係卡死先得；done 唔得", () => {
      const now = new Date();
      const staleAt = new Date(now.getTime() - 16 * 60 * 1000);
      expect(monthCloseRunRerunAllowed({ status: "failed", applyStartedAt: now }, now)).toBe(true);
      expect(monthCloseRunRerunAllowed({ status: "running", applyStartedAt: now }, now)).toBe(false);
      expect(monthCloseRunRerunAllowed({ status: "running", applyStartedAt: staleAt }, now)).toBe(true);
      expect(monthCloseRunRerunAllowed({ status: "done", applyStartedAt: staleAt }, now)).toBe(false);
    });

    it("rerun API：running 未夠 15 分鐘 → 409；過咗 15 分鐘 → 可以重新執行", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
      const staleAt = new Date(Date.now() - 16 * 60 * 1000);
      const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
      const tooSoon = await rerunOneClick(reqJson(`http://x/api/month-close/one-click/${run.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
      expect(tooSoon.status).toBe(409);

      await prisma.monthCloseRun.update({ where: { id: run.id }, data: { applyStartedAt: staleAt } });
      const ok = await rerunOneClick(reqJson(`http://x/api/month-close/one-click/${run.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
      expect([200, 202]).toContain(ok.status);
    });
  });
});
